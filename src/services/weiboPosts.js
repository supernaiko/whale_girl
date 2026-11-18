// 从微博搜索页捞真实帖子（文案 + 配图），给朋友圈当素材。
// s.weibo.com 需要登录态才返回完整结果，cookie 存在 data/settings.json 的 moments.weiboCookie。
const https = require('node:https');
const agent = new https.Agent({ keepAlive: false });
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.0.0';

function get(url, { cookie = '', referer = 'https://s.weibo.com/', timeout = 15000, buffer = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: buffer ? 'image/avif,image/webp,image/*,*/*' : 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: referer,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      timeout,
      agent,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve({ status: res.statusCode, location: res.headers.location });
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: buffer ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[ \t\u3000]+/g, ' ').trim();
}

// 只保留正文里的相机图，头像和表情包都不要。
function pickImages(chunk) {
  const out = [];
  const re = /<img[^>]+src="([^"]+)"/g;
  let m;
  while ((m = re.exec(chunk))) {
    const src = m[1].startsWith('//') ? 'https:' + m[1] : m[1];
    if (!/^https:\/\/wx\d\.sinaimg\.cn\//.test(src)) continue;
    if (/avatar|tvax|tv[0-9]\.sinaimg/.test(src)) continue;
    if (/\/orj(360|480)\//.test(src)) continue;
    const large = src.replace(/\/(thumb\d*|mw690|bmiddle|small|square|orj\d+)\//, '/large/');
    if (!out.includes(large)) out.push(large);
  }
  return out;
}

function parseCards(html) {
  const posts = [];
  const parts = String(html).split('action-type="feed_list_item" mid="');
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const mid = (chunk.match(/^(\d+)/) || [])[1] || '';
    if (!mid) continue;
    const textMatch = chunk.match(/<p class="txt"[^>]*>([\s\S]*?)<\/p>/);
    let text = textMatch ? decodeEntities(textMatch[1]) : '';
    if (!text || text.includes('展开全文')) continue;
    if (/^(转发微博|分享图片|Repost)$/.test(text)) continue;
    const name = (chunk.match(/nick-name="?([^">]+)"?/) || [])[1] || '';
    const images = pickImages(chunk);
    posts.push({ mid, text, images, name: decodeEntities(name) });
  }
  return posts;
}

function acceptable(text) {
  if (text.length < 8 || text.length > 140) return false;
  if (/#[^#]{1,20}#/.test(text)) return false;
  if (/https?:\/\//.test(text)) return false;
  if (/抽奖|转发|优惠券|团购|代购|加微信|私信|报名|课程|招聘|广告|福利/.test(text)) return false;
  return true;
}

async function searchPosts(query, { cookie = '', page = 1, limit = 12 } = {}) {
  if (!query) return [];
  const url = 'https://s.weibo.com/weibo?q=' + encodeURIComponent(query) + '&page=' + page;
  const res = await get(url, { cookie });
  if (res.status !== 200 || !res.body) return [];
  return parseCards(res.body).filter(p => acceptable(p.text)).slice(0, limit);
}

// 微博图右下角常有 @用户名，切掉底边一截。
function stripMark(buf) {
  const python = path.resolve(__dirname, '../../runtime/python/python.exe');
  const script = path.resolve(__dirname, 'photo_clean.py');
  if (!fs.existsSync(python) || !fs.existsSync(script)) return buf;
  let dir = '';
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-weibo-'));
    const input = path.join(dir, 'in.jpg');
    const output = path.join(dir, 'out.jpg');
    fs.writeFileSync(input, buf);
    const res = spawnSync(python, [script, input, output], { timeout: 20000, windowsHide: true });
    if (res.status !== 0 || !fs.existsSync(output)) return buf;
    const out = fs.readFileSync(output);
    return out.length > 10 * 1024 ? out : buf;
  } catch { return buf; } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

async function download(url, destDir) {
  let res;
  for (let i = 0; i < 2; i++) {
    try { res = await get(url, { referer: 'https://weibo.com/', buffer: true, timeout: 12000 }); } catch { res = null; }
    if (res && res.status === 200 && Buffer.isBuffer(res.body) && res.body.length > 20000) break;
    res = null;
  }
  if (!res) return '';
  const buf = res.body;
  if (buf.length < 20000 || buf.length > 12 * 1024 * 1024) return '';
  if (!/^\xff\xd8/.test(buf.toString('latin1', 0, 2)) && buf.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') return '';
  fs.mkdirSync(destDir, { recursive: true });
  const cleaned = stripMark(buf);
  const file = path.join(destDir, crypto.createHash('sha1').update(cleaned).digest('hex').slice(0, 16) + '.jpg');
  if (!fs.existsSync(file)) fs.writeFileSync(file, cleaned);
  return file;
}

module.exports = { searchPosts, download, parseCards };
