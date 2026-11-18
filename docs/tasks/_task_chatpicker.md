在 C:\dev\whale-girl 改「调试台」页的目标会话输入，让它能选人而不是手打。

## 现状
- `launcher\Views\DebugPage.xaml` 里「目标会话」是一个普通 TextBox（发文件 / 表情 / 链接 三个页签各一个）。
- 启动器已有调内核的封装：`launcher\Api.cs`（含 token 读取），内核 `GET /api/wechat/contacts` 返回当前账号联系人列表（字段至少有 wxid、name、remark，先读实现确认）。
- 页面后台在 `DebugPage.xaml.cs`。

## 要做
1. 三个页签的「目标会话」都换成可编辑的 ComboBox（IsEditable=true）：加载页面/点刷新时拉 `/api/wechat/contacts`，把「备注(昵称) · wxid」填进下拉项，选中后把 **wxid** 写回输入框（用户手打的名字也允许，保持兼容）。
2. 输入时做即时过滤（Contains，忽略大小写），输入框为空时显示全部；列表项显示名称 + 灰色 wxid；没有联系人时给「未同步」提示而不是空白。
3. 顶上加一个「刷新联系人」按钮，调 `/api/wechat/contacts/sync`（若存在）或重新 GET，并在日志区打印耗时与条数。
4. 常用目标置顶：`文件传输助手`、当前账号本人（如果联系人里有自己）。
5. 保留手工输入能力：用户改了文本就按文本发，不要强制从列表选。

## 约束
- 只改 `launcher\Views\DebugPage.*` 与必要的 `launcher\Api.cs`；不要动 `src\`、`bridge\`。
- 深色主题、跟现有控件风格一致（参考同页其它控件与 `CodexLogPage.xaml`）。
- `C:\dev\tools\dotnet\dotnet.exe build launcher\WhaleLauncher.csproj -c Release` 必须通过；**不要** publish 到 `app\`、不要重启鲸鲸、不要发真实消息。
- 完成后告诉我：改了哪些文件、build 结果、联系人条数怎么拿的（哪个字段做显示/回填）。
