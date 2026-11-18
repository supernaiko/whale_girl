'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const bondPlugin = require('../custom/plugins/yxn-bond/plugin');
const { createRouter } = require('../src/http/routes');
const {
  loadMessages, moodSeries, memorySeries, chatSeries, bondSeries, heatmap, todayMessages, extremes,
} = require('../src/stats/insights');

const at = (day, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const msg = (at, fromMe, len = 3, chatId = 'chat-a') => ({ at, fromMe, len, chatId });

test('心情按本地小时聚合，空输入返回空数组', () => {
  const options = { since: at(19), bucket: 'hour' };
  const history = [
    { at: at(19, 2, 5), v: 55, e: 42 },
    { at: at(19, 1, 5), v: 40, e: 60 },
    { at: at(19, 1, 55), v: 80, e: 40 },
    { at: at(18, 23, 55), v: 20, e: 20 },
  ];
  assert.deepEqual(moodSeries(history, options), [
    { t: at(19, 1), v: 60, e: 50, n: 2 },
    { t: at(19, 2), v: 55, e: 42, n: 1 },
  ]);
  assert.deepEqual(moodSeries([], options), []);
});

test('对方连发三条后回一条只记一次回复，其他会话不串轮次', () => {
  const messages = [msg(at(19, 1, 3), true, 4), msg(at(19, 1), false, 2),
    msg(at(19, 1, 1), false, 3), msg(at(19, 1, 2), false, 3)];
  const options = { since: at(19), bucket: 'hour' };
  const [point] = chatSeries(messages, options);
  assert.equal(point.t, at(19, 1));
  assert.equal(point.messages, 4);
  assert.equal(point.mine, 1);
  assert.equal(point.theirs, 3);
  assert.equal(point.avgLen, 3);
  assert.ok(Math.abs(point.replyRate - 0.33) < 0.02);
  const [isolated] = chatSeries([messages[1], msg(at(19, 1, 1), true, 1, 'chat-b')], options);
  assert.equal(isolated.replyRate, 0);
  assert.deepEqual(chatSeries([msg(at(19, 2), true), messages[1]], options).map(p => p.replyRate), [1, 0]);
});

test('热力图按周一到周日归档，空图也有 7×24 个格子', () => {
  const messages = [msg(at(16, 0), false), msg(at(16, 0, 30), true), msg(at(22, 23), false)];
  for (const input of [[], messages]) {
    const { rows, max } = heatmap(input, { since: at(16) });
    assert.equal(rows.length, 7);
    assert.ok(rows.every(row => row.length === 24));
    assert.equal(rows.flat().reduce((sum, count) => sum + count, 0), input.length);
    assert.equal(max, input.length ? 2 : 0);
    assert.equal(rows[0][0], input.length ? 2 : 0);
    assert.equal(rows[6][23], input.length ? 1 : 0);
  }
  assert.equal(heatmap(messages, { since: at(17) }).max, 1);
  assert.equal(todayMessages([...messages, msg(at(23), true)], at(22, 23)), 1);
});

test('单个心情点同时是最高和最低，只取当时已经存在的最近事件', () => {
  const history = [{ at: at(19, 10), v: 64, e: 45 }, { at: at(18, 23), v: 90, e: 45 }];
  const events = [{ createdAt: at(19, 11), title: '之后的事件' },
    { createdAt: at(19, 7), title: '更早的事件' }, { createdAt: at(19, 9), title: '最近的事件' }];
  const point = { t: at(19, 10), v: 64, why: '最近的事件' };
  assert.deepEqual(extremes(history, at(19, 12), events), { high: point, low: point });
  assert.deepEqual(extremes(history, at(19, 12)).high, { ...point, why: '' });
  assert.deepEqual(extremes([], at(19, 12)), { high: null, low: null });
});

test('记忆总数带入窗口前的事件，只按创建时间统计新增', () => {
  const events = [{ createdAt: at(20, 2), date: '2026-11-15' }, { createdAt: at(18, 7) },
    { createdAt: at(20, 5), deleted: true }];
  assert.deepEqual(memorySeries([msg(at(19, 9), false)], events, { since: at(19), bucket: 'day' }), [
    { t: at(19), added: 0, total: 1 }, { t: at(20), added: 1, total: 2 },
  ]);
  assert.deepEqual(memorySeries([], events.slice(1, 2), { since: at(19), bucket: 'day' }), [
    { t: at(19), added: 0, total: 1 },
  ]);
});

test('没有好感历史时只返回当前点，存在快照时取每桶最新的实测值', () => {
  const current = { people: { peer: { name: '测试联系人', closeness: 60, trust: 50, lastAt: at(20), interactions: 4 } } };
  const options = { since: at(19), bucket: 'day' };
  const points = [{ t: at(20), closeness: 60, trust: 50 }];
  assert.deepEqual(bondSeries(current, options), {
    people: [{ wxid: 'peer', ...current.people.peer, series: points }], note: '好感只有当前值',
  });
  const snapshot = (at, closeness) => ({ at, people: { peer: { closeness, trust: 50 } } });
  const snapshots = [snapshot(at(19, 2), 55), snapshot(at(18, 2), 51), snapshot(at(19, 1), 54)];
  const bond = bondSeries({ ...current, snapshots }, options);
  assert.equal(bond.note, '');
  assert.deepEqual(bond.people[0].series, [{ t: at(19, 2), closeness: 55, trust: 50 }, ...points]);
  assert.deepEqual(bondSeries(current, { ...options, since: at(21) }).people[0].series, points);
});

async function fixture(t, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-insights-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, 'utf8');
  }
  return dir;
}

const jsonl = (...rows) => rows.map(row => JSON.stringify(row)).join('\r\n');

test('心情插件保留近 30 天的快照并清掉更早的数据', async t => {
  const now = at(19, 12);
  const cutoff = now - 30 * 24 * 3600 * 1000;
  t.mock.method(Date, 'now', () => now);
  const samples = Array.from({ length: 61 }, (_, i) => ({ at: cutoff + i * 300_000, v: 55, e: 50 }));
  const pluginData = await fixture(t, { 'mood-history.jsonl': jsonl({ at: cutoff - 1, v: 50, e: 50 }, ...samples) + '\n' });
  await bondPlugin['timer.tick']({ paths: { pluginData } });
  const saved = await fs.readFile(path.join(pluginData, 'mood-history.jsonl'), 'utf8');
  const times = saved.trim().split('\n').map(line => JSON.parse(line).at);
  assert.deepEqual(times, [...samples.map(row => row.at), now]);
});

test('聊天加载器读取真实存盘结构及兼容字段，只返回规范化元数据', async t => {
  const dataDir = await fixture(t, {
    'memory/chats/first/meta.json': JSON.stringify({ chatId: 'chat-a', title: '测试会话' }),
    'memory/chats/first/messages.jsonl': '\uFEFF' + jsonl(
      { seq: 1, chatId: 'chat-a', role: 'user', name: '测试联系人', ts: at(18, 23), text: '旧消息' },
      { seq: 2, chatId: 'chat-a', role: 'user', name: '测试联系人', ts: at(19, 1), text: '你好🌊' },
      { seq: 3, chatId: 'chat-a', role: 'assistant', name: '鲸鲸', ts: at(19, 2), text: '好' },
    ) + '\r\n{"role":',
    'memory/chats/legacy/messages.jsonl': jsonl({ role: 'user', senderName: '旧版联系人', at: at(19, 3), text: '早' }),
    'memory/chats/missing/meta.json': '{}',
  });
  const messages = await loadMessages(dataDir, { sinceMs: at(19) });
  assert.deepEqual(messages.sort((a, b) => a.at - b.at), [
    { ...msg(at(19, 1), false), chatName: '测试会话' },
    { ...msg(at(19, 2), true, 1), chatName: '测试会话' },
    { ...msg(at(19, 3), false, 1, 'legacy'), chatName: '旧版联系人' },
  ]);
});

test('聚合路由读取两种人物卡布局和已有费率，缺少费率文件时保持只读', async t => {
  const midnight = at(19);
  t.mock.method(Date, 'now', () => at(19, 12));
  const personCard = JSON.stringify({ events: [{ createdAt: midnight, title: '测试事件' }] });
  const dataDir = await fixture(t, {
    'usage.jsonl': jsonl({ at: midnight, model: 'deepseek-v4-flash', completion: 1_000_000 },
      { at: at(19, 1), completion: 1_000_000 }, { at: at(18, 23), completion: 1_000_000 }),
    'memory/people/legacy.json': personCard,
    'memory/chats/first/people/person.json': personCard,
    'memory/chats/first/messages.jsonl': jsonl({ role: 'user', ts: midnight, text: '测试消息' }),
    'plugins/yxn-bond.data/mood-history.jsonl': jsonl({ at: midnight, v: 50, e: 60 }, { at: at(19, 3), v: 40, e: 60 }),
    'plugins/yxn-bond.data/bond.json': JSON.stringify({
      mood: { why: '被关心', updatedAt: at(19, 3) },
      people: { peer: { closeness: 70, trust: 65, lastAt: at(18) } },
    }),
  });
  const router = createRouter({ config: { paths: { dataDir } }, logger: { error: assert.fail, warn: assert.fail } });
  async function get(query = '') {
    let body;
    const response = {
      setHeader() {},
      writeHead(status) { this.statusCode = status; },
      end(value) { body = JSON.parse(value); },
    };
    await router.handle({ url: '/api/insights/series' + query, headers: {}, method: 'GET' }, response);
    assert.equal(response.statusCode, 200);
    return body;
  }
  const one = await get('?days=1');
  assert.equal(one.ok, true);
  assert.equal(one.days, 1);
  assert.equal(one.bucket, 'hour');
  assert.deepEqual(one.mood, [{ t: midnight, v: 50, e: 60, n: 1 }, { t: at(19, 3), v: 40, e: 60, n: 1 }]);
  assert.deepEqual(one.memory, [{ t: midnight, added: 2, total: 2 }]);
  assert.deepEqual(one.today, { messages: 1, requests: 2, costCny: 12 });
  assert.equal(one.heatmap.max, 1);
  assert.equal(one.extremes.high.why, '测试事件');
  assert.equal(one.extremes.low.why, '被关心');
  assert.equal(one.generatedAt, at(19, 12));
  assert.equal(one.bond.note, '好感只有当前值');
  assert.deepEqual(one.bond.people[0].series, [{ t: one.generatedAt, closeness: 70, trust: 65 }]);
  const pricing = JSON.stringify({ models: { flash: { peak: { outputPerM: 12 } } } });
  const pricingFile = path.join(dataDir, 'pricing.json');
  await assert.rejects(fs.access(pricingFile), { code: 'ENOENT' });
  await fs.writeFile(pricingFile, pricing, 'utf8');
  const thirty = await get('?days=30&bucket=hour');
  assert.equal(thirty.bucket, 'hour');
  assert.equal(thirty.days, 30);
  assert.deepEqual(thirty.today, { messages: 1, requests: 2, costCny: 16 });
  const defaults = await get();
  assert.equal(defaults.days, 7);
  assert.equal(defaults.bucket, 'day');
  assert.equal(await fs.readFile(pricingFile, 'utf8'), pricing);
});
