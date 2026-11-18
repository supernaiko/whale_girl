'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadPricing, loadUsage, nameOf, readJson, readRows, timestamp } = require('./aggregator');
const { normalizePricing, usagePricer } = require('./pricing');

async function list(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function jsonLines(file) {
  return readRows(fs.createReadStream(file, { encoding: 'utf8' }));
}

function bucketStart(at, bucket) {
  const date = new Date(at);
  return bucket === 'hour' ? date.setMinutes(0, 0, 0) : date.setHours(0, 0, 0, 0);
}

function addDays(at, days) {
  const date = new Date(at);
  return date.setDate(date.getDate() + days);
}

function byTime(a, b) { return a.t - b.t; }

async function loadMessages(dataDir, { sinceMs = -Infinity, untilMs = Infinity } = {}) {
  const root = path.join(dataDir, 'memory', 'chats');
  const messages = [];
  for (const dir of await list(root)) {
    if (!dir.isDirectory()) continue;
    const folder = path.join(root, dir.name);
    const start = messages.length;
    let savedId = '';
    let senderName = '';
    let senderAt = -Infinity;
    for await (const row of jsonLines(path.join(folder, 'messages.jsonl'))) {
      const at = timestamp(row.ts ?? row.at, '');
      if (!Number.isFinite(at) || (row.role !== 'user' && row.role !== 'assistant')) continue;
      const fromMe = row.role === 'assistant';
      savedId ||= nameOf(row.chatId);
      if (!fromMe && at >= senderAt) {
        const name = nameOf(row.name, row.senderName);
        if (name) {
          senderName = name;
          senderAt = at;
        }
      }
      if (at < sinceMs || at >= untilMs) continue;
      let len = 0;
      if (typeof row.text === 'string') {
        for (const char of row.text) len++;
      }
      messages.push({ at, fromMe, len });
    }
    if (messages.length === start) continue;
    const [manifest, meta] = await Promise.all([
      readJson(path.join(folder, 'manifest.json')),
      readJson(path.join(folder, 'meta.json')),
    ]);
    const chatId = nameOf(manifest?.chatId, meta?.chatId, savedId, dir.name);
    const chatName = nameOf(manifest?.name, manifest?.title, meta?.title, senderName, chatId.slice(0, 8));
    for (let i = start; i < messages.length; i++) {
      Object.assign(messages[i], { chatId, chatName });
    }
  }
  return messages;
}

function moodSeries(history, { since = -Infinity, bucket = 'day' } = {}) {
  const buckets = new Map();
  for (const { at, v, e } of history) {
    if (!(at >= since) || !Number.isFinite(v) || !Number.isFinite(e)) continue;
    const t = bucketStart(at, bucket);
    if (!buckets.has(t)) buckets.set(t, { t, v: 0, e: 0, n: 0 });
    const point = buckets.get(t);
    point.v += v;
    point.e += e;
    point.n++;
  }
  return [...buckets.values()].sort(byTime).map(({ t, v, e, n }) => ({ t, v: v / n, e: e / n, n }));
}

function eventTime(event) {
  const createdAt = timestamp(event.createdAt ?? event.at, '');
  if (Number.isFinite(createdAt)) return createdAt;
  return typeof event.date === 'string' ? timestamp(`${event.date}T00:00:00`, '') : NaN;
}

function memorySeries(messages, events, { since = -Infinity, bucket = 'day' } = {}) {
  const addedByTime = new Map();
  let total = 0;
  // 有聊天的时段即使没生成事件卡，也要画出新增 0 和当时的累计值。
  for (const { at } of messages) {
    if (at >= since) addedByTime.set(bucketStart(at, bucket), 0);
  }
  for (const event of events) {
    if (!event || event.deleted || event.superseded) continue;
    const at = eventTime(event);
    if (at < since) total++;
    if (!(at >= since)) continue;
    const t = bucketStart(at, bucket);
    addedByTime.set(t, (addedByTime.get(t) ?? 0) + 1);
  }
  if (total) {
    const t = bucketStart(since, bucket);
    if (!addedByTime.has(t)) addedByTime.set(t, 0);
  }
  return [...addedByTime.keys()].sort((a, b) => a - b).map(t => {
    const added = addedByTime.get(t);
    total += added;
    return { t, added, total };
  });
}

function chatSeries(messages, { since = -Infinity, bucket = 'day' } = {}) {
  const buckets = new Map();
  const pending = new Map();
  const ordered = messages.filter(message => message.at >= since).sort((a, b) => a.at - b.at);
  for (const { at, chatId, fromMe, len } of ordered) {
    const t = bucketStart(at, bucket);
    if (!buckets.has(t)) buckets.set(t, { t, messages: 0, mine: 0, theirs: 0, chars: 0, replies: 0 });
    const point = buckets.get(t);
    point.messages++;
    point.chars += len;
    // 每条来信算一轮。她的下一条消息只记给同一会话最近一条待回复的来信，
    // 回应跨桶时仍归到来信所在的桶，连续发送多条回复也只命中一次。
    if (fromMe) {
      point.mine++;
      const opening = pending.get(chatId);
      if (opening) opening.replies++;
      pending.delete(chatId);
    } else {
      point.theirs++;
      pending.set(chatId, point);
    }
  }
  return [...buckets.values()].sort(byTime).map(({ t, messages, mine, theirs, chars, replies }) => ({
    t, messages, mine, theirs, avgLen: chars / messages, replyRate: theirs ? replies / theirs : 0,
  }));
}

function bondSeries({ at, people = {}, snapshots = [] } = {}, { since = -Infinity, bucket = 'day' } = {}) {
  const historyByPerson = new Map();
  for (const snapshot of snapshots) {
    if (!(snapshot.at >= since)) continue;
    const t = bucketStart(snapshot.at, bucket);
    for (const [wxid, value] of Object.entries(snapshot.people || {})) {
      if (!Object.hasOwn(people, wxid) || !Number.isFinite(value?.closeness) || !Number.isFinite(value?.trust)) continue;
      if (!historyByPerson.has(wxid)) historyByPerson.set(wxid, new Map());
      const history = historyByPerson.get(wxid);
      if (!history.has(t) || history.get(t).at <= snapshot.at) {
        history.set(t, { at: snapshot.at, closeness: value.closeness, trust: value.trust });
      }
    }
  }
  let hasHistory = false;
  const rows = [];
  for (const [wxid, person] of Object.entries(people)) {
    if (!Number.isFinite(person?.closeness) || !Number.isFinite(person?.trust)) continue;
    const { name = '', closeness, trust, lastAt = 0, interactions = 0 } = person;
    const currentAt = at ?? (timestamp(lastAt, '') || 0);
    const series = [];
    const history = historyByPerson.get(wxid);
    for (const point of history?.values() || []) {
      if (point.at === currentAt) continue;
      series.push({ t: point.at, closeness: point.closeness, trust: point.trust });
    }
    hasHistory ||= series.length > 0;
    series.push({ t: currentAt, closeness, trust });
    rows.push({ wxid, name, closeness, trust, lastAt, interactions, series: series.sort(byTime) });
  }
  return { people: rows.sort((a, b) => b.closeness - a.closeness), note: hasHistory ? '' : '好感只有当前值' };
}

function heatmap(messages, { since = -Infinity } = {}) {
  const rows = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const { at } of messages) {
    if (!(at >= since)) continue;
    const date = new Date(at);
    const row = rows[(date.getDay() + 6) % 7];
    max = Math.max(max, ++row[date.getHours()]);
  }
  return { rows, max };
}

function todayMessages(messages, now) {
  const start = bucketStart(now, 'day');
  const end = addDays(start, 1);
  return messages.reduce((count, { at }) => count + (at >= start && at < end ? 1 : 0), 0);
}

function extremes(history, now, events = []) {
  const start = bucketStart(now, 'day');
  let high;
  let low;
  for (const point of history) {
    if (!(point.at >= start && point.at <= now) || !Number.isFinite(point.v)) continue;
    if (!high || point.v > high.v) high = point;
    if (!low || point.v < low.v) low = point;
  }
  function withReason(point) {
    if (!point) return null;
    let why = nameOf(point.why);
    if (!why) {
      let latest = -Infinity;
      for (const event of events) {
        if (!event || event.deleted || event.superseded) continue;
        const at = eventTime(event);
        if (!(at > latest && at <= point.at)) continue;
        const reason = nameOf(event.why, event.title);
        if (reason) {
          latest = at;
          why = reason;
        }
      }
    }
    return { t: point.at, v: point.v, why };
  }
  return { high: withReason(high), low: withReason(low) };
}

async function loadEvents(dataDir, until) {
  const memory = path.join(dataDir, 'memory');
  const chats = path.join(memory, 'chats');
  const dirs = [path.join(memory, 'people')];
  // 现行人物卡跟随会话存放，同时读仍保存在顶层 people 的旧数据。
  for (const dir of await list(chats)) {
    if (dir.isDirectory()) dirs.push(path.join(chats, dir.name, 'people'));
  }
  const events = [];
  for (const dir of dirs) {
    for (const file of await list(dir)) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue;
      const card = await readJson(path.join(dir, file.name));
      if (!Array.isArray(card?.events)) continue;
      for (const event of card.events) {
        if (event && eventTime(event) < until) events.push(event);
      }
    }
  }
  return events;
}

async function loadHistory(file, since, until) {
  const history = [];
  for await (const row of jsonLines(file)) {
    const at = timestamp(row.at, '');
    if (at >= since && at < until) history.push({ ...row, at });
  }
  return history;
}

async function loadSeries(dataDir, { days, bucket, now }) {
  const midnight = bucketStart(now, 'day');
  const since = addDays(midnight, 1 - days);
  const until = addDays(midnight, 1);
  const dir = path.join(dataDir, 'plugins', 'yxn-bond.data');
  const [messages, events, moodHistory, bond, snapshots, usage, pricing] = await Promise.all([
    loadMessages(dataDir, { sinceMs: since, untilMs: until }),
    loadEvents(dataDir, until),
    loadHistory(path.join(dir, 'mood-history.jsonl'), since, until),
    readJson(path.join(dir, 'bond.json')),
    // 插件目前只写当前值；若有按 { at, people } 存放的历史快照，也可直接展示。
    loadHistory(path.join(dir, 'bond-history.jsonl'), since, until),
    loadUsage(dataDir, { days: 1, now, timeZone: '' }),
    loadPricing(dataDir),
  ]);
  const options = { since, bucket };
  const price = usagePricer(normalizePricing(pricing), '');
  const costCny = usage.reduce((sum, row) => sum + price(row, row.at).costCny, 0);
  const moodReasons = [{ at: bond?.mood?.updatedAt, why: bond?.mood?.why }, ...events];
  return {
    mood: moodSeries(moodHistory, options),
    memory: memorySeries(messages, events, options),
    chat: chatSeries(messages, options),
    // 当前点取读取时刻，最后一次联系时间单独保留，便于在任何窗口显示当前值。
    bond: bondSeries({ at: now, people: bond?.people || {}, snapshots }, options),
    heatmap: heatmap(messages, options),
    today: { messages: todayMessages(messages, now), requests: usage.length, costCny },
    extremes: extremes(moodHistory, now, moodReasons),
  };
}

module.exports = { loadMessages, moodSeries, memorySeries, chatSeries, bondSeries, heatmap, todayMessages, extremes, loadSeries };
