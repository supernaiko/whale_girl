'use strict';
/**
 * 朋友圈出图：把「角色卡 + 场景」交给 Codex 画成一张图。
 * 独立成模块，方便以后换图像模型；发布流程只依赖 paint()。
 */
const fs = require('node:fs');
const path = require('node:path');
const momentsCodex = require('./momentsCodex');

function characterCard(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'moments', 'character.json'), 'utf8'));
  } catch { return null; }
}

async function paint({ dataDir, scene, frontView = false, reference = '', view = 'auto', logger } = {}) {
  if (!dataDir || !scene) return '';
  if (!momentsCodex.available || !momentsCodex.available()) return '';
  const dir = path.join(dataDir, 'moments', 'post-images', 'paint');
  const file = path.join(dir, 'paint-' + Date.now() + '.png');
  try {
    const got = await momentsCodex.generateImage({
      scene, character: characterCard(dataDir), outFile: file, frontView, reference, view,
    });
    if (got && got.file) { logger?.info?.('[moments] paint ok ms=' + got.ms); return got.file; }
  } catch (error) { logger?.warn?.('[moments] paint error: ' + error.message); }
  return '';
}

module.exports = { paint, characterCard };
