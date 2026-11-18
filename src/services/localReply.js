'use strict';

/**
 * 本地 llama.cpp 出话：调试页与插件共用。
 * 首选 llama-server 的 /v1/chat/completions（带 system、无编码坑、模型常驻）；
 * 没配 serverUrl 时退回 llama-cli 单次进程。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SYSTEM = '你是雅小奈，二十出头的女生，平时就用微信和朋友聊天。回话就像打字：一到两句，不超过20个字，口语、随意，别解释、别总结、别安慰式说教，不堆语气词。对方说什么就顺着接，可以损一句、也可以懒一下。';

const AI_WORDS = /\u6211\u7406\u89e3|\u5e0c\u671b\u8fd9\u4e9a\u80fd\u5e2e\u5230|\u4f5c\u4e3a\u4e00\u4e2a|\u6839\u636e\u4f60\u7684\u63cf\u8ff0|\u5efa\u8bae\u4f60|\u8981\u6ce8\u610f|\u603b\u4e4b|\u7efc\u4e0a\u6240\u8ff0|\u5e0c\u671b\u5bf9\u4f60\u6709\u5e2e\u52a9|能不能|感觉你|休息一下|好好休息/g;

function stripAiTone(text) {
  let t = String(text || '').trim();
  t = t.replace(/^[\u54ce\u5509\u55ef\u5662\u54c8\u597d\u7684\uff0c\s]+/, '');
  t = t.replace(/(\u5e0c\u671b\u8fd9\u4e9a\u80fd\u5e2e\u5230\u4f60|\u5e0c\u671b\u5bf9\u4f60\u6709\u5e2e\u52a9|\u4f60\u89c9\u5f97\u5462\uff1f?)$/g, '');
  t = t.replace(/[~\u301c\u3001]+$/g, '');
  return t.trim();
}

function freeMB() {
  try { return Math.floor(os.freemem() / (1024 * 1024)); } catch { return 0; }
}

function checkCfg(config) {
  const cfg = config || {};
  const free = freeMB();
  if (cfg.enabled !== true) return { error: '本地模型未启用', free };
  const need = Number(cfg.minFreeRamMB) || 512;
  if (free < need) return { error: `空闲内存 ${free}MB，低于门槛 ${need}MB`, free };
  return { free };
}

async function ensureServer(cfg) {
  const base = String(cfg.serverUrl || '').replace(/\/+$/, '');
  if (!base) return false;
  try {
    const res = await fetch(base + '/health', { signal: AbortSignal.timeout(1500) });
    if (res.ok) return true;
  } catch { /* not up */ }
  const server = String(cfg.serverExe || '').trim();
  const modelPath = String(cfg.modelPath || '').trim();
  if (!server || !modelPath || !fs.existsSync(server) || !fs.existsSync(modelPath)) return false;
  const port = new URL(base).port || '18080';
  try {
    const child = spawn(server, ['-m', modelPath, '-c', '2048', '-t', '4', '--host', '127.0.0.1', '--port', port],
      { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch { return false; }
  for (let i = 0; i < 40; i += 1) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch(base + '/health', { signal: AbortSignal.timeout(1200) });
      if (res.ok) return true;
    } catch { /* keep waiting */ }
  }
  return false;
}

async function viaServer({ base, text, instruction, cfg, timeoutMs }) {
  const messages = [
    { role: 'system', content: String(instruction || SYSTEM) },
    { role: 'user', content: String(text) },
  ];
  const res = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      max_tokens: Number(cfg.maxTokens) || 64,
      temperature: 0.85,
      top_p: 0.9,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('本地服务 HTTP ' + res.status);
  const data = await res.json();
  const reply = String(data?.choices?.[0]?.message?.content || '').trim().replace(/^["'「」]+|["'「」]+$/g, '');
  return reply.slice(0, 80);
}

function parseReply(raw, prompt) {
  const all = String(raw || '').split(/\r?\n/);
  const marks = all.map((line, i) => (line.includes('<|im_start|>assistant') ? i : -1)).filter(i => i >= 0);
  const tag = marks.length ? marks[marks.length - 1] : -1;
  let body = [];
  if (tag >= 0) {
    body = all.slice(tag + 1);
  } else {
    const marker = all.findIndex(line => line.trim().startsWith('> '));
    const skip = marker >= 0 ? Math.max(1, prompt.split('\n').length) : 0;
    body = all.slice(marker >= 0 ? marker + skip : 0);
  }
  const reply = body
    .map(line => line.replace(/<\|[^|]*\|>/g, '').trim())
    .filter(line => line && !line.startsWith('[ Prompt:') && !line.startsWith('Exiting') && !line.startsWith('> '))
    .join(' ')
    .replace(/\s*>\s*$/, '')
    .replace(/^["'「」]+|["'「」]+$/g, '')
    .trim();
  if (!reply || reply.length > 80) return '';
  if (/sorry|as an ai|无法|不能协助|不能提供/i.test(reply)) return '';
  return reply;
}

async function viaCli({ text, instruction, cfg, timeoutMs }) {
  const cmd = String(cfg.cmd || '').trim();
  const modelPath = String(cfg.modelPath || '').trim();
  const prompt = [
    '<|im_start|>system', String(instruction || SYSTEM), '<|im_end|>',
    '<|im_start|>user', String(text), '<|im_end|>',
    '<|im_start|>assistant', '',
  ].join('\n');
  const dir = path.join(os.tmpdir(), 'yxn-chat');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const promptFile = path.join(dir, 'dbg-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8) + '.txt');
  try {
    fs.writeFileSync(promptFile, prompt, 'utf8');
    const raw = await new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (value) => { if (!done) { done = true; resolve(value); } };
      let child;
      try {
        child = spawn(cmd, ['-m', modelPath, '-f', promptFile, '-n', String(Number(cfg.maxTokens) || 64), '-t', '4',
          '--no-display-prompt', '--no-warmup', '--no-jinja'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { finish(''); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(''); }, timeoutMs);
      child.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
      child.on('error', () => { clearTimeout(timer); finish(''); });
      child.on('close', () => { clearTimeout(timer); finish(out); });
    });
    return parseReply(raw, prompt);
  } finally {
    try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
  }
}

/**
 * @param {{text:string, instruction?:string, config:object, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, text?:string, ms?:number, via?:string, freeMB:number, error?:string}>}
 */
async function generate({ text, instruction, config, timeoutMs = 60000 }) {
  const started = Date.now();
  const checked = checkCfg(config);
  if (checked.error) return { ok: false, freeMB: checked.free, error: checked.error };
  const cfg = config;
  if (!String(text || '').trim()) return { ok: false, freeMB: checked.free, error: '先填一句对方说的话' };

  const base = String(cfg.serverUrl || '').replace(/\/+$/, '');
  if (base) {
    try {
      const up = await ensureServer(cfg);
      if (up) {
        const reply = await viaServer({ base, text: String(text).slice(0, 200), instruction, cfg, timeoutMs });
        if (reply) return { ok: true, text: reply, ms: Date.now() - started, via: 'server', freeMB: checked.free };
      }
    } catch (err) {
      // 服务路径失败就继续走 CLI
    }
  }

  const cmd = String(cfg.cmd || '').trim();
  const modelPath = String(cfg.modelPath || '').trim();
  if (!cmd || !modelPath) return { ok: false, freeMB: checked.free, error: '没配本地服务，也没填 llama-cli 与模型路径' };
  if (!fs.existsSync(cmd)) return { ok: false, freeMB: checked.free, error: '找不到 llama-cli：' + cmd };
  if (!fs.existsSync(modelPath)) return { ok: false, freeMB: checked.free, error: '找不到模型文件：' + modelPath };
  try {
    const reply = await viaCli({ text: String(text).slice(0, 200), instruction, cfg, timeoutMs });
    if (!reply) return { ok: false, freeMB: checked.free, error: '模型没给出可用回答（可能超时或输出为空）' };
    return { ok: true, text: reply, ms: Date.now() - started, via: 'cli', freeMB: checked.free };
  } catch (err) {
    return { ok: false, freeMB: checked.free, error: err.message };
  }
}

module.exports = { generate, freeMB, SYSTEM, parseReply };
