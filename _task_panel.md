# 任务：把「数据面板 · 概览」补成用户要的样子

仓库：C:\dev\whale-girl（WPF 启动器 .NET 10 + Node 内核）。
只改启动器与必要的前端调用，不动内核业务逻辑。构建命令：
`C:\dev\tools\dotnet\dotnet.exe build launcher\WhaleLauncher.csproj -c Release`（必须 0 error 0 warning）。

## 背景
`launcher\Views\PanelPage.xaml(.cs)` 是「数据面板」，已经有四个页签（概览/心情/花销/统计）和
概览页的 KPI、心情卡（含 24h 心情/精力折线）、花销卡（柱状）、聊天统计卡（柱状）。
但用户说「没有我说的那些」，缺：记忆变化曲线、聊天量曲线（消息/回复两条）、7×24 热力图、
心情极值、每人好感双线。刚才已经补了暗色 TabItem 样式（App.xaml 的 `DarkTabItem`），别动它。

## 数据源（已实现，直接调用，不要再造后端）
`GET /api/insights/series?days=1|7|30&bucket=hour|day`，实现在
`src\stats\insights.js` 与 `src\http\routes\insights.js`。先读这两个文件确认真实字段名，
再按实际字段写解析（不要猜）。启动器里取数用现成的 `Api.Get(_sup.Url, path)`。

## 要加的东西（都在「概览」页签里）
1. **记忆曲线**：每日新增事件卡数量（折线或柱状都行），副标题写累计总数。
2. **聊天量曲线**：消息数与她回复数两条线，7 天按天分桶；鼠标悬停不是必须。
3. **7×24 热力图**：7 行（周一…周日）× 24 列，色阶用 `Accent` 的不同透明度（0 显示 `Surface3`），
   格子 10×10、间距 2，左上角标注「周一…周日」。
4. **心情极值**：最高/最低各一行（值 + 时间 + 当时最近事件），数据来自 insights 的 extremes。
5. **每人好感双线**：前 5 个人，亲近（`Accent`）与信任（`Ok`）两条线，横向时间轴；
   没有历史时显示「还没有好感记录」。

## 硬性要求
- 只改 `launcher\Views\PanelPage.xaml` 与 `PanelPage.xaml.cs`（必要时可加一个小的私有辅助类在同一个 .cs 里）。
- 颜色一律用 App.xaml 里已有的资源键（`Text`/`Muted`/`Dim`/`Accent`/`Ok`/`Surface3`/`Line`/`Card`/`H1`/`H2`/`Label`/`Small`/`Ghost`），不要硬编码颜色字符串。
- 空数据要有中文提示，不要空白卡片。
- 保持现有 30 秒自动刷新、`IRefreshable`、`OnRefreshClick`、花销页签的今日/7/30 切换不变。
- 曲线仍用 Canvas 手绘（现成 `DrawBars`/`DrawHistory` 可以参考），不要引入第三方图表库。
- 排版要跟现有卡片一致：`Card` 样式 + Padding 22,18 + 标题 H2 + 说明 Small。

## 验收
1. 构建 0 error 0 warning。
2. 用 `node --test tests\insights.test.js tests\stats.test.js` 确认后端没被改坏（应当 14/14 通过）。
3. 输出一份简短改动说明：改了哪些文件、加了哪几块、每个块用的 insights 字段。
不要启动鲸鲸、不要动 app\ 目录（我这边负责发布）。
