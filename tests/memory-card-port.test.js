'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mc = require('../src/memory/memoryCard.js');

const DAY = 24 * 60 * 60 * 1000;

test('主人私聊重要记忆永远不彻底遗忘（最差保持清楚）', () => {
  const card = mc.createEmptyCard();
  const r = mc.addMemoryRecord(card, {
    text: '主人说：明天下午三点开会，记得带身份证',
    source: 'qq-owner', sourceId: 'a', isOwner: true, isPrivate: true, direct: true,
    createdAt: Date.now(),
  });
  assert.strictEqual(r.added, true);
  assert.ok(r.record.importance >= 60);
  assert.strictEqual(r.record.clarity, 'vivid');
  // 很久以后仍不是 forgotten（owner + 重要度 >= minOwnerImportance 被保护）
  const t = mc.targetClarity(r.record, {}, Date.now() + 400 * DAY);
  assert.notStrictEqual(t, 'forgotten');
});

test('群友一条平淡短消息会随天数衰减到遗忘', () => {
  const card = mc.createEmptyCard();
  const r = mc.addMemoryRecord(card, {
    text: '群友说：哦', source: 'qq-group', sourceId: 'b',
    createdAt: Date.now(),
  });
  const t = mc.targetClarity(r.record, {}, Date.now() + 120 * DAY);
  assert.strictEqual(t, 'forgotten');
});

test('脱敏：密钥/令牌/手机号/身份证/链接都遮掉', () => {
  const out = mc.redactForMemory(
    '我的密码=abc123，token sk-abcdefgh12345678，手机13800138000，身份证110101199001011234，看 https://example.com/x',
    { scope: 'qq' },
  );
  assert.ok(out.includes('[已隐藏]'));
  assert.ok(out.includes('[手机号已隐藏]'));
  assert.ok(out.includes('[证件号已隐藏]'));
  assert.ok(out.includes('（链接已省略）'));
  assert.ok(!out.includes('abc123'));
});

test('重要度评分：主人私聊 > 群里，直接对她说加分', () => {
  const owner = mc.scoreMemory({ text: '我今天有点难过', source: 'qq-owner', isOwner: true, isPrivate: true, direct: true });
  const group = mc.scoreMemory({ text: '我今天有点难过', source: 'qq-group', isOwner: false, isPrivate: false });
  assert.ok(owner.importance > group.importance);
});

test('每日衰减：一次只降一档，不跳级', () => {
  const card = mc.createEmptyCard();
  const r = mc.addMemoryRecord(card, {
    text: '一个普通的、不太重要的事情', source: 'qq-group', sourceId: 'c',
    createdAt: Date.now() - 90 * DAY,
  });
  // 把初始 clarity 拉高，确保能连续降档
  r.record.clarity = 'vivid';
  const before = r.record.clarity;
  mc.applyDailyDecay(card, {}, Date.now(), { force: true, steps: 1 });
  const after = r.record.clarity;
  assert.notStrictEqual(after, before);
  const idx = mc.CLARITY_ORDER.indexOf(after);
  const prev = mc.CLARITY_ORDER.indexOf(before);
  assert.ok(idx === prev + 1 || idx === prev - 1, `一次只能降一档：${before} -> ${after}`);
});

test('初次/第一次 → pinned 锚点，重要度 100', () => {
  const card = mc.createEmptyCard();
  const r = mc.addMemoryRecord(card, {
    text: '第一次和主人说话', source: 'qq-owner', sourceId: 'd',
    isOwner: true, isPrivate: true, direct: true, isFirst: true,
    createdAt: Date.now(),
  });
  assert.strictEqual(r.record.pinned, true);
  assert.strictEqual(r.record.importance, 100);
});
