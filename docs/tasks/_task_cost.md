在 C:\dev\whale-girl 加「花销」页，把鲸鲸自己的 DeepSeek 调用和 Codex 用量换成钱显示出来。Codex 一律按 **DeepSeek 的 API 价**折算（用户要的是“同等量用 DeepSeek 要花多少”）。

## 1) 内核：usage 落盘 + 聚合路由
- `src/llm/client.js` 已经在 `_recordUsage` 里拿到了 prompt/cacheHit/cacheMiss/completion，把它追加到 `<数据目录>\usage.jsonl`，一行一条：`{at, purpose, model, prompt, cached, completion, reasoning}`。文件超过 5MB 轮转成 `usage.1.jsonl`（只留一份旧的）。
- 新路由 `GET /api/cost/usage?days=7`（loopback 即可，不需要 token，和 `/api/debug/*` 一致）返回：
  ```
  { ok:true, days, today:{requests,prompt,cached,completion,costCny}, total:{...},
    byDay:[{date,requests,prompt,cached,completion,costCny}], pricing:{...} }
  ```
- 费率放 `<数据目录>\pricing.json`，首次自动生成：
  ```json
  { "currency": "CNY", "rate": 7.15,
    "deepseek": { "cacheHitPerM": 0.028, "cacheMissPerM": 0.28, "outputPerM": 0.42 } }
  ```
  `costCny = ((cached*cacheHit + (prompt-cached)*cacheMiss + completion*outputPerM) / 1e6) * rate`。文件缺失/字段缺失时用上面的默认值，**不要**抛错。

## 2) 启动器：新页面「花销」（放在「调试台」下面）
- 顶部时间范围切换：今日 / 7 天 / 30 天；右上「刷新」。
- 上半「鲸鲸 · DeepSeek」：请求数、输入（其中缓存命中）、输出、命中率、金额；下面按天列表（日期/请求/金额）。
- 下半「Codex」：扫描 `%USERPROFILE%\.codex\sessions\**\*.jsonl`，取每个文件最后一次 `event_msg`/`token_count` 的 `total_token_usage`（字段 `input_tokens`、`cached_input_tokens`、`output_tokens`、`reasoning_output_tokens`），按文件修改时间过滤时间范围，汇总后按同一套 DeepSeek 价折算；显示 token 明细 + 金额 + 会话数。
- 底部一句说明：费率来自 `data\pricing.json`，Codex 按 DeepSeek 价折算，改文件即可改价。
- 样式跟「调试台」「Codex 日志」一致（深色、卡片、等宽数字）。

## 约束
- 不要动 `bridge\`、`src\pipeline\`、`src\persona\`（上游补丁刚合进来，别覆盖）。
- 只改 `src/llm/client.js`、新增 `src/http/routes/cost.js`、`src/http/routes/index.js`（注册路由）、`launcher\Views\CostPage.xaml(.cs)`、`launcher\MainWindow.xaml.cs`（加导航）。
- `node --check` 通过；新增路由要有测试（放在 `tests/cost-usage.test.js`，覆盖：无 usage.jsonl 时返回 0、有数据时按天聚合、pricing.json 缺字段用默认值、days 参数边界）。
- `C:\dev\tools\dotnet\dotnet.exe build launcher\WhaleLauncher.csproj -c Release` 通过；不要 publish 到 `app\`、不要重启、不要发真实消息。
- 最后告诉我：改了哪些文件、测试结果、页面截图（存 `C:\dev\whale-girl\publish\cost-page.png`）、以及用今天真实数据算出来的数字（DeepSeek 侧和 Codex 侧各多少元）。
