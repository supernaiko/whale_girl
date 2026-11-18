'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseRequest } = require('../src/services/wechatEmoticon');

test('内置表情请求只接受一个名称或方括号代码', () => {
  for (const code of ['微笑', '[微笑]', ' [微笑] ']) {
    assert.deepEqual(parseRequest({ chat: ' 目标会话 ', code }), { chat: '目标会话', code: '[微笑]' });
  }
  for (const code of ['🙂', '[微笑][捂脸]', '[微笑', '[ 微笑 ]', '微笑\n捂脸', {}, 'a'.repeat(21)]) {
    assert.deepEqual(parseRequest({ chat: '目标会话', code }), { reason: 'invalid_code' });
  }
  for (const chat of [null, '', 'a'.repeat(121), '会话\n', ['会话']]) {
    assert.deepEqual(parseRequest({ chat, code: '[微笑]' }), { reason: 'invalid_chat' });
  }
});
