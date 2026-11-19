// 从鲸鲸 jsonl 聊天流建 SQLite 检索库（node:sqlite，无需装依赖）。
// 用法: node build-chatdb.js [输出.db]   默认 C:\dev\whale-girl\app\data\chatlog.db
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const APP_DATA = 'C:/dev/whale-girl/app/data';
const CHATS_DIR = path.join(APP_DATA, 'memory', 'chats');
const DB_PATH = process.argv[2] || path.join(APP_DATA, 'chatlog.db');

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
  if (!fs.existsSync(CHATS_DIR)) { console.error('no memory/chats: ' + CHATS_DIR); process.exit(1); }
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (fs.existsSync(DB_PATH)) fs.rmSync(DB_PATH); // 全量重建（数据源是 jsonl，重建即最新）

  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE messages(
      id TEXT PRIMARY KEY, chatId TEXT, seq INTEGER, ts INTEGER, time TEXT,
      role TEXT, name TEXT, uid TEXT, text TEXT, msgId TEXT,
      replyToUserId TEXT, addressedToBot INTEGER, tokens INTEGER,
      session TEXT, sessionTitle TEXT
    );
    CREATE INDEX idx_ts ON messages(ts);
    CREATE INDEX idx_chat ON messages(chatId, ts);
    CREATE INDEX idx_role ON messages(role);
    CREATE VIRTUAL TABLE fts USING fts5(text, name, role, content='messages', content_rowid='rowid', tokenize='trigram');
  `);

  const ins = db.prepare(`
    INSERT INTO messages(id, chatId, seq, ts, time, role, name, uid, text, msgId,
      replyToUserId, addressedToBot, tokens, session, sessionTitle)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  const seen = new Set();
  let n = 0, sessions = 0;

  db.exec('BEGIN');
  for (const dir of fs.readdirSync(CHATS_DIR)) {
    const jsonl = path.join(CHATS_DIR, dir, 'messages.jsonl');
    if (!fs.existsSync(jsonl)) continue;
    const rows = readJsonl(jsonl);
    if (!rows.length) continue;
    sessions++;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, dir, 'meta.json'), 'utf8')); } catch { /* ignore */ }
    const title = meta.title || meta.name || '';
    for (const r of rows) {
      const id = r.msgId || (r.chatId + ':' + r.seq + ':' + r.ts);
      if (seen.has(id)) continue;
      seen.add(id);
      ins.run(
        id, r.chatId || '', r.seq ?? null, r.ts ?? null, fmt(r.ts), r.role || '',
        r.name || '', r.uid || '', String(r.text ?? ''), r.msgId || '',
        r.replyToUserId || '', r.addressedToBot ? 1 : 0, r.tokens ?? null, dir, title
      );
      n++;
    }
  }
  db.exec('COMMIT');

  // 全量灌 FTS（trigram 对 >=3 字有效；1~2 字需 LIKE 兜底）
  db.exec("INSERT INTO fts(rowid, text, name, role) SELECT rowid, text, name, role FROM messages;");

  const first = db.prepare('SELECT time, text FROM messages ORDER BY ts ASC LIMIT 1').get();
  const last = db.prepare('SELECT time, text FROM messages ORDER BY ts DESC LIMIT 1').get();
  const byRole = db.prepare('SELECT role, COUNT(*) c FROM messages GROUP BY role').all();

  console.log('db=' + DB_PATH);
  console.log('sessions=' + sessions + ' messages=' + n);
  console.log('byRole=' + JSON.stringify(byRole));
  console.log('first=' + JSON.stringify(first && first.time));
  console.log('last=' + JSON.stringify(last && last.time));

  // 冒烟：FTS 查一个 >=3 字词 + LIKE 查一个 2 字词
  const q1 = db.prepare("SELECT COUNT(*) c FROM fts WHERE fts MATCH '不想上班'").get();
  const q2 = db.prepare("SELECT COUNT(*) c FROM messages WHERE text LIKE '%好累%'").get();
  console.log('ftsMatch(不想上班)=' + q1.c + ' likeMatch(好累)=' + q2.c);
  db.close();
}

main();
