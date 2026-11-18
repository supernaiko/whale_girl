按设计文档 `C:\dev\whale-girl\docs\yxn-architecture.md` 第 3 节实现第一个插件 `yxn-gate`（接话判定）。这是新项目，从零建。

## 目标目录
`C:\dev\whale-girl\custom\plugins\yxn-gate\`
- `plugin.json`
- `plugin.js`（CommonJS，Node 侧运行，`require('whale')` 可用）
- `package.json`（仅用于本地测试，`"private": true`，无依赖）
- `tests\run-tests.js`（node:test）
- `README.md`（装法、设置项、日志怎么读）
- `install.js`（写入 `C:\dev\whale-girl\app\data\plugins\`，参照 `custom\plugins\whale-ops\install.py` 的字段：flow.json / flow-grant.json / .enabled / zip）

## plugin.json 字段
Id `yxn-gate`、Name `接话判定`、Author `Naiko`、Version `0.1.0`、MinAppVersion `4.1.2`、Api 4、Kind message、Hooks `["chat.pre_reply"]`、Permissions `["system.full"]`、ExecutionTimeoutMs 20000、appCompatibility 与 whale-ops 一致。

## plugin.js 行为

导出 `{ hooks: { 'chat.pre_reply': onPreReply } }`（参考 `custom\plugins\whale-ops\plugin.js` 的导出结构，先读一遍再写）。

### 1. 读配置
从 `ctx.settings` 读，缺省用默认值；再尝试读 `path.join(whale.paths.pluginData, 'config.json')` 覆盖（文件不存在就用 settings）。字段：
```jsonc
{
  "enabled": true,
  "private": { "base": 0.92, "min": 0.35, "max": 0.99 },
  "group":   { "base": 0.30, "min": 0.05, "max": 0.85 },
  "keywords": ["小奈", "雅小奈", "奈奈"],
  "quietHours": { "start": "23:30", "end": "07:00" },
  "judge": { "enabled": true, "low": 0.25, "high": 0.65, "timeoutMs": 8000 },
  "silent": { "consecutiveNo": 3, "maxSilentMs": 600000, "wakeOnMessages": 8 }
}
```

### 2. 概率链
按设计文档 3.2 的表格执行，顺序固定，每一步都可日志：
```
p = base
被@(群) → p += 0.45
关键词/被叫名字 → p += (私聊 0.05 / 群聊 0.12)；被叫名字再 +0.20/0.25
疑问句 → += 0.04/0.10
纯表情 → -= 0.35/0.10
系统通知 → -= 0.60/0.30
60s 内同人 ≥4 条 → -= 0.10/0.05
20s 内刚回过该人 → -= 0.15/0.20
5 分钟内已回 ≥5 条 → -= 0.50/0.40
连续回同一人 ≥6 轮无回应 → -= 0.10/0.10
明确不想聊（别烦我/不想聊/闭嘴/滚） → -= 0.70/0.50
23:30–07:00 → -= 0.25/0.20
群 10 分钟内 <3 条 → 群聊 += 0.05
p = clamp(p, min, max)
```
纯函数 `scoreChain(input)` 导出并单测，输入形如 `{ chatType, text, atMe, senderId, now, stats }`，输出 `{ p, steps: [{name, delta, p}] }`。
必须处理：`text` 为空 / 只有表情 / 超长（>4000 截断）。

### 3. 状态
存 `path.join(whale.paths.pluginData, 'state.json')`：`{ [chatId]: { lastReplyAt, replies: [ts...], consecutiveNo, silentUntil, silentMsgCount, lastSenderId, senderStreak } }`。窗口裁剪：只留最近 10 分钟的时间戳，最多 50 条。

### 4. 静默 FSM
连续 3 次判定 skip → 进入静默（`silentUntil = now + 10min`，记 `silentMsgCount=0`）。静默期内：
- 消息不调 LLM、不做完整概率链，直接 `pass`（让宿主正常处理？不：返回 `skip`，reason=`silent`）
- 唤醒条件：被 @、被叫名字、过 600s、攒够 8 条 → 清静默

### 5. 闸门2 judge
`p` 落在 `[low, high]` 且 `judge.enabled` 时调用：
```js
const text = await whale.model({
  system: '你是「雅小奈」的发言判断器。只判断要不要回这条消息，不要写回复。',
  turns: [{ role: 'user', content: judgePrompt }],
  maxTokens: 8
});
```
返回文本 trim 后以 `yes` 开头 → 回；其他/超时/异常 → **不回**（fail-closed，catch 里记日志返回 no）。

### 6. chat.pre_reply 返回值
- 要回：`{ action: 'wake' }`，并更新 `lastReplyAt`、push `replies`
- 不回：`{ action: 'skip', reason: '<step 名或 silent/judge_no>' }`，`consecutiveNo++`
- 关闭时：`{ action: 'pass' }`

### 7. 日志
每轮 `console.log('[yxn-gate]', JSON.stringify({ chatId, p, action, reason, steps: steps.map(s=>s.name) }))`；错误 `console.error`。

### 8. 单测（tests/run-tests.js，至少 14 个）
- 概率链：@ 群聊必过阈值；「别烦我」压到 min；23:30 后降低；连续轰炸降低；纯表情私聊降到很低
- 边界：20s 刚回过、5 分钟 5 条、连续 6 轮
- 静默：连续 3 次 skip → 第 4 条 silent；被 @ 唤醒
- judge：stub `whale.model` 返回 'yes'/'no'/抛错，断言 回/不回/不回
- clamp：极端输入不越界
用 `node --test`，全部 mock 掉 `whale`（测试里 `module` 注入，别真的 require whale）。

## 约束
- 只动 `custom\plugins\yxn-gate\`，不改 `src\`、`launcher\`、`bridge\`
- 不安装、不跑 install.js、不重启鲸鲸
- `node --check plugin.js` + `node --test tests/run-tests.js` 必须全绿
- 代码注释用中文；不要留 TODO
- 完成后回报：文件清单、测试数量与结果、`scoreChain` 对 3 组样例输入的输出（p 值）
