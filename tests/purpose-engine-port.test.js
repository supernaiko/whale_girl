'use strict';
/**
 * surfcore purpose-engine 移植冒烟测试：验证 50 个导出的核心链路在 CJS 下正常。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const pe = require('../src/services/purposeEngine.js');

const now = Date.now();
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

test('配置归一化：坏值回默认、安静时段解析正确', () => {
  const cfg = pe.normalizePurposeConfig({ gapMinMs: 'x', dailyMax: 99, quietStart: '23:30', quietEnd: '08:30' });
  assert.strictEqual(cfg.gapMinMs, pe.DEFAULT_PURPOSE_CONFIG.gapMinMs, '非法 gapMinMs 回默认');
  assert.strictEqual(cfg.dailyMax, 24, 'dailyMax 夹到 0~24');
  assert.strictEqual(cfg.quietStart, '23:30');
  assert.strictEqual(cfg.quietEnd, '08:30');
});

test('安静时段判定：凌晨 2 点在安静、下午 3 点不在', () => {
  const night = new Date(now); night.setHours(2, 0, 0, 0);
  const afternoon = new Date(now); afternoon.setHours(15, 0, 0, 0);
  assert.strictEqual(pe.inQuietHours(night.getTime()), true);
  assert.strictEqual(pe.inQuietHours(afternoon.getTime()), false);
});

test('排程：due 之后才 run，主人空闲足够久', () => {
  const noon = new Date(); noon.setHours(15, 0, 0, 0); // 下午 3 点，非安静时段
  const t = noon.getTime();
  const st = pe.createPurposeState(t);
  st.nextFireAt = t - 1000; // 已到点
  const cfg = pe.normalizePurposeConfig({});
  const tick = pe.evaluatePurposeTick({ now: t, config: cfg, state: st, env: { ownerIdleMs: 12 * 3600 * 1000 } });
  assert.strictEqual(tick.action, 'run');
});

test('素材采集：主人私聊内容进 owner、群友进 member', () => {
  const cfg = pe.normalizePurposeConfig({});
  const convs = [
    {
      key: 'private:wxid_owner',
      recentMessages: [
        { text: '明天下午三点面试，有点紧张', time: now - HOUR, isSelf: false, isOwner: true, sender: '主人' },
        { text: '我陪你去', time: now - 30 * 60000, isSelf: true, isOwner: false, sender: '雅小奈' },
      ],
    },
    {
      key: 'group:g1',
      recentMessages: [
        { text: '有人一起打游戏吗', time: now - 2 * HOUR, isSelf: false, isOwner: false, sender: '群友A' },
      ],
    },
  ];
  const { items } = pe.collectMaterials({ now, config: cfg, ownerUin: 'wxid_owner', conversations: convs });
  const ownerItem = items.find((m) => m.kind === 'owner');
  assert.ok(ownerItem, '主人消息进素材');
  assert.ok(ownerItem.text.includes('面试'));
});

test('目标归属：主人「面试」生成关心目标，群友想玩不变成自己目标', () => {
  const cfg = pe.normalizePurposeConfig({});
  const convs = [
    {
      key: 'private:wxid_owner',
      recentMessages: [{ text: '明天面试我好慌', time: now - HOUR, isSelf: false, isOwner: true, sender: '主人' }],
    },
    {
      key: 'group:g1',
      recentMessages: [{ text: '周末一起打游戏吗', time: now - 2 * HOUR, isSelf: false, isOwner: false, sender: '群友A' }],
    },
  ];
  const { items } = pe.collectMaterials({ now, config: cfg, ownerUin: 'wxid_owner', conversations: convs });
  const { goals } = pe.formGoalHypotheses({ materials: items, now, config: cfg, lastMasterAt: now - 3 * HOUR });
  const careGoal = goals.find((g) => g.domain === 'care' && g.owner === 'owner');
  assert.ok(careGoal, '主人面试 → 关心目标（owner 归属）');
  // 群友的游戏不应该是 self 的 play 目标（除非重复/点名）
  const selfPlay = goals.find((g) => g.domain === 'play' && g.owner === 'self');
  assert.ok(!selfPlay, '群友想玩游戏不该直接变成她自己的 play 目标');
});

test('提示词本地化：出现「微信·主人」，不出现「QQ·主人」', () => {
  const cfg = pe.normalizePurposeConfig({});
  const convs = [{
    key: 'private:wxid_owner',
    recentMessages: [{ text: '我周末想去吃火锅', time: now - HOUR, isSelf: false, isOwner: true, sender: '主人' }],
  }];
  const { items } = pe.collectMaterials({ now, config: cfg, ownerUin: 'wxid_owner', conversations: convs });
  const { goals } = pe.formGoalHypotheses({ materials: items, now, config: cfg, lastMasterAt: now - 3 * HOUR });
  const cands = goals.map((g) => pe.goalToCandidate(g));
  const sel = pe.selectPurpose({ seeds: [], goals, now, config: cfg, lastMasterAt: now - 3 * HOUR });
  const prompt = pe.buildPurposePrompt({
    now, config: cfg, ownerName: '主人', ownerUin: 'wxid_owner',
    materials: items, candidates: sel.candidates, selected: sel.purpose,
    mode: 'auto',
  });
  assert.ok(prompt.includes('微信·主人'), '提示词用微信平台名');
  assert.ok(!prompt.includes('QQ·主人'), '不再出现 QQ 平台名');
  assert.ok(prompt.includes('主动找主人'), '有目的回合头');
});

test('回执解析：内部备忘能解析出目的/需求/状态', () => {
  const memo = '【目的】关心主人面试\n【需求】关心\n【情绪】有点担心\n【类型】关心\n【状态】完成\n【待续】无';
  const parsed = pe.parsePurposeMemo(memo);
  assert.ok(parsed, '能解析');
  assert.strictEqual(parsed.need, 'care');
  assert.strictEqual(parsed.kind, 'care');
  assert.strictEqual(parsed.status, '完成');
  assert.strictEqual(parsed.followUp, '');
});

test('状态迁移：sent 后 countToday+1、安排下一次、写历史', () => {
  const cfg = pe.normalizePurposeConfig({});
  const st = pe.createPurposeState(now);
  pe.markPurposeDelivered(st, { now });
  pe.applyPurposeOutcome(st, { now, config: cfg, outcome: 'sent', text: '面试准备得咋样啦', planned: { need: 'care', text: '关心面试' } });
  assert.strictEqual(st.countToday, 1);
  assert.strictEqual(st.lastOutcome, 'sent');
  assert.strictEqual(st.history.length, 1);
  assert.ok(st.nextFireAt > now, '安排了下次');
});
