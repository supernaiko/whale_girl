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

function buildPrompt({ name, desc, mood, lines, selfCount = 0 }) {
  return [
    '你在帮她发一条朋友圈。下面是候选照片（用 -i 传给你的图片，按顺序，下标从 0 开始）。',
    '挑一张最合适的，再写一句配文。',
    '',
    '选图规则（重要）：',
    '1) 优先选没有人的照片：食物、街景、物件、天空、猫、背影都可以。',
    '2) 如果画面里必须有人物，只允许选她本人（说明里标了“她本人”的那几张）；不要选陌生人的正脸、不要选多人合影、不要选网红图。',
    '3) 拿不准就选没有清晰人脸的那张。',
    '',
    '配文要求：',
    '1) 10~45 个字，最多两句，像随手打的一句话，不是文案；可以只有半句。',
    '2) 第一人称，口语，可以带一点情绪或吐槽；不解释、不总结、不讲道理、不写鸡汤。',
    '3) 不要描述照片画面，不要点评照片里的人或物，不要「这不是…吗」「咱们」「那位」「笑死」「家人们」这类腔调。',
    '4) 不出现人名、昵称、群名、链接、地址；emoji 最多一个，感叹号最多一个。',
    '5) 饿了、困了、不想上班、无聊、发呆这类日常小事可以反复写，不必每次都找新事。',
    '6) 文案要和照片里的场景对得上，但只写你自己的感受。',
    '',
    name ? '她叫' + name + (desc ? '，' + desc : '') + '。' : '',
    selfCount ? '前 ' + selfCount + ' 张是“她本人”，其余不是。' : '这批照片里没有标注“她本人”的。',
    mood ? '她此刻心情：' + mood + '。' : '',
    lines && lines.length ? '最近的聊天碎片（只当灵感，可完全不用）：' + JSON.stringify(lines.slice(0, 6)) : '',
    '',
    '只输出一行 JSON，不要 Markdown、不要解释：{"pick":0,"text":"…","person":false}',
    'person 表示你选的照片里有没有清晰的人物（有就 true）。',
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
      return { pick, text, person: parsed.person === true };
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
