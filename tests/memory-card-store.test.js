'use strict';

/**
 * 记忆卡接入 Store 的集成回归：主人消息写进她自己的经历记忆卡，
 * buildContext 把它作为 memoryCardBlock 带出来，非主人不写。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/memory/store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mcard-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'store.json');
  return { store: new Store({ file, logger: null }), dataDir, dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
}

test('主人消息写进记忆卡，非主人不写', () => {
  const { store, dataDir, dir } = tempStore();
  store.appendMessage('owner', {
    role: 'user', name: '主人', uid: 'wxid_owner', text: '明天下午三点开会，记得带身份证', ts: Date.now(), isOwner: true,
  });
  store.appendMessage('other', {
    role: 'user', name: '路人', uid: 'wxid_other', text: '你好呀', ts: Date.now(), isOwner: false,
  });
  store.close();

  const cardFile = path.join(dataDir, 'memory', 'memory-card', 'memory-card.json');
  assert.ok(fs.existsSync(cardFile), '主人消息应落一张记忆卡');
  const card = JSON.parse(fs.readFileSync(cardFile, 'utf8'));
  assert.ok(card.records.length >= 1, '至少有一条主人记忆');
  const ownerRecord = card.records.find((r) => String(r.text).includes('身份证'));
  assert.ok(ownerRecord, '主人那条消息应在记忆卡里');
  assert.strictEqual(ownerRecord.platform, 'pet');
  assert.ok(ownerRecord.tags.includes('owner'));
  // 非主人那条「你好呀」不该进来（太短也会被过滤，但这里它根本不是 owner）
  assert.ok(!card.records.some((r) => String(r.text).includes('你好呀')), '非主人消息不写记忆卡');
  cleanup(dir);
});

test('buildContext 把记忆卡作为 memoryCardBlock 带出来', () => {
  const { store, dir } = tempStore();
  const now = Date.now();
  store.appendMessage('owner', {
    role: 'user', name: '主人', uid: 'wxid_owner', text: '我周末想吃火锅，你陪我', ts: now, isOwner: true,
  });
  const ctx = store.buildContext({ key: 'owner', uid: 'wxid_owner', name: '主人', now: now + 1000 });
  assert.ok(typeof ctx.memoryCardBlock === 'string', 'memoryCardBlock 应是字符串');
  assert.ok(ctx.memoryCardBlock.includes('火锅'), '记忆卡块里应包含刚写入的经历');
  store.close();
  cleanup(dir);
});

test('空卡不往上下文里塞空块', () => {
  const { store, dir } = tempStore();
  const ctx = store.buildContext({ key: 'nobody', uid: 'wxid_x', name: 'x', now: Date.now() });
  assert.strictEqual(ctx.memoryCardBlock, '', '没记过任何事时 memoryCardBlock 为空字符串');
  store.close();
  cleanup(dir);
});
