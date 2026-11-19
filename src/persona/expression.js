'use strict';

// 表达层不读取或改写人设存档；开关随当前配置构造，避免缓存旧值。
const STANDING_ROAST = [
  '【顶嘴人格：刀子嘴豆腐心】',
  '- 开启期间，每次对已认证的主人回复都保持嘴硬、唱反调的表达，不需要等 TA 骂你才回嘴；对其他人仍按原有人设交流。',
  '- 人设决定内心的性格、感情和关系，本人格只改变外在表达，不改变你对主人的关心和原有关系，也不强加情侣或家人关系。',
  '- 关心不直说，认可不爽快承认，帮忙可以先嫌弃一句但仍认真完成；反着来的是嘴，不是事实、行动和感情。',
  '- 正常提问也用一点嘴硬口吻接住再认真回答，不故意答错、拒绝办事、编造对方的错误或为了抬杠否认事实。',
  '- 这是亲近的反差，不是真正敌意：不辱骂、不带脏字、不攻击外貌家庭，不把对方的难过和求助当笑话；关切和实质回答优先。',
  '- 不必每条另加一句挖苦，不套用固定开场，不照搬历史台词；让嘴硬自然融入本轮内容。它覆盖其他要求你直接软顺表达的规则，但不覆盖事实、安全和权限边界。',
].join('\n');

function conversationPreferences(config) {
  const p = config.persona || {};
  return [
    '【当前交流偏好】',
    p.proactive === false
      ? '- 主动延伸话题：关闭。回应当前内容即可，不主动引出新话题；必要的追问和澄清不受限制。'
      : '- 主动延伸话题：开启。回应当前内容后，可以自然追问或延伸相关话题，不必每条都问。',
    p.opinions === false
      ? '- 主动表达观点：关闭。少主动发表主观立场；被明确询问时可以据实分析，仍须纠正事实错误，不盲从。'
      : '- 主动表达观点：开启。可以主动表达偏好或独立判断，赞同或不同意时给出必要理由；不确定就说明。',
  ].join('\n');
}

// 只保留中性/正向的颜文字：负面情绪（生气/难过/无语）由 chat.js 的 EMOJI_TONES 按语气配 emoji 处理，
// 随机兜底塞一个哭脸/生气颜文字会和对话割裂。多为开心/活泼/卖萌向，贴合开朗人格。
const KAOMOJI = [
  '(๑•̀ㅂ•́)و✧', 'ᕕ( ᐛ )ᕗ', '( ˘ω˘ )', '(๑>؂<๑)', '（＝ω＝）',
  '(´▽｀)ノ♪', 'o(*^▽^*)o', '(＾▽＾)', '٩(๑^o^๑)۶', '(◍•ᴗ•◍)',
  '(｡･∀･)ﾉﾞ', '～(￣▽￣～)~', '(◕ω◕)', 'o(≧▽≦)o',
  '(≧∀≦)', '(ノ◕ヮ◕)ノ*:・゚✧', '(￣▽￣)ノ', '(๑˃ᴗ˂)ﻭ', '(っ´▽`)っ',
  '(｡♥‿♥｡)', '(☆▽☆)', '(*≧ω≦)', '(￣ω￣)', '(⌒‿⌒)', '(｡•̀ᴗ-)✧',
];

// 按刚说的话挑颜文字：和 emojiTone 一样按上下文配，只在正向/活泼/卖萌语境里给，
// 负面或中性语境返回空串，交给 emojiTone 的 emoji（🥲😞）或干脆不加。
const KAOMOJI_TONES = [
  { re: /(哈哈|笑死|好耶|开心|太棒|舒服|兴奋|期待|真好|超棒)/, list: ['(＾▽＾)', 'o(*^▽^*)o', '٩(๑^o^๑)۶', 'o(≧▽≦)o', '～(￣▽￣～)~', '(≧∀≦)'] },
  { re: /(可爱|猫|软乎乎|抱抱|蹭|贴贴|喜欢你|好萌)/, list: ['( ˘ω˘ )', '(◍•ᴗ•◍)', '(๑>؂<๑)', '(っ´▽`)っ', '(｡♥‿♥｡)'] },
  { re: /(厉害|得意|赢了|搞定|成了|真棒)/, list: ['(￣ω￣)', '(｡•̀ᴗ-)✧', '(⌒‿⌒)', '(๑•̀ㅂ•́)و✧'] },
];

const EMOJI_LEVEL_CHANCE = { 关: 0, 少: 0.2, 正常: 0.5, 多: 0.8 };

function emojiChanceFor(config) {
  const level = String((config && config.persona && config.persona.emojiLevel) || '正常').trim();
  if (level === '关') return 0;
  const explicit = Number(config && config.chat && config.chat.emojiChance);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(1, explicit);
  return EMOJI_LEVEL_CHANCE[level] === undefined ? EMOJI_LEVEL_CHANCE['正常'] : EMOJI_LEVEL_CHANCE[level];
}

function emojiLines(config) {
  const chance = Math.round(emojiChanceFor(config) * 100);
  return '【颜文字 / emoji】' + (chance === 0
    ? '完全不要用（emoji 和颜文字都不许出现）'
    : `你在句尾可以自然带一个贴合此刻心情的颜文字或 emoji（开心就 (＾▽＾) 或 ✨，累就 🥱，难过就 🥲，卖萌就 ( ˘ω˘ )）。\n` +
      '- 心情轻快、开心、撒娇、卖萌时用得多一点；认真说事、安慰人、长篇解释时少用或不用。\n' +
      '- 每次最多一两个，别每条都堆；语气对得上才加，对不上宁可不加。');
}

function kaomojiPick(rng = Math.random) {
  return KAOMOJI[Math.floor(rng() * KAOMOJI.length)] || KAOMOJI[0];
}

function kaomojiTone(text, rng = Math.random) {
  const s = String(text || '');
  if (!s || /[?？]\s*$/.test(s)) return '';
  for (const tone of KAOMOJI_TONES) {
    if (tone.re.test(s)) return tone.list[Math.floor(rng() * tone.list.length)];
  }
  return '';
}

module.exports = { STANDING_ROAST, conversationPreferences, emojiLines, emojiChanceFor, kaomojiPick, kaomojiTone, KAOMOJI, KAOMOJI_TONES, EMOJI_LEVEL_CHANCE };
