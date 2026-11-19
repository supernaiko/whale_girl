// 导出鲸鲸的聊天记录，供研究用。
// 用法: node export-chatlog.js [输出目录]   默认 C:\dev\whale-girl\app\data\chatlog-export
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const APP_DATA = 'C:/dev/whale-girl/app/data';
const CHATS_DIR = path.join(APP_DATA, 'memory', 'chats');
const OUT_ROOT = process.argv[2] || path.join(APP_DATA, 'chatlog-export');

function readJsonl(file) {
  const rows = [];
  if (!fs.existsSync(file)) return rows;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return rows;
}

function fmt(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function main() {
  const seen = new Set();
  const all = [];
  let sessions = 0;

  if (!fs.existsSync(CHATS_DIR)) {
    console.error('no memory/chats dir: ' + CHATS_DIR);
    process.exit(1);
  }

  for (const dir of fs.readdirSync(CHATS_DIR)) {
    const jsonl = path.join(CHATS_DIR, dir, 'messages.jsonl');
    if (!fs.existsSync(jsonl)) continue;
    const rows = readJsonl(jsonl);
    if (!rows.length) continue;
    sessions++;
    const metaPath = path.join(CHATS_DIR, dir, 'meta.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* ignore */ }
    for (const r of rows) {
      const key = r.msgId || (r.chatId + ':' + r.seq + ':' + r.ts);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({
        chatId: r.chatId || '',
        seq: r.seq ?? null,
        ts: r.ts ?? null,
        time: fmt(r.ts),
        role: r.role || '',
        name: r.name || '',
        uid: r.uid || '',
        text: String(r.text ?? ''),
        msgId: r.msgId || '',
        replyToUserId: r.replyToUserId || '',
        replyToName: r.replyToName || '',
        addressedToBot: !!r.addressedToBot,
        mentionedNames: Array.isArray(r.mentionedNames) ? r.mentionedNames : [],
        tokens: r.tokens ?? null,
        session: dir,
        sessionTitle: meta.title || meta.name || '',
      });
    }
  }

  all.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(OUT_ROOT, 'export-' + stamp);
  fs.mkdirSync(outDir, { recursive: true });

  // 1) 完整 jsonl（原始字段归一化）
  const jsonl = all.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'chatlog.jsonl'), jsonl, 'utf8');

  // 2) 完整 json（数组）
  fs.writeFileSync(path.join(outDir, 'chatlog.json'), JSON.stringify(all, null, 2), 'utf8');

  // 3) csv（utf-8 BOM，Excel 可直接打开）
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csvHeader = 'time,role,name,uid,text,msgId,replyToUserId,addressedToBot,mentionedNames,tokens,session,sessionTitle';
  const csvRows = all.map(r => [
    esc(r.time), esc(r.role), esc(r.name), esc(r.uid), esc(r.text), esc(r.msgId),
    esc(r.replyToUserId), r.addressedToBot ? 1 : 0, esc(r.mentionedNames.join('、')), r.tokens,
    esc(r.session), esc(r.sessionTitle),
  ].join(','));
  fs.writeFileSync(path.join(outDir, 'chatlog.csv'), '\uFEFF' + csvHeader + '\n' + csvRows.join('\n') + '\n', 'utf8');

  // 4) 人读版 txt
  const txt = all.map(r => `[${r.time}] ${r.name || r.role}：${r.text}`).join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'chatlog.txt'), txt, 'utf8');

  // 5) 索引/统计
  const byRole = {};
  for (const r of all) byRole[r.role] = (byRole[r.role] || 0) + 1;
  const byDay = {};
  for (const r of all) { const d = (r.time || '').slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; }
  const stats = {
    exportedAt: new Date().toISOString(),
    sessions,
    messages: all.length,
    byRole,
    byDay,
    timeRange: all.length ? { first: all[0].time, last: all[all.length - 1].time } : null,
  };
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(stats, null, 2), 'utf8');

  // 更新 latest 软链目录（写一个 latest.txt 指向最新）
  fs.writeFileSync(path.join(OUT_ROOT, 'latest.txt'), outDir, 'utf8');

  console.log('sessions=' + sessions);
  console.log('messages=' + all.length);
  console.log('byRole=' + JSON.stringify(byRole));
  console.log('timeRange=' + JSON.stringify(stats.timeRange));
  console.log('out=' + outDir);
  for (const f of fs.readdirSync(outDir)) {
    console.log('  ' + f + ' ' + fs.statSync(path.join(outDir, f)).size + 'B');
  }
}

main();
