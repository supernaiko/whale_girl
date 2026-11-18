# 任务：给鲸鲸启动器加「统计」页（参考 dsh-context 的指标口径）

目标：在鲸鲸（whale_girl，C:\dev\whale-girl）里做一个「统计」页面，像 dsh-context 那样把她的使用情况摊开看。
只做**数据统计与展示**，不要改聊天链路、不要动发布/语音/朋友圈逻辑。

## 需要交付的三块

### 1. `src/stats/aggregator.js`（纯函数 + 测试）
输入全部来自磁盘，函数不碰网络、不写状态：
- `loadUsage(dataDir, { days })`：读 `data\usage.jsonl` 和 `usage.1.jsonl`（每行 `{at,purpose,model,prompt,cached,completion,reasoning}`，at 是毫秒时间戳；文件可能不存在或末尾半行损坏，要容错）。
- `dailyBuckets(rows, { days, now })`：按北京时间的自然日聚合，返回 `[{ day:'2026-11-19', billedTokens, prompt, cached, completion, cost, requests }]`；billedTokens = prompt + completion（prompt 已含 cached）。
- `computeCost(row, pricingRow)`：直接复用 `src/http/routes/cost.js` 里已有的计价规则（先看它导出了什么；能 require 就 require，不能就抽一个 `src/stats/pricing.js` 再让 cost.js 也引用它，别复制两份公式）。规则：按 `pricing.json` 的 `models.flash.offPeak/peak`，空闲窗 `offPeakWindow{start:'00:30',end:'08:30'}`，公式 `(cached*hit + (prompt-cached)*miss + completion*out)/1e6`。
- `chatStats(dataDir, { days, now })`：扫 `data\memory\chats\*\messages.jsonl`（先 `fs.readdir` 探真实结构，字段以实际文件为准；一般是 `{at,role,text,...}`），按会话聚合：`{ chatId, name, messages, mine, theirs, avgLen, lastAt }`，name 从 `manifest.json` 或消息里的 senderName 取，取不到就用 chatId 前 8 位。
- `hourlyHeatmap(rows, { days })`：返回 7×24 的计数矩阵（周几 × 小时，北京时间），给热力图用。
- `kpi(rows, chats, { days, now })`：`{ requests, billedTokens, cost, cacheHitRate, messages, replies, avgReplyLen, activeDays }`。
- 所有函数都要能处理空数据（返回 0 / 空数组），不能抛。

测试：`tests/stats.test.js`，用临时目录写假的 usage.jsonl / messages.jsonl，覆盖：空文件、坏行、跨日边界、缓存命中率、成本（给一组已知数字断言到 1e-4）。

### 2. `src/http/routes/stats.js`
- `GET /api/stats/overview?days=7|30` → `{ ok, kpi:{...}, daily:[...], heatmap:[...], chats:[...], generatedAt }`
- `GET /api/stats/context`（可以后置，先给个占位 `{ ok:true, parts:[] }`）
- 在 `src/http/routes/index.js` 的 modules 里注册（照现有写法）。
- 大文件解析要流式或按行读，别一次性 readFileSync 几百 MB。

### 3. 启动器页面 `launcher/Views/StatsPage.xaml` + `.cs`
风格照 `launcher/Views/MoodPage.xaml` 与 `CostPage.xaml`：深色卡片、样式键只用 App.xaml 里已有的（H1/H2/Card/Label/Small/Muted/Text/Accent/Ok/Idle/Surface3/Primary/Ghost），**不要**用 Track/Good 这类不存在的键，颜色用 `Foreground="{StaticResource Muted}"` 而不是 Style。
布局从上到下：
1. 顶部：标题「统计」+ 时间范围切换（今天 / 7 天 / 30 天）+ 刷新按钮 + 更新时间。
2. KPI 卡一行 4~6 个：请求数、计费 token、预估花费、缓存命中率、消息数、平均回复字数。
3. 「最近 7 天」柱状图：每天两根细柱（token 与花费各归一化），用 Grid + Rectangle 手画，每根柱子上方标当天数值；不引入任何图表库。
4. 「活跃时段」热力图：7 行（周一~周日）× 24 列，颜色按数量 5 档（Accent/Ok/Idle/Surface3 混色即可），鼠标悬停显示「周三 21 点 · 12 条」（用 ToolTip）。
5. 「会话」列表：每个会话一张卡片行——名字、消息数、她/对方条数、平均字数、最后活跃时间，按最后活跃倒序，最多 20 条。
6. 页脚一行小字：数据来源说明（usage.jsonl / memory）。
实现 `IRefreshable`，`DispatcherTimer` 30 秒自动刷新；切时间范围重新 Get。
`launcher/MainWindow.xaml.cs`：NavKeys 里加 `Key = "统计"`（放在「花销」后面），CreatePage 加 case 返回 `new StatsPage(_sup)`。

## 硬性要求
- 代码风格跟现有文件一致：C# 用 4 空格、`var`、`Api.Get(_sup.Url, path)`；JS 用 `'use strict';`、CommonJS。
- 中文文案直接写 UTF-8，文件保存为 UTF-8（无 BOM 也可以，但 JSON 读写要容忍 BOM）。
- 不要引入 npm 依赖，不要引入 NuGet 包。
- 改完必须自测：
  - `C:\dev\whale-girl\app\runtime\node.exe --test tests\stats.test.js` 全过
  - `C:\dev\tools\dotnet\dotnet.exe build launcher\WhaleLauncher.csproj -c Release` 0 警告 0 错误
- 不要删除或改动 `tests/` 下别的测试文件；跑完 `node --test tests` 不要有新增失败。
- 不要 git commit、不要 push、不要发布 exe，我自己来。

## 参考
- 数据：`app\data\usage.jsonl`、`app\data\memory\chats\*`、`app\data\pricing.json`
- 现有计价：[src/http/routes/cost.js](C:\dev\whale-girl\src\http\routes\cost.js)
- 现有页面：[CostPage.xaml](C:\dev\whale-girl\launcher\Views\CostPage.xaml)、[MoodPage.xaml](C:\dev\whale-girl\launcher\Views\MoodPage.xaml)
- 设计参考（只看指标口径，别抄代码）：dsh-context 的 KPI 条 / 7 天用量图 / 活动热力图 / 会话卡片
