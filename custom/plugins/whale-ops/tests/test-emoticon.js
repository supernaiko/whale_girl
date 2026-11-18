'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { hooks } = require('../plugin');

function context(text, { senderId = 'wxid_test_owner', chatType = 'private', platform = 'wechat',
  result = { ok: true, status: 'confirmed' } } = {}) {
  const calls = [];
  return {
    message: { text, senderId, chatType, chatId: 'wxid_test_chat', platform },
    state: { pending: { kind: 'open', arg: '记事本' } },
    settings: JSON.stringify({ owners: ['wxid_test_owner'], prefix: '助手' }),
    whale: { sendEmoticon: async (...args) => { calls.push(args); return result; } },
    calls,
  };
}

test('识别内置表情指令，直接使用当前会话，保留已有待确认操作', async () => {
  for (const [command, code] of [
    ['发一个[微笑]', '[微笑]'], ['发一个微笑表情', '[微笑]'], ['发一个捂脸', '[捂脸]'],
    ['助手 请发个旺柴吧。', '[旺柴]'], ['发个[不存在]', '[不存在]'],
  ]) {
    const ctx = context(command);
    assert.deepEqual(await hooks['chat.pre_reply'](ctx), { action: 'wake' });
    assert.deepEqual(await hooks['chat.generate'](ctx), { text: '' });
    assert.deepEqual(ctx.calls, [['wxid_test_chat', code]]);
    assert.deepEqual(ctx.state.pending, { kind: 'open', arg: '记事本' });
  }
});

test('普通表情聊天、非主人、未授权群聊和其它平台不触发表情发送', async () => {
  for (const ctx of [
    context('你刚发了一个[微笑]'), context('发个表情包'), context('发一个🙂'),
    context('发一个捂脸', { senderId: 'wxid_test_guest' }),
    context('发一个捂脸', { chatType: 'group' }),
    context('发一个捂脸', { platform: 'qq' }),
  ]) {
    assert.deepEqual(await hooks['chat.pre_reply'](ctx), { action: 'pass' });
    assert.deepEqual(await hooks['chat.generate'](ctx), {});
    assert.deepEqual(ctx.calls, []);
  }
});

test('失败、未确认及旧版宿主给出明确文字回执', async () => {
  const failed = context('发一个[不存在]', { result: { ok: false, status: 'failed', reason: 'not_converted' } });
  assert.match((await hooks['chat.generate'](failed)).text, /没有把这个代码识别为内置表情/);
  const uncertain = context('发一个捂脸', { result: { ok: false, status: 'unconfirmed' } });
  assert.match((await hooks['chat.generate'](uncertain)).text, /未确认/);
  assert.equal(uncertain.calls.length, 1);
  const old = context('发一个捂脸');
  delete old.whale.sendEmoticon;
  assert.match((await hooks['chat.generate'](old)).text, /4\.2\.0/);
});
