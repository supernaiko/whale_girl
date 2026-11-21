'use strict';

/**
 * episode 抽取的预算与日志（2026-11 修「思考吃满 max_tokens → 空泡泡」）。
 *
 * 以前 extractEpisode 传 maxTokens:900，被 client 夹成 700；思考模型把 700 全用来
 * reasoning，finish=length、content 为空，日志只剩一句「空泡泡」，看不出原因。
 * 这里钉住：
 *   1) 抽取必须传 thinking:false + allowOverflow:true + maxTokens:1200；
 *   2) 失败日志要带 code/detail，不能拿「空泡泡」当日志；
 *   3) 返回不是可解析 JSON 时要 warn「疑似截断」，不静默降级。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { extractEpisode } = require('../src/memory/extractor');
const { LlmError, FRIENDLY } = require('../src/llm/client');

const messages = [
  { role: 'user', uid: 'u1', name: '小海', text: '最近在换工作，压力挺大，想换个环境', id: 'msg_1' },
  { role: 'assistant', uid: 'bot', name: '鲸鲸', text: '慢慢来，别把自己逼太紧' },
];
const speakers = [{ uid: 'u1', name: '小海' }];

function collector() {
  const logs = [];
  return {
    logs,
    logger: {
      warn: (m) => logs.push(['warn', String(m)]),
      info: () => {},
      debug: () => {},
      error: (m) => logs.push(['error', String(m)]),
    },
  };
}

test('抽取请求带 thinking:false / allowOverflow / maxTokens:1200', async () => {
  let seen = null;
  const llm = {
    isMock: false,
    async complete(opts) {
      seen = opts;
      return JSON.stringify({ summary: '在聊换工作', facts: [], traits: [], events: [], threads: [] });
    },
  };
  await extractEpisode({ messages, llm, speakers });
  assert.ok(seen, '必须真的调一次模型');
  assert.equal(seen.thinking, false, '抽取必须关思考（思考 token 会吃光预算）');
  assert.equal(seen.allowOverflow, true, '后台任务不吃聊天的 700 夹取');
  assert.equal(seen.maxTokens, 1200, '给足预算，别再被夹成 700');
});

test('LlmError 带 detail：日志里有 code/detail，不能只有「空泡泡」', async () => {
  const { logs, logger } = collector();
  const detail = '空响应（finish=length usage=3200/700 reasoning_tokens=700）';
  const llm = {
    isMock: false,
    async complete() {
      throw new LlmError(FRIENDLY.empty, { code: 'empty', detail });
    },
  };
  const out = await extractEpisode({ messages, llm, speakers, logger });
  assert.equal(out.fallback, true, '失败要退回规则兜底');
  const line = logs.map(([, m]) => m).join('\n');
  assert.ok(line.includes('episode 抽取失败'), line);
  assert.ok(line.includes('code=empty'), '日志要带 code：' + line);
  assert.ok(line.includes('finish=length'), '日志要带 detail：' + line);
  assert.ok(!line.includes('空泡泡'), '不能拿给用户看的话术当日志：' + line);
});

test('返回不是可解析 JSON：warn「疑似截断」，不静默降级', async () => {
  const { logs, logger } = collector();
  const llm = {
    isMock: false,
    async complete() {
      // 典型截断：JSON 只开了个头
      return '{"summary":"在聊换工作","facts":[{"uid":"u1","text":"换工作"';
    },
  };
  const out = await extractEpisode({ messages, llm, speakers, logger });
  assert.equal(out.fallback, true);
  const line = logs.map(([, m]) => m).join('\n');
  assert.ok(line.includes('不是可解析 JSON'), line);
  assert.ok(line.includes('疑似截断'), line);
});

test('多人抽取：模型漏填/填错 uid 就丢弃，绝不归给最后一个说话人', async () => {
  // 三个人，最后说话的是 u3；模型把 u1 的事实 uid 写错成「u9」
  const group = [
    { role: 'user', uid: 'u1', name: '小海', text: '我要去北京上班了', id: 'msg_1' },
    { role: 'user', uid: 'u2', name: '小树', text: '恭喜啊', id: 'msg_2' },
    { role: 'user', uid: 'u3', name: '小湖', text: '去北京记得带伞', id: 'msg_3' },
  ];
  const groupSpeakers = [{ uid: 'u1', name: '小海' }, { uid: 'u2', name: '小树' }, { uid: 'u3', name: '小湖' }];
  const llm = {
    isMock: false,
    async complete() {
      return JSON.stringify({
        summary: '在聊小海去北京',
        facts: [{ uid: 'u9', text: '要去北京上班' }, { text: '恭喜' }],
        events: [{ uid: 'nope', title: '去北京', summary: '小海要去北京' }],
        traits: [],
        threads: [],
        relations: [],
      });
    },
  };
  const out = await extractEpisode({ messages: group, llm, speakers: groupSpeakers });
  assert.equal(out.facts.length, 0, '非法 uid 的事实必须丢弃，不能归给 u3：' + JSON.stringify(out.facts));
  assert.equal(out.events.length, 0, '非法 uid 的事件也要丢弃：' + JSON.stringify(out.events));
});

test('单人对聊：模型漏填 uid 可以保守回退到唯一说话人', async () => {
  const llm = {
    isMock: false,
    async complete() {
      return JSON.stringify({
        summary: '在聊换工作',
        facts: [{ text: '想换个环境' }],
        traits: [],
        events: [{ title: '换工作', summary: '小海最近在换工作' }],
        threads: [],
        relations: [],
      });
    },
  };
  const out = await extractEpisode({ messages, llm, speakers });
  assert.equal(out.facts.length, 1, '单人漏填 uid 应回退到唯一说话人');
  assert.equal(out.facts[0].uid, 'u1');
  assert.equal(out.events[0].uid, 'u1');
});
