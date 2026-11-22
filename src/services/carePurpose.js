'use strict';

/**
 * 主动找人（care）的 purpose-engine 接线层。
 *
 * surfcore 的 purpose-engine 是纯逻辑（零 I/O、零 import），这里的职责是：
 *   1. 状态持久化 —— data/memory/care-purpose.json（drives / goals / pending / history / nextFireAt）
 *   2. 素材采集 —— 只喂微信（主人私聊 + 最近活跃群），不喂 QQ / B站（我们没有接入）
 *   3. 生成 —— 收集素材 → 驱动 → 目标假设 → 种子 → 选一个目的 → 提示词 → 模型 → 拆消息/备忘
 *   4. 回执 —— parsePurposeMemo + applyPurposeOutcome（不重复、被否定降权、惦记的事待续）
 *
 * 判「该不该发」仍然走 care.js 的 careDecide（时间窗 / 频率 / 每日上限 / 白名单），
 * 这里只替换「生成内容」和「回执记账」两层，不动 bridge 的收发协议。
 */

const fs = require('node:fs');
const path = require('node:path');
const pe = require('./purposeEngine');
const { masterLists } = require('../core/master');
const { describeError } = require('../infra/errors');

const STATE_REL = path.join('memory', 'care-purpose.json');

/** 主人 wxid（取配置里第一个真 id；没有就空，本轮退化为模板搭话）。 */
function masterUin(config) {
  const { wxids } = masterLists(config);
  return wxids.length ? wxids[0] : '';
}

/** care 的开关/频率映射成 purpose 配置（安静时段固定 23:30–08:30，surfcore 默认）。 */
function purposeConfig(runtime) {
  const c = (runtime.config && runtime.config.care) || {};
  const every = Math.max(30, Number(c.everyMinutes) || 90);
  const jitter = Math.max(0, Number(c.jitterMinutes) || 25);
  return pe.normalizePurposeConfig({
    enabled: c.enabled !== false,
    dailyMax: Math.max(1, Number(c.maxPerDay) || 6),
    gapMinMs: every * 60000,
    gapMaxMs: (every + jitter) * 60000,
  }, { ownerQQ: masterUin(runtime.config) });
}

function stateFile(runtime) {
  return path.join(runtime.config.paths.dataDir, STATE_REL);
}

function purposeState(runtime, now = Date.now()) {
  try {
    const f = stateFile(runtime);
    if (fs.existsSync(f)) {
      return pe.normalizePurposeState(JSON.parse(fs.readFileSync(f, 'utf8')), now);
    }
  } catch { /* 状态坏了就重建，别挡主动搭话 */ }
  return pe.createPurposeState(now);
}

function saveState(runtime, state) {
  try {
    const f = stateFile(runtime);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, f);
  } catch (err) {
    runtime.logger?.warn?.('care-purpose 状态保存失败：' + describeError(err));
  }
}

/** store 消息 → purpose-engine 的消息形态（time 用 ms，role 映射 isSelf/isOwner）。 */
function toMaterialMessage(m) {
  return {
    text: String(m?.text ?? '').trim(),
    isSelf: m?.role === 'assistant',
    isOwner: m?.role === 'user',
    sender: String(m?.name ?? ''),
    time: Number(m?.ts) || Date.now(),
  };
}

function recentMessages(runtime, key, limit) {
  try {
    const msgs = runtime.store?.messages(key, limit) || [];
    return msgs.map(toMaterialMessage).filter((m) => m.text);
  } catch {
    return [];
  }
}

/** 收集微信素材：主人私聊 + 最近活跃的群（无 QQ/B站）。 */
function collectWx(runtime, now = Date.now()) {
  const config = purposeConfig(runtime);
  const ownerUin = masterUin(runtime.config);
  const roleName = (runtime.config?.persona?.name) || '';
  const conversations = [];

  if (ownerUin) {
    const msgs = recentMessages(runtime, `wechat:u:${ownerUin}`, 30);
    if (msgs.length) conversations.push({ key: `private:${ownerUin}`, recentMessages: msgs });
  }

  // 群：从联系人缓存里挑群会话（最多 3 个，按最近消息）。contacts 是 Map 且有 .items。
  const contacts = runtime.contacts;
  const items = Array.isArray(contacts?.items) ? contacts.items : [];
  for (const it of items) {
    if (conversations.length >= 4) break;
    const wxid = String(it?.wxid || '').trim();
    const isGroup = it?.isGroup === true || /@chatroom$/i.test(wxid);
    if (!wxid || !isGroup) continue;
    const msgs = recentMessages(runtime, `wechat:g:${wxid}`, 20);
    if (msgs.length) conversations.push({ key: `group:${wxid}`, recentMessages: msgs });
  }

  const collected = pe.collectMaterials({
    now, config, ownerUin, roleName, conversations, biliEntries: [], memoryRecords: [],
  });
  return { ...collected, ownerUin, roleName };
}

/** 主人最近一次说话的时间（私聊最后一条 user 消息，或状态里记的 lastSentAt）。 */
function lastMasterAt(runtime, collected) {
  const ownerMsg = collected?.items?.slice().reverse().find((m) => m.kind === 'owner');
  if (ownerMsg && Number(ownerMsg.at) > 0) return Number(ownerMsg.at);
  return 0;
}

/** 组装一整套 purpose 生成上下文（纯逻辑，便于测试）。 */
function buildGeneration(runtime, state, collected, now = Date.now()) {
  const config = purposeConfig(runtime);
  const persona = runtime.config?.persona || {};
  const ownerName = String(persona.ownerName || '主人');
  const personaText = [
    persona.personality,
    persona.background,
    persona.customPrompt,
  ].filter(Boolean).join('\n');
  const personaAnalysis = pe.analyzePersona(personaText);
  const masterAt = lastMasterAt(runtime, collected);

  const driveOut = pe.deriveDrives({
    drives: state.drives, drivesAt: state.drivesAt, materials: collected.items, now,
    lastMasterAt: masterAt, personaBias: personaAnalysis.bias,
  });
  const goalOut = pe.formGoalHypotheses({
    materials: collected.items, goals: state.goals, observations: state.observations,
    drives: driveOut.drives, now, lastMasterAt: masterAt, config,
    roleName: collected.roleName, persona: personaAnalysis,
  });
  const seeds = pe.minePurposeSeeds({
    materials: collected.items, now, roleName: collected.roleName, config,
    drives: driveOut.drives, history: state.history, lastMasterAt: masterAt,
  });
  const selected = pe.selectPurpose({
    seeds, goals: goalOut.goals, pending: state.pending, history: state.history, config,
    drives: driveOut.drives, now, lastMasterAt: masterAt,
  });

  const contextBlocks = [];
  if (personaText.trim()) {
    contextBlocks.push(`你是「${persona.name || '鲸鲸'}」。${personaText}`);
  }

  const prompt = pe.buildPurposePrompt({
    now, config, mode: 'direct', ownerUin: collected.ownerUin, ownerName,
    contextBlocks,
    materials: collected.items,
    candidates: selected.candidates,
    selected: selected.purpose,
    pending: state.pending,
    history: state.history,
    drives: driveOut.drives,
  });

  return {
    prompt,
    selected,
    seeds,
    goals: goalOut.goals,
    observations: goalOut.observations,
    drives: driveOut.drives,
    materials: collected.items,
    stats: collected.stats,
  };
}

/**
 * 把模型输出拆成「要发的话」和「内部备忘」。
 * 备忘块是回合最后另起的一段，从第一个【目的】/【需求】/【状态】标记开始。
 */
function splitPurposeReply(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { message: '', memo: null };
  const marker = /【(?:目的|需求|情绪|类型|状态|待续)】/;
  const hit = marker.exec(s);
  if (!hit) return { message: s, memo: null };
  const lineStart = s.lastIndexOf('\n', hit.index - 1);
  const message = (lineStart >= 0 ? s.slice(0, lineStart) : s.slice(0, hit.index)).trim();
  const memoText = s.slice(hit.index);
  return { message, memo: pe.parsePurposeMemo(memoText) };
}

/** 清洗要发出去的话：剥引号、折叠空白、去「（内部备忘）」，留自然的多句。 */
function cleanPurposeMessage(text, max = 200) {
  let s = String(text ?? '').trim();
  s = s.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// 生成 → 回执之间的短时暂存（keyed by chatId，通常只有主人一个，一轮一个）。
const _lastGen = new Map();

function _stashRound(chatId, data) {
  const key = String(chatId || '');
  if (!key) return;
  _lastGen.set(key, { ...data, at: Date.now() });
  if (_lastGen.size > 8) {
    const oldest = _lastGen.keys().next().value;
    _lastGen.delete(oldest);
  }
}

function _takeRound(chatId) {
  const key = String(chatId || '');
  const r = _lastGen.get(key);
  if (r) _lastGen.delete(key);
  return r || null;
}

/**
 * 生成主动找人的内容。成功返回 { ok:true, text, memo, selected }；
 * 模型/解析都失败返回 { ok:false }，调用方回退到旧的模板搭话。
 */
async function generate(runtime, { chatId = '', now = Date.now() } = {}) {
  const state = purposeState(runtime, now);
  const collected = collectWx(runtime, now);
  const gen = buildGeneration(runtime, state, collected, now);
  const raw = await runtime.llm.complete({
    system: gen.prompt,
    turns: [{ role: 'user', content: '按上面的要求，现在想一句要对主人说的话。' }],
  });
  const { message, memo } = splitPurposeReply(raw);
  const text = cleanPurposeMessage(message);
  if (!text) return { ok: false, reason: 'empty', gen };
  _stashRound(chatId, { memo, selected: gen.selected });
  return { ok: true, text, memo, selected: gen.selected, gen, state };
}

/** 回执：把发送结果（sent/silent/failed）喂回状态机并落盘。 */
function record(runtime, { outcome = 'sent', text = '', chatId = '', memo = null, selected = null, now = Date.now() } = {}) {
  const round = _takeRound(chatId);
  const effMemo = memo || round?.memo || null;
  const effSelected = selected || round?.selected || null;
  const state = purposeState(runtime, now);
  const config = purposeConfig(runtime);
  const planned = effSelected?.purpose ? { text: effSelected.purpose.text || effSelected.purpose } : null;
  pe.markPurposeDelivered(state, { now, planned });
  pe.applyPurposeOutcome(state, {
    now, config, outcome, text, memo: effMemo, planned,
  });
  saveState(runtime, state);
  return state;
}

module.exports = {
  masterUin,
  purposeConfig,
  purposeState,
  saveState,
  collectWx,
  buildGeneration,
  splitPurposeReply,
  cleanPurposeMessage,
  generate,
  record,
};
