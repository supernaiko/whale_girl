'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const manifest = require('../plugin.json');
const { createHooks, sampleReply, calculateDelayMs } = require('../plugin');

const HOUR = 60 * 60 * 1000;
const DAY = HOUR * 24;
const NOW = Date.UTC(2025, 0, 15);
const traits = { sweet: 0.5, sharp: 0.5, talky: 0.5 };

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yxn-chat-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const pluginData = path.join(root, 'plugin');
  const appData = path.join(root, 'host');
  const ctx = { whale: { paths: { pluginData, appData } } };
  const delays = [];
  let now = NOW;
  const hooks = createHooks({
    clock: () => now, rng: () => 0, sleep: async ms => { delays.push(ms); }, ...overrides,
  });
  const file = name => path.join(pluginData, name);
  return {
    hooks, ctx, delays, file, advance: ms => { now += ms; },
    read: name => JSON.parse(fs.readFileSync(file(name), 'utf8')),
    pool: () => fs.readFileSync(file('pool.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)),
    config: settings => ({ ...ctx, settings }),
    generate: (text, extra = {}) => hooks['chat.generate']({ ...ctx, message: { text }, ...extra }),
    memory(lines, filename = 'sample.jsonl') {
      const dest = path.join(appData, 'memory', 'chats', filename);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, lines.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
      return dest;
    },
  };
}

test('manifest declares exactly the implemented API 4 hooks', () => {
  assert.equal(manifest.Api, 4);
  assert.deepEqual([...manifest.Hooks].sort(), Object.keys(createHooks()).sort());
  assert.deepEqual(manifest.Permissions, ['system.full']);
  assert.equal(manifest.ExecutionTimeoutMs, 60000);
  assert.equal(manifest.IntervalSeconds, 300);
});

test('equal scores give deterministic results with an injected RNG', () => {
  const replies = ['a', 'b', 'c'].map(text => ({ ...traits, text, weight: 1, lastUsedAt: null }));
  assert.equal(sampleReply(replies, traits, NOW, () => 0), replies[0]);
  assert.equal(sampleReply(replies, traits, NOW, () => 0.5), replies[1]);
  assert.equal(sampleReply(replies, traits, NOW, () => 0.5), replies[1]);
  assert.equal(sampleReply(replies, traits, NOW, () => 0.999), replies[2]);
  assert.equal(sampleReply([], traits, NOW), undefined);
});

test('higher weight wins substantially more of 1000 samples', () => {
  const low = { ...traits, weight: 1 };
  const high = { ...traits, weight: 3 };
  let state = 12345;
  const rng = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  let wins = 0;
  for (let i = 0; i < 1000; i += 1) if (sampleReply([low, high], traits, NOW, rng) === high) wins += 1;
  assert.ok(wins > 900 && wins < 1000, `higher-weight wins: ${wins}`);
});

test('sampling applies trait distance, both recency boundaries and the 0.7 temperature', () => {
  const ideal = { ...traits, weight: 1 };
  const reply = { sweet: 0, sharp: 0, talky: 0, weight: 2 };
  for (const [hours, penalty] of [[1, 0.4], [2, 0.8], [23, 0.8], [24, 1]]) {
    const candidate = { ...reply, lastUsedAt: NOW - hours * HOUR };
    const expected = 1 / (1 + Math.exp((penalty - 1) / 0.7));
    assert.equal(sampleReply([ideal, candidate], traits, NOW, () => expected - 0.00001), ideal);
    assert.equal(sampleReply([ideal, candidate], traits, NOW, () => expected + 0.00001), candidate);
  }
});

test('delay interpolates read time, counts Unicode characters and honors both caps and the budget', () => {
  const config = { readDelay: { min: 3, max: 30 }, typingMsPerChar: 120, maxDelaySec: 100 };
  assert.equal(calculateDelayMs('你好🙂', config, 60000, () => 0), 3360);
  assert.equal(calculateDelayMs('你好🙂', config, 60000, () => 1), 30360);
  assert.equal(calculateDelayMs('好'.repeat(200), config, 60000, () => 1), 45000);
  assert.equal(calculateDelayMs('好'.repeat(200), { ...config, maxDelaySec: 15 }, 60000, () => 1), 15000);
  assert.equal(calculateDelayMs('你好🙂', config, 3000, () => 0), 2400);
  assert.equal(calculateDelayMs('你好🙂', config, 0, () => 0), 0);
});

test('pre_reply always passes and generate leaves commands, links, voice and prior plugin replies alone', async t => {
  const f = fixture(t);
  const settings = { mode: 'fallback' };
  f.memory([{ role: 'assistant', text: '你好呀呀。' }]);
  await f.hooks['app.start'](f.config(settings));
  for (const text of ['你好，建个文件', '你好，用codex', '你好，用 DSH', '你好，打开它', '你好，截图',
    '你好 https://example.test', '请看 b23.tv', '你好，用语音回复', '[语音] 你好']) {
    assert.deepEqual(f.hooks['chat.pre_reply']({ message: { text } }), { action: 'pass' });
    assert.deepEqual(await f.generate(text, { reason: 'model_error' }), {}, text);
  }
  assert.deepEqual(f.hooks['chat.pre_reply']({ message: { text: '你好' } }), { action: 'pass' });
  assert.deepEqual(await f.generate('你好', { reason: 'model_error', message: { text: '你好', type: 34 } }), {});
  assert.deepEqual(await f.generate('你好', { error: {}, text: '' }), {});
  assert.deepEqual(await f.generate('你好', { error: {}, text: '电脑助手回复' }), {});
  assert.deepEqual(f.delays, []);
});

test('generate supports off, fallback, probabilistic, disabled buckets and delay before returning', async t => {
  const f = fixture(t);
  const greeting = '你好呀';
  f.memory([{ role: 'assistant', text: '好的，你好呀。' }]);
  await f.hooks['app.start'](f.ctx);
  assert.equal(f.read('config.json').mode, 'off');
  assert.deepEqual(f.read('local-model.json'), { enabled: false, cmd: '', modelPath: '', maxTokens: 64 });
  assert.deepEqual(await f.generate(greeting, { error: {} }), {});
  assert.deepEqual(await f.generate(greeting, { settings: { mode: 'fallback' } }), {});
  assert.deepEqual(await f.generate(greeting, { reason: 'model_error', now: NOW - 58000 }), { text: '行，你好呀' });
  assert.deepEqual(f.delays, [1600]);
  assert.deepEqual(await f.generate(greeting, { settings: { mode: 'probabilistic', probability: 0 } }), {});
  assert.deepEqual(await f.generate(greeting, { settings: { probability: 1, bucketsOff: ['greeting'] } }), {});
  assert.deepEqual(await f.generate('一二三四', { settings: { bucketsOff: [] } }), {});
  assert.deepEqual(await f.generate('想你'), {});
  fs.writeFileSync(f.file('local-model.json'), JSON.stringify({ enabled: true, cmd: 'fixture-command' }));
  assert.deepEqual(await f.generate(greeting), { text: '行，你好呀' });
  assert.deepEqual(f.delays, [1600, 3600]);
  assert.deepEqual(f.read('brain.json').stats, { sent: 2, picked: 2, skipped: 4, model: 0 });
  assert.equal(f.read('brain.json').buckets.greeting[0].uses, 2);
});

test('only the provided finalText is learned and the append log deduplicates across restarts', async t => {
  const f = fixture(t);
  const text = '今天也要好好吃饭';
  assert.deepEqual(await f.generate('随便聊聊', { text }), {});
  assert.deepEqual(f.pool(), []);
  await f.generate('随便聊聊', { finalText: text });
  await f.generate('随便聊聊', { finalText: '  ' + text + '  ' });
  const restarted = createHooks({ clock: () => NOW + DAY - 1 });
  await restarted['chat.generate']({ ...f.ctx, message: { text: '随便聊聊' }, finalText: text });
  assert.deepEqual(f.pool(), [{ at: NOW, bucket: 'food', text, source: 'learned' }]);
  assert.equal(f.read('brain.json').buckets.food.length, 1);
  f.advance(DAY);
  await f.generate('随便聊聊', { finalText: text });
  assert.equal(f.pool().length, 2);
  assert.equal(f.read('brain.json').buckets.food.length, 2);
});

test('generate waits for the delay before returning text', async t => {
  let beginDelay, finishDelay;
  const started = new Promise(resolve => { beginDelay = resolve; });
  const pending = new Promise(resolve => { finishDelay = resolve; });
  const f = fixture(t, { sleep: async ms => { beginDelay(ms); await pending; } });
  f.memory([{ role: 'assistant', text: '你好呀朋友' }]);
  await f.hooks['app.start'](f.config({ mode: 'probabilistic', probability: 1 }));
  const call = f.generate('你好呀');
  assert.equal(await Promise.race([call, started]), 3600);
  assert.equal(f.read('brain.json').stats.sent, 0);
  finishDelay();
  assert.deepEqual(await call, { text: '你好呀朋友' });
});

test('first startup imports flat and nested memories once and filters names, links, roles and length', async t => {
  const f = fixture(t);
  const file = f.memory([
    { role: 'assistant', text: '你好呀朋友' },
    { role: 'assistant', text: '看这里 example.com' },
    { role: 'assistant', text: '小明晚安呀' },
    { role: 'assistant', text: '小雨想你啦', replyToName: '小雨' },
    { role: 'assistant', text: '@朋友 你好呀' },
    { role: 'assistant', text: '你好' },
    { role: 'assistant', text: '好'.repeat(31) },
    { role: 'user', name: '小明', text: '已经吃过晚饭' },
    '{invalid json}',
  ]);
  const nested = f.memory([
    { role: 'assistant', content: '我也想你呀' },
    { role: 'assistant', text: '晚安做个好梦' },
  ], 'hashed-chat/messages.jsonl');
  const original = [fs.readFileSync(file), fs.readFileSync(nested)];
  await f.hooks['app.start'](f.ctx);
  await f.hooks['app.start'](f.ctx);
  const brain = f.read('brain.json');
  assert.deepEqual(Object.keys(brain.buckets).sort(), ['goodnight', 'greeting', 'miss']);
  assert.deepEqual(f.pool().map(row => row.source), ['seed', 'seed', 'seed']);
  assert.equal(brain.buckets.greeting[0].weight, 1);
  assert.equal(fs.readFileSync(f.file('activity.log'), 'utf8'), '[yxn-chat] seeded 3 in 3 buckets\n');
  assert.deepEqual([fs.readFileSync(file), fs.readFileSync(nested)], original);
  await f.generate('随便聊聊', { finalText: '我也想你呀' });
  assert.equal(f.pool().length, 3);
});

test('seeds cap each bucket at 40 and maintenance decays hourly, keeps best 150 and preserves raw rows', async t => {
  const f = fixture(t, { freeMemory: () => 64 * 1024 * 1024 });
  f.memory(Array.from({ length: 50 }, (_, i) => ({ role: 'assistant', text: '你好呀第' + i + '回' })));
  await f.hooks['app.start'](f.ctx);
  const pool = f.pool();
  assert.equal(pool.length, 40);
  const brain = f.read('brain.json');
  const aged = { ...brain.buckets.greeting[0], addedAt: NOW - 14 * DAY };
  brain.buckets.greeting = [
    { ...aged, text: '衰减后淘汰', weight: 0.051 },
    { ...aged, text: '很久以前使用', weight: 2 },
    { ...aged, text: '刚使用过', weight: 3, lastUsedAt: NOW - HOUR },
    ...Array.from({ length: 150 }, (_, i) => ({ ...aged, text: '填充' + i, weight: 1 })),
  ];
  fs.writeFileSync(f.file('brain.json'), JSON.stringify(brain));
  await f.hooks['timer.tick'](f.ctx);
  const first = f.read('brain.json').buckets.greeting;
  assert.equal(first.length, 150);
  assert.equal(first[0].weight, 3);
  assert.equal(first[1].weight, 1.9);
  assert.ok(first.every(reply => reply.text !== '衰减后淘汰'));
  f.advance(HOUR - 1);
  await f.hooks['timer.tick'](f.ctx);
  assert.equal(f.read('brain.json').buckets.greeting[1].weight, 1.9);
  f.advance(1);
  await f.hooks['timer.tick'](f.ctx);
  assert.equal(f.read('brain.json').buckets.greeting[1].weight, 1.805);
  assert.deepEqual(f.pool(), pool);
  assert.equal(fs.readFileSync(f.file('activity.log'), 'utf8').match(/warning low_memory/g).length, 2);
});

test('startup completes an interrupted pool append without duplicating a record', async t => {
  const f = fixture(t);
  await f.hooks['app.start'](f.ctx);
  const text = '晚安要做个好梦';
  const row = { at: NOW, bucket: 'goodnight', text, source: 'learned' };
  const brain = f.read('brain.json');
  brain.buckets.goodnight = [{ ...traits, text, weight: 1, source: 'learned', addedAt: NOW, uses: 0, lastUsedAt: null }];
  const lines = JSON.stringify(row) + '\n';
  const partialBytes = Buffer.byteLength(lines.split(text)[0]) + 1;
  fs.writeFileSync(f.file('.pool-commit.tmp'), JSON.stringify({ offset: 0, lines, brain }));
  fs.appendFileSync(f.file('pool.jsonl'), Buffer.from(lines).subarray(0, partialBytes));
  await f.hooks['app.start'](f.ctx);
  assert.deepEqual(f.pool(), [row]);
  assert.deepEqual(f.read('brain.json'), brain);
  assert.equal(fs.existsSync(f.file('.pool-commit.tmp')), false);
});

test('moving the plugin data directory preserves config, replies and the learning window', async t => {
  const source = fixture(t);
  source.memory([{ role: 'assistant', text: '今天吃饭了吗' }]);
  await source.hooks['app.start'](source.config({ mode: 'probabilistic', probability: 1 }));
  await source.generate('随便聊聊', { finalText: '晚安好好睡吧' });
  const target = fixture(t);
  target.memory([{ role: 'assistant', text: '你好新朋友' }]);
  fs.cpSync(source.ctx.whale.paths.pluginData, target.ctx.whale.paths.pluginData, { recursive: true });
  await target.hooks['app.start'](target.config({}));
  assert.deepEqual(await target.generate('吃饭啦'), { text: '今天吃饭了吗' });
  await target.generate('随便聊聊', { finalText: '晚安好好睡吧' });
  assert.deepEqual(target.pool(), source.pool());
  assert.equal(target.read('brain.json').buckets.greeting, undefined);
  assert.equal(target.read('brain.json').buckets.food[0].uses, 1);
});
