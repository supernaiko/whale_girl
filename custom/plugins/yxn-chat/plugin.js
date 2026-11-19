'use strict';

const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const EXECUTION_TIMEOUT_MS = 60000;
const MAX_DELAY_MS = 45000;
const DEFAULT_CONFIG = {
  mode: 'off', probability: 0.25, readDelay: { min: 3, max: 30 },
  typingMsPerChar: 120, maxDelaySec: 45, minFreeRamMB: 1024, bucketsOff: [],
};
const DEFAULT_MODEL = { enabled: false, cmd: '', modelPath: '', maxTokens: 64 };
const DEFAULT_TRAITS = { sweet: 0.5, sharp: 0.5, talky: 0.5 };
const BUCKETS = [
  ['goodnight', /晚安|睡觉|要睡|睡了|早点睡|好梦|困啦/u],
  ['miss', /想你|想我|想念|好久不见|有点想|好想见/u],
  ['bored', /无聊|闲得|没事做|发呆|好闷|没意思/u],
  ['complain', /好烦|烦死|好累|累死|讨厌|气死|难受|委屈|吐槽|倒霉|心累/u],
  ['food', /吃饭|吃了|吃啥|吃点|好吃|开饭|早餐|午饭|晚饭|饿|宵夜|奶茶/u],
  ['praise', /厉害|好棒|真棒|很棒|优秀|好看|可爱|好乖|夸我|夸奖|真不错|赞你/u],
  ['greeting', /你好|您好|你早|早安|早上好|中午好|下午好|晚上好|^早[呀啊！!?？～~，,。\s]*$|嗨|哈[喽啰囉]|嘿[呀啊]?|\b(?:hi|hello|hey)\b/iu],
];
const LIGHT_BUCKETS = new Set(BUCKETS.map(([name]) => name));
const LINK = /(?:[a-z][a-z\d+.-]*:\/\/|www[.．]|<a\s+href|\[[^\]]+\]\(|(?:[a-z\d-]+[.．])+(?:com|cn|net|org|io|cc|me|edu|gov|app|xyz|info|dev|co|tv|top|link|site)\b)/iu;
const COMMAND = /[建删改发]|打开|运行|截图|截屏|codex|dsh|电脑助手|鲸鲸助手|复制|启动|执行|导出|^(?:看看|列出|读|找|状态|帮助|确认|取消|移动)|桌面|文件|目录|表格|文档|记事本|资源管理器|xlsx|[a-z]:[\\/]/iu;
const VOICE = /(?:^[\[【(（<]\s*(?:语音|voice|audio)|^语音[？?!！。]?$|语音消息|语音转文字|用语音|语音(?:回我|回复|说一句)|(?:来|说|讲|回复)(?:给我|一条|一句|一段|个|句|段|点)?\s*语音)/iu;
const UNSAFE_TEXT = /[@＠][\s\u200B-\u200D\u2060\uFEFF]*(?:所有人|全体成员|all)(?![\p{L}\p{N}.])|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/iu;
// 种子导入要排除「不是回复」的自述：错误提示、任务确认、主动搭话、系统占位、过时自述
const SEED_JUNK = /(?:白名单|不存在|路径|这个文件|目录里|建好了|做完了|文件在|弄完|在桌面|桌面建|表格|文档|记事本|读取日记|忙得怎么样|抽空喝口水|忙到现在|还在忙吗|是我主人|真不会忘|你问了几遍)/iu;

const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const nonnegative = (value, fallback) => Math.max(0, finite(value, fallback));
const unit = (value, fallback = 0.5) => Math.min(1, nonnegative(value, fallback));
const charCount = text => [...text].length;

function classifyBucket(text) {
  return BUCKETS.find(([, keywords]) => keywords.test(text))?.[0] || 'other';
}

function shouldPass(message = {}) {
  const text = String(message.text ?? '').trim();
  return !text || COMMAND.test(text) || LINK.test(text) || VOICE.test(text)
    || message.isVoice === true || message.voiceRequested === true
    || [message.type, message.msgType].some(type => /^(?:voice|audio|34)$/iu.test(type));
}

function traitAffinity(reply, persona) {
  const difference = ['sweet', 'sharp', 'talky'].reduce((total, trait) =>
    total + Math.abs(unit(reply[trait]) - unit(persona[trait])), 0);
  return 1 - difference / 3;
}

function recencyPenalty(ageMs) {
  if (ageMs < 2 * HOUR) return 0.4;
  if (ageMs < DAY) return 0.8;
  return 1;
}

function sampleReply(replies, persona, now, rng = Math.random) {
  if (!replies?.length) return undefined;
  const scores = replies.map(reply => nonnegative(reply.weight, 0) * traitAffinity(reply, persona)
    * recencyPenalty(Number.isFinite(reply.lastUsedAt) ? now - reply.lastUsedAt : Infinity));
  const max = Math.max(...scores);
  const weights = scores.map(score => Math.exp((score - max) / 0.7));
  let draw = rng() * weights.reduce((total, weight) => total + weight, 0);
  for (let index = 0; index < replies.length; index += 1) {
    draw -= weights[index];
    if (draw < 0) return replies[index];
  }
  return replies.at(-1);
}

function calculateDelayMs(text, config, remainingMs, rng = Math.random) {
  const { min, max } = config.readDelay;
  const desiredMs = (min + (max - min) * rng()) * 1000 + charCount(text) * config.typingMsPerChar;
  const cappedMs = Math.min(desiredMs, config.maxDelaySec * 1000, MAX_DELAY_MS);
  const availableMs = Math.max(0, remainingMs);
  return Math.floor(cappedMs >= availableMs ? availableMs * 0.8 : cappedMs);
}

function tuneText(text) {
  return text.trim().replace(/^好的(?=$|[，,。！!、\s])/u, '行').replace(/。+$/u, '');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  }
}

function writeAtomic(file, data) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, data, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function writeJson(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

async function* readJsonLines(file, start = 0) {
  let handle;
  try { handle = await fs.promises.open(file, 'r'); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const input = handle.createReadStream({ encoding: 'utf8', start });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line.replace(/^\uFEFF/u, '')); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        continue;
      }
      yield row;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

function loadConfig(file, settings) {
  const stored = readJson(file);
  const patch = settings || {};
  const raw = { ...stored, ...patch };
  const delay = { ...stored?.readDelay, ...patch.readDelay };
  const min = nonnegative(delay.min, DEFAULT_CONFIG.readDelay.min);
  const config = {
    mode: ['off', 'fallback', 'probabilistic'].includes(raw.mode) ? raw.mode : DEFAULT_CONFIG.mode,
    probability: unit(raw.probability, DEFAULT_CONFIG.probability),
    readDelay: { min, max: Math.max(min, nonnegative(delay.max, DEFAULT_CONFIG.readDelay.max)) },
    typingMsPerChar: nonnegative(raw.typingMsPerChar, DEFAULT_CONFIG.typingMsPerChar),
    maxDelaySec: nonnegative(raw.maxDelaySec, DEFAULT_CONFIG.maxDelaySec),
    minFreeRamMB: nonnegative(raw.minFreeRamMB, DEFAULT_CONFIG.minFreeRamMB),
    bucketsOff: Array.isArray(raw.bucketsOff) ? raw.bucketsOff.filter(name => typeof name === 'string') : [],
  };
  if (JSON.stringify(stored) !== JSON.stringify(config)) writeJson(file, config);
  return config;
}

function newBrain() {
  return { schema: 1, personaTraits: { ...DEFAULT_TRAITS }, buckets: {}, stats: { sent: 0, picked: 0, skipped: 0, model: 0 } };
}

function addReply(brain, { text, bucket, source, at }) {
  (brain.buckets[bucket] ||= []).push({
    text, weight: 1, sweet: /抱抱|亲亲|想你|宝贝|乖|呀|啦/u.test(text) ? 0.8 : 0.5,
    sharp: /切[，,！!]|笨蛋|才怪|哼/u.test(text) ? 0.8 : 0.5,
    talky: unit(charCount(text) / 30), source, uses: 0, lastUsedAt: null, addedAt: at,
  });
}

function recoverCommit(files) {
  const pending = readJson(files.pending);
  if (!pending) return;
  const bytes = Buffer.from(pending.lines);
  const appended = fs.statSync(files.pool).size - pending.offset;
  if (appended < 0 || appended > bytes.length) throw new Error('pool_changed_during_commit');
  if (appended) {
    const handle = fs.openSync(files.pool, 'r');
    try {
      const prefix = Buffer.alloc(appended);
      const read = fs.readSync(handle, prefix, 0, appended, pending.offset);
      if (read !== appended || !prefix.equals(bytes.subarray(0, appended))) throw new Error('pool_changed_during_commit');
    } finally { fs.closeSync(handle); }
  }
  if (appended < bytes.length) fs.appendFileSync(files.pool, bytes.subarray(appended));
  writeJson(files.brain, pending.brain);
  fs.unlinkSync(files.pending);
}

function commitReplies(files, brain, records) {
  if (!records.length) return writeJson(files.brain, brain);
  // 宿主串行执行同一个插件。先保留提交信息，重启后可补完 append 而不重复写素材。
  const offset = fs.statSync(files.pool).size;
  writeJson(files.pending, { offset, lines: records.map(row => JSON.stringify(row) + '\n').join(''), brain });
  recoverCommit(files);
}

async function memoryFiles(appData) {
  if (!appData) return [];
  const directory = path.join(appData, 'memory', 'chats');
  let entries;
  try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) return [file];
    if (entry.isDirectory()) {
      const messages = path.join(file, 'messages.jsonl');
      if (fs.existsSync(messages)) return [messages];
    }
    return [];
  }).sort();
}

async function seedReplies(appData, brain, now) {
  const files = await memoryFiles(appData);
  const names = new Set();
  for (const file of files) {
    for await (const row of readJsonLines(file)) {
      const mentions = Array.isArray(row?.mentionedNames) ? row.mentionedNames : [];
      const inferred = Array.isArray(row?.inferredTargetNames) ? row.inferredTargetNames : [];
      for (const name of [row?.name, row?.senderName, row?.replyToName, ...mentions, ...inferred]) {
        if (typeof name === 'string' && name.trim()) names.add(name.trim().toLowerCase());
      }
    }
  }
  const knownNames = [...names];
  const records = [];
  const seen = new Set();
  for (const file of files) {
    for await (const row of readJsonLines(file)) {
      if (row?.role !== 'assistant' || typeof (row.text ?? row.content) !== 'string') continue;
      const text = (row.text ?? row.content).trim();
      const length = charCount(text);
      if (length < 4 || length > 30 || seen.has(text) || LINK.test(text) || /[@＠]/u.test(text) || UNSAFE_TEXT.test(text) || SEED_JUNK.test(text)) continue;
      const lowercase = text.toLowerCase();
      if (knownNames.some(name => lowercase.includes(name))) continue;
      const bucket = classifyBucket(text);
      if ((brain.buckets[bucket]?.length || 0) >= 40) continue;
      const record = { at: now, bucket, text, source: 'seed' };
      records.push(record);
      addReply(brain, record);
      seen.add(text);
      if (records.length >= 400) return records;
    }
  }
  return records;
}

function logActivity(file, line) {
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trimEnd().split('\n') : [];
  writeAtomic(file, [...previous.slice(-99), line].join('\n') + '\n');
}

function logReply(file, entry) {
  try { fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8'); } catch { /* 统计日志失败不影响回复 */ }
}

async function openStore(ctx, now) {
  const { pluginData, appData } = ctx.whale.paths;
  fs.mkdirSync(pluginData, { recursive: true });
  const files = {
    brain: path.join(pluginData, 'brain.json'), pool: path.join(pluginData, 'pool.jsonl'),
    config: path.join(pluginData, 'config.json'), model: path.join(pluginData, 'local-model.json'),
    activity: path.join(pluginData, 'activity.log'), pending: path.join(pluginData, '.pool-commit.tmp'),
    replies: path.join(pluginData, 'replies.jsonl'),
  };
  if (!fs.existsSync(files.pool)) fs.appendFileSync(files.pool, '');
  recoverCommit(files);
  const config = loadConfig(files.config, ctx.settings);
  const storedModel = readJson(files.model);
  const localModel = storedModel ?? DEFAULT_MODEL;
  if (storedModel === undefined) writeJson(files.model, localModel);
  let brain = readJson(files.brain);
  if (brain === undefined) {
    brain = newBrain();
    const seeds = await seedReplies(appData, brain, now);
    commitReplies(files, brain, seeds);
    logActivity(files.activity, `[yxn-chat] seeded ${seeds.length} in ${Object.keys(brain.buckets).length} buckets`);
  }
  if (brain?.schema !== 1) throw new Error('unsupported_brain_schema');
  return { files, config, localModel, brain };
}

async function learnFinalReply(store, finalText, now, recent) {
  const text = typeof finalText === 'string' ? finalText.trim() : '';
  if (!text || text.length > 16000 || UNSAFE_TEXT.test(text)) return undefined;
  const file = store.files.pool;
  const size = fs.statSync(file).size;
  if (recent.file !== file || size < recent.offset) {
    recent.file = file;
    recent.offset = 0;
    recent.byText.clear();
  }
  for (const [value, at] of recent.byText) if (now - at >= DAY) recent.byText.delete(value);
  if (size > recent.offset) {
    for await (const row of readJsonLines(file, recent.offset)) {
      if (typeof row?.text === 'string' && Number.isFinite(row.at) && now - row.at < DAY) {
        recent.byText.set(row.text, Math.max(recent.byText.get(row.text) ?? -Infinity, row.at));
      }
    }
    recent.offset = size;
  }
  if (recent.byText.has(text)) return undefined;
  const record = { at: now, bucket: classifyBucket(text), text, source: 'learned' };
  addReply(store.brain, record);
  return record;
}

function maintainBrain(brain, now) {
  for (const [bucket, replies] of Object.entries(brain.buckets)) {
    for (const reply of replies) {
      if (now - (reply.lastUsedAt ?? reply.addedAt) >= 14 * DAY) reply.weight *= 0.95;
    }
    const kept = replies.filter(reply => reply.weight >= 0.05);
    if (kept.length > 150) kept.sort((a, b) => b.weight - a.weight || (b.lastUsedAt ?? b.addedAt) - (a.lastUsedAt ?? a.addedAt));
    brain.buckets[bucket] = kept.slice(0, 150);
  }
}

let sharedLocalReply;
try {
  sharedLocalReply = require('../../../src/services/localReply');
} catch {
  sharedLocalReply = null;
}

async function generateLocalModelReply({ localModel, message, bucket, deadline }) {
  if (sharedLocalReply && localModel && localModel.enabled === true) {
    const timeoutMs = Math.min(60000, Math.max(5000, Number(deadline || 0) - Date.now()));
    const result = await sharedLocalReply.generate({ text: String(message?.text || ''), config: localModel, timeoutMs });
    if (result && result.ok) return result.text;
    if (result && localModel.serverUrl) return undefined;
  }
  if (!localModel || localModel.enabled !== true) return undefined;
  const cmd = String(localModel.cmd || '').trim();
  const modelPath = String(localModel.modelPath || '').trim();
  if (!cmd || !modelPath) return undefined;
  let freeMB = 0;
  try { freeMB = Math.floor(os.freemem() / (1024 * 1024)); } catch { freeMB = 0; }
  if (freeMB < (Number(localModel.minFreeRamMB) || 1024)) return undefined;
  const left = Math.min(60000, Math.max(5000, Number(deadline || 0) - Date.now()));
  const text = String((message && message.text) || '').slice(0, 120);
  if (!text) return undefined;
  const prompt = '你是雅小奈，蓝发鲸鱼娘，温柔心软、说话软一点，在微信私聊里随口回一句。口语、短、一到两句不超过20字，不要解释，不要自称AI。\n对方说：' + text + '\n你回：';
  const dir = path.join(os.tmpdir(), 'yxn-chat');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const promptFile = path.join(dir, 'p-' + Date.now() + '.txt');
  try {
    fs.writeFileSync(promptFile, prompt, 'utf8');
    const raw = await new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (value) => { if (!done) { done = true; resolve(value); } };
      let child;
      try {
        child = spawn(cmd, ['-m', modelPath, '-f', promptFile, '-n', String(Number(localModel.maxTokens) || 64), '-t', '4',
          '--no-display-prompt', '--single-turn', '--no-warmup', '--jinja'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { finish(''); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(''); }, left);
      child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
      child.on('error', () => { clearTimeout(timer); finish(''); });
      child.on('close', () => { clearTimeout(timer); finish(out); });
    });
    const lines = String(raw || '').split(/\r?\n/);
    const marker = lines.findIndex((line) => line.trim().startsWith('> '));
    if (marker < 0) return undefined;
    const body = [];
    const skip = Math.max(0, prompt.split('\n').length - 1);
    for (const line of lines.slice(marker + 1 + skip)) {
      const row = line.trim();
      if (!row) { if (body.length) break; else continue; }
      if (row.startsWith('[ Prompt:') || row.startsWith('Exiting')) break;
      body.push(row);
    }
    const reply = body.join(' ').replace(/^["'「」]+|["'「」]+$/g, '').trim();
    if (!reply || reply.length > 80) return undefined;
    if (/sorry|as an ai|无法|不能协助|不能提供/i.test(reply)) return undefined;
    return reply;
  } catch {
    return undefined;
  } finally {
    try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
  }
}

function createHooks({
  rng = Math.random, clock = Date.now, freeMemory = os.freemem,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const maintainedAt = new Map();
  const recentLearned = { file: undefined, offset: 0, byText: new Map() };
  return {
    'chat.pre_reply': () => ({ action: 'pass' }),
    'app.start': async ctx => { await openStore(ctx, clock()); },
    'chat.generate': async ctx => {
      if (shouldPass(ctx.message)) return {};
      const now = clock();
      // 现有宿主不提供执行截止时刻。消息时间可以保守地覆盖入队前已经过去的时间。
      const deadline = Math.min(now, finite(ctx.now, now)) + EXECUTION_TIMEOUT_MS;
      const store = await openStore(ctx, now);
      const { brain, config, files, localModel } = store;
      const bucket = classifyBucket(ctx.message.text);
      const mayReply = config.mode !== 'off' && typeof ctx.text !== 'string' && !config.bucketsOff.includes(bucket);
      const shouldReply = mayReply && (
        (config.mode === 'fallback' && Boolean(ctx.reason || ctx.error))
        || (config.mode === 'probabilistic' && LIGHT_BUCKETS.has(bucket) && rng() < config.probability)
      );
      let reply;
      let text;
      let source = '';
      if (shouldReply) {
        const modelText = localModel.enabled === true
          ? tuneText(await generateLocalModelReply({ localModel, message: ctx.message, bucket, deadline }) ?? '')
          : '';
        reply = modelText ? undefined : sampleReply(brain.buckets[bucket], brain.personaTraits, now, rng);
        text = modelText || tuneText(reply?.text ?? '');
        source = modelText ? 'model' : (reply ? 'pool' : '');
        if (UNSAFE_TEXT.test(text)) text = '';
        if (text) {
          const delay = calculateDelayMs(text, config, deadline - clock(), rng);
          if (delay > 0) await sleep(delay);
          if (reply) {
            reply.uses += 1;
            reply.lastUsedAt = clock();
            brain.stats.picked += 1;
          }
          brain.stats.sent += 1;
          if (source === 'model') brain.stats.model += 1;
        }
      }
      if (!text && mayReply) brain.stats.skipped += 1;
      const learned = await learnFinalReply(store, ctx.finalText, clock(), recentLearned);
      if (mayReply || learned) commitReplies(files, brain, learned ? [learned] : []);
      if (text) logReply(files.replies, { at: clock(), bucket, source, text });
      return text ? { text } : {};
    },
    'timer.tick': async ctx => {
      const now = clock();
      const directory = ctx.whale.paths.pluginData;
      if (now - (maintainedAt.get(directory) ?? -Infinity) < HOUR) return;
      const { brain, config, files } = await openStore(ctx, now);
      maintainBrain(brain, now);
      writeJson(files.brain, brain);
      const freeMB = Math.floor(freeMemory() / (1024 * 1024));
      if (freeMB < config.minFreeRamMB) {
        logActivity(files.activity, `[yxn-chat] warning low_memory freeMB=${freeMB} minFreeRamMB=${config.minFreeRamMB}`);
      }
      maintainedAt.set(directory, now);
    },
  };
}

exports.hooks = createHooks();
exports.createHooks = createHooks;
exports.sampleReply = sampleReply;
exports.calculateDelayMs = calculateDelayMs;
exports.generateLocalModelReply = generateLocalModelReply;
