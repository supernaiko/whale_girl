'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { describeError } = require('../infra/errors');

const MAX_BYTES = 1024n ** 3n;
const JOB_TTL = 90_000;
const RESULT_TTL = 300_000;
const RESULTS = {
  submitted: '',
  unconfirmed: '微信发送结果未能确认，请先查看目标会话。若有附件草稿，请手动清空。',
  target_unavailable: '无法唯一定位目标会话或验证微信窗口。',
  blocked: '当前微信账号、会话或插件授权不允许发送。',
  file_changed: '文件已变化或无法读取，请重新发起命令。',
  failed: '微信未能提交附件，请检查目标会话和输入框草稿。',
  note_failed: '本机微信已记录文件消息，附言发送失败。',
  expired: '桥接未在有效期内领取文件任务。',
};

function reject(status, error) { return { status, error }; }

class FileSendQueue {
  constructor(runtime) {
    this.runtime = runtime;
    this.jobs = new Map();
  }

  async sendFile(chat, file, note = '', pluginId) {
    if (typeof chat !== 'string' || !chat.trim() || chat.length > 160 || /[\x00-\x1f]/.test(chat)) {
      return reject(400, '请提供有效的微信会话名称或 ID。');
    }
    if (typeof note !== 'string' || note.length > 4000 || note.includes('\0')) {
      return reject(400, '附言必须是最多 4000 字的文本。');
    }
    if (typeof file !== 'string' || file.includes('\0') || !path.isAbsolute(file)
        || (process.platform === 'win32' && path.parse(file).root.length < 3)) {
      return reject(400, '请提供绝对文件路径。');
    }
    let info;
    try {
      file = await fs.realpath(file);
      info = await fs.stat(file, { bigint: true });
    } catch (err) {
      this.runtime.logger.warn('[send-file] ' + describeError({ name: err.name, code: err.code,
        status: 400, detail: '本地文件解析或读取失败' }));
      return reject(400, '文件不存在或无法读取。');
    }
    if (!info.isFile()) return reject(400, '路径必须指向普通文件。');
    if (info.size > MAX_BYTES) return reject(413, '文件大小不能超过 1 GB。');

    const gw = this.runtime.gateways.get('wechat');
    const gateway = gw?.status();
    if (!gateway?.enabled || !gateway.bridge?.online || !gateway.bridge.account) {
      return reject(503, '微信桥接未就绪，请启动桥接并确认微信已登录。');
    }
    const plugins = this.runtime.bot?.javascriptPlugins;
    const pluginHash = pluginId && plugins?.installed().find(plugin => plugin.id === pluginId)?.hash;
    if (pluginId && !pluginHash) return reject(403, '插件发送授权已撤回。');

    this.sweep();
    if (this.jobs.size >= 64) return reject(429, '文件任务队列已满，请稍后再试。');
    const id = randomUUID();
    const job = { id, chat: chat.trim(), path: file, note, size: Number(info.size), modifiedNs: String(info.mtimeNs),
      account: gateway.bridge.account, wantedAccount: this.runtime.config.wechat?.account,
      pluginId, pluginHash, status: 'queued', until: Date.now() + JOB_TTL };
    this.jobs.set(id, job);
    this.runtime.logger.info(`[send-file] id=${id} status=queued bytes=${info.size} noteLength=${note.length}`);
    return { jobId: id };
  }

  allowed(job, account) {
    return job.account === account && job.wantedAccount === this.runtime.config.wechat?.account
      && this.runtime.gateways.get('wechat')?.options.enabled
      && (!job.pluginId || this.runtime.bot.javascriptPlugins.isApproved(job.pluginId, job.pluginHash));
  }

  claim(account) {
    this.sweep();
    for (const job of this.jobs.values()) {
      if (job.status !== 'queued' || job.account !== account) continue;
      if (!this.allowed(job, account)) {
        this.finish(job, 'blocked');
        continue;
      }
      job.status = 'sending';
      job.until = Date.now() + JOB_TTL;
      const { id, chat, path, note, size, modifiedNs } = job;
      return { id, chat, path, note, size, modifiedNs };
    }
    return null;
  }

  permission(id, account) {
    this.sweep();
    const job = this.jobs.get(id);
    return Boolean(job?.status === 'sending' && this.allowed(job, account));
  }

  ack(id, account, status) {
    this.sweep();
    const job = this.jobs.get(id);
    if (job?.status !== 'sending' || job.account !== account || typeof status !== 'string'
        || !Object.hasOwn(RESULTS, status) || status === 'expired') return false;
    this.finish(job, status);
    return true;
  }

  status(id) {
    this.sweep();
    const job = this.jobs.get(id);
    return job ? { jobId: id, status: job.status, error: RESULTS[job.status] || '' } : null;
  }

  finish(job, status) {
    this.jobs.set(job.id, { id: job.id, status, until: Date.now() + RESULT_TTL });
    if (status === 'submitted') this.runtime.logger.info(`[send-file] id=${job.id} status=${status}`);
    else this.runtime.logger.warn(`[send-file] id=${job.id} ` + describeError({ name: 'FileSendError',
      code: status, detail: RESULTS[status] }));
  }

  sweep() {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (job.until > now) continue;
      if (job.status === 'queued' || job.status === 'sending') {
        this.finish(job, job.status === 'queued' ? 'expired' : 'unconfirmed');
      } else {
        this.jobs.delete(job.id);
      }
    }
  }
}

module.exports = { FileSendQueue };
