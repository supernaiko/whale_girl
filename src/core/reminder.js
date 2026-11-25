'use strict';

/**
 * 提醒的纯逻辑：从一句人话里抽出「什么时候 + 提醒什么事」。
 *
 * 这里不碰存储、不碰网络，只做解析，方便单测。识别分两层：
 *   1. 规则（本文件）：准点、明天/后天、几分钟后、中文数字、上午/下午/晚上；
 *   2. 模型兜底（chat.js 里）：规则解析不出来时，让模型输出结构化结果。
 *
 * 设计原则：**宁可不识别，也不瞎猜时间**。解析失败就返回 null，当作普通聊天。
 */

const time = require('../infra/time');

const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const PERIOD = [
  { re: /(凌晨)/, hours: [0, 5] },
  { re: /(早上|早晨|清晨|上午)/, hours: [6, 11] },
  { re: /(中午|晌午)/, hours: [11, 13] },
  { re: /(下午|午后)/, hours: [13, 18] },
  { re: /(傍晚|黄昏)/, hours: [17, 19] },
  { re: /(晚上|夜里|今晚|明晚)/, hours: [18, 23] },
];

function cnToNumber(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '半') return 0.5;
  if (s === '一刻') return 0.25;
  if (s === '三刻') return 0.75;
  if (!/^[零一二两三四五六七八九十]+$/.test(s)) return null;
  if (s === '十') return 10;
  if (s.length === 1) return CN_NUM[s] ?? null;
  if (s.startsWith('十')) return 10 + (CN_NUM[s[1]] || 0);
  if (s.endsWith('十')) return (CN_NUM[s[0]] || 0) * 10;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    return (CN_NUM[a] || 0) * 10 + (CN_NUM[b] || 0);
  }
  return null;
}

/** 「3点半」「15:20」「晚上七点一刻」 → {hour, minute} */
function parseClockPhrase(text) {
  const s = String(text || '');
  // 24 小时制：15:20 / 15点20 / 15时20分
  let m = s.match(/(\d{1,2})\s*[:：点时]\s*(\d{1,2}|\d{1,2}分)/);
  if (!m) m = s.match(/(\d{1,2})\s*[:：点时]/);
  if (m && /[:：点时]/.test(m[0])) {
    const hour = Number(m[1]);
    let minute = 0;
    const rest = m[2] ? m[2].replace('分', '') : '';
    if (/^\d+$/.test(rest)) minute = Number(rest);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute, raw: m[0] };
  }
  // 中文数字：三点半 / 七点一刻 / 十点
  m = s.match(/([零一二两三四五六七八九十]{1,2})\s*[点时](半|一刻|三刻|[零一二两三四五六七八九十]{1,2}分?)?/);
  if (m) {
    const hour = cnToNumber(m[1]);
    let minute = 0;
    const rest = m[2] || '';
    if (rest === '半') minute = 30;
    else if (rest === '一刻') minute = 15;
    else if (rest === '三刻') minute = 45;
    else if (rest) {
      const n = cnToNumber(rest.replace('分', ''));
      if (n !== null) minute = n;
    }
    if (hour !== null && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute, raw: m[0] };
    }
  }
  return null;
}

function periodOf(text) {
  for (const p of PERIOD) if (p.re.test(String(text || ''))) return p.hours;
  return null;
}

/** 把小时按「上午/下午/晚上」修正：晚上八点 → 20 点；下午三点 → 15 点 */
function applyPeriod(hour, period) {
  if (!period) return hour;
  const [lo, hi] = period;
  if (hour === 12 && lo >= 13) return 12 + (hour - 12); // 下午12点 → 12
  if (hour >= lo && hour <= hi) return hour;
  if (hour < 12 && lo >= 12) return hour + 12;          // 下午3 → 15
  if (hour === 12) return 12;
  if (hour >= 13 && hi <= 12) return hour - 12;         // 凌晨13 → 1
  return hour;
}

const REL_RE = /([零一二两三四五六七八九十\d]{1,3})\s*(秒钟?|分钟|分|个?小时|钟头)\s*(?:之?后|以后)/;
const DAY_RE = /(大后天|后天|明天|明早|明晚|今天|今早|今晚|今儿|当天)/;
/** 周期提醒：每天 / 每周X / 工作日 */
const REPEAT_RE = /(每天|每日|天天|每(?:个)?(?:周|星期)([一二三四五六日天])|工作日)/;

/** 0=周日 … 6=周六 */
function weekdayOf(p) {
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay();
}

function repeatLabel(repeat) {
  if (!repeat) return '';
  if (repeat.kind === 'daily') return '每天';
  if (repeat.kind === 'weekdays') return '工作日';
  if (repeat.kind === 'weekly') {
    const names = ['日', '一', '二', '三', '四', '五', '六'];
    return `每周${names[Number(repeat.weekday) % 7]}`;
  }
  return '';
}

function dayOffset(word) {
  if (!word) return 0;
  if (word === '后天') return 2;
  if (word === '大后天') return 3;
  if (word === '明天' || word === '明早' || word === '明晚') return 1;
  return 0;
}

/**
 * 解析提醒时间。
 * @param {string} text 用户原话
 * @param {Date} now
 * @param {string} timeZone 统一的 IANA 时区；空串 = 系统时区
 * @returns {{at:Date, rest:string, matched:string}|null}
 */
function parseWhen(text, now = new Date(), timeZone = '') {
  const raw = String(text || '');
  if (!raw) return null;

  // ① 相对时间：30 分钟后 / 两个小时以后
  const rel = raw.match(REL_RE);
  if (rel) {
    const n = cnToNumber(rel[1]);
    if (n !== null && n > 0) {
      const unit = rel[2];
      const ms = /秒/.test(unit) ? n * 1000
        : /小时|钟头/.test(unit) ? n * 3600 * 1000
          : n * 60 * 1000;
      if (ms >= 1000 && ms <= 30 * 24 * 3600 * 1000) {
        return { at: new Date(now.getTime() + ms), rest: raw.replace(rel[0], ''), matched: rel[0] };
      }
    }
  }

  // ①b 倒计时：「计时一分钟」「倒计时 30 秒」「计个时，三分钟」= 从此刻起算相对时长
  const cd = raw.match(/(?:计时|倒计时|计个时)\s*([零一二两三四五六七八九十\d]{1,3})\s*(秒钟?|分钟|分|个?小时|钟头)/);
  if (cd) {
    const n = cnToNumber(cd[1]);
    if (n !== null && n > 0) {
      const unit = cd[2];
      const ms = /秒/.test(unit) ? n * 1000
        : /小时|钟头/.test(unit) ? n * 3600 * 1000
          : n * 60 * 1000;
      if (ms >= 1000 && ms <= 30 * 24 * 3600 * 1000) {
        const relative = /秒/.test(unit) ? `${n} 秒`
          : /小时|钟头/.test(unit) ? `${n} 小时` : `${n} 分钟`;
        return { at: new Date(now.getTime() + ms), rest: raw.replace(cd[0], ''), matched: cd[0], relative };
      }
    }
  }

  // ② 绝对时间：今天/明天/后天 + 几点几分
  const dayWord = (raw.match(DAY_RE) || [])[1] || '';
  const clock = parseClockPhrase(raw);
  if (!clock) return null;
  const period = periodOf(raw) || (/明晚|今晚|晚上/.test(dayWord) ? [18, 23] : null);
  let hour = applyPeriod(clock.hour, period);
  if (hour > 23 || hour < 0) return null;

  // ②b 周期提醒：每天 / 每周X / 工作日 + 几点（「每天11点提醒我学习」）
  const repeatHit = raw.match(REPEAT_RE);
  if (repeatHit) {
    const word = repeatHit[0];
    const p0 = time.parts(now.getTime(), timeZone);
    const stamp = (base) => time.toEpoch({ ...base, hour, minute: clock.minute, second: 0 }, timeZone);
    let at = stamp(p0);
    let repeat;
    if (/工作日/.test(word)) {
      repeat = { kind: 'weekdays' };
      for (let i = 0; i < 9; i += 1) {
        const cur = time.addDays(p0, i);
        const wd = weekdayOf(cur);
        if (wd >= 1 && wd <= 5 && stamp(cur) > now.getTime()) { at = stamp(cur); break; }
      }
    } else if (/每天|每日|天天/.test(word)) {
      repeat = { kind: 'daily' };
      if (at <= now.getTime()) at = stamp(time.addDays(p0, 1));
    } else {
      const idx = '一二三四五六日天'.indexOf(repeatHit[2]);
      const want = idx === 6 ? 0 : idx + 1;
      repeat = { kind: 'weekly', weekday: want };
      const delta = (want - weekdayOf(p0) + 7) % 7;
      at = stamp(time.addDays(p0, delta === 0 && at <= now.getTime() ? 7 : delta));
    }
    return {
      at: new Date(at),
      rest: raw.replace(word, '').replace(clock.raw, ''),
      matched: word + clock.raw,
      repeat,
    };
  }
  const offset = dayOffset(dayWord);
  const base = time.addDays(time.parts(now.getTime(), timeZone), offset);
  let at = time.toEpoch({ ...base, hour, minute: clock.minute, second: 0 }, timeZone);
  // 没说「明天」但那个点已经过了 → 顺延到明天（「八点提醒我」晚上说就是明早八点）
  if (!dayWord && at <= now.getTime()) {
    at = time.toEpoch({ ...time.addDays(base, 1), hour, minute: clock.minute, second: 0 }, timeZone);
  }
  if (at <= now.getTime()) {
    // 明确说了今天但已经过了 → 不猜，交给调用方当普通聊天
    return null;
  }
  return {
    at: new Date(at),
    rest: raw.replace(dayWord, '').replace(clock.raw, ''),
    matched: `${dayWord}${clock.raw}`,
  };
}

// 只认「明确在让她做事」的说法。
// 以前把「记得 / 到点 / 到时候」也算意图词，于是「我记得明天八点要开会」这种
// 自言自语被当成设提醒（用户实测踩到过）。现在必须出现 提醒我 / 叫我 / 别忘，
// 或者「计时 / 倒计时」（「帮我计时一分钟」= 一分钟后叫我）。
const INTENT_RE = /(提醒我|提醒一下|提醒下|叫我|别忘|计时|倒计时)/;
/** 「他叫我明天八点开会」是在转述，不是让她做提醒 */
const REPORTED_RE = /(他|她|你|您|朋友|同事|老板|老师|同学|我妈|我爸|家人|别人)\s*叫我/;
/** 像不像一个「设提醒」的请求（先粗筛，再解析时间） */
function looksLikeReminder(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 120) return false;
  if (!INTENT_RE.test(s)) return false;
  // 「提醒你」「提醒大家」是让别人，不是设提醒
  if (/提醒(你|您|大家|他|她|他们)/.test(s)) return false;
  if (REPORTED_RE.test(s)) return false;
  return true;
}

const TAIL_RE = /\s*(记得|哦|啊|呀|嘛|吧|谢谢|谢了|辛苦了)[。.!！~～]*\s*$/;

/** 把「时间 + 提醒我 + 事情」里的事情抽出来 */
function extractWhat(text) {
  let s = String(text || '').trim();

  // 倒计时：「计时一分钟」= 一分钟后叫我，没有别的事要提醒；
  // 「计时三分钟提醒我喝水」= 内容是「喝水」。
  const cd = /(?:计时|倒计时|计个时)/.exec(s);
  if (cd) {
    let after = s.slice(cd.index + cd[0].length);
    after = after.replace(/([零一二两三四五六七八九十\d]{1,3})\s*(秒钟?|分钟|分|个?小时|钟头)\s*(?:之?后|以后)?/, '');
    after = after.replace(/(?:提醒我|提醒一下|提醒下|叫我|别忘(?:记|了)?)[\s,，。.!！~～]*/g, '');
    after = after.replace(/^(一下|一声|一句)[\s,，。.!！~～]*/, '');
    after = after.replace(/^[\s,，:：。.!！~～、]+/, '').replace(TAIL_RE, '').replace(/[\s,，:：。.!！~～、]+$/, '');
    if (after.trim()) return after.trim().slice(0, 200);
    return '时间到了';
  }

  // 强意图词后面直接跟内容；「好来做个测试吧 20分钟后提醒我 开始学习」里的
  // 「好来做个测试吧」是寒暄/铺垫，不是要提醒的事 → 取「提醒我」之后的部分。
  // 注意「别忘了提醒我八点吃药」要认「提醒我」而不是前面的「别忘」。
  const strong = /提醒一下|提醒下|提醒我|叫我/.exec(s);
  const intent = strong || /别忘记|别忘了|别忘|提醒/.exec(s);
  if (intent) {
    let after = s.slice(intent.index + intent[0].length);
    after = after.replace(REL_RE, '').replace(DAY_RE, '').replace(REPEAT_RE, '');
    const clock = parseClockPhrase(after);
    if (clock) after = after.replace(clock.raw, '');
    after = after.replace(/(凌晨|早上|早晨|清晨|上午|中午|晌午|下午|午后|傍晚|黄昏|晚上|夜里|今晚|明晚)/g, '');
    after = after.replace(/^(一下|一声|一句|下)[\s,，。.!！~～]*/, '');
    after = after.replace(/^[\s,，:：。.!！~～、]+/, '').replace(TAIL_RE, '').replace(/[\s,，:：。.!！~～、]+$/, '');
    if (after.trim()) return after.trim().slice(0, 200);
  }

  // 意图词在句末（「明天开会提醒我」）：先去掉时间短语，剩下的就是内容。
  s = s.replace(REL_RE, '').replace(DAY_RE, '').replace(REPEAT_RE, '');
  const clock = parseClockPhrase(s);
  if (clock) s = s.replace(clock.raw, '');
  s = s.replace(/(凌晨|早上|早晨|清晨|上午|中午|晌午|下午|午后|傍晚|黄昏|晚上|夜里|今晚|明晚)/g, '');
  // 提醒意图词可能在句首，也可能跟在时间后面（「十点半提醒我开会」）
  s = s.replace(/帮我|请|麻烦|那个|然后/g, '');
  s = s.replace(/(提醒一下|提醒下|提醒我|提醒|叫我|别忘记|别忘了|别忘|记得|到点|到时候)/g, '');
  s = s.replace(/^(一下|一声|一句|下)[\s,，。.!！~～]*/, '');
  s = s.replace(/^[\s,，:：。.!！~～、]+/, '').replace(TAIL_RE, '').replace(/[\s,，:：。.!！~～、]+$/, '');
  return s.slice(0, 200);
}

/**
 * 完整解析：像提醒 + 有时间 + 有事可提醒，三者齐了才算数。
 * @returns {{at:Date, what:string, when:string}|null}
 */
function parseReminder(text, now = new Date(), timeZone = '') {
  if (!looksLikeReminder(text)) return null;
  const when = parseWhen(text, now, timeZone);
  if (!when) return null;
  const what = extractWhat(text);
  if (!what || what.length < 1) return null;
  return { at: when.at, what, when: when.matched || '', relative: when.relative || '', repeat: when.repeat || null };
}

/** 「今天 20:30」/「明天 08:00」这种人话 */
function describeWhen(at, now = new Date(), timeZone = '') {
  const d = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(d.getTime())) return '';
  const day = time.dayKey(d.getTime(), timeZone);
  const today = time.dayKey(now.getTime(), timeZone);
  // 用日历加一天，不要用 now + 24h：夏令时回拨那天是 25 小时，
  // +24h 可能还停在前一天，「明天」就会显示成具体日期。
  const tomorrow = time.dayKeyOf(time.addDays(time.parts(now.getTime(), timeZone), 1));
  const clock = time.formatClock(time.minutesOfDay(d.getTime(), timeZone));
  if (day === today) return `今天 ${clock}`;
  if (day === tomorrow) return `明天 ${clock}`;
  const p = time.parts(d.getTime(), timeZone);
  return `${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${clock}`;
}

/** 设好提醒之后的回执（不经过模型，保证时间和事情都对） */
function confirmText(parsed, { now = new Date(), group = false, who = '', timeZone = '' } = {}) {
  const { at, what, relative, repeat } = parsed;
  // 倒计时显示相对时长（「过 1 分钟 叫你」），不报绝对时钟
  if (relative) {
    const action = what === '时间到了' ? '叫你' : `提醒你${what}`;
    return `好，过 ${relative} ${action}。`;
  }
  // 周期提醒：直接说「每天 11:00 提醒你学习」
  if (repeat) {
    const clock = time.formatClock(time.minutesOfDay(at.getTime(), timeZone));
    const target = group && who ? `到点我会在群里 @${who}` : '到点我在这里提醒你';
    return `好，${repeatLabel(repeat)} ${clock} 提醒你${what}。${target}。`;
  }
  const when = describeWhen(at, now, timeZone);
  const target = group && who ? `到点我会在群里 @${who}` : '到点我在这里提醒你';
  return `好，${when} 提醒你${what}。${target}。`;
}

/** 提醒到点说的话：模板拼，不调模型（定时任务不花 API 钱） */
function spokenText(what) {
  const w = String(what || '').trim();
  if (!w || w === '时间到了') return '时间到啦～';
  return `到点啦，该${w}了～`;
}

/**
 * 从「每天11点提醒学习」这类话里抽出关键词，用来匹配已有提醒。
 * 去掉周期词、时间词和口水词，留下能对上内容的部分。
 */
function reminderKeys(text) {
  return String(text || '')
    .replace(REPEAT_RE, ' ')
    .replace(/[零一二两三四五六七八九十\d]{1,3}\s*(?:点|时|:|：)\s*[零一二两三四五六七八九十\d]{0,3}/g, ' ')
    .replace(/\d{1,2}:\d{2}/g, ' ')
    .replace(/(?:改成|改到|改为|换成|换到|推到|挪到)/g, ' ')
    .replace(/(?:取消|删除|清空|删掉|去掉|改|换|推|挪|成|到|为|把|将)/g, ' ')
    .replace(/(?:提醒|一下|一声|我|你|的|了|在|要|这条|那条|这个|那个)/g, ' ')
    .split(/[\s,，。.!！~～、]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

module.exports = {
  parseWhen,
  parseReminder,
  looksLikeReminder,
  describeWhen,
  confirmText,
  spokenText,
  repeatLabel,
  reminderKeys,
};
