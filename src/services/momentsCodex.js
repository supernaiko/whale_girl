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

function buildPrompt({ name, desc, mood, lines, selfCount = 0, extra = '' }) {
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
    extra ? '额外要求：' + extra : '',
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
  const prompt = buildPrompt({
    name: input.name, desc: input.desc, mood: input.mood, lines: input.lines,
    selfCount: input.selfCount || 0, extra: input.extra || '',
  });
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
      if (typeof input.onRaw === 'function') { try { input.onRaw(out); } catch { /* ignore */ } }
      if (!parsed) return finish(null, 'exit ' + code + ' ' + err.slice(-200));
      if (typeof input.onRaw === 'function') { try { input.onRaw(out); } catch { /* ignore */ } }
      finish(parsed, '');
    });
  });
}


/**
 * 让 Codex 自己画一张图存到 outFile。
 * 用于「固定人物 + 每天场景」的出图：人物长相由角色卡固定，场景由文案决定。
 * 成功返回 { file, ms, raw }，失败返回 null。
 */
function generateImage({ scene, character, outFile, timeoutMs, frontView = false, reference = '', view = 'auto' }) {
  return new Promise((resolve) => {
    if (!available() || !outFile) return resolve(null);
    const dir = path.dirname(outFile);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return resolve(null); }
    try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
    const who = character && character.look ? character.look : '一个二十多岁的女生，长发，身材偏瘦，日常穿宽松卫衣和牛仔裤';
    const optional = character && character.optional ? character.optional : '';
    let outfit = '';
    if (character && Array.isArray(character.wardrobe) && character.wardrobe.length) {
      const seed = String(scene || '').length + new Date().getHours();
      outfit = character.wardrobe[seed % character.wardrobe.length];
    }

    const style = (character && character.style) || '手机随手拍的日常照片，自然光，生活感，不要影楼布光，不要文字和水印';
    const text = String(scene || '');
    let mode = view;
    if (!mode || mode === 'auto') {
      if (/出去玩|旅行|景点|海边|爬山|逛街|打卡|拍照/.test(text)) mode = 'thirdPerson';
      else if (/自拍|对着镜头|正脸|脸/.test(text)) mode = 'selfie';
      else mode = (text.length % 3 === 0) ? 'selfie' : 'firstPerson';
    }
    const viewRule = (character && character.viewRules && character.viewRules[mode]) || '';
    const prompt = [
      '用你的图像生成工具画一张照片，并保存到：' + outFile,
      '（必须真的生成图片文件，不要画 SVG，不要复制别的图片。）',
      '',
      reference ? ('参考图里的人就是主角（第 1 张），脸型、五官、发型、发夹、身材都照着她画，只换场景和衣服。') : '',
      '画面里的人（每次都必须是同一个人，长相身材不要变）：' + who,
      optional ? ('细节（不是每张都要出现）：' + optional) : '',
      outfit ? ('这次穿：' + outfit + '（换别的日子可以换别的衣服，但人不变）') : '',
      '',
      '这次的生活场景：' + text.slice(0, 200),
    '先把这句话还原成一个具体瞬间（谁在哪、手里拿着什么、眼前第一眼看到什么、光线和时间），再拍那一瞬间。',
    '如果这句话是在抱怨/说感受（比如「怎么都不发语音了」「好累」「不想上班」），就拍与之直接对应的画面：抱怨没语音就拍低头看手机、屏幕上一条语音；说累就拍摊在椅子上、鞋没脱；不要随便拍一顿饭应付。',
    '不要拍和这句话无关的日常，也不要拍成素材图。',
      viewRule ? ('拍照方式（重要）：' + viewRule) : '',
      '',
      '风格：' + style,
      '要求：',
      '1) 竖构图或方构图都可以，像手机相册里的照片；',
      frontView
        ? '2) 可以有正脸，自然一点的日常表情（可以笑），但不要怼脸大特写、不要摆拍看镜头；'
        : (mode === 'selfie'
            ? '2) 可以正脸、可以笑，但必须是手机前置自拍那种近距离随手拍，不要像别人给你拍的照片；'
            : '2) 不要出现第三人称全身摆拍；日常就是手机在手里拍眼前的东西，最多露手、脚、局部；'),
      '3) 不要出现第二个人，不要网红脸，不要浓妆，不要文字、logo、水印、边框；',
      '4) 画面要能对上这个场景，让人一看就知道在做什么。',
      '完成后只回复一句话：已保存。'
    ].join('\n');
    const started = Date.now();
    let raw = '';
    const extra = [];
    if (reference && fs.existsSync(reference)) extra.push('-i', reference);
    const child = spawn(process.execPath, [
      codexEntry(), 'exec', '-C', dir, ...extra,
      '-c', 'model_reasoning_effort="low"',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-'
    ], {
      env: Object.assign({}, process.env, { HTTPS_PROXY: PROXY, HTTP_PROXY: PROXY }),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs || 300000);
    child.stdout.on('data', (b) => { raw += b.toString('utf8'); });
    child.stderr.on('data', (b) => { raw += b.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const st = fs.statSync(outFile);
        if (st.size > 20 * 1024) return resolve({ file: outFile, ms: Date.now() - started, raw: raw.slice(-800) });
      } catch { /* not created */ }
      resolve(null);
    });
    child.stdin.end(prompt + '\n');
  });
}

module.exports = { generateImage, available, choose, parseResult, buildPrompt, codexEntry };
