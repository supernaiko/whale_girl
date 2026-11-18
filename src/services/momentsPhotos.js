'use strict';

// 给朋友圈配一张「像人随手拍的生活照」：先百度图片（中文生活场景更贴），再退必应。
// 关键：优先选带相机 EXIF 的照片和社区/微博的图，避开图库站样图；拿不到就在预算内退到可用图。
// 失败返回空串，调用方回退到自带贴纸，不影响发表主流程。

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
const MIN_BYTES = 20 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SIDE = 4096;
// 图库站的样图带大水印/编号条，发到朋友圈一眼假；直接按域名排掉。
const STOCK_HOSTS = /(^|\.)(nipic|nximg|58pic|zcool|veer|shutterstock|dreamstime|alamy|123rf|gettyimages|istockphoto|depositphotos|pngtree|lovepik|tukuppt|photophoto|588ku|51miz|bigstockphoto|stock\.adobe)\b/i;
// 用户自己拍的图多在这些站，同等条件下优先。
// 只收微博图床的原图：知乎/豆瓣/什么值得买这些站的图常被压上站名水印，发朋友圈一眼假，直接不要。
const CLEAN_HOSTS = /(^|\.)(sinaimg\.cn|weibocdn\.com|sina\.com\.cn)$/i;
const BUDGET_MS = 20000;
const ILLUST_TITLE = /插画|二次元|动漫|漫画|壁纸|头像|表情包|手绘|同人|Q版|画师|原画|线稿|立绘|壁纸图|卡通|动画/i;
const STOCK_TITLE = /昵图|摄图|千库|包图|素材|模板|矢量|水印|图库|汇图|六图|摄影图|高清图|图片下载|正版图|商用图|png格式|psd|ai格式|海报|banner/i;

function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }
    const marker = buf[offset + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// 手机/相机拍的 JPEG 一般带 Exif 的 Make/Model；图库站导出的成品图基本被抹掉。
// 这是区分「真·随手拍」和「棚拍素材」最稳的信号。
function exifCamera(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return false;
  let offset = 2;
  while (offset + 10 < buf.length) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }
    const marker = buf[offset + 1];
    if (marker === 0xda || marker === 0xd9) return false;
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return false;
    if (marker === 0xe1 && buf.toString('latin1', offset + 4, offset + 8) === 'Exif') {
      try { return tiffHasCamera(buf, offset + 10); } catch { return false; }
    }
    offset += 2 + length;
  }
  return false;
}

function tiffHasCamera(buf, base) {
  const head = buf.toString('latin1', base, base + 2);
  if (head !== 'II' && head !== 'MM') return false;
  const little = head === 'II';
  const r16 = o => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const r32 = o => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (r16(base + 2) !== 42) return false;
  const ifd = base + r32(base + 4);
  if (ifd <= base || ifd + 2 > buf.length) return false;
  const count = r16(ifd);
  if (count > 200) return false;
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > buf.length) return false;
    const tag = r16(entry);
    if (tag !== 0x010f && tag !== 0x0110) continue;
    const len = Math.min(r32(entry + 4), 40);
    const value = buf.toString('latin1', base + r32(entry + 8), base + r32(entry + 8) + len);
    if (/[A-Za-z\u4e00-\u9fa5]{2,}/.test(value.replace(/\0.*$/, '').trim())) return true;
  }
  return false;
}

function photoSize(buf) {
  const size = jpegSize(buf) || pngSize(buf);
  if (!size || !size.width || !size.height) return null;
  if (size.width > MAX_SIDE || size.height > MAX_SIDE) return null;
  if (size.width < 400 || size.height < 300) return null;
  // 朋友圈按方形裁切，太宽或太高的图会裁掉主体。
  const ratio = size.width / size.height;
  if (ratio < 0.6 || ratio > 1.8) return null;
  return size;
}

async function withTimeout(fn, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fn(controller.signal); } finally { clearTimeout(timer); }
}

function bigrams(text) {
  const q = String(text).replace(/[\s\u3000]+/g, '');
  return q.length < 2 ? [] : Array.from({ length: q.length - 1 }, (_, i) => q.slice(i, i + 2));
}

async function baiduSearch(query, fetchImpl = fetch, ms = 6000) {
  const url = 'https://image.baidu.com/search/acjson?tn=resultjson_com&logid=1&ipn=rj&ct=201326592&fp=result&word='
    + encodeURIComponent(query) + '&pn=0&rn=20';
  let body = '';
  try {
    body = await withTimeout(async signal => {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': UA, referer: 'https://image.baidu.com/' }, signal,
      });
      return res.ok ? res.text() : '';
    }, ms);
  } catch { return []; }
  let json;
  try { json = JSON.parse(body.replace(/\\'/g, "'")); } catch { return []; }
  // 中文标题很少整词命中，用二字切片做相关度；一个都不沾的（比如搜猫给出动画海报）直接丢。
  const tokens = bigrams(query);
  const scored = [];
  for (const item of json.data || []) {
    const link = item && (item.middleURL || item.thumbURL);
    if (!link || !/^https?:\/\/[^/]*baidu\.com\//.test(link)) continue;
    const title = String(item.fromPageTitleEnc || item.fromPageTitle || '');
    if (STOCK_TITLE.test(title) || ILLUST_TITLE.test(title)) continue;
    const hits = tokens.filter(t => title.includes(t)).length;
    if (tokens.length && hits === 0) continue;
    scored.push({ link, title, hits, bonus: 0 });
  }
  scored.sort((a, b) => (b.hits + b.bonus) - (a.hits + a.bonus));
  const urls = [];
  for (const item of scored) {
    if (!urls.includes(item.link)) urls.push(item.link);
    if (urls.length >= 8) break;
  }
  return urls;
}

function unescapeHtml(text) {
  return text.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function bingCandidates(html) {
  // 必应把每条结果塞在 m="{...}" 里，带标题（t）和原图地址（murl）。
  const found = [];
  const pattern = /m="(\{[^"]*?\})"/g;
  let match;
  while ((match = pattern.exec(html))) {
    let item;
    try { item = JSON.parse(unescapeHtml(match[1])); } catch { continue; }
    const url = String(item.murl || '');
    if (!/\.(jpe?g|png)(\?|$)/i.test(url) || found.some(x => x.url === url)) continue;
    const title = String(item.t || item.desc || '');
    if (STOCK_TITLE.test(title) || ILLUST_TITLE.test(title)) continue;
    let host = '';
    try { host = new URL(url).hostname; } catch { continue; }
    if (STOCK_HOSTS.test(host)) continue;
    found.push({ url, title, host });
    if (found.length >= 10) break;
  }
  return found;
}

function rankByTitle(items, query) {
  const q = String(query).replace(/[\s\u3000]+/g, '');
  const tokens = bigrams(query);
  // 主体名词一般在词尾（「电动车上的橘猫」→ 橘猫）。标题连这两个字都没有，
  // 十有八九是「搜猫给电动车」这种跑偏图，宁可不配图也不要用错图。
  const head = q.slice(-2);
  const scored = items.map(item => ({ ...item, hits: tokens.filter(t => item.title.includes(t)).length }))
    .filter(item => item.title.includes(head));
  const pool = scored;
  const bonus = item => (CLEAN_HOSTS.test(item.host || '') ? 1 : 0);
  return pool.sort((a, b) => (b.hits + bonus(b)) - (a.hits + bonus(a)));
}

async function bingSearch(query, fetchImpl = fetch, ms = 6000) {
  const url = 'https://cn.bing.com/images/search?q=' + encodeURIComponent(query)
    + '&form=HDRSC2&first=1&mkt=zh-CN';
  try {
    return await withTimeout(async signal => {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }, signal,
      });
      if (!res.ok) return [];
      return rankByTitle(bingCandidates(await res.text()), query).slice(0, 8).map(item => item.url);
    }, ms);
  } catch { return []; }
}

async function download(url, { fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  try {
    return await withTimeout(async signal => {
      const res = await fetchImpl(url, { headers: { 'user-agent': UA, referer: 'https://image.baidu.com/' }, signal });
      if (!res.ok) return null;
      const type = String(res.headers.get('content-type') || '').toLowerCase();
      if (!/image\/(jpe?g|png)/.test(type) && !/\.(jpe?g|png)/i.test(url)) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < MIN_BYTES || buf.length > MAX_BYTES) return null;
      const size = photoSize(buf);
      if (!size) return null;
      return { buf, ext: pngSize(buf) ? '.png' : '.jpg', camera: exifCamera(buf), size };
    }, timeoutMs);
  } catch { return null; }
}

// 底边水印（微博/知乎角标、素材站编号）靠 PIL 切掉一截；没有 Python 环境就原样保存。
function stripWatermark(file) {
  const python = path.resolve(__dirname, '../../runtime/python/python.exe');
  const script = path.resolve(__dirname, 'photo_clean.py');
  if (!fs.existsSync(python) || !fs.existsSync(script)) return file.buf;
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-photo-'));
    const input = path.join(dir, 'in' + file.ext);
    const output = path.join(dir, 'out.jpg');
    fs.writeFileSync(input, file.buf);
    const res = spawnSync(python, [script, input, output], { timeout: 20000, windowsHide: true });
    if (res.status !== 0 || !fs.existsSync(output)) return file.buf;
    const out = fs.readFileSync(output);
    return out.length > 10 * 1024 ? out : file.buf;
  } catch { return file.buf; } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

async function save(file, destDir) {
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const cleaned = stripWatermark(file);
    const name = createHash('sha1').update(cleaned).digest('hex').slice(0, 16) + '.jpg';
    const target = path.join(destDir, name);
    if (!fs.existsSync(target)) fs.writeFileSync(target, cleaned);
    return target;
  } catch { return ''; }
}

/**
 * 抓一张配图存到 destDir，返回文件绝对路径；失败返回 ''。
 * 真实感优先：微博图床（sinaimg）上的随手拍最像真人发的，优先拿；其次带相机 EXIF 的；
 * 最后退到任一张合格的图，保证朋友圈有图可发。
 */
async function fetchPhoto(query, destDir, options = {}) {
  const words = String(query || '').trim().replace(/[^\p{Script=Han}a-zA-Z0-9 ]/gu, '').slice(0, 40);
  if (!words || !destDir) return '';
  const deadline = Date.now() + (options.budgetMs || BUDGET_MS);
  const left = () => Math.max(1200, deadline - Date.now());
  const fetchImpl = options.fetchImpl || fetch;
  const short = [...new Set([words.slice(-4), words.slice(-3), words.slice(-2)].filter(x => x.length >= 2))];
  const plans = [
    { source: bingSearch, query: words + ' site:weibo.com' },
    { source: bingSearch, query: words + ' 随手拍' },
    { source: bingSearch, query: words },
    { source: baiduSearch, query: words },
    ...short.map(q => ({ source: bingSearch, query: q })),
  ];
  let realFallback = '';
  let anyFallback = '';
  for (const plan of plans) {
    if (Date.now() > deadline) break;
    let urls = [];
    try { urls = await plan.source(plan.query, fetchImpl, Math.min(left(), 6000)); } catch { continue; }
    for (const url of urls) {
      if (Date.now() > deadline) break;
      const file = await download(url, { fetchImpl, timeoutMs: Math.min(left(), 6000) });
      if (!file) continue;
      let host = '';
      try { host = new URL(url).hostname; } catch { host = ''; }
      const fromWeibo = CLEAN_HOSTS.test(host);
      // 不是微博原图的，一律不用：素材站水印、站名角标都从这儿挡掉。
      if (!fromWeibo) continue;
      if (fromWeibo) {
        const saved = await save(file, destDir);
        if (saved) return saved;
      }
      if (file.camera) {
        const saved = await save(file, destDir);
        if (saved) return saved;
      }
      if (!realFallback) realFallback = await save(file, destDir);
    }
  }
  return realFallback;
}

module.exports = { fetchPhoto, photoSize, exifCamera, baiduSearch, bingSearch, bingCandidates, download };
