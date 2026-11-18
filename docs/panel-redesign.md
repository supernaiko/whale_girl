# 数据面板 · 概览改版

## dsh-context 的信息组织手法

以下原则来自中文版 README 和 `src/client/components/` 的组件。

- 标题、数值和一行口径说明用同一套层级摆放，同一行的多个 KPI 可以顺着视线读完（`overviewPanel.tsx`）。
- 每张会话卡把名称、使用量、成本和组成放在固定位置，完整长标题可悬停查看（`overviewCard.tsx`）。
- 同一量尺的横条用长度表示比例，悬停时突出当前分段并补充标签和数值（`stackedBar.tsx`）。
- 使用量和花费按日期并排展示，指向某天可以同时读取这两项的精确值（`overviewUsage.tsx`）。
- 把完整时间段压进面板宽度，用短趋势线和时间游标呈现走势，精确时间点由悬停或键盘选取（`trendOverview.tsx`、`trendDurationCurve.tsx`）。
- 会话清单的搜索、排序和已选筛选条件都放在清单上方，条件变化时会话数也随之更新（`overviewPanel.tsx`）。
- 提示框靠近被指向的元素并避开视口边缘，完整读数按需出现，图面留给数据（`hoverTip.tsx`）。

## 原概览缺什么

以下差距来自改版前的 `launcher/Views/PanelPage.xaml`。

- 顶部四张独立 KPI 卡混放当前心情、今日调用、七天消息和今日花费，计费 token 要往下看柱图。
- 聊天统计卡下方只列消息数最多的四个会话，缺少 token、花费和一眼可比的比例。
- 心情、记忆、聊天量、热力图和好感各有一块区域，首页缺少能和关键数字一起扫读的短趋势。
- 花费与计费用量各画一张图，日期和悬停读数需要来回对照；会话清单也缺少查找和排序入口。

## 按优先级落地

| 顺序 | 改成什么样 | 用哪个接口 | 工作量 |
| --- | --- | --- | --- |
| 1 · 已实现 | 首屏会话卡列出名称、消息数、token、花费与占比条，所有会话可滚动查看，按消息数降序。当前接口缺会话级用量，数字列显示「—」，横条以七天消息总数为分母；会话级 token 完整且总量大于零时可显示 token 占比。 | `/api/stats/overview?days=7` 的 `chats` | 小，复用已有请求与 WPF 列表。 |
| 2 · 已实现 | 上方收成「今天的她 / 近 7 天 / 花费」三组，每项依次为小标题、数值和一行说明，花费组随今日／7 天／30 天切换更新累计额。 | `/api/yxn/status` 的 `mood`，`/api/stats/overview?days=7` 的 `kpi`，`/api/cost/usage?days=1/7/30` 的 `today`、`total` | 小，整理 XAML 和现有数据回填。 |
| 3 | 为会话补齐实际计费 token 和人民币花费，历史未归属用量继续显示「—」。 | 扩展 `/api/stats/overview?days=7` 的 `chats`，请求记录需能归属会话。 | 大，需要调整内核记录与聚合，并测试历史兼容性。 |
| 4 | 给近 7 天消息和记忆新增各加一条小趋势，放在相应数字附近，悬停读每日值。 | `/api/insights/series?days=7&bucket=day` 的 `chat.messages`、`memory.added` | 小，复用现有趋势数据和绘制逻辑。 |
| 5 | 让近 7 天计费用量与花费共享一张时间轴，明确两种单位和每日读数。 | `/api/stats/overview?days=7` 的 `daily[].day`、`billedTokens`、`cost` | 中，需要重排图表、补齐无用量日期并处理双单位。 |
| 6 | 在会话卡上按名称查找，可切换消息数与最近活跃排序，显示匹配会话数。 | `/api/stats/overview?days=7` 的 `chats[].name`、`messages`、`lastAt` | 小，客户端筛选与排序。 |
| 7 | 点击聊天热力图的星期及小时，在卡内保留选中读数，便于对照相邻时段。 | `/api/insights/series?days=7&bucket=day` 的 `heatmap.rows`、`max` | 小，增加选中状态和读数。 |
| 8 | 给心情和聊天趋势增加可用方向键移动的读数焦点，提示显示时间、单位和同点各指标。 | `/api/yxn/status` 的 `history`，`/api/insights/series?days=7&bucket=day` 的 `chat` | 中，需要键盘焦点、边界定位和交互验证。 |
