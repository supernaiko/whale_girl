'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ACTION = '(?:聊聊天|聊天|搭话|聊聊|说句话|打个招呼|问好|聊一聊|说两句)';
const COMMAND_RE = new RegExp(
  `^(?:(?:去找|找|跟|和)\\s*(.{1,32}?)\\s*${ACTION}|(?:关心一下|问候一下)\\s*(.{1,32}?))$`, 'u',
);
const BLOCK_IDS = /^(?:gh_|(?:notifymessage|weixin|fmessage|medianote|floatbottle|filehelper|newsapp|weibo)$)/i;

function nameKey(value) {
  return String(value || '').trim().replace(/[.．·•・。\s]+$/u, '').toLowerCase();
}

function commandTarget(text) {
  const raw = String(text || '').trim().replace(/[。！!~～]+$/u, '');
  if (/[？?\r\n]/u.test(raw) || /怎么|为什么|是不是|要不要|能不能/u.test(raw)) return '';
  const match = COMMAND_RE.exec(raw);
  return nameKey(match?.[1] || match?.[2]);
}

function displayName(contact) {
  return String(contact?.remark || '').trim() || String(contact?.name || '').trim();
}

function findTarget(wanted, items) {
  if (!wanted || !Array.isArray(items)) return null;
  const people = items.filter(c => c && typeof c.wxid === 'string' && c.wxid.trim() &&
    !c.isGroup && !/@chatroom$/i.test(c.wxid) && !BLOCK_IDS.test(c.wxid) && displayName(c));
  const names = c => [nameKey(c.remark), nameKey(c.name)];
  const exact = people.filter(c => names(c).includes(wanted));
  const matches = exact.length ? exact : people.filter(c => names(c).some(name => name.includes(wanted)));
  // 同名时不能猜收件人。
  return matches.length === 1 ? matches[0] : null;
}

async function modelLine(whale, system, content, fallback) {
  let timer;
  try {
    const limit = new Promise(resolve => { timer = setTimeout(resolve, 4000); });
    const raw = await Promise.race([
      whale.model({ system, turns: [{ role: 'user', content }], maxTokens: 100, thinking: false }),
      limit,
    ]);
    if (typeof raw === 'string') {
      const line = raw.trim().split(/\r?\n/, 1)[0].replace(/^["“「]+|["”」]+$/g, '').trim();
      if (line && line.length <= 80 && !/[\x00-\x1f]/.test(line)) return line;
    }
  } catch { /* 模型不可用时仍可用一句普通关心话。 */ }
  finally { clearTimeout(timer); }
  return fallback;
}

async function handleNamedCare(ctx, whale) {
  const msg = ctx.message || {};
  if (msg.platform !== 'wechat' || msg.chatType !== 'private' || !msg.senderId) return;
  const wanted = commandTarget(msg.text);
  if (!wanted) return;
  try {
    const result = await whale.api('/api/config');
    const config = result?.body?.config;
    const owner = String(msg.senderId).trim();
    const ownerIds = config?.persona?.master?.wxids;
    if (!result?.ok || !/^wxid_[a-z0-9_-]+$/i.test(owner) || !Array.isArray(ownerIds) ||
        !ownerIds.some(id => {
          const key = String(id).trim().toLowerCase();
          return key === owner.toLowerCase() || key.replace(/_[0-9a-f]{4}$/, '') === owner.toLowerCase();
        })) return;

    const file = path.join(whale.paths.appData, 'contacts-cache.json');
    const cache = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const items = cache?.items;
    const target = findTarget(wanted, items);
    if (!target || target.wxid === cache.account || target.wxid === config.wechat?.account) return;

    const name = displayName(target);
    const persona = config.persona;
    const voice = [persona.name, persona.personality, persona.background, persona.customPrompt].filter(Boolean).join('\n');
    const text = await modelLine(whale,
      voice + '\n用当前人设的口吻写一句普通的微信关心话，只输出正文。不要提到委托或透露主人的信息。',
      '收件人的显示名是 ' + JSON.stringify(name), '今天过得怎么样呀？');
    const sent = await whale.sendText(target.wxid, text, { name, chatType: 'private' });
    if (sent?.status !== 'queued' || !sent.id) return;

    const fallback = `给主人报个信，给${name}的关心话已经排队啦。`;
    const receipt = await modelLine(whale,
      voice + '\n按当前人设写一句给主人看的回执。只输出正文，用入队或排队描述处理结果。',
      JSON.stringify({ target: name, text }), fallback);
    const safeReceipt = /入队|排队/.test(receipt) && !/送达|收到|发到了|发出去了/.test(receipt) ? receipt : fallback;
    const ownerName = displayName(items.find(contact => contact?.wxid === owner)) || owner;
    const queued = await whale.sendText(owner, safeReceipt, { name: ownerName, chatType: 'private' });
    if (queued?.status === 'queued' && queued.id) return { text: '' };
  } catch { /* 任何未完成的指令都交回宿主正常回复。 */ }
}

module.exports = {
  hooks: { 'chat.generate': ctx => handleNamedCare(ctx, ctx.whale) },
  commandTarget,
  findTarget,
};
