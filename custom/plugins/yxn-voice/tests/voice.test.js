'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { stats, styleLine, clean } = require('../plugin.js').__test;

test('清理标记', () => {
  assert.equal(clean('好 [[sticker:开心]]'), '好');
  assert.equal(clean('嗯 [[diary:2026-11-18]]'), '嗯');
});

test('空样本不产话', () => {
  assert.equal(styleLine(stats([])), '');
  assert.equal(styleLine(stats(['嗯', '行'])), '');
});

test('短句为主时说短', () => {
  const st = stats(['嗯', '行吧', '好', '可以', '哦', '诶', '好吧', '行', '嗯嗯', '好']);
  assert.ok(st.n >= 8);
  assert.equal(st.short, 100);
  const line = styleLine(st);
  assert.match(line, /一句话就够/);
  assert.match(line, /句号/);
});

test('常用开头会被识别', () => {
  const list = Array.from({ length: 10 }, (_, i) => '嗯' + i);
  const st = stats(list);
  assert.deepEqual(st.openers, ['嗯']);
});

test('表情比例', () => {
  const st = stats(['好呀😊', '嗯', '行', '好', '哦', '诶', '行', '好', '嗯', '行']);
  assert.equal(st.emoji, 10);
});

test('注入行不超过一行', () => {
  const st = stats(Array.from({ length: 20 }, () => '嗯行'));
  const line = styleLine(st);
  assert.ok(line.length < 120, line);
  assert.ok(line.startsWith('【说话方式】'));
});
