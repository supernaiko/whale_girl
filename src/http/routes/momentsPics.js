'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { json, readBody } = require('../util');
const { isLoopbackRequest } = require('../security');
const { applyConfigPatch } = require('../../infra/configPatch');
const momentsCodex = require('../../services/momentsCodex');
const { searchPosts, download: downloadWeibo } = require('../../services/weiboPosts');

const PROMPT = [
  '【身份段，每次都原样带上】',
  '使用附图作为同一个人。保持：深色长直发（肩下到腰）、身形偏瘦、二十岁出头、常穿浅色上衣或宽松外套；',
  '不要改变脸型、发型长度、发色、身形比例。只出现她一个人，不要生成第二个人。',
  '不露正脸：背影、侧影、低头、手挡脸、只拍局部都可以。',
  '画风：手机随手拍，自然光，轻微噪点，不要影棚光、不要滤镜感、不要商业广告感、不要二次元。',
  '',
  '【场景段，每次只换这一句】',
  '例：场景：小饭馆靠窗的桌子，一碗面和半碟小菜，傍晚暖光。动作：低头挑面。镜头：侧后方半身。',
  '',
  '【负面词】',
  '不要正脸特写、不要多人合影、不要网红妆、不要 logo 和水印、不要在画面里出现文字、不要过曝、不要 AI 感的平滑皮肤。',
  '',
  '【用法】',
  '先出 1 张最满意的当参考图；之后每次上传它，只改场景段。存进下面这个目录，文件名 self-xx.jpg。',
].join('\n');

const EXTS = new Set(['.jpg', '.jpeg', '.png']);

module.exports = function register(router) {
  const local = req => {
    if (!isLoopbackRequest(req)) throw Object.assign(new Error('配图设置仅允许本机访问'), { statusCode: 403 });
  };
  const selfDir = runtime => path.join(runtime.config.paths.dataDir, 'moments', 'self');
  const list = runtime => {
    const dir = selfDir(runtime);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => EXTS.has(path.extname(n).toLowerCase())).sort(); } catch { /* ignore */ }
    return names.slice(0, 12).map(name => {
      let dataUrl = '';
      try { dataUrl = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(dir, name)).toString('base64'); } catch { /* ignore */ }
      return { name, dataUrl };
    });
  };
  const snapshot = runtime => {
    const m = runtime.config.moments || {};
    return {
      ok: true,
      writer: m.writer === 'codex' ? 'codex' : 'deepseek',
      preferNoPerson: m.preferNoPerson !== false,
      allowRepeat: m.allowRepeat !== false,
      dir: selfDir(runtime),
      images: list(runtime),
      prompt: PROMPT,
    };
  };

  router.get('/api/moments/pics', (runtime, req, res) => {
    local(req);
    return json(res, 200, snapshot(runtime));
  });

  const dataUrl = file => {
    try { return 'data:image/jpeg;base64,' + fs.readFileSync(file).toString('base64'); } catch { return ''; }
  };

  // 调试台：给一段提示词，跑一次真实的「挑图 + 写文案」，把用的提示词和结果都吐出来。
  router.post('/api/moments/debug/run', async (runtime, req, res) => {
    local(req);
    const body = await readBody(req) || {};
    const pub = runtime.momentsPublisher;
    const extra = String(body.prompt || '').slice(0, 600);
    const query = String(body.query || '').trim().slice(0, 40);
    const useSelf = body.useSelf !== false;
    await pub.prepareImages();
    const selfFiles = useSelf ? pub.selfImages() : [];
    const picked = [];
    try {
      const q = query || extra.slice(0, 10) || '日常';
      const posts = await searchPosts(q, { cookie: pub.weiboCookie() });
      for (const post of posts.slice(0, 6)) {
        if (!post.images || post.images.length !== 1 || !post.text || post.text.length < 6) continue;
        const file = await downloadWeibo(post.images[0], path.join(pub.images, 'debug'));
        if (file) picked.push({ file, self: false });
        if (picked.length >= 4) break;
      }
    } catch { /* 微博不通就用本人图 */ }
    const images = [...selfFiles.map(f => ({ file: f, self: true })), ...picked];
    if (!images.length) return json(res, 400, { ok: false, error: '没有候选图：微博搜不到，也没有本人图' });
    const started = Date.now();
    let raw = '';
    const result = await momentsCodex.choose({
      images: images.map(item => item.file),
      selfCount: selfFiles.length,
      extra,
      logger: runtime.logger,
      onRaw: text => { raw = text; },
    });
    return json(res, 200, {
      ok: true,
      prompt: momentsCodex.buildPrompt({ selfCount: selfFiles.length, extra }),
      candidates: images.map(item => ({ file: item.file, self: item.self, dataUrl: dataUrl(item.file) })),
      pick: result ? result.pick : -1,
      text: result ? result.text : '',
      person: result ? !!result.person : false,
      elapsedMs: Date.now() - started,
      raw: String(raw || '').slice(-3000),
      error: result ? '' : 'Codex 没有给出可用的 JSON（可能超时或被代理挡住）',
    });
  });

  router.post('/api/moments/pics/settings', async (runtime, req, res) => {
    local(req);
    const body = await readBody(req) || {};
    const patch = {};
    if (body.writer !== undefined) patch['moments.writer'] = body.writer === 'codex' ? 'codex' : 'deepseek';
    if (typeof body.preferNoPerson === 'boolean') patch['moments.preferNoPerson'] = body.preferNoPerson;
    if (typeof body.allowRepeat === 'boolean') patch['moments.allowRepeat'] = body.allowRepeat;
    if (Object.keys(patch).length) applyConfigPatch(runtime, patch);
    return json(res, 200, snapshot(runtime));
  });

  router.post('/api/moments/pics/self/add', async (runtime, req, res) => {
    local(req);
    const body = await readBody(req) || {};
    const src = String(body.path || '');
    if (!src || !fs.existsSync(src) || !EXTS.has(path.extname(src).toLowerCase())) {
      return json(res, 400, { ok: false, error: '图片不存在或格式不支持（jpg/png）' });
    }
    const dir = selfDir(runtime);
    fs.mkdirSync(dir, { recursive: true });
    const used = new Set(fs.readdirSync(dir).map(n => n.toLowerCase()));
    if (used.size >= 6) return json(res, 400, { ok: false, error: '最多 6 张，先删一张' });
    let n = 1;
    while (used.has(('self-' + String(n).padStart(2, '0') + '.jpg').toLowerCase())) n += 1;
    fs.copyFileSync(src, path.join(dir, 'self-' + String(n).padStart(2, '0') + '.jpg'));
    return json(res, 200, snapshot(runtime));
  });

  router.post('/api/moments/pics/self/remove', async (runtime, req, res) => {
    local(req);
    const body = await readBody(req) || {};
    const name = path.basename(String(body.name || ''));
    if (!EXTS.has(path.extname(name).toLowerCase())) return json(res, 400, { ok: false, error: '文件名不对' });
    try { fs.unlinkSync(path.join(selfDir(runtime), name)); } catch { /* ignore */ }
    return json(res, 200, snapshot(runtime));
  });
};
