'use strict';

const { isLoopbackRequest, safeEqual } = require('../security');
const { json, readBody } = require('../util');

module.exports = function register(router) {
  function authenticated(handler) {
    return (runtime, req, res, info) => {
      const token = runtime.config.gateway?.wechat?.inboundToken;
      if (!isLoopbackRequest(req) || !token || !safeEqual(req.headers['x-bot-token'], token)) {
        return json(res, 403, { ok: false, error: '文件发送仅允许持有微信网关凭据的本机请求。' });
      }
      return handler(runtime.fileSend, req, res, info);
    };
  }

  router.post('/api/send-file', authenticated(async (queue, req, res) => {
    const body = await readBody(req);
    const out = await queue.sendFile(body?.chat, body?.path, body?.note, req.headers['x-whale-plugin']);
    if (out.error) return json(res, out.status, { ok: false, error: out.error });
    return json(res, 202, { ok: true, jobId: out.jobId });
  }));

  router.get('/api/send-file/status', authenticated((queue, req, res, { url }) => {
    const out = queue.status(url.searchParams.get('id'));
    return out ? json(res, 200, { ok: true, ...out }) : json(res, 404, { ok: false, error: '文件任务不存在或已过期。' });
  }));

  router.post('/api/send-file/claim', authenticated(async (queue, req, res) => {
    const body = await readBody(req);
    if (typeof body?.account !== 'string' || !body.account) return json(res, 400, { ok: false, error: '缺少微信账号。' });
    return json(res, 200, { ok: true, item: queue.claim(body.account) });
  }));

  router.post('/api/send-file/permission', authenticated(async (queue, req, res) => {
    const body = await readBody(req);
    return json(res, 200, { ok: true, allowed: queue.permission(body?.id, body?.account) });
  }));

  router.post('/api/send-file/ack', authenticated(async (queue, req, res) => {
    const body = await readBody(req);
    if (!queue.ack(body?.id, body?.account, body?.status)) {
      return json(res, 409, { ok: false, error: '文件任务回执无效或已过期。' });
    }
    return json(res, 200, { ok: true });
  }));
};
