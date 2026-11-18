'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { json } = require('../util');

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

module.exports = function register(router) {
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

    return json(res, 200, {
      ok: true,
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
