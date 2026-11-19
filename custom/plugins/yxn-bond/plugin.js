'use strict';

/**
 * yxn-bond · 心情与好感
 *
 * 做三件事：
 *   1. 从聊天里更新「鲸鲸自己的心情」（valence 心情 / energy 精力，0~100）
 *   2. 记录对每个人的「亲近 closeness / 信任 trust」，按档位注入，不注入数字
 *   3. 定时让心情缓慢回到基线（人不会一直生气，也不会一直兴奋）
 *
 * 给 UI 用：/api/yxn/status 直接读这份 state（见 src/http/routes/yxn.js）。
 */

const fs = require('node:fs');
const path = require('node:path');

const BASELINE = { valence: 55, energy: 50 };
const MOOD_HALF_LIFE_HOURS = 6;

const POSITIVE_RE = /可爱|厉害|喜欢你|想你|辛苦了|谢谢|乖|好听|好看|靠谱|真棒|牛/;
const NEGATIVE_RE = /笨|蠢|滚|烦|闭嘴|讨厌|敷衍|傻|废物|别烦我|没用的东西/;
const CARE_RE = /睡吧|早点睡|吃饭|休息|喝水|别熬|注意身体/;
const FLIRT_RE = /抱|亲|贴贴|么么|摸摸头/;

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function num(v, d) { return Number.isFinite(Number(v)) ? Number(v) : d; }

function stateFile(input) {
  const root = input && input.paths && input.paths.pluginData;
  return root ? path.join(root, 'bond.json') : '';
}

function emptyState(now = Date.now()) {
  return {
    baseline: { ...BASELINE },
    mood: { valence: BASELINE.valence, energy: BASELINE.energy, updatedAt: now, why: '刚睡醒' },
    people: {},
  };
}

function loadState(file) {
  if (!file) return emptyState();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const base = emptyState();
    return {
      baseline: { ...base.baseline, ...(raw.baseline || {}) },
      mood: { ...base.mood, ...(raw.mood || {}) },
      people: raw.people && typeof raw.people === 'object' ? raw.people : {},
    };
  } catch {
    return emptyState();
  }
}

function saveState(file, state) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 1), 'utf8');
  } catch { /* ignore */ }
}

/** 心情衰减：按指数半衰期回到基线，而不是线性 */
function decayMood(mood, baseline, now) {
  const hours = Math.max(0, (now - num(mood.updatedAt, now)) / 3600000);
  if (!hours) return mood;
  const k = Math.pow(0.5, hours / MOOD_HALF_LIFE_HOURS);
  return {
    valence: clamp(num(mood.valence, baseline.valence) * k + baseline.valence * (1 - k), 0, 100),
    energy: clamp(num(mood.energy, baseline.energy) * k + baseline.energy * (1 - k), 0, 100),
    updatedAt: now,
    why: mood.why || '',
  };
}

/** 从一条消息里识别情绪事件；纯函数，方便单测 */
function eventsFromText(text) {
  const s = String(text || '');
  const out = [];
  if (POSITIVE_RE.test(s)) out.push('praise');
  if (NEGATIVE_RE.test(s)) out.push('insult');
  if (CARE_RE.test(s)) out.push('care');
  if (FLIRT_RE.test(s)) out.push('flirt');
  return out;
}

function applyEvents(mood, events) {
  let valence = num(mood.valence, BASELINE.valence);
  let energy = num(mood.energy, BASELINE.energy);
  let why = mood.why || '';
  for (const ev of events) {
    if (ev === 'praise') { valence += 4; energy += 2; why = '被夸了'; }
    else if (ev === 'insult') { valence -= 8; energy += 4; why = '被气到了'; }
    else if (ev === 'care') { valence += 2; energy -= 1; why = '被关心'; }
    else if (ev === 'flirt') { valence += 3; energy += 2; why = '有点害羞'; }
  }
  return { valence: clamp(valence, 0, 100), energy: clamp(energy, 0, 100), why, updatedAt: Date.now() };
}

/** 心情 → 一句人话 */
function moodLabel(mood) {
  const v = num(mood.valence, BASELINE.valence);
  const e = num(mood.energy, BASELINE.energy);
  if (e < 25) return v < 45 ? '又累又低落' : '很困，懒得动';
  if (v >= 75) return e >= 60 ? '心情很好' : '挺惬意的';
  if (v >= 60) return '平静';
  if (v >= 45) return '有点闷';
  if (v >= 30) return '不太高兴';
  return '很低落';
}

function bondTier(closeness) {
  const c = num(closeness, 30);
  if (c >= 85) return '很亲近';
  if (c >= 70) return '亲近';
  if (c >= 55) return '朋友';
  if (c >= 40) return '熟人';
  if (c >= 25) return '点头之交';
  return '不太熟';
}

function updatePerson(state, message, events, now) {
  const uid = String(message.senderId || '');
  if (!uid) return null;
  const prev = state.people[uid] || { closeness: 30, trust: 50, interactions: 0, lastAt: 0, name: '' };
  const next = { ...prev, lastAt: now, interactions: prev.interactions + 1 };
  if (message.senderName) next.name = String(message.senderName).slice(0, 24);

  // 每天最多涨 6 点亲近，避免刷几句就变亲密
  const dayKey = new Date(now).toISOString().slice(0, 10);
  if (prev.day !== dayKey) { next.day = dayKey; next.dayGain = 0; }
  const gain = (delta) => {
    const d = Math.min(delta, 6 - num(next.dayGain, 0));
    if (d > 0) { next.dayGain = num(next.dayGain, 0) + d; next.closeness = clamp(num(prev.closeness, 30) + d, 0, 100); }
  };

  if (events.includes('praise') || events.includes('flirt')) gain(1.2);
  if (events.includes('care')) gain(0.8);
  if (events.includes('insult')) {
    next.trust = clamp(num(prev.trust, 50) - 6, 0, 100);
    next.closeness = clamp(num(prev.closeness, 30) - 2, 0, 100);
  }
  // 久不联系慢慢淡一点（3 天以上开始）
  const days = (now - num(prev.lastAt, now)) / 86400000;
  if (days > 3) next.closeness = clamp(num(next.closeness, 30) - Math.min(4, days / 3), 0, 100);

  state.people[uid] = next;
  return next;
}

function moodLine(state) {
  const m = state.mood || BASELINE;
  const why = m.why ? `，${m.why}` : '';
  return `【此刻心情】${moodLabel(m)}${why}`;
}

function bondLine(state, senderId) {
  const p = state.people[String(senderId || '')];
  if (!p) return '';
  return `【对她的印象】${p.name || '这个人'}是${bondTier(p.closeness)}`;
}

async function onPreReply(ctx) {
  const message = (ctx && ctx.message) || {};
  if (!message.chatType || message.chatType !== 'group' && message.chatType !== 'private') return { action: 'pass' };
  const file = stateFile(ctx);
  const now = Date.now();
  const state = loadState(file);
  state.mood = decayMood(state.mood, state.baseline, now);
  const events = eventsFromText(message.text);
  if (events.length) state.mood = applyEvents(state.mood, events);
  updatePerson(state, message, events, now);
  if (events.length) { state.historyAt = 0; recordHistory(file, state, now); }
  saveState(file, state);
  return { action: 'pass' };
}

async function onPrompt(ctx) {
  const file = stateFile(ctx);
  const state = loadState(file);
  state.mood = decayMood(state.mood, state.baseline, Date.now());
  const msg = (ctx && ctx.message) || {};
  const extra = [moodLine(state), bondLine(state, msg.senderId)].filter(Boolean).join('\n');
  return { system: `${ctx.system || ''}\n\n${extra}`.trim() };
}

const HISTORY_STEP_MS = 5 * 60 * 1000;
const HISTORY_KEEP_MS = 30 * 24 * 3600 * 1000;

/** 限制快照的写入频率和保留时间，避免面板绘图时扫描过多历史。 */
function recordHistory(file, state, now) {
  if (!file) return;
  const hist = path.join(path.dirname(file), 'mood-history.jsonl');
  try {
    const last = num(state.historyAt, 0);
    if (last && now - last < HISTORY_STEP_MS) return;
    fs.appendFileSync(hist, JSON.stringify({
      at: now,
      v: Math.round(num(state.mood.valence, BASELINE.valence)),
      e: Math.round(num(state.mood.energy, BASELINE.energy)),
    }) + '\n', 'utf8');
    state.historyAt = now;
    try {
      const text = fs.readFileSync(hist, 'utf8');
      const lines = text.split('\n').filter(Boolean);
      if (lines.length > 60) {
        const keep = lines.filter((line) => {
          try { return now - Number(JSON.parse(line).at) <= HISTORY_KEEP_MS; } catch { return false; }
        });
        if (keep.length !== lines.length) fs.writeFileSync(hist, keep.join('\n') + '\n', 'utf8');
      }
    } catch { /* ignore */ }
  } catch { /* ignore */ }
}

async function onTick(ctx) {
  const file = stateFile(ctx);
  const state = loadState(file);
  const now = Date.now();
  state.mood = decayMood(state.mood, state.baseline, now);
  recordHistory(file, state, now);
  saveState(file, state);
  return {};
}

module.exports = {
  'chat.pre_reply': async (ctx) => { try { return await onPreReply(ctx); } catch { return { action: 'pass' }; } },
  'chat.prompt': async (ctx) => { try { return await onPrompt(ctx); } catch { return {}; } },
  'timer.tick': async (ctx) => { try { return await onTick(ctx); } catch { return {}; } },
};

module.exports.__test = { decayMood, eventsFromText, applyEvents, moodLabel, bondTier };
