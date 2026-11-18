'use strict';

// 端到端（本地假 DSH）：确认 → 启动子进程 → 解析 --json 事件 → 回消息。
const assert = require('node:assert');
const path = require('node:path');

const plugin = require('../plugin.js');

const node = process.execPath;
const fake = path.join(__dirname, 'fake-dsh.js');

const settings = {
  prefix: '助手',
  owners: ['wxid_owner_test'],
  roots: [path.dirname(__dirname)],
  apps: {},
  dsh: {
    runner: [node, fake],
    workspace: path.dirname(__dirname),
    timeoutSeconds: 30,
    syncWaitSeconds: 20,
  },
};

function ctx(text, state = {}) {
  const sent = [];
  return {
    sent,
    message: { platform: 'wechat', chatId: 'wxid_owner_test', chatType: 'private', senderId: 'wxid_owner_test', text, atMe: true },
    settings,
    state,
    whale: { sendText: async (to, body) => { sent.push({ to, body }); }, paths: { pluginData: path.join(__dirname, '.tmp') } },
  };
}

(async () => {
  const first = ctx('助手 让 DSH 数一下文件');
  const out1 = await plugin.hooks['chat.generate'](first);
  assert.match(out1.text, /回「确认」/);
  assert.ok(out1.state.pending, '应挂起待确认');

  const second = ctx('确认', out1.state);
  const out2 = await plugin.hooks['chat.generate'](second);
  const body = out2.text || (second.sent[0] && second.sent[0].body);
  assert.match(body, /假 DSH 收到了：数一下文件/);
  assert.ok(out2.state.dshSessions.wxid_owner_test, '应记住会话，便于追问');

  const third = ctx('助手 让 DSH 再数一次', out2.state);
  const out3 = await plugin.hooks['chat.generate'](third);
  const fourth = ctx('确认', out3.state);
  const out4 = await plugin.hooks['chat.generate'](fourth);
  const body2 = out4.text || (fourth.sent[0] && fourth.sent[0].body);
  assert.match(body2, /假 DSH 收到了：再数一次/);
  console.log('  ok   让 DSH：确认 → 子进程 → --json 解析 → 回消息');
  console.log('  ok   第二次 DSH 复用了 --session-id');
})();
