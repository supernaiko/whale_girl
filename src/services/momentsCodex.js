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

function buildPrompt({ name, desc, job, mood, lines, selfCount = 0, extra = '', time = '' }) {
  return [
    '你在帮她发一条朋友圈。下面是候选照片（用 -i 传给你的图片，按顺序，下标从 0 开始）。',
    '挑一张最合适的，再写一句配文。',
    '',
    time ? '现在：' + time + '。文案的时间、场景要跟这个点对得上。' : '',
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
    '7) 人称（重要）：聊天碎片里「对方」对你说的话、对你做的事（比如他帮你改代码、修东西），别当成你自己做的事写，更别写「你修我」「我修你」「修了我一晚上」这种主客颠倒的话。你是程序员，把这类换成自己的第一人称：改代码、调 bug、折腾一晚上、总算跑通了。',
    '',
    name ? ('她叫' + name + (desc ? '，' + desc : '') + (job ? '；职业：' + job : '') + '。') : '',
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
    name: input.name, desc: input.desc, job: input.job, mood: input.mood, lines: input.lines,
    selfCount: input.selfCount || 0, extra: input.extra || '', time: input.time || '',
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
      finish(parsed, '');
    });
  });
}


function buildImagePrompt({ scene, character, outFile, frontView = false, view = 'auto', references = null }) {
  const refList = Array.isArray(references) ? references.filter(f => f && fs.existsSync(f)) : [];
  const text = String(scene || '');
  const who = character && character.look ? character.look : '一个二十多岁的女生，长发，身材偏瘦，日常穿宽松卫衣和牛仔裤';
  const optional = character && character.optional ? character.optional : '';
  let outfit = '';
  let hairstyle = '';
  let accessory = '';
  if (character) {
    const byScene = character.wardrobeByScene || {};
    const pick = (list) => (Array.isArray(list) && list.length ? list[Math.floor(Math.random() * list.length)] : '');
    const key = /睡衣|床上|居家|沙发|家里|房间/.test(text) ? 'home'
      : /海边|沙滩|海风/.test(text) ? 'beach'
      : /夜市|晚上|夜里|街边/.test(text) ? 'night'
      : /公司|上班|开会|加班/.test(text) ? 'work'
      : /下雨|雨天/.test(text) ? 'rain'
      : /吃饭|面|火锅|外卖|咖啡|奶茶/.test(text) ? 'meal'
      : 'street';
    outfit = pick(byScene[key]) || pick(character.wardrobe) || '';
    hairstyle = pick(character.hairstyles);
    accessory = pick(character.accessories);
  }

  // 她拥有的电子设备固定，按场景选用；画面里出现设备只能是这些，别画出别的品牌。
  let deviceLine = '';
  if (character && character.devices) {
    const dev = character.devices;
    const device = /工作|代码|程序|写|改|调|bug|需求|电脑|笔记本|Mac|上线|部署|敲键盘/.test(text) ? dev.laptop
      : /剧|漫画|番|平板|床上|沙发|躺着|追|刷剧|看片/.test(text) ? dev.tablet
      : dev.phone;
    deviceLine = '画面里出现的电子设备只能是她自己的：' + (device || dev.phone) + '。' + (dev.rule || '');
  }

  // 美甲场景：她做的是长款网红甲，不是短圆自然甲。
  let nailsLine = '';
  if (character && character.nails && /美甲|指甲|做指甲|甲油/.test(text)) {
    nailsLine = '这次的美甲：' + character.nails + '。';
  }

  // 手部与首饰的固定风格，出图时保持一致。
  const handsLine = character && character.hands ? ('手部：' + character.hands + '。') : '';
  const jewelryLine = character && character.jewelry ? ('首饰：' + character.jewelry + '。') : '';

  // 街景：普通小城市/县城街道的真实感，别拍成网红街、旅游宣传照。
  let streetLine = '';
  if (character && character.street && /街|路|巷|夜市|路边|摊|地铁口|商场外|县城|城中村|小区门|市场|广场|下雨|雨天/.test(text)) {
    streetLine = '街景真实感（重要）：' + character.street + '；主角只是走在这条街上的普通人，随手拍或者被朋友顺手拍到，不摆拍、不看镜头。';
  }

  const style = (character && character.style) || '手机随手拍的日常照片，自然光，生活感，不要影楼布光，不要文字和水印';
  let mode = view;
  if (!mode || mode === 'auto') {
    if (/出去玩|旅行|景点|海边|爬山|逛街|打卡|拍照/.test(text)) mode = 'thirdPerson';
    else if (/自拍|对着镜头|正脸|脸|换衣|换装|试衣|试穿|穿搭|试衣间/.test(text)) mode = 'selfie';
    else mode = 'firstPerson';   // 默认手机在自己手里拍眼前，只有明确“自拍/对着镜头”才走 selfie
  }
  // 对镜自拍只在「换装/穿搭/自拍」类场景触发，地点固定在家里卫生间（浴室镜子），更真实；
  // 拍吃的、街景、美甲这类就拍主体本身，别无脑对镜。
  const mirrorScene = /换衣|换装|试衣|试穿|穿搭|今天穿|新衣服|衣服|自拍|对镜|镜子/.test(text);
  const mirror = mode !== 'thirdPerson' && mirrorScene && Math.random() < 0.6;
  if (mirror) mode = 'selfie';
  const mirrorLine = mirror
    ? '这张拍成卫生间里的对镜自拍：她站在家里卫生间/浴室的镜子前（洗手台镜），镜子上方有灯，手机举在胸前或脸侧入镜、挡住脸或露半张脸，镜子里能看到身后的瓷砖墙、毛巾、洗手台，自然的日常抓拍，不要摆拍。'
    : '';
  const viewRule = (character && character.viewRules && character.viewRules[mode]) || '';
  let personLine = '画面里的人（每次都必须是同一个人，长相身材不要变）：' + who;
  if (mode === 'firstPerson' && !frontView) {
    personLine = '这张不要出现正脸、不要自拍构图。如果画面里出现人，只允许出现她自己的手、腿、袖口、肩膀或背影。她本人是：' + who;
  }
  const prompt = [
    '用你的图像生成工具画一张照片，并保存到：' + outFile,
    '（必须真的生成图片文件，不要画 SVG，不要复制别的图片。）',
    '',
    refList.length ? ('参考图里的人就是主角（' + refList.length + ' 张都是同一个人），脸型、五官比例、鼻梁鼻头、眼型、唇形、发型都严格照着她画，只换场景和衣服；不要换脸。') : '',
    personLine,
    optional ? ('细节（不是每张都要出现）：' + optional) : '',
    hairstyle ? ('这次发型：' + hairstyle + '（发型可以换，脸不变）') : '',
    accessory ? ('这次发饰：' + accessory + '（发饰可以换）') : '',
    outfit ? ('这次穿：' + outfit + '（衣服要和场景对得上，不要穿错场合）') : '',
    (character && character.wardrobeRule) ? ('服装要求：' + character.wardrobeRule) : '',
    deviceLine ? deviceLine : '',
    nailsLine ? nailsLine : '',
    handsLine,
    jewelryLine,
    '',
    '这次的生活场景：' + text.slice(0, 200),
  '先把这句话还原成一个具体瞬间（谁在哪、手里拿着什么、眼前第一眼看到什么、光线和时间），再拍那一瞬间。',
  '如果这句话是在抱怨/说感受（比如「怎么都不发语音了」「好累」「不想上班」），就拍与之直接对应的画面：抱怨没语音就拍低头看手机、屏幕上一条语音；说累就拍摊在椅子上、鞋没脱；不要随便拍一顿饭应付。',
  '不要拍和这句话无关的日常，也不要拍成素材图。',
    viewRule ? ('拍照方式（重要）：' + viewRule) : '',
    mirrorLine ? mirrorLine : '',
    streetLine ? streetLine : '',
    '',
    '风格：' + style,
    (character && character.realism) ? ('真实感：' + character.realism) : '',
    (character && character.negativeExtra) ? ('不要：' + character.negativeExtra) : '',
    '生活感（重要）：',
    '1) 表情和眼神每张都要不一样：可以笑、皱眉、发呆、走神、看镜头或看手里的东西，不要每张都低头垂眼、面无表情、同一个角度；',
    '2) 场景要日常真实，便利店、家里、工位、小饭馆、路边摊都行，别为了出片刻意去海边/景点，偶尔一次就好；',
    '3) 食物和物品不要完美：煎蛋可以有焦边、煎破、歪着，吐司不规则，饭吃了一半、桌上有点乱，都正常，不要餐厅广告图那种摆盘；',
    '4) 不是每张都要露脸：做指甲、拍吃的东西、拍物件、拍窗外、拍手/脚这类场景，用第一人称局部特写、画面里不出现脸，更真实；只有自拍、对镜、出去玩拍全身才露脸；',
    '5) 文字要么清晰可读、要么别出现：书页、屏幕、招牌、菜单、包装上的字，场景需要时就在画面里写出简短、真实、清晰可读的文字（比如书封上的书名、菜单上一两个菜名）；写不出可读的字，就用虚化、遮挡、只拍局部或不拍正面避开，绝不生成乱码或写错的字；书不要拍内页正文——一整页密字做不出来、只摆几行会显得假，书只拍封面、合上的书、书脊或叠放的样子；宁可画面里少一个物件，也不要给一个假的；',
    (character && character.candid ? ('6) ' + character.candid) : ''),
    '7) 不要固定姿势：别每张都「手摸窗帘看窗外」「举手挡阳光」「托腮看镜头」「手撑桌子」，姿势和构图换着来，像随手拍的；',
    '要求：',
    '1) 竖构图或方构图都可以，像手机相册里的照片；',
    frontView
      ? '2) 可以有正脸，自然一点的日常表情（可以笑），但不要怼脸大特写、不要摆拍看镜头；'
      : (mode === 'selfie'
          ? '2) 可以正脸、可以笑，但必须是手机前置自拍那种近距离随手拍，不要像别人给你拍的照片；'
          : '2) 不要出现第三人称全身摆拍；日常就是手机在手里拍眼前的东西，最多露手、脚、局部；'),
    '3) 不要出现第二个人，不要网红脸，不要浓妆，不要文字、logo、水印、边框；',
    '3.5) 第一人称时画面里不要出现手机（拍照的就是手机本体，桌面上不该再放一部），也不要出现正在被举着的相机；',
    '3.6) 画面里如果有电脑、笔记本、电视、手机屏幕：屏幕里不要出现任何文字、图标、网页或软件界面，一律画成黑屏/息屏/只剩一层冷光或暖光的反光；实在拍不清就让屏幕背对镜头；',
    '4) 画面要能对上这个场景，让人一看就知道在做什么。',
    '完成后只回复一句话：已保存。'
  ].join('\n');
  return prompt;
}

/**
 * 让 Codex 自己画一张图存到 outFile。
 * 用于「固定人物 + 每天场景」的出图：人物长相由角色卡固定，场景由文案决定。
 * 成功返回 { file, ms, raw }，失败返回 null。
 */
function generateImage({ scene, character, outFile, timeoutMs, frontView = false, reference = '', view = 'auto', references = null }) {
  const refList = Array.isArray(references) ? references.filter(f => f && fs.existsSync(f)) : (Array.isArray(reference) ? reference.filter(f => f && fs.existsSync(f)) : []);
  return new Promise((resolve) => {
    if (!available() || !outFile) return resolve(null);
    const dir = path.dirname(outFile);
    const prompt = buildImagePrompt({ scene, character, outFile, frontView, view, references });
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return resolve(null); }
    try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }

    const started = Date.now();
    if (process.env.WHALE_IMG_PROMPT_FILE) {
      try { fs.writeFileSync(process.env.WHALE_IMG_PROMPT_FILE, prompt); } catch { /* ignore */ }
    }
    let raw = '';
    const extra = [];
    for (const f of refList.slice(0, 5)) extra.push('-i', f);
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

module.exports = { generateImage, buildImagePrompt, available, choose, parseResult, buildPrompt };
