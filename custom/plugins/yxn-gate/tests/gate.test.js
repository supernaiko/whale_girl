'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hooks = require('../plugin.js');
const { scoreMessage } = hooks.__test;

function ctx(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yxn-gate-'));
  return {
    paths: { pluginData: dir },
    isMaster: false,
    lastBotReplyAt: 0,
    recentMessages: [],
    groupMessagesLast5Min: 0,
    ...over,
    settings: over.settings || {},
    message: Object.assign({
      platform: 'wechat',
      chatId: 'group_1',
      chatType: 'group',
      senderId: 'wxid_other',
      senderName: '某人',
      text: '今天天气不错',
      atMe: false,
      replyToBot: false,
    }, over.message || {}),
  };
}

test('私聊一律 pass', async () => {
  const r = await hooks['chat.pre_reply'](ctx({ message: { chatType: 'private', chatId: 'u1' } }));
  assert.equal(r.action, 'pass');
});

test('@ 了她 pass，交给宿主', async () => {
  const r = await hooks['chat.pre_reply'](ctx({ message: { atMe: true, text: '鲸鲸来一下' } }));
  assert.equal(r.action, 'pass');
});

test('只是陈述 pass', async () => {
  const r = await hooks['chat.pre_reply'](ctx({ message: { text: '今天食堂排队挺久' } }));
  assert.equal(r.action, 'pass');
});

test('叫名字 + 疑问 → wake', async () => {
  const r = await hooks['chat.pre_reply'](ctx({ message: { text: '小奈今天怎么没说话？' } }));
  assert.equal(r.action, 'wake');
});

test('只有链接 pass', async () => {
  const r = await hooks['chat.pre_reply'](ctx({ message: { text: 'https://example.com/a' } }));
  assert.equal(r.action, 'pass');
});

test('在跟别人说 pass', async () => {
  const r = await hooks['chat.pre_reply'](ctx({ message: { text: '小奈你看呢', directedElsewhere: true } }));
  assert.equal(r.action, 'pass');
});

test('刚回过 30 秒 → 冷却 pass', async () => {
  const r = await hooks['chat.pre_reply'](ctx({
    lastBotReplyAt: Date.now() - 30 * 1000,
    message: { text: '小奈你觉得呢？' },
  }));
  assert.equal(r.action, 'pass');
});

test('每小时上限生效', async () => {
  const c = ctx({ settings: { maxWakesPerHour: 1 }, message: { text: '小奈你怎么看？' } });
  const first = await hooks['chat.pre_reply'](c);
  assert.equal(first.action, 'wake');
  const second = await hooks['chat.pre_reply'](c);
  assert.equal(second.action, 'pass');
});

test('打分：叫名字 + 疑问 + 长度合适 > 0.6', () => {
  const { score, features } = scoreMessage({ text: '小奈你今天怎么这么安静？', atMe: false }, {});
  assert.ok(score >= 0.6, `score=${score}`);
  assert.equal(features['叫名字'], 0.4);
});
