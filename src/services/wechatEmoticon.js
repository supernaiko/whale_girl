'use strict';

const { describeError } = require('../infra/errors');

const BRIDGE_URL = 'http://127.0.0.1:47821/send_emoticon';
const REASONS = new Set(['invalid_request', 'invalid_chat', 'invalid_code', 'bridge_auth_failed',
  'bridge_busy', 'target_unavailable', 'send_blocked', 'foreground_unavailable', 'focus_unavailable',
  'clipboard_unavailable', 'draft_not_empty', 'not_converted', 'draft_unverified', 'delivery_unverified']);

function parseRequest(body) {
  const chat = typeof body?.chat === 'string' ? body.chat.trim() : '';
  if (!chat || [...chat].length > 120 || /[\x00-\x1f\x7f]/.test(body.chat)) {
    return { reason: 'invalid_chat' };
  }
  const input = typeof body.code === 'string' ? body.code.trim() : '';
  const name = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
  if (!/^[A-Za-z0-9\u3400-\u9fff]{1,20}$/.test(name)) return { reason: 'invalid_code' };
  return { chat, code: `[${name}]` };
}

async function sendEmoticon(runtime, body, { signal, fetcher = fetch } = {}) {
  const payload = parseRequest(body);
  if (payload.reason) return { ok: false, status: 'failed', reason: payload.reason };
  const token = runtime.config.gateway?.wechat?.inboundToken;
  if (!token) return { ok: false, status: 'failed', reason: 'bridge_auth_failed' };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) return { ok: false, status: 'failed', reason: 'send_blocked' };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 24000);
  try {
    const response = await fetcher(BRIDGE_URL, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-bot-token': token },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (response.ok && data?.ok === true && data.status === 'confirmed') {
      return { ok: true, status: 'confirmed', reason: '' };
    }
    if (data?.ok === false && ['failed', 'unconfirmed'].includes(data.status) && REASONS.has(data.reason)) {
      runtime.logger?.warn?.('内置表情桥接失败：' + describeError({
        name: 'BridgeError', code: data.reason, status: response.status, detail: data.status,
      }));
      return { ok: false, status: data.status, reason: data.reason };
    }
    throw Object.assign(Error('桥接回执格式不符'), { status: response.status, code: 'invalid_bridge_response' });
  } catch (err) {
    const code = err.cause?.code || err.code;
    runtime.logger?.warn?.('内置表情接口失败：' + describeError({
      name: err.name, code, status: err.status, detail: 'bridge_request',
    }));
    if (code === 'ECONNREFUSED') return { ok: false, status: 'failed', reason: 'bridge_unavailable' };
    return { ok: false, status: 'unconfirmed', reason: 'delivery_unverified' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

module.exports = { parseRequest, sendEmoticon };
