'use strict';
// 连续消息收集：同一会话的消息先攒一个窗口，等对方停手再一次性处理。
// 图片/表情包这类空文本消息等得更久（mediaSettleMs），文字消息用 messageSettleMs；
// 窗口内有多条时合并成一条，有文字优先拼接文字、空消息被丢弃。
const { test } = require('node:test');
const assert = require('node:assert');
const { Gateway } = require('../src/adapters/gateway');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mockGateway(settle) {
  const calls = [];
  const chat = settle && typeof settle === 'object' ? settle : {};
  const gateway = new Gateway({
    platform: 'wechat',
    options: {},
    bot: {
      config: { chat },
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

test('空消息进入分段等待，窗口内来了文字则合并成一条只处理文字', async () => {
  const { gateway, calls } = mockGateway({ mediaSettleMs: 60, messageSettleMs: 20 });
  const r1 = await gateway.handleInbound({ chat_id: 'wxid-x', sender_id: 'wxid-x', text: '' }, { local: true });
  assert.equal(r1.action, 'ignore');
  assert.equal(r1.reason, 'settle_wait');
  assert.equal(calls.length, 0, '空消息不该立即处理');

  await sleep(10);
  const r2 = await gateway.handleInbound({ chat_id: 'wxid-x', sender_id: 'wxid-x', text: '你看这个' }, { local: true });
  assert.equal(r2.action, 'ignore', '文字也进入收集窗口');
  await sleep(120); // 等窗口到点
  assert.deepEqual(calls, ['你看这个'], '文字合并后处理一次，空消息被丢弃');
});

test('窗口内没有新消息，到点后处理空消息', async () => {
  const { gateway, calls } = mockGateway({ mediaSettleMs: 30, messageSettleMs: 20 });
  const r1 = await gateway.handleInbound({ chat_id: 'wxid-y', sender_id: 'wxid-y', text: '' }, { local: true });
  assert.equal(r1.reason, 'settle_wait');
  await sleep(100);
  assert.deepEqual(calls, [''], '到点后处理空消息');
});

test('连续多条文字消息合并成一条处理', async () => {
  const { gateway, calls } = mockGateway({ mediaSettleMs: 60, messageSettleMs: 30 });
  await gateway.handleInbound({ chat_id: 'wxid-m', sender_id: 'wxid-m', text: '第一句' }, { local: true });
  await sleep(5);
  await gateway.handleInbound({ chat_id: 'wxid-m', sender_id: 'wxid-m', text: '第二句' }, { local: true });
  await sleep(5);
  await gateway.handleInbound({ chat_id: 'wxid-m', sender_id: 'wxid-m', text: '第三句' }, { local: true });
  await sleep(150);
  assert.deepEqual(calls, ['第一句\n第二句\n第三句'], '三条合并成一条');
});

test('连续多条空消息合并成一条处理', async () => {
  const { gateway, calls } = mockGateway({ mediaSettleMs: 30, messageSettleMs: 20 });
  await gateway.handleInbound({ chat_id: 'wxid-n', sender_id: 'wxid-n', text: '' }, { local: true });
  await gateway.handleInbound({ chat_id: 'wxid-n', sender_id: 'wxid-n', text: '' }, { local: true });
  await sleep(100);
  assert.deepEqual(calls, [''], '多条空消息合并成一次');
});

test('未配置 settle 时不挂起，立即处理', async () => {
  const { gateway, calls } = mockGateway({});
  await gateway.handleInbound({ chat_id: 'wxid-z', sender_id: 'wxid-z', text: '' }, { local: true });
  assert.deepEqual(calls, [''], '未配置 settle 时立即处理');
});

test('不同会话互不干扰', async () => {
  const { gateway, calls } = mockGateway({ mediaSettleMs: 60, messageSettleMs: 20 });
  await gateway.handleInbound({ chat_id: 'wxid-a', sender_id: 'wxid-a', text: '' }, { local: true });
  await gateway.handleInbound({ chat_id: 'wxid-b', sender_id: 'wxid-b', text: '' }, { local: true });
  assert.equal(calls.length, 0);
  await gateway.handleInbound({ chat_id: 'wxid-a', sender_id: 'wxid-a', text: 'a说话' }, { local: true });
  await sleep(120);
  assert.deepEqual(calls, ['a说话', ''], 'a 处理文字，b 到点处理空消息');
});
