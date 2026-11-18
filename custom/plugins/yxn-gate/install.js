'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..', '..');
const pluginsDir = path.join(root, 'app', 'data', 'plugins');
const manifest = require('./plugin.json');
const { Id: id, Version: version } = manifest;

function buildZip(file) {
  // 通过环境变量传路径，避免 PowerShell 对路径中的引号或特殊字符求值。
  const command = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($env:YXN_GATE_ZIP, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($name in @('plugin.json', 'plugin.js')) {
    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $env:YXN_GATE_SOURCE $name), $name)
  }
} finally { $zip.Dispose() }
`;
  execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, YXN_GATE_SOURCE: __dirname, YXN_GATE_ZIP: file },
    windowsHide: true,
  });
}

function readJsonIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function main(args) {
  const [mode] = args;
  if (args.length !== 1 || !['--pack', '--enable-full-access'].includes(mode)) {
    console.error('用法：node install.js --pack 或 node install.js --enable-full-access');
    process.exitCode = 2;
    return;
  }

  const packOnly = mode === '--pack';
  const dir = packOnly ? __dirname : pluginsDir;
  const target = packOnly ? `${id}-${version}.zip` : `${id}.zip`;
  fs.mkdirSync(dir, { recursive: true });
  const staged = new Map();
  function stage(name) {
    const file = path.join(dir, `${id}.${randomUUID()}.tmp`);
    staged.set(name, file);
    return file;
  }
  try {
    buildZip(stage(target));
    if (!packOnly) {
      const flow = Buffer.from(JSON.stringify({
        id, api: manifest.Api, kind: manifest.Kind, hooks: manifest.Hooks,
        permissions: manifest.Permissions, executionTimeoutMs: manifest.ExecutionTimeoutMs,
        javascript: fs.readFileSync(path.join(__dirname, 'plugin.js'), 'utf8'),
      }));
      const hash = createHash('sha256').update(flow).digest('hex');
      const settingsName = `${id}.flow-settings.json`;
      const grantName = `${id}.flow-grant.json`;
      const marker = `${id}.enabled`;
      const settings = readJsonIfPresent(path.join(dir, settingsName))
        ?? readJsonIfPresent(path.join(dir, grantName))?.settings ?? manifest.Settings;
      const settingsJson = JSON.stringify(settings);
      if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Buffer.byteLength(settingsJson) > 65536) {
        throw new Error('插件设置无效或超过 64 KiB');
      }
      fs.writeFileSync(stage(`${id}.flow.json`), flow);
      fs.writeFileSync(stage(settingsName), settingsJson);
      fs.writeFileSync(stage(grantName), JSON.stringify({ enabled: true, fullAccess: true, hash, settings }));
      fs.writeFileSync(stage(marker), '');
      // 授权文件和源码必须配对，最后发布启用标记以避免宿主读取半套文件。
      fs.rmSync(path.join(dir, marker), { force: true });
    }
    for (const [name, file] of staged) fs.renameSync(file, path.join(dir, name));
    console.log(path.join(dir, target));
  } finally {
    for (const file of staged.values()) fs.rmSync(file, { force: true });
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error('[yxn-gate] 安装文件生成失败', error.code || error.name, error.message);
  process.exitCode = 1;
}
