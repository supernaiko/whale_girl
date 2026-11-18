'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createRouter } = require('../src/http/routes');
const { loadUsage, dailyBuckets, computeCost, chatStats, hourlyHeatmap, kpi } = require('../src/stats/aggregator');

const now = Date.parse('2026-11-19T22:00:00+08:00');
const today = { days: 1, now };
const week = { days: 7, now };
const at = (day, hhmm) => Date.parse(`2026-11-${day}T${hhmm}:00+08:00`);
const zero = {
  requests: 0, billedTokens: 0, cost: 0, cacheHitRate: 0,
  messages: 0, replies: 0, avgReplyLen: 0, activeDays: 0,
};

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-stats-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

async function write(dataDir, file, data) {
  const full = path.join(dataDir, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, data, 'utf8');
}

function lines(...rows) {
  return rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\r\n');
}

test('缺失或空的日志得到空会话、空日桶和零值统计', async t => {
  const dataDir = await fixture(t);
  assert.deepEqual(await loadUsage(dataDir, week), []);
  assert.deepEqual(await chatStats(dataDir, week), []);
  await write(dataDir, 'usage.jsonl', '');
  await write(dataDir, 'memory/chats/empty/messages.jsonl', '\ufeff\r\n');
  await write(dataDir, 'memory/chats/missing/meta.json', '{}');
  assert.deepEqual(await loadUsage(dataDir, today), []);
  assert.deepEqual(await chatStats(dataDir, today), []);
  assert.deepEqual(dailyBuckets([], today), []);
  assert.deepEqual(kpi([], [], today), zero);
  assert.deepEqual(hourlyHeatmap([], today), Array.from({ length: 7 }, () => Array(24).fill(0)));
  assert.equal(computeCost(), 0);
});

test('按北京时间跨日归档，兼容轮转、BOM、坏行和仍在追加的末行', async t => {
  const dataDir = await fixture(t);
  await write(dataDir, 'usage.1.jsonl', '\ufeff' + lines(
    { at: at(12, '23:59'), prompt: 900 },
    { at: at(18, '23:59'), prompt: 100, cached: 50, completion: 20, reasoning: 10 },
    'garbage', '{"at":',
  ));
  await write(dataDir, 'usage.jsonl', lines(
    { at: at(19, '00:00'), prompt: 300, cached: 200, completion: 60, reasoning: 40 },
    { at: '2026-11-19T13:15:00.000Z', completion: 20 },
    { at: at(20, '00:00'), prompt: 800 },
    { at: 'invalid', prompt: 600 }, '{',
  ));
  const rows = await loadUsage(dataDir, week);
  assert.deepEqual(rows.map(row => row.at), [at(18, '23:59'), at(19, '00:00'), at(19, '21:15')]);
  assert.deepEqual(dailyBuckets(rows, week).map(({ cost, ...row }) => row), [
    { day: '2026-11-18', billedTokens: 120, prompt: 100, cached: 50, completion: 20, requests: 1 },
    { day: '2026-11-19', billedTokens: 380, prompt: 300, cached: 200, completion: 80, requests: 2 },
  ]);
  assert.equal(kpi(rows, [], week).cacheHitRate, 0.625);
  assert.equal(kpi(rows, [], week).activeDays, 2);
  assert.equal(kpi(rows, [], today).billedTokens, 380);
  assert.equal((await loadUsage(dataDir, today)).length, 2);
  const heatmap = hourlyHeatmap(rows, week);
  assert.equal(heatmap[2][23], 1);
  assert.equal(heatmap[3][0], 1);
  assert.equal(heatmap[3][21], 1);
  assert.equal(hourlyHeatmap(rows, today)[2][23], 0);
  assert.equal(heatmap.flat().reduce((sum, count) => sum + count, 0), 3);
});

test('共用费率的空闲窗包含 00:30 并排除 08:30，reasoning 不重复收费', () => {
  const row = { prompt: 38_420_000, cached: 37_110_000, completion: 246_000, reasoning: 40_000 };
  for (const [clock, expected] of [['00:29', 6.0724], ['00:30', 3.0362], ['08:29', 3.0362], ['08:30', 6.0724]]) {
    const actual = computeCost({ ...row, at: at(19, clock) });
    assert.ok(Math.abs(actual - expected) < 1e-4, `${clock}: ${actual} vs ${expected}`);
  }
  const offPeakRow = { ...row, at: at(19, '00:30') };
  const peakRow = { ...row, at: at(19, '08:30') };
  assert.ok(Math.abs(kpi([offPeakRow, peakRow], [], today).cost - 9.1086) < 1e-4);
  const clamped = computeCost({ at: at(19, '01:00'), prompt: 10, cached: 20, completion: -5 });
  assert.ok(Math.abs(clamped - 0.0000002) < 1e-12);
});

test('记忆会话兼容 ts / name 与 at / senderName，回复长度按回复条数加权', async t => {
  const dataDir = await fixture(t);
  await write(dataDir, 'memory/chats/first/meta.json', '\ufeff' + JSON.stringify({ chatId: 'example-chat-a', title: '示例会话' }));
  await write(dataDir, 'memory/chats/first/messages.jsonl', '\ufeff' + lines(
    { role: 'user', ts: at(18, '23:59'), name: '较早发言人', text: '过滤这条' },
    { role: 'user', ts: at(19, '00:00'), name: '示例发言人', text: '你好🌊' },
    '{broken',
    { role: 'assistant', ts: at(19, '01:00'), name: '鲸鲸', text: '好' },
    { role: 'assistant', ts: at(19, '02:00'), name: '鲸鲸', text: '今天见！' },
  ));
  await write(dataDir, 'memory/chats/second/messages.jsonl', lines(
    { role: 'user', at: at(19, '02:30'), senderName: '新会话', text: '你好' },
    { role: 'assistant', at: at(19, '03:00'), senderName: '鲸鲸', text: '回复🌊' },
    '{"role":',
  ));
  await write(dataDir, 'memory/chats/third/manifest.json', '{"name":"清单名称"}');
  await write(dataDir, 'memory/chats/third/messages.jsonl', lines({ role: 'user', at: at(19, '01:00'), text: '清单' }));
  await write(dataDir, 'memory/chats/abcdefghijkl/messages.jsonl', lines({ role: 'user', at: at(19, '00:00'), text: '' }));

  const chats = await chatStats(dataDir, today);
  assert.deepEqual(chats, [
    { chatId: 'second', name: '新会话', messages: 2, mine: 1, theirs: 1, avgLen: 2.5, lastAt: at(19, '03:00') },
    { chatId: 'example-chat-a', name: '示例会话', messages: 3, mine: 2, theirs: 1, avgLen: 8 / 3, lastAt: at(19, '02:00') },
    { chatId: 'third', name: '清单名称', messages: 1, mine: 0, theirs: 1, avgLen: 2, lastAt: at(19, '01:00') },
    { chatId: 'abcdefghijkl', name: 'abcdefgh', messages: 1, mine: 0, theirs: 1, avgLen: 0, lastAt: at(19, '00:00') },
  ]);
  assert.deepEqual(kpi([], chats, today), { ...zero, messages: 7, replies: 3, avgReplyLen: 8 / 3 });
});

test('统计路由读本机费率，今天筛选保留七天图且接口只读', async t => {
  const dataDir = await fixture(t);
  const runtime = { config: { paths: { dataDir } }, logger: { warn() {}, error() {} } };
  const router = createRouter(runtime);
  const server = http.createServer((req, res) => router.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const get = async suffix => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/stats/${suffix}`, { headers: { connection: 'close' } });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual(await get('context'), { ok: true, parts: [] });
  assert.deepEqual((await get('overview')).kpi, zero);
  assert.deepEqual(await fs.readdir(dataDir), []);

  const beijingDate = offset => new Date(Date.now() + 8 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
  const stamp = offset => Date.parse(`${beijingDate(offset)}T01:00:00+08:00`);
  await write(dataDir, 'usage.jsonl', lines(
    { at: stamp(0), completion: 1_000_000 },
    { at: stamp(-1), completion: 2_000_000 },
    { at: stamp(-15), completion: 1_000_000 },
  ));
  const pricing = '\ufeff{"models":{"flash":{"offPeak":{"outputPerM":5}}}}';
  await write(dataDir, 'pricing.json', pricing);
  const one = await get('overview?days=1');
  assert.equal(one.ok, true);
  assert.equal(one.kpi.requests, 1);
  assert.equal(one.kpi.cost, 5);
  assert.deepEqual(one.daily.map(row => [row.day, row.cost]), [[beijingDate(-1), 10], [beijingDate(0), 5]]);
  assert.equal(one.heatmap.flat().reduce((sum, count) => sum + count, 0), 1);
  assert.deepEqual(one.chats, []);
  assert.ok(Number.isFinite(one.generatedAt));
  assert.equal((await get('overview?days=7')).kpi.requests, 2);
  assert.equal((await get('overview?days=30')).kpi.requests, 3);
  assert.equal(await fs.readFile(path.join(dataDir, 'pricing.json'), 'utf8'), pricing);
});
