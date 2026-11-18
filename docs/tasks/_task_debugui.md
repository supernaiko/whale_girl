在 C:\dev\whale-girl 加一个「调试台」界面，装进鲸鲸启动器里，用于手动测五个能力：发文件、发表情、发链接（纯文本消息）、Codex、微博。目的是调试，别做花哨产品化。

## 现状
- 启动器是 WPF（`launcher\WhaleLauncher.csproj`，net10.0-windows），左侧导航 `MainWindow.xaml.cs:40-71`（NavKeys），页面切换在 `:537` 附近的 switch；已有页面在 `launcher\Views\*.xaml`，参考 `CodexLogPage.xaml`（我上次加的，深色主题、左侧列表+右侧内容）与 `DiagPage.xaml`。
- 内核 127.0.0.1:8787，鉴权头 `x-bot-token`，token 在 `<数据目录>\config.json` 的 `gateway.wechat.inboundToken`；启动器里已有取 token/调内核的写法，找现成的复用，不要另起一套。
- 已有接口：`POST /api/send-file {chat,path}`、`GET /api/send-file/status?id=`、`POST /api/send-emoticon {chat,code}`、`/api/wechat/contacts`、`/api/status`、`/api/debug/state`。
- 没有「发纯文本」的调试接口，需要你在 `src/http/routes/` 加一个 `POST /api/send-text {chat,text}`（同样的 loopback+token 校验，复用现有 gateway/bridge 的发文本能力，写完加测试）。

## 要做的页面：`launcher\Views\DebugPage.xaml(.cs)`，导航名「调试台」，放在「Codex 日志」下面
一页五个分组（TabControl 或纵向 Card 都可以，跟现有深色风格一致）：

1. **发文件**：目标会话输入框、文件路径输入框 + 「选择文件」按钮、发送按钮；显示 jobId、轮询 status（queued/submitted/failed 与 error 原文），失败时把完整错误显示出来。
2. **发表情**：目标会话 + 表情代码（如 `[微笑]`）+ 发送；显示返回的 ok/reason。
3. **链接**：目标会话 + 文本（可含 URL）+ 发送，走新的 `/api/send-text`；显示返回。
4. **Codex**：任务文本（多行）、工作目录（默认 `C:\Users\1\Desktop`）、数量/超时提示；「运行」调 `C:\Users\1\AppData\Roaming\npm\codex.cmd exec -c model_reasoning_effort="high" --dangerously-bypass-approvals-and-sandbox -`，把任务从 stdin 喂进去，环境变量 `HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:10808`；实时把 stdout/stderr 追加到下方日志区，结束显示退出码与耗时，支持「取消」（kill 进程树）。
5. **微博**：关键词输入 + 「搜索」；用 `<数据目录>\runtime\node.exe` 起子进程执行一段 node 脚本，require `<仓库>\src\services\weiboPosts.js` 的搜索函数（先读该文件确认导出名与签名，cookie 从 `<数据目录>\weibo.cookie` 读取），把结果（文本前 60 字、图片 URL、原帖链接）列成列表；选中一条显示大图和「下载图片」按钮（下载到 `<数据目录>\debug\weibo\`）。

公共要求：
- 底部一个统一日志区，所有请求打印耗时、HTTP 状态、响应体（截断 2000 字）。
- 数据目录通过启动器现有方式获取（别硬编码用户的路径，允许 `--data` 覆盖，参考现有代码）。
- 线程：所有 HTTP/进程都用 async/await，别阻塞 UI；关闭页面要能取消在跑的 Codex。
- 错误一律捕获并显示原文，别弹 MessageBox 打断。

## 约束
- 只改 `launcher\` 与 `src\http\routes\`（新增 send-text）及相关测试；不要动 `bridge\`、不要动 `src\services\momentsPublisher.js`。
- 编译：`C:\dev\tools\dotnet\dotnet.exe publish launcher\WhaleLauncher.csproj -c Release -o publish` 必须通过；**不要**覆盖 `app\WhaleLauncher.exe`（进程在跑，锁着），产物留在 `publish\`。
- 内核改动要 `node --check` + 跑现有测试（`app\runtime\node.exe tests\*.test.js` 里挑相关的），新增路由要有测试。
- 不要 git commit、不要重启鲸鲸、不要发真实微信消息（发文件/表情/链接的测试只到「构造请求并检查 403/400 校验」级别）。

## 交付
告诉我：新增/修改了哪些文件、`dotnet publish` 结果、新路由的测试结果、页面截图（可以用 `powershell` 截屏存到 `C:\dev\whale-girl\publish\debug-page.png`，我这边看）。
