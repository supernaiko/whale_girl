'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { addDays, dayKey, parseDateTimeLoose, parts, toEpoch } = require('../infra/time');
const { BEIJING, normalizePricing, usagePricer } = require('./pricing');

// 回复总字数只用于加权计算，接口的会话行无需携带这个中间值。
const replyChars = Symbol('replyChars');

function timestamp(value, timeZone = BEIJING) {
  if (typeof value === 'string') value = parseDateTimeLoose(value, timeZone);
  return Number.isFinite(value) && Number.isFinite(new Date(value).getTime()) ? value : NaN;
}

function dateRange({ days = 7, now = Date.now(), timeZone = BEIJING }) {
  const count = Number.isInteger(days) && days > 0 ? days : 7;
  const { year, month, day } = parts(+now, timeZone);
  const today = { year, month, day };
  const start = toEpoch(addDays(today, 1 - count), timeZone);
  const end = toEpoch(addDays(today, 1), timeZone);
  return at => at >= start && at < end;
}

function parseJson(text) {
  try { return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { return null; }
}

async function readJson(file) {
  try {
    return parseJson(await fs.promises.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
}

async function* readRows(stream) {
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line) continue;
      const row = parseJson(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) yield row;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function loadUsage(dataDir, options = {}) {
  if (!dataDir) return [];
  const inRange = dateRange(options);
  const rows = [];
  const files = [];
  try {
    // 内核同步轮转，先一起打开两份日志，避免流式读取期间把同一份日志读两次。
    for (const name of ['usage.1.jsonl', 'usage.jsonl']) {
      const file = path.join(dataDir, name);
      try {
        files.push({ file, fd: fs.openSync(file, 'r') });
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    while (files.length) {
      const { file, fd } = files.shift();
      for await (const row of readRows(fs.createReadStream(file, { fd, encoding: 'utf8' }))) {
        const at = timestamp(row.at, options.timeZone);
        if (inRange(at)) rows.push({ ...row, at });
      }
    }
  } finally {
    for (const { fd } of files) fs.closeSync(fd);
  }
  return rows;
}

function computeCost(row, pricingRow) {
  const at = timestamp(row?.at);
  return Number.isFinite(at) ? usagePricer(normalizePricing(pricingRow))(row, at).costCny : 0;
}

function dailyBuckets(rows = [], options = {}) {
  const inRange = dateRange(options);
  const price = usagePricer(normalizePricing(options.pricing));
  const buckets = new Map();
  for (const row of rows) {
    const at = timestamp(row?.at);
    if (!inRange(at)) continue;
    const day = dayKey(at, BEIJING);
    if (!buckets.has(day)) {
      buckets.set(day, { day, billedTokens: 0, prompt: 0, cached: 0, completion: 0, cost: 0, requests: 0 });
    }
    const bucket = buckets.get(day);
    const { prompt, cached, completion, costCny } = price(row, at);
    bucket.billedTokens += prompt + completion;
    bucket.prompt += prompt;
    bucket.cached += cached;
    bucket.completion += completion;
    bucket.cost += costCny;
    bucket.requests++;
  }
  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function nameOf(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

async function chatStats(dataDir, options = {}) {
  if (!dataDir) return [];
  const root = path.join(dataDir, 'memory', 'chats');
  let dirs;
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const inRange = dateRange(options);
  const chats = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const folder = path.join(root, dir.name);
    let chatId = '';
    let senderName = '';
    let senderAt = -Infinity;
    let theirs = 0;
    let mine = 0;
    let chars = 0;
    let mineChars = 0;
    let lastAt = -Infinity;
    const stream = fs.createReadStream(path.join(folder, 'messages.jsonl'), { encoding: 'utf8' });
    for await (const row of readRows(stream)) {
      const at = timestamp(row.ts ?? row.at);
      if (!Number.isFinite(at) || (row.role !== 'user' && row.role !== 'assistant')) continue;
      chatId ||= nameOf(row.chatId);
      if (row.role === 'user' && at >= senderAt) {
        const name = nameOf(row.senderName, row.name);
        if (name) {
          senderName = name;
          senderAt = at;
        }
      }
      if (!inRange(at)) continue;
      const length = typeof row.text === 'string' ? [...row.text].length : 0;
      chars += length;
      lastAt = Math.max(lastAt, at);
      if (row.role === 'assistant') {
        mine++;
        mineChars += length;
      } else {
        theirs++;
      }
    }
    const messages = mine + theirs;
    if (!messages) continue;
    const manifest = await readJson(path.join(folder, 'manifest.json'));
    const meta = await readJson(path.join(folder, 'meta.json'));
    chatId = nameOf(manifest?.chatId, meta?.chatId, chatId, dir.name);
    const name = nameOf(manifest?.name, manifest?.title, meta?.title, senderName, chatId.slice(0, 8));
    const chat = { chatId, name, messages, mine, theirs, avgLen: chars / messages, lastAt };
    Object.defineProperty(chat, replyChars, { value: mineChars });
    chats.push(chat);
  }
  return chats.sort((a, b) => b.lastAt - a.lastAt || a.chatId.localeCompare(b.chatId));
}

function hourlyHeatmap(rows = [], options = {}) {
  const inRange = dateRange(options);
  const counts = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const row of rows) {
    const at = timestamp(row?.at);
    if (!inRange(at)) continue;
    const { year, month, day, hour } = parts(at, BEIJING);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    counts[(weekday + 6) % 7][hour]++;
  }
  return counts;
}

function kpi(rows = [], chats = [], options = {}) {
  const daily = dailyBuckets(rows, options);
  let requests = 0;
  let billedTokens = 0;
  let cost = 0;
  let prompt = 0;
  let cached = 0;
  for (const bucket of daily) {
    requests += bucket.requests;
    billedTokens += bucket.billedTokens;
    cost += bucket.cost;
    prompt += bucket.prompt;
    cached += bucket.cached;
  }
  let messages = 0;
  let replies = 0;
  let chars = 0;
  for (const chat of chats) {
    messages += chat.messages;
    replies += chat.mine;
    chars += chat[replyChars] ?? 0;
  }
  return {
    requests, billedTokens, cost, cacheHitRate: prompt ? cached / prompt : 0,
    messages, replies, avgReplyLen: replies ? chars / replies : 0, activeDays: daily.length,
  };
}

function loadPricing(dataDir) {
  return readJson(path.join(dataDir, 'pricing.json'));
}

module.exports = {
  loadUsage, dailyBuckets, computeCost, chatStats, hourlyHeatmap, kpi, loadPricing,
  nameOf, readJson, readRows, timestamp,
};
