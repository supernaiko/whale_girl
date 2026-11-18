async function generateLocalModelReply({ localModel, message, bucket, deadline }) {
  if (!localModel || localModel.enabled !== true) return undefined;
  const cmd = String(localModel.cmd || '').trim();
  const modelPath = String(localModel.modelPath || '').trim();
  if (!cmd || !modelPath) return undefined;
  let freeMB = 0;
  try { freeMB = Math.floor(os.freemem() / (1024 * 1024)); } catch { freeMB = 0; }
  if (freeMB < (Number(localModel.minFreeRamMB) || 1024)) return undefined;
  const left = Math.min(60000, Math.max(5000, Number(deadline || 0) - Date.now()));
  const text = String((message && message.text) || '').slice(0, 120);
  if (!text) return undefined;
  const prompt = '你叫雅小奈，在微信私聊里随口回一句，口语、短、不要解释，不要自称AI，不超过30字。\n对方说：' + text + '\n你回：';
  const dir = path.join(os.tmpdir(), 'yxn-chat');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const promptFile = path.join(dir, 'p-' + Date.now() + '.txt');
  try {
    fs.writeFileSync(promptFile, prompt, 'utf8');
    const raw = await new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (value) => { if (!done) { done = true; resolve(value); } };
      let child;
      try {
        child = spawn(cmd, ['-m', modelPath, '-f', promptFile, '-n', String(Number(localModel.maxTokens) || 64), '-t', '4',
          '--no-display-prompt', '--single-turn', '--no-warmup', '--jinja'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch { finish(''); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(''); }, left);
      child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
      child.on('error', () => { clearTimeout(timer); finish(''); });
      child.on('close', () => { clearTimeout(timer); finish(out); });
    });
    const lines = String(raw || '').split(/\r?\n/);
    const marker = lines.findIndex((line) => line.trim().startsWith('> '));
    if (marker < 0) return undefined;
    const body = [];
    for (const line of lines.slice(marker + 1)) {
      const row = line.trim();
      if (!row) { if (body.length) break; else continue; }
      if (row.startsWith('[ Prompt:') || row.startsWith('Exiting')) break;
      body.push(row);
    }
    const reply = body.join(' ').replace(/^["'「」]+|["'「」]+$/g, '').trim();
    if (!reply || reply.length > 80) return undefined;
    if (/sorry|as an ai|无法|不能协助|不能提供/i.test(reply)) return undefined;
    return reply;
  } catch {
    return undefined;
  } finally {
    try { fs.unlinkSync(promptFile); } catch { /* ignore */ }
  }
}
