'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Router } = require('../src/http/router');
const register = require('../src/http/routes/sendFile');
const { FileSendQueue } = require('../src/services/fileSendQueue');

const TOKEN = 'test-only-file-token';
const ACCOUNT = 'test-account';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-file-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, '季度 简报.pdf');
  await fs.writeFile(file, 'fixture');
  const gateway = {
    options: { enabled: true },
    status: () => ({ enabled: true, bridge: { online: true, account: ACCOUNT } }),
  };
  const config = { gateway: { wechat: { inboundToken: TOKEN } } };
  const runtime = { config, gateways: new Map([['wechat', gateway]]), logger: { warn() {}, info() {} } };
  runtime.fileSend = new FileSendQueue(runtime);
  const router = new Router(runtime);
  register(router);
  const server = http.createServer((req, res) => router.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/send-file';
  async function request(suffix, data, headers = {}) {
    const response = await fetch(base + suffix, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'x-bot-token': TOKEN, 'content-type': 'application/json', ...headers },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  }
  return { root, file, request, runtime };
}

test('文件接口校验本机 token、会话、绝对路径、文件类型、大小和附言', async t => {
  const { root, file, request } = await fixture(t);
  const input = { chat: '文件传输助手', path: file };
  assert.equal((await request('', input, { 'x-bot-token': 'wrong' })).status, 403);
  assert.equal((await request('', input, { origin: 'https://example.org' })).status, 403);
  const oversized = path.join(root, 'oversized.pdf');
  await fs.writeFile(oversized, '');
  await fs.truncate(oversized, (1024 ** 3) + 1);
  for (const change of [{ chat: '  ' }, { path: 'relative.pdf' }, { path: root },
    { path: path.join(root, 'missing.pdf') }, { note: 3 }]) {
    assert.equal((await request('', { ...input, ...change })).status, 400);
  }
  assert.equal((await request('', { ...input, path: oversized })).status, 413);
});

test('抢不到微信前台时先放回队列重试，重试次数用完才报失败', async t => {
  const { file, request, runtime } = await fixture(t);
  const out = await request('', { chat: '文件传输助手', path: file });
  const id = out.body.jobId;
  const subject = { id, account: ACCOUNT };
  const queue = runtime.fileSend;
  const status = () => request('/status?id=' + id);

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const claimed = (await request('/claim', { account: ACCOUNT })).body.item;
    assert.equal(claimed?.id, id);
    assert.equal((await request('/ack', { ...subject, status: 'target_unavailable' })).status, 200);
    assert.equal((await status()).body.status, attempt < 4 ? 'queued' : 'target_unavailable');
    if (attempt < 4) {
      // 冷却期内不重复领取，冷却结束后重新排上。
      assert.equal((await request('/claim', { account: ACCOUNT })).body.item, null);
      queue.jobs.get(id).notBefore = 0;
    }
  }
  assert.match((await status()).body.error, /窗口.*没能切到前台/);
});

test('仅入队绑定账号可领取，重复领取及重复回执不会再次推进任务', async t => {
  const { file, request } = await fixture(t);
  const out = await request('', { chat: ' 测试群 ', path: file, note: '附言' });
  assert.equal(out.status, 202);
  assert.equal(out.body.ok, true);
  const id = out.body.jobId;
  const status = () => request('/status?id=' + id);
  assert.equal((await status()).body.status, 'queued');
  assert.equal((await request('/claim', { account: 'other-account' })).body.item, null);
  const items = await Promise.all([request('/claim', { account: ACCOUNT }), request('/claim', { account: ACCOUNT })]);
  const claimed = items.map(result => result.body.item).filter(Boolean);
  assert.equal(claimed.length, 1);
  assert.deepEqual(claimed[0], { id, chat: '测试群', path: await fs.realpath(file), note: '附言', size: 7,
    modifiedNs: String((await fs.stat(file, { bigint: true })).mtimeNs) });
  const subject = { id, account: ACCOUNT };
  assert.equal((await request('/permission', subject)).body.allowed, true);
  assert.equal((await request('/ack', { ...subject, status: ['submitted'] })).status, 409);
  assert.equal((await request('/ack', { ...subject, status: 'unconfirmed' })).status, 200);
  assert.equal((await request('/ack', { ...subject, status: 'submitted' })).status, 409);
  assert.equal((await request('/permission', subject)).body.allowed, false);
  assert.equal((await status()).body.status, 'unconfirmed');
  assert.equal((await status()).body.path, undefined);
});
