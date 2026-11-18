'use strict';

const time = require('../infra/time');
const HOUR = 3600000;

function numberOr(value, fallback, valid) {
  const n = Number(value);
  return value !== undefined && value !== null && value !== '' && Number.isFinite(n) && valid(n) ? n : fallback;
}

function scheduleSettings(cfg = {}) {
  const start = time.parseClock(cfg.activeStart) ?? 480;
  const end = time.parseClock(cfg.activeEnd, { allow24: true }) ?? 1410;
  return {
    // 旧间隔只供旧客户端读写；每小时抽样与发表冷却分别计时。
    intervalHours: numberOr(cfg.intervalHours ?? cfg.publishIntervalHours ?? cfg.interval, 6, n => n > 0),
    maxPerDay: numberOr(cfg.maxPerDay ?? cfg.publishMaxPerDay, 2, n => Number.isSafeInteger(n) && n >= 0),
    activeStart: time.formatClock(start === end ? 480 : start),
    activeEnd: time.formatClock(start === end ? 1410 : end),
    minGapHours: numberOr(cfg.minGapHours, 3, n => n > 0),
    attemptProbability: numberOr(cfg.attemptProbability, 0.25, n => n >= 0 && n <= 1),
    muteDate: /^\d{4}-\d{2}-\d{2}$/.test(cfg.muteDate || '') ? cfg.muteDate : '',
    timezone: time.isValidTimeZone(cfg.timezone) ? cfg.timezone : '',
  };
}

function eligibility(now, state = {}, cfg = {}) {
  const settings = scheduleSettings(cfg);
  const tz = settings.timezone;
  const today = time.dayKey(now, tz);
  const todayCount = state.day === today ? Math.max(0, Number(state.count) || 0) : 0;
  const window = time.parseWindow(settings.activeStart + '-' + settings.activeEnd);
  const active = time.inWindows(time.minutesOfDay(now, tz), [window]);
  const muted = settings.muteDate === today;
  const full = settings.maxPerDay > 0 && todayCount >= settings.maxPerDay;
  const last = Number(state.lastPublishAt);
  const gapEnd = Number.isFinite(last) && last > 0 ? last + settings.minGapHours * HOUR : 0;
  const reason = muted ? 'muted' : full ? 'daily_limit' : !active ? 'inactive_hours' : now < gapEnd ? 'min_gap' : 'ready';
  let next = Math.max(Number(now), gapEnd);
  if ((muted || full) && time.dayKey(next, tz) === today) next = time.nextDayStart(now, tz);
  if (!time.inWindows(time.minutesOfDay(next, tz), [window])) {
    const p = time.parts(next, tz);
    const start = time.toEpoch({ ...p, hour: Math.floor(window.start / 60), minute: window.start % 60, second: 0 }, tz);
    next = start >= next ? start : time.toEpoch({ ...time.addDays(p, 1),
      hour: Math.floor(window.start / 60), minute: window.start % 60, second: 0 }, tz);
  }
  return { eligible: reason === 'ready', reason, nextEligibleAt: next, todayCount };
}

function eligibleNow(now, state, cfg) {
  return eligibility(now, state, cfg).eligible;
}

module.exports = { scheduleSettings, eligibility, eligibleNow };
