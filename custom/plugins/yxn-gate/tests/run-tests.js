'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const vm = require('node:vm');
const { test } = require('node:test');
const manifest = require('../plugin.json');

const PLUGIN = require.resolve('../plugin.js');
const source = fs.readFileSync(PLUGIN, 'utf8');
const NOW = new Date(2026, 10, 18, 14).getTime();
const MINUTE = 60000;
const CHAT = 'test-room';
const SENDER = 'test-sender';
const GROUP = { chatType: 'group', now: NOW };
const PRIVATE = { chatType: 'private', now: NOW };

function load(whale = {}, random = () => 0, logs = []) {
  const entry = new Module(PLUGIN, module);
  entry.filename = PLUGIN;
  const originalRequire = Module.createRequire(PLUGIN);
  entry.require = name => name === 'whale' ? whale : originalRequire(name);
  const run = vm.compileFunction(source, ['require', 'module', 'console', 'Math'], { filename: PLUGIN });
  run(entry.require, entry, {
    log: (...args) => logs.push(['log', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  }, Object.assign(Object.create(Math), { random }));
  return entry.exports;
}

const { scoreChain } = load();
const names = result => result.steps.map(step => step.name);
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);

function fixture(t, { model = () => 'no', random, dir } = {}) {
  const folder = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'yxn-gate-test-'));
  if (!dir) t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const calls = [];
  const logs = [];
  const plugin = load({
    paths: { pluginData: folder },
    model: input => { calls.push(input); return model(input); },
  }, random, logs);
  const stateFile = path.join(folder, 'state.json');
  const configFile = path.join(folder, 'config.json');
  const onPreReply = plugin.hooks['chat.pre_reply'];
  return {
    folder, calls, logs, stateFile, configFile,
    seed: state => fs.writeFileSync(stateFile, JSON.stringify(state)),
    state: (id = CHAT) => JSON.parse(fs.readFileSync(stateFile, 'utf8'))[id],
    run(overrides = {}, message = {}) {
      return onPreReply({ now: NOW, ...overrides, message: {
        chatId: CHAT, chatType: 'group', senderId: SENDER, text: '今天下雨', ...message,
      } });
    },
    decision() {
      const [, tag, line] = logs.filter(row => row[0] === 'log').at(-1);
      assert.equal(tag, '[yxn-gate]');
      return JSON.parse(line);
    },
  };
}

test('群聊被 @ 后高于默认复判区间', () => {
  const result = scoreChain({ ...GROUP, text: '在吗', atMe: true });
  assert.ok(result.p > manifest.Settings.judge.high);
  closeTo(result.p, 0.85);
  assert.deepEqual(names(result), ['base', 'at_me', 'question', 'quiet_group', 'clamp']);
  assert.ok(!names(scoreChain({ ...PRIVATE, atMe: true })).includes('at_me'));
});

test('明确不想聊时压至私聊和群聊的下限', () => {
  for (const [chat, floor] of [[PRIVATE, 0.35], [GROUP, 0.05]]) {
    const result = scoreChain({ ...chat, text: '别烦我' });
    assert.equal(result.p, floor);
    assert.ok(names(result).includes('do_not_chat'));
  }
  assert.ok(!names(scoreChain({ ...PRIVATE, text: '下拉滚动了' })).includes('do_not_chat'));
});

test('安静时段跨午夜并在 07:00 结束', () => {
  for (const [hour, minute, result] of [[23, 29, 0.92], [23, 30, 0.67], [0, 0, 0.67], [6, 59, 0.67], [7, 0, 0.92]]) {
    closeTo(scoreChain({ ...PRIVATE, now: new Date(2026, 10, 18, hour, minute), text: '到了' }).p, result);
  }
});

test('同一人 60 秒内从第 4 条开始扣分', () => {
  for (const [chat, difference] of [[PRIVATE, 0.10], [GROUP, 0.05]]) {
    const third = scoreChain({ ...chat, stats: { senderMessagesLastMinute: 3 } });
    const fourth = scoreChain({ ...chat, stats: { senderMessagesLastMinute: 4 } });
    closeTo(third.p - fourth.p, difference);
    assert.ok(names(fourth).includes('sender_burst'));
  }
});

test('私聊纯表情与表情包降低概率，混合文字保留原分', () => {
  for (const text of ['[表情]', '👩🏽‍💻 [表情] 1️⃣', '😀🇨🇳']) {
    const result = scoreChain({ ...PRIVATE, text });
    closeTo(result.p, 0.57);
    assert.ok(names(result).includes('pure_sticker'));
  }
  closeTo(scoreChain({ ...PRIVATE, text: '你好😀' }).p, 0.92);
});

test('空文本可评分，超过 4000 字符的信号不参与', () => {
  closeTo(scoreChain({ ...PRIVATE, text: null }).p, 0.92);
  closeTo(scoreChain({ ...PRIVATE, text: '  ' }).p, 0.92);
  const result = scoreChain({ ...GROUP, text: `${'甲'.repeat(4000)}奈奈？` });
  assert.deepEqual(names(result), ['base', 'quiet_group', 'clamp']);
});

test('关键词和叫名字分别加成，概率步骤按请求顺序执行', () => {
  const result = scoreChain({ ...GROUP, atMe: true, text: '雅小奈，怎么了？撤回了一条消息',
    senderId: SENDER, now: new Date(2026, 10, 18, 23, 30).getTime(),
    stats: { senderMessagesLastMinute: 4, senderStreak: 6, groupMessagesLastTenMinutes: 1 },
  });
  assert.deepEqual(names(result), ['base', 'at_me', 'keyword', 'called_name', 'question', 'system_notice',
    'sender_burst', 'fatigue', 'quiet_hours', 'quiet_group', 'clamp']);
  assert.equal(result.steps.find(step => step.name === 'called_name').delta, 0.25);
  const keyword = scoreChain({ ...GROUP, text: '咖啡', settings: { keywords: ['咖啡'] } });
  assert.ok(names(keyword).includes('keyword'));
  assert.ok(!names(keyword).includes('called_name'));
});

test('刚回过只作用于同一人且严格小于 20 秒', () => {
  const scoring = (elapsed, lastSenderId = SENDER) => scoreChain({
    ...PRIVATE, senderId: SENDER, stats: { lastReplyAt: NOW - elapsed, lastSenderId },
  });
  closeTo(scoring(19999).p, 0.77);
  closeTo(scoring(20000).p, 0.92);
  closeTo(scoring(1000, 'test-someone-else').p, 0.92);
});

test('只在 5 分钟内达到 5 次回复才施加密度惩罚', () => {
  const recent = [NOW - 1000, NOW - MINUTE, NOW - 2 * MINUTE, NOW - 3 * MINUTE];
  const justWithin = scoreChain({ ...PRIVATE, stats: { replies: [...recent, NOW - 5 * MINUTE + 1] } });
  const atLimit = scoreChain({ ...PRIVATE, stats: { replies: [...recent, NOW - 5 * MINUTE, NOW + 1] } });
  closeTo(justWithin.p, 0.42);
  closeTo(atLimit.p, 0.92);
});

test('连续 6 轮无回应触发疲劳惩罚', () => {
  const fifth = scoreChain({ ...PRIVATE, stats: { senderStreak: 5 } });
  const sixth = scoreChain({ ...PRIVATE, stats: { senderStreak: 6 } });
  closeTo(fifth.p - sixth.p, 0.10);
  assert.ok(names(sixth).includes('fatigue'));
});

test('群十分钟内第 3 条取消低活跃加成', () => {
  closeTo(scoreChain({ ...GROUP, stats: { groupMessagesLastTenMinutes: 2 } }).p, 0.35);
  closeTo(scoreChain({ ...GROUP, stats: { groupMessagesLastTenMinutes: 3 } }).p, 0.30);
});

test('clamp 把极端输入限制在范围内，非法配置沿用原边界', () => {
  assert.equal(scoreChain({ ...GROUP, text: '小奈，为什么？', atMe: true }).p, 0.85);
  assert.equal(scoreChain({ ...GROUP, text: '别烦我，撤回了一条消息', stats: { senderStreak: 9 } }).p, 0.05);
  const high = scoreChain({ ...PRIVATE, text: '小奈为什么？', settings: { private: { min: 0.95, max: 0.50 } } });
  assert.equal(high.p, 0.99);
  assert.ok(high.steps.at(-1).delta < 0);
});

test('概率链的默认配置与清单一致', () => {
  for (const input of [PRIVATE, GROUP, { ...GROUP, text: '奈奈怎么了？' }]) {
    assert.deepEqual(scoreChain(input), scoreChain({ ...input, settings: manifest.Settings }));
  }
});

test('第三次跳过进入静默，第四条跳过且不执行模型或评分', async t => {
  const gate = fixture(t);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await gate.run({ now: NOW + i }), { action: 'skip', reason: 'judge_no' });
  }
  assert.equal(gate.state().silentUntil, NOW + 2 + 600000);
  assert.equal(gate.state().silentMsgCount, 0);
  assert.deepEqual(await gate.run({ now: NOW + 3 }), { action: 'skip', reason: 'silent' });
  assert.equal(gate.calls.length, 3);
  assert.equal(gate.state().consecutiveNo, 4);
  assert.equal(gate.state().silentMsgCount, 1);
  assert.deepEqual(gate.decision(), { chatId: CHAT, p: null, action: 'skip', reason: 'silent', steps: [] });
});

test('重载插件后被 @ 可解除保存在磁盘上的静默', async t => {
  const gate = fixture(t);
  gate.seed({ [CHAT]: { silentUntil: NOW + MINUTE, consecutiveNo: 3, silentMsgCount: 2 } });
  const reloaded = fixture(t, { dir: gate.folder });
  assert.deepEqual(await reloaded.run({}, { atMe: true }), { action: 'wake' });
  assert.equal(reloaded.calls.length, 0);
  assert.deepEqual(reloaded.state(), { lastReplyAt: NOW, lastSenderId: SENDER, replies: [NOW],
    consecutiveNo: 0, silentUntil: 0, silentMsgCount: 0, senderStreak: 1 });
});

test('被叫名字可清静默，普通配置话题词不清静默', async t => {
  const gate = fixture(t);
  gate.seed({ [CHAT]: { silentUntil: NOW + MINUTE } });
  const settings = { keywords: ['咖啡'] };
  assert.deepEqual(await gate.run({ settings }, { text: '咖啡' }), { action: 'skip', reason: 'silent' });
  assert.deepEqual(await gate.run({ settings }, { text: '奈奈，晚上好' }), { action: 'wake' });
  assert.equal(gate.state().silentUntil, 0);
});

test('静默攒到第 8 条和到达截止时间均重新判定', async t => {
  const gate = fixture(t, { model: () => 'yes' });
  gate.seed({ [CHAT]: { silentUntil: NOW + MINUTE, silentMsgCount: 6, consecutiveNo: 9 } });
  assert.equal((await gate.run()).reason, 'silent');
  assert.deepEqual(await gate.run({ now: NOW + 1 }), { action: 'wake' });
  assert.equal(gate.state().silentMsgCount, 0);
  gate.seed({ [CHAT]: { silentUntil: NOW } });
  assert.deepEqual(await gate.run(), { action: 'wake' });
  assert.equal(gate.calls.length, 2);
});

test('窗口落盘时剔除过期及未来时间戳，只留最近 50 条', async t => {
  const gate = fixture(t);
  const repeated = Array.from({ length: 60 }, (_, index) => NOW - 60 + index);
  gate.seed({ [CHAT]: { replies: [NOW + 1, NOW - 10 * MINUTE, ...repeated.reverse()] },
    'other-room': { consecutiveNo: 2 } });
  assert.deepEqual(await gate.run({ settings: { judge: { enabled: false } } }), { action: 'wake' });
  assert.equal(gate.state().replies.length, 50);
  assert.equal(gate.state().replies[0], NOW - 49);
  assert.equal(gate.state().replies.at(-1), NOW);
  assert.deepEqual(gate.state('other-room'), { consecutiveNo: 2 });
});

test('会话 ID 即使与对象原型键同名也保存为独立状态', async t => {
  const gate = fixture(t);
  await gate.run({}, { chatId: '__proto__' });
  assert.equal(gate.state('__proto__').consecutiveNo, 1);
  assert.equal(gate.state(), undefined);
});

test('宿主已经落盘的当前消息只计一次，60 秒边界排除旧消息', async t => {
  const gate = fixture(t);
  const history = [NOW - MINUTE, NOW - 1000, NOW - 30, NOW].map((at, index) => ({
    role: 'user', uid: SENDER, at, text: index === 3 ? '今天下雨' : '旧消息',
  }));
  await gate.run({ history });
  assert.ok(!gate.decision().steps.includes('sender_burst'));
  history[0].at++;
  await gate.run({ history });
  assert.ok(gate.decision().steps.includes('sender_burst'));
  assert.ok(!gate.decision().steps.includes('quiet_group'));
});

test('根据宿主历史识别 6 次发给同一人的无回应，并识别中途回复', async t => {
  const gate = fixture(t);
  const history = Array.from({ length: 6 }, (_, index) => ({
    role: 'assistant', targetId: SENDER, at: NOW - (7 - index) * MINUTE, text: '旧回复',
  }));
  history.push({ role: 'user', uid: SENDER, at: NOW, text: '今天下雨' });
  await gate.run({ history });
  assert.ok(gate.decision().steps.includes('fatigue'));
  history.splice(2, 0, { role: 'user', uid: SENDER, at: NOW - 5.5 * MINUTE, text: '中间回了' });
  await gate.run({ history });
  assert.ok(!gate.decision().steps.includes('fatigue'));
});

test('文件配置逐项叠加卡片设置，且每轮立即读取', async t => {
  const gate = fixture(t);
  const settings = { enabled: false, group: { base: 0.50, max: 0.81 }, judge: { enabled: false } };
  assert.deepEqual(await gate.run({ settings }), { action: 'pass' });
  assert.equal(fs.existsSync(gate.stateFile), false);
  fs.writeFileSync(gate.configFile, JSON.stringify({ enabled: true, group: { min: 0.40 } }));
  assert.deepEqual(await gate.run({ settings }), { action: 'wake' });
  closeTo(gate.decision().p, 0.55);
  assert.equal(gate.calls.length, 0);
  fs.writeFileSync(gate.configFile, '{');
  assert.deepEqual(await gate.run({ settings }), { action: 'pass' });
  assert.ok(gate.logs.some(([level, , line]) => level === 'error' && JSON.parse(line).detail.includes('read_config')));
});

test('state.json 损坏时不覆盖现有数据', async t => {
  const gate = fixture(t);
  fs.writeFileSync(gate.stateFile, '{');
  assert.deepEqual(await gate.run(), { action: 'pass' });
  assert.equal(fs.readFileSync(gate.stateFile, 'utf8'), '{');
  assert.equal(gate.decision().reason, 'state_unavailable');
});

test('模型 yes 前缀可接话，judge 提示包含边界所需的上下文', async t => {
  const gate = fixture(t, { model: async () => '  YeS\n' });
  const history = Array.from({ length: 11 }, (_, index) => ({
    role: 'user', uid: `test-peer-${index}`, name: `昵称${index}`, text: `测试记录${index}。`, at: NOW - 100 - index,
  }));
  const result = await gate.run({ history, relationship: { label: '熟人', description: '可以随意聊' } }, { senderName: '来访者' });
  assert.deepEqual(result, { action: 'wake' });
  assert.equal(gate.calls.length, 1);
  assert.equal(gate.calls[0].maxTokens, 8);
  assert.match(gate.calls[0].system, /只判断要不要回/);
  const [{ role, content }] = gate.calls[0].turns;
  assert.equal(role, 'user');
  for (const fragment of ['熟人', '昵称1', '昵称10', String(NOW - 101), '来访者', '今天下雨']) assert.ok(content.includes(fragment));
  assert.ok(!content.includes('测试记录0。'));
  assert.ok(!gate.logs.some(row => row[2].includes('今天下雨')));
});

test('模型 no 拒绝接话，IPC 序列化使用宿主允许的 data 字段', async t => {
  const gate = fixture(t, { model: () => 'no' });
  const result = await gate.run();
  assert.deepEqual(result, { action: 'skip', reason: 'judge_no' });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { action: 'skip', data: { reason: 'judge_no' } });
  assert.equal(gate.state().consecutiveNo, 1);
  assert.deepEqual(gate.state().replies, []);
});

test('模型错误拒绝接话，日志保留结构化错误且不回显异常正文', async t => {
  const gate = fixture(t, { model: async () => { throw Object.assign(new Error('模拟私密内容'), { code: 'host_call_failed', status: 429 }); } });
  assert.deepEqual(await gate.run(), { action: 'skip', reason: 'judge_no' });
  const [, tag, line] = gate.logs.find(([level]) => level === 'error');
  assert.equal(tag, '[yxn-gate]');
  assert.equal(JSON.parse(line).code, 'host_call_failed');
  assert.equal(JSON.parse(line).status, 429);
  assert.ok(!line.includes('模拟私密内容'));
  const disk = fs.readFileSync(path.join(gate.folder, 'decisions.jsonl'), 'utf8');
  assert.ok(disk.includes('host_call_failed'));
  assert.ok(!disk.includes('今天下雨'));
});

test('模型超时拒绝接话并记录超时代码', async t => {
  const gate = fixture(t, { model: () => new Promise(() => {}) });
  const result = await gate.run({ settings: { judge: { timeoutMs: 10 } } });
  assert.deepEqual(result, { action: 'skip', reason: 'judge_no' });
  assert.ok(gate.logs.some(([level, , line]) => level === 'error' && JSON.parse(line).code === 'JUDGE_TIMEOUT'));
});

test('模型非字符串或未以 yes 开头时拒绝接话', async t => {
  for (const answer of [{ text: 'yes' }, '', 'maybe yes']) {
    const gate = fixture(t, { model: () => answer });
    assert.deepEqual(await gate.run(), { action: 'skip', reason: 'judge_no' });
  }
});

test('复判区间包含两个端点，区间之外按 p 掷骰', async t => {
  const gate = fixture(t, { model: () => 'yes', random: () => 0.90 });
  for (const p of [0.25, 0.65]) {
    assert.deepEqual(await gate.run({ settings: { group: { base: p, min: p, max: p } } },
      { chatId: `test-boundary-${p}` }), { action: 'wake' });
  }
  assert.deepEqual(await gate.run({}, { atMe: true }), { action: 'skip', reason: 'base' });
  assert.equal(gate.calls.length, 2);
});

test('禁用 judge 时按概率决定，概率跳过报告主要扣分步骤', async t => {
  const gate = fixture(t, { random: () => 0.51 });
  const settings = { judge: { enabled: false } };
  assert.deepEqual(await gate.run({ settings }, { text: '别烦我' }), { action: 'skip', reason: 'do_not_chat' });
  assert.deepEqual(await gate.run({ settings }, { atMe: true }), { action: 'wake' });
  assert.equal(gate.calls.length, 0);
  assert.equal(gate.state().consecutiveNo, 0);
});

test('判定日志轮转，新日志包含当轮结果', async t => {
  const gate = fixture(t);
  const file = path.join(gate.folder, 'decisions.jsonl');
  fs.writeFileSync(file, ' '.repeat(256 * 1024));
  await gate.run();
  assert.equal(fs.statSync(`${file}.1`).size, 256 * 1024);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).reason, 'judge_no');
});
