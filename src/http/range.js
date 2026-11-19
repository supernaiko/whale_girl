'use strict';

// 把 ?days= / ?from=&to= 统一成时间窗；日期按服务器本地时区解释（这台机器就是北京时间）。
const DAY = 24 * 60 * 60 * 1000;

function parseDay(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text || '')) return null;
  const date = new Date(text + 'T00:00:00');
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseRange(url, now = Date.now()) {
  const fromRaw = (url.searchParams.get('from') || '').trim();
  const toRaw = (url.searchParams.get('to') || '').trim();
  const daysRaw = (url.searchParams.get('days') || '').trim();
  const from = parseDay(fromRaw);
  const to = parseDay(toRaw);
  if (from && to && to >= from) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    const days = Math.min(366, Math.round((to.getTime() - from.getTime()) / DAY) + 1);
    return { days, start: from.getTime(), end: end.getTime(), from: fromRaw, to: toRaw, now: end.getTime() };
  }
  // 整数（含负号）都先夹到 1..365；非整数/乱写才是「非法」回默认 7。
  const days = /^-?\d+$/.test(daysRaw) ? Math.min(365, Math.max(1, Number(daysRaw))) : 7;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return {
    days,
    start: midnight.getTime() - (days - 1) * DAY,
    end: midnight.getTime() + DAY,
    from: '',
    to: '',
    now,
  };
}

module.exports = { parseRange, DAY };
