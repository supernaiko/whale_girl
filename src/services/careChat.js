'use strict';

const fs = require('node:fs');
const path = require('node:path');
const care = require('./care');
const time = require('../infra/time');
const { describeError } = require('../infra/errors');
const { hotSearch } = require('./weiboPosts');

/** 微博 cookie：先看配置，再看 data/weibo.cookie 文件；都没有就返回空（搭话降级）。 */
function weiboCookie(runtime) {
  try {
    if (runtime.config?.moments?.weiboCookie) return String(runtime.config.moments.weiboCookie);
    const dataDir = runtime.config?.paths?.dataDir;
    if (dataDir) {
      const file = path.join(dataDir, 'weibo.cookie');
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * 主动搭话的内容：问她一句「在干啥 / 累不累」。
 * 演示模式（没 Key）直接用内置台词，省得等模型；有 Key 就带着最近聊天生成，避免每次同一句。
 */
async function careForChat(runtime, chatId) {
  const personaCfg = runtime.config.persona || {};
  const name = String(personaCfg.ownerName || '主人');
  const hour = time.hourOfDay(Date.now(), time.resolveTimeZone(runtime.config));
  let recent = [];
  if (chatId) {
    // 会话 key 可能是私聊（wechat:u:<id>）也可能是群（wechat:g:<id>），两边都试
    for (const key of [`wechat:u:${chatId}`, `wechat:g:${chatId}`, chatId]) {
      try {
        const msgs = runtime.store.messages(key, 12) || [];
        if (msgs.length) {
          recent = msgs
            .filter((m) => m && m.text)
            .map((m) => `${m.role === 'user' ? '对方' : (personaCfg.name || '我')}：${String(m.text).slice(0, 60)}`);
          break;
        }
      } catch {
        recent = [];
      }
    }
  }
  // 对方刚说了要去睡 / 我已经主动过一轮还没回，就先别开口。
  const lastLine = recent.length ? recent[recent.length - 1] : '';
  const lastIsMe = lastLine.startsWith((personaCfg.name || '我') + '：');
  const saidGoodNight = /(去睡了|先睡了|睡了|晚安|困了|不聊了|眯一会儿)/.test(lastLine);
  if (lastIsMe || saidGoodNight) {
    return { ok: true, text: '', skip: lastIsMe ? 'no_reply_yet' : 'said_goodnight', mock: false, hour };
  }
  if (runtime.llm.isMock) {
    return { ok: true, text: care.pickTemplate(), mock: true, hour };
  }
  try {
    let topics = [];
    try {
      const cookie = weiboCookie(runtime);
      if (cookie) topics = await hotSearch({ cookie, limit: 12 });
    } catch { topics = []; }
    const { system, user } = care.buildCarePrompt({ persona: personaCfg, recent, name, hour, topics });
    const raw = await runtime.llm.complete({ system, turns: [{ role: 'user', content: user }] });
    const text = care.cleanCareText(raw) || care.pickTemplate();
    return { ok: true, text, mock: false, hour };
  } catch (err) {
    runtime.logger.warn('搭话模型失败，用内置台词：' + describeError(err));
    return { ok: true, text: care.pickTemplate(), mock: true, fallback: true, hour };
  }
}

module.exports = { careForChat };
