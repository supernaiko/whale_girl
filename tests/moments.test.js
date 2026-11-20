'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MomentsService } = require('../src/services/moments');
const { MomentsPublisher } = require('../src/services/momentsPublisher');
const { Scheduler } = require('../src/infra/scheduler');
const { momentsIntent, Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const register = require('../src/http/routes/moments');

test('自动发表资格：作息、当天上限、最小间隔和当天静音', () => {
  const { eligibleNow } = require('../src/services/momentsScheduler');
  const cfg = { timezone: 'Asia/Shanghai' };
  const now = Date.parse('2026-11-19T10:00:00+08:00');
  assert.equal(eligibleNow(Date.parse('2026-11-19T02:00:00+08:00'), {}, cfg), false);
  assert.equal(eligibleNow(now, { day: '2026-11-19', count: 2 }, cfg), false);
  assert.equal(eligibleNow(now, { lastPublishAt: now - 2 * 3600000 }, cfg), false);
  assert.equal(eligibleNow(now, {}, { ...cfg, muteDate: '2026-11-19' }), false);
  assert.equal(eligibleNow(now, { day: '2026-11-19', count: 0 }, cfg), true);
});

test('朋友圈：读取结果保存为最近一次快照，重启后能回答主人', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-snapshot-'));
  try {
    const s = new MomentsService({ dir });
    assert.match(s.contextBlock(), /还没有读取/);
    const j = s.request({ limit: 2 });
    s.claim('test-account');
    s.complete({ id: j.id, account: 'test-account', items: [
      { nickname: 'Peer', text: '第一行\n第二行', create_time: 1700000000 },
    ] });

    const again = new MomentsService({ dir });
    const block = again.contextBlock();
    assert.match(block, /Peer/);
    assert.match(block, /第一行 第二行/);
    assert.match(block, /不是当前聊天/);
    assert.ok(!block.includes('test-account'));

    // 筛选没命中时不要把上一份快照清空
    const empty = again.request({ limit: 2, keyword: '没有这条' });
    again.claim('test-account');
    again.complete({ id: empty.id, account: 'test-account', items: [] });
    assert.match(again.contextBlock(), /Peer/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('朋友圈：只有问到朋友圈时才注入快照上下文', () => {
  assert.equal(momentsIntent('今天朋友圈有什么'), true);
  assert.equal(momentsIntent('帮我看看谁发了动态'), true);
  assert.equal(momentsIntent('最近发了啥'), true);
  assert.equal(momentsIntent('今天吃什么'), false);
});

test('朋友圈：只有主人私聊问到才注入快照上下文', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-chat-'));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.master = { names: [], wxids: ['owner'] };
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const captured = {};
  const llm = {
    isMock: false, model: 'mock', reload() {}, describe() { return {}; },
    async complete({ system, turns }) { captured.system = system; captured.turns = turns; return '好'; },
  };
  const moments = { contextBlock: () => '【朋友圈快照】\n- Peer（2026-11-08 12:00）：春天来了' };
  const bot = new Bot({ config, store, llm, logger: null, mockChunkDelayMs: 0, moments });
  const msg = (extra) => ({ platform: 'web', chatId: 'owner', chatType: 'private',
    senderId: 'owner', senderName: '主人', text: '今天朋友圈有什么', ...extra });
  try {
    const privateReply = await bot.decide(msg({}));
    assert.equal(privateReply.action, 'reply');
    assert.match(privateReply.turns.map((t) => t.content).join('\n'), /【朋友圈快照】/);
    assert.match(privateReply.turns.map((t) => t.content).join('\n'), /春天来了/);

    const groupReply = await bot.decide(msg({ chatId: 'g1', chatType: 'group', atMe: true }));
    assert.ok(groupReply.turns);
    assert.doesNotMatch(groupReply.turns.map((t) => t.content).join('\n'), /【朋友圈快照】/);

    const otherReply = await bot.decide(msg({ chatId: 'other', senderId: 'other', senderName: '别人' }));
    assert.ok(otherReply.turns);
    assert.doesNotMatch(otherReply.turns.map((t) => t.content).join('\n'), /【朋友圈快照】/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('朋友圈：自动点赞只处理安全候选，执行后不重复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-like-'));
  try {
    const s = new MomentsService({ dir, config: { moments: { autoLike: true, autoLikeMaxPerDay: 2 } } });
    const calls = [];
    let seen = [];
    s.judgeLikes = async (items) => { seen = items; return [{ id: 'ok', confidence: 0.95 }]; };
    s.action = (body) => { calls.push(body); return { id: 'job-' + calls.length }; };
    s.waitForJob = async () => ({ status: 'unconfirmed' });
    const job = {
      account: 'acct', query: {}, items: [
        { id: 'ok', nickname: 'Peer', text: '今天天气真好呀', own: false, likedByMe: false },
        { id: 'own', nickname: 'Me', text: '我自己的动态', own: true, likedByMe: false },
        { id: 'liked', nickname: 'Peer2', text: '已经点过赞的动态', own: false, likedByMe: true },
        { id: 'sad', nickname: 'Peer3', text: '家里有人去世了', own: false, likedByMe: false },
        { id: 'short', nickname: 'Peer4', text: '早安', own: false, likedByMe: false },
      ],
    };
    await s.autoLike(job);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, 'ok');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { action: 'like', publisher: 'Peer', keyword: '今天天气真好呀', account: 'acct' });
    assert.ok(s.state.liked.has('ok'));
    assert.equal(s.state.count, 1);

    await s.autoLike(job);
    assert.equal(calls.length, 1, '执行过的动态不能再自动点赞');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('朋友圈：自动点赞的关键词不带省略号，能匹配原正文', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-like-kw-'));
  try {
    const s = new MomentsService({ dir, config: { moments: { autoLike: true, autoLikeMaxPerDay: 1 } } });
    let keyword = '';
    s.judgeLikes = async () => [{ id: 'long', confidence: 0.95 }];
    s.action = (body) => { keyword = body.keyword; return { id: 'job' }; };
    s.waitForJob = async () => ({ status: 'unconfirmed' });
    const text = '很长很长的动态正文'.repeat(5);
    await s.autoLike({ account: 'acct', query: {}, items: [
      { id: 'long', nickname: 'Peer', text, own: false, likedByMe: false },
    ] });
    assert.equal(keyword.length, 20);
    assert.ok(!keyword.includes('…'));
    assert.ok(text.includes(keyword));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('朋友圈：主人问起且快照过期时会先补读一次', async () => {
  const s = new MomentsService({ now: () => 700000 });
  s.latest = { savedAt: 0, items: [{ id: 'old', nickname: 'Peer', text: '旧动态' }] };
  let requested = 0;
  s.request = (body) => { requested++; assert.equal(body.limit, 20); return { id: 'job-refresh' }; };
  s.result = () => ({ status: 'done', items: [] });
  const out = await s.ensureFresh({ waitMs: 700 });
  assert.equal(out.ok, true);
  assert.equal(out.fresh, true);
  assert.equal(requested, 1);

  const fresh = new MomentsService({ now: () => 20000 });
  fresh.latest = { savedAt: 19000, items: [{ id: 'new', nickname: 'Peer', text: '刚读过' }] };
  fresh.request = () => { throw new Error('不该再读'); };
  const again = await fresh.ensureFresh({ waitMs: 700 });
  assert.equal(again.fresh, false);
});

test('朋友圈互动：完整定位、单次领取、仅报告未确认', () => {
  const s = new MomentsService();
  assert.throws(() => s.action({ action: 'comment', publisher: 'Peer', keyword: 'spring' }));
  const j = s.action({ action: 'like', publisher: 'Peer', keyword: 'spring' });
  assert.equal(s.claim('test-account').action, 'like');
  assert.equal(s.claim('test-account'), null);
  assert.equal(s.complete({ id: j.id, account: 'test-account', performed: true }).status, 'unconfirmed');
  assert.throws(() => s.action({ action: 'publish' }));
});

test('朋友圈：手动请求才产生任务；只领取一次且账号绑定', () => {
  const s = new MomentsService();
  assert.equal(s.claim('test-account'), null);
  const j = s.request({ keyword: '春天', own: true });
  assert.equal(j.status, 'queued');
  assert.equal(s.claim(''), null);
  assert.deepEqual(s.claim('test-account').query, { limit: 20, keyword: '春天', username: '', own: true });
  assert.equal(s.claim('test-account'), null);
  assert.throws(() => s.complete({ id: j.id, account: 'other', items: [] }), { statusCode: 409 });
  assert.equal(s.result(j.id).status, 'reading');
});

test('朋友圈：结果限量/白名单，路径/定位/评论不传回客户端', () => {
  const s = new MomentsService();
  const j = s.request({ limit: 1 });
  s.claim('test-account');
  const r = s.complete({ id: j.id, account: 'test-account', items: [
    { text: '测试', id: '1', location: 'private', path: 'secret', comments: ['secret'], images: ['secret'] },
    { text: '不返回' },
  ] });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].text, '测试');
  assert.ok(!JSON.stringify(r).includes('secret'));
  assert.throws(() => s.complete({ id: j.id, account: 'test-account', items: [] }), { statusCode: 409 });
});

test('朋友圈：账号钉住后其他桥接不能领走任务', () => {
  const s = new MomentsService();
  const j = s.request({ keyword: '春天', account: 'wxid-a' });
  assert.equal(s.claim('wxid-b'), null);
  assert.equal(s.claim('wxid-a').query.keyword, '春天');
  assert.equal(s.result(j.id).status, 'reading');
});

test('朋友圈：超时从桥接领取时开始算，不在请求时提前判死', () => {
  let now = 1000;
  const s = new MomentsService({ now: () => now });
  const j = s.request();
  now += 60000;
  assert.equal(s.claim('test-account').id, j.id);
  now += 60000;
  assert.equal(s.result(j.id).status, 'reading');
  now += 31000;
  assert.equal(s.result(j.id).status, 'failed');
});

test('朋友圈：正文保留换行，互动错误不再冒充读取错误', () => {
  const s = new MomentsService();
  const j = s.request({ limit: 1 });
  s.claim('test-account');
  const r = s.complete({ id: j.id, account: 'test-account', items: [{ text: '第一行\n第二行' }] });
  assert.equal(r.items[0].text, '第一行\n第二行');

  const a = s.action({ action: 'unlike', publisher: 'Peer', keyword: 'spring' });
  s.claim('test-account');
  const failed = s.complete({ id: a.id, account: 'test-account', error: 'cancel_not_found' });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /取消点赞/);
  assert.doesNotMatch(failed.error, /读取失败/);
});

test('朋友圈：超时/过期结果不能污染新任务', () => {
  let now = 1000;
  const s = new MomentsService({ now: () => now });
  const a = s.request(); s.claim('test-account');
  assert.throws(() => s.request(), { statusCode: 409 });
  now += 91000;
  assert.equal(s.result(a.id).status, 'failed');
  const b = s.request();
  assert.throws(() => s.complete({ id: a.id, account: 'test-account', items: [] }), { statusCode: 404 });
  now += 301000;
  assert.throws(() => s.result(b.id), { statusCode: 404 });
  assert.equal(s.job, null);
});

test('朋友圈：限制扫描范围，错误不泄露内部异常', () => {
  const s = new MomentsService();
  for (const limit of [0, -1, 51, 1.5, 'abc']) assert.throws(() => s.request({ limit }), { statusCode: 400 });
  assert.throws(() => s.request(null), { statusCode: 400 });
  const j = s.request(); s.claim('test-account');
  const r = s.complete({ id: j.id, account: 'test-account', error: 'secret path' });
  assert.equal(r.status, 'failed');
  assert.ok(!r.error.includes('secret'));
});

test('朋友圈：所有接口限制本机，桥接写入必须验证 token', async () => {
  const routes = {};
  register({ get: (p, f) => { routes[p] = f; }, post: (p, f) => { routes[p] = f; } });
  const runtime = { moments: new MomentsService(), gateways: new Map([['wechat', { verifyToken: () => false }]]) };
  const remote = { socket: { remoteAddress: '192.0.2.1' } };
  for (const route of Object.values(routes)) {
    await assert.rejects(async () => route(runtime, remote), { statusCode: 403 });
  }
  for (const p of ['/api/moments/claim', '/api/moments/complete']) {
    await assert.rejects(async () => routes[p](runtime, { socket: { remoteAddress: '127.0.0.1' } }), { statusCode: 403 });
  }
});

test('朋友圈 HTTP 全链路：请求、鉴权领取、回传与读取', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { startServer } = require('../server');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-test-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    watchConfig: false, server: { openBrowser: false },
    gateway: { wechat: { enabled: true, inboundToken: 'test-moments-token' } },
  }));
  const app = await startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  const post = (route, body, token = '') => fetch(app.url + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bot-token': token }, body: JSON.stringify(body),
  });
  try {
    const job = await (await post('/api/moments/read', { limit: 2 })).json();
    assert.equal(job.status, 'queued');
    assert.equal((await post('/api/moments/claim', { account: 'test-account' })).status, 403);
    const claimed = await (await post('/api/moments/claim', { account: 'test-account' }, 'test-moments-token')).json();
    assert.equal(claimed.job.id, job.id);
    const completed = await post('/api/moments/complete', { id: job.id, account: 'test-account', items: [{ text: '测试动态' }] }, 'test-moments-token');
    assert.equal(completed.status, 200);
    const result = await (await fetch(app.url + '/api/moments/result?id=' + job.id)).json();
    assert.equal(result.status, 'done');
    assert.equal(result.items[0].text, '测试动态');

    const settings = await (await fetch(app.url + '/api/moments/settings')).json();
    assert.equal(settings.ok, true);
    assert.equal(settings.autoLike, true);
    const publishSettings = await (await fetch(app.url + '/api/moments/publish-settings')).json();
    assert.equal(publishSettings.maxPerDay, 2);
    assert.equal(publishSettings.interval, 6);
    assert.equal(publishSettings.intervalHours, 6);
    assert.equal(publishSettings.todayCount, 0);
    assert.equal(publishSettings.muteDate, '');
    assert.equal(publishSettings.nextEligibleAt, null);
    const muted = await (await post('/api/moments/publish-settings', {
      muteDate: '2026-11-19', activeStart: '09:00', activeEnd: '22:30',
      minGapHours: 4, attemptProbability: 0.5, intervalHours: 8, maxPerDay: 3,
    })).json();
    assert.equal(muted.muteDate, '2026-11-19');
    assert.equal(muted.activeStart, '09:00');
    assert.equal(muted.activeEnd, '22:30');
    assert.equal(muted.minGapHours, 4);
    assert.equal(muted.attemptProbability, 0.5);
    assert.equal(muted.interval, 8);
    assert.equal(muted.intervalHours, 8);
    assert.equal(muted.maxPerDay, 3);
    assert.equal(muted.enabled, false);
    assert.equal((await post('/api/moments/publish-settings', { attemptProbability: 1.5 })).status, 400);
    const patched = await (await fetch(app.url + '/api/moments/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoLike: false, autoReadEveryHours: 6 }),
    })).json();
    assert.equal(patched.autoLike, false);
    assert.equal(patched.autoReadEveryHours, 6);

    const latest = await (await fetch(app.url + '/api/moments/latest')).json();
    assert.equal(latest.snapshot.items[0].text, '测试动态');

    assert.equal((await fetch(app.url + '/healthz')).status, 200);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});


test('立即发表使用正常文案和三种心情配图，不占或受限于自动额度', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-manual-moods-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [emotion, category] of Object.entries({ happy: '开心', cute: '傲娇', angry: '炸毛' })) {
    const folder = path.join(root, emotion);
    const messages = ['今天学了一首新曲子', '早上的咖啡有点苦呢', '终于收拾好了书桌'].map(text =>
      ({ role: 'user', ts: Date.now(), text }));
    const publisher = new MomentsPublisher({
      config: { root: folder, paths: { dataDir: folder }, moments: { publishFeatureEnabled: true, publishMaxPerDay: 1 } },
      store: { sessions: new Map([['wechat:g:fixture', { messages }]]), messages: () => messages },
      llm: { complete: async () => JSON.stringify({ text: '慢慢找到自己的节奏，今天也值得认真度过。', emotion }) },
    });
    const imageDir = path.join(publisher.images, category);
    fs.mkdirSync(imageDir, { recursive: true });
    fs.writeFileSync(path.join(imageDir, 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS/8AAAAASUVORK5CYII=', 'base64'));
    publisher.save({ day: publisher.today(), count: 1 });
    assert.equal(publisher.queueTest('account', true), '');
    assert.equal(publisher.queueTest('account', true), 'busy');
    await new Promise(resolve => setImmediate(resolve));
    const job = publisher.claim('account');
    assert.equal(job.query.manual, true);
    assert.equal(job.query.category, category);
    assert.equal(job.query.image, path.join(imageDir, 'sample.png'));
    assert.doesNotMatch(job.query.text, /朋友圈测试/);
    assert.equal(publisher.dailyCount(), 1);
    assert.equal(publisher.complete({ id: job.id, account: 'account', publishStatus: 'failed' }), true);
    assert.equal(publisher.dailyCount(), 1, '手动失败不能退还自动额度');
    publisher.save({ lastHash: '', lastSource: 0, count: 0 });
    assert.equal(publisher.queueTest('account', false), '');
    await new Promise(resolve => setImmediate(resolve));
    const textJob = publisher.claim('account');
    assert.equal(textJob.query.image, '');
    publisher.complete({ id: textJob.id, account: 'account', publishStatus: 'confirmed' });
    assert.equal(publisher.dailyCount(), 0);
  }
});

test('朋友圈发表允许小数间隔、大于旧限制的设置和不限每日条数', () => {
  const publisher = new MomentsPublisher({
    config: { paths: { dataDir: os.tmpdir() }, moments: { publishIntervalHours: 0.25, publishMaxPerDay: 0 } },
  });
  assert.equal(publisher.settings().interval, 0.25);
  assert.equal(publisher.settings().maxPerDay, 0);
  publisher.config.moments.publishIntervalHours = 72;
  publisher.config.moments.publishMaxPerDay = 100;
  assert.equal(publisher.settings().interval, 72);
  assert.equal(publisher.settings().maxPerDay, 100);
  const { FIELDS, checkValue } = require('../src/infra/configSchema');
  assert.equal(checkValue(0.25, FIELDS['moments.publishIntervalHours']), null);
  assert.equal(checkValue(72, FIELDS['moments.publishIntervalHours']), null);
  assert.equal(checkValue(100, FIELDS['moments.publishMaxPerDay']), null);
  assert.equal(checkValue(0, FIELDS['moments.publishMaxPerDay']), null);
  assert.ok(checkValue(0, FIELDS['moments.publishIntervalHours']));
  publisher.config.moments.publishFeatureEnabled = true;
  publisher.config.moments.publishMaxPerDay = 0;
  publisher.save = patch => Object.assign(publisher.state, patch);
  publisher.state = { day: publisher.today(), count: 100 };
  publisher.reconcile();
  publisher.queueDraft({ text: '慢慢找到自己的节奏，今天也值得认真度过。', emotion: 'happy' },
    'account', publisher.settings(), { hash: 'unlimited', lastSource: 1 });
  assert.ok(publisher.claim('account'));
  assert.equal(publisher.dailyCount(), 101);
});

test('定时发表从首次在线开始每小时抽样，重启后仍能生成、领取和回执', async t => {
  const { MomentsPublisher } = require('../src/services/momentsPublisher');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-moments-clock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hour = 3600000;
  let now = Date.parse('2026-11-10T08:00:00+08:00');
  const config = { root, paths: { dataDir: root }, env: { timezone: 'Asia/Shanghai' }, moments: {
    publishFeatureEnabled: true, publishEnabled: true, publishAccount: 'selected',
    publishIntervalHours: 6, publishMaxPerDay: 1,
  } };
  const messages = ['昨天练了好几遍吉他', '今天试着弹了新的和弦', '周末想把整首曲子练熟']
    .map(text => ({ role: 'user', ts: now, name: '小北', text }));
  messages.push({ role: 'user', ts: now, name: '小北', text: '我的验证码 123456' });
  const key = 'wechat:g:fixture';
  const store = { sessions: new Map([[key, { title: '练琴群', messages }]]), messages: () => messages };
  const prompts = [];
  const llm = { async complete(request) {
    prompts.push(request.turns[0].content);
    return JSON.stringify({ text: '一点一点练，普通的日子也有自己的节奏。', emotion: 'happy' });
  } };
  const create = () => new MomentsPublisher({ config, store, llm, now: () => now, random: () => 0 });
  let publisher = create();
  assert.equal(publisher.claim('other'), null);
  assert.equal(publisher.status().nextCheckAt, null);
  assert.equal(publisher.claim('selected'), null);
  assert.equal(publisher.status().nextCheckAt, now + hour);
  assert.equal(publisher.status().nextEligibleAt, now + hour);
  assert.equal(prompts.length, 0);

  now += hour - 1;
  publisher = create();
  assert.equal(publisher.claim('selected'), null);
  assert.equal(prompts.length, 0);
  now++;
  assert.equal(publisher.claim('selected'), null, '本轮先生成，下一次轮询再领');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /吉他/);
  assert.doesNotMatch(prompts[0], /验证码|123456/);
  assert.equal(publisher.claim('other'), null);
  const job = publisher.claim('selected');
  assert.equal(job.action, 'publish');
  assert.equal(job.query.image, '');
  assert.equal(publisher.allowed(job.id, 'selected'), true);
  assert.equal(publisher.claim('selected'), null, '同一任务不能重复领取');

  assert.equal(publisher.complete({ id: job.id, account: 'selected', publishStatus: 'failed' }), true);
  assert.equal(publisher.dailyCount(), 0);
  assert.equal(publisher.state.lastSource, undefined, '明确未发表可以在下轮重新使用素材');
  now += 3 * hour;
  assert.equal(publisher.claim('selected'), null);
  await new Promise(resolve => setImmediate(resolve));
  const retry = publisher.claim('selected');
  assert.equal(retry.action, 'publish');
  assert.equal(publisher.complete({ id: retry.id, account: 'selected', publishStatus: 'unconfirmed' }), true);
  assert.equal(publisher.dailyCount(), 1);
  assert.ok(publisher.state.lastSource > 0);
  assert.equal(publisher.allowed(retry.id, 'selected'), false);
});

test('无效的朋友圈发表状态显示为暂停而不是让查询报错', t => {
  const { MomentsPublisher } = require('../src/services/momentsPublisher');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-moments-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'moments'));
  fs.writeFileSync(path.join(root, 'moments', 'publish-state.json'), 'null');
  const publisher = new MomentsPublisher({ config: { paths: { dataDir: root } } });
  assert.equal(publisher.status().status, 'state_error');
  assert.equal(publisher.claim('selected'), null);
});

test('朋友圈：定时读取接到统一调度，改设置后重排', async () => {
  let now = Date.UTC(2026, 0, 1, 4, 0); // 上海 12:00，避开 0–7 点夜间跳过
  let seq = 0;
  const timers = new Map();
  const clock = {
    setTimeout(fn, ms) {
      const t = { id: ++seq, at: now + ms, fn, unref() { return t; } };
      timers.set(t.id, t);
      return t;
    },
    clearTimeout(t) { if (t) timers.delete(t.id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due.id);
        now = due.at;
        due.fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = end;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  const scheduler = new Scheduler({ now: () => now, timers: clock });
  const service = new MomentsService({
    scheduler,
    now: () => now,
    config: { env: { timezone: 'Asia/Shanghai' }, moments: { autoReadEveryHours: 4 }, wechat: {} },
  });
  let calls = 0;
  service.request = () => { calls += 1; return { id: 'job' }; };

  service.startAutoRead();
  await clock.advance(4 * 3600 * 1000 - 1);
  assert.equal(calls, 0);
  await clock.advance(1);
  assert.equal(calls, 1);

  // 改设置立即重排：旧的 4 小时计划不能继续生效
  service.config.moments.autoReadEveryHours = 6;
  service.startAutoRead();
  await clock.advance(4 * 3600 * 1000);
  assert.equal(calls, 1);
  await clock.advance(2 * 3600 * 1000);
  assert.equal(calls, 2);

  service.stopAutoRead();
  await clock.advance(12 * 3600 * 1000);
  assert.equal(calls, 2);
});

test('朋友圈：读取结果保留 own/likedByMe，自动点赞不会点自己或已点过赞的', () => {
  const service = new MomentsService({
    config: { moments: { autoLike: true } },
    now: () => 1000,
  });
  const job = service.request({ limit: 20, account: 'acct' });
  assert.equal(service.claim('acct').id, job.id);
  const done = service.complete({
    id: job.id,
    account: 'acct',
    items: [
      { id: 'own', nickname: 'Me', text: '我自己的动态', own: true, likedByMe: false },
      { id: 'liked', nickname: 'Peer', text: '已经点过赞的动态', own: false, likedByMe: true },
      { id: 'ok', nickname: 'Peer2', text: '今天天气真好', own: false, likedByMe: false },
    ],
  });
  assert.equal(done.items.find((x) => x.id === 'own').own, true);
  assert.equal(done.items.find((x) => x.id === 'liked').likedByMe, true);
  assert.equal(done.items.find((x) => x.id === 'ok').own, false);
  assert.equal(done.items.find((x) => x.id === 'ok').likedByMe, false);
});

test('朋友圈发表：每日额度按 env.timezone 的日期重置', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-moments-tz-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const now = Date.UTC(2026, 0, 1, 4, 0); // 上海 12:00；纽约仍是 2025-12-31 23:00
  const publisher = new MomentsPublisher({
    config: {
      paths: { dataDir: root },
      env: { timezone: 'America/New_York' },
      moments: {
        publishFeatureEnabled: true, publishEnabled: true, publishAccount: 'acct',
        publishIntervalHours: 6, publishMaxPerDay: 1, publishWithImage: false,
      },
    },
    now: () => now,
  });
  publisher.queueDraft({ text: '慢慢找到自己的节奏，今天也值得认真度过。', emotion: 'happy' }, 'acct', publisher.settings(), { hash: 'fixture', lastSource: now });
  const job = publisher.claim('acct');
  assert.equal(publisher.state.day, '2025-12-31');
  assert.equal(publisher.dailyCount(), 1);
  assert.equal(publisher.complete({ id: job.id, account: 'acct', publishStatus: 'failed' }), true);
  assert.equal(publisher.dailyCount(), 0);
});

test('朋友圈发表：领取后从领取时刻计时，排队久也不会误判过期', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-moments-ttl-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  let now = 1_000_000;
  const publisher = new MomentsPublisher({
    config: {
      paths: { dataDir: root },
      moments: {
        publishFeatureEnabled: true, publishEnabled: true, publishAccount: 'acct',
        publishIntervalHours: 6, publishMaxPerDay: 1, publishWithImage: false,
      },
    },
    now: () => now,
  });
  publisher.queueDraft({ text: '慢慢找到自己的节奏，今天也值得认真度过。', emotion: 'happy' }, 'acct', publisher.settings(), { hash: 'fixture', lastSource: now });
  now += 110_000; // 排队 110 秒，仍可领取
  const job = publisher.claim('acct');
  assert.ok(job, '排队 110 秒后仍应能领取');
  now += 60_000; // 领取后 60 秒，应仍然有效
  assert.equal(publisher.allowed(job.id, 'acct'), true);
  now += 70_000; // 领取后 130 秒，超过任务时限
  assert.equal(publisher.allowed(job.id, 'acct'), false);
});

test('朋友圈发表：状态查询清除过期排队，已领取超时仍保留额度和去重游标', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-moments-expired-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = 1_000_000;
  const config = { paths: { dataDir: root }, moments: { publishFeatureEnabled: true, publishMaxPerDay: 1 } };
  const publisher = new MomentsPublisher({ config, now: () => now });
  const draft = { text: '慢慢找到自己的节奏，今天也值得认真度过。', emotion: 'happy' };
  publisher.save({ status: 'generating' });
  publisher.queueDraft(draft, 'acct', publisher.settings(), { hash: 'queued', lastSource: now });
  now += 121_000;
  assert.equal(publisher.status().status, 'failed');
  assert.equal(publisher.job, null);
  assert.equal(publisher.dailyCount(), 0);

  publisher.queueDraft(draft, 'acct', publisher.settings(), { hash: 'claimed', lastSource: now });
  const job = publisher.claim('acct');
  now += 121_000;
  assert.equal(publisher.status().status, 'unconfirmed');
  assert.equal(publisher.dailyCount(), 1);
  assert.equal(publisher.state.lastHash, 'claimed');
  assert.equal(publisher.complete({ id: job.id, account: 'acct', publishStatus: 'failed' }), false);

  publisher.queueDraft(draft, 'acct', publisher.settings(), { hash: 'cancelled', lastSource: now });
  config.moments.publishFeatureEnabled = false;
  assert.equal(publisher.status().status, 'failed');
  assert.equal(publisher.job, null);
  assert.equal(publisher.dailyCount(), 1);
});


test('朋友圈配图在目录后建或图片放入子目录后可见，超大图不进入桥接', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-moments-images-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const publisher = new MomentsPublisher({ config: { paths: { dataDir: root }, moments: { publishWithImage: true } } });
  const draft = { text: '今天的天空很蓝，慢慢走也能看到新的风景。', emotion: 'happy' };
  publisher.queueDraft(draft, 'account', publisher.settings(), {});
  assert.equal(publisher.status().imageReason, 'no_usable_image');
  const folder = path.join(publisher.images, '开心', '新图');
  fs.mkdirSync(folder, { recursive: true });
  const image = path.join(folder, 'small.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS/8AAAAASUVORK5CYII=', 'base64'));
  const big = path.join(folder, 'too-big.png');
  fs.writeFileSync(big, 'x');
  fs.truncateSync(big, 8 * 1024 * 1024 + 1);
  publisher.queueDraft(draft, 'account', publisher.settings(), {});
  assert.equal(publisher.job.query.image, image);
  assert.equal(publisher.status().imageReason, 'selected');
  publisher.queueDraft(draft, 'account', publisher.settings(), {}, false);
  assert.equal(publisher.status().imageReason, 'disabled');
});


test('朋友圈内置图与表情包清单一致，三类自动补齐并保留已有图', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-moments-presets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.resolve(__dirname, '..');
  const publisher = new MomentsPublisher({ config: {
    root: repo, paths: { dataDir: root }, features: { stickers: false },
    moments: { publishFeatureEnabled: true },
  } });
  const existing = path.join(publisher.images, '开心', 'custom.png');
  fs.mkdirSync(path.dirname(existing), { recursive: true });
  fs.writeFileSync(existing, 'keep-my-image');
  assert.equal(await publisher.prepareImages(), 27);
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'assets/stickers/manifest.json'), 'utf8'));
  for (const item of manifest.files)
    assert.deepEqual(fs.readFileSync(path.join(publisher.images, item.file)),
      fs.readFileSync(path.join(repo, 'assets/stickers', item.file)));
  assert.equal(await publisher.prepareImages(), 0);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep-my-image');
  assert.equal(publisher.config.features.stickers, false);
});

test('素材不足时清除上次文案和配图状态，本次没有进入发表队列', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-moments-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const publisher = new MomentsPublisher({ config: {
    root, paths: { dataDir: root }, moments: { publishFeatureEnabled: true },
  }, store: { sessions: new Map() } });
  publisher.preview = { text: '旧内容', image: '', imageReason: 'disabled' };
  publisher.save({ lastImageReason: 'selected', lastImage: true, lastImageCategory: '开心' });
  assert.equal(publisher.queueTest('account', true), '');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(publisher.status().status, 'no_material');
  assert.equal(publisher.status().preview, '');
  assert.equal(publisher.status().imageReason, '');
  assert.equal(publisher.status().image, false);
  assert.equal(publisher.claim('account'), null);
});

function automaticFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-moments-auto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse('2026-11-19T10:00:00+08:00');
  const messages = options.messages ?? [{ role: 'user', ts: now - 1000, text: '刚刚走到公园看到树叶黄了' }];
  const store = { sessions: new Map([['wechat:g:fixture', { messages }]]), messages: () => messages };
  const logs = [];
  let calls = 0;
  const config = { root, paths: { dataDir: root }, env: { timezone: 'Asia/Shanghai' }, moments: {
    publishFeatureEnabled: true, publishEnabled: true, publishAccount: 'fixture', ...options.moments,
  } };
  const create = () => new MomentsPublisher({ config, store,
    now: () => now, random: options.random || (() => 0), logger: { info: line => logs.push(line) },
    llm: { complete: async () => { calls++; return options.raw ?? '{"text":"我去这个面包好好吃啊","emotion":"happy"}'; } },
  });
  const publisher = create();
  publisher.save({ scheduleAccount: 'fixture', lastCheck: now - 3600000 });
  return { root, store, logs, publisher, config, create, get now() { return now; },
    set now(value) { now = value; }, get calls() { return calls; } };
}

test('自动发表：08:00 包含、23:30 排除，跨日额度和时区一致', () => {
  const { eligibility, eligibleNow } = require('../src/services/momentsScheduler');
  const cfg = { timezone: 'Asia/Shanghai' };
  const at = text => Date.parse('2026-11-19T' + text + '+08:00');
  assert.equal(eligibleNow(at('07:59:59'), {}, cfg), false);
  assert.equal(eligibleNow(at('08:00:00'), {}, cfg), true);
  assert.equal(eligibleNow(at('23:29:59'), {}, cfg), true);
  assert.equal(eligibleNow(at('23:30:00'), {}, cfg), false);
  assert.equal(eligibility(at('02:00:00'), {}, cfg).nextEligibleAt, at('08:00:00'));
  assert.equal(eligibility(at('23:30:00'), {}, cfg).nextEligibleAt, Date.parse('2026-11-20T08:00:00+08:00'));
  assert.equal(eligibility(at('10:00:00'), { day: '2026-11-19', count: 2 }, cfg).nextEligibleAt,
    Date.parse('2026-11-20T08:00:00+08:00'));
  assert.equal(eligibility(at('10:00:00'), {}, { ...cfg, muteDate: '2026-11-19' }).nextEligibleAt,
    Date.parse('2026-11-20T08:00:00+08:00'));
  assert.equal(eligibility(at('10:00:00'), { lastPublishAt: at('08:00:00') }, cfg).nextEligibleAt, at('11:00:00'));
  assert.equal(eligibleNow(at('10:00:00'), { day: '2026-11-18', count: 2 }, cfg), true);
  assert.equal(eligibleNow(at('20:00:00'), {}, { timezone: 'America/New_York' }), false);
  assert.equal(eligibleNow(at('10:00:00'), { lastPublishAt: at('07:00:00') }, cfg), true);
});

test('自动发表：配置可覆盖默认值，旧 intervalHours 缺失或非法时回退', () => {
  const { scheduleSettings, eligibleNow } = require('../src/services/momentsScheduler');
  assert.equal(scheduleSettings().intervalHours, 6);
  for (const value of [null, '', -1, 'bad', Infinity]) assert.equal(scheduleSettings({ intervalHours: value }).intervalHours, 6);
  assert.equal(scheduleSettings({ intervalHours: 0.5 }).intervalHours, 0.5);
  const now = Date.parse('2026-11-19T10:00:00+08:00');
  const state = { day: '2026-11-19', count: 2, lastPublishAt: now - 2 * 3600000 };
  assert.equal(eligibleNow(now, state, { timezone: 'Asia/Shanghai', activeStart: '09:00', activeEnd: '11:00',
    maxPerDay: 3, minGapHours: 1 }), true);
  assert.equal(eligibleNow(now, {}, { timezone: 'Asia/Shanghai', activeStart: '11:00' }), false);
});

test('自动发表：概率未命中后小时内不重抽，重启与连续三天空白不补发', async t => {
  let rolls = 0;
  const f = automaticFixture(t, { random: () => { rolls++; return 0.25; } });
  f.publisher.claim('fixture');
  assert.equal(rolls, 1);
  assert.equal(f.calls, 0);
  f.publisher.claim('fixture');
  f.create().claim('fixture');
  assert.equal(rolls, 1);
  f.now += 3 * 24 * 3600000;
  f.publisher.claim('fixture');
  assert.equal(rolls, 2, '离线多日也只抽本轮，不补历史轮次');
  assert.equal(f.calls, 0);
  assert.equal(f.publisher.job, null);
  assert.ok(f.logs.includes('[moments] tick eligible=false reason=jitter_miss'));
  assert.ok(f.logs.includes('[moments] tick eligible=false reason=hourly_wait'));
});

test('自动发表：夜间、静音、日上限和冷却都不抽样或调用模型', t => {
  let rolls = 0;
  const f = automaticFixture(t, { random: () => { rolls++; return 0; } });
  f.config.moments.muteDate = '2026-11-19';
  f.publisher.claim('fixture');
  f.config.moments.muteDate = '';
  f.publisher.save({ day: '2026-11-19', count: 2 });
  f.publisher.claim('fixture');
  f.publisher.save({ count: 0, lastPublishAt: f.now - 2 * 3600000 });
  f.publisher.claim('fixture');
  f.now = Date.parse('2026-11-19T02:00:00+08:00');
  f.publisher.claim('fixture');
  assert.equal(rolls, 0);
  assert.equal(f.calls, 0);
  for (const reason of ['muted', 'daily_limit', 'min_gap', 'inactive_hours'])
    assert.ok(f.logs.includes('[moments] tick eligible=false reason=' + reason));
});

test('自动发表：只有昨日聊天时没有素材，不调用模型且不重复尝试', async t => {
  const f = automaticFixture(t, { messages: [{ role: 'user', ts: Date.parse('2026-11-18T23:00:00+08:00'), text: '昨晚看到了很漂亮的月亮' }] });
  f.publisher.claim('fixture');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.publisher.status().status, 'no_material');
  assert.equal(f.calls, 0);
  assert.equal(f.publisher.dailyCount(), 0);
  assert.equal(f.publisher.job, null);
  f.publisher.claim('fixture');
  assert.equal(f.calls, 0);
});

test('自动发表：模型空输出直接跳过，不重试、不入队、不占额度', async t => {
  for (const raw of ['', '  ', 'null', '{"text":""}', '{"text":"  ","emotion":"happy"}', '{"text":null}']) {
    const f = automaticFixture(t, { raw });
    f.publisher.claim('fixture');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.publisher.status().status, 'skip_no_text', JSON.stringify(raw));
    assert.equal(f.calls, 1);
    assert.equal(f.publisher.job, null);
    assert.equal(f.publisher.dailyCount(), 0);
    assert.equal(f.publisher.state.lastSource, undefined);
    f.publisher.claim('fixture');
    assert.equal(f.calls, 1);
  }
});

test('自动发表：当日日记摘要或事件卡可以独立供稿', async t => {
  for (const kind of ['diary', 'event']) {
    const f = automaticFixture(t, { messages: [] });
    if (kind === 'diary') {
      fs.mkdirSync(path.join(f.root, 'diary'));
      fs.writeFileSync(path.join(f.root, 'diary', 'index.json'), JSON.stringify({ entries: {
        '2026-11-19': { createdAt: f.now - 1000, summary: '下午试着学了一段新的舞蹈' },
      } }));
    } else {
      f.store.chatStore = { chats: new Map([['wechat:g:fixture', { people: new Map([['peer', {
        name: '伙伴', events: [{ date: '2026-11-19', createdAt: f.now - 1000, summary: '一起看了傍晚的彩霞' }],
      }]]) }]]) };
    }
    f.publisher.claim('fixture');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls, 1, kind);
    assert.equal(f.publisher.job?.status, 'queued', kind);
    assert.equal(f.publisher.dailyCount(), 0);
  }
});

test('自动发表：领取时记录三小时冷却，未确认回执和重启后仍生效', async t => {
  const f = automaticFixture(t);
  f.publisher.claim('fixture');
  await new Promise(resolve => setImmediate(resolve));
  const job = f.publisher.claim('fixture');
  assert.equal(job.action, 'publish');
  assert.equal(f.publisher.state.lastPublishAt, f.now);
  assert.equal(f.publisher.status().todayCount, 1);
  assert.equal(f.publisher.status().nextEligibleAt, f.now + 3 * 3600000);
  f.publisher.complete({ id: job.id, account: 'fixture', publishStatus: 'unconfirmed' });
  f.now += 2 * 3600000;
  f.create().claim('fixture');
  assert.equal(f.calls, 1);
  assert.equal(f.publisher.dailyCount(), 1);
});

test('自动发表：生成后跨入 23:30 不再领取', async t => {
  const f = automaticFixture(t);
  f.now = Date.parse('2026-11-19T23:29:59+08:00');
  f.publisher.claim('fixture');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.publisher.job?.status, 'queued');
  f.now += 1000;
  assert.equal(f.publisher.claim('fixture'), null);
  assert.equal(f.publisher.job, null);
  assert.equal(f.publisher.dailyCount(), 0);
});

test('自动发表：概率覆盖为 0 时永不调用模型，为 1 时仍需有素材', async t => {
  const disabled = automaticFixture(t, { moments: { attemptProbability: 0 } });
  disabled.publisher.claim('fixture');
  assert.equal(disabled.calls, 0);
  const enabled = automaticFixture(t, { moments: { attemptProbability: 1 }, random: () => 0.999 });
  enabled.publisher.claim('fixture');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(enabled.calls, 1);
  assert.equal(enabled.publisher.job?.status, 'queued');
  const empty = automaticFixture(t, { messages: [], moments: { attemptProbability: 1 } });
  empty.publisher.claim('fixture');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(empty.calls, 0);
  assert.equal(empty.publisher.status().status, 'no_material');
});

test('自动发表：默认两条后当天不再尝试，跨日恢复且不补发', async t => {
  const options = {};
  const f = automaticFixture(t, options);
  for (let i = 0; i < 2; i++) {
    f.publisher.claim('fixture');
    await new Promise(resolve => setImmediate(resolve));
    const job = f.publisher.claim('fixture');
    assert.equal(job.action, 'publish');
    f.publisher.complete({ id: job.id, account: 'fixture', publishStatus: 'confirmed' });
    f.now += 3 * 3600000;
    f.store.messages().push({ role: 'user', ts: f.now - 1000, text: '刚刚去旁边的小店逛了一圈' });
    options.raw = '{"text":"吃完饭现在只想躺一会儿","emotion":"happy"}';
  }
  assert.equal(f.publisher.dailyCount(), 2);
  f.publisher.claim('fixture');
  assert.equal(f.calls, 2);
  f.now = Date.parse('2026-11-20T10:00:00+08:00');
  f.publisher.claim('fixture');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.publisher.dailyCount(), 0);
  assert.equal(f.publisher.status().status, 'no_material');
  assert.equal(f.calls, 2);
});

test('朋友圈确认发布后落长期生活记忆，失败或未确认不落', async t => {
  const lifeOf = (f) => path.join(f.root, 'moments', 'self-life.json');

  // 确认发出 → 落一条
  const ok = automaticFixture(t);
  ok.publisher.claim('fixture');
  await new Promise(resolve => setImmediate(resolve));
  const okJob = ok.publisher.claim('fixture');
  assert.equal(okJob.action, 'publish');
  ok.publisher.complete({ id: okJob.id, account: 'fixture', publishStatus: 'confirmed' });
  const okLife = JSON.parse(fs.readFileSync(lifeOf(ok), 'utf8'));
  assert.equal(okLife.length, 1);
  assert.equal(okLife[0].text, '我去这个面包好好吃啊');
  assert.equal(okLife[0].date, '2026-11-19');
  assert.equal(typeof okLife[0].at, 'number');

  // 失败 → 不落
  const fail = automaticFixture(t);
  fail.publisher.claim('fixture');
  await new Promise(resolve => setImmediate(resolve));
  const failJob = fail.publisher.claim('fixture');
  fail.publisher.complete({ id: failJob.id, account: 'fixture', publishStatus: 'failed' });
  assert.equal(fs.existsSync(lifeOf(fail)), false);

  // 未确认 → 不落
  const unk = automaticFixture(t);
  unk.publisher.claim('fixture');
  await new Promise(resolve => setImmediate(resolve));
  const unkJob = unk.publisher.claim('fixture');
  unk.publisher.complete({ id: unkJob.id, account: 'fixture', publishStatus: 'unconfirmed' });
  assert.equal(fs.existsSync(lifeOf(unk)), false);
});

test('生活记忆同一天同文案去重，最多保留最近 60 条', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-self-life-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.parse('2026-11-19T10:00:00+08:00');
  const p = new MomentsPublisher({
    config: { root, paths: { dataDir: root }, env: { timezone: 'Asia/Shanghai' }, moments: {} },
    now: () => now,
  });
  const file = path.join(root, 'moments', 'self-life.json');

  // 同一天同文案：只落一次
  p.job = { query: { text: '今天买了棉花糖吃' } };
  p.rememberLife();
  p.rememberLife();
  let list = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '今天买了棉花糖吃');

  // 不同文案累计，超过 60 条裁掉最旧的
  for (let i = 0; i < 70; i++) {
    p.job = { query: { text: `今天去做了第 ${i} 件事` } };
    p.rememberLife();
  }
  list = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(list.length, 60);
  assert.equal(list[0].text, '今天去做了第 10 件事');
  assert.equal(list[59].text, '今天去做了第 69 件事');
});
