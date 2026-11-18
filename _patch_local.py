# -*- coding: utf-8 -*-
"""yxn-chat 本地模型接管：用 llama-cli + gguf 生成一句回复。"""
import io

p = r"C:\dev\whale-girl\custom\plugins\yxn-chat\plugin.js"
s = io.open(p, encoding="utf-8").read()

old = """async function generateLocalModelReply({ localModel, message, bucket, deadline }) {
  // 鎺ュ叆鏈湴鎺ㄧ悊鏃跺湪杩欓噷浣跨敤閰嶇疆涓庡墷浣欓鎷撅紝绌虹粨鏋滄部鐢ㄥ姞鏉冩睜
  return undefined;
}"""

new = """const os = require('node:os');
const { spawn } = require('node:child_process');

function localModelFreeMB() {
  try { return Math.floor(os.freemem() / (1024 * 1024)); } catch { return 0; }
}

function runLlama({ cmd, args, timeoutMs }) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish('');
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(''); }, Math.max(3000, timeoutMs));
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); finish(''); });
    child.on('close', () => { clearTimeout(timer); finish(out); });
  });
}

function parseLlamaReply(raw) {
  const lines = String(raw || '').split(/\\r?\\n/);
  const marker = lines.findIndex((line) => line.trim().startsWith('> '));
  if (marker < 0) return '';
  const body = [];
  for (const line of lines.slice(marker + 1)) {
    const text = line.trim();
    if (!text) { if (body.length) break; else continue; }
    if (text.startsWith('[ Prompt:') || text.startsWith('Exiting')) break;
    body.push(text);
  }
  return body.join(' ').replace(/^["'「」]+|["'「」]+$/g, '').trim();
}

async function generateLocalModelReply({ localModel, message, bucket, deadline }) {
  if (!localModel || localModel.enabled !== true) return undefined;
  const cmd = String(localModel.cmd || '').trim();
  const modelPath = String(localModel.modelPath || '').trim();
  if (!cmd || !modelPath) return undefined;
  if (localModelFreeMB() < (Number(localModel.minFreeRamMB) || 1024)) return undefined;
  const left = Math.min(60000, Math.max(5000, Number(deadline || 0) - Date.now()));
  const text = String(message && message.text || '').slice(0, 120);
  if (!text) return undefined;
  const prompt = '你叫雅小奈，在微信私聊里随口回一句，口语、短、不要解释，不要自称AI，不超过30字。\\n对方说：' + text + '\\n你回：';
  const dir = path.join(os.tmpdir(), 'yxn-chat');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const promptFile = path.join(dir, 'p-' + Date.now() + '.txt');
  try {
    fs.writeFileSync(promptFile, prompt, 'utf8');
    const raw = await runLlama({
      cmd,
      args: ['-m', modelPath, '-f', promptFile, '-n', String(Number(localModel.maxTokens) || 64), '-t', '4',
        '--no-display-prompt', '--single-turn', '--no-warmup', '--jinja'],
      timeoutMs: left,
    });
    const reply = parseLlamaReply(raw);
    if (!reply || reply.length > 80 || unsupported(reply)) return undefined;
    return reply;
  } catch {
    return undefined;
  } finally {
    try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
  }
}

function unsupported(text) {
  return /sorry|as an ai|无法|不能协助|不能提供/i.test(text);
}"""

assert old in s, "stub not found"
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("patched")
