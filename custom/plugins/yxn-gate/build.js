'use strict';

/** 打包 yxn-gate：生成 flow.json / grant / enabled，并打印 zip 命令 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
const code = fs.readFileSync(path.join(root, 'plugin.js'), 'utf8');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const flow = {
  id: manifest.Id,
  name: manifest.Name,
  api: 4,
  kind: 'message',
  hooks: manifest.Hooks,
  permissions: ['system.full'],
  executionTimeoutMs: manifest.ExecutionTimeoutMs || 20000,
  resultLabel: manifest.ResultLabel,
  minAppVersion: manifest.MinAppVersion,
  javascript: code,
};
const flowPath = path.join(dist, `${manifest.Id}.flow.json`);
fs.writeFileSync(flowPath, JSON.stringify(flow), 'utf8');
const hash = crypto.createHash('sha256').update(fs.readFileSync(flowPath)).digest('hex');

const grant = { enabled: true, fullAccess: true, hash, settings: {} };
fs.writeFileSync(path.join(dist, `${manifest.Id}.flow-grant.json`), JSON.stringify(grant), 'utf8');
fs.writeFileSync(path.join(dist, `${manifest.Id}.enabled`), '');
console.log(`flow=${flowPath} hash=${hash}`);
console.log(`zip: ${manifest.Id}-${manifest.Version}.zip`);
