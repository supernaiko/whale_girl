'use strict';

/**
 * yxn-gate · 接话判定
 *
 * 只在群聊、且这条消息没有被明确叫到她时介入：
 *   - wake：这条值得接，把她叫醒（宿主随后照常生成回复）
 *   - pass：什么都不做，交给宿主自己的规则（requireAt 等）
 *
 * 不做的事（避免和宿主打架）：
 *   - 不返回 skip（会让宿主连 @ 她的消息也丢掉）
 *   - 不碰私聊、不碰主人的消息
 *   - 不改文本、不注入 prompt
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  threshold: 0.62,       // 0~1，越高越少插话
  cooldownSec: 150,      // 两次主动接话的最小间隔
  maxWakesPerHour: 4,    // 每群每小时最多主动接几次
  judge: false,          // 边界分是否问一次模型
  judgeLow: 0.4,         // 进入 judge 的下限（低于它直接 pass）
};

const NAME_RE = /鲸鲸|小奈|雅小奈|鲸鱼娘|鲸娘/;
const QUESTION_RE = /[?？]|吗\b|呢|什么|怎么|谁|哪|多少|为什么|咋/;
const LAUGH_RE = /哈哈|笑死|草|乐了|绷不住/;
const LINK_ONLY_RE = /^https?:\/\/\S+$/;
const PUNCT_ONLY_RE = /^[\s\p{P}\p{S}]+$/u;
const AT_OTHER_RE = /@[^\s@]{1,20}/;

function clip(value, max) {
  const s = String(value == null ? '' : value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function readSettings(input) {
  const src = (input && input.settings) || {};
  const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    threshold: Math.min(0.95, Math.max(0.2, num(src.threshold, DEFAULTS.threshold))),
    cooldownSec: Math.max(0, num(src.cooldownSec, DEFAULTS.cooldownSec)),
    maxWakesPerHour: Math.max(1, num(src.maxWakesPerHour, DEFAULTS.maxWakesPerHour)),
    judge: src.judge === true,
    judgeLow: Math.min(0.9, Math.max(0.1, num(src.judgeLow, DEFAULTS.judgeLow))),
  };
}

/* ------------------------------- 状态 ------------------------------- */

function statePath(input) {
  const root = input && input.paths && input.paths.pluginData;
  return root ? path.join(root, 'gate-state.json') : '';
}

function loadState(file) {
  if (!file) return { chats: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && raw.chats ? raw : { chats: {} };
  } catch {
    return { chats: {} };
  }
}

function saveState(file, state) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch { /* 状态写不进去不影响判定 */ }
}

/* ------------------------------- 打分 ------------------------------- */

function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, '');
  for (let i = 0; i + 1 < cjk.length; i += 1) out.add(cjk.slice(i, i + 2));
  return out;
}

function overlap(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit += 1;
  return hit / Math.min(ta.size, tb.size);
}

/**
 * 纯函数：给一条群消息打分。返回 { score, features }
 * 所有特征都写进 features，日志里能看出「为什么没接」。
 */
function scoreMessage(message, opts = {}) {
  const text = String(message.text || '').trim();
  const features = {};
  let score = 0.05;

  const add = (name, delta) => {
    if (!delta) return;
    features[name] = Number(delta.toFixed(2));
    score += delta;
  };

  if (NAME_RE.test(text)) add('叫名字', 0.40);
  if (QUESTION_RE.test(text)) add('疑问句', 0.18);
  if (LAUGH_RE.test(text)) add('笑声', 0.10);
  if (text.length >= 4 && text.length <= 80) add('长度合适', 0.08);
  if (message.atMe) add('@了她', 0.5);
  if (opts.isMaster) add('主人', 0.15);

  const engaged = Number(opts.engagedMinutes || 0) > 0;
  if (engaged) add('接话窗口', 0.15);

  const recent = Array.isArray(opts.recentTexts) ? opts.recentTexts.slice(-3) : [];
  if (recent.length) {
    const sim = Math.max(...recent.map((t) => overlap(text, t)), 0);
    if (sim >= 0.2) add('话题延续', 0.10);
  }

  if (!text) add('空消息', -0.30);
  if (PUNCT_ONLY_RE.test(text)) add('只有标点', -0.25);
  if (LINK_ONLY_RE.test(text)) add('只有链接', -0.30);
  if (Number(opts.recentHerReplySec || 999) < 60) add('刚回过', -0.35);
  if (Number(opts.groupBusy || 0) >= 15) add('群里太吵', -0.10);
  if (message.directedElsewhere) add('在跟别人说', -0.40);
  if (!NAME_RE.test(text) && AT_OTHER_RE.test(text)) add('@了别人', -0.20);

  score = Math.min(1, Math.max(0, score));
  return { score: Number(score.toFixed(2)), features };
}

/* ------------------------------- 模型判定 ------------------------------- */

async function askJudge(whale, text, history) {
  try {
    const out = await whale.model({
      system: '你是群聊里的旁观者。判断下面这句话是否需要「鲸鲸」（一个群友）开口回应。只回答 yes 或 no，不要解释。',
      turns: [{ role: 'user', content: `最近几句：${history || '（无）'}\n这句话：${clip(text, 200)}` }],
      maxTokens: 8,
    });
    return /^\s*yes/i.test(String(out == null ? '' : out));
  } catch {
    return false;
  }
}

/* ------------------------------- hook ------------------------------- */

async function onPreReply(ctx, whale) {
  const message = (ctx && ctx.message) || {};
  if (message.chatType !== 'group') return { action: 'pass' };
  if (message.atMe) return { action: 'pass' };          // 宿主自己会回
  if (message.replyToBot) return { action: 'pass' };

  const settings = readSettings(ctx);
  const file = statePath(ctx);
  const state = loadState(file);
  const chatId = String(message.chatId || '');
  const now = Date.now();
  const entry = (chatId && state.chats[chatId]) || { wakes: [] };

  const herLast = Number(ctx.lastBotReplyAt || 0);
  const recentHerReplySec = herLast ? Math.round((now - herLast) / 1000) : 999;
  const recentTexts = Array.isArray(ctx.recentMessages)
    ? ctx.recentMessages.slice(-3).map((m) => (typeof m === 'string' ? m : m && m.text)).filter(Boolean)
    : [];

  const { score, features } = scoreMessage(message, {
    isMaster: Boolean(ctx.isMaster),
    engagedMinutes: 0,
    recentTexts,
    recentHerReplySec,
    groupBusy: Number(ctx.groupMessagesLast5Min || 0),
  });

  // 冷却与频率
  const wakes = (entry.wakes || []).filter((t) => now - Number(t) < 3600 * 1000);
  if (herLast && now - herLast < settings.cooldownSec * 1000) {
    return { action: 'pass', reason: `cooldown score=${score}` };
  }
  if (wakes.length >= settings.maxWakesPerHour) {
    return { action: 'pass', reason: `rate score=${score}` };
  }

  let wake = score >= settings.threshold;
  if (!wake && settings.judge && score >= settings.judgeLow && whale && whale.model) {
    wake = await askJudge(whale, message.text, recentTexts.join(' / '));
    features.judge = wake ? 1 : 0;
  }

  if (!wake) return { action: 'pass', reason: `score=${score} ${JSON.stringify(features)}` };

  if (chatId) {
    state.chats[chatId] = { wakes: [...wakes, now].slice(-32), lastWakeAt: now };
    saveState(file, state);
  }
  return {
    action: 'wake',
    reason: `gate score=${score}`,
    score,
    features,
  };
}

const hooks = {
  'chat.pre_reply': async (ctx) => {
    try {
      const whale = ctx && ctx.whale;
      return await onPreReply(ctx, whale);
    } catch (error) {
      return { action: 'pass', reason: 'gate_error ' + clip(error && error.message, 120) };
    }
  },
};

module.exports = hooks;
module.exports.__test = { scoreMessage, readSettings, DEFAULTS };
