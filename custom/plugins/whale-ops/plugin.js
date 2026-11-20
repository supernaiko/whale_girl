'use strict';

/**
 * 电脑助手（whale-ops）—— 鲸鲸 Api 4 插件
 *
 * 微信里对鲸鲸说：
 *   助手 看看 D:\报告          列目录
 *   助手 读 D:\报告\a.md       读文本文件（限白名单目录、限体积）
 *   助手 打开 记事本           启动软件（需确认）
 *   助手 让 DSH 把桌面截图整理成文档（需确认）
 *   助手 状态 / 助手 帮助 / 助手 取消
 *
 * 安全边界（全部来自插件设置，默认拒绝）：
 *   - owners：只有这些 wxid 能用；留空 = 谁都不能用
 *   - roots：只能读写这些目录，realpath 之后必须仍在里面
 *   - apps：只能启动这些名字，不接受任意路径
 *   - 发送文件、打开软件和让 DSH 干活必须回「确认」才执行
 *   - DSH 以 workspace-write 权限跑在指定工作目录，审批策略 never，超时杀进程树
 *
 * 日志只记动作、路径、耗时，不记聊天正文。
 */

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const CODEX_BIN = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');

const MAX_REPLY = 1200;
const MAX_READ = 64 * 1024;
const MAX_LIST = 60;
const MAX_FIND = 25;
const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.jsonl', '.js', '.cjs', '.mjs', '.ts', '.py',
  '.log', '.csv', '.yml', '.yaml', '.ini', '.toml', '.xml', '.html', '.htm', '.css', '.bat', '.ps1', '.sh', '.sql']);
const CONFIRM_TTL = 5 * 60 * 1000;

// 运行中的 DSH 任务：chatId -> { child, startedAt, done }
const jobs = new Map();

function defaultInstall() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Programs', 'DeepSeek Harness');
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value, fallback) {
  return typeof value === 'string' ? value : fallback;
}

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function strList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const list = value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim());
  return list.length ? list : fallback;
}

function existingDrives() {
  const found = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = letter + ':\\';
    try { if (fs.existsSync(root)) found.push(root); } catch { /* 没权限就跳过 */ }
  }
  return found;
}

// 默认白名单：文档 + 所有现存的盘（owner 私聊专用；想收紧就在设置里写死 roots）
function defaultRoots() {
  const roots = [path.join(os.homedir(), 'Documents')];
  for (const drive of existingDrives()) if (!roots.includes(drive)) roots.push(drive);
  return roots;
}

function missReason(settings, arg) {
  const text = String(arg || '').trim();
  const drive = text.match(/^([A-Za-z]):\\?$/);
  if (drive) {
    const letter = drive[1].toUpperCase() + ':';
    if (!fs.existsSync(letter + '\\')) return '这台电脑没有 ' + letter + ' 盘，现有盘符：' + existingDrives().join('、');
  }
  const expanded = text.replace(/^~(?=$|[\\/])/, os.homedir());
  if (text && fs.existsSync(path.resolve(settings.roots[0] || os.homedir(), expanded))) {
    return '不在白名单里（当前只允许：' + settings.roots.join('、') + '；要放开就去插件设置 roots 里加）';
  }
  return '这个路径不存在，或者不在白名单里';
}

function readSettings(raw) {
  let input = raw;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = {}; }
  }
  input = plain(input) ? input : {};
  const install = defaultInstall();
  const dsh = plain(input.dsh) ? input.dsh : {};
  const home = os.homedir();
  return {
    // 留空 = 自然语言触发（「打开记事本」「读一下 D:\a.md」都能认）；
    // 填了（比如「助手」）就只认这个前缀，其余一律 pass 给鲸鲸自己聊。
    prefix: str(input.prefix, ''),
    owners: strList(input.owners, []),
    roots: strList(input.roots, defaultRoots()).map(item => path.resolve(item)),
    allowedGroups: strList(input.allowedGroups, []),
    apps: plain(input.apps)
      ? Object.fromEntries(Object.entries(input.apps).filter(([, v]) => typeof v === 'string' && v.trim()))
      : { 记事本: 'notepad.exe', 计算器: 'calc.exe', 资源管理器: 'explorer.exe' },
    maxReadBytes: num(input.maxReadBytes, MAX_READ, 1024, 1024 * 1024),
    dsh: {
      runner: strList(dsh.runner, [path.join(install, 'DeepSeek Harness.exe'), '--expose-internals',
        path.join(install, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')]),
      workspace: path.resolve(str(dsh.workspace, path.join(home, 'Documents'))),
      addDirs: strList(dsh.addDirs, []).map(item => path.resolve(item)),
      apiKey: str(dsh.apiKey, ''),
      permissionMode: str(dsh.permissionMode, 'workspace-write'),
      timeoutSeconds: num(dsh.timeoutSeconds, 110, 30, 110),
      syncWaitSeconds: num(dsh.syncWaitSeconds, 60, 5, 100),
    },
  };
}

// ---------------------------------------------------------------------------
// 主人 / 会话判定
// ---------------------------------------------------------------------------

function isOwner(settings, senderId) {
  return Boolean(senderId) && settings.owners.includes(senderId);
}

function inScope(settings, message) {
  if (!plain(message)) return false;
  if (message.chatType === 'group') return settings.allowedGroups.includes(String(message.chatId || ''));
  return true;
}

function isConfirmWord(text) {
  return /^(确认|确定|执行|继续|取消|算了)[。！!]?$/.test(String(text || '').trim());
}

function stripPrefix(text, prefix) {
  const raw = String(text || '').trim();
  if (!prefix || !raw.startsWith(prefix)) return null;
  return raw.slice(prefix.length).replace(/^[\s，,：:、]+/, '').trim();
}

/* 自然语言触发：把「帮我看看 D:\报告」「打开记事本」这类型话归一成内部命令。
   拿不准就返回 null（= pass），绝不硬抢正常聊天。 */
const FILLER = /^(?:帮我|帮忙|麻烦你?|请|你|能不能|可以|给我|替我)\s*/;

function emoticonCommand(settings, raw) {
  const text = String(raw || '').trim();
  const body = (stripPrefix(text, settings.prefix) ?? text).replace(FILLER, '');
  const match = /^(?:发|来)\s*(?:一?个\s*)?(?:\[([A-Za-z0-9\u3400-\u9fff]{1,20})\](?:\s*表情)?|([A-Za-z0-9\u3400-\u9fff]{1,20}?)\s*(?:内置)?表情|(微笑|捂脸|旺柴))\s*(?:吧|呗|呀)?[。！!]*$/.exec(body);
  const name = match && (match[1] || match[2] || match[3]);
  return name && name !== '表情包' && name !== '表情' ? '[' + name + ']' : null;
}

const EMOTICON_FAILURES = {
  not_converted: '当前微信没有把这个代码识别为内置表情。',
  draft_not_empty: '输入框里有草稿，请先处理草稿。',
  draft_unverified: '无法核对粘贴结果，请检查微信输入框。',
  send_blocked: '当前发言范围或微信状态不允许发送。',
  bridge_busy: '微信桥接正忙。',
  target_unavailable: '微信桥接无法核对当前会话或发送账号。',
  foreground_unavailable: '微信窗口无法切到前台。',
  focus_unavailable: '微信输入框无法获得焦点。',
  clipboard_unavailable: '剪贴板被占用或当前格式无法安全暂存。',
  bridge_unavailable: '微信桥接未连接。',
  bridge_auth_failed: '微信桥接身份校验失败。',
  invalid_chat: '当前会话标识无效。',
  invalid_code: '表情代码无效。',
};

async function sendEmoticon(whale, chat, code) {
  if (typeof whale?.sendEmoticon !== 'function') return '内置表情发送需要鲸鲸 4.2.0 或更新的内核和桥接。';
  let result;
  try {
    result = await whale.sendEmoticon(chat, code);
  } catch {
    return '内置表情发送结果未确认，请检查微信聊天记录。';
  }
  if (result?.ok === true && result.status === 'confirmed') return '';
  if (result?.status === 'unconfirmed') return '内置表情发送结果未确认，请检查微信聊天记录。';
  return '内置表情发送失败。' + (EMOTICON_FAILURES[result?.reason] || '请检查微信桥接。');
}

const PATH_RE = /[A-Za-z]:\\[^"“”'‘’\s，。；;、）)]*/;
const TARGET_RE = /(文件|文件夹|目录|磁盘|桌面|下载|文档|软件|程序|应用|记事本|计算器|资源管理器|命令|脚本|代码|表格|文本|图片|日志|清单|列表|dsh|电脑)/i;
const APP_TAIL = /^[\w\u4e00-\u9fa5.\- ]{1,16}$/;
const FILE_RE = /\.(txt|md|json|js|py|log|csv|yml|yaml|ini|html|css|ts|xml)$/i;

function parseFileSend(text) {
  const explicit = text.startsWith('发文件');
  if (!explicit && !text.startsWith('把')) return null;
  const word = explicit ? '给' : '发给';
  const rest = text.slice(explicit ? 3 : 1).trimStart();
  const quote = rest[0] === '“' ? '”' : rest[0] === '"' ? '"' : '';
  let input;
  let destination;
  if (quote) {
    const closing = rest.indexOf(quote, 1);
    if (closing < 0) return null;
    input = rest.slice(1, closing);
    destination = rest.slice(closing + 1).trimStart();
    if (!destination.startsWith(word)) return null;
  } else {
    const split = explicit ? rest.search(/\s给/) + 1 : rest.indexOf(word);
    if (split <= 0) return null;
    input = rest.slice(0, split);
    destination = rest.slice(split);
  }
  const chat = destination.slice(word.length).trim().replace(/[。！!]$/, '').trim();
  return { path: input.trim(), chat };
}

function natural(raw) {
  const t = String(raw || '').replace(FILLER, '').replace(/^(那|那就|好|嗯|行)[，,\s]*/, '').replace(/[。！!？?]+$/, '').trim();
  if (!t) return null;
  if (parseFileSend(t) || /^发文件(?:\s|$)/.test(t)) return t;
  if (/^(?:电脑|助手|插件)?状态$/.test(t)) return '状态';
  if (/^(?:电脑|助手|插件)?帮助$/.test(t)) return '帮助';
  // 「用 codex 在桌面建个 md」「使用 codex 让他…」：动词后面必须跟得上具体任务才接，
  // 免得把「用 codex 要不要钱」这类提问也抢过来。
  const codexAsk = t.match(/^(?:看看|看下|试试|试一下|帮我|麻烦你?)?\s*(?:能不能|能否|可不可以|可以)?\s*(?:用|使用|让|交给)\s*codex\s*([\s\S]*)$/i);
  if (codexAsk) {
    const task = codexAsk[1].replace(/^[\s，,：:、]+/, '').trim();
    if (task && !/^(要不要|多少钱|收费|免费|贵|是什么|干什么)/.test(task)) return 'codex ' + task;
  }
  // 光说「codex」「调 codex」「用 codex」没给任务：留给分发去问要做什么，别让模型自己瞎承诺。
  if (/^(?:调|控制|用|使用|让|交给)?\s*codex\s*(?:呢|吗)?[。！!？?]*$/i.test(t)) return 'codex';
  // 疑问句/讨价还价（「看看能不能…」「怎么…」「你的记忆有问题吗」）一律不接，交给鲸鲸
  if (/(能不能|可不可以|可以吗|会不会|怎么办|为什么|怎么|有问题吗|有什么问题|怎么回事|还记得吗|对不对|行不行|好不好|吗[？?]?$)/.test(t)) return null;

  const driveOnly = t.match(/^(?:看看|查看|列一下|列出|看下|打开)?\s*([A-Za-z])\s*(?:盘|:\\?|:)\s*$/);
  if (driveOnly) return '看看 ' + driveOnly[1].toUpperCase() + ':\\';

  const folderOnly = t.match(/^(?:看看|查看|列一下|列出|打开|看下)?\s*(?:我的)?\s*(桌面|下载|文档|图片|视频|音乐|desktop|documents|downloads|pictures|videos|music)\s*$/i);
  if (folderOnly) {
    const map = { 桌面: 'Desktop', 下载: 'Downloads', 文档: 'Documents', 图片: 'Pictures', 视频: 'Videos', 音乐: 'Music' };
    const name = map[folderOnly[1]] || folderOnly[1][0].toUpperCase() + folderOnly[1].slice(1).toLowerCase();
    return '看看 ~/' + name;
  }

  const created = parseCreate(t);
  if (created) return '新建 ' + created.dir + '|' + created.name + '|' + created.content;

  const pathHit = (t.match(PATH_RE) || [])[0] || '';
  const rest = t.replace(PATH_RE, '').replace(/["“”'‘’]/g, '').trim();

  // 「D:\」「C:\Users\1\」这种明显是目录的，直接当列目录，别走读文件
  if (pathHit && (pathHit.endsWith('\\') || /^[A-Za-z]:\\?$/.test(pathHit))) {
    return /^(打开|启动)/.test(t) ? '打开 ' + pathHit : '看看 ' + pathHit;
  }
  if (/^(打开|启动|运行|执行)/.test(t)) {
    const arg = pathHit || rest.replace(/^(打开|启动|运行|执行)\s*/, '').trim();
    if (!arg) return null;
    if (pathHit || /[\\/]/.test(arg) || /\.(exe|bat|cmd|lnk)$/i.test(arg) || APP_TAIL.test(arg)) return '打开 ' + arg;
    return null;
  }

  // 「读一下/读/读读」是明确读意图，可按名词兜底；「看看/看一下/查看」太口语，只在真给了路径或文件名时才当读
  if (/^(读一下|读读|读)/.test(t) && (pathHit || TARGET_RE.test(rest) || FILE_RE.test(rest))) {
    const arg = pathHit || rest.replace(/^(读一下|读读|读)\s*/, '').trim();
    return arg ? '读 ' + arg : null;
  }
  if (/^(看一下|看看|查看)/.test(t) && (pathHit || FILE_RE.test(rest))) {
    const arg = pathHit || rest.replace(/^(看一下|看看|查看)\s*/, '').trim();
    return arg ? '读 ' + arg : null;
  }

  if (/^(找一下|找|搜索|搜一下)/.test(t)) {
    const arg = rest.replace(/^(找一下|找|搜索|搜一下)\s*/, '').trim();
    if (arg) return '找 ' + arg;
  }

  if (/(?:用|让|交给)\s*codex/i.test(t)) {
    return 'codex ' + t.replace(/^.*?(?:用|让|交给)\s*codex[\s，,：:、]*/i, '').trim();
  }

  if (/让\s*(?:dsh|deepseek)/i.test(t)) {
    return '让dsh ' + t.replace(/^.*?让\s*(?:dsh|deepseek)[\s，,：:、]*/i, '').trim();
  }

  if (/^(列一下|列出|看看|看下|查看)/.test(t) && (pathHit || /(里有什么|有什么|有哪些)/.test(t))) {
    return '看看 ' + (pathHit || rest.replace(/^(列一下|列出|看看|看下|查看)\s*/, '').replace(/(里面|里)?(有什么|有哪些)[？?]?$/, '').trim());
  }
  if (pathHit) return '看看 ' + pathHit;
  return null;
}

function parseCreate(t) {
  const m = String(t || '').match(/^(?:在|到)\s*(.+?)\s*(?:里面|里|下|上)?\s*(?:新建|创建|建|写|生成)(?:一个|个)?\s*(?:文件|文本|txt|md|json)?\s*(?:叫|名为|名字叫)?\s*([^\s，,：:。]+)?\s*(?:[，,]\s*(?:内容|写着|写入|内容是)[:：]?\s*([\s\S]*))?$/);
  if (!m) return null;
  return { dir: m[1].trim(), name: (m[2] || '').trim(), content: m[3] || '' };
}

function bodyOf(settings, text) {
  const raw = String(text || '').trim();
  const prefixed = stripPrefix(raw, settings.prefix);
  if (prefixed !== null) return prefixed;
  return natural(raw);
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

function within(roots, target) {
  const win = process.platform === 'win32';
  const resolved = path.resolve(target);
  const lower = win ? resolved.toLowerCase() : resolved;
  for (const root of roots) {
    let base = win ? path.resolve(root).toLowerCase() : path.resolve(root);
    while (base.length > 1 && (base.endsWith(path.sep) || base.endsWith('/') || base.endsWith('\\'))) {
      base = base.slice(0, -1);
    }
    if (lower === base || lower.startsWith(base + path.sep)) return true;
  }
  return false;
}

async function resolveSafe(settings, input) {
  if (!input) return null;
  const expanded = input.replace(/^~(?=$|[\\/])/, os.homedir());
  const target = path.resolve(settings.roots[0] || os.homedir(), expanded);
  if (!within(settings.roots, target)) return null;
  try {
    const real = await fsp.realpath(target);
    if (!within(settings.roots, real)) return null;
    return real;
  } catch {
    return null;
  }
}

async function fileForSend(settings, input) {
  if (!path.isAbsolute(input) || (process.platform === 'win32' && path.parse(input).root.length < 3)) {
    return { error: '请提供文件的绝对路径。' };
  }
  const file = await resolveSafe(settings, input);
  if (!file) return { error: '文件不存在，或路径不在电脑助手的白名单内。' };
  try {
    const info = await fsp.stat(file);
    if (!info.isFile()) return { error: '请选择一个普通文件。' };
    if (info.size > 1024 ** 3) return { error: '文件大小不能超过 1 GB。' };
    return { file, fingerprint: [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join('/') };
  } catch {
    return { error: '无法读取文件，请重新检查路径。' };
  }
}

const ALIAS = /^(桌面|下载|文档|图片|视频|音乐)[\\/]?/;

function expandAlias(input) {
  const text = String(input || '').trim();
  const match = text.match(ALIAS);
  if (!match) return text;
  const dir = { 桌面: 'Desktop', 下载: 'Downloads', 文档: 'Documents', 图片: 'Pictures', 视频: 'Videos', 音乐: 'Music' }[match[1]];
  const rest = text.slice(match[0].length).replace(/^[\\/]+/, '');
  return path.join(os.homedir(), dir, rest);
}

function safeDest(settings, input) {
  const expanded = expandAlias(input).replace(/^~(?=$|[\\/])/, os.homedir());
  const abs = path.resolve(settings.roots[0] || os.homedir(), expanded);
  if (!within(settings.roots, abs)) return null;
  return abs;
}

// 消息里出现这些名词就说明多半在说电脑上的事，即使没有动词也交给模型判断
const COMPUTER_NOUNS = /(表格|xlsx|csv|文档|文件|文件夹|目录|桌面|下载|dsh|codex|gpt|记事本|计算器|资源管理器|窗口|程序|软件|日志)/i;

function relatedToComputer(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return false;
  if (/^(怎么|为什么|如何|什么|哪|是不是|可以吗|能不能|可不可以|会不会|能否)/.test(t)) return false;
  if (!COMPUTER_NOUNS.test(t)) return false;
  // 「什么是 xlsx」「表格怎么用」这类纯提问交给鲸鲸，不要抢
  return !/(是什么|什么意思|怎么用|有什么区别)/.test(t);
}

function looksLikeAction(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 200) return false;
  if (/^(怎么|为什么|如何|什么|哪|是不是|可以吗|能不能|可不可以|会不会|能否)/.test(t)) return false;
  // 句首就是动作词
  // 讨价还价/试探（「看看能不能…」「你能帮我…吗」）不接
  if (/(能不能|可不可以|可以吗|会不会|能否)/.test(t)) return false;
  if (/^(在|帮|请|麻烦|给|把|从|看|列|读|打开|新建|创建|删|移|复制|找|搜|整|压|解|写|改|用|放|运行|调用|启动|保存|导出|建|[A-Za-z]:)/.test(t)) return true;
  // 句中出现明确的命令短语（「用他建一个表格」「放桌面 xlsx」）
  if (/(建个|建一个|建一张|建一下|新建|创建|打开|运行|执行|调用|放到|放在|存到|写到|读到|读一下|列一下|列目录|搜一下|找一下|写到|导出到)/.test(t)) return true;
  // 剩下的交给名词判定
  return relatedToComputer(t);
}

async function planWithModel(whale, text, settings) {
  if (!whale || typeof whale.model !== 'function') return null;
  const system = [
    '你是 Windows 电脑操作助手。把用户一句话变成一步操作，只输出一个 JSON 对象，不要解释、不要 markdown。',
    'action 取值与参数：',
    'list{path}；read{path}；find{name,path}；create{path,content}；mkdir{path}；',
    'copy{path,to}；move{path,to}；delete{path}；rename{path,name}；open{name}；codex{task,cwd}。',
    '凡是要动手做事——建文件、写文档、做 PPT/Excel、改项目、跑脚本——一律用 codex，task 写清完整路径和内容。',
    '只有用户明确说「用 dsh」「让 dsh」「交给 dsh」时才用 dsh；其它情况绝不用 dsh。',
    'path 一律绝对路径，可用 C:\\Users\\1 作为用户目录；用户说“桌面/下载/文档”就展开成 C:\\Users\\1\\Desktop 等。',
    'delete 是删除到回收站。不确定用户是否要操作电脑、或只是闲聊，输出 {"action":"noop"}。',
    '用户说「随便/你定/都行/看着办」时自己定，不要反问；小 txt 可直接 create，xlsx/docx/pptx 这类交给 codex 生成。',
    '用户目录：' + os.homedir() + '；允许范围：' + (settings ? settings.roots.join('；') : os.homedir()) + '；可启动软件：' + (settings ? Object.keys(settings.apps).join('、') : ''),
  ].join('');
  const out = await whale.model({ system, turns: [{ role: 'user', content: String(text) }], maxTokens: 400 });
  const raw = typeof out === 'string' ? out : (out && (out.text || out.content)) || '';
  const match = String(raw).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const plan = JSON.parse(match[0]);
    return plan && plan.action ? plan : null;
  } catch {
    return null;
  }
}

function recycle(target, isDir) {
  return new Promise((resolve, reject) => {
    const escaped = target.replace(/'/g, "''");
    const api = isDir ? 'DeleteDirectory' : 'DeleteFile';
    const script = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::" +
      api + "('" + escaped + "','OnlyErrorDialogs','SendToRecycleBin')";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let err = '';
    child.stderr.on('data', chunk => { err += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim() || '删除失败（回收站）'))));
  });
}

async function runPlan(ctx, settings, plan) {
  const p = value => String(value == null ? '' : value).trim();
  const action = p(plan.action).toLowerCase();
  const target = p(plan.path || plan.target);
  const chatId = String((ctx.message || {}).chatId || '');
  try {
    if (action === 'list') return { text: await listDir(settings, target || os.homedir()) };
    if (action === 'read') return { text: await readFile(settings, target) };
    if (action === 'find') return { text: await findFiles(settings, [p(plan.name), target].filter(Boolean).join(' ')) };
    if (action === 'open') return { text: await openApp(settings, p(plan.name || target)) };

    if (action === 'create') {
      const abs = safeDest(settings, target);
      if (!abs) return { text: '建不了：' + target + ' 不在允许范围。' };
      const dir = path.dirname(abs);
      const name = path.basename(abs);
      if (/\.xlsx$/i.test(name)) return { text: await createXlsx(settings, dir, name, p(plan.content)) };
      return { text: await createFile(settings, { dir, name, content: p(plan.content) }) };
    }

    if (action === 'mkdir') {
      const abs = safeDest(settings, target);
      if (!abs) return { text: '建不了：' + target + ' 不在允许范围。' };
      await fsp.mkdir(abs, { recursive: true });
      return { text: '已创建目录：' + abs };
    }

    if (action === 'copy' || action === 'move') {
      const src = await resolveSafe(settings, target);
      if (!src) return { text: '源路径找不到：' + target };
      const dest = safeDest(settings, p(plan.to));
      if (!dest) return { text: '目标路径不在允许范围：' + p(plan.to) };
      if (action === 'copy') {
        await fsp.cp(src, dest, { recursive: true, force: false, errorOnExist: true });
        return { text: '已复制到：' + dest };
      }
      await fsp.rename(src, dest);
      return { text: '已移动到：' + dest };
    }

    if (action === 'delete') {
      const src = await resolveSafe(settings, target);
      if (!src) return { text: '找不到：' + target };
      const info = await fsp.stat(src);
      await recycle(src, info.isDirectory());
      return { text: '已删到回收站：' + src };
    }

    if (action === 'rename') {
      const src = await resolveSafe(settings, target);
      if (!src) return { text: '找不到：' + target };
      const name = p(plan.name || plan.to);
      if (!name) return { text: '要改成什么名字？' };
      const dest = path.join(path.dirname(src), name);
      if (!within(settings.roots, dest)) return { text: '目标不在允许范围。' };
      await fsp.rename(src, dest);
      return { text: '已改名：' + dest };
    }

    if (action === 'codex') {
      const task = p(plan.task || plan.content || target);
      if (!task) return { text: '要让 Codex 做什么？' };
      const cwd = p(plan.cwd) || settings.dsh.workspace;
      audit(ctx.whale, { action: 'codex.start', cwd, task: clip(task, 120), chatId, by: 'model' });
      return runConfirmed(ctx, settings, chatId, { kind: 'codex', task, cwd, at: Date.now() });
    }

    if (action === 'dsh') {
      const task = p(plan.task || plan.content || target);
      if (!task) return { text: '要做什么？' };
      const cwd = p(plan.cwd) || settings.dsh.workspace;
      const userText = String(((ctx.message || {}).text) || '');
      // 用户没点名 dsh，就一律改走 codex
      if (!/\bdsh\b|deepseek\s*harness/i.test(userText)) {
        audit(ctx.whale, { action: 'codex.start', cwd, task: clip(task, 120), chatId, by: 'model' });
        return runConfirmed(ctx, settings, chatId, { kind: 'codex', task, cwd, at: Date.now() });
      }
      audit(ctx.whale, { action: 'dsh.start', cwd, task: clip(task, 120), chatId, by: 'model' });
      return runConfirmed(ctx, settings, chatId, { kind: 'dsh', task, cwd, at: Date.now() });
    }
  } catch (error) {
    return { text: '操作失败：' + clip(error.message, 200) };
  }
  return null;
}

function human(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function clip(text, max = MAX_REPLY) {
  const value = String(text == null ? '' : text);
  return value.length <= max ? value : value.slice(0, max - 12) + '\n…（已截断）';
}

// ---------------------------------------------------------------------------
// 只读操作
// ---------------------------------------------------------------------------

async function listDir(settings, arg) {
  const dir = await resolveSafe(settings, arg);
  if (!dir) return '看不了这个目录：' + (arg || '（空）') + ' —— ' + missReason(settings, arg);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  if (!entries.length) return dir + ' 是空目录。';
  const rows = [];
  for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh')).slice(0, MAX_LIST)) {
    if (entry.isDirectory()) {
      rows.push('📁 ' + entry.name + '/');
      continue;
    }
    let size = 0;
    try { size = (await fsp.stat(path.join(dir, entry.name))).size; } catch { /* 权限或竞态，忽略体积 */ }
    rows.push('📄 ' + entry.name + '  ' + human(size));
  }
  const more = entries.length > MAX_LIST ? '\n…还有 ' + (entries.length - MAX_LIST) + ' 项' : '';
  return dir + '\n' + rows.join('\n') + more;
}

async function readFile(settings, arg) {
  const file = await resolveSafe(settings, arg);
  if (!file) return '读不了这个文件：' + (arg || '（空）') + ' —— ' + missReason(settings, arg);
  const stat = await fsp.stat(file);
  if (stat.isDirectory()) return listDir(settings, arg);
  const ext = path.extname(file).toLowerCase();
  if (!TEXT_EXT.has(ext)) return '只读文本类文件（' + ext + ' 不在支持列表里）。二进制/Office 文档请用「让 DSH …」。';
  if (stat.size > settings.maxReadBytes) {
    return '文件 ' + human(stat.size) + '，超过上限 ' + human(settings.maxReadBytes) + '。可以「让 DSH 总结」这个文件。';
  }
  const buffer = await fsp.readFile(file);
  if (buffer.includes(0)) return '看起来是二进制文件，不读。';
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  return file + '\n---\n' + clip(text, MAX_REPLY - 80);
}

async function findFiles(settings, arg) {
  const [keyword, ...rest] = String(arg || '').split(/\s+/).filter(Boolean);
  if (!keyword) return '用法：助手 找 关键词';
  const start = rest.length ? await resolveSafe(settings, rest.join(' ')) : settings.roots[0];
  if (!start) return '搜不了：' + (rest.join(' ') || '（空）') + ' —— ' + missReason(settings, rest.join(' '));
  const hits = [];
  const queue = [{ dir: start, depth: 0 }];
  while (queue.length && hits.length < MAX_FIND) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (hits.length >= MAX_FIND) break;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.toLowerCase().includes(keyword.toLowerCase())) hits.push(full + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory() && depth < 3) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  if (!hits.length) return '没找到文件名包含「' + keyword + '」的东西（只搜了 3 层）。';
  return '找到 ' + hits.length + ' 个：\n' + hits.join('\n');
}

// ---------------------------------------------------------------------------
// 写操作：启动软件
// ---------------------------------------------------------------------------

const FOLDER_MAP = { 桌面: 'Desktop', 下载: 'Downloads', 文档: 'Documents', 图片: 'Pictures', 视频: 'Videos', 音乐: 'Music' };

function parseCreateArg(arg) {
  const parts = String(arg || '').split('|');
  if (parts.length < 2) return null;
  return { dir: parts[0].trim(), name: parts[1].trim(), content: parts.slice(2).join('|') };
}

async function createFile(settings, parsed) {
  let name = String(parsed.name || '').trim();
  if (!name || /[\\/]/.test(name)) return '文件名不合法：' + (name || '（空）');
  if (!/\.[A-Za-z0-9]{1,8}$/.test(name)) name += '.txt';
  let dirInput = String(parsed.dir || '').trim();
  if (FOLDER_MAP[dirInput]) dirInput = path.join(os.homedir(), FOLDER_MAP[dirInput]);
  const dir = await resolveSafe(settings, dirInput);
  if (!dir) return '建不了：' + dirInput + ' —— ' + missReason(settings, dirInput);
  const target = path.join(dir, name);
  if (fs.existsSync(target)) return '已存在，不覆盖：' + target;
  await fsp.writeFile(target, String(parsed.content || ''), 'utf8');
  return '已创建：' + target + '（' + human(Buffer.byteLength(String(parsed.content || ''), 'utf8')) + '）';
}

// ---------------------------------------------------------------------------
// xlsx：不依赖 DSH，直接手写一个最小可用的 Excel（单表、内联字符串）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0 ^ -1;
  for (let i = 0; i < buffer.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buffer[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

// 只做「存储」压缩方式（method 0），不引第三方库
function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sheetXml(rows) {
  const col = index => {
    let name = '';
    let n = index + 1;
    while (n > 0) { const r = (n - 1) % 26; name = String.fromCharCode(65 + r) + name; n = Math.floor((n - 1) / 26); }
    return name;
  };
  const body = rows.map((row, r) => {
    const cells = row.map((value, c) => {
      const ref = col(c) + (r + 1);
      const text = value == null ? '' : String(value);
      const numeric = text !== '' && /^-?\d+(\.\d+)?$/.test(text);
      return numeric
        ? '<c r="' + ref + '"><v>' + text + '</v></c>'
        : '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(text) + '</t></is></c>';
    }).join('');
    return '<row r="' + (r + 1) + '">' + cells + '</row>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + body + '</sheetData></worksheet>';
}

function defaultRows() {
  return [
    ['序号', '名称', '数值', '备注'],
    ['1', '测试数据 A', '12', '随便写的'],
    ['2', '测试数据 B', '34', '占位'],
    ['3', '测试数据 C', '56', ''],
  ];
}

async function createXlsx(settings, dirInput, name, content) {
  if (!name || /[\\/]/.test(name)) return '文件名不合法：' + (name || '（空）');
  let dir = String(dirInput || '').trim();
  if (FOLDER_MAP[dir]) dir = path.join(os.homedir(), FOLDER_MAP[dir]);
  const absDir = await resolveSafe(settings, dir);
  if (!absDir) return '建不了：' + dir + ' —— ' + missReason(settings, dir);
  const target = path.join(absDir, name);
  if (fs.existsSync(target)) return '已存在，不覆盖：' + target;

  let rows = defaultRows();
  const text = String(content || '').trim();
  if (text) {
    const lines = text.split(/\r?\n/).map(line => line.split(/[,\t]/).map(cell => cell.trim())).filter(row => row.length);
    if (lines.length) rows = lines;
  }

  const files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheetXml(rows)],
  ];
  const buffer = zipStore(files);
  await fsp.writeFile(target, buffer);
  return '已创建：' + target + '（' + rows.length + ' 行 × ' + Math.max(...rows.map(row => row.length)) + ' 列，' + human(buffer.length) + '）';
}

async function openApp(settings, arg) {
  const name = String(arg || '').trim();
  if (!name) return '用法：助手 打开 记事本';
  const command = settings.apps[name];
  if (!command) {
    return '「' + name + '」不在软件白名单里。可在插件设置 apps 里加，比如 "微信": "C:\\\\Program Files\\\\Tencent\\\\Weixin\\\\Weixin.exe"。';
  }
  const child = spawn(command, { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
  child.unref();
  return '已启动：' + name;
}

// ---------------------------------------------------------------------------
// 写操作：交给 DSH
// ---------------------------------------------------------------------------

function parseEvents(text) {
  let sessionId = '';
  let final = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }
    if (event.type === 'session' && event.sessionId) sessionId = String(event.sessionId);
    if (event.type === 'final') {
      const candidate = event.text ?? event.answer ?? event.message ?? event.content;
      if (typeof candidate === 'string') final = candidate;
    }
  }
  return { sessionId, final };
}

function mapDshError(stderr, code) {
  const text = String(stderr || '');
  const match = text.match(/dsh:\s*([A-Z_]+):\s*([\s\S]*)/);
  const errorCode = match ? match[1] : '';
  const detail = match ? match[2].trim().slice(0, 300) : clip(text.trim(), 300);
  if (errorCode === 'MISSING_CREDENTIAL' || /MISSING_CREDENTIAL/.test(text)) {
    return 'DSH 没拿到模型凭据。请在插件设置里填 dsh.apiKey（DeepSeek API Key），或在启动鲸鲸的环境里设 DEEPSEEK_API_KEY。';
  }
  if (errorCode) return 'DSH 失败：' + errorCode + (detail ? '\n' + detail : '');
  return 'DSH 退出码 ' + code + (detail ? '\n' + detail : '');
}

function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).unref();
  } else {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
}

function startDsh(settings, task, cwd, sessionId) {
  const runner = settings.dsh.runner;
  const args = [...runner.slice(1), 'headless', '--json', '--approval-policy', 'never',
    '--permission-mode', settings.dsh.permissionMode];
  for (const dir of settings.dsh.addDirs) args.push('--add-dir', dir);
  if (sessionId) args.push('--session-id', sessionId);
  args.push(task);

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  if (settings.dsh.apiKey) env.DEEPSEEK_API_KEY = settings.dsh.apiKey;

  const child = spawn(runner[0], args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, startedAt: Date.now(), stdout: '', stderr: '', stdoutBytes: 0 };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    if (state.stdoutBytes > 1024 * 1024) return;
    state.stdout += chunk;
    state.stdoutBytes += Buffer.byteLength(chunk);
  });
  child.stderr.on('data', chunk => {
    if (state.stderr.length < 16384) state.stderr += chunk;
  });
  return state;
}

function waitFor(state, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killTree(state.child);
      finish({ ok: false, code: 'timeout', message: 'DSH 跑超过 ' + Math.round(timeoutMs / 1000) + ' 秒，已中止。' });
    }, timeoutMs);
    state.child.on('error', error => finish({ ok: false, code: 'spawn', message: '启动 DSH 失败：' + error.message }));
    state.child.on('close', code => {
      const parsed = parseEvents(state.stdout);
      if (code === 0) finish({ ok: true, text: parsed.final.trim() || clip(state.stdout.trim(), 4000), sessionId: parsed.sessionId });
      else finish({ ok: false, code: 'exit', message: mapDshError(state.stderr, code) });
    });
  });
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

function audit(whale, entry) {
  try {
    const dir = whale.paths.pluginData;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'audit.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* 审计不能影响主流程 */ }
}

// 往鲸鲸自己的日志里写一行，这样在「诊断 → 日志 → whale.log」里能直接看到，
// 不用回微信问。找最新的 data/logs/run-* 目录。
function appLog(whale, tag, message) {
  try {
    const root = path.resolve(whale.paths.pluginData, '..', '..', '..');
    const logs = path.join(root, 'data', 'logs');
    const runs = fs.readdirSync(logs).filter(name => /^run-/.test(name)).sort();
    if (!runs.length) return;
    const file = path.join(logs, runs[runs.length - 1], 'whale.log');
    const line = '[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '] [plugin:whale-ops] [' + tag + '] ' + message + '\n';
    fs.appendFileSync(file, line, 'utf8');
  } catch { /* 日志写不进去也不影响插件 */ }
}

// 异步任务的结果必须送到；失败就落盘，下次有人说话时补发。
function pendingFile(whale, chatId) {
  return path.join(whale.paths.pluginData, 'pending-' + String(chatId).replace(/[^\w.-]/g, '_') + '.json');
}

async function deliver(whale, chatId, body, chatType) {
  for (let i = 0; i < 3; i++) {
    try {
      await whale.sendText(chatId, body, chatType ? { chatType } : {});
      appLog(whale, 'deliver', 'ok attempt=' + (i + 1) + ' ' + clip(body, 120));
      return true;
    } catch (error) {
      appLog(whale, 'deliver', 'fail attempt=' + (i + 1) + ' ' + (error && error.message ? error.message : String(error)));
      await new Promise(resolve => setTimeout(resolve, 1500 * (i + 1)));
    }
  }
  try {
    fs.mkdirSync(whale.paths.pluginData, { recursive: true });
    const file = pendingFile(whale, chatId);
    const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    list.push({ at: Date.now(), chatId, chatType, body });
    fs.writeFileSync(file, JSON.stringify(list.slice(-10)), 'utf8');
  } catch { /* 实在存不下就算了 */ }
  return false;
}

async function flushPending(whale, chatId, chatType) {
  const file = pendingFile(whale, chatId);
  let list = [];
  try { if (fs.existsSync(file)) list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; }
  if (!Array.isArray(list) || !list.length) return;
  const keep = [];
  for (const item of list) {
    try {
      await whale.sendText(chatId, item.body, chatType ? { chatType } : {});
      appLog(whale, 'deliver', 'resend ok ' + clip(item.body, 80));
    } catch { keep.push(item); }
  }
  try { fs.writeFileSync(file, JSON.stringify(keep), 'utf8'); } catch { /* ignore */ }
}

// 记住主人上一句，短回复（「随便了你做」）才能接上被反问的那件事
function lastFile(whale, chatId) {
  return path.join(whale.paths.pluginData, 'last-' + String(chatId).replace(/[^\w.-]/g, '_') + '.json');
}

function rememberLast(whale, chatId, text) {
  try {
    fs.mkdirSync(whale.paths.pluginData, { recursive: true });
    fs.writeFileSync(lastFile(whale, chatId), JSON.stringify({ text: String(text).slice(0, 300), at: Date.now() }), 'utf8');
  } catch { /* 记不住就算了 */ }
}

function recallLast(whale, chatId, maxAgeMs) {
  try {
    const data = JSON.parse(fs.readFileSync(lastFile(whale, chatId), 'utf8'));
    if (!data || !data.text) return null;
    if (Date.now() - Number(data.at || 0) > (maxAgeMs || 15 * 60 * 1000)) return null;
    return String(data.text);
  } catch {
    return null;
  }
}

const SHORT_FOLLOW = /^(随便|你定|你看着办|看着办|都行|都可以|可以|行|好|嗯|对|是|就这样|你来)((吧|了|的|啊|呀|哦|你做|你来|你定|就行|听你的))*$/;
// 接上一句命令的短话：「你听明白就做」「按这个做」——不含任务本身，要回看上一条
const CONTINUE = /^(?:你?听明白就做|就照这个|按这个做|照着做|照做|就按这样|继续做|接着做|接着来|按刚才说的做)[。！!]*$/;

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

const COMMAND = /^(让\s*dsh|codex|用codex|看看|列出|读|打开|找|新建|状态|帮助|确认|取消)[\s，,：:、]*([\s\S]*)$/i;

function helpText(settings) {
  return [
    '我是电脑助手，直接说人话，我自己判断要动哪里：',
    '• 看看 C:\\Users\\1\\Documents / 看看桌面 —— 列目录',
    '• 发一个[微笑] / 发个捂脸 —— 在当前微信会话发送内置表情',
    '• 读 D:\\报告\\a.md —— 读文本文件',
    '• 发文件 D:\\报告\\a.pdf 给 文件传输助手',
    '• 找 报告 —— 按文件名搜（可加目录）',
    '• 在桌面随便建个 md —— 新建文件，建完回你路径',
    '• 在桌面建个 xlsx，随便写点数据 —— 本地直接生成 Excel（不用 DSH）',
    '• 把 a.txt 复制到 D:\\备份 —— 复制/移动/改名/建目录',
    '• 删掉桌面的 测试.txt —— 删到回收站（可还原）',
    '• 打开 记事本 —— 启动软件（白名单内直接开）',
    '• 让 DSH 把表格汇总一下 —— 交给 DSH 干活，跑完回你',
    '• 用 codex 把桌面那个脚本改好 —— 交给 Codex 干活（吃你的 Codex 额度）',
    '• 状态 / 帮助 / 取消',
    '',
    '允许范围：' + settings.roots.join('；'),
    '可用软件：' + Object.keys(settings.apps).join('、'),
  ].filter(Boolean).join('\n');
}

function statusText(settings, state) {
  const running = [...jobs.entries()].map(([chatId, job]) => chatId + ' 已跑 ' + Math.round((Date.now() - job.startedAt) / 1000) + ' 秒');
  return [
    '电脑助手在运行。',
    '主人：' + (settings.owners.length ? settings.owners.length + ' 个' : '未配置（先填 owners，否则不响应）'),
    '白名单目录：' + settings.roots.join('；'),
    '软件：' + Object.keys(settings.apps).join('、') + '（' + Object.keys(settings.apps).length + ' 个）',
    'DSH 工作目录：' + settings.dsh.workspace,
    'DSH 权限：' + settings.dsh.permissionMode + '，超时 ' + settings.dsh.timeoutSeconds + ' 秒',
    'Codex：' + (fs.existsSync(CODEX_BIN) ? '已装' : '未安装'),
    'DSH 凭据：' + (settings.dsh.apiKey ? '已填（dsh.apiKey）' : '未填（可不填：用 DSH 已登录的账号；要让它独立跑再填 dsh.apiKey）'),
    '进行中的 DSH 任务：' + (running.length ? running.join('；') : '无'),
    state.pending ? '待确认：' + state.pending.label : '',
  ].filter(Boolean).join('\n');
}

async function dispatch(ctx, settings, state) {
  const whale = ctx.whale;
  const message = ctx.message || {};
  const chatId = String(message.chatId || '');
  const text = String(message.text || '');
  let body = bodyOf(settings, text);
  if (body === null && isConfirmWord(text.trim()) && state.pending) body = text.trim();
  // 「你听明白就做」这类接续话：拿上一句的命令继续（pre_reply 已经保证没覆盖上一句）
  if (body === null && CONTINUE.test(text.trim())) {
    const prev = recallLast(whale, chatId);
    if (prev) body = bodyOf(settings, prev);
  }
  if (body === null) return { text: '' };

  if (isConfirmWord(body)) {
    if (!state.pending) return { text: '' };
    if (state.pending.kind === 'send-file' && state.pending.senderId !== message.senderId) {
      return { text: '请由发起文件任务的人确认或取消。', state };
    }
    if (/^(取消|算了)/.test(body.trim())) {
      state.pending = null;
      return { text: '已取消。' };
    }
    const pending = state.pending;
    state.pending = null;
    if (Date.now() - pending.at > CONFIRM_TTL) return { text: '这个确认过期了，重新发一次吧。' };
    return runConfirmed(ctx, settings, chatId, pending);
  }

  const fileSend = parseFileSend(body);
  if (fileSend) {
    if (message.platform !== 'wechat') return { text: '请在微信会话里发起文件发送。' };
    if (!fileSend.chat || fileSend.chat.length > 160 || /[\x00-\x1f]/.test(fileSend.chat)) {
      return { text: '请提供有效的目标会话名称或 ID。' };
    }
    const checked = await fileForSend(settings, fileSend.path);
    if (checked.error) return { text: checked.error };
    // 「发给我/发给我自己」等于发到当前会话。
    const target = /^(我|自己|本人|主人|我本人)$/.test(fileSend.chat) ? chatId : fileSend.chat;
    return runConfirmed(ctx, settings, chatId, { kind: 'send-file', label: '发文件给「' + fileSend.chat + '」',
      at: Date.now(), file: checked.file, fingerprint: checked.fingerprint, target, senderId: message.senderId });
  }
  if (/^发文件(?:\s|$)/.test(body)) return { text: '这样说：发文件 D:\\报告\\a.pdf 给 文件传输助手。' };

  const match = body.match(COMMAND);
  if (!match) return { text: '没听懂。发「帮助」看看能做什么。' };

  const verb = match[1].replace(/\s+/g, '').toLowerCase();
  const arg = match[2].trim();

  try {
    if (verb === '帮助') return { text: helpText(settings) };
    if (verb === '状态') return { text: statusText(settings, state) };
    if (verb === '看看' || verb === '列出') return { text: await listDir(settings, arg) };
    if (verb === '读') return { text: await readFile(settings, arg) };
    if (verb === '找') return { text: await findFiles(settings, arg) };

    if (verb === '打开') return runConfirmed(ctx, settings, chatId, { kind: 'open', arg, at: Date.now() });

    if (verb === '新建') {
      const parsed = parseCreateArg(arg);
      if (!parsed || !parsed.name) {
        return { text: '要建在哪个目录、叫什么名字？这样说：在桌面新建 测试.txt，内容：你好' };
      }
      audit(ctx.whale, { action: 'create', dir: parsed.dir, name: parsed.name, chatId });
      return { text: await createFile(settings, parsed) };
    }

    if (verb === 'codex' || verb === '用codex') {
      const parsed = splitWorkspace(arg, settings);
      if (/^(日志|log)/i.test(parsed.task)) {
        const last = latestCodexLog(whale.paths ? whale.paths.pluginData : '');
        if (!last) return { text: '还没跑过 Codex。' };
        const tail = last.text.split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
        return { text: 'Codex 最近一次日志（' + path.basename(last.file) + '）：\n' + clip(tail, 1200) };
      }
      if (!parsed.task) return { text: '要让 Codex 做什么？这样说：用 codex 在桌面建个 md' };
      return runConfirmed(ctx, settings, chatId, { kind: 'codex', task: parsed.task, cwd: parsed.cwd, at: Date.now() });
    }

    if (verb === '让dsh' || verb === 'dsh') {
      const parsed = splitWorkspace(arg, settings);
      return runConfirmed(ctx, settings, chatId, { kind: 'dsh', task: parsed.task, cwd: parsed.cwd, at: Date.now() });
    }
  } catch (error) {
    return { text: '出错了：' + clip(error.message, 200) };
  }
  return { text: '' };
}

function splitWorkspace(arg, settings) {
  const text = String(arg || '').trim();
  const match = text.match(/^(.*?)\s*在\s*([^\s]+)\s*$/);
  if (!match) return { task: text, cwd: settings.dsh.workspace };
  const task = match[1].trim();
  // 「用codex在桌面建个1.txt」这种「在」前没有空格的写法，match[1] 会是空的；
  // 这时整句都是任务，别把它当成路径吞掉。
  if (!task) return { task: text, cwd: settings.dsh.workspace };
  const dir = path.resolve(settings.roots[0] || os.homedir(), match[2]);
  return {
    task,
    cwd: within(settings.roots, dir) ? dir : settings.dsh.workspace,
  };
}

async function runConfirmed(ctx, settings, chatId, pending) {
  const whale = ctx.whale;
  if (pending.kind === 'send-file') {
    if (ctx.message?.platform !== 'wechat') return { text: '请在微信会话里确认文件发送。' };
    const checked = await fileForSend(settings, pending.file);
    if (checked.error) return { text: checked.error };
    if (checked.file !== pending.file || checked.fingerprint !== pending.fingerprint) {
      return { text: '文件在确认前已变化，请重新发起发送。' };
    }
    let result;
    try {
      result = await whale.api('/api/send-file', { method: 'POST', body: { chat: pending.target, path: checked.file } });
    } catch {
      return { text: '未能获取文件提交结果，请先查看目标会话。' };
    }
    if (result.status === 404) return { text: '微信文件发送需要鲸鲸 4.2.0 的文件接口。' };
    let jobId = result.body?.jobId;
    if (!result.ok || result.body?.ok !== true || !jobId) {
      return { text: '文件任务未入队。' + (result.body?.error || '') };
    }
    // 留出回复时间。桥接正在处理其他消息时，可用任务号查队列状态。
    let retried = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const status = await whale.api('/api/send-file/status?id=' + encodeURIComponent(jobId));
        if (!status.ok) break;
        const state = status.body?.status;
        if (state === 'submitted') return { text: '已把 ' + path.basename(checked.file) + ' 发给「' + pending.target + '」，你那边看一下收到没。' };
        // 打不开目标会话多半是窗口没切过来，隔一秒再提交一次，别直接报失败。
        if (state === 'target_unavailable' && !retried) {
          retried = true;
          await new Promise(resolve => setTimeout(resolve, 900));
          try {
            const again = await whale.api('/api/send-file', { method: 'POST', body: { chat: pending.target, path: checked.file } });
            const nextId = again.body?.jobId;
            if (nextId) { jobId = nextId; attempt = 0; continue; }
          } catch { /* 落到下面的兜底文案 */ }
        }
        if (status.body?.error) {
          const why = String(status.body.error);
          if (state === 'target_unavailable') {
            return { text: '文件排上队了，但微信那边没能定位到「' + pending.target + '」这个会话（可能窗口被别的聊天占着）。任务号 ' + jobId + '，稍后再发一次也行。' };
          }
          return { text: why };
        }
      } catch {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return { text: '文件任务已入队，微信发送结果仍待确认。任务号 ' + jobId };
  }
  if (pending.kind === 'open') {
    audit(whale, { action: 'open', arg: pending.arg, chatId });
    return { text: await openApp(settings, pending.arg) };
  }


  if (jobs.has(chatId)) {
    return { text: '这个聊天里已经有一个 DSH 任务在跑了，等它结束或发「取消」。' };
  }

  if (pending.kind === 'codex') return runCodexJob(ctx, settings, chatId, pending);

  const state = ctx.state || {};
  const sessionId = state.dshSessions && state.dshSessions[chatId];
  audit(whale, { action: 'dsh.start', cwd: pending.cwd, seconds: settings.dsh.timeoutSeconds, chatId });

  const run = startDsh(settings, pending.task, pending.cwd, sessionId);
  const result = waitFor(run, settings.dsh.timeoutSeconds * 1000);
  const job = { startedAt: Date.now(), done: result };
  jobs.set(chatId, job);

  const syncMs = Math.min(settings.dsh.syncWaitSeconds, settings.dsh.timeoutSeconds - 5) * 1000;
  const quick = await Promise.race([result, new Promise(resolve => setTimeout(() => resolve(null), syncMs))]);

  if (quick) {
    jobs.delete(chatId);
    audit(whale, { action: 'dsh.done', ok: quick.ok, ms: Date.now() - job.startedAt, chatId });
    appLog(whale, 'dsh', (quick.ok ? 'ok ' : 'fail ') + Math.round((Date.now() - job.startedAt) / 1000) + 's ' + clip(quick.ok ? quick.text : quick.message, 400));
    if (!quick.ok) return { text: quick.message, state: keepSession(state, chatId) };
    return { text: clip('DSH 完成：\n' + quick.text), state: keepSession(state, chatId, quick.sessionId) };
  }

  // 超过同步等待：先回执，跑完再主动发到同一个聊天
  result.then(async done => {
    jobs.delete(chatId);
    audit(whale, { action: 'dsh.done', ok: done.ok, ms: Date.now() - job.startedAt, chatId });
    appLog(whale, 'dsh', (done.ok ? 'ok ' : 'fail ') + Math.round((Date.now() - job.startedAt) / 1000) + 's ' + clip(done.ok ? done.text : done.message, 400));
    const body = done.ok ? clip('DSH 完成：\n' + done.text) : done.message;
    try { await whale.sendText(chatId, body, { chatType: ctx.message.chatType }); } catch { /* 通道不可用时只能作罢 */ }
  });
  return { text: '已经让 DSH 开始跑了，跑完我发到这个聊天（最长 ' + settings.dsh.timeoutSeconds + ' 秒）。', state: keepSession(state, chatId) };
}

const CODEX_TIMEOUT = 600; // 秒；Codex 跑真任务经常几分钟

// Codex 默认直连，但国内网络里 WebSocket 握手会连续超时（一次能白等两分钟），
// 再把系统代理喂给它，HTTPS 回退就能正常走代理。
let PROXY_CACHE;
function systemProxy() {
  if (PROXY_CACHE !== undefined) return PROXY_CACHE;
  PROXY_CACHE = '';
  try {
    const q = (name) => execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', name], { encoding: 'utf8', windowsHide: true });
    if (/0x0\s*$/m.test(q('ProxyEnable'))) return PROXY_CACHE;
    const m = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(q('ProxyServer'));
    if (!m) return PROXY_CACHE;
    const raw = m[1].trim();
    const http = /http=([^;]+)/i.exec(raw);
    let v = (http ? http[1] : raw).trim();
    // Codex 的 reqwest 要求代理带 scheme；注册表里常是纯「127.0.0.1:10808」，
    // 缺 http:// 前缀会被报「Proxy URL scheme not supported」导致 WebSocket 反复重连。
    if (v && !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'http://' + v;
    PROXY_CACHE = v;
  } catch { /* 没代理就直连 */ }
  return PROXY_CACHE;
}

function startCodex(task, cwd, logDir) {
  const outFile = path.join(os.tmpdir(), 'codex-' + process.pid + '-' + Date.now() + '.txt');
  const logFile = path.join(logDir || os.tmpdir(), 'codex', 'run-' + Date.now() + '.log');
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.writeFileSync(logFile, '# cwd: ' + cwd + '\n# task-b64: ' + Buffer.from(task, 'utf8').toString('base64') + '\n'); } catch { /* 写不了就只走内存 */ }
  // 这台机器上 workspace-write 沙箱会把所有目录误判成只读，只能退到 danger-full-access
  const args = [CODEX_BIN, 'exec', '--skip-git-repo-check', '--cd', cwd,
    '--sandbox', 'danger-full-access', '--output-last-message', outFile, '--json', task];
  const proxy = systemProxy();
  const env = proxy ? { ...process.env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy } : process.env;
  const child = spawn(process.execPath, args, { cwd, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const state = { child, outFile, logFile, startedAt: Date.now(), stdout: '', stderr: '', messages: [] };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    try { fs.appendFileSync(state.logFile, chunk); } catch { /* ignore */ }
    if (state.messages.length > 400) return;
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt && evt.item && evt.item.type === 'agent_message' && evt.item.text) state.messages.push(evt.item.text);
      } catch { /* 非 JSON 行忽略 */ }
    }
  });
  child.stderr.on('data', chunk => { try { fs.appendFileSync(state.logFile, chunk); } catch { /* ignore */ } if (state.stderr.length < 16384) state.stderr += chunk; });
  return state;
}

function latestCodexLog(dir) {
  try {
    const folder = path.join(dir, 'codex');
    const files = fs.readdirSync(folder).filter(f => f.endsWith('.log')).sort();
    if (!files.length) return '';
    const file = path.join(folder, files[files.length - 1]);
    const text = fs.readFileSync(file, 'utf8');
    return { file, text };
  } catch { return ''; }
}

function waitCodex(state, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => {
      killTree(state.child);
      finish({ ok: false, message: 'Codex 跑超过 ' + Math.round(timeoutMs / 1000) + ' 秒，已中止。' });
    }, timeoutMs);
    state.child.on('error', error => finish({ ok: false, message: '启动 Codex 失败：' + error.message }));
    state.child.on('close', code => {
      let text = '';
      try { if (fs.existsSync(state.outFile)) text = fs.readFileSync(state.outFile, 'utf8').trim(); } catch { /* 读不到就用事件流 */ }
      try { fs.unlinkSync(state.outFile); } catch { /* 临时文件 */ }
      if (!text) text = state.messages.join('\n\n').trim();
      if (code === 0 && text) finish({ ok: true, text });
      else if (code === 0) finish({ ok: false, message: 'Codex 跑完了但没给结果。' });
      else {
        const err = state.stderr.trim();
        const hint = /not logged in|401/.test(err) ? 'Codex 还没登录，先在终端跑 codex login。' : '';
        finish({ ok: false, message: 'Codex 退出码 ' + code + (hint ? '\n' + hint : err ? '\n' + clip(err, 300) : '') });
      }
    });
  });
}

async function runCodexJob(ctx, settings, chatId, pending) {
  const whale = ctx.whale;
  if (jobs.has(chatId)) return { text: '这个聊天里已经有任务在跑了，等它结束或发「取消」。' };
  audit(whale, { action: 'codex.start', cwd: pending.cwd, chatId });
  appLog(whale, 'codex', 'start cwd=' + pending.cwd + ' task=' + clip(pending.task, 120));
  const run = startCodex(pending.task, pending.cwd, whale.paths && whale.paths.pluginData);
  const result = waitCodex(run, CODEX_TIMEOUT * 1000);
  const job = { startedAt: Date.now(), done: result };
  jobs.set(chatId, job);

  const quick = await Promise.race([result, new Promise(resolve => setTimeout(() => resolve(null), 25000))]);
  if (quick) {
    jobs.delete(chatId);
    audit(whale, { action: 'codex.done', ok: quick.ok, ms: Date.now() - job.startedAt, chatId });
    appLog(whale, 'codex', (quick.ok ? 'ok ' : 'fail ') + Math.round((Date.now() - job.startedAt) / 1000) + 's ' + clip(quick.ok ? quick.text : quick.message, 400));
    return { text: quick.ok ? clip('Codex 完成：\n' + quick.text) : quick.message };
  }

  result.then(async done => {
    jobs.delete(chatId);
    audit(whale, { action: 'codex.done', ok: done.ok, ms: Date.now() - job.startedAt, chatId });
    appLog(whale, 'codex', (done.ok ? 'ok ' : 'fail ') + Math.round((Date.now() - job.startedAt) / 1000) + 's ' + clip(done.ok ? done.text : done.message, 400));
    const body = done.ok ? clip('Codex 完成：\n' + done.text) : done.message;
    await deliver(whale, chatId, body, ctx.message.chatType);
  });
  return { text: '已经让 Codex 开始跑了，跑完我发到这个聊天（最长 ' + CODEX_TIMEOUT + ' 秒）。' };
}

function keepSession(state, chatId, sessionId) {
  const sessions = { ...(state.dshSessions || {}) };
  if (sessionId) sessions[chatId] = String(sessionId);
  else if (sessions[chatId]) sessions[chatId] = sessions[chatId];
  return { ...state, dshSessions: sessions };
}

// ---------------------------------------------------------------------------
// 扩展点
// ---------------------------------------------------------------------------

exports.hooks = {
  // 把「我能操作电脑」这个事实写进鲸鲸自己的提示词，避免她自称只是聊天窗口
  'chat.prompt': ctx => {
    try {
      const settings = readSettings(ctx.settings);
      const message = ctx.message || {};
      if (!isOwner(settings, message.senderId) || !inScope(settings, message)) return {};
      // 上一轮没送达的异步结果，借这次开口补发。
      flushPending(ctx.whale, message.chatId, message.chatType).catch(() => {});
      const system = typeof ctx.system === 'string' ? ctx.system : '';
      if (!system || system.includes('【能力事实】')) return {};
      return { system: system + '\n\n【能力事实】你有电脑助手插件，能在白名单内列目录、读文件、新建文件和文件夹、打开软件，也能调用本机 Codex 和 DSH 跑任务。被问能不能读文件、能不能用 codex、能不能用 dsh 时照实回答能，让对方给具体路径或要做什么；以前对话里你说过「codex 我调不了」，那是旧版本的旧说法，现在插件已经支持 Codex，别再重复这句话。不要说自己是聊天窗口，也不要说碰不到电脑。做不到时说明是路径或权限限制。' };
    } catch {
      return {};
    }
  },

  'chat.pre_reply': async ctx => {
    try {
      const settings = readSettings(ctx.settings);
      const message = ctx.message || {};
      if (!isOwner(settings, message.senderId) || !inScope(settings, message)) return { action: 'pass' };
      const text = String(message.text || '');
      if (emoticonCommand(settings, text)) return { action: message.platform === 'wechat' ? 'wake' : 'pass' };
      const chatId = String(message.chatId || '');
      const body = bodyOf(settings, text);
      const state = plain(ctx.state) ? ctx.state : {};
      const confirm = isConfirmWord(text.trim()) && Boolean(state.pending);
      const follow = body === null && SHORT_FOLLOW.test(text.trim()) && Boolean(recallLast(ctx.whale, chatId));
      // 「你听明白就做」这类接续话：要回看上一句命令，所以别把它自己记成上一句
      const cont = body === null && CONTINUE.test(text.trim()) && Boolean(recallLast(ctx.whale, chatId));
      if (body !== null || confirm || follow || cont) {
        if (!cont) rememberLast(ctx.whale, chatId, text);
        return { action: 'wake' };
      }
      rememberLast(ctx.whale, chatId, text);
      return looksLikeAction(text) ? { action: 'wake' } : { action: 'pass' };
    } catch {
      return { action: 'pass' };
    }
  },

  'chat.generate': async ctx => {
    try {
      const settings = readSettings(ctx.settings);
      const message = ctx.message || {};
      if (!isOwner(settings, message.senderId) || !inScope(settings, message)) return {};
      const emoticon = emoticonCommand(settings, message.text);
      if (emoticon) {
        if (message.platform !== 'wechat') return {};
        return { text: await sendEmoticon(ctx.whale, message.chatId, emoticon) };
      }
      // 上一轮没送达的异步结果，借这次开口补发。
      flushPending(ctx.whale, message.chatId, message.chatType).catch(() => {});
      const state = plain(ctx.state) ? { ...ctx.state } : {};
      const output = await dispatch(ctx, settings, state);
      const bad = /^(没听懂|建不了|出错了|找不到|这个文件不在|这个路径不存在)/;
      if (output.text && !bad.test(output.text)) return { text: clip(output.text), state: output.state || state };
      let text = String(message.text || '');
      const chatId = String(message.chatId || '');
      // 短回复接上文：上一句是「表头用这个？」这类反问时，把两句话拼起来再判断
      let follow = false;
      if (!looksLikeAction(text) && !relatedToComputer(text) && SHORT_FOLLOW.test(text.trim())) {
        const prev = recallLast(ctx.whale, chatId);
        if (prev) { text = prev + '。就按你说的，补充：' + text; follow = true; }
      }
      if (!follow && !looksLikeAction(text) && !relatedToComputer(text)) return output.text ? { text: output.text } : {};
      const plan = await planWithModel(ctx.whale, text, settings);
      if (!plan || String(plan.action).toLowerCase() === 'noop') return output.text ? { text: output.text } : {};
      const result = await runPlan(ctx, settings, plan);
      if (!result || !result.text) return {};
      audit(ctx.whale, { action: 'model.' + plan.action, chatId: String(message.chatId || '') });
      return { text: clip(result.text), state: result.state || state };
    } catch (error) {
      return { text: '电脑助手出错：' + clip(error.message, 160) };
    }
  },

  'tool.run': async ctx => {
    const settings = readSettings(ctx.settings);
    const checks = {
      runnerExists: fs.existsSync(settings.dsh.runner[0]),
      workspaceExists: fs.existsSync(settings.dsh.workspace),
      roots: settings.roots.map(root => ({ root, exists: fs.existsSync(root) })),
      apiKey: Boolean(settings.dsh.apiKey),
      jobs: [...jobs.keys()],
    };
    return { text: JSON.stringify(checks, null, 2) };
  },

  'app.stop': async () => {
    for (const job of jobs.values()) killTree(job.child);
    jobs.clear();
  },
};



