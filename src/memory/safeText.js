// safe-text.js —— 截断不产生「孤立代理项」（lone surrogate）。自 surfcore 移植（CJS）。
// 见 src/safe-text.js 原注释：text.slice(0,n) 按 UTF-16 单元截断，可能劈开 emoji/生僻字的代理对，
// 拼进提示词后模型 API 序列化请求体非法 → 400。sliceHead/clipText 治本，wellFormed/deepWellFormed 治标。

const HIGH = (c) => c >= 0xD800 && c <= 0xDBFF;
const LOW = (c) => c >= 0xDC00 && c <= 0xDFFF;

function sliceHead(text, max) {
  const s = String(text ?? '');
  const n = Math.max(0, Math.floor(Number(max) || 0));
  if (s.length <= n) return s;
  let cut = n;
  if (cut > 0 && HIGH(s.charCodeAt(cut - 1))) cut -= 1;
  return s.slice(0, cut);
}

function clipText(text, max = 120, { keepNewlines = false } = {}) {
  const raw = String(text ?? '');
  const s = (keepNewlines ? raw.replace(/\r\n/g, '\n') : raw.replace(/\s+/g, ' ')).trim();
  return s.length > max ? `${sliceHead(s, Math.max(1, max - 1))}…` : s;
}

function wellFormed(text) {
  const s = String(text ?? '');
  if (typeof s.toWellFormed === 'function') return s.toWellFormed();
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (HIGH(c) && LOW(s.charCodeAt(i + 1))) { out += s[i] + s[i + 1]; i += 1; }
    else if (HIGH(c) || LOW(c)) out += '�';
    else out += s[i];
  }
  return out;
}

function isWellFormed(text) {
  const s = String(text ?? '');
  return typeof s.isWellFormed === 'function' ? s.isWellFormed() : wellFormed(s) === s;
}

function deepWellFormed(value, depth = 0) {
  if (typeof value === 'string') return wellFormed(value);
  if (value === null || typeof value !== 'object' || depth > 32) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const fixed = deepWellFormed(item, depth + 1);
      if (fixed !== item) changed = true;
      return fixed;
    });
    return changed ? next : value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  let changed = false;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    const fixed = deepWellFormed(item, depth + 1);
    if (fixed !== item) changed = true;
    next[key] = fixed;
  }
  return changed ? next : value;
}

module.exports = { sliceHead, clipText, wellFormed, isWellFormed, deepWellFormed };
