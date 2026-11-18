'use strict';

// 鲸鲸日志台：只读地汇总鲸鲸内核日志、whale-ops 插件日志、Codex 每次运行记录。
// 不依赖任何 npm 包，起一个本地小服务，浏览器看。

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = 'C:/Users/1/AppData/Local/Programs/WhaleGirl';
const DATA = path.join(ROOT, 'data');
const PLUGIN_DATA = path.join(DATA, 'plugins', 'whale-ops.data');
const PORT = Number(process.env.WHALE_LOGS_PORT || 8899);

function latestRunDir() {
  const dir = path.join(DATA, 'logs');
  try {
    const runs = fs.readdirSync(dir).filter(name => name.startsWith('run-')).sort();
    return runs.length ? path.join(dir, runs[runs.length - 1]) : '';
  } catch { return ''; }
}

function readTail(file, maxBytes = 400 * 1024) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

function listCodexRuns() {
  const dir = path.join(PLUGIN_DATA, 'codex');
  try {
    return fs.readdirSync(dir)
      .filter(name => /^run-.*\.log$/.test(name))
      .map(name => {
        const full = path.join(dir, name);
        const stat = fs.statSync(full);
        return { name, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

function readAudit(limit = 80) {
  const file = path.join(PLUGIN_DATA, 'audit.jsonl');
  const text = readTail(file, 200 * 1024);
  return text.split(/\r?\n/).filter(Boolean).slice(-limit).map(line => {
    try { return JSON.parse(line); } catch { return { raw: line }; }
  });
}

function summary() {
  const run = latestRunDir();
  const codex = listCodexRuns();
  const audit = readAudit(40);
  const whaleInfo = run ? fs.statSync(path.join(run, 'whale.log')).mtimeMs : 0;
  return {
    run,
    whaleLogAge: whaleInfo ? Math.round((Date.now() - whaleInfo) / 1000) : null,
    codexRuns: codex.length,
    lastCodex: codex[0] ? { name: codex[0].name, mtime: codex[0].mtime } : null,
    audit: audit.filter(item => ['codex.start', 'codex.done', 'codex.confirm'].includes(item.action)),
  };
}

const PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>鲸鲸日志台</title>
<style>
:root{color-scheme:dark}
body{margin:0;font:14px/1.6 "Microsoft YaHei",system-ui;background:#12151b;color:#dfe6ef}
header{display:flex;gap:16px;align-items:center;padding:14px 20px;border-bottom:1px solid #232a35;background:#151a22;position:sticky;top:0}
h1{font-size:15px;margin:0;font-weight:600;color:#9fd0ff}
button{background:#1e2733;color:#cfe0f5;border:1px solid #2c3a4a;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:13px}
button:hover{background:#26333f}
nav{display:flex;gap:8px;padding:10px 20px;border-bottom:1px solid #232a35}
main{padding:16px 20px}
pre{margin:0;padding:12px;background:#0d1117;border:1px solid #222c38;border-radius:8px;overflow:auto;max-height:70vh;font:12.5px/1.55 Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.row{display:flex;gap:10px;align-items:center;margin:6px 0;color:#8fa3b8;font-size:12.5px}
.dot{width:8px;height:8px;border-radius:50%;background:#3ddc84}
.pill{background:#1b2430;border:1px solid #2a3644;border-radius:999px;padding:1px 9px;font-size:12px}
</style></head><body>
<header><h1>鲸鲸日志台</h1><div class="row" id="stat">读取中…</div><button onclick="load()">刷新</button><span class="pill">每 3 秒自动刷新</span></header>
<nav>
<button onclick="tab('overview')">总览</button>
<button onclick="tab('whale')">鲸鲸内核日志</button>
<button onclick="tab('codex')">Codex 运行</button>
<button onclick="tab('plugin')">插件记录</button>
</nav>
<main><pre id="view">…</pre></main>
<script>
let current='overview';
async function tab(name){current=name;await render();}
async function load(){await render();}
async function render(){
  try{
    if(current==='overview'){
      const s=await (await fetch('/api/summary')).json();
      document.getElementById('stat').innerHTML='<span class="dot"></span>运行目录 '+s.run.split(/[\\\\/]/).pop()
        +' · whale.log '+(s.whaleLogAge===null?'无':s.whaleLogAge+' 秒前更新')+' · Codex 记录 '+s.codexRuns+' 次';
      const lines=[];
      lines.push('最近的 Codex 任务：');
      (s.audit||[]).slice().reverse().forEach(item=>{
        const t=new Date(item.at||Date.now()).toLocaleTimeString('zh-CN',{hour12:false});
        lines.push('  '+t+'  '+item.action+'  '+(item.task||'')+(item.ok===false?'  [失败]':'')+(item.peer?'  ('+item.peer+')':''));
      });
      document.getElementById('view').textContent=lines.join('\\n')||'（还没有记录）';
      return;
    }
    const res=await fetch('/api/log?name='+current);
    const text=await res.text();
    document.getElementById('view').textContent=text||'（空）';
    const v=document.getElementById('view');v.scrollTop=v.scrollHeight;
  }catch(e){document.getElementById('view').textContent='连接日志服务失败：'+e;}
}
load();setInterval(load,3000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (url.pathname === '/api/summary') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(summary()));
    return;
  }
  if (url.pathname === '/api/log') {
    const name = url.searchParams.get('name') || 'whale';
    let text = '';
    if (name === 'whale') {
      const run = latestRunDir();
      if (run) text = readTail(path.join(run, 'whale.log'), 1200 * 1024);
    } else if (name === 'codex') {
      const run = listCodexRuns()[0];
      text = run ? readTail(path.join(PLUGIN_DATA, 'codex', run.name)) : '（还没有 Codex 运行记录）';
    } else if (name === 'plugin') {
      const audit = readAudit(200);
      text = audit.map(item => JSON.stringify(item)).join('\n');
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(text);
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('鲸鲸日志台: http://127.0.0.1:' + PORT);
});
