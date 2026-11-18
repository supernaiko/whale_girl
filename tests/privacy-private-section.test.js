const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { buildPromptParts } = require('../src/persona');

// 每条用例用不同正文，避免模块级缓存互相干扰
const mk = (tag) => `你是雅小奈${tag}。\n\n【我们之间】\n- 主人上个月跳槽${tag}，压力大。\n- 主人怕黑${tag}。`;

function system(persona = {}, msg = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  Object.assign(config.persona, persona);
  return buildPromptParts({ config, msg: { chatType: 'private', text: '早', ...msg }, now: new Date(2026, 10, 18, 10) }).system;
}

test('人设带隐私红线', () => {
  const s = system({ customPrompt: '你是雅小奈。' });
  assert.ok(s.includes('你和别人的私聊只属于那段对话'));
});

test('主人能看到「我们之间」', () => {
  const s = system({ customPrompt: mk('甲') }, { isMaster: true });
  assert.ok(s.includes('【我们之间】'));
  assert.ok(s.includes('跳槽甲'));
});

test('非主人看不到「我们之间」', () => {
  const s = system({ customPrompt: mk('乙') }, { isMaster: false });
  assert.ok(!s.includes('【我们之间】'));
  assert.ok(!s.includes('跳槽乙'));
  assert.ok(s.includes('雅小奈乙'));
});

test('群里也按发言者身份过滤', () => {
  const s = system({ customPrompt: mk('丙') }, { chatType: 'group', isMaster: false });
  assert.ok(!s.includes('跳槽丙'));
});
