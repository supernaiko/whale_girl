'use strict';

const { inWindows, minutesOfDay, parseClock } = require('../infra/time');

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

// 在 models 下显式添加 pro 才启用，缺项按示例单价补齐。
const PRO_PRICING = {
  offPeak: { cacheHitPerM: 0.10, cacheMissPerM: 4, outputPerM: 16 },
  peak: { cacheHitPerM: 0.20, cacheMissPerM: 8, outputPerM: 32 },
};
const BEIJING = 'Asia/Shanghai';

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

function normalizePricing(saved) {
  const models = { flash: modelPricing(saved?.models?.flash, DEFAULT_PRICING.models.flash) };
  const pro = saved?.models?.pro;
  if (pro && typeof pro === 'object' && !Array.isArray(pro)) models.pro = modelPricing(pro, PRO_PRICING);
  const defaults = DEFAULT_PRICING.offPeakWindow;
  const start = validClock(saved?.offPeakWindow?.start, defaults.start);
  const end = validClock(saved?.offPeakWindow?.end, defaults.end);
  return { currency: DEFAULT_PRICING.currency, models, offPeakWindow: start === end ? defaults : { start, end } };
}

function usagePricer(pricing) {
  const { models, offPeakWindow } = pricing;
  const windows = [{ start: parseClock(offPeakWindow.start), end: parseClock(offPeakWindow.end) }];
  return (row, at) => {
    const band = inWindows(minutesOfDay(at, BEIJING), windows) ? 'offPeak' : 'peak';
    const model = row.model === 'deepseek-v4-pro' && models.pro ? models.pro : models.flash;
    const { cacheHitPerM, cacheMissPerM, outputPerM } = model[band];
    const prompt = nonnegative(row.prompt);
    const cached = Math.min(prompt, nonnegative(row.cached));
    const completion = nonnegative(row.completion);
    const costCny = (cached * cacheHitPerM + (prompt - cached) * cacheMissPerM + completion * outputPerM) / 1e6;
    return { band, prompt, cached, completion, costCny };
  };
}

module.exports = { BEIJING, DEFAULT_PRICING, normalizePricing, usagePricer };
