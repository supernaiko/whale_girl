'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cp = require('../src/services/carePurpose');

function fakeRuntime(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-care-purpose-'));
  const messages = {
    'wechat:u:wxid_master': [
      { role: 'user', name: '主人', text: '我明天有个面试，有点紧张', ts: Date.now() - 3600 * 1000 },
      { role: 'assistant', name: '鲸鲸', text: '加油呀，你肯定没问题的', ts: Date.now() - 3000 * 1000 },
      { role: 'user', name: '主人', text: '嗯嗯 那我先睡了', ts: Date.now() - 2000 * 1000 },
    ],
  };
  const runtime = {
    config: {
      paths: { dataDir },
      persona: {
        name: '鲸鲸',
        ownerName: '主人',
        personality: '感性、开朗活泼、爱笑',
        background: '程序员，自由接单，在家远程办公',
        customPrompt: '喜欢分享日常，有点黏人',
        master: { names: [], wxids: ['wxid_master'] },
      },
      care: { enabled: true, everyMinutes: 90, jitterMinutes: 25, maxPerDay: 6 },
    },
    contacts: { items: [], get() { return null; } },
    store: { messages(key, limit) { return messages[key] || []; } },
    llm: { isMock: false, complete: async () => '' },
    logger: null,
  };
  return { runtime, dataDir, ...overrides };
}

test('masterUin 取配置里第一个真 wxid', () => {
  const { runtime } = fakeRuntime();
  assert.strictEqual(cp.masterUin(runtime.config), 'wxid_master');
});

test('purposeConfig 把 care 频率映射成 gapMin/gapMax', () => {
  const { runtime } = fakeRuntime();
  const cfg = cp.purposeConfig(runtime);
  assert.strictEqual(cfg.gapMinMs, 90 * 60000);
  assert.strictEqual(cfg.gapMaxMs, 115 * 60000);
  assert.strictEqual(cfg.dailyMax, 6);
  assert.strictEqual(cfg.enabled, true);
});

test('splitPurposeReply 拆消息与内部备忘', () => {
  const raw = '今天看到一个好好玩的猫猫视频\n\n【目的】想分享给你\n【类型】分享\n【状态】完成\n【待续】无';
  const { message, memo } = cp.splitPurposeReply(raw);
  assert.strictEqual(message, '今天看到一个好好玩的猫猫视频');
  assert.strictEqual(memo.purpose, '想分享给你');
  assert.strictEqual(memo.kind, 'share');
  assert.strictEqual(memo.status, '完成');
});

test('splitPurposeReply 无备忘时整段当消息', () => {
  const { message, memo } = cp.splitPurposeReply('就这一句');
  assert.strictEqual(message, '就这一句');
  assert.strictEqual(memo, null);
});

test('splitPurposeReply 只写「内部备忘」四个字也切掉', () => {
  const raw = '诶，问你个事，你歌单里那种苦情味儿的歌是不是特别多啊\n内部备忘';
  const { message, memo } = cp.splitPurposeReply(raw);
  assert.strictEqual(message, '诶，问你个事，你歌单里那种苦情味儿的歌是不是特别多啊');
  assert.strictEqual(memo, null);
});

test('cleanPurposeMessage 去掉残留的「内部备忘」行', () => {
  assert.strictEqual(
    cp.cleanPurposeMessage('说回歌单，那些歌听着叹气那种？\n内部备忘'),
    '说回歌单，那些歌听着叹气那种？',
  );
});

test('cleanPurposeMessage 剥引号折叠空白', () => {
  assert.strictEqual(cp.cleanPurposeMessage('"  你好呀  "'), '你好呀');
  assert.strictEqual(cp.cleanPurposeMessage(''), '');
});

test('buildGeneration 出的提示词带「微信·主人」、不带「QQ·主人」', () => {
  const { runtime } = fakeRuntime();
  const now = Date.now();
  const collected = cp.collectWx(runtime, now);
  assert.ok(collected.items.some((m) => m.kind === 'owner'), '应收集到主人私聊素材');
  const state = cp.purposeState(runtime, now);
  const gen = cp.buildGeneration(runtime, state, collected, now);
  assert.ok(gen.prompt.includes('微信·主人'), '提示词应含 微信·主人');
  assert.ok(!gen.prompt.includes('QQ·主人'), '提示词不应含 QQ·主人');
});

test('generate 成功 + record 记账并落盘 countToday=1', async () => {
  const { runtime } = fakeRuntime();
  runtime.llm.complete = async () => '面试准备得咋样啦\n\n【目的】关心一下面试\n【类型】关心\n【需求】关心\n【状态】完成\n【待续】无';
  const out = await cp.generate(runtime, { chatId: 'wxid_master' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.text, '面试准备得咋样啦');
  assert.ok(out.memo && out.memo.purpose === '关心一下面试');

  const state = cp.record(runtime, { outcome: 'sent', text: out.text, chatId: 'wxid_master' });
  assert.strictEqual(state.countToday, 1);
  assert.strictEqual(state.lastOutcome, 'sent');
  // 状态已落盘
  const f = path.join(runtime.config.paths.dataDir, 'memory', 'care-purpose.json');
  assert.ok(fs.existsSync(f), '状态文件应写入');
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(saved.countToday, 1);
});

test('generate 模型输出空 → ok:false（调用方回退模板）', async () => {
  const { runtime } = fakeRuntime();
  runtime.llm.complete = async () => '   ';
  const out = await cp.generate(runtime, { chatId: 'wxid_master' });
  assert.strictEqual(out.ok, false);
});
