'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRouter } = require('../src/http/routes');

const TOKEN = 'test-only-text-token';

async function fixture(t) {
  const runtime = {
    config: { server: { allowRemote: true }, gateway: { wechat: { inboundToken: TOKEN } } },
    logger: { error() {}, warn() {} },
    gateways: new Map([['wechat', { status: () => ({ enabled: true, bridge: { online: true, account: 'test-account' } }) }]]),
    contacts: {
      account: 'test-account',
      get: () => null,
      items: [{ name: '同名', wxid: 'test-one' }, { name: '同名', wxid: 'test-two' }],
    },
    reminders: { enqueueNow: t.mock.fn(() => { assert.fail('校验请求不得进入发送队列'); }) },
  };
  const router = createRouter(runtime);
  const server = http.createServer((req, res) => {
    // 模拟远程调用通过全局 allowRemote 验证，仍应被发送路由自己的本机闸拒绝。
    if (req.headers['x-test-remote']) Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.5' });
    return router.handle(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.after(() => assert.equal(runtime.reminders.enqueueNow.mock.callCount(), 0));

  return async (body, headers = {}, path = '/api/send-text') => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + path, {
      method: 'POST',
      headers: { 'connection': 'close', 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
}

test('纯文本发送拒绝缺少、错误或仅在请求体中提供的 token，以及远程或跨站调用', async t => {
  const request = await fixture(t);
  const input = { chat: '文件传输助手', text: 'https://example.org/' };
  for (const [body, headers, path] of [
    [input],
    [input, { 'x-bot-token': 'wrong' }],
    [{ ...input, token: TOKEN }, {}, '/api/send-text?token=' + TOKEN],
    [input, { 'x-bot-token': TOKEN, 'x-test-remote': '1' }],
    [input, { 'x-bot-token': TOKEN, origin: 'https://example.org' }],
    [input, { 'x-bot-token': TOKEN, 'x-whale-plugin': 'uninstalled-fixture' }],
  ]) {
    const response = await request(body, headers, path);
    assert.equal(response.status, 403);
    assert.equal(response.body.ok, false);
  }
});

test('纯文本发送拒绝畸形 JSON、无效字段和无法唯一定位的会话', async t => {
  const request = await fixture(t);
  for (const body of [
    '{',
    [],
    {},
    { chat: 123, text: '验证' },
    { chat: ' ', text: '验证' },
    { chat: '第一行\n第二行', text: '验证' },
    { chat: '字'.repeat(121), text: '验证' },
    { chat: '文件传输助手', text: [] },
    { chat: '文件传输助手', text: ' \n ' },
    { chat: '文件传输助手', text: '前\0后' },
    { chat: '文件传输助手', text: '字'.repeat(20001) },
    { chat: '同名', text: '验证' },
    { chat: '不存在的会话', text: '验证' },
  ]) {
    const response = await request(body, { 'x-bot-token': TOKEN });
    assert.equal(response.status, 400);
    assert.equal(response.body.ok, false);
    assert.ok(response.body.error);
  }
});
