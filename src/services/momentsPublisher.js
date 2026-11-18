'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EMOTIONS, listImages, invalidateScan } = require('../adapters/stickers');
const time = require('../infra/time');
const { describeError } = require('../infra/errors');
const { installPresets } = require('../adapters/stickerPresets');
const { fetchPhoto } = require('./momentsPhotos');
const { searchPosts, download: downloadWeibo } = require('./weiboPosts');

const HOUR = 3600000;
const SENSITIVE = /https?:\/\/|www\.|wxid_|@|\d{6,}|电话|住址|身份证|密钥|密码|验证码|订单号|银行卡|患者|病历|转账|私聊/i;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function lcsLen(a, b) {
  const x = String(a), y = String(b);
  let best = 0;
  const dp = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    let prev = 0;
    for (let j = 1; j <= y.length; j++) {
      const cur = dp[j];
      dp[j] = x[i - 1] === y[j - 1] ? prev + 1 : 0;
      if (dp[j] > best) best = dp[j];
      prev = cur;
    }
  }
  return best;
}

function normalized(text) {
  return String(text).replace(/[\s\p{P}\p{S}]/gu, '');
}

function looseObject(raw) {
  // 模型偶尔收尾被截断，JSON 不完整；能拿到 text 就拼一份，总比整条丢掉好。
  const text = String(raw || '');
  const match = text.match(/"text"\s*:\s*"((?:[^"\\]|\\.){8,200})"/);
  if (!match) return null;
  const emotion = (text.match(/"emotion"\s*:\s*"(happy|cute|angry)"/) || [])[1] || 'happy';
  const imageQuery = (text.match(/"imageQuery"\s*:\s*"([^"]{0,40})"/) || [])[1] || '';
  return { text: match[1].replace(/\\n/g, ' '), emotion, imageQuery };
}

function parseDraft(raw, lines, identities = []) {
  let obj;
  try { obj = JSON.parse(String(raw).trim()); } catch { obj = looseObject(raw); }
  if (!obj) return null;
  if (typeof obj?.text !== 'string' || !Object.hasOwn(EMOTIONS, obj.emotion)) return null;
  const text = obj.text.trim();
  const core = normalized(text);
  if (core.length < 8 || text.length > 120 || SENSITIVE.test(text) || /[\x00-\x1f\x7f]/.test(text)) return null;
  if (identities.some(name => name.length >= 2 && text.includes(name))) return null;
  for (const line of lines) {
    const input = normalized(line);
    if (input.length >= 8 && core.includes(input)) return null;
    for (let i = 0; i + 16 <= core.length; i++) {
      if (input.includes(core.slice(i, i + 16))) return null;
    }
  }
  const imageQuery = typeof obj.imageQuery === 'string'
    ? obj.imageQuery.replace(/[^\p{Script=Han}a-zA-Z0-9 ]/gu, '').trim().slice(0, 20) : '';
  return { text, emotion: obj.emotion, imageQuery };
}

// 按北京时间判断“现在这个点该发什么”：深夜只适合短句和夜宵/加班，早上不适合写刚吃完晚饭。
const FESTIVALS = {
  '1-1': '元旦', '2-14': '情人节', '3-8': '妇女节', '5-1': '劳动节', '6-1': '儿童节',
  '10-1': '国庆', '12-24': '平安夜', '12-25': '圣诞', '12-31': '跨年',
};
function timeBrief(now = (process.env.WHALE_NOW ? new Date(process.env.WHALE_NOW) : new Date())) {
  const tz = 'Asia/Shanghai';
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(now);
  const get = t => (p.find(x => x.type === t) || {}).value || '';
  const hour = Number(get('hour')) % 24;
  const month = Number(get('month'));
  const day = Number(get('day'));
  const week = get('weekday');
  const weekend = week === 'Sat' || week === 'Sun';
  const label = hour < 5 ? '凌晨' : hour < 8 ? '早上' : hour < 11 ? '上午' : hour < 13 ? '中午'
    : hour < 17 ? '下午' : hour < 19 ? '傍晚' : hour < 23 ? '晚上' : '深夜';
  const festival = FESTIVALS[month + '-' + day] || '';
  const guide = hour < 5
    ? '这个点绝大多数人在睡，只适合一句很短的话：失眠、夜宵、加班、刷手机，别写白天发生的事。'
    : hour < 8
      ? '这个点适合刚醒、赶早、早饭、通勤，别写刚吃完晚饭这种乱时段的。'
      : hour < 11
        ? '上午适合路上、工作、早饭刚过，别写准备睡觉。'
        : hour < 14
          ? '中午适合吃饭、午休、犯困。'
          : hour < 18
            ? '下午适合工作、摸鱼、放学、下午茶。'
            : hour < 20
              ? '傍晚适合下班、买菜、回家路上、晚饭。'
              : '晚上适合吃饭、散步、追剧、加班、准备睡。';
  return {
    text: `${month}月${day}日 ${week === 'Mon' ? '周一' : week === 'Tue' ? '周二' : week === 'Wed' ? '周三' : week === 'Thu' ? '周四' : week === 'Fri' ? '周五' : week === 'Sat' ? '周六' : '周日'} ${String(hour).padStart(2, '0')}:${get('minute')}，${label}${weekend ? '（周末）' : ''}${festival ? '，' + festival : ''}`,
    guide,
    hour,
    weekend,
    festival,
  };
}

class MomentsPublisher {
  constructor({ config, store, llm, logger, now = Date.now }) {
    Object.assign(this, { config, store, llm, logger, now });
    this.file = path.join(config.paths.dataDir, 'moments', 'publish-state.json');
    this.images = path.join(config.paths.dataDir, 'moments', 'post-images');
    this.job = null;
    this.preview = null;
    this.generating = false;
    this.currentSettings = this.settings();
    this.settingsKey = JSON.stringify(this.currentSettings);
    this.resetSchedule = false;
    this.settingsRevision = 0;
    this.state = {};
    this.stateError = false;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) this.stateError = true;
      else this.state = saved;
    } catch (err) { this.stateError = err.code !== 'ENOENT'; }
  }

  settings() {
    const m = this.config.moments || {};
    return {
      featureEnabled: m.publishFeatureEnabled === true,
      enabled: m.publishEnabled === true,
      withImage: m.publishWithImage === true,
      photoPrimary: m.photoPrimary === true,
      account: String(m.publishAccount || ''),
      interval: (Number.isFinite(Number(m.publishIntervalHours)) && Number(m.publishIntervalHours) > 0 ? Number(m.publishIntervalHours) : 6),
      maxPerDay: (Number.isSafeInteger(Number(m.publishMaxPerDay)) && Number(m.publishMaxPerDay) >= 0 ? Number(m.publishMaxPerDay) : 1),
    };
  }

  // 和日记/朋友圈读取用同一个时区口径：每日上限按 env.timezone 的午夜重置，
  // 不再按运行桥接的机器本地时间。
  today(ms = this.now()) {
    return time.dayKey(ms, time.resolveTimeZone(this.config));
  }

  reconcile() {
    const settings = this.settings();
    const key = JSON.stringify(settings);
    if (key === this.settingsKey) return;
    const previous = this.currentSettings;
    if (settings.enabled !== previous.enabled || settings.featureEnabled !== previous.featureEnabled
        || settings.account !== previous.account) this.resetSchedule = true;
    this.currentSettings = settings;
    this.settingsKey = key;
    this.settingsRevision++;
    if (this.job?.status === 'queued') {
      this.save({ status: 'failed', error: 'job_cancelled' });
      this.job = null;
    }
  }

  status() {
    this.expire();
    this.reconcile();
    const settings = this.settings();
    const lastCheck = this.scheduleAnchor(settings);
    return {
      nextCheckAt: lastCheck === null ? null : lastCheck + settings.interval * HOUR,
      status: this.stateError ? 'state_error' : (this.generating ? 'generating' : this.job?.status || this.state.status || 'idle'),
      count: this.dailyCount(),
      preview: this.preview?.text || '',
      category: this.preview?.category || this.state.lastImageCategory || '',
      image: this.preview ? Boolean(this.preview.image) : this.state.lastImage === true,
      imageReason: this.preview?.imageReason || this.state.lastImageReason || '',
      error: this.state.error || '',
    };
  }

  scheduleAnchor(settings) {
    if (!settings.featureEnabled || !settings.enabled || !settings.account || this.resetSchedule
        || this.stateError || this.state.scheduleAccount !== settings.account) return null;
    return Number.isFinite(this.state.lastCheck) ? this.state.lastCheck : null;
  }

  save(patch) {
    const next = { ...this.state, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
    fs.renameSync(tmp, this.file);
    this.state = next;
  }

  expire() {
    if (!this.job) return;
    // 队列里放太久可以丢；一旦桥接领取，就从领取时刻重新计时，
    // 否则排队 100 秒后领取，OCR 发表只剩 20 秒，会被误判取消。
    const at = Number(this.job.claimedAt || this.job.at) || 0;
    if (this.now() - at > 120000) {
      // 已领取时可能已发送，过期也不能归还额度或回退去重游标。
      this.save({ status: this.job.status === 'sending' ? 'unconfirmed' : 'failed', error: 'job_cancelled' });
      this.job = null;
    }
  }

  async generate(settings, account, revision, manual = false, withImage = settings.withImage) {
    const now = this.now();
    const since = Math.max(now - 24 * HOUR, manual ? 0 : Number(this.state.lastSource) || 0);
    // 会话视图的 lastActiveAt 创建后不会跟着更新，优先按实际消息时间排序。
    const keys = [...this.store.sessions.entries()].filter(([key]) => /^wechat:[gu]:/.test(key))
      .map(([key, session]) => ({ key, lastActiveAt: session.messages?.at(-1)?.ts ?? session.lastActiveAt ?? 0 }))
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 32).map(session => session.key);
    const entries = keys.flatMap(key => this.store.messages(key, 30))
      .filter(m => m.role === 'user' && m.ts > since && m.ts <= now && !m.error
        && typeof m.text === 'string' && m.text.length <= 220 && !SENSITIVE.test(m.text))
      .sort((a, b) => b.ts - a.ts).slice(0, 20);
    const identities = [...new Set([
      ...entries.flatMap(m => [m.name, m.replyToName, ...(Array.isArray(m.mentionedNames) ? m.mentionedNames : [])]),
      ...keys.map(key => this.store.sessions.get(key)?.title),
    ].map(x => String(x || '').trim()).filter(name => name.length >= 2))];
    const original = entries.map(m => m.text.trim());
    const lines = [...new Set(original.map(line =>
      identities.reduce((text, name) => text.replaceAll(name, '某人'), line)
    ).filter(x => x.length >= 4))];
    this.logger?.info?.('[moments] keys=' + keys.length + ' entries=' + entries.length + ' lines=' + lines.length);
    if (lines.length < 2) { this.save({ status: 'no_material' }); return; }
    if (!this.llm || this.llm.isMock) { this.save({ status: 'model_unavailable' }); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    let draft = null;
    let raw = '';
    try {
      // 第一次太像素材原话会被去重规则拦下；换一件事再写一次，仍然重复才放弃。
      for (let attempt = 0; attempt < 2 && !draft; attempt++) {
      const note = attempt === 0 ? '' : '\n上一条不合格（太像素材原话，或句子太长太像文案）。重写，更短更口语，别复述素材。';
      raw = await this.llm.complete({
        maxTokens: 900,
        system: (() => { const t = timeBrief(); return '现在是北京时间 ' + t.text + '。' + t.guide
          + '文案的时间、场景要跟这个点对得上。' })()
          + '为鲸鲸写一条微信朋友圈，第一人称，像随手打的一句，不是文案。'
          + '要求：5~30 字，最多两句；可以只有半句、可以不完整，比如「我去这个面包好好吃」「今天不宜上班」「吃面了」「累麻了，今天一堆事」。'
          + '口语，可以用「我去」「啊啊」「好累」「绝了」「行吧」这类语气；不解释、不总结、不讲道理、不写鸡汤、不用成语和书面词；'
          + '禁「像极了」「谁懂」「属实」「主打一个」「这波」「真的会谢」「生活总要有点」这类模板句；'
          + '可以写吃了什么、在干什么、路上看到什么、累不累，素材只当灵感，可完全不用；'
          + '不出现人名、昵称、群名、链接、隐私、具体地址。emoji 最多一个，感叹号最多一个。'
          + '配图可选，不是每条都要：想配才给 imageQuery（2~6 个汉字，写画面里的主角，比如「橘猫」而不是「电动车」、「火锅」而不是「吃饭」，别写动作）；'+ '不想配就填空字符串。'
          + '只输出 JSON：{"text":"…","emotion":"happy|cute|angry","imageQuery":"…"}。没有合适内容输出 null。不要 Markdown。',
        turns: [{ role: 'user', content: JSON.stringify([...lines].reverse()) + note }],
        signal: controller.signal,
      });
      if (process.env.WHALE_DEBUG) console.log('[raw]', String(raw).slice(0, 300));
      draft = parseDraft(raw, original, identities);
      }
    } finally { clearTimeout(timeout); }
    if (revision !== this.settingsRevision || this.settingsKey !== JSON.stringify(settings)) return;
    if (!draft) { this.save({ status: 'filtered' }); return; }
    const hash = digest(normalized(draft.text));
    if (this.state.lastHash === hash) { this.save({ status: 'filtered' }); return; }
    let photo = '';
    let sourceText = '';
    if (withImage && draft.imageQuery) {
      await this.prepareImages();
      // 先从微博捞一条真帖子：图文都是真人发的，文案照着它改，比凭空写更像人。
      try {
        const posts = await searchPosts(draft.imageQuery, { cookie: this.weiboCookie() });
        const pick = posts.find(p => p.images.length && p.text.length >= 10);
        if (pick) {
          photo = await downloadWeibo(pick.images[0], path.join(this.images, 'weibo'));
          if (photo) sourceText = pick.text;
        }
      } catch { /* 微博不通就退回图库 */ }
      if (!photo) {
        try { photo = await fetchPhoto(draft.imageQuery, path.join(this.images, 'photo')); } catch { photo = ''; }
      }
    }
    // 文案贴着定下来的图写：有原帖就轻改原帖，没有就照图写一句。
    if (photo) {
      try {
        const refined = await this.llm.complete({
          maxTokens: 220,
          system: sourceText
            ? '下面是别人发的一条微博。鲸鲸想发类似的朋友圈，把这件事、这个画面保留，用她自己的口吻重写成一两句：'
              + '10~40 字，口语，可以换词换角度，但别换主题、别扩写、别升华，不加话题和 @，不出现人名。'
              + '只输出 JSON：{"text":"…"}。'
            : '给鲸鲸的朋友圈配一句话，照片内容就是「' + draft.imageQuery + '」。'
              + '要求：10~30 字，第一人称，口语，可以只有半句；只写当时的一句感受、吐槽或反应；'
              + '不要描述照片画面、不要总结、不讲道理、不用模板句、不出现人名；emoji 最多一个，感叹号最多一个。'
              + '只输出 JSON：{"text":"…"}。',
          turns: [{ role: 'user', content: sourceText ? ('原帖：' + sourceText) : JSON.stringify([...lines].reverse()) }],
          signal: controller.signal,
        });
        const take = raw => {
          const m = String(raw || '').match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (!m) return '';
          const text = JSON.parse('"' + m[1] + '"').trim().replace(/[…\.。]+$/, '');
          return text.length >= 4 && text.length <= 80 ? text : '';
        };
        let text = take(refined);
        // 太像原帖就重写一次：连续 8 个字一样就算抄。
        if (sourceText && text && lcsLen(text, sourceText) >= 8) {
          const again = await this.llm.complete({
            maxTokens: 220,
            system: '把下面这条微博改写成鲸鲸自己的朋友圈：保留同一件事，但措辞要换掉大半，不能出现连续 8 个字和原文一样；'
              + '10~35 字，口语，不用「谁懂」「属实」「主打一个」这类词，不加话题和 @。只输出 JSON：{"text":"…"}。',
            turns: [{ role: 'user', content: '原帖：' + sourceText + '\n刚才那版：' + text }],
            signal: controller.signal,
          });
          const second = take(again);
          if (second) text = second;
        }
        if (text) draft.text = text;
      } catch { /* 保住初稿 */ }
    }
    this.reconcile();
    if (revision !== this.settingsRevision) return;
    // 抓不到真照片就发纯文字，不要塞表情包凑数。
    if (photo) draft.imageQuery = draft.imageQuery || '';
    const wantImage = settings.photoPrimary ? Boolean(photo) : withImage;
    this.queueDraft(draft, account, settings, { hash: digest(normalized(draft.text)), lastSource: entries[0].ts, manual }, wantImage, photo);
  }

  weiboCookie() {
    try {
      if (this.config?.moments?.weiboCookie) return String(this.config.moments.weiboCookie);
      const file = path.join(this.config?.root || path.resolve(__dirname, '../..'), 'data', 'weibo.cookie');
      if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    } catch { /* ignore */ }
    return '';
  }

  async prepareImages() {
    if (!this.settings().featureEnabled) return 0;
    // 与表情包共用随包清单和校验逻辑，复制到桥接允许的朋友圈图片目录。
    const presetConfig = { ...this.config,
      features: { ...this.config.features, stickers: true },
      sticker: { ...this.config.sticker, dir: this.images } };
    return installPresets(presetConfig, this.config.root || path.resolve(__dirname, '../..'), { manual: true });
  }

  queueDraft(draft, account, settings, extra, withImage = settings.withImage, photo = '') {
    const category = EMOTIONS[draft.emotion];
    const folder = path.join(this.images, category);
    // 新建目录或刚放入图片后，要重新检查目录，而不能沿用之前的空目录结果。
    invalidateScan(folder);
    const files = withImage && !photo && !settings.photoPrimary
      ? listImages(folder, { root: this.images, recursive: true })
        .filter(file => /\.(png|jpe?g)$/i.test(file) && fs.statSync(file, { throwIfNoEntry: false })?.size <= 8 * 1024 * 1024) : [];
    const image = photo || (files.length ? files[Math.floor(Math.random() * files.length)] : '');
    this.preview = { text: draft.text, category, image,
      imageReason: !withImage ? 'disabled' : photo ? 'photo_selected' : image ? 'selected' : (settings.photoPrimary ? 'text_only' : 'no_usable_image') };
    this.save({ status: 'queued', error: '' });
    this.job = { id: randomUUID(), at: this.now(), status: 'queued', account, revision: this.settingsRevision, ...extra, query: { ...this.preview, manual: extra?.manual === true } };
  }

  dailyCount() {
    return this.state.day === this.today() ? Number(this.state.count) || 0 : 0;
  }

  queueTest(account, withImage) {
    this.expire();
    this.reconcile();
    const settings = this.settings();
    if (!settings.featureEnabled) return 'feature_disabled';
    if (!account || this.stateError) return 'account_not_verified';
    if (this.job || this.generating) return 'busy';
    this.startGeneration(settings, account, true, withImage);
    return '';
  }

  claim(account) {
    this.expire();
    this.reconcile();
    const settings = this.settings();
    if (this.stateError || !settings.featureEnabled || !account) return null;
    if (this.job?.status === 'queued') {
      if (this.job.account !== account) return null;
      const today = this.today();
      const count = this.dailyCount();
      if (!this.job.manual && settings.maxPerDay > 0 && count >= settings.maxPerDay) { this.job = null; return null; }
      // 保留上次的素材游标。只有桥接明确没点过「发表」，才允许下轮重新选这批素材。
      this.job.previousSource = { lastHash: this.state.lastHash, lastSource: this.state.lastSource };
      // 先占额度再交给桥接。退出或回执丢失时，下次启动也不会补发这条。
      this.save({
        ...(!this.job.manual ? { day: today, count: count + 1 } : {}), status: 'unconfirmed', error: '',
        lastHash: this.job.hash, lastSource: this.job.lastSource,
        lastImage: Boolean(this.job.query.image), lastImageCategory: this.job.query.category,
        lastImageReason: this.job.query.imageReason,
      });
      this.job.day = today;
      this.job.status = 'sending';
      this.job.claimedAt = this.now();
      return { id: this.job.id, action: 'publish', query: this.job.query };
    }
    if (!settings.enabled || settings.account !== account || this.job || this.generating) return null;
    const now = this.now();
    const lastCheck = this.scheduleAnchor(settings);
    if (lastCheck === null) {
      // 第一次由绑定账号在线轮询时开始计时，并保存基准以便重启后续算。
      this.save({ scheduleAccount: account, lastCheck: now });
      this.resetSchedule = false;
      return null;
    }
    // 凌晨不自动发：真人这个点很少发朋友圈，发了也假。
    const hour = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(new Date())) % 24;
    if (hour < 7) return null;
    if ((settings.maxPerDay > 0 && this.dailyCount() >= settings.maxPerDay) || now - lastCheck < settings.interval * HOUR) return null;
    this.save({ lastCheck: now, status: 'checking', error: '' });
    this.startGeneration(settings, account);
    return null;
  }

  startGeneration(settings, account, manual = false, withImage = settings.withImage) {
    this.preview = null;
    this.save({ status: 'generating', error: '', lastImage: false, lastImageCategory: '', lastImageReason: '' });
    this.generating = true;
    const revision = this.settingsRevision;
    this.generate(settings, account, revision, manual, withImage)
      .catch((err) => {
        this.logger?.warn?.('朋友圈草稿生成失败：' + describeError(err));
        try {
          this.save(revision === this.settingsRevision
            ? { status: 'failed', error: 'draft_failed' }
            : { status: 'idle' });
        } catch (saveErr) {
          this.logger?.warn?.('朋友圈草稿失败状态保存失败：' + describeError(saveErr));
        }
      })
      .finally(() => { this.generating = false; });
    return null;
  }

  allowed(id, account) {
    this.expire();
    this.reconcile();
    return this.job?.id === id && this.job.account === account && this.job.status === 'sending'
      && this.settings().featureEnabled && this.job.revision === this.settingsRevision;
  }

  complete(body) {
    if (this.job?.id !== body.id || this.job.account !== body.account || this.job.status !== 'sending') return false;
    const status = body.publishStatus;
    const error = /^[a-z_]{1,36}$/.test(String(body.error || '')) ? body.error : '';
    // 只有确定没有点过发表才归还当天额度，未确认或丢失回执仍然占额度。
    const release = !this.job.manual && status === 'failed' && this.job.day === this.state.day;
    this.save({ ...(release ? { count: Math.max(0, Number(this.state.count) - 1) } : {}),
      ...(status === 'failed' ? this.job.previousSource : {}),
      status: ['confirmed', 'unconfirmed', 'failed'].includes(status) ? status : 'unconfirmed', error });
    this.job = null;
    return true;
  }
}

module.exports = { MomentsPublisher, parseDraft };
