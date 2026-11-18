'use strict';

const { loadSeries } = require('../../stats/insights');
const { json } = require('../util');

module.exports = function register(router) {
  router.get('/api/insights/series', async (runtime, req, res, { url }) => {
    const input = url.searchParams.get('days');
    const days = /^\d+$/.test(input || '') ? Math.min(365, Math.max(1, Number(input))) : 7;
    const requested = url.searchParams.get('bucket');
    const bucket = requested === 'hour' || requested === 'day' ? requested : days === 1 ? 'hour' : 'day';
    const now = Date.now();
    const data = await loadSeries(runtime.config.paths.dataDir, { days, bucket, now });
    return json(res, 200, { ok: true, days, bucket, ...data, generatedAt: now });
  });
};
