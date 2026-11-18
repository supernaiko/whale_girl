'use strict';

const { loadUsage, dailyBuckets, chatStats, hourlyHeatmap, kpi, loadPricing } = require('../../stats/aggregator');
const { json } = require('../util');

module.exports = function register(router) {
  router.get('/api/stats/overview', async (runtime, req, res, { url }) => {
    const input = url.searchParams.get('days');
    const days = input === '1' ? 1 : input === '30' ? 30 : 7;
    // 今天的概览也要有完整的七天图，免得启动器重复扫描会话日志。
    const dailyDays = Math.max(days, 7);
    const now = Date.now();
    const { dataDir } = runtime.config.paths;
    const [rows, chats, pricing] = await Promise.all([
      loadUsage(dataDir, { days: dailyDays, now }),
      chatStats(dataDir, { days, now }),
      loadPricing(dataDir),
    ]);
    const options = { days, now, pricing };
    return json(res, 200, {
      ok: true,
      kpi: kpi(rows, chats, options),
      daily: dailyBuckets(rows, { ...options, days: dailyDays }),
      heatmap: hourlyHeatmap(rows, options),
      chats,
      generatedAt: now,
    });
  });
  router.get('/api/stats/context', (runtime, req, res) => json(res, 200, { ok: true, parts: [] }));
};
