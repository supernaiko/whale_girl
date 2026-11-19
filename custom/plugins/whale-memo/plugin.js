'use strict';
// 记忆管家 whale-memo — 每天从和主人的聊天里提炼长期记忆，写成草稿，主人回「确认记忆」才并入人设。
// Api 4 · Hooks: chat.pre_reply / chat.generate / timer.tick / tool.run
const fs = require('node:fs');
const path = require('node:path');

const APPLY_RE = /^(确认记忆|记下来|并入人设|记忆确认)$/;
const MAX_LINES = 300;
const MAX_SECTION = 1600;

function settingsOf(input) {
  const s = (input && typeof input === 'object') ? input : {};
  return {
    owners: Array.isArray(s.owners) ? s.owners : [],
    hour: Number.isFinite(Number(s.hour)) ? Number(s.hour) : 21,
    minLines: Number.isFinite(Number(s.minLines)) ? Number(s.minLines) : 10,
    maxItems: Number.isFinite(Number(s.maxItems)) ? Number(s.maxItems) : 3,
    sendToOwner: s.sendToOwner !== false,
  };
}

function dataDir(ctx) {
  const w = ctx.whale || {};
  return (w.paths && w.paths.pluginData) || path.join(require('node:os').homedir(), '.whale-memo');
}
function personaPath(ctx) {
  const w = ctx.whale || {};
  const base = (w.paths && w.paths.appData) || path.join(dataDir(ctx), '..', '..');
  return path.join(base, 'persona.json');
}
function p(ctx, ...parts) { return path.join(dataDir(ctx), ...parts); }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}
function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}
function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function isOwner(settings, msg) {
  const from = String(msg.senderId || '');
  if (!from) return false;
  if (settings.owners.length) return settings.owners.includes(from);
  return msg.chatType === 'private';
}
function rememberChat(ctx, msg) {
  if (!isOwner(settingsOf(ctx.settings), msg)) return;
  const text = String(msg.text || '').slice(0, 500);
  if (!text) return;
  const lines = readLines(p(ctx, 'chat.jsonl'));
  if (lines.length && lines[lines.length - 1].text === text) return;
  appendLine(p(ctx, 'chat.jsonl'), { t: Date.now(), text });
  const all = lines.concat([{ t: Date.now(), text }]);
  if (all.length > MAX_LINES) fs.writeFileSync(p(ctx, 'chat.jsonl'), all.slice(-MAX_LINES).map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  if (!fs.existsSync(p(ctx, 'owner.json')) && msg.chatId) writeJson(p(ctx, 'owner.json'), { chatId: msg.chatId, chatType: msg.chatType || 'private' });
}

const PROMPT = [
  '你在整理一段微信私聊的长期记忆。只保留会长期成立、以后还用得上的东西。',
  '输出严格 JSON：{"facts":[],"promises":[],"style":[]}',
  'facts：关于对方身份、生活、工作、喜好的稳定事实；promises：双方约定（时间、暗号、边界）；style：称呼、语气、习惯用词的变化。',
  '每条不超过 40 字，最多 3 条；没有就空数组。不要复述聊天，不要编造。',
].join('\n');

function parseModel(text) {
  const raw = String(text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const clean = a => (Array.isArray(a) ? a.map(x => String(x).slice(0, 60)).filter(Boolean).slice(0, 3) : []);
    return { facts: clean(o.facts), promises: clean(o.promises), style: clean(o.style) };
  } catch { return null; }
}

function renderDraft(date, items) {
  const lines = [`记忆草稿 ${date}`];
  const tag = { facts: '事实', promises: '约定', style: '习惯' };
  for (const k of ['facts', 'promises', 'style']) {
    if (!items[k] || !items[k].length) continue;
    lines.push('', `【${tag[k]}】`);
    for (const it of items[k]) lines.push('- ' + it);
  }
  return lines.join('\n');
}

async function buildDraft(ctx) {
  const settings = settingsOf(ctx.settings);
  const lines = readLines(p(ctx, 'chat.jsonl')).slice(-120);
  if (lines.length < settings.minLines) return { ok: false, reason: '聊得太少（' + lines.length + ' 条）' };
  const transcript = lines.map(x => '- ' + x.text).join('\n').slice(-6000);
  const persona = readJson(personaPath(ctx), {});
  const who = String(persona.name || '她') + ' / ' + String(persona.job || '');
  const text = await ctx.whale.model({
    system: PROMPT + '\n当前人设：' + who,
    turns: [{ role: 'user', content: '最近的对话：\n' + transcript }],
    maxTokens: 800,
  });
  const items = parseModel(text);
  if (!items) return { ok: false, reason: '模型没给出可解析的 JSON' };
  const date = new Date().toISOString().slice(0, 10);
  writeJson(p(ctx, 'draft.json'), { date, items, at: Date.now() });
  writeJson(p(ctx, 'pending.json'), { date, items, at: Date.now() });
  fs.writeFileSync(p(ctx, 'draft.md'), renderDraft(date, items), 'utf8');
  return { ok: true, date, items, text: renderDraft(date, items) };
}

function mergeSection(prompt, items) {
  const date = new Date().toISOString().slice(0, 10);
  const tag = { facts: '事实', promises: '约定', style: '习惯' };
  const newItems = [];
  for (const k of ['facts', 'promises', 'style']) for (const it of items[k] || []) newItems.push(`- ${tag[k]}：${it}`);
  const marker = '【我们之间】';
  let body = String(prompt || '');
  const idx = body.indexOf(marker);
  const existing = idx >= 0 ? body.slice(idx + marker.length) : '';
  const have = new Set(body.split('\n').map(s => s.trim()));
  const fresh = newItems.filter(l => !have.has(l));
  let section = (marker + '\n' + (existing.trim() ? existing.trim() + '\n' : '') + fresh.join('\n')).trim();
  if (section.length > MAX_SECTION) section = section.slice(0, MAX_SECTION);
  if (idx >= 0) body = body.slice(0, idx).trimEnd() + '\n\n' + section;
  else body = body.trimEnd() + '\n\n' + section;
  return { body, added: fresh.length, date };
}

async function applyDraft(ctx) {
  const pending = readJson(p(ctx, 'pending.json'), null);
  if (!pending || !pending.items) return null;
  const file = personaPath(ctx);
  const persona = readJson(file, null);
  if (!persona) return { ok: false, reason: '读不到 persona.json：' + file };
  const merged = mergeSection(persona.customPrompt || '', pending.items);
  if (!merged.added) return { ok: false, reason: '没有新内容（可能已经并过了）' };
  const backup = p(ctx, 'persona.bak.json');
  if (!fs.existsSync(backup)) writeJson(backup, { at: Date.now(), customPrompt: String(persona.customPrompt || '') });
  let viaApi = false;
  if (ctx.whale && typeof ctx.whale.api === 'function') {
    try {
      const res = await ctx.whale.api('/api/config', { method: 'POST', body: { patch: { 'persona.customPrompt': merged.body } } });
      viaApi = res && res.ok !== false;
    } catch { viaApi = false; }
  }
  if (!viaApi) {
    persona.customPrompt = merged.body;
    writeJson(file, persona);
  }
  writeJson(p(ctx, 'applied.json'), { date: pending.date, added: merged.added, viaApi, at: Date.now() });
  fs.rmSync(p(ctx, 'pending.json'), { force: true });
  return { ok: true, added: merged.added, file, viaApi };
}

async function tick(ctx) {
  const settings = settingsOf(ctx.settings);
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const meta = readJson(p(ctx, 'meta.json'), {});
  if (!ctx.force && now.getHours() < settings.hour) return { ok: false, reason: '还没到点' };
  if (meta.lastRunDate === date) return { ok: false, reason: '今天已经跑过' };
  const built = await buildDraft(ctx);
  if (!built.ok) { writeJson(p(ctx, 'meta.json'), { ...meta, lastRunDate: date, lastError: built.reason, at: Date.now() }); return built; }
  writeJson(p(ctx, 'meta.json'), { ...meta, lastRunDate: date, at: Date.now() });
  const owner = readJson(p(ctx, 'owner.json'), null);
  if (settings.sendToOwner && !ctx.silent && owner && owner.chatId && ctx.whale.sendText) {
    const msg = '今天记到这些：\n\n' + built.text + '\n\n回「确认记忆」我就并进人设。';
    try { await ctx.whale.sendText(owner.chatId, msg.slice(0, 1500), { name: '鲸鲸', chatType: owner.chatType || 'private' }); } catch (e) { /* 发送失败不影响草稿 */ }
  }
  return { ok: true, date, items: built.items };
}

module.exports = {
  async 'chat.pre_reply'(ctx) {
    const msg = ctx.message || {};
    rememberChat(ctx, msg);
    const text = String(msg.text || '').trim();
    if (/^(整理记忆|现在整理|生成记忆)$/.test(text)) return { action: 'wake' };
    if (APPLY_RE.test(text) && fs.existsSync(p(ctx, 'pending.json'))) return { action: 'wake' };
    return { action: 'pass' };
  },
  async 'chat.generate'(ctx) {
    const text = String((ctx.message && ctx.message.text) || '').trim();
    if (/^(整理记忆|现在整理|生成记忆)$/.test(text)) {
      const r = await tick({ ...ctx, force: true, silent: true });
      if (!r.ok) return { text: '这次没整理成：' + (r.reason || '未知原因') };
      return { text: (r.items ? '整理好了，先看草稿：\n\n' + renderDraft(r.date, r.items) : '整理好了。') + '\n\n回「确认记忆」并入人设。' };
    }
    if (!APPLY_RE.test(text)) return {};
    const r = await applyDraft(ctx);
    if (!r) return { text: '还没有待确认的记忆草稿。' };
    if (!r.ok) return { text: r.reason };
    return { text: '记下了，' + r.added + ' 条并入人设。' };
  },
  async 'timer.tick'(ctx) { return tick(ctx); },
  async 'tool.run'(ctx) {
    const args = (ctx.tool && ctx.tool.args) || {};
    const lines = readLines(p(ctx, 'chat.jsonl')).length;
    if (String(args.action || '') === '生成') return tick({ ...ctx, force: true });
    return { ok: true, lines, meta: readJson(p(ctx, 'meta.json'), {}), pending: fs.existsSync(p(ctx, 'pending.json')) };
  },
  _internal: { parseModel },
};
