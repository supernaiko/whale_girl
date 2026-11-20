'use strict';

/**
 * 百度网页搜索（HTML 抓取兜底）。
 *
 * 为什么要它：cn.bing.com 对高频抓取会返回「与查询无关的诱饵结果」，
 * 相关性过滤后往往一条不剩；so.com 桌面版频繁弹安全验证。
 * 百度结果页带 mu（真实落地 URL）属性，可直接取原链，不用跟跳转。
 */
const { getText, searchError } = require('./transport');
const { stripTags, decodeEntities, sourceUrl } = require('./html');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36';

function textOf(html) {
  return decodeEntities(stripTags(String(html || ''))).replace(/\s+/g, ' ').trim();
}

function parseBaidu(html) {
  const items = [];
  const blocks = String(html || '').split(/<div[^>]+class="[^"]*\bc-container\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const heading = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!heading) continue;
    const title = textOf(heading[1]);
    if (!title || /^扫码下载/.test(title)) continue;
    const mu = (block.match(/\bmu="([^"]+)"/) || [])[1];
    const url = sourceUrl(mu || (block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/) || [])[1], 'https://www.baidu.com');
    if (!url) continue;
    if (/(^|\.)baidu\.com$/i.test(new URL(url).hostname)) continue;
    const snippet = textOf((block.match(/<div[^>]+class="[^"]*(?:c-abstract|content-right|abstract)[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1]
      || (block.match(/<span[^>]+class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || [])[1]);
    if (title || snippet) items.push({ title, url, snippet });
    if (items.length >= 10) break;
  }
  return items;
}

async function search(query, opts = {}) {
  // 同一条 query 也放 q= 参数，便于诊断/测试脚本按统一键读取，不影响百度解析。
  const url = 'https://www.baidu.com/s?wd=' + encodeURIComponent(query) + '&q=' + encodeURIComponent(query) + '&ie=utf-8&rn=10';
  const html = await getText(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
  const items = parseBaidu(html);
  if (!items.length && /百度安全验证|请输入验证码|访问过于频繁/i.test(html)) throw searchError('blocked');
  if (!items.length && html.trim() && !/没有找到|很抱歉|未找到/i.test(stripTags(html))) throw searchError('parse_error');
  return items;
}

module.exports = { search, parseBaidu };
