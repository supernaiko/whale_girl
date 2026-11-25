'use strict';


'use strict';

// 本地模拟宿主：直接 require plugin.js，喂假 ctx。不需要鲸鲸在跑。
// 用法：node tests/run-tests.js

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 假 Codex：把收到的任务写到 STUB_TASK_FILE 后直接退出，测试不真跑 Codex
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ops-codex-'));
const stubCodex = path.join(stubDir, 'codex.js');
fs.writeFileSync(stubCodex, [
  "'use strict';",
  "const fs = require('fs');",
  "const args = process.argv.slice(2);",
  "const outAt = args.indexOf('--output-last-message');",
  "const out = outAt >= 0 ? args[outAt + 1] : '';",
  "const task = args[args.length - 1] || '';",
  "if (process.env.STUB_TASK_FILE) fs.writeFileSync(process.env.STUB_TASK_FILE, task, 'utf8');",
  "if (out) fs.writeFileSync(out, 'STUB 结果', 'utf8');",
  "process.exit(0);",
].join('\n'), 'utf8');
process.env.WHALE_CODEX_BIN = stubCodex;

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

test('新建一个还不存在的目录（如 小本本）不再报路径不存在', async () => {
  const out = await gen('在文档里建个小本本文件夹', {
    chatId: 'mkdir-missing-chat',
    overrides: { prefix: '', roots: [tmp] },
    model: async () => JSON.stringify({ action: 'mkdir', path: path.join(tmp, '小本本') }),
  });
  assert.match(out.output.text || '', /已创建目录/);
  assert.ok(fs.existsSync(path.join(tmp, '小本本')));
  const out2 = await gen('在小本本里建 notes.md，内容：hello', {
    chatId: 'mkdir-missing-chat',
    overrides: { prefix: '', roots: [tmp] },
    model: async () => JSON.stringify({ action: 'create', path: path.join(tmp, '小本本', 'notes.md'), content: 'hello' }),
  });
  assert.match(out2.output.text || '', /已创建/);
  assert.strictEqual(fs.readFileSync(path.join(tmp, '小本本', 'notes.md'), 'utf8'), 'hello');
});

test('日常说「把这些记一下」会写进小本本，问的时候能翻出来', async () => {
  const memo = path.join(tmp, '小本本');
  const overrides = { prefix: '', roots: [tmp], memoDir: memo };
  const out = await gen('把这些记一下：周六去看展，门票在邮箱里', { chatId: 'memo-chat', overrides });
  assert.match(out.output.text || '', /记好了/);
  assert.ok(fs.readFileSync(path.join(memo, '杂记.md'), 'utf8').includes('周六去看展'));
  const again = await gen('小本本里记了什么', { chatId: 'memo-chat', overrides });
  assert.match(again.output.text || '', /周六去看展/);
});

test('记小本本按内容分类分文件，不再堆一个文件', async () => {
  const memo = path.join(tmp, '小本本分类写');
  const overrides = { prefix: '', roots: [tmp], memoDir: memo };
  const chatId = 'memo-cat-chat';
  await gen('记一下：账号 hei_721158 密码 j8xsza', {
    chatId, overrides,
    model: async ({ system }) => String(system || '').includes('记到哪个文件')
      ? JSON.stringify({ file: '账号密码', block: '- 账号：hei_721158 密码：j8xsza' })
      : JSON.stringify({ text: '账号 hei_721158 密码 j8xsza' }),
  });
  const file = path.join(memo, '账号密码.md');
  assert.ok(fs.existsSync(file), '应按分类写到账号密码.md，实得目录：' + fs.readdirSync(memo).join(','));
  assert.ok(fs.readFileSync(file, 'utf8').includes('hei_721158'));
  assert.ok(!fs.existsSync(path.join(memo, '小本本.md')), '不该再堆在小本本.md 一个文件里');
  const again = await gen('小本本里记了什么', { chatId, overrides });
  assert.match(again.output.text || '', /账号密码/);
  assert.match(again.output.text || '', /hei_721158/);
});

test('用户说「不要和别的放一起」时单独建文件，分类要求本身不写进内容', async () => {
  const memo = path.join(tmp, '小本本分开');
  const overrides = { prefix: '', roots: [tmp], memoDir: memo };
  const chatId = 'memo-separate-chat';
  const out = await gen('帮我记一下：a.com b.com c.com（这些不要和别的网站放一起，单独一个文件）', {
    chatId, overrides,
    model: async ({ system }) => String(system || '').includes('记到哪个文件')
      ? JSON.stringify({ file: '成人网站', block: '## 网站列表\n- https://a.com\n- https://b.com\n- https://c.com' })
      : JSON.stringify({ text: 'a.com b.com c.com' }),
  });
  assert.match(out.output.text || '', /记好了/);
  const file = path.join(memo, '成人网站.md');
  assert.ok(fs.existsSync(file), '应按 deep 给的名字单独建文件，实得：' + fs.readdirSync(memo).join(','));
  const body = fs.readFileSync(file, 'utf8');
  assert.ok(body.startsWith('# 成人网站'), '新文件该带标题');
  assert.ok(body.includes('## 网站列表'), '该按 deep 给的格式写');
  assert.ok(body.includes('https://a.com'));
  assert.ok(!body.includes('不要和别的网站放一起'), '分类要求本身不该写进内容');
  assert.ok(body.includes('https://c.com'));
});

test('「我是让你把这些网站记在小本本里」不会再写成单个「里」', async () => {
  const memo = path.join(tmp, '小本本2');
  const overrides = { prefix: '', roots: [tmp], memoDir: memo };
  const chatId = 'memo-ref-chat';
  // 先发一大段要记的内容，再发一句指代「把这些记一下」——插件要回翻上一段
  await pre('GitHub Skills 十条：HyperFrames 生成动效视频；video-use 剪视频；Remotion 批量做视频；ffmpeg 万能剪辑；agent-caption 自动字幕。', { chatId, overrides });
  const out = await gen('我是让你把这些网站记在小本本里', { chatId, overrides });
  assert.match(out.output.text || '', /记好了/);
  const written = fs.readFileSync(path.join(memo, '杂记.md'), 'utf8');
  assert.ok(written.includes('HyperFrames'), '应把上一段内容记进去');
  assert.ok(!/^\s*-\s*[^ ]*里\s*$/.test(written), '不该只记一个「里」');
});

test('「记一下并且分类好」交给 codex 分类，不本地直接写', async () => {
  const memo = path.join(tmp, '小本本分类');
  const overrides = { prefix: '', roots: [tmp], memoDir: memo };
  const chatId = 'memo-classify-chat';
  const taskFile = path.join(tmp, 'codex-task-classify.txt');
  process.env.STUB_TASK_FILE = taskFile;
  await pre('十个视频工具：HyperFrames 做动效视频；video-use 剪视频；Remotion 批量做视频；ffmpeg-skill 万能剪辑；agent-caption 自动字幕。', { chatId, overrides });
  const out = await gen('把这些记一下并且分类好', { chatId, overrides });
  assert.doesNotMatch(out.output.text || '', /没听懂|要记什么/);
  const stub = fs.readFileSync(taskFile, 'utf8');
  assert.match(stub, /分类|主题|小本本\.md/);
  assert.match(stub, /HyperFrames/);
  assert.ok(!fs.existsSync(path.join(memo, '小本本.md')), '走 codex 不该本地直接写');
});

test('「没有哦你重新记一下」交给模型理解，不把「没有哦你重新」当内容', async () => {
  const memo = path.join(tmp, '小本本重记');
  const overrides = { prefix: '', roots: [tmp], memoDir: memo };
  const chatId = 'memo-redo-chat';
  await pre('十个视频工具：HyperFrames 做动效视频；video-use 剪视频。', { chatId, overrides });
  const out = await gen('没有哦你重新记一下', {
    chatId, overrides,
    model: async ({ system, turns }) => {
      const s = String(system || '');
      if (s.includes('记到哪个文件')) return JSON.stringify({ file: '备忘', block: '- 十个视频工具：HyperFrames 做动效视频；video-use 剪视频。' });
      const joined = turns.map(x => x.content).join('\n');
      assert.match(joined, /重新记一下/);
      assert.match(joined, /HyperFrames/);
      return JSON.stringify({ text: '十个视频工具：HyperFrames 做动效视频；video-use 剪视频。' });
    },
  });
  assert.match(out.output.text || '', /记好了/);
  const written = fs.readFileSync(path.join(memo, '备忘.md'), 'utf8');
  assert.ok(written.includes('HyperFrames'), '应记模型返回的内容');
  assert.ok(!written.includes('没有哦你重新'), '不该把修正词当内容');
});

test('「你还记得吗」「你记了啥」是问不是让记，不写小本本也不回「记好了」', async () => {
  const memo = path.join(tmp, '小本本疑问');
  const overrides = { prefix: '', roots: [tmp], memoDir: memo };
  const chatId = 'memo-ask-chat';
  await pre('找 codex 调 notion 发我资料', { chatId, overrides });
  const out = await gen('对了你还记得我之前让你去找codex调用我的notion让他发你关于我的东西你都有记住吗', { chatId, overrides });
  assert.doesNotMatch(out.output.text || '', /记好了|写进小本本/);
  assert.ok(!fs.existsSync(path.join(memo, '小本本.md')), '询问记忆不该写小本本');
  const again = await gen('你记了啥这个不是让你记住的我是在问你', { chatId, overrides });
  assert.doesNotMatch(again.output.text || '', /记好了|写进小本本/);
  assert.ok(!fs.existsSync(path.join(memo, '小本本.md')), '否定澄清也不该写小本本');
});

test('自己干不了的电脑活儿（剪辑/下载）由模型判断意图后丢给 codex', async () => {
  const overrides = { prefix: '', roots: [tmp] };
  const taskFile = path.join(tmp, 'codex-task-fallback.txt');
  process.env.STUB_TASK_FILE = taskFile;
  const out = await gen('帮我剪辑这段视频，把开头剪掉三秒', {
    chatId: 'codex-fallback-chat',
    overrides,
    model: async () => JSON.stringify({ action: 'codex', task: '剪辑视频：把开头剪掉三秒', cwd: tmp }),
  });
  assert.doesNotMatch(out.output.text || '', /没听懂|回「确认」/);
  const stub = fs.readFileSync(taskFile, 'utf8');
  assert.match(stub, /剪掉三秒|剪辑/);
});

test('「帮你剪辑视频」没模型接时（如模型不可用）不抢话', async () => {
  const taskFile = path.join(tmp, 'codex-fallback-nomodel.txt');
  process.env.STUB_TASK_FILE = taskFile;
  const out = await gen('帮我剪辑这段视频', { chatId: 'codex-fallback-nomodel-chat', overrides: { prefix: '', roots: [tmp] } });
  assert.ok(!fs.existsSync(taskFile), '模型不可用时不 spawn codex');
  assert.strictEqual(out.output.text || '', '');
});

test('「你没记住啊」是否定/反问，不写小本本也不当指令', async () => {
  const memo = path.join(tmp, '小本本没记住');
  const overrides = { prefix: '', roots: [tmp], memoDir: memo };
  const chatId = 'memo-neg-chat';
  const p = await pre('话说你没记住啊', { chatId, overrides });
  assert.strictEqual(p.action, 'pass');
  const out = await gen('话说你没记住啊', { chatId, overrides });
  assert.doesNotMatch(out.output.text || '', /记好了|写进小本本/);
  assert.ok(!fs.existsSync(path.join(memo, '小本本.md')), '反问不该写小本本');
});

test('「你把信息交给deep处理」是转交，不当 codex 任务', async () => {
  const taskFile = path.join(tmp, 'codex-handoff-task.txt');
  process.env.STUB_TASK_FILE = taskFile;
  const overrides = { prefix: '', roots: [tmp] };
  const out = await gen('你把信息交给deep处理', { chatId: 'codex-handoff-chat', overrides });
  assert.ok(!fs.existsSync(taskFile), '转交给 deep 不该 spawn codex');
  assert.doesNotMatch(out.output.text || '', /Codex|codex/);
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

test('「把文件发我」把刚建好的文件发到当前会话', async () => {
  const chatId = 'wxid_send_me_chat';
  const dir = path.join(tmp, '发我');
  fs.mkdirSync(dir, { recursive: true });
  const created = await gen(`在 ${dir} 新建 测试发我.txt，内容：你好`, { chatId, overrides: { prefix: '', roots: [tmp] } });
  assert.match(created.output.text, /已创建/);
  const file = path.join(dir, '测试发我.txt');
  const calls = [];
  const api = async (url, options) => {
    calls.push({ url, options });
    return options ? { status: 202, ok: true, body: { ok: true, jobId: 'job-b' } }
      : { status: 200, ok: true, body: { ok: true, status: 'submitted' } };
  };
  assert.equal((await pre('我说的是你把文件发我', { chatId })).action, 'wake');
  const out = await gen('我说的是你把文件发我', { chatId, overrides: { prefix: '', roots: [tmp] }, api });
  assert.match(out.output.text, /已把 测试发我\.txt 发给/);
  assert.deepEqual(calls[0], { url: '/api/send-file', options: { method: 'POST', body: { chat: chatId, path: file } } });
});

test('没建过文件时说「把文件发我」不调接口，提示给路径', async () => {
  let calls = 0;
  const api = async () => { calls++; };
  const out = await gen('把文件发我', { chatId: 'wxid_no_created', overrides: { prefix: '', roots: [tmp] }, api });
  assert.match(out.output.text, /没找到刚建好的文件/);
  assert.equal(calls, 0);
});

test('「把 <路径> 发给我」也发到当前会话', async () => {
  const chatId = 'wxid_send_me_path';
  const file = path.join(tmp, '测试路径发我.txt');
  fs.writeFileSync(file, '路径直接发', 'utf8');
  const calls = [];
  const api = async (url, options) => {
    calls.push({ url, options });
    return options ? { status: 202, ok: true, body: { ok: true, jobId: 'job-c' } }
      : { status: 200, ok: true, body: { ok: true, status: 'submitted' } };
  };
  const out = await gen(`把 ${file} 发给我`, { chatId, overrides: { prefix: '', roots: [tmp] }, api });
  assert.match(out.output.text, /已把 测试路径发我\.txt 发给/);
  assert.deepEqual(calls[0], { url: '/api/send-file', options: { method: 'POST', body: { chat: chatId, path: file } } });
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

  test('「用 codex 在桌面建文件」触发 codex 路由', async () => {
    const first = await gen('用 codex 在桌面建个 md 文件', { overrides: NAT });
    assert.doesNotMatch(first.output.text, /回「确认」|没听懂/);
  });

  test('「交给 codex 改脚本」也触发 codex 路由', async () => {
    const first = await gen('交给 codex 把桌面那个脚本改好', { overrides: NAT });
    assert.doesNotMatch(first.output.text, /回「确认」|没听懂/);
  });

  test('codex 找内容时要求直接给出正文，而不是只贴链接', async () => {
    const taskFile = path.join(tmp, 'codex-task.txt');
    process.env.STUB_TASK_FILE = taskFile;
    const out = await gen('用 codex 找《假烟假酒假朋友》毛家超版歌词', {
      chatId: 'codex-hint-chat',
      overrides: { prefix: '', roots: [tmp] },
      model: async () => JSON.stringify({ action: 'codex', task: '找《假烟假酒假朋友》毛家超版歌词' }),
    });
    assert.match(out.output.text || '', /Codex 完成/);
    const sent = fs.readFileSync(taskFile, 'utf8');
    assert.match(sent, /【输出要求】/);
    assert.match(sent, /不要只给链接/);
    assert.match(sent, /毛家超版歌词/, '原任务要保留在提示后面');
  });

  test('codex 建文件的任务不加「给正文」要求', async () => {
    const taskFile = path.join(tmp, 'codex-task2.txt');
    process.env.STUB_TASK_FILE = taskFile;
    await gen('用 codex 在桌面建个 md', {
      chatId: 'codex-file-chat',
      overrides: { prefix: '', roots: [tmp] },
      model: async () => JSON.stringify({ action: 'codex', task: '在桌面创建 a.md，内容写 hello' }),
    });
    assert.doesNotMatch(fs.readFileSync(taskFile, 'utf8'), /【输出要求】/);
  });

  test('能力事实块提到 Codex 与 DSH', async () => {
    const hook = plugin.hooks['chat.prompt'];
    const ctx = {
      settings: settings({ prefix: '' }),
      message: { senderId: OWNER, chatId: 'c1', chatType: 'private' },
      system: 'base',
      whale: { api: async () => ({}), sendText: async () => ({ ok: true }), paths: { pluginData: tmp } },
    };
    const out = await hook(ctx);
    assert.match(out.system, /Codex/);
    assert.match(out.system, /DSH/);
  });

  test('codex 拉到/写出的文件内容会写进小本本，deep 以后能翻到', async () => {
    const memo = path.join(tmp, '小本本codex');
    const overrides = { prefix: '', roots: [tmp], memoDir: memo };
    const chatId = 'codex-memo-chat';
    const mdFile = path.join(tmp, 'notion_计划.md');
    fs.writeFileSync(mdFile, '用户于 2026-10-15 确认正式离职，10-16 为 Day 1，之后启动独立开发。', 'utf8');
    const logDir = path.join(tmp, '.pluginData', 'codex');
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'run-777.log'), [
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '已读取 Notion，汇总到 [notion_计划.md](' + mdFile.replace(/\\/g, '/') + ')' } }),
    ].join('\n'), 'utf8');
    await gen('用 codex 拉我的 notion 计划', {
      chatId,
      overrides,
      model: async () => JSON.stringify({ action: 'codex', task: '从 Notion 读取计划输出到 ' + mdFile }),
    });
    const written = fs.readFileSync(path.join(memo, '资料.md'), 'utf8');
    assert.ok(written.includes('2026-10-15'), '小本本该含 codex 拉到的文件内容，实得：' + written);
    assert.ok(written.includes('【Codex 查到】'), '该带 Codex 查到标记');
  });

  test('主人私聊问到记事本里的事，会把相关内容注入提示词', async () => {
    const memo = path.join(tmp, '小本本注入');
    const overrides = { prefix: '', roots: [tmp], memoDir: memo };
    fs.mkdirSync(memo, { recursive: true });
    fs.writeFileSync(path.join(memo, '计划日程.md'), '- 计划：用户 2026/10/15 正式离职，10-16 启动\n', 'utf8');
    const c = ctx('那你讲讲我的计划', { overrides });
    const out = await plugin.hooks['chat.prompt'](c);
    assert.ok(out && out.system, '该返回注入后的 system');
    assert.ok(out.system.includes('2026/10/15'), '该把记事本里的计划内容注入');
    assert.ok(out.system.includes('【你的记事本】'), '该带记事本标记');
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

test('Codex 日志里记下的文件也能「把文件发我」发出去', async () => {
  const chatId = 'wxid_send_me_log';
  const dir = path.join(tmp, '日志建的文件');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '日志测试.txt');
  fs.writeFileSync(file, '日志兜底', 'utf8');
  const logDir = path.join(tmp, '.pluginData', 'codex');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'run-9999999999999.log'), [
    JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', aggregated_output: file + '\r\n', exit_code: 0, status: 'completed' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: '已创建：[' + path.basename(file) + '](' + file.replace(/\\/g, '/') + ')' } }),
  ].join('\n'), 'utf8');
  const calls = [];
  const api = async (url, options) => {
    calls.push({ url, options });
    return options ? { status: 202, ok: true, body: { ok: true, jobId: 'job-log' } } : { status: 200, ok: true, body: { ok: true, status: 'submitted' } };
  };
  const out = await gen('把文件发我', { chatId, overrides: { prefix: '', roots: [tmp] }, api });
    assert.match(out.output.text, /已把 日志测试\.txt 发给/);
  assert.equal(calls[0].url, '/api/send-file');
});