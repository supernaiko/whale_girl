目标：把朋友圈自动发布从「固定 6 小时一条」改成「像人一样按作息、按心情、按有没有话想说」。

仓库：C:\dev\whale-girl。

关键文件：
- `src\services\momentsPublisher.js`：`generate()` 生成文案 + 选图；`queueDraft` 入队。
- `src\services\momentsScheduler.js`（若存在）：定时的调度；否则在 `src\services\moments*.js` 里找 tick。
- `src\http\routes\moments.js`：`/api/moments/publish-settings`、`/api/moments/publish`。
- `app\data\config.json` 的 `moments` 段：intervalHours、maxPerDay、publishEnabled、publishWithImage、photoPrimary。
- `tests\moments.test.js`：已有 28 个断言，必须继续全过。

要做的：
1. 新调度规则（默认值，可在 config 覆盖）：
   - 活跃时段 08:00–23:30；23:30–08:00 不发
   - 每天最多 2 条；两条之间至少 3 小时
   - 触发不按固定间隔：每小时以 0.25 概率尝试（jitter），命中后再看「有没有素材/有没有想说的」
   - 连续 3 天没发也允许空着；如果当天已经发过 2 条就不再尝试
   - 主人标记「今天不想发」时当天跳过（config `moments.muteDate: 'YYYY-MM-DD'`）
2. 「有没有想说的」判断：已有素材（当天聊天/日记/事件卡）且模型返回非空 text 才发；模型返回空就跳过并记 `status=skip_no_text`。
3. `/api/moments/publish-settings` 返回新字段：`nextEligibleAt`、`todayCount`、`muteDate`；旧的 intervalHours 保留兼容（读不到就用默认）。
4. 日志：每次 tick 记一行 `[moments] tick eligible=... reason=...`，方便排查。
5. 测试：把上面规则写成纯函数（例如 `eligibleNow(now, state, cfg)`）并加单测：
   - 凌晨 02:00 → 不 eligible
   - 已发 2 条 → 不 eligible
   - 距上一条 2 小时 → 不 eligible
   - muteDate=今天 → 不 eligible
   - 正常 10:00 且今天 0 条 → eligible
   跑 `node --test tests/moments.test.js` 全过。

约束：
- 不改文案提示词与配图逻辑（那部分已定稿）。
- 不发真实朋友圈；测试只用假数据。
- 完成后写 `C:\dev\whale-girl\_report_moments.md`：规则、默认值、改的文件、测试结果。
