'use strict';

/**
 * 颜文字 / emoji 控制器必须真的生效。
 *
 * 之前的 bug：调教台的「颜文字用量」只改提示词里的半句话，真正决定「加不加 emoji」的
 * 是 config.chat.emojiChance，默认 0 —— 于是无论选哪档都不出现颜文字；
 * 而且加料池里只有 emoji，没有颜文字。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const persona = require('../src/persona');

const cfgWith = (level, chance) => ({ persona: { emojiLevel: level }, chat: { emojiChance: chance } });

test('四档「颜文字用量」对应四个真实概率', () => {
  assert.equal(persona.emojiChanceFor(cfgWith('关', 0)), 0);
  assert.equal(persona.emojiChanceFor(cfgWith('少', 0)), 0.12);
  assert.equal(persona.emojiChanceFor(cfgWith('正常', 0)), 0.3);
  assert.equal(persona.emojiChanceFor(cfgWith('多', 0)), 0.65);
});

test('没调过档位时按「正常」算，不是永远不说话', () => {
  assert.equal(persona.emojiChanceFor({ persona: {}, chat: { emojiChance: 0 } }), 0.3);
  assert.equal(persona.emojiChanceFor({}), 0.3);
});

test('「关」是硬关，压过手动概率', () => {
  assert.equal(persona.emojiChanceFor(cfgWith('关', 0.9)), 0);
});

test('手动填了概率就用手动的（高级微调）', () => {
  assert.equal(persona.emojiChanceFor(cfgWith('正常', 0.5)), 0.5);
  assert.equal(persona.emojiChanceFor(cfgWith('多', 1)), 1);
});

test('颜文字池里有真的颜文字，不是占位符', () => {
  assert.ok(Array.isArray(persona.KAOMOJI) && persona.KAOMOJI.length >= 5);
  for (const k of persona.KAOMOJI) {
    assert.equal(typeof k, 'string');
    assert.ok(k.length >= 3, '颜文字太短：' + k);
    assert.ok(/[()（）]/.test(k) || /qwq|ᕕ/.test(k), '看起来不像颜文字：' + k);
  }
  assert.equal(typeof persona.kaomojiPick(() => 0.5), 'string');
});

// 「关时不加料」「多加颜文字」「已带 emoji 跳过」三类行为在 bot.test.js 的
// 「追加表情按整轮剩余字数决定…」里通过 finalize()（生产真实链路）覆盖，
// pickEmoji 死代码删除后不再单独测。
