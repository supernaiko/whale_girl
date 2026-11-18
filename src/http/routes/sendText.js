'use strict';

const { sameWxid } = require('../../core/master');
const { isLoopbackRequest, safeEqual } = require('../security');
const { json, readBody } = require('../util');

function resolveChat(chat, contacts, account) {
  if (/^(filehelper|文件传输助手)$/i.test(chat)) return { wxid: 'filehelper', name: '文件传输助手' };
  const current = sameWxid(contacts?.account, account) ? contacts : null;
  const exact = current?.get(chat);
  if (exact) return exact;

  // 发送策略按真实会话 ID 生效。同名会话必须由操作者明确选定 ID。
  const matches = current?.items.filter(item => [item.name, item.remark].includes(chat)) || [];
  if (matches.length === 1) return matches[0];
  if (matches.length === 0 && /^(wxid_[\w-]+|[\w-]+@chatroom)$/i.test(chat)) {
    return { wxid: chat, name: chat };
  }
  return null;
}

module.exports = function register(router) {
  router.post('/api/send-text', async (runtime, req, res) => {
    const token = runtime.config.gateway?.wechat?.inboundToken;
    if (!isLoopbackRequest(req) || !token || !safeEqual(req.headers['x-bot-token'], token)) {
      return json(res, 403, { ok: false, error: '文本发送仅允许持有微信网关凭据的本机请求。' });
    }
    const body = await readBody(req, 128 * 1024);
    const { chat, text } = body;
    if (typeof chat !== 'string' || !chat.trim() || chat.trim().length > 120 || /[\x00-\x1f\x7f]/.test(chat)) {
      return json(res, 400, { ok: false, error: '请提供有效的微信会话名称或 ID。' });
    }
    if (typeof text !== 'string' || !text.trim() || text.length > 20000 || text.includes('\0')) {
      return json(res, 400, { ok: false, error: '请提供 1 到 20000 字的文本，且不要包含空字符（NUL）。' });
    }
    const gateway = runtime.gateways.get('wechat')?.status();
    if (!gateway?.enabled || !gateway.bridge?.online || !gateway.bridge.account) {
      return json(res, 503, { ok: false, error: '微信桥接未就绪，请启动桥接并确认微信已登录。' });
    }
    const target = resolveChat(chat.trim(), runtime.contacts, gateway.bridge.accountWxid || gateway.bridge.account);
    if (!target) {
      return json(res, 400, { ok: false, error: '当前账号的联系人中无法唯一定位会话，请使用微信会话 ID。' });
    }

    const pluginId = req.headers['x-whale-plugin'];
    const pluginHash = pluginId && runtime.bot?.javascriptPlugins?.installed().find(plugin => plugin.id === pluginId)?.hash;
    if (pluginId && !pluginHash) {
      return json(res, 403, { ok: false, error: '插件发送授权已撤回。' });
    }

    // 复用桥接的即时投递通道。插件调用保留授权标记，领取和发送前还能复查。
    const item = runtime.reminders.enqueueNow({
      wxid: target.wxid,
      name: target.label || target.name,
      chatType: target.isGroup || /@chatroom$/i.test(target.wxid) ? 'group' : 'private',
      text,
      ...(pluginId ? { kind: 'plugin', pluginId, pluginHash } : {}),
    });
    return json(res, 202, { ok: true, jobId: item.id, status: 'queued', confirmed: false });
  });
};
