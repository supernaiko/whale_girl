'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { createRouter } = require('../src/http/routes');
const { DeepSeekClient } = require('../src/llm/client');

const defaults = {
  currency: 'CNY',
  models: {
    flash: {
      offPeak: { cacheHitPerM: 0.02, cacheMissPerM: 1, outputPerM: 4 },
      peak: { cacheHitPerM: 0.04, cacheMissPerM: 2, outputPerM: 8 },
    },
  },
  offPeakWindow: { start: '00:30', end: '08:30' },
};

const codexSample = { prompt: 38_420_000, cached: 37_110_000, completion: 246_000 };

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cost-usage-'));
  const logger = { warn() {}, error(message) { assert.fail(message); } };
  const config = { paths: { dataDir, settingsFile: path.join(dataDir, 'settings.json') } };
  const router = createRouter({ config, logger });
  const server = http.createServer((req, res) => router.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    config, logger,
    file: name => path.join(dataDir, name),
    async get(query = '') {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/cost/usage${query}`,
        { headers: { connection: 'close' } });
      assert.equal(response.status, 200);
      return response.json();
    },
  };
}

function day(offset) {
  const result = new Date();
  result.setHours(12, 0, 0, 0);
  result.setDate(result.getDate() + offset);
  return result;
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function almostEqual(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} vs ${expected}`);
}

function beijingTime(clock) {
  const yesterdayUtc = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return `${yesterdayUtc}T${clock}:00+08:00`;
}

test('a new ledger returns zero usage and creates default pricing', async t => {
  const f = await fixture(t);
  const zero = { requests: 0, prompt: 0, cached: 0, completion: 0, costCny: 0 };
  assert.deepEqual(await f.get(), { ok: true, days: 7, today: zero, total: zero, peak: zero, offPeak: zero, byDay: [],
    pricing: { ...defaults, rate: 1, deepseek: defaults.models.flash.peak } });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file('pricing.json'), 'utf8')), defaults);
  assert.equal(fs.existsSync(f.file('usage.jsonl')), false);
});

test('usage includes rotated records, groups by local day and bills output once', async t => {
  const f = await fixture(t);
  const record = (offset, fields = {}) => JSON.stringify({
    at: day(offset).toISOString(), prompt: 1000, cached: 250, completion: 100, reasoning: 40, ...fields,
  });
  fs.writeFileSync(f.file('usage.1.jsonl'), [record(-7), record(-6), record(-1)].join('\n') + '\n');
  fs.writeFileSync(f.file('usage.jsonl'), [record(0, { at: +day(0) }), record(0), record(1), '{'].join('\r\n'));
  const one = offset => {
    const beijing = new Date(+day(offset) + 8 * 60 * 60 * 1000);
    const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
    return 0.001155 * (minutes >= 30 && minutes < 510 ? 1 : 2);
  };
  const result = await f.get('?days=7');
  assert.deepEqual(result.byDay.map(row => [row.date, row.requests]), [
    [dayKey(day(-6)), 1], [dayKey(day(-1)), 1], [dayKey(day(0)), 2],
  ]);
  assert.deepEqual(result.today, { requests: 2, prompt: 2000, cached: 500, completion: 200, costCny: result.today.costCny });
  almostEqual(result.today.costCny, one(0) * 2);
  almostEqual(result.total.costCny, one(-6) + one(-1) + one(0) * 2);
  almostEqual(result.byDay[0].costCny, one(-6));
  const todayOnly = await f.get('?days=1');
  assert.deepEqual(todayOnly.total, result.today);
  assert.equal(todayOnly.byDay.length, 1);
});

for (const [band, clock, expected] of [['offPeak', '03:00', 3.0362], ['peak', '09:00', 6.0724]]) {
  test(`Codex sample re-priced at Flash ${band} rates`, async t => {
    const f = await fixture(t);
    fs.writeFileSync(f.file('usage.jsonl'), JSON.stringify({ at: beijingTime(clock), ...codexSample }));
    const result = await f.get();
    assert.deepEqual(result[band], { requests: 1, ...codexSample, costCny: result.total.costCny });
    almostEqual(result.total.costCny, expected);
    almostEqual(result.byDay[0][`${band}CostCny`], expected);
  });
}

test('each timestamp determines its own band and daily costs sum to total', async t => {
  const f = await fixture(t);
  const records = [
    { at: beijingTime('09:00'), ...codexSample },
    { at: Date.parse(beijingTime('03:00')), ...codexSample },
  ];
  fs.writeFileSync(f.file('usage.jsonl'), records.map(item => JSON.stringify(item)).join('\n'));
  const { peak, offPeak, total, byDay } = await f.get();
  assert.deepEqual([peak.requests, offPeak.requests, total.requests], [1, 1, 2]);
  almostEqual(peak.costCny, 6.0724);
  almostEqual(offPeak.costCny, 3.0362);
  assert.equal(total.costCny, peak.costCny + offPeak.costCny);
  almostEqual(byDay.reduce((sum, day) => sum + day.peakCostCny, 0), peak.costCny);
  almostEqual(byDay.reduce((sum, day) => sum + day.offPeakCostCny, 0), offPeak.costCny);
});

test('Beijing off-peak window includes 00:30 and excludes 08:30', async t => {
  const f = await fixture(t);
  const records = [['00:29', 1], ['00:30', 10], ['08:29', 100], ['08:30', 1000]];
  fs.writeFileSync(f.file('usage.jsonl'), records.map(([clock, completion]) =>
    JSON.stringify({ at: beijingTime(clock), completion })).join('\n'));
  const { peak, offPeak } = await f.get();
  assert.equal(peak.completion, 1001);
  assert.equal(offPeak.completion, 110);
});

test('pricing fills missing fields and preserves valid overrides including zero', async t => {
  const f = await fixture(t);
  fs.writeFileSync(f.file('pricing.json'), JSON.stringify({
    rate: 7.15,
    models: { flash: { offPeak: { cacheHitPerM: 0, outputPerM: -1 } } },
    offPeakWindow: { start: '01:00', end: 'invalid' },
  }));
  fs.writeFileSync(f.file('usage.jsonl'), JSON.stringify({ at: beijingTime('03:00'), prompt: 300, cached: 200, completion: 100 }));
  const result = await f.get();
  assert.deepEqual(result.pricing.models.flash, {
    ...defaults.models.flash, offPeak: { ...defaults.models.flash.offPeak, cacheHitPerM: 0 },
  });
  assert.deepEqual(result.pricing.offPeakWindow, { start: '01:00', end: '08:30' });
  almostEqual(result.offPeak.costCny, 0.0005);
  for (const saved of ['{', '{"rate":7.15,"deepseek":{"cacheHitPerM":0.028}}']) {
    fs.writeFileSync(f.file('pricing.json'), saved);
    const fallback = await f.get();
    assert.deepEqual(fallback.pricing.models, defaults.models);
    almostEqual(fallback.offPeak.costCny, 0.000504);
  }
});

test('configured Pro rates apply to Pro records while Flash rates still apply to Flash records', async t => {
  const f = await fixture(t);
  const at = beijingTime('03:00');
  fs.writeFileSync(f.file('usage.jsonl'), [
    { at, model: 'deepseek-flash', completion: 1_000_000 },
    { at, model: 'deepseek-v4-pro', completion: 1_000_000 },
  ].map(item => JSON.stringify(item)).join('\n'));
  fs.writeFileSync(f.file('pricing.json'), JSON.stringify({ models: { pro: { offPeak: { outputPerM: 10 } } } }));
  const result = await f.get();
  assert.equal(result.offPeak.costCny, 14);
  assert.equal(result.pricing.models.pro.offPeak.outputPerM, 10);
});

test('days is bounded to 1–365 and invalid values default to seven', async t => {
  const f = await fixture(t);
  for (const [input, expected] of [['0', 1], ['-1', 1], ['30', 30], ['365', 365], ['500', 365], ['', 7], ['NaN', 7], ['1.5', 7]]) {
    assert.equal((await f.get(`?days=${input}`)).days, expected, input);
  }
});

test('DeepSeek usage appends only ledger fields and replaces the previous rotation', async t => {
  const f = await fixture(t);
  const client = new DeepSeekClient({ config: f.config, logger: f.logger });
  const reply = { usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 100, completion_tokens: 10,
    completion_tokens_details: { reasoning_tokens: 5 } } };
  client._recordUsage(reply, 'chat', 'test-request');
  const first = JSON.parse(fs.readFileSync(f.file('usage.jsonl'), 'utf8'));
  assert.deepEqual(first, { at: client.lastUsage.at, purpose: 'chat', model: client.model,
    prompt: 120, cached: 100, completion: 10, reasoning: 5 });
  const active = f.file('usage.jsonl');
  const rotated = f.file('usage.1.jsonl');
  fs.truncateSync(active, 5 * 1024 * 1024);
  fs.writeFileSync(rotated, 'old\n');
  client._recordUsage(reply, 'background', undefined, { provider: 'deepseek', model: 'deepseek-reasoner' });
  assert.equal(fs.statSync(rotated).size, 5 * 1024 * 1024);
  const next = fs.readFileSync(active, 'utf8');
  assert.equal(JSON.parse(next).model, 'deepseek-reasoner');
  client._recordUsage(reply, 'chat', undefined, { provider: 'custom', model: 'other' });
  assert.equal(fs.readFileSync(active, 'utf8'), next);
  assert.equal(client.lastUsage.promptTokens, 120);
});

test('token-count probes enter the cost ledger without changing in-memory chat usage', async t => {
  const f = await fixture(t);
  f.config.deepseek = { baseUrl: 'http://127.0.0.1:9/v1' };
  const client = new DeepSeekClient({ config: f.config, logger: f.logger });
  const replies = [30, 5];
  client._open = async () => {
    const usage = { prompt_tokens: replies.shift(), completion_tokens: 1 };
    const res = Readable.from([Buffer.from(JSON.stringify({ usage }))]);
    res.statusCode = 200;
    return { res };
  };
  assert.equal((await client.countPromptTokens('example')).tokens, 25);
  assert.equal(client.usageEvents.length, 0);
  const usage = (await f.get('?days=1')).today;
  assert.deepEqual([usage.requests, usage.prompt, usage.completion], [2, 35, 2]);
});
