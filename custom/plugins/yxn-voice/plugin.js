'use strict';

/**
 * yxn-voice — 说话方式
 *
 * 干三件事：
 *   1. 她每次发出去的话（chat.before_send）留一条样本，最多 200 条；
 *   2. 从样本里算：平均字数、短句比例、表情比例、句号比例、常用开头；
 *   3. chat.prompt 里注入一两行「你平时怎么发微信」，只给结论不给数字堆砌。
 *
 * 不做「模仿某个人」，只做「像真人在微信上打字」。
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_SAMPLES = 200;
const OPENERS = ['嗯', '行', '好', '哦', '诶', '啊', '哈', '那个', '不是', '没有', '我'];

function num(v, d) { return Number.isFinite(Number(v)) ? Number(v) : d; }

function dataFile(input) {
  const root = input && input.paths && input.paths.pluginData;
  return root ? path.join(root, 'voice.json') : '';
}

function load(file) {
  if (!file) return { samples: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { samples: Array.isArray(raw.samples) ? raw.samples.filter((s) => typeof s === 'string') : [] };
  } catch {
    return { samples: [] };
  }
}

function save(file, state) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ samples: state.samples.slice(-MAX_SAMPLES) }), 'utf8');
  } catch { /* 写不进去就算了，不影响聊天 */ }
}

/** 去掉标记、空白，只留真正的说话内容。 */
function clean(text) {
  return String(text || '')
    .replace(/\[\[sticker:[^\]]{1,20}\]\]/gi, '')
    .replace(/\[\[diary:[^\]]{1,32}\]\]/gi, '')
    .trim();
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

function stats(samples) {
  const list = (samples || []).map(clean).filter(Boolean);
  const n = list.length;
  if (!n) return { n: 0 };
  const lens = list.map((s) => Array.from(s).length);
  const avg = lens.reduce((a, b) => a + b, 0) / n;
  const short = lens.filter((l) => l <= 12).length / n;
  const long = lens.filter((l) => l >= 40).length / n;
  const emoji = list.filter((s) => EMOJI_RE.test(s)).length / n;
  const period = list.filter((s) => /[。.]$/.test(s)).length / n;
  const question = list.filter((s) => /[?？]$/.test(s)).length / n;

  const counts = new Map();
  for (const s of list) {
    for (const op of OPENERS) {
      if (s.startsWith(op)) {
        counts.set(op, (counts.get(op) || 0) + 1);
        break;
      }
    }
  }
  const openers = [...counts.entries()]
    .filter(([, c]) => c / n >= 0.08)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([op]) => op);

  return {
    n,
    avg: Math.round(avg * 10) / 10,
    short: Math.round(short * 100),
    long: Math.round(long * 100),
    emoji: Math.round(emoji * 100),
    period: Math.round(period * 100),
    question: Math.round(question * 100),
    openers,
    examples: list.slice(-5),
  };
}

/** 把统计结论写成两行注入语。样本少的时候宁可不说话。 */
function styleLine(st) {
  if (!st || st.n < 8) return '';
  const bits = [];
  if (st.short >= 60) bits.push('多数时候一句话就够');
  else if (st.long >= 30) bits.push('偶尔会多说几句，但别写成小作文');
  if (st.avg <= 14) bits.push('平均十来个字');
  else if (st.avg >= 30) bits.push('平均三十字上下');
  if (st.period <= 25) bits.push('句尾不常带句号');
  if (st.emoji >= 20) bits.push('偶尔带个表情');
  if (st.openers.length) bits.push('常用开头「' + st.openers.join('」「') + '」');
  if (st.question >= 50) bits.push('别每句都反问');
  if (!bits.length) return '';
  return '【说话方式】' + bits.join('，') + '。像在微信上随手回，不整理段落、不用书面连接词；不要为了像真人故意写错字。';
}

async function onPrompt(ctx) {
  const st = stats(load(dataFile(ctx)).samples);
  const line = styleLine(st);
  if (!line) return {};
  return { system: `${ctx.system || ''}\n\n${line}`.trim() };
}

async function onBeforeSend(ctx) {
  const text = clean(ctx && ctx.text);
  if (!text || text.length > 300) return { text: ctx && ctx.text };
  const file = dataFile(ctx);
  const state = load(file);
  state.samples.push(text);
  save(file, state);
  return { text: ctx && ctx.text };
}

module.exports = {
  'chat.prompt': async (ctx) => { try { return await onPrompt(ctx); } catch { return {}; } },
  'chat.before_send': async (ctx) => { try { return await onBeforeSend(ctx); } catch { return {}; } },
};

module.exports.__test = { stats, styleLine, clean };
