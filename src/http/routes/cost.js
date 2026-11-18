'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { describeError } = require('../../infra/errors');
const { inWindows, minutesOfDay, parseClock } = require('../../infra/time');
const { json } = require('../util');

const DEFAULT_PRICING = {
  currency: 'CNY',
  models: {
    flash: {
      offPeak: { cacheHitPerM: 0.02, cacheMissPerM: 1, outputPerM: 4 },
      peak: { cacheHitPerM: 0.04, cacheMissPerM: 2, outputPerM: 8 },
    },
  },
  offPeakWindow: { start: '00:30', end: '08:30' },
};

// 在 models 下显式添加 pro 才启用，缺项按任务给出的示例单价补齐。
const PRO_PRICING = {
  offPeak: { cacheHitPerM: 0.10, cacheMissPerM: 4, outputPerM: 16 },
  peak: { cacheHitPerM: 0.20, cacheMissPerM: 8, outputPerM: 32 },
};
const BEIJING = 'Asia/Shanghai';

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function nonnegative(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function modelPricing(saved, defaults) {
  return Object.fromEntries(Object.entries(defaults).map(([band, rates]) => [band, {
    cacheHitPerM: nonnegative(saved?.[band]?.cacheHitPerM, rates.cacheHitPerM),
    cacheMissPerM: nonnegative(saved?.[band]?.cacheMissPerM, rates.cacheMissPerM),
    outputPerM: nonnegative(saved?.[band]?.outputPerM, rates.outputPerM),
  }]));
}

function validClock(value, fallback) {
  return typeof value === 'string' && /^\d{2}:\d{2}$/.test(value) && parseClock(value) !== null ? value : fallback;
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
  const models = { flash: modelPricing(saved?.models?.flash, DEFAULT_PRICING.models.flash) };
  const pro = saved?.models?.pro;
  if (pro && typeof pro === 'object' && !Array.isArray(pro)) models.pro = modelPricing(pro, PRO_PRICING);
  const defaults = DEFAULT_PRICING.offPeakWindow;
  const start = validClock(saved?.offPeakWindow?.start, defaults.start);
  const end = validClock(saved?.offPeakWindow?.end, defaults.end);
  return {
    currency: DEFAULT_PRICING.currency,
    models,
    offPeakWindow: start === end ? defaults : { start, end },
    // 旧启动器用这两个字段折算 Codex，兼容返回直接使用人民币高峰价。
    rate: 1,
    deepseek: models.flash.peak,
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

function summarize(dataDir, days, pricing) {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const start = new Date(midnight);
  const end = new Date(midnight);
  start.setDate(start.getDate() - days + 1);
  end.setDate(end.getDate() + 1);
  const total = emptyUsage();
  const bands = { peak: emptyUsage(), offPeak: emptyUsage() };
  const buckets = new Map();
  const windows = [{ start: parseClock(pricing.offPeakWindow.start), end: parseClock(pricing.offPeakWindow.end) }];

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
      const band = inWindows(minutesOfDay(at.getTime(), BEIJING), windows) ? 'offPeak' : 'peak';
      const model = item.model === 'deepseek-v4-pro' && pricing.models.pro ? pricing.models.pro : pricing.models.flash;
      const { cacheHitPerM, cacheMissPerM, outputPerM } = model[band];
      const prompt = nonnegative(item.prompt);
      const cached = Math.min(prompt, nonnegative(item.cached));
      const completion = nonnegative(item.completion);
      const costCny = (cached * cacheHitPerM + (prompt - cached) * cacheMissPerM + completion * outputPerM) / 1e6;
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
    const input = url.searchParams.get('days')?.trim();
    const days = /^-?\d+$/.test(input || '') ? Math.min(365, Math.max(1, Number(input))) : 7;
    const { dataDir } = runtime.config.paths;
    const pricing = readPricing(dataDir, runtime.logger);
    return json(res, 200, { ok: true, days, ...summarize(dataDir, days, pricing), pricing });
  });
};
