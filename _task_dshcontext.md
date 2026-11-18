# 任务：吃透参考项目 dsh-context，把它值得学的部分落到我们的「数据面板」

参考仓库已克隆到 `C:\dev\reference\dsh-context`（只读，不要改它，也不要 merge 它的代码；它 AGPL，只学思路与交互）。
我们的仓库：`C:\dev\whale-girl`。

## 第一步：读参考
- 读 `C:\dev\reference\dsh-context\README.md`（中文那份）和 `src\client\components\` 下的核心组件，
  重点看它「一屏看很多信息」的排版：会话卡片、占比条、趋势/sparkline、指标分组、hover 细节。
- 不要抄配色和文案；提炼 5~8 条可借鉴的排版与交互原则。

## 第二步：产出
1. 新建 `docs\panel-redesign.md`（≤120 行）：
   - 参考项目的信息组织手法（每条一句话 + 对应组件文件名）
   - 我们的「数据面板 · 概览」现在缺什么（对照 `launcher\Views\PanelPage.xaml`）
   - 落地清单：按优先级 8 条，每条写「改成什么样 / 用哪个接口 / 工作量」
2. 直接实现其中**最高优先级的 2 条**，只改 `launcher\Views\PanelPage.xaml` 与 `PanelPage.xaml.cs`：
   - **会话明细卡**：按会话列出 名称 / 消息数 / token / 花费 / 占比横条（数据用 `/api/stats/overview?days=7` 的 `chats`，缺字段就先算消息数占比）。
   - **指标分组**：把现在散落的 KPI 收进「今天的她 / 近 7 天 / 花费」三组，组内指标用 小标题 + 数值 + 一行说明 的紧凑排法。

## 硬性要求
- 颜色只用 `App.xaml` 既有键（`Text`/`Muted`/`Dim`/`Accent`/`Ok`/`Warn`/`Surface3`/`Line`/`Card`/`H1`/`H2`/`Label`/`Small`/`Ghost`）。
- 保留现有：四个页签、30 秒自动刷新、`IRefreshable`、hover tooltip（`AddHover`）、花销今日/7/30 切换。
- `C:\dev\tools\dotnet\dotnet.exe build launcher\WhaleLauncher.csproj -c Release` 必须 0 error 0 warning。
- 不要动 `app\`、不要启动鲸鲸、不要联网。
- 结束时输出：改了哪些文件、两条实现各用了哪些字段、构建结果。
