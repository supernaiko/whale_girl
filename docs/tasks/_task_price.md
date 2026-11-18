把「花销」页的计价改成 DeepSeek 官方价，并区分高峰/空闲两个时段。现在的价（¥0.028/0.28/0.42 每百万 × 汇率 7.15）是错的，用户核对后指出按官方价应该只有 ¥3~6，不是 ¥10.79。

## 官方价格（每百万 token，人民币，直接是 CNY，不要再乘汇率）

DeepSeek V4.1 Flash：
- 空闲时段：缓存命中 ¥0.02 / 缓存未命中 ¥1.00 / 输出 ¥4.00
- 高峰时段：缓存命中 ¥0.04 / 缓存未命中 ¥2.00 / 输出 ¥8.00

DeepSeek V4 Pro（可选，配了才显示）：
- 空闲：缓存命中 ¥0.10 / 未命中 ¥4.00 / 输出 ¥16.00
- 高峰：缓存命中 ¥0.20 / 未命中 ¥8.00 / 输出 ¥32.00

时段规则（北京时间为准）：**00:30–08:30 为空闲，其余为高峰**。每条用量按它自己的时间戳判断，不要整体按当前时间算。

## 改动

1. `app\data\pricing.json` 新格式（首次自动生成，字段缺失要有兜底）：
```json
{
  "currency": "CNY",
  "models": {
    "flash": {
      "offPeak": { "cacheHitPerM": 0.02, "cacheMissPerM": 1.0, "outputPerM": 4.0 },
      "peak":    { "cacheHitPerM": 0.04, "cacheMissPerM": 2.0, "outputPerM": 8.0 }
    }
  },
  "offPeakWindow": { "start": "00:30", "end": "08:30" }
}
```
（`pro` 作为可选第二项写进注释里即可，默认不启用。）

2. `src\http\routes\cost.js`：
   - 每条 `usage.jsonl` 记录（字段 `at`、`prompt`、`cached`、`completion`）按 `at` 落到 peak / offPeak，分别累计 token 和金额
   - 返回里增加 `peak: {requests,prompt,cached,completion,costCny}`、`offPeak: {...}`、`byDay` 每天也要拆 `peakCostCny` / `offPeakCostCny`
   - `total.costCny` = peak + offPeak；旧字段名保持不变，别让启动器页面炸
   - days 上限 365 保持

3. `launcher\Views\CostPage.xaml(.cs)`：
   - 「鲸鲸 · DeepSeek」卡片：金额拆两行「高峰 ¥x / 空闲 ¥y」，下面小字显示当前用的单价（读 pricing.json 的 flash 峰值价）
   - 「Codex」卡片：加一个「按高峰 / 按空闲」切换（默认高峰），换算用同一套 Flash 单价；说明文字改成「Codex 会话按 DeepSeek Flash 价格折算，缓存命中率沿用 Codex 实测值」
   - 底部说明改成：时段划分 00:30–08:30 空闲，其余高峰；单价在 `data\pricing.json` 改

4. `tests\cost-usage.test.js` 增加用例：
   - 37.11M 命中 / 1.31M 未命中 / 0.246M 输出，全部落在空闲 → 金额 ≈ 3.04（±0.02）
   - 同样 token 全部落在高峰 → ≈ 6.07（±0.03）
   - 混合两条记录（一条 09:00、一条 03:00）→ peak 与 offPeak 各自非零且 total = 两者之和
   - pricing.json 字段缺失 → 用默认价，不抛错

## 约束
- 只改 `src\http\routes\cost.js`、`src\llm\client.js`（如果它还在写金额）、`launcher\Views\CostPage.*`、`tests\cost-usage.test.js`、`app\data\pricing.json`
- 不动 bridge\、pipeline\、persona\
- `node --check` + 新测试 + `C:\dev\tools\dotnet\dotnet.exe build launcher\WhaleLauncher.csproj -c Release` 通过
- 不要 publish 到 app\、不要重启鲸鲸、不要发消息
- 完成后回报：改了哪些文件、测试输出、用今天 Codex 的 37.11M/1.31M/0.246M 分别按高峰和空闲算出来多少（应该接近 ¥6.07 / ¥3.04）
