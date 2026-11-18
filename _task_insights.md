# 任务：whale_girl 数据聚合接口（yxn insights）

仓库：C:\dev\whale-girl（Node 24，零第三方运行时依赖，代码风格 CommonJS，测试用 node:test）

## 目标
新增一个只读接口，把「心情 / 记忆 / 聊天 / 好感」四类时间序列一次性给前端。前端（WPF 启动器）只负责画，不做任何聚合。

## 现有数据源（先读，别猜）
- 心情与好感：`data\plugins\yxn-bond.data\bond.json`（mood{valence,energy,why,updatedAt}、people{wxid:{name,closeness,trust,lastAt,interactions}}）
- 心情快照：`data\plugins\yxn-bond.data\mood-history.jsonl`（每行 `{at,v,e}`，插件每 5 分钟写一条）
- 用量：`data\usage.jsonl`（每行 `{at,purpose,model,prompt,cached,completion,reasoning}`）+ 现有 `src\http\routes\cost.js` 的计价逻辑
- 聊天：`data\memory\chats\*\messages.jsonl`（每行一条消息，字段以实际文件为准，先 cat 两条确认）+ `data\memory\people\*.json`（事件卡）
- 已有聚合：`src\stats\aggregator.js`、`src\http\routes\stats.js`、`src\http\routes\yxn.js`

## 要做的事

1. **新增 `src\stats\insights.js`**（纯函数为主，便于测试）：
   - `loadMessages(dataDir, { sinceMs })` → 统一结构的消息数组 `{ at, chatId, chatName, fromMe, len }`；读 memory/chats 下所有 messages.jsonl，先确认字段名再写。
   - `moodSeries(history, { since, bucket })` → 按桶聚合心情/精力：`[{ t, v, e, n }]`，bucket 为 `hour` 或 `day`；桶内取均值。
   - `memorySeries(messages, events, { since, bucket })` → `[{ t, added, total }]`：每天新增事件卡数、累计条数。
   - `chatSeries(messages, { since, bucket })` → `[{ t, messages, mine, theirs, avgLen, replyRate }]`：消息量、她发的条数、对方发的条数、平均字数、回复率（她回复的会话轮次 / 对方开启的轮次，口径自己定并在注释里写清）。
   - `bondSeries(bondHistory, { since, bucket })` → 好感曲线。**数据没有历史**：bond.json 只有当前值。所以本项只返回当前值 + `since` 之后若有快照则返回；没有就返回单点，并在 `note` 里注明「好感只有当前值」。
   - `heatmap(messages, { since })` → 7×24 矩阵 `[[count]]`，行=周一..周日，列=0..23，另返回 `max`。
   - `todayMessages(messages, now)` → 今天（本地时区）消息条数。
   - `extremes(history, now)` → 今天心情最高/最低的 `{t, v, why}`（why 用当时最近的一条事件或空）。

2. **新增路由 `src\http\routes\insights.js`**，并在 `src\http\routes\index.js` 注册：
   - `GET /api/insights/series?days=1|7|30&bucket=hour|day`
     → `{ ok, days, bucket, mood:[…], memory:[…], chat:[…], bond:{people:[…], note}, heatmap:{rows, max}, today:{messages, requests, costCny}, extremes:{high, low}, generatedAt }`
   - `days=1` 默认 bucket=hour，其余默认 day。
   - 只读，不改任何文件。

3. **心情历史保留期**：`custom\plugins\yxn-bond\plugin.js` 里把 `HISTORY_KEEP_MS` 从 7 天改成 30 天（一处常量）。

4. **测试** `tests\insights.test.js`（node:test）：
   - moodSeries 按小时分桶、桶内均值正确；空输入返回 `[]`。
   - chatSeries 的 replyRate 边界：对方连发 3 条她回 1 条 → 0.33（±0.02）。
   - heatmap 维度恒为 7×24，且 total 与输入条数一致。
   - extremes 在只有单点时返回同一高一低。
   - 至少 8 个断言，全部用构造数据，不读真实文件。

## 约束
- 不新增 npm 依赖；不联网；不改 `app/`（那是运行目录，我负责同步）。
- 时区一律本地时区（`new Date()` 默认），不要 UTC 偏移硬编码。
- 性能：30 天窗口下内存里处理，不逐行正则。
- 完成后跑 `node --test tests\insights.test.js` 与 `node --test tests\stats.test.js`，都要绿。

## 交付
- 改/增的文件清单 + 每个文件一句话说明。
- 测试输出原文。
- 指出你在 `messages.jsonl` 里实际看到的字段名（怕我记错）。
