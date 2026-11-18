'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseReply } = require('../src/services/localReply');

test('chat template: 只取 assistant 之后的正文', () => {
  const raw = [
    '今天好累啊，不想上班',
    '<|im_end|>',
    '<|im_start|>assistant',
    '那就早点躺平',
    '',
    '[ Prompt: 55.1 t/s | Generation: 15.7 t/s ]',
  ].join('\n');
  assert.equal(parseReply(raw, 'x'), '那就早点躺平');
});

test('classic echo: > 之后跳过 prompt 行', () => {
  const prompt = '你叫雅小奈\n对方说：在干嘛呢\n你回：';
  const raw = ['> 你叫雅小奈', '对方说：在干嘛呢', '你回：', '躺着刷手机呢', '', '[ Prompt: 1 t/s ]'].join('\n');
  assert.equal(parseReply(raw, prompt), '躺着刷手机呢');
});

test('拒绝道歉腔与空输出', () => {
  assert.equal(parseReply('<|im_start|>assistant\nI am sorry, I cannot help.', 'x'), '');
  assert.equal(parseReply('', 'x'), '');
});
