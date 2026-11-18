'use strict';
const { parseRange } = require('../range');

const { loadSeries } = require('../../stats/insights');
const { json } = require('../util');

module.exports = function register(router) {
  router.get('/api/insights/series', async (runtime, req, res, { url }) => {
    const { days, now, from, to } = parseRange(url);
    const requested = url.searchParams.get('bucket');
    const bucket = requested === 'hour' || requested === 'day' ? requested : days === 1 ? 'hour' : 'day';
    const data = await loadSeries(runtime.config.paths.dataDir, { days, bucket, now });
    return json(res, 200, { ok: true, days, from, to, bucket, ...data, generatedAt: now });
  });
};
