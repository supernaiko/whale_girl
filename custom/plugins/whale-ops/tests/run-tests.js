'use strict';


'use strict';

// 本地模拟宿主：直接 require plugin.js，喂假 ctx。不需要鲸鲸在跑。
// 用法：node tests/run-tests.js

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plugin = require('../plugin.js');

const OWNER = 'wxid_owner_test';
const STRANGER = 'wxid_stranger';
const PREFIX = '助手';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ops-test-'));
fs.mkdirSync(path.join(tmp, '子目录'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'a.txt'), '你好，这是测试文件。\n第二行。', 'utf8');
fs.writeFileSync(path.join(tmp, '子目录', 'x.md'), '# 标题', 'utf8');
fs.writeFileSync(path.join(tmp, 'b.bin'), Buffer.from([0, 1, 2, 3, 0, 5]));
fs.writeFileSync(path.join(tmp, '报告-2026.md'), '报告正文', 'utf8');
fs.writeFileSync(path.join(tmp, '季度 简报.pdf'), '文件路径测试', 'utf8');

// 外部目录，用于验证越界拒绝
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ops-outside-'));
fs.writeFileSync(path.join(outside, 'secret.txt'), '不该读到', 'utf8');

function settings(overrides = {}) {
  return JSON.stringify({
    prefix: PREFIX,
    owners: [OWNER],
    roots: [tmp],
    apps: { 记事本: 'notepad.exe' },
    maxReadBytes: 4096,
    dsh: { workspace: tmp, timeoutSeconds: 120, syncWaitSeconds: 5 },
    ...overrides,
  });
}

function ctx(text, { senderId = OWNER, state, chatType = 'private', chatId = 'wxid_owner_test', overrides = {}, model, api } = {}) {
  const sent = [];
  return {
    message: { platform: 'wechat', chatId, chatType, senderId, text, atMe: true },
    settings: settings(overrides),
    state: state || {},
    whale: {
      sendText: async (to, body) => { sent.push({ to, body }); return { id: 'm1' }; },
      model,
      api,
      paths: { pluginData: path.join(tmp, '.pluginData'), appData: tmp, appRoot: path.resolve(__dirname, '..') },
    },
    sent,
  };
}

async function gen(text, opts = {}) {
  const c = ctx(text, opts);
  const out = await plugin.hooks['chat.generate'](c);
  c.output = out || {};
  return c;
}

async function pre(text, opts = {}) {
  const c = ctx(text, opts);
  return plugin.hooks['chat.pre_reply'](c);
}


const cases = [];
function test(name, fn) { cases.push([name, fn]); }

function test(name, fn) { cases.push([name, fn]); }

// ---- xlsx ----

test('模型计划建 xlsx：真的产出可打开的 Excel 文件', async () => {
  const out = await gen('放桌面表格', {
    overrides: { prefix: '', roots: [tmp] },
    model: async () => JSON.stringify({ action: 'create', path: path.join(tmp, '数据.xlsx'), content: '' }),
  });
  assert.match(out.output.text || '', /已创建/);
  const buffer = fs.readFileSync(path.join(tmp, '数据.xlsx'));
  assert.strictEqual(buffer.slice(0, 2).toString(), 'PK');
  assert.ok(buffer.includes(Buffer.from('xl/worksheets/sheet1.xml')));
});

test('短回复接上文：随便了你做 → 沿用上一句', async () => {
  const chatId = 'wxid_owner_test';
  const first = ctx('随便放个测试数据', { overrides: { prefix: '', roots: [tmp] } });
  plugin.hooks['chat.pre_reply'](first); // 记录上一句
  const out = await gen('随便了你做', {
    overrides: { prefix: '', roots: [tmp] },
    model: async ({ turns }) => {
      // 拼进来的文字里应该同时有上一句和这一句
      assert.match(turns[0].content, /随便放个测试数据/);
      return JSON.stringify({ action: 'mkdir', path: path.join(tmp, '随便') });
    },
  });
  assert.match(out.output.text || '', /已创建目录/);
});

// ---- 触发与作用域 ----

test('普通聊天不抢话：pre_reply 返回 pass', async () => {
  assert.deepStrictEqual(await pre('晚上吃什么'), { action: 'pass' });
});

test('主人发「助手 状态」唤醒', async () => {
  assert.strictEqual((await pre('助手 状态')).action, 'wake');
});

test('非主人发前缀不唤醒', async () => {
  assert.strictEqual((await pre('助手 状态', { senderId: STRANGER })).action, 'pass');
});

test('群聊默认不响应', async () => {
  assert.strictEqual((await pre('助手 状态', { chatType: 'group', chatId: 'g1' })).action, 'pass');
});

test('无前缀时 generate 不出声', async () => {
  assert.deepStrictEqual((await gen('今天天气不错')).output, {});
});

test('全角冒号也认', async () => {
  const out = (await gen('助手：帮助')).output.text;
  assert.match(out, /电脑助手/);
});

// ---- 只读 ----

test('帮助文本列出命令', async () => {
  const out = (await gen('助手 帮助')).output.text;
  assert.match(out, /看看/);
  assert.match(out, /让 DSH/);
});

test('状态显示白名单与凭据状态', async () => {
  const out = (await gen('助手 状态')).output.text;
  assert.match(out, /白名单目录/);
  assert.match(out, /1 个/);
});

test('列目录只列白名单内', async () => {
  const out = (await gen('助手 看看 .')).output.text;
  assert.match(out, /a\.txt/);
  assert.match(out, /📁 子目录/);
});

test('读文本文件', async () => {
  const out = (await gen('助手 读 a.txt')).output.text;
  assert.match(out, /你好，这是测试文件/);
});

test('拒绝读二进制', async () => {
  const out = (await gen('助手 读 b.bin')).output.text;
  assert.match(out, /只读文本类文件|二进制/);
});

test('拒绝越界路径', async () => {
  const out = (await gen('助手 读 ../' + path.basename(outside) + '/secret.txt')).output.text;
  assert.match(out, /不在白名单/);
});

test('拒绝 ..\\ 穿越到 C 盘', async () => {
  const out = (await gen('助手 读 ..\\..\\Windows\\win.ini')).output.text;
  assert.match(out, /不在白名单/);
});

test('拒绝读不存在的文件', async () => {
  const out = (await gen('助手 读 nope.txt')).output.text;
  assert.match(out, /不存在/);
});

test('找文件名', async () => {
  const out = (await gen('助手 找 报告')).output.text;
  assert.match(out, /报告-2026\.md/);
});

// ---- 写操作：主人说了就做，不再二次确认 ----

test('两种文件指令直接提交，回报本机结果', async () => {
  const file = fs.realpathSync(path.join(tmp, '季度 简报.pdf'));
  const examples = [`把 ${file} 发给 文件传输助手`, `助手 发文件 “${file}” 给 测试群`];
  for (const [index, command] of examples.entries()) {
    const target = index === 0 ? '文件传输助手' : '测试群';
    const calls = [];
    const api = async (url, options) => {
      calls.push({ url, options });
      return options ? { status: 202, ok: true, body: { ok: true, jobId: 'job-a' } }
        : { status: 200, ok: true, body: { ok: true, status: 'submitted' } };
    };
    assert.equal((await pre(command)).action, 'wake');
    const first = await gen(command, { api });
    assert.match(first.output.text, /已把 .* 发给/);
    assert.equal(first.output.state.pending, undefined);
    assert.deepEqual(calls, [
      { url: '/api/send-file', options: { method: 'POST', body: { chat: target, path: file } } },
      { url: '/api/send-file/status?id=job-a', options: undefined },
    ]);
  }
});

test('文件命令拒绝越界、目录和相对路径，全程不调 API', async () => {
  let calls = 0;
  const api = async () => { calls++; };
  for (const [input, expected] of [[path.join(outside, 'secret.txt'), /白名单/], [tmp, /普通文件/], ['a.txt', /绝对路径/]]) {
    const result = await gen(`发文件 "${input}" 给 文件传输助手`, { api });
    assert.match(result.output.text, expected);
    assert.equal(result.output.state.pending, undefined);
  }
  assert.equal(calls, 0);
});

test('打开白名单外软件：直接拒绝，不留待确认', async () => {
  const first = await gen('助手 打开 微信');
  assert.match(first.output.text, /不在软件白名单里/);
  assert.equal(first.output.state.pending, undefined);
});

test('没有待确认时回「确认」什么都不做', async () => {
  const out = (await gen('助手 确认')).output.text;
  assert.ok(!out, '不应该回话，实际：' + out);
});

test('pre_reply 对确认词仍唤醒', async () => {
  const r = await pre('确认', { state: { pending: { kind: 'open', arg: '记事本', at: Date.now() } } });
  assert.strictEqual(r.action, 'wake');
});

// ---- DSH 前置校验 ----

test('tool.run 返回环境 JSON', async () => {
  const out = await plugin.hooks['tool.run']({ settings: settings(), whale: { paths: { pluginData: tmp } } });
  const data = JSON.parse(out.text);
  assert.strictEqual(data.workspaceExists, true);
  assert.strictEqual(data.apiKey, false);
});

test('让 DSH：直接开工，不再问确认', async () => {
  const first = await gen('助手 让 DSH 整理一下桌面');
  assert.doesNotMatch(first.output.text, /回「确认」/);
  assert.ok(first.output.text.length > 0);
});

// ---- 回复长度 ----

test('回复不超过 1200 字', async () => {
  const big = path.join(tmp, 'big.txt');
  fs.writeFileSync(big, 'x'.repeat(100000), 'utf8');
  const out = (await gen('助手 读 big.txt')).output.text;
  assert.ok(out.length <= 1200, '实际长度 ' + out.length);
});

// ---- 自然语言触发（prefix 留空）----

const NAT = { prefix: '' };

test('自然语言：打开软件会唤醒', async () => {
  assert.strictEqual((await pre('打开记事本', { overrides: NAT })).action, 'wake');
});

test('自然语言：闲聊不抢话', async () => {
  assert.strictEqual((await pre('晚上吃什么', { overrides: NAT })).action, 'pass');
});

test('自然语言：只发路径就列目录', async () => {
  const out = (await gen(tmp, { overrides: NAT })).output.text;
  assert.match(out, /a\.txt/);
});

test('自然语言：读一下 文件', async () => {
  const out = (await gen('读一下 a.txt', { overrides: NAT })).output.text;
  assert.match(out, /你好，这是测试文件/);
});

test('自然语言：找 报告', async () => {
  const out = (await gen('找 报告', { overrides: NAT })).output.text;
  assert.match(out, /报告-2026\.md/);
});

test('自然语言：让 DSH 直接开工', async () => {
  const first = await gen('让 DSH 整理桌面', { overrides: NAT });
  assert.doesNotMatch(first.output.text, /回「确认」/);
});

test('自然语言：状态', async () => {
  const out = (await gen('状态', { overrides: NAT })).output.text;
  assert.match(out, /白名单目录/);
});

test('不存在的盘要说人话', async () => {
  const out = (await gen('看看 Q:\\', { overrides: NAT })).output.text;
  assert.match(out, /没有 Q: 盘|盘符/);
});

test('自然语言：看看C盘 能唤醒', async () => {
  assert.strictEqual((await pre('看看C盘', { overrides: NAT })).action, 'wake');
});

test('自然语言：新建文件直接落地，不啰嗦确认', async () => {
  const out = (await gen('在 ' + tmp + ' 新建 t.txt，内容：hello', { overrides: NAT })).output.text;
  assert.match(out, /已创建/);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 't.txt'), 'utf8'), 'hello');
});

test('疑问句不接（能不能…）', async () => {
  assert.strictEqual((await pre('你看看能不能在桌面创建一个文件', { overrides: NAT })).action, 'pass');
});

test('疑问句不接（你的记忆有问题吗）', async () => {
  assert.strictEqual((await pre('你看看你的记忆有问题吗我刚刚动了你记忆方面的代码', { overrides: NAT })).action, 'pass');
});

test('根目录白名单：C:\\ 下任意路径都算在内', async () => {
  const out = (await gen('看看 C:\\Users', { overrides: { prefix: '', roots: ['C:\\'] } })).output.text;
  assert.doesNotMatch(out, /不在白名单/);
});

// ---- 模型自主判断（m01285）----

test('没前缀但像操作：pre_reply 唤醒', async () => {
  assert.strictEqual((await pre('在桌面随便创建一个md文档')).action, 'wake');
});

test('模型计划：建文件（不确认直接建）', async () => {
  const plan = JSON.stringify({ action: 'create', path: path.join(tmp, 'model-1.md'), content: 'hi' });
  const out = (await gen('帮我建个md文件', { model: async () => plan })).output.text;
  assert.match(out, /已创建/);
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'model-1.md'), 'utf8'), 'hi');
});

test('模型计划：复制文件', async () => {
  const plan = JSON.stringify({ action: 'copy', path: path.join(tmp, 'a.txt'), to: path.join(tmp, 'copy-a.txt') });
  const out = (await gen('把 a.txt 复制一份', { model: async () => plan })).output.text;
  assert.match(out, /已复制/);
  assert.ok(fs.existsSync(path.join(tmp, 'copy-a.txt')));
});

test('模型计划：改名', async () => {
  const plan = JSON.stringify({ action: 'rename', path: path.join(tmp, 'copy-a.txt'), name: 'renamed.txt' });
  const out = (await gen('把 copy-a.txt 改名', { model: async () => plan })).output.text;
  assert.match(out, /已改名/);
  assert.ok(fs.existsSync(path.join(tmp, 'renamed.txt')));
});

test('模型说 noop 就不抢话', async () => {
  const out = (await gen('我今天把文件删了，好烦', { model: async () => '{"action":"noop"}' })).output;
  assert.strictEqual(out.text, undefined);
});

test('模型输出的脏 JSON 能兜住', async () => {
  const out = (await gen('在桌面看看文件', { model: async () => '好的：```json\n{"action":"list","path":"' + tmp.replace(/\\/g, '\\\\') + '"}\n```' })).output.text;
  assert.ok(out && out.length > 0);
});

test('解析器先失败时交给模型兜底', async () => {
  const plan = JSON.stringify({ action: 'create', path: path.join(tmp, 'fallback.md'), content: '' });
  const out = (await gen('在桌面随便创建一个md文档', { model: async () => plan })).output.text;
  assert.match(out, /已创建/);
  assert.ok(fs.existsSync(path.join(tmp, 'fallback.md')));
});

(async () => {
  let failed = 0;
  test('对话式跟进也唤醒（用他建一个表格）', async () => {
    assert.strictEqual((await pre('用他建一个表格', { overrides: NAT })).action, 'wake');
  });

  test('补一句「放桌面xlsx」也唤醒', async () => {
    assert.strictEqual((await pre('放桌面xlsx', { overrides: NAT })).action, 'wake');
  });

  test('问「你可以调用dsh吗」交给插件如实回答', async () => {
    assert.strictEqual((await pre('你可以调用dsh吗', { overrides: NAT })).action, 'wake');
  });

  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log('  ok   ' + name);
    } catch (error) {
      failed += 1;
      console.log('  FAIL ' + name + '\n       ' + String(error.message).split('\n')[0]);
    }
  }
  console.log('\n' + (cases.length - failed) + '/' + cases.length + ' 通过');
  process.exitCode = failed ? 1 : 0;
})();


