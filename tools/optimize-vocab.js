#!/usr/bin/env node
/**
 * 离线优化 yxn-chat 词库：让 DeepSeek 把现有短句整理、补充、打标签。
 * 用法：node tools/optimize-vocab.js [--app C:\dev\whale-girl\app] [--dry]
 * 产出：brain.json 覆盖（先备份 brain.bak-<时间>.json）+ 优化报告打印。
 */
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const APP = argOf('--app', 'C:\\dev\\whale-girl\\app');
const DRY = args.includes('--dry');
const BUCKETS = ['greeting', 'food', 'bored', 'sleepy', 'miss', 'praise', 'tease', 'comfort', 'other'];
const MAX_PER_BUCKET = 150;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function deepseekKey(app) {
  const s = readJson(path.join(app, 'data', 'settings.json'), {});
  return (s.keys && (s.keys.deepseek || s.keys.DeepSeek)) || '';
}

async function askDeepSeek({ key, model, system, user, maxTokens = 4000 }) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      temperature: 0.9,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

function parseJsonLoose(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(raw); } catch { /* fallthrough */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fallthrough */ }
  }
  return null;
}

function normalizeItem(item) {
  const text = typeof item?.text === 'string' ? item.text.trim().replace(/\s+/g, ' ') : '';
  if (!text || text.length > 40) return null;
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    text,
    weight: Math.min(2, Math.max(0.2, num(item.weight, 1))),
    sweet: Math.min(1, Math.max(0, num(item.sweet, 0.4))),
    sharp: Math.min(1, Math.max(0, num(item.sharp, 0.4))),
    talky: Math.min(1, Math.max(0, num(item.talky, 0.5))),
    source: 'optimized',
    addedAt: Date.now(),
    uses: 0,
    lastUsedAt: 0,
  };
}

async function main() {
  const dataDir = path.join(APP, 'data', 'plugins', 'yxn-chat.data');
  const brainFile = path.join(dataDir, 'brain.json');
  const brain = readJson(brainFile, { buckets: {} });
  const key = deepseekKey(APP);
  if (!key) throw new Error('没有 DeepSeek key（data\\settings.json → keys.deepseek）');

  const existing = [];
  for (const [bucket, items] of Object.entries(brain.buckets || {})) {
    for (const item of items) existing.push({ bucket, text: item.text });
  }

  const system = [
    '你在帮一个微信陪聊人格整理「懒人词库」：从真实对话里提炼她自己会说的话，供离线兜底时参考。',
    '要求：',
    '1) 只写短句（不超过 24 个汉字），口语、像真人微信，不要解释、不要旁白、不要书名号。',
    '2) 每条带标签：weight 0.2~2（越常用越高）、sweet 0~1（甜度）、sharp 0~1（损/怼）、talky 0~1（话多程度）。',
    '3) 分桶：greeting 打招呼/晚安早安、food 吃的、bored 无聊/在干嘛、sleepy 困/睡、miss 想人、praise 被夸、tease 被逗被损、comfort 安慰、other 其他。',
    '4) 去重，不要和已有句子重复；不要写情色、政治、隐私、承诺性内容。',
    '只输出 JSON：{"buckets":{"桶名":[{"text":"…","weight":1,"sweet":0.4,"sharp":0.2,"talky":0.5}]}}',
    '每桶 6~12 条，总条数 40~70。',
  ].join('\n');

  const user = [
    '已有句子（用于去重）：',
    existing.slice(0, 120).map(x => `- [${x.bucket}] ${x.text}`).join('\n') || '（暂无）',
    '',
    '现在请按上面的规则产出新的 JSON。',
  ].join('\n');

  const model = argOf('--model', 'deepseek-chat');
  const reply = await askDeepSeek({ key, model, system, user });
  const parsed = parseJsonLoose(reply);
  if (!parsed || !parsed.buckets) throw new Error('模型没有返回可用 JSON：' + reply.slice(0, 200));

  const before = {};
  const after = {};
  for (const bucket of BUCKETS) {
    const old = Array.isArray(brain.buckets[bucket]) ? brain.buckets[bucket] : [];
    before[bucket] = old.length;
    const seen = new Set(old.map(x => x.text));
    const additions = (parsed.buckets[bucket] || [])
      .map(normalizeItem)
      .filter(Boolean)
      .filter(x => !seen.has(x.text));
    brain.buckets[bucket] = old.concat(additions).slice(-MAX_PER_BUCKET);
    after[bucket] = brain.buckets[bucket].length;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (!DRY) {
    fs.copyFileSync(brainFile, path.join(dataDir, `brain.bak-${stamp}.json`));
    fs.writeFileSync(brainFile, JSON.stringify(brain, null, 2), 'utf8');
    fs.appendFileSync(path.join(dataDir, 'activity.log'),
      `[yxn-chat] vocab optimized ${stamp} ` + BUCKETS.map(b => `${b}:${before[b]}->${after[b]}`).join(' ') + '\n');
  }

  console.log((DRY ? '[dry] ' : '') + '词库已更新：' + BUCKETS.map(b => `${b} ${before[b]}→${after[b]}`).join('，'));
}

main().catch(err => { console.error('优化失败：' + err.message); process.exit(1); });
