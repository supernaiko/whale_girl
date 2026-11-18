'use strict';
// node tests/run-tests.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');
const plugin = require('../plugin.js');

const sent = [];
let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + ' → ' + e.message); }
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'whale-memo-')); }
function ctx(dir, over = {}) {
  const d = path.join(dir, 'data');
  return {
    settings: { owners: ['wxid_owner'], ...(over.settings || {}) },
    message: over.message || { senderId: 'wxid_owner', chatId: 'wxid_owner', chatType: 'private', text: '' },
    whale: {
      paths: { pluginData: d, appData: dir },
      model: over.model || (async () => '{"facts":["主人养了一只猫叫团子"],"promises":["周末不问工作"],"style":["叫主人老陈"]}'),
      sendText: over.sendText || (async (...a) => { sent.push(a); }),
    },
    force: over.force,
    tool: over.tool,
    settingsFromHost: over.settingsFromHost,
  };
}
function lines(dir) {
  try { return fs.readFileSync(path.join(dir, 'data', 'chat.jsonl'), 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
}

(async () => {
  console.log('whale-memo tests');

  check('parseModel 可单独调用', () => assert.equal(typeof plugin._internal.parseModel('{}'), 'object'));
  {
    const dir = tmp();
    const c = ctx(dir, { message: { senderId: 'wxid_owner', chatId: 'wxid_owner', chatType: 'private', text: '今天加班到十点' } });
    const r = await plugin['chat.pre_reply'](c);
    assert.equal(r.action, 'pass');
    assert.equal(lines(dir).length, 1);
    assert.equal(JSON.parse(lines(dir)[0]).text, '今天加班到十点');
    assert.ok(fs.existsSync(path.join(dir, 'data', 'owner.json')));
  }

  check('owners 非空时忽略陌生人', async () => {
    const dir = tmp();
    const c = ctx(dir, { message: { senderId: 'wxid_stranger', chatId: 'x', chatType: 'private', text: '在吗' } });
    await plugin['chat.pre_reply'](c);
    assert.equal(lines(dir).length, 0);
  });

  check('没有待确认草稿时「确认记忆」不唤醒', async () => {
    const dir = tmp();
    const c = ctx(dir, { message: { senderId: 'wxid_owner', chatId: 'wxid_owner', chatType: 'private', text: '确认记忆' } });
    const r = await plugin['chat.pre_reply'](c);
    assert.equal(r.action, 'pass');
    const g = await plugin['chat.generate'](c);
    assert.ok(g.text.includes('还没有待确认'));
  });

  check('tick 生成草稿、发消息、写文件', async () => {
    const dir = tmp();
    const d = path.join(dir, 'data');
    fs.mkdirSync(d, { recursive: true });
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push(JSON.stringify({ t: Date.now(), text: '消息 ' + i }));
    fs.writeFileSync(path.join(d, 'chat.jsonl'), rows.join('\n') + '\n', 'utf8');
    const c = ctx(dir, { force: true });
    const r = await plugin['timer.tick'](c);
    assert.equal(r.ok, true);
    assert.equal(r.items.facts[0], '主人养了一只猫叫团子');
    assert.ok(fs.existsSync(path.join(d, 'draft.md')));
    assert.ok(fs.existsSync(path.join(d, 'pending.json')));
    assert.ok(sent.length >= 1);
    const msg = String(sent[sent.length - 1][1]);
    assert.ok(msg.includes('确认记忆'));
  });

  check('同一自然日不重复跑', async () => {
    const dir = tmp();
    const d = path.join(dir, 'data');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'chat.jsonl'), Array.from({ length: 12 }, (_, i) => JSON.stringify({ t: i, text: 'm' + i })).join('\n') + '\n', 'utf8');
    const c = ctx(dir, { force: true });
    await plugin['timer.tick'](c);
    const second = await plugin['timer.tick'](ctx(dir, { force: true }));
    assert.equal(second.ok, false);
    assert.ok(second.reason.includes('已经跑过'));
  });

  check('确认后并入 persona.json 并清 pending', async () => {
    const dir = tmp();
    const d = path.join(dir, 'data');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({ name: '雅小奈', customPrompt: '你是鲸鲸。' }), 'utf8');
    fs.writeFileSync(path.join(d, 'chat.jsonl'), Array.from({ length: 12 }, (_, i) => JSON.stringify({ t: i, text: 'm' + i })).join('\n') + '\n', 'utf8');
    const c = ctx(dir, { force: true });
    const t = await plugin['timer.tick'](c);
    assert.equal(t.ok, true);
    const wake = await plugin['chat.pre_reply'](ctx(dir, { message: { senderId: 'wxid_owner', chatId: 'wxid_owner', chatType: 'private', text: '确认记忆' } }));
    assert.equal(wake.action, 'wake');
    const g = await plugin['chat.generate'](ctx(dir, { message: { senderId: 'wxid_owner', chatId: 'wxid_owner', chatType: 'private', text: '确认记忆' } }));
    assert.ok(g.text.includes('并入人设'), g.text);
    const persona = JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8'));
    assert.ok(persona.customPrompt.includes('【我们之间】'));
    assert.ok(persona.customPrompt.includes('团子'));
    assert.ok(persona.customPrompt.startsWith('你是鲸鲸。'));
    assert.ok(!fs.existsSync(path.join(d, 'pending.json')));
    assert.ok(fs.existsSync(path.join(d, 'persona.bak.json')));

    const again = await plugin['chat.generate'](ctx(dir, { message: { senderId: 'wxid_owner', chatId: 'wxid_owner', chatType: 'private', text: '确认记忆' } }));
    assert.ok(again.text.includes('还没有待确认'));
  });

  check('重复内容不重复并入', async () => {
    const dir = tmp();
    const d = path.join(dir, 'data');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({ customPrompt: '你是鲸鲸。\n\n【我们之间】\n- 事实：主人养了一只猫叫团子' }), 'utf8');
    fs.writeFileSync(path.join(d, 'chat.jsonl'), Array.from({ length: 12 }, (_, i) => JSON.stringify({ t: i, text: 'm' + i })).join('\n') + '\n', 'utf8');
    await plugin['timer.tick'](ctx(dir, { force: true }));
    const g = await plugin['chat.generate'](ctx(dir, { message: { senderId: 'wxid_owner', chatId: 'wxid_owner', chatType: 'private', text: '确认记忆' } }));
    assert.ok(g.text.includes('没有新内容'), g.text);
  });

  check('「整理记忆」唤醒并当场出草稿（不重复发送）', async () => {
    const dir = tmp();
    const d = path.join(dir, 'data');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'chat.jsonl'), Array.from({ length: 12 }, (_, i) => JSON.stringify({ t: i, text: 'm' + i })).join('\n') + '\n', 'utf8');
    const m = { senderId: 'wxid_owner', chatId: 'wxid_owner', chatType: 'private', text: '整理记忆' };
    const before = sent.length;
    const wake = await plugin['chat.pre_reply'](ctx(dir, { message: m }));
    assert.equal(wake.action, 'wake');
    const g = await plugin['chat.generate'](ctx(dir, { message: m }));
    assert.ok(g.text.includes('确认记忆'), g.text);
    assert.equal(sent.length, before, '整理记忆时不应再额外发一条');
    assert.ok(fs.existsSync(path.join(d, 'pending.json')));
  });

  check('解析模型脏输出', async () => {
    const items = plugin._internal.parseModel('好的：\n```json\n{"facts":["a"],"promises":[],"style":[]}\n```');
    assert.equal(items.facts[0], 'a');
    assert.equal(plugin._internal.parseModel('无'), null);
  });

  console.log(failures ? `\n${failures} 个失败` : '\n全部通过');
  process.exit(failures ? 1 : 0);
})();
