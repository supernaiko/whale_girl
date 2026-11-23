'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { commandTarget, findTarget, hooks } = require('./plugin');
const { findHotTopic } = require('../../../src/services/careHotTopic');
const { generate } = require('../../../src/services/carePurpose');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'named-care-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('只识别点名搭话指令，去掉名字尾部的分隔符', () => {
  for (const line of ['去找 Tree 搭话。', '找 Tree 聊聊', '跟 Tree 说句话', '关心一下 Tree']) {
    assert.equal(commandTarget(line), 'tree');
  }
  assert.equal(commandTarget('去找 几度雨停. 搭话'), '几度雨停');
  assert.equal(commandTarget('怎么跟 Tree 搭话？'), '');
  assert.equal(commandTarget('去找一个文件'), '');
});

test('备注或昵称的精确匹配优先，重名、群聊和系统账号不发送', () => {
  const contact = { wxid: 'wxid_test_person', name: 'Tree', remark: '几度雨停.' };
  const similar = { wxid: 'wxid_test_other', name: 'Tree House' };
  const items = [{ wxid: 'filehelper', name: 'Tree' }, { wxid: 'g@chatroom', name: 'Tree' }, similar, contact];
  assert.equal(findTarget('tree', items), contact);
  assert.equal(findTarget('几度雨停', items), contact);
  assert.equal(findTarget('house', items), similar);
  assert.equal(findTarget('tree', items.concat({ wxid: 'wxid_test_duplicate', name: 'Tree.' })), null);
});

test('用真实微信 ID 排队，且仅在搭话和回执都入队后抑制主回复', async t => {
  const appData = tempDir(t);
  const owner = 'wxid_test_owner';
  const target = 'wxid_test_target';
  fs.writeFileSync(path.join(appData, 'contacts-cache.json'), JSON.stringify({ items: [
    { wxid: owner, name: '主人昵称' }, { wxid: target, name: 'Tree.' },
  ] }));
  const ctx = { message: { platform: 'wechat', chatType: 'private', senderId: owner, chatId: 'internal', text: '去找 tree 搭话' } };
  const sent = [];
  const whale = {
    paths: { appData },
    api: async () => ({ ok: true, body: { config: { persona: { master: { wxids: [owner] } } } } }),
    model: async () => { throw Error('offline'); },
    sendText: async (...args) => { sent.push(args); return { id: 'job', status: 'queued' }; },
  };
  const handle = message => hooks['chat.generate']({ message, whale });
  assert.deepEqual(await handle(ctx.message), { text: '' });
  assert.deepEqual(sent.map(([id,, opts]) => [id, opts.name]), [[target, 'Tree.'], [owner, '主人昵称']]);
  assert.match(sent[1][1], /排队/);
  sent.length = 0;
  assert.equal(await handle({ ...ctx.message, senderId: 'wxid_test_stranger' }), undefined);
  assert.equal(await handle({ ...ctx.message, chatType: 'group' }), undefined);
  assert.equal(sent.length, 0);
  whale.sendText = async id => {
    if (id === owner) throw Error('queue offline');
    return { id: 'target-job', status: 'queued' };
  };
  assert.equal(await handle(ctx.message), undefined);
});

test('只将有效的近期网页素材接入同一次生成，异常或空结果保持原始提示词', async t => {
  const dataDir = tempDir(t);
  fs.writeFileSync(path.join(dataDir, 'persona.json'), JSON.stringify({ interests: ['原神'] }));
  const now = Date.parse('2026-11-24T12:00:00Z');
  const topic = '玩家正在讨论新的角色预告。';
  const events = [
    { type: 'item.completed', item: { type: 'web_search' } },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({
      text: topic, url: 'https://example.com/news', date: '2026-11-23',
    }) } },
  ].map(event => JSON.stringify(event)).join('\n');
  const calls = [];
  const config = { paths: { dataDir }, persona: { customPrompt: '语气照常。' } };
  const runtime = { config, llm: { complete: async args => { calls.push(args); return '今天过得怎么样呀？'; } } };
  const run = async prompt => {
    assert.match(prompt, /原神/);
    assert.doesNotMatch(prompt, /语气照常/);
    return events;
  };
  const withTopic = await generate(runtime, { now, search: (cfg, time) => findHotTopic(cfg, time, run) });
  assert.equal(withTopic.ok, true);
  assert.match(calls[0].turns[0].content, /玩家正在讨论/);
  const offline = await generate(runtime, { now, search: async () => { throw Error('offline'); } });
  assert.equal(offline.text, withTopic.text);
  assert.deepEqual(calls[1], {
    system: calls[0].system,
    turns: [{ role: 'user', content: '按上面的要求，现在想一句要对主人说的话。' }],
  });
  assert.equal(await findHotTopic(config, now, async () => ''), '');
  assert.equal(await findHotTopic(config, now, async () => events.split('\n')[1]), '');
});
