'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const codex = require(path.join(__dirname, '..', 'src', 'services', 'momentsCodex'));

test('parseResult 从噪声里取出 JSON', () => {
  const raw = '思考中...\n{"pick":1,"text":"今天的风挺舒服"}\n';
  assert.deepStrictEqual(codex.parseResult(raw, 3), { pick: 1, text: '今天的风挺舒服' });
});

test('parseResult 拒绝越界下标和空文案', () => {
  assert.strictEqual(codex.parseResult('{"pick":9,"text":"x"}', 3), null);
  assert.strictEqual(codex.parseResult('{"pick":0,"text":""}', 3), null);
  assert.strictEqual(codex.parseResult('no json here', 3), null);
});

test('parseResult 容忍尾随说明文字', () => {
  const raw = 'note\n{"pick":0,"text":"吃面了"}\n以上。';
  assert.deepStrictEqual(codex.parseResult(raw, 1), { pick: 0, text: '吃面了' });
});

test('buildPrompt 强调只输出 JSON 且不少规矩', () => {
  const text = codex.buildPrompt({ name: '雅小奈', desc: '温柔', mood: '有点累', lines: ['开会'] });
  assert.match(text, /只输出一行 JSON/);
  assert.match(text, /不要描述照片画面/);
  assert.match(text, /雅小奈/);
});

test('没有图片时直接返回 null，不启动进程', async () => {
  assert.strictEqual(await codex.choose({ images: [] }), null);
});
