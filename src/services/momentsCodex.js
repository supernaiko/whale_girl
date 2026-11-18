'use strict';
/**
 * 让本机 Codex（ChatGPT 账号）挑图 + 写朋友圈文案。
 *
 * 为什么不把搜图也交给它：Codex 沙箱限网，搜不到图；图片由调用方先下载好，
 * 这里只把本地路径喂给它，让它看图挑一张、写一句，再返回 { pick, text }。
 * 任何失败都返回 null，调用方回落到原来的 DeepSeek 文案流程。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROXY = process.env.WHALE_CODEX_PROXY || 'http://127.0.0.1:10808';
const TIMEOUT_MS = Number(process.env.WHALE_CODEX_TIMEOUT_MS || 180000) || 180000;

function codexEntry() {
  const npm = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm');
  return path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
}

function available() {
  return fs.existsSync(codexEntry()) && typeof process.execPath === 'string';
}

function buildPrompt({ name, desc, mood, lines }) {
  return [
    '你在替微信里的一个女生写朋友圈。下面给你几张她自己拍/存下来的照片，以及最近聊天的碎片。',
    '请先挑一张最适合发朋友圈的照片（挑第几张用下标，从 0 开始），再写一句配文。',
    '配文要求：',
    '1) 10~45 个字，最多两句，像随手打的一句，不是文案；可以只有半句。',
    '2) 第一人称，口语，可以带一点情绪或吐槽；不解释、不总结、不讲道理、不写鸡汤。',
    '3) 不要描述照片画面，不要点评照片里的人或物，不要"这不是…吗""咱们""那位""笑死""家人们"这类腔调。',
    '4) 不出现人名、昵称、群名、链接、地址；emoji 最多一个，感叹号最多一个。',
    '5) 文案要和照片里的场景对得上，但只写你自己的感受。',
    name ? '她叫' + name + (desc ? '，' + desc : '') + '。' : '',
    mood ? '她此刻情绪：' + mood + '。' : '',
    lines && lines.length ? '最近的聊天碎片（只当灵感，可完全不用）：' + JSON.stringify(lines.slice(0, 6)) : '',
    '',
    '只输出一行 JSON，不要 Markdown、不要解释：{"pick":0,"text":"…"}',
  ].filter(Boolean).join('\n');
}

function parseResult(text, count) {
  const raw = String(text || '');
  const matches = raw.match(/\{[^{}]*"pick"[^{}]*\}/g) || raw.match(/\{[\s\S]*\}/g);
  if (!matches) return null;
  for (const block of matches.reverse()) {
    try {
      const parsed = JSON.parse(block);
      const pick = Number(parsed.pick);
      const text = String(parsed.text || '').trim();
      if (!Number.isInteger(pick) || pick < 0 || pick >= count) continue;
      if (!text || text.length > 120) continue;
      return { pick, text };
    } catch { /* 继续试下一段 */ }
  }
  return null;
}

/**
 * @param {object} input { images: string[], name, desc, mood, lines, logger }
 * @returns {Promise<{pick:number,text:string}|null>}
 */
function choose(input = {}) {
  const images = (input.images || []).filter(file => file && fs.existsSync(file)).slice(0, 5);
  if (!images.length || !available()) return Promise.resolve(null);
  const prompt = buildPrompt({ name: input.name, desc: input.desc, mood: input.mood, lines: input.lines });
  const args = [
    codexEntry(), 'exec',
    '-C', input.cwd || os.tmpdir(),
    '-c', 'model_reasoning_effort="medium"',
    '--skip-git-repo-check',
  ];
  for (const file of images) args.push('-i', file);
  args.push('-');

  return new Promise(resolve => {
    let out = '';
    let err = '';
    let done = false;
    const child = spawn(process.execPath, args, {
      env: { ...process.env, HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY, NO_COLOR: '1', CODEX_NON_INTERACTIVE: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => finish(null, 'timeout'), TIMEOUT_MS);
    function finish(value, why) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      if (!value && input.logger) input.logger.warn?.('[moments] codex skip: ' + why);
      resolve(value);
    }
    child.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
    try { child.stdin.on('error', () => {}); child.stdin.end(prompt + '\n'); } catch { /* ignore */ }
    child.stderr.on('data', chunk => { err += chunk.toString('utf8'); });
    child.on('error', error => finish(null, 'spawn ' + error.message));
    child.on('close', code => {
      const parsed = parseResult(out, images.length);
      if (!parsed) return finish(null, 'exit ' + code + ' ' + err.slice(-200));
      finish(parsed, '');
    });
  });
}

module.exports = { available, choose, parseResult, buildPrompt, codexEntry };
