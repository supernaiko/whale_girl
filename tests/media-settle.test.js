'use strict';
// 分段缓冲（media settle）：图片/表情包这类没有文字的消息，先挂起一个窗口，
// 看对方会不会接着发下半句；窗口内来了文字就丢弃空消息只处理文字。
const { test } = require('node:test');
const assert = require('node:assert');
const { Gateway } = require('../src/adapters/gateway');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockGateway(handle, mediaSettleMs) {
  const calls = [];
  const gateway = new Gateway({
    platform: 'wechat',
    options: {},
    bot: {
      config: { chat: mediaSettleMs === undefined ? {} : { mediaSettleMs } },
      handle: async (msg) => {
        calls.push(String((msg && msg.text) || ''));
        return { action: 'reply', reply: '回' + ((msg && msg.text) || '空'), bubbles: ['回' + ((msg && msg.text) || '空')] };
      },
      messagePlugins: null,
    },
    logger: null,
  });
  return { gateway, calls };
}

test('图片/表情包消息进入分段等待，窗口内来了文字则丢弃空消息只处理文字', async () => {
  const { gateway, calls } = mockGateway(null, 60);
  const r1 = await gateway.handleInbound({ chat_id: 'wxid-x', sender_id: 'wxid-x', text: '' }, { local: true });
  assert.equal(r1.action, 'ignore');
  assert.equal(r1.reason, 'media_settle_wait');
  assert.equal(calls.length, 0, '空消息不该立即处理');

  await sleep(20);
  const r2 = await gateway.handleInbound({ chat_id: 'wxid-x', sender_id: 'wxid-x', text: '你看这个' }, { local: true });
  assert.equal(r2.action, 'reply');
  await sleep(120); // 等挂起 timer 到点，确认空消息没被补处理
  assert.deepEqual(calls, ['你看这个'], '只处理文字，空消息被丢弃');
});

test('窗口内没有文字，到点后正常处理空消息', async () => {
  const { gateway, calls } = mockGateway(null, 30);
  const r1 = await gateway.handleInbound({ chat_id: 'wxid-y', sender_id: 'wxid-y', text: '' }, { local: true });
  assert.equal(r1.reason, 'media_settle_wait');
  await sleep(100);
  assert.deepEqual(calls, [''], '到点后处理空消息');
});

test('mediaSettleMs 未配置时不挂起，空消息立即处理', async () => {
  const { gateway, calls } = mockGateway(null, undefined);
  await gateway.handleInbound({ chat_id: 'wxid-z', sender_id: 'wxid-z', text: '' }, { local: true });
  assert.deepEqual(calls, [''], '未配置 settle 时立即处理');
});

test('不同会话的空消息互不干扰', async () => {
  const { gateway, calls } = mockGateway(null, 60);
  await gateway.handleInbound({ chat_id: 'wxid-a', sender_id: 'wxid-a', text: '' }, { local: true });
  await gateway.handleInbound({ chat_id: 'wxid-b', sender_id: 'wxid-b', text: '' }, { local: true });
  assert.equal(calls.length, 0);
  // a 会话来了文字，b 的空消息仍在等
  await gateway.handleInbound({ chat_id: 'wxid-a', sender_id: 'wxid-a', text: 'a说话' }, { local: true });
  await sleep(120);
  assert.deepEqual(calls, ['a说话', ''], 'a 处理文字，b 到点处理空消息');
});
