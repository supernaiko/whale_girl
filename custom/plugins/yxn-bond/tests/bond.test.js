'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { decayMood, eventsFromText, applyEvents, moodLabel, bondTier } = require('../plugin.js').__test;

test('识别夸奖 / 骂人 / 关心 / 撒娇', () => {
  assert.deepEqual(eventsFromText('你真厉害'), ['praise']);
  assert.deepEqual(eventsFromText('这都做不好，废物'), ['insult']);
  assert.deepEqual(eventsFromText('早点睡吧'), ['care']);
  assert.deepEqual(eventsFromText('贴贴'), ['flirt']);
  assert.deepEqual(eventsFromText('今天天气不错'), []);
});

test('被骂心情掉、精力升', () => {
  const m = applyEvents({ valence: 60, energy: 50 }, ['insult']);
  assert.ok(m.valence < 60);
  assert.ok(m.energy > 50);
});

test('心情会向基线回落', () => {
  const now = Date.now();
  const m = decayMood({ valence: 95, energy: 95, updatedAt: now - 12 * 3600 * 1000 }, { valence: 55, energy: 50 }, now);
  assert.ok(m.valence < 95 && m.valence > 55);
  assert.ok(m.energy < 95 && m.energy > 50);
});

test('心情标签分档', () => {
  assert.equal(moodLabel({ valence: 80, energy: 70 }), '心情很好');
  assert.equal(moodLabel({ valence: 60, energy: 50 }), '平静');
  assert.equal(moodLabel({ valence: 40, energy: 50 }), '不太高兴');
  assert.equal(moodLabel({ valence: 40, energy: 20 }), '又累又低落');
});

test('厌倦感：无聊高时优先说无聊', () => {
  assert.equal(moodLabel({ valence: 80, energy: 70, boredom: 75 }), '有点无聊，想找点新鲜的');
  assert.equal(moodLabel({ valence: 40, energy: 50, boredom: 20 }), '不太高兴');
});

test('被夸/互动让厌倦感回落', () => {
  const m = applyEvents({ valence: 65, energy: 55, boredom: 80 }, ['praise']);
  assert.ok(m.boredom < 80);
  assert.ok(m.boredom >= 0);
});

test('没新鲜事厌倦感缓慢上升', () => {
  const now = Date.now();
  const m = decayMood({ valence: 65, energy: 55, boredom: 15, updatedAt: now - 24 * 3600 * 1000 }, { valence: 65, energy: 55, boredom: 15 }, now);
  assert.ok(m.boredom > 15 && m.boredom <= 100);
});

test('亲近档位', () => {
  assert.equal(bondTier(90), '很亲近');
  assert.equal(bondTier(60), '朋友');
  assert.equal(bondTier(30), '点头之交');
  assert.equal(bondTier(10), '不太熟');
});

test('数值永远 0~100', () => {
  let m = { valence: 99, energy: 99 };
  for (let i = 0; i < 20; i += 1) m = applyEvents(m, ['praise']);
  assert.ok(m.valence <= 100 && m.energy <= 100);
  let n = { valence: 1, energy: 1 };
  for (let i = 0; i < 20; i += 1) n = applyEvents(n, ['insult']);
  assert.ok(n.valence >= 0 && n.energy >= 0);
});
