'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { json, readBody } = require('../util');
const localReply = require('../../services/localReply');

const BASELINE = { valence: 55, energy: 50 };

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function num(v, d) { return Number.isFinite(Number(v)) ? Number(v) : d; }

function moodLabel(valence, energy) {
  const v = num(valence, BASELINE.valence);
  const e = num(energy, BASELINE.energy);
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

function readBond(dataDir) {
  const file = path.join(dataDir, 'plugins', 'yxn-bond.data', 'bond.json');
  const empty = {
    mood: { valence: BASELINE.valence, energy: BASELINE.energy, why: '', updatedAt: 0 },
    people: {},
  };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      mood: { ...empty.mood, ...(raw.mood || {}) },
      people: raw.people && typeof raw.people === 'object' ? raw.people : {},
    };
  } catch {
    return empty;
  }
}


const CHAT_BUCKETS = ['greeting', 'care', 'food', 'bored', 'tired', 'happy', 'sad', 'angry', 'flirt', 'work', 'other'];
const CHAT_MODES = ['off', 'fallback', 'probabilistic'];
const DEFAULT_CHAT_CONFIG = {
  mode: 'off', probability: 0.25, readDelay: { min: 3, max: 30 },
  typingMsPerChar: 120, maxDelaySec: 45, minFreeRamMB: 1024, bucketsOff: [],
};
const DEFAULT_LOCAL_MODEL = { enabled: false, cmd: '', modelPath: '', maxTokens: 64 };

function chatDir(dataDir) {
  return path.join(dataDir, 'plugins', 'yxn-chat.data');
}

function readJson(file, fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch { return fallback; }
}

function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function clampNum(v, lo, hi, d) {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
}

function normalizeChatConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const min = Math.round(clampNum(src.readDelay && src.readDelay.min, 1, 120, 3));
  const max = Math.round(clampNum(src.readDelay && src.readDelay.max, min, 180, 30));
  const mode = CHAT_MODES.includes(src.mode) ? src.mode : 'off';
  const off = Array.isArray(src.bucketsOff) ? src.bucketsOff.filter((b) => CHAT_BUCKETS.includes(b)) : [];
  return {
    mode,
    probability: Math.round(clampNum(src.probability, 0, 1, 0.25) * 100) / 100,
    readDelay: { min, max },
    typingMsPerChar: Math.round(clampNum(src.typingMsPerChar, 20, 500, 120)),
    maxDelaySec: Math.round(clampNum(src.maxDelaySec, 5, 300, 45)),
    minFreeRamMB: Math.round(clampNum(src.minFreeRamMB, 0, 65536, 1024)),
    bucketsOff: [...new Set(off)],
  };
}

function normalizeLocalModel(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled === true,
    cmd: typeof src.cmd === 'string' ? src.cmd.slice(0, 400) : '',
    modelPath: typeof src.modelPath === 'string' ? src.modelPath.slice(0, 400) : '',
    maxTokens: Math.round(clampNum(src.maxTokens, 8, 512, 64)),
  };
}

function chatSnapshot(dataDir) {
  const dir = chatDir(dataDir);
  const config = normalizeChatConfig(readJson(path.join(dir, 'config.json'), DEFAULT_CHAT_CONFIG));
  const brain = readJson(path.join(dir, 'brain.json'), { buckets: {} });
  const buckets = brain.buckets && typeof brain.buckets === 'object' ? brain.buckets : {};

  const rows = CHAT_BUCKETS.map((id) => {
    const list = Array.isArray(buckets[id]) ? buckets[id] : [];
    const weights = list.map((e) => Number(e && e.weight)).filter((n) => Number.isFinite(n));
    const avg = weights.length ? weights.reduce((a, b) => a + b, 0) / weights.length : 0;
    const examples = list.slice(-20)
      .map((e) => String(e && e.text || '').trim()).filter(Boolean).slice(-3);
    return {
      id,
      count: list.length,
      avgWeight: Math.round(avg * 10) / 10,
      off: config.bucketsOff.includes(id),
      examples,
    };
  });

  let poolLines = 0;
  try {
    const pool = fs.readFileSync(path.join(dir, 'pool.jsonl'), 'utf8');
    poolLines = pool.split('\n').filter((l) => l.trim()).length;
  } catch { poolLines = 0; }

  let activity = [];
  try {
    const lines = fs.readFileSync(path.join(dir, 'activity.log'), 'utf8').split(/\r?\n/).filter(Boolean);
    activity = lines.slice(-120);
  } catch { activity = []; }

  const model = normalizeLocalModel(readJson(path.join(dir, 'local-model.json'), DEFAULT_LOCAL_MODEL));
  const modelFile = model.modelPath ? fs.existsSync(model.modelPath) : false;
  const cmdFile = model.cmd ? fs.existsSync(model.cmd.split(' ')[0].replace(/^"|"$/g, '')) : false;

  return {
    config,
    buckets: rows,
    totals: {
      count: rows.reduce((a, b) => a + b.count, 0),
      buckets: rows.filter((r) => r.count > 0).length,
      poolLines,
    },
    localModel: { ...model, modelExists: modelFile, cmdExists: cmdFile },
    activity,
    dir,
  };
}


function readMoodHistory(dataDir, now, hours = 24) {
  const file = path.join(dataDir, 'plugins', 'yxn-bond.data', 'mood-history.jsonl');
  const since = now - hours * 3600 * 1000;
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  const points = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (num(row.at, 0) >= since) points.push({ t: num(row.at, 0), v: clamp(num(row.v, 55), 0, 100), e: clamp(num(row.e, 50), 0, 100) });
    } catch { /* skip */ }
  }
  points.sort((a, b) => a.t - b.t);
  if (points.length <= 96) return points;
  const step = Math.ceil(points.length / 96);
  return points.filter((_, i) => i % step === 0 || i === points.length - 1);
}

function register(router) {
  router.get('/api/yxn/status', (runtime, req, res) => {
    const { dataDir } = runtime.config.paths;
    const state = readBond(dataDir);
    const valence = clamp(num(state.mood.valence, BASELINE.valence), 0, 100);
    const energy = clamp(num(state.mood.energy, BASELINE.energy), 0, 100);
    const people = Object.entries(state.people)
      .map(([wxid, p]) => ({
        wxid,
        name: p.name || '',
        closeness: Math.round(clamp(num(p.closeness, 30), 0, 100)),
        trust: Math.round(clamp(num(p.trust, 50), 0, 100)),
        tier: bondTier(p.closeness),
        lastAt: num(p.lastAt, 0),
        interactions: num(p.interactions, 0),
      }))
      .sort((a, b) => b.closeness - a.closeness)
      .slice(0, 30);

    const now = Date.now();
    return json(res, 200, {
      ok: true,
      history: readMoodHistory(dataDir, now),
      mood: {
        valence: Math.round(valence),
        energy: Math.round(energy),
        label: moodLabel(valence, energy),
        why: state.mood.why || '',
        updatedAt: num(state.mood.updatedAt, 0),
      },
      baseline: BASELINE,
      people,
    });
  });

  router.get('/api/yxn/chat', (runtime, req, res) => {
    const { dataDir } = runtime.config.paths;
    return json(res, 200, { ok: true, ...chatSnapshot(dataDir) });
  });

  router.post('/api/yxn/chat/config', async (runtime, req, res) => {
    const { dataDir } = runtime.config.paths;
    const body = await readBody(req);
    try {
      const dir = chatDir(dataDir);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'config.json');
      const current = readJson(file, DEFAULT_CHAT_CONFIG);
      const next = normalizeChatConfig({ ...current, ...(body && body.config) });
      writeJson(file, next);

      const modelFile = path.join(dir, 'local-model.json');
      if (body && body.localModel && typeof body.localModel === 'object') {
        const prev = readJson(modelFile, { enabled: false, cmd: '', modelPath: '', maxTokens: 64 });
        writeJson(modelFile, normalizeLocalModel({ ...prev, ...body.localModel }));
      }

      return json(res, 200, { ok: true, ...chatSnapshot(dataDir) });
    } catch (err) {
      return json(res, 400, { ok: false, error: err && err.message ? err.message : '保存失败' });
    }
  });

  router.post('/api/yxn/chat/local-test', async (runtime, req, res) => {
    const { dataDir } = runtime.config.paths;
    const body = (await readBody(req)) || {};
    const model = readJson(path.join(chatDir(dataDir), 'local-model.json'), { enabled: false, cmd: '', modelPath: '', maxTokens: 64, minFreeRamMB: 512 });
    const timeoutMs = Math.min(120000, Math.max(5000, Number(body.timeoutMs) || 60000));
    const result = await localReply.generate({
      text: body.text, instruction: body.instruction, config: model, timeoutMs,
    });
    let job = null;
    if (result.ok && body.send) {
      const chat = String(body.chat || '文件传输助手');
      if (chat !== '文件传输助手' && chat !== 'filehelper') {
        return json(res, 400, { ok: false, error: '调试发送目前只支持文件传输助手' });
      }
      const item = runtime.reminders.enqueueNow({
        wxid: 'filehelper', name: '文件传输助手', chatType: 'private', text: result.text, kind: 'debug',
      });
      job = { jobId: item.id, status: 'queued', chat: '文件传输助手' };
    }
    return json(res, 200, { ok: result.ok, ...result, job });
  });

  router.get('/api/yxn/voice', (runtime, req, res) => {
    const { dataDir } = runtime.config.paths;
    const file = path.join(dataDir, 'plugins', 'yxn-voice.data', 'voice.json');
    let samples = [];
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      samples = Array.isArray(raw.samples) ? raw.samples.filter((s) => typeof s === 'string') : [];
    } catch { samples = []; }
    return json(res, 200, { ok: true, ...voiceStats(samples) });
  });
};

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const OPENERS = ['嗯', '行', '好', '哦', '诶', '啊', '哈', '那个', '不是', '没有', '我'];

function voiceStats(samples) {
  const list = (samples || []).map((s) => String(s).replace(/\[\[sticker:[^\]]{1,20}\]\]/gi, '').trim()).filter(Boolean);
  const n = list.length;
  if (!n) return { n: 0, samples: [] };
  const lens = list.map((s) => Array.from(s).length);
  const pct = (x) => Math.round((x / n) * 100);
  const counts = new Map();
  for (const s of list) {
    const hit = OPENERS.find((op) => s.startsWith(op));
    if (hit) counts.set(hit, (counts.get(hit) || 0) + 1);
  }
  return {
    n,
    avg: Math.round((lens.reduce((a, b) => a + b, 0) / n) * 10) / 10,
    short: pct(lens.filter((l) => l <= 12).length),
    emoji: pct(list.filter((s) => EMOJI_RE.test(s)).length),
    period: pct(list.filter((s) => /[。.]$/.test(s)).length),
    question: pct(list.filter((s) => /[?？]$/.test(s)).length),
    openers: [...counts.entries()].filter(([, c]) => c / n >= 0.08).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([op]) => op),
    samples: list.slice(-8),
  };
}

module.exports = register;
module.exports.helpers = { chatSnapshot, normalizeChatConfig };
