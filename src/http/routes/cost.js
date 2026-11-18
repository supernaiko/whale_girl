'use strict';
const { parseRange } = require('../range');

const fs = require('node:fs');
const path = require('node:path');
const { describeError } = require('../../infra/errors');
const { DEFAULT_PRICING, normalizePricing, usagePricer } = require('../../stats/pricing');
const { json } = require('../util');

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function readPricing(dataDir, logger) {
  const file = path.join(dataDir, 'pricing.json');
  let saved;
  try {
    saved = parseJson(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger?.warn('读取花销费率失败：' + describeError(err));
    } else {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(DEFAULT_PRICING, null, 2) + '\n', { flag: 'wx' });
      } catch (writeError) {
        if (writeError.code !== 'EEXIST') logger?.warn('创建花销费率失败：' + describeError(writeError));
      }
    }
  }
  const pricing = normalizePricing(saved);
  return {
    ...pricing,
    // 旧启动器用这两个字段折算 Codex，兼容返回直接使用人民币高峰价。
    rate: 1,
    deepseek: pricing.models.flash.peak,
  };
}

function localDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function emptyUsage() {
  return { requests: 0, prompt: 0, cached: 0, completion: 0, costCny: 0 };
}

function summarize(dataDir, range, pricing) {
  const start = new Date(range.start);
  const end = new Date(range.end);
  const nowDate = new Date(range.now);
  const midnight = new Date(nowDate);
  midnight.setHours(0, 0, 0, 0);
  const total = emptyUsage();
  const bands = { peak: emptyUsage(), offPeak: emptyUsage() };
  const buckets = new Map();
  const price = usagePricer(pricing);

  // 两个日志都很小，同步读取可以避免轮转夹在两次读取之间，导致同一份用量被算两遍。
  for (const file of ['usage.1.jsonl', 'usage.jsonl']) {
    let text;
    try {
      text = fs.readFileSync(path.join(dataDir, file), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const item = parseJson(line);
      if (typeof item?.at !== 'number' && typeof item?.at !== 'string') continue;
      const at = new Date(item.at);
      if (!(at >= start && at < end)) continue;
      const date = localDate(at);
      if (!buckets.has(date)) buckets.set(date, { usage: emptyUsage(), costs: { peak: 0, offPeak: 0 } });
      const day = buckets.get(date);
      const { band, prompt, cached, completion, costCny } = price(item, at.getTime());
      day.costs[band] += costCny;
      bands[band].costCny += costCny;
      for (const usage of [day.usage, total, bands[band]]) {
        usage.requests++;
        usage.prompt += prompt;
        usage.cached += cached;
        usage.completion += completion;
      }
    }
  }

  total.costCny = bands.peak.costCny + bands.offPeak.costCny;
  const byDay = [...buckets.keys()].sort().map(date => {
    const { usage, costs } = buckets.get(date);
    usage.costCny = costs.peak + costs.offPeak;
    return { date, ...usage, peakCostCny: costs.peak, offPeakCostCny: costs.offPeak };
  });
  return {
    today: buckets.get(localDate(midnight))?.usage || emptyUsage(),
    total,
    ...bands,
    byDay,
  };
}

module.exports = function register(router) {
  router.get('/api/cost/usage', (runtime, req, res, { url }) => {
    const range = parseRange(url);
    const { dataDir } = runtime.config.paths;
    const pricing = readPricing(dataDir, runtime.logger);
    return json(res, 200, { ok: true, days: range.days, from: range.from, to: range.to, ...summarize(dataDir, range, pricing), pricing });
  });
};
