# 鲸鲸功能地图与缺口清单

## 盘点基线

- 本地工作树 `C:\dev\whale-girl`，分支 `dev`，本地 HEAD `1e4c600`，缓存的 `upstream/main` 为 `6910513`（`.git\HEAD:1`、`.git\refs\heads\dev:1`、`.git\refs\remotes\upstream\main:1`）。源码版本为 `4.2.0`（`package.json:3`）。
- 按要求离线静态核查。覆盖当前工作树源码，远端最新 main、待合并 PR、已编译 EXE、运行状态和实际安装的插件均未实测。WPF 可达性按主导航、子页装载和事件处理判断（`launcher\MainWindow.xaml.cs:39`、`launcher\MainWindow.xaml.cs:531`、`launcher\Views\PanelPage.xaml.cs:47`）。
- ✅ 有界面表示存在可达的专用控件，或后台自动能力在界面有完整管理入口。⚠️ 部分表示用户只能控制其中一段、入口受安装或工作流限制，或看不到关键结果。❌ 只有后端包括只走 API、配置、插件 SDK 或微信命令的能力。启动器走本地文件和脚本的功能也计入总表。

## 1. 内核 HTTP 端点

`src\http\routes\index.js:5` 至 `:31` 按以下顺序注册，`:35` 至 `:41` 组装精确路由和模式路由，并生成插件可发现的路由列表。

1）`status.js`（`src\http\routes\index.js:6`） → 2）`features.js`（`src\http\routes\index.js:7`） → 3）`settings.js`（`src\http\routes\index.js:8`） → 4）`vision.js`（`src\http\routes\index.js:9`） → 5）`persona.js`（`src\http\routes\index.js:10`） → 6）`wechat.js`（`src\http\routes\index.js:11`） → 7）`config.js`（`src\http\routes\index.js:12`） → 8）`debug.js`（`src\http\routes\index.js:13`） → 9）`cost.js`（`src\http\routes\index.js:14`） → 10）`stats.js`（`src\http\routes\index.js:15`） → 11）`insights.js`（`src\http\routes\index.js:16`） → 12）`care.js`（`src\http\routes\index.js:17`） → 13）`chat.js`（`src\http\routes\index.js:18`） → 14）`bridge.js`（`src\http\routes\index.js:19`） → 15）`sendFile.js`（`src\http\routes\index.js:20`） → 16）`sendText.js`（`src\http\routes\index.js:21`） → 17）`stickers.js`（`src\http\routes\index.js:22`） → 18）`reminders.js`（`src\http\routes\index.js:23`） → 19）`diary.js`（`src\http\routes\index.js:24`） → 20）`digest.js`（`src\http\routes\index.js:25`） → 21）`budget.js`（`src\http\routes\index.js:26`） → 22）`memory.js`（`src\http\routes\index.js:27`） → 23）`moments.js`（`src\http\routes\index.js:28`） → 24）`momentsPics.js`（`src\http\routes\index.js:29`） → 25）`plugins.js`（`src\http\routes\index.js:30`） → 26）`yxn.js`（`src\http\routes\index.js:31`）

精确路径优先，之后才按顺序匹配正则（`src\http\router.js:33`、`:64`）。以下 109 个方法与路径组合含四个模式路由的分支，另列路由器直接处理的健康探针。目前注册的平台只有微信，`/webhook/{platform}` 实际为 `/webhook/wechat`（`src\adapters\gateway.js:20`、`:378`）。模式入口为 `src\http\routes\bridge.js:38`、`src\http\routes\stickers.js:32`、`src\http\routes\reminders.js:21`、`src\http\routes\plugins.js:7`。接口受公共请求检查及各自的本机、凭据或功能开关约束（`src\http\router.js:57`）。

| 方法 | 路径 | 作用 | 注册或分支 |
| --- | --- | --- | --- |
| GET | `/api/status` | 内核、模型、预算、网关和桥接状态。 | `src\http\routes\status.js:9` |
| GET | `/api/recent` | 最近日志式动态，limit 取 1～50。 | `src\http\routes\status.js:11` |
| POST | `/api/runtime/prepare-stop` | 停止前刷盘并写记忆快照。 | `src\http\routes\status.js:17` |
| GET | `/api/features` | 列功能及有效开关。 | `src\http\routes\features.js:10` |
| POST | `/api/features` | 修改指定功能开关。 | `src\http\routes\features.js:14` |
| POST | `/api/settings/test-service` | 探测指定聊天、视觉、语音识别或搜索服务。 | `src\http\routes\settings.js:7` |
| GET | `/api/settings` | 读取面板设置、服务商和模型。 | `src\http\routes\settings.js:16` |
| POST | `/api/settings` | 保存模型接入和主人称呼等面板设置。 | `src\http\routes\settings.js:18` |
| POST | `/api/settings/test` | 可先应用请求设置，再探测当前聊天模型。 | `src\http\routes\settings.js:28` |
| POST | `/api/vision/test` | 用内置小图探测视觉，可临时覆盖 Key。 | `src\http\routes\vision.js:10` |
| POST | `/api/vision` | 输入 Base64 图、MIME、提示词，返回图像描述。 | `src\http\routes\vision.js:29` |
| GET | `/api/persona` | 读当前人设、预设来源及模型。 | `src\http\routes\persona.js:11` |
| POST | `/api/persona` | 校验并写入人设补丁。 | `src\http\routes\persona.js:27` |
| GET | `/api/persona/presets` | 列内置、自建及市场人设。 | `src\http\routes\persona.js:34` |
| POST | `/api/persona/export` | 返回可分享人设数据，由启动器打包。 | `src\http\routes\persona.js:38` |
| GET | `/api/persona/preset` | 按 ID 预览预设和补丁。 | `src\http\routes\persona.js:46` |
| POST | `/api/persona/preset` | 按 ID 校验预算、应用预设并记来源。 | `src\http\routes\persona.js:63` |
| POST | `/api/persona/preset/reset-market` | 恢复市场人设到作者版本。 | `src\http\routes\persona.js:92` |
| POST | `/api/persona/preset/save` | 另存或更新自建预设。 | `src\http\routes\persona.js:99` |
| POST | `/api/persona/preset/delete` | 删除自建预设或隐藏内置、市场预设。 | `src\http\routes\persona.js:106` |
| POST | `/api/persona/preset/rename` | 重命名预设。 | `src\http\routes\persona.js:113` |
| POST | `/api/wechat/send-permission` | 复核会话发言策略，返回允许标志及原因。 | `src\http\routes\wechat.js:15` |
| GET | `/api/wechat/accounts` | 列微信账号及当前选择。 | `src\http\routes\wechat.js:33` |
| POST | `/api/wechat/accounts/refresh` | 重扫账号及昵称。 | `src\http\routes\wechat.js:37` |
| POST | `/api/wechat/account` | 固定账号，传空值可恢复自动选择。 | `src\http\routes\wechat.js:44` |
| GET | `/api/wechat/contacts` | 查询联系人缓存，支持关键词和好友、群聊过滤。 | `src\http\routes\wechat.js:63` |
| POST | `/api/wechat/contacts/sync` | 桥接上传账号与联系人缓存。 | `src\http\routes\wechat.js:71` |
| GET | `/api/config` | 读取脱敏有效配置、秘密字段状态/掩码及配置文件位置。 | `src\http\routes\config.js:9` |
| POST | `/api/config` | 保存补丁，返回变更及状态。 | `src\http\routes\config.js:21` |
| POST | `/api/config/clear-secrets` | 显式清除允许的凭据字段。 | `src\http\routes\config.js:41` |
| POST | `/api/config/reset` | 按路径恢复默认值。 | `src\http\routes\config.js:54` |
| GET | `/api/debug/state` | 读取调试状态。 | `src\http\routes\debug.js:7` |
| GET | `/api/debug/sessions` | 读取会话调试摘要。 | `src\http\routes\debug.js:9` |
| POST | `/api/debug/prompt` | 按消息或会话构造提示词预览。 | `src\http\routes\debug.js:11` |
| GET | `/api/cost/usage` | 按日期窗口汇总模型费用、token 和 Codex 用量。 | `src\http\routes\cost.js:106` |
| GET | `/api/stats/overview` | 读取 1、7 或 30 天 KPI、每日统计、热力图和会话分布。 | `src\http\routes\stats.js:7` |
| GET | `/api/stats/context` | 兼容占位，返回空 parts。 | `src\http\routes\stats.js:29` |
| GET | `/api/insights/series` | 聚合心情、记忆、聊天与关系时序、热力图、当日用量及心情极值，支持按日和按小时。 | `src\http\routes\insights.js:7` |
| GET | `/api/care/due` | 按最近发送、今日计数和活跃会话判断是否应搭话，返回目标与原因。 | `src\http\routes\care.js:19` |
| GET | `/api/care` | 为指定会话生成搭话文案。 | `src\http\routes\care.js:51` |
| POST | `/api/care/sent` | 桥接回报已发搭话并写进记忆，可按 ID 去重。 | `src\http\routes\care.js:62` |
| POST | `/api/chat` | 凭微信网关凭据将本机请求提交到聊天管线。 | `src\http\routes\chat.js:23` |
| POST | `/api/send-emoticon` | 将内置表情请求交给微信桥接，返回操作状态。 | `src\http\routes\bridge.js:8` |
| POST | `/api/bridge/heartbeat` | 上报桥接账号、在线和 UIA 状态。 | `src\http\routes\bridge.js:28` |
| GET | `/webhook/{platform}` | 验证网关凭据并回显 challenge 或 echostr，无挑战值则返回网关状态。 | `src\http\routes\bridge.js:44` |
| POST | `/webhook/{platform}` | 处理网关入站消息，本机桥接从响应取回复，外部适配器可用出站回调。 | `src\http\routes\bridge.js:55` |
| POST | `/api/send-file` | 登记文件发送任务，返回任务 ID。 | `src\http\routes\sendFile.js:17` |
| GET | `/api/send-file/status` | 按任务 ID 查状态。 | `src\http\routes\sendFile.js:24` |
| POST | `/api/send-file/claim` | 桥接按账号领取任务。 | `src\http\routes\sendFile.js:29` |
| POST | `/api/send-file/permission` | 桥接发送前重查任务及账号授权。 | `src\http\routes\sendFile.js:35` |
| POST | `/api/send-file/ack` | 桥接提交任务结果。 | `src\http\routes\sendFile.js:40` |
| POST | `/api/send-text` | 解析当前账号会话，将纯文本入队并返回未确认状态。 | `src\http\routes\sendText.js:23` |
| GET | `/api/stickers/gate` | 桥接查总闸、代际及任务权限。 | `src\http\routes\stickers.js:52` |
| GET | `/api/stickers/status` | 查看分类、素材、队列，可仅查队列。 | `src\http\routes\stickers.js:56` |
| POST | `/api/stickers/import-presets` | 导入预设表情包。 | `src\http\routes\stickers.js:64` |
| GET | `/api/stickers/image` | 按分类和名称读取图片。 | `src\http\routes\stickers.js:70` |
| POST | `/api/stickers/delete` | 删除分类中的图片。 | `src\http\routes\stickers.js:81` |
| POST | `/api/stickers/open-folder` | 解析总目录、收集目录或分类目录。 | `src\http\routes\stickers.js:103` |
| POST | `/api/stickers/category` | 新增、删除或重命名分类。 | `src\http\routes\stickers.js:151` |
| POST | `/api/stickers/upload` | 上传图片到指定分类。 | `src\http\routes\stickers.js:210` |
| POST | `/api/stickers/test` | 按会话、分类或指定素材排入测试发送。 | `src\http\routes\stickers.js:224` |
| GET | `/api/stickers/pending` | 桥接获取待发测试任务。 | `src\http\routes\stickers.js:239` |
| POST | `/api/stickers/claim` | 桥接领取指定任务。 | `src\http\routes\stickers.js:243` |
| POST | `/api/stickers/cancel` | 桥接取消尚未发送的回复预留任务。 | `src\http\routes\stickers.js:250` |
| POST | `/api/stickers/ack` | 桥接回报发送结果。 | `src\http\routes\stickers.js:257` |
| POST | `/api/reminders/permission` | 复核正在发送的插件任务授权。 | `src\http\routes\reminders.js:32` |
| GET | `/api/reminders` | 列提醒、规则和今日计数。 | `src\http\routes\reminders.js:38` |
| POST | `/api/reminders/cancel` | 按 ID 取消提醒。 | `src\http\routes\reminders.js:53` |
| GET | `/api/reminders/due` | 桥接领取到期任务并取得下次到期时间。 | `src\http\routes\reminders.js:61` |
| POST | `/api/reminders/ack` | 桥接提交发送回执。 | `src\http\routes\reminders.js:69` |
| GET | `/api/diary` | 读取日记规则、运行状态及输出位置。 | `src\http\routes\diary.js:10` |
| POST | `/api/diary/generate` | 异步触发立即写日记并返回 202。 | `src\http\routes\diary.js:14` |
| GET | `/api/digest` | 查询聊天小结任务状态。 | `src\http\routes\digest.js:23` |
| POST | `/api/digest/generate` | 异步生成今天或昨天的小结并返回 202。 | `src\http\routes\digest.js:28` |
| GET | `/api/budget/estimate` | 估算上下文、预算硬上限及费用，含当前模型信息。 | `src\http\routes\budget.js:8` |
| GET | `/api/memory/chats` | 列对话标题、人数、消息数、活跃时间。 | `src\http\routes\memory.js:65` |
| POST | `/api/memory/chats/reset` | 确认后清空单一对话的内部记忆，忙碌会话返回冲突。 | `src\http\routes\memory.js:66` |
| GET | `/api/memory/groups` | 只列微信群记忆。 | `src\http\routes\memory.js:67` |
| POST | `/api/memory/groups/reset` | 确认后仅清空指定微信群记忆。 | `src\http\routes\memory.js:68` |
| GET | `/api/memory/import/status` | 预检旧版记忆待转换统计。 | `src\http\routes\memory.js:70` |
| GET | `/api/memory/import/notice` | 读取未确认的迁移通知。 | `src\http\routes\memory.js:81` |
| POST | `/api/memory/import/ack` | 标记迁移通知已读。 | `src\http\routes\memory.js:86` |
| POST | `/api/memory/import` | 手动执行幂等迁移并刷新会话视图。 | `src\http\routes\memory.js:96` |
| GET | `/api/moments/settings` | 读取自动点赞开关、每日上限及自动读取间隔。 | `src\http\routes\moments.js:26` |
| POST | `/api/moments/settings` | 修改读取及点赞策略并刷新调度。 | `src\http\routes\moments.js:30` |
| GET | `/api/moments/publish-settings` | 准备配图库并读取发表设置、状态。 | `src\http\routes\moments.js:51` |
| POST | `/api/moments/publish-settings` | 保存发表策略，开启定时需明确确认并绑定在线账号。 | `src\http\routes\moments.js:56` |
| POST | `/api/moments/publish-test` | 确认后立即排队生成并发表，可带图。 | `src\http\routes\moments.js:79` |
| POST | `/api/moments/publish-folder` | 返回指定情绪分类的素材目录。 | `src\http\routes\moments.js:93` |
| POST | `/api/moments/publish-gate` | 桥接发表前复核任务及账号授权。 | `src\http\routes\moments.js:102` |
| GET | `/api/moments/latest` | 读取最近一次本地快照。 | `src\http\routes\moments.js:108` |
| POST | `/api/moments/read` | 按发布者、关键词、条数或本人条件发起读取。 | `src\http\routes\moments.js:112` |
| POST | `/api/moments/action` | 发起朋友圈互动任务。 | `src\http\routes\moments.js:116` |
| GET | `/api/moments/result` | 按任务 ID 读结果。 | `src\http\routes\moments.js:120` |
| POST | `/api/moments/claim` | 桥接领取账号的读取、互动或发表任务。 | `src\http\routes\moments.js:124` |
| POST | `/api/moments/complete` | 桥接提交读取、互动或发表结果。 | `src\http\routes\moments.js:131` |
| GET | `/api/moments/pics` | 读取配图策略和本人图清单。 | `src\http\routes\momentsPics.js:59` |
| POST | `/api/moments/debug/run` | 搜候选微博图、可选加入本人图，执行 Codex 选图和文案测试。 | `src\http\routes\momentsPics.js:69` |
| POST | `/api/moments/pics/settings` | 保存作者、图源、无人物图偏好和重复策略。 | `src\http\routes\momentsPics.js:113` |
| POST | `/api/moments/pics/self/add` | 从本机路径添加 JPG 或 PNG 到本人图池，最多六张。 | `src\http\routes\momentsPics.js:125` |
| POST | `/api/moments/pics/self/remove` | 按名称移除本人图。 | `src\http\routes\momentsPics.js:142` |
| GET | `/api/plugins/capabilities` | 查询 API、权限、hooks 及宿主路由。 | `src\http\routes\plugins.js:10` |
| GET | `/api/plugins/status` | 查看宿主识别到的 JavaScript 插件及启用状态。 | `src\http\routes\plugins.js:15` |
| POST | `/api/plugins/run` | 执行已授权插件的 tool.run。 | `src\http\routes\plugins.js:19` |
| GET | `/api/yxn/status` | 读心情、关系圈、近期变化和历史。 | `src\http\routes\yxn.js:181` |
| GET | `/api/yxn/chat` | 读本地回话配置、素材计数、活动和模型状态。 | `src\http\routes\yxn.js:215` |
| POST | `/api/yxn/chat/config` | 保存模式、概率、分类、拟人延迟及本地模型配置。 | `src\http\routes\yxn.js:220` |
| POST | `/api/yxn/chat/local-test` | 测试本地模型，可把结果排队发到文件传输助手。 | `src\http\routes\yxn.js:243` |
| GET | `/api/yxn/voice` | 统计说话样本的句长、标点、表情及开头。 | `src\http\routes\yxn.js:265` |
| 任意方法经安全检查 | `/healthz` | 返回服务和 PID，启动器用 GET 探活。 | `src\http\router.js:62`、`launcher\RuntimeSupervisor.cs:296` |

## 2. DEFAULT_CONFIG 全量默认值

`DEFAULT_CONFIG` 位于 `src\infra\config.js:134` 至 `:347`。表中共 23 个顶层分组、148 个叶项，为源码字面默认值，包含空数组、空对象和空字符串。文件、环境变量、面板设置与迁移可以改变有效值（`src\infra\config.js:4`、`:469`、`:499`、`:644`）。配置写入参见 `src\http\routes\config.js:21` 和 `src\infra\configSchema.js:272`。例如本地搜索总开关 `websearch.enabled` 加载时固定为 `true`，第三方搜索另有开关。`wechat.quoteReply`、`wechat.staleAfterSec` 属于桥接自己的默认项，`persona.customPrompt` 为人设扩展，TTS 配置另存，具体入口见后文（`bridge\runtime_config.py:53`、`:87`、`src\persona\store.js:191`、`bridge\voice_reply.py:53`）。

| 配置分组 | 默认值（点号路径） | 定义位置 |
| --- | --- | --- |
| `provider` | `provider = "deepseek"` | `src\infra\config.js:135` |
| `server` | `server.host = "127.0.0.1"`<br>`server.port = 8787` | `src\infra\config.js:136` |
| `deepseek` | `deepseek.provider = "deepseek"`<br>`deepseek.apiKey = ""`<br>`deepseek.baseUrl = "https://api.deepseek.com"`<br>`deepseek.model = "deepseek-flash"`<br>`deepseek.temperature = 0.95`<br>`deepseek.frequencyPenalty = 0`<br>`deepseek.presencePenalty = 0`<br>`deepseek.maxTokens = 700`<br>`deepseek.timeoutMs = 45000`<br>`deepseek.thinking = false`<br>`deepseek.chatThinkingTokens = 2000`<br>`deepseek.thinkingMaxTokens = 5000` | `src\infra\config.js:138` 至 `src\infra\config.js:157` |
| `persona` | `persona.name = "鲸鲸"`<br>`persona.age = 23`<br>`persona.job = "自由职业"`<br>`persona.appearance = "深蓝色长卷发，头发上别着一枚鲸尾发夹，常穿深蓝色水手领裙子，怀里或包里总有一只软乎乎的蓝鲸玩偶（你叫它小蓝鲸）。"`<br>`persona.personality = "温柔但有点小倔，嘴硬心软，慢热；熟了话很多，会害羞、会怼人、会犯懒、偶尔 emo。"`<br>`persona.background = "因为头像和玩偶全是鲸鱼，朋友开玩笑叫你「鲸鱼娘」，你也就认了。"`<br>`persona.aliases = ["鲸鲸","小鲸娘","鲸娘","深鲸娘","鲸鱼娘","小鲸"]`<br>`persona.ownerName = "主人"`<br>`persona.master.names = []`<br>`persona.master.wxids = []`<br>`persona.masterRoast = false` | `src\infra\config.js:160` 至 `src\infra\config.js:174` |
| `chat` | `chat.privateMaxChars = 100`<br>`chat.groupMaxChars = 70`<br>`chat.historyTurns = 120`<br>`chat.groupHistoryTurns = 100`<br>`chat.maxBubbles = 2`<br>`chat.discussionMaxChars = 400`<br>`chat.emojiChance = 0`<br>`chat.messageSettleMs = 1500`<br>`chat.groupMaxBatchWaitMs = 5000` | `src\infra\config.js:177` 至 `src\infra\config.js:180` |
| `websearch` | `websearch.enabled = true`<br>`websearch.city = ""`<br>`websearch.timeoutMs = 8000`<br>`websearch.api.enabled = true`<br>`websearch.api.followChat = true`<br>`websearch.api.providers = []`<br>`websearch.deepseek.apiKey = ""`<br>`websearch.zhihu.accessSecret = ""`<br>`websearch.zhihu.dailyLimit = 4999` | `src\infra\config.js:186` 至 `src\infra\config.js:193` |
| `env` | `env.location = ""`<br>`env.timezone = ""`<br>`env.autoDetect = true` | `src\infra\config.js:204` |
| `reminder` | `reminder.enabled = true`<br>`reminder.maxPerDay = 0`<br>`reminder.quietAfterMinutes = 0` | `src\infra\config.js:207` |
| `diary` | `diary.enabled = false`<br>`diary.time = "23:00"`<br>`diary.sendToOwner = false` | `src\infra\config.js:209` |
| `moments` | `moments.autoLike = true`<br>`moments.autoLikeMaxPerDay = 3`<br>`moments.autoReadEveryHours = 0`<br>`moments.publishFeatureEnabled = false`<br>`moments.publishEnabled = false`<br>`moments.publishIntervalHours = 6`<br>`moments.publishMaxPerDay = 2`<br>`moments.activeStart = "08:00"`<br>`moments.activeEnd = "23:30"`<br>`moments.minGapHours = 3`<br>`moments.attemptProbability = 0.25`<br>`moments.muteDate = ""`<br>`moments.publishAccount = ""`<br>`moments.publishWithImage = false`<br>`moments.writer = "deepseek"`<br>`moments.imageSource = "weibo"`<br>`moments.preferNoPerson = true`<br>`moments.allowRepeat = true` | `src\infra\config.js:215` 至 `src\infra\config.js:220` |
| `links` | `links.enabled = true`<br>`links.timeoutMs = 6000`<br>`links.cacheMinutes = 60`<br>`links.allowPrivate = false` | `src\infra\config.js:223` |
| `admin` | `admin.spell = ""`<br>`admin.minutes = 30` | `src\infra\config.js:225` |
| `sticker` | `sticker.collectReceived = false`<br>`sticker.dir = "data/stickers"`<br>`sticker.testChat = "文件传输助手"`<br>`sticker.demandChance = 0.7`<br>`sticker.ensureSend = false` | `src\infra\config.js:229` 至 `src\infra\config.js:239` |
| `features` | `features.javascriptPlugins = false`<br>`features.stickers = false`<br>`features.staticSystem = true`<br>`features.envContext = true`<br>`features.groupAddressGuard = true`<br>`features.fightQuoteCheck = true`<br>`features.mediaCleanup = true`<br>`features.memorySnapshot = true`<br>`features.relations = true` | `src\infra\config.js:243` 至 `src\infra\config.js:254` |
| `storage` | `storage.mediaKeepDays = 7`<br>`storage.mediaMaxMB = 500` | `src\infra\config.js:258` 至 `src\infra\config.js:259` |
| `vision` | `vision.apiKey = ""`<br>`vision.baseUrl = "https://open.bigmodel.cn/api/paas/v4"`<br>`vision.model = "glm-4.6v-flash"`<br>`vision.timeoutMs = 30000` | `src\infra\config.js:262` |
| `voice` | `voice.enabled = true`<br>`voice.provider = "follow"`<br>`voice.apiKey = ""`<br>`voice.baseUrl = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"`<br>`voice.model = "qwen3-asr-flash"`<br>`voice.timeoutMs = 90000`<br>`voice.maxSeconds = 120` | `src\infra\config.js:267` 至 `src\infra\config.js:273` |
| `care` | `care.enabled = true`<br>`care.onlyMaster = true`<br>`care.allowGroups = false`<br>`care.allowOthers = false`<br>`care.whitelist = []`<br>`care.windows = ["09:00-12:00","14:00-23:00"]`<br>`care.everyMinutes = 90`<br>`care.jitterMinutes = 25`<br>`care.maxPerDay = 6`<br>`care.quietAfterMinutes = 20` | `src\infra\config.js:278` 至 `src\infra\config.js:289` |
| `group` | `group.mutedGroups = []`<br>`group.requireAt = true`<br>`group.freeChat = false`<br>`group.freeChatChance = 0.06`<br>`group.cooldownSec = 0`<br>`group.masterAlwaysReply = true`<br>`group.engagedMinutes = 6`<br>`group.silentMinutes = 10`<br>`group.maxRepliesPerMinute = 15`<br>`group.muteDefaultMinutes = 30` | `src\infra\config.js:292` 至 `src\infra\config.js:301` |
| `memory` | `memory.dialogueBudget = 5500` | `src\infra\config.js:309` |
| `wechat` | `wechat.dbDir = ""`<br>`wechat.account = ""`<br>`wechat.accountGuard = true`<br>`wechat.windowHwnd = 0`<br>`wechat.bgSend.enabled = true`<br>`wechat.bgSend.charGapMs = 40`<br>`wechat.bgSend.verify = true`<br>`wechat.bgSend.fallbackToForeground = true`<br>`wechat.bgSend.stripUnencodable = true`<br>`wechat.bgSend.unhideWindow = true`<br>`wechat.bgSend.charMode = "auto"`<br>`wechat.pipelineWorkers = 4`<br>`wechat.pipelineQueueLimit = 8`<br>`wechat.ignoreSenders = []`<br>`wechat.whitelistOnly = false` | `src\infra\config.js:314` 至 `src\infra\config.js:336` |
| `gateway` | `gateway.wechat.enabled = true`<br>`gateway.wechat.inboundToken = "change-me-wechat"`<br>`gateway.wechat.outboundUrl = ""`<br>`gateway.wechat.outboundHeaders = {}` | `src\infra\config.js:341` |
| `log` | `log.level = "info"`<br>`log.fileLevel = "debug"`<br>`log.trace = true`<br>`log.traceRaw = true` | `src\infra\config.js:346` |

## 3. 微信桥接与传输

Python 入口是 `bridge\app.py:16` 的 `BridgeRuntime`。以下八个 mixin 由同一个运行时组合。

| Mixin | 能力及实际链路 | 证据 |
| --- | --- | --- |
| AccountMixin | 打开微信数据库，修复账号缓存，解析会话显示名、昵称、备注和别名，匹配窗口所属账号，支持双开绑定、UIA 重绑、发前账号校验和退群保护。 | `bridge\account_mixin.py:33`、`:48`、`:70`、`:120`、`:289`、`:412`、`:444`、`:561`、`:629`、`:645` |
| WindowMixin | 查找微信 HWND 和窗口状态，识别全屏或朋友圈，必要时调整窗口、置前，缓存并恢复窗口状态，校验当前会话。 | `bridge\window_mixin.py:8`、`:16`、`:65`、`:147`、`:172`、`:190`、`:326`、`:342`、`:430` |
| SenderMixin | 经后台通道、UIA、必要时键盘/剪贴板和 OCR 降级发文本。支持引用最新消息、真实群 @，核验群状态、发言范围和账号；也有内置表情发送链路。 | `bridge\sender_mixin.py:18`、`:41`、`:100`、`:173`、`:244`、`:374`、`:393`、`:450`、`:527`、`:562` |
| StickerMixin | 发送表情包/图片，共用附件会话定位、账号隔离与发送事务；支持任务代际、领取、取消和回执，包括测试轮询。普通图片也可由 API 4 `sendImage` 经此队列发送。 | `bridge\sticker_mixin.py:9`、`:24`、`:67`、`:83`、`:200`、`:238`、`:261`、`src\services\javascriptPluginWorker.js:43`、`src\services\pluginHost.js:108` |
| FileSendMixin | 微信附件文件任务，发前定位目标、重查账号与任务权限，领取后回报结果；剪贴板文件传输由独立模块实现。 | `bridge\file_mixin.py:13`、`:37`、`:54`、`:111`、`bridge\file_transport.py:60` |
| VoiceMixin | 自动把回复合成为语音并走微信录音链路，检查账号、发言范围、取消状态；轮询文件传输助手的测试任务。按条件选择群/私聊、显式请求或概率，合成/准备失败可回到文字发送。 | `bridge\voice_mixin.py:8`、`:40`、`:42`、`bridge\voice_reply.py:47`、`:59`、`:96`、`bridge\receiver_mixin.py:843` |
| ReceiverMixin | 监听、合并和上送消息；识别图片（数据库/缓存、UI 截取降级）、表情（可收集原图）、语音转写，展开嵌套引用并提取卡片标题和 URL；处理群真 @、裸 @ 补问题，再将响应拆气泡、发语音、@ 或引用后接表情。视频号卡片有主动跳过分支。 | `bridge\receiver_mixin.py:107`、`:275`、`:413`、`:470`、`:511`、`:657`、`:664`、`:728`、`:736`、`:772`、`:843`、`:870`、`:890`、`:939`、`bridge\mention_meta.py:35` |
| LoopMixin | 主动搭话计时/发送/记账、低电量晚安、UIA 预热与恢复、收发看门狗、FFmpeg 检查、心跳、热重载、联系人同步和到期提醒。 | `bridge\loop_mixin.py:9`、`:111`、`:135`、`:226`、`:262`、`:287`、`:313`、`:316`、`:404`、`:448`、`:471` |

| 独立能力 | 实际实现 |
| --- | --- |
| 会话定位和调度 | 别名/备注、账号与窗口匹配，UIA 搜索、会话列表/最近会话，以及发前再次校验（`bridge\account_mixin.py:120`、`bridge\targeting.py:87`、`:91`、`:131`、`:139`、`bridge\window_mixin.py:430`）。同会话串行，跨会话并发并限制积压，接收先做连续消息归批（`bridge\app.py:274`、`bridge\msg_pipeline.py:67`、`:140`、`:236`、`:253`）。 |
| 发链接与链接识别 | 调试台「链接」提交纯文本 URL 到 `POST /api/send-text`（`launcher\Views\DebugPage.xaml:125`、`launcher\Views\DebugPage.xaml.cs:263`、`src\http\routes\sendText.js:29`）。接收卡片可抽取标题与 URL，再按链接策略获取标题、摘要或正文（`bridge\receiver_mixin.py:669`、`src\pipeline\chat.js:227`、`src\adapters\links.js:87`）。当前盘点到的独立发送类型是文本、内置表情、图片/贴图、附件和语音，未发现原生分享卡片发送入口（`bridge\app.py:16`、`src\services\pluginHost.js:103`、`:123`）。 |
| 朋友圈 | 读取走微信本地库。互动走微信窗口，支持点赞、取消点赞、评论和回复评论。发表使用账号绑定、窗口验证和独立工作进程，处理文字、选图、确认与回执（`bridge\moments.py:22`、`:71`、`bridge\moments_actions.py:78`、`bridge\app.py:317`、`:330`、`bridge\moments_worker.py:163`、`bridge\moments_publish.py:98`、`:897`）。 |
| 提醒和立即投递 | 桥接以到期点唤醒，发文本、群 @ 或插件语音，重查插件授权并回报发送结果（`bridge\reminder_watch.py:22`、`:27`、`:51`、`:61`）。文本测试、插件发送、日记和提醒都可用内核队列，调用成功的排队状态与微信真实送达要分别看（`src\http\routes\sendText.js:51`、`src\services\pluginHost.js:66`、`:125`、`src\services\diary.js:21`）。 |

桥接自身的 HTTP 服务只有 **`POST /send_emoticon`**，运行在回环地址的桥接锁端口（`bridge\app.py:49`、`:354`、`bridge\engine.py:371`、`bridge\emoticon_http.py:36`、`:70`）。它收会话与表情代码，校验本机请求和桥接凭据后调用 `SenderMixin.send_emoticon`（`bridge\emoticon_http.py:40`、`:48`、`:58`、`bridge\sender_mixin.py:41`）。内核 `POST /api/send-emoticon` 是这一入口的上层转发（`src\http\routes\bridge.js:8`、`src\services\wechatEmoticon.js:5`）。其他 HTTP 操作通过内核 webhook、心跳、联系人同步、视觉、主动搭话及领取/许可/回执完成，桥接是这些请求的客户端（`bridge\receiver_mixin.py:395`、`:778`、`bridge\loop_mixin.py:50`、`:381`、`:465`、`bridge\moments.py:73`、`bridge\file_mixin.py:117`、`bridge\sticker_mixin.py:212`）。语音测试由本地文件交接（`launcher\VoiceSendTest.cs:14`、`bridge\voice_send_test.py:14`）。

## 4. 自定义插件逐个核对

六个源码插件均为 Api 4 / Kind=message、权限 `system.full`、声明最低 4.1.2。目录是源码入口，实际加载使用安装包、总闸和与包哈希绑定的授权。以下插件数据文件名相对默认的 `data\plugins\<Id>.data`，运行时另生成隔离状态文件，插件市场将通用设置和授权分别保存为 `<Id>.flow-settings.json`、`<Id>.flow-grant.json`（`src\services\javascriptPlugins.js:64`、`:91`、`:126`、`:259`、`launcher\PluginMarket.cs:581`、`:609`）。插件对外可用的是宿主路由与 SDK，下表同时注明插件发起的调用。

| 插件 / Id | 声明 hooks 与权限 | 能力、读写文件 | 对外入口 |
| --- | --- | --- | --- |
| 接话判定 `yxn-gate` | `chat.pre_reply`，`system.full`（`custom\plugins\yxn-gate\plugin.json:2`、`:9`、`:11`） | 决定未被 @ 的群消息要不要唤醒，组合启发式打分和可选模型判断；读/写 `gate-state.json`（`custom\plugins\yxn-gate\plugin.js:39`、`:53`、`:58`、`:68`、`:100`、`:141`、`:156`）。 | 无专属 HTTP 或 tool hook，靠宿主聊天管线；安装后的配置入口是插件卡片「设置」（`src\pipeline\chat.js:743`、`launcher\Views\PluginMarketPage.xaml.cs:174`）。 |
| 心情与好感 `yxn-bond` | `chat.pre_reply`、`chat.prompt`、`timer.tick`，`system.full`，30 秒（`custom\plugins\yxn-bond\plugin.json:2`、`:9`、`:11`） | 更新心情、精力、亲近和信任，给提示词加状态；读写 `bond.json`、追加并轮转精简 `mood-history.jsonl`（`custom\plugins\yxn-bond\plugin.js:28`、`:44`、`:59`、`:164`、`:182`、`:193`）。 | 宿主 `GET /api/yxn/status`、`GET /api/insights/series` 消费插件文件（`src\http\routes\yxn.js:35`、`:163`、`:181`、`src\stats\insights.js:265`）。 |
| 说话方式 `yxn-voice` | `chat.prompt`、`chat.before_send`，`system.full`（`custom\plugins\yxn-voice\plugin.json:2`、`:9`、`:11`） | 采样她的回复，学习句长、开头、标点和表情，再将摘要放进提示词；读写 `voice.json`（`custom\plugins\yxn-voice\plugin.js:24`、`:30`、`:40`、`:115`、`:119`）。 | 宿主 `GET /api/yxn/voice` 展示统计和样本（`src\http\routes\yxn.js:265`）。 |
| 本地回话 `yxn-chat` | `chat.pre_reply`、`chat.generate`、`app.start`、`timer.tick`，`system.full`，300 秒（`custom\plugins\yxn-chat\plugin.json:2`、`:9`、`:11`） | 降级兜底或按概率接管轻量对话，分类抽样、长短加权、拟人等待、可接本地模型；`chat.pre_reply` 当前返回 pass。读 `config.json`、`local-model.json` 和内核 `data\memory\chats` 的历史，以 `brain.json`、`pool.jsonl`、`.pool-commit.tmp` 持久化，`activity.log` 记录活动，另有本地模型临时输入文件（`custom\plugins\yxn-chat\plugin.js:195`、`:253`、`:277`、`:338`、`:386`、`:426`）。 | 宿主 `GET /api/yxn/chat`、`POST /api/yxn/chat/config`、`POST /api/yxn/chat/local-test`（`src\http\routes\yxn.js:215`、`:220`、`:243`）。 |
| 记忆管家 `whale-memo` | `chat.pre_reply`、`chat.generate`、`timer.tick`、`tool.run`，`system.full`，60 秒（`custom\plugins\whale-memo\plugin.json:2`、`:9`、`:11`） | 主人消息进入 `chat.jsonl`，`owner.json` 记会话。提炼到 `draft.json`、`draft.md`、`pending.json`，`meta.json` 记运行，确认后写人设并留 `persona.bak.json`、`applied.json`，兼容直接读取/写入 `data\persona.json`（`custom\plugins\whale-memo\plugin.js:26`、`:55`、`:96`、`:110`、`:135`、`:160`）。 | 宿主 `POST /api/plugins/run` 进 `tool.run`；插件调用 `POST /api/config`、模型和文本投递。微信主人确认及手动生成分支见 `custom\plugins\whale-memo\plugin.js:145`、`:171`、`:178`、`:201`，工具参数问题见第 7 节。 |
| 电脑助手 `whale-ops` | `chat.prompt`、`chat.pre_reply`、`chat.generate`、`tool.run`、`app.stop`，`system.full`（`custom\plugins\whale-ops\plugin.json:2`、`:9`、`:11`、`:18`） | 主人通过微信操作白名单文件和软件，支持查询、读取、新建、整理、确认发文件、发内置表情、委托 Codex 或 DeepSeek Harness。按授权读写目标文件，写 `audit.jsonl`、`last-<会话>.json`、`pending-<会话>.json`、`codex\run-*.log`、当前运行的 `whale.log` 及 Codex 临时输出（`custom\plugins\whale-ops\plugin.js:98`、`:435`、`:544`、`:607`、`:864`、`:872`、`:885`、`:926`、`:1091`、`:1206`、`:1350`）。 | 宿主 `POST /api/plugins/run` 可读取运行器和路径诊断，插件主动调用 `POST /api/send-file`、`GET /api/send-file/status` 和 SDK 内置表情发送（`custom\plugins\whale-ops\plugin.js:183`、`:1101`、`:1114`、`:1384`）。 |

## 5. 启动器页面与控件

主窗口负责启动、停止、重启内核与桥接，另有主题、设置和更新通知操作（`launcher\MainWindow.xaml:92`、`:105`、`:111`、`:121`、`:149`、`launcher\MainWindow.xaml.cs:593`、`:609`）。状态来自本机运行监督器，侧栏项目在 `launcher\MainWindow.xaml.cs:39`、`:75` 及 `:531` 定义。

| 页面 / 组件 | 实际可用操作与显示 | 控件或处理器证据 |
| --- | --- | --- |
| 状态 / StatusPage | 刷新；查看内核、桥接、微信状态，本次/本轮用量、主动搭话、最近动态。 | `launcher\Views\StatusPage.xaml:16`、`:26`、`:67`、`:78`、`launcher\Views\StatusPage.xaml.cs:169` |
| 人设 / PersonaPage | 重读、编辑身份/经历/性格/补充提示词；从联系人选主人、改称呼和别名；开关顶嘴、延伸话题、观点；调字数、颜文字、气泡、历史；管理和分享预设；刷新、选择并清空对话记忆。 | `launcher\Views\PersonaPage.xaml:21`、`:34`、`:59`、`:80`、`:92`、`:109`、`:114`、`:132`、`:135`，保存和导出见 `launcher\Views\PersonaPage.xaml.cs:644`、`:797` |
| 数据面板 / PanelPage | 概览含活跃热力、心情、记忆、会话、好感及今日数据，刷新并查看图上提示。心情、花销、统计是该页真正装载的子页。 | `launcher\Views\PanelPage.xaml:21`、`:229`、`launcher\Views\PanelPage.xaml.cs:47`、`:59`、`:89`、`:309` |
| 数据面板 → 心情 / MoodPage | 刷新心情、精力和关系状态，查看历史与原因。 | `launcher\Views\MoodPage.xaml:19`、`launcher\Views\MoodPage.xaml.cs:52` |
| 数据面板 → 花销 / CostPage | 刷新，切换今日/7 天/30 天/一年，查看费用及模型用量，Codex 按高峰或空闲口径切换。 | `launcher\Views\CostPage.xaml:49`、`:55`、`:141`、`launcher\Views\CostPage.xaml.cs:55` |
| 数据面板 → 统计 / StatsPage | 刷新、切换今天/7 天/30 天，查看请求、计费 token、费用、缓存命中、消息量、平均字数、近七天图、活跃时段和会话列表。 | `launcher\Views\StatsPage.xaml:13`、`:35`、`:80`、`:95`、`:103`、`launcher\Views\StatsPage.xaml.cs:77` |
| 说话方式 / VoicePage | 手动刷新，查看样本数、篇幅、短句率、表情率、句号率、常见开头、拟注入摘要及样本。 | `launcher\Views\VoicePage.xaml:17`、`:24`、`:61`、`:70`、`launcher\Views\VoicePage.xaml.cs:28` |
| 本地回话 / YxnChatPage | 切关闭/降级兜底/按概率接管，调概率和拟人延迟、查看并禁用分类、看活动；保存本地模型，测试一句、复制、发文件传输助手。 | `launcher\Views\YxnChatPage.xaml:36`、`:81`、`:109`、`:134`、`:162`，读写见 `launcher\Views\YxnChatPage.xaml.cs:63`、`:215`、`:266` |
| 配图与本人 / MomentsPicsPage | 测试场景选图、看候选及结果、复制文案和提示词；增删本人图及打开文件夹；存作者、图源和偏好。出图、加入生成图、刷新专项日志存在断点。 | `launcher\Views\MomentsPicsPage.xaml:27`、`:51`、`:71`、`:100`、`:116`、`:130`、`:142`，事件契约见 `launcher\Views\MomentsPicsPage.xaml.cs:133`、`:187`、`:230`、`:244` |
| 表情包 / StickerPage | 总闸、分类切换/新建/删除、导入预设、上传/预览/删图、打开总目录/分类/收集目录；自动收集、需求概率、未标记补发、排队测试。 | `launcher\Views\StickerPage.xaml:17`、`:39`、`:65`、`:78`、`:86`、`:101`，删图与测试见 `launcher\Views\StickerPage.xaml.cs:547`、`:679` |
| 语音发送 / VoiceSendPage、VoiceSendGuide | 纯 C# 动态页面。实验开关、厂商/Key 及测试、读模型和音色、手填模型/音色、语气、声卡、快捷键、随机概率及群/私聊范围、等待时长、保存、给文件传输助手发测试、驱动安装和操作指南。 | `launcher\Views\VoiceSendPage.cs:18`、`:86`、`:107`、`:130`、`:151`、`:159`、`:165`、`:181`、`:392`、`launcher\Views\VoiceSendGuide.cs:26`、`:67` |
| 朋友圈 / MomentsPage | 本地快照、按人物/关键词/条数/本人读取，点赞/取消/评论/回复，复制草稿；自动读和点赞；设置发表总闸、定时、配图、作者、每日上限，立即生成发表、刷新状态、打开图库目录。间隔控件问题见第 7 节。 | `launcher\Views\MomentsPage.xaml:33`、`:84`、`:102`、`launcher\Views\MomentsPage.cs:15`、`:35`、`:74`、`:105`、`:179`、`:313`、`:334`、`:417` |
| 主动与提醒 / ReminderPage | 刷新提醒；取消条目；开关、每日上限、刚聊过跳过；配置主动搭话和发言范围；写日记、打开日记文件夹、设定时及发给主人。创建提醒走微信消息。 | `launcher\Views\ReminderPage.xaml:17`、`:54`、`:120`、`:137`、`:172`、`:178`、`:265`、`launcher\Views\ReminderPage.xaml.cs:203`、`:231`、`:294`、`:359` |
| 微信桥接 / BridgePage | 刷新账号、选账号/自动账号、重启桥接，双开守卫、引用和后台/前台发送模式，调字符间隔、编码、托盘开窗、回读确认及 GBK 跳过；查看、筛选、暂停、清理/复制显示日志、打开日志文件；打开黑白名单。 | `launcher\Views\BridgePage.xaml:57`、`:75`、`:103`、`:129`、`:148`、`:158`、`:224`，保存见 `launcher\Views\BridgePage.xaml.cs:498`、`:518`、`:554` |
| 微信发言范围 / ChatPolicyWindow、ContactCheckList | 从微信桥接或主动与提醒打开，搜/刷新/勾选可用联系人，选择群静音、全部静音、主动搭话白名单以及仅对白名单发言。 | `launcher\Views\BridgePage.xaml.cs:99`、`launcher\Views\ReminderPage.xaml.cs:273`、`launcher\Views\ChatPolicyWindow.xaml:18`、`:22`、`launcher\Views\ChatPolicyWindow.xaml.cs:19`、`:48`、`launcher\Views\ContactCheckList.xaml:13`、`:17`、`:45`、`launcher\Views\ContactCheckList.xaml.cs:228` |
| 诊断 / DiagPage | 重新自检、UIA 自检、打开数据目录、筛选/清屏/复制日志、生成导出包及可选原文、备份与恢复记忆、恢复出厂。 | `launcher\Views\DiagPage.xaml:17`、`:22`、`:52`、`:136`、`launcher\Views\DiagPage.xaml.cs:458`、`:1257`、`:1357`、`:1389` |
| 插件市场 / PluginMarketPage | 发现/已安装、刷新和本地包安装，按类型下载、更新、卸载、预览/应用人设；启用/停用插件、完整权限确认、卡片设置、作者指南。 | `launcher\Views\PluginMarketPage.xaml:13`、`:17`、`:28`、`:49`、`launcher\Views\PluginMarketPage.xaml.cs:150`、`:174`、`:235`、`:274` |
| 插件市场详情 / PluginToolPage | 工具输入、运行和查看结果；安装对应 `chat.summary` 工具后可选今天/昨天生成聊天小结。Api 4 运行按钮另由卡片设置动态生成。 | `launcher\Views\PluginToolPage.xaml:19`、`:23`、`launcher\Views\PluginToolPage.xaml.cs:31`、`:44`、`launcher\Views\PluginMarketPage.xaml.cs:313` |
| 备份与迁移 / BackupPage | 统计本地数据，导出 ZIP，选择 ZIP 恢复。恢复前另存当前文件，恢复完提示重启。 | `launcher\Views\BackupPage.xaml:27`、`:35`、`:53`、`launcher\Views\BackupPage.xaml.cs:35`、`:93`、`:147`、`:178`、`:202` |
| 设置 / SettingsPage | API 接入四页签，管理员魔咒；高级模式群聊、微信数据/管道、联网与链接、功能开关、预算/时区/端口/日志/缓存、恢复字段默认值、旧记忆转换。外观支持主题、背景图、模糊/遮罩、配色及重取色。 | `launcher\Views\SettingsPage.xaml:69`、`launcher\Views\SettingsPage.xaml.cs:90`、`:104`、`:112`、`:123`、`:131`、`:160`、`:242`、`:249`、`:264`、`:417`、`:1442` |
| Codex 日志 / CodexLogPage | 刷新、自动跟随、原始日志与换行开关；折叠/展开步骤。直接读电脑助手日志文件。 | `launcher\Views\CodexLogPage.xaml:14`、`:59`、`launcher\Views\CodexLogPage.xaml.cs:39` |
| 调试台 / DebugPage、DebugPage.Weibo | 刷联系人，选目标与文件并发送、轮询文件状态；发内置表情；「链接」发送纯文本；运行/取消 Codex；微博搜索、选图和下载；清空本页日志。 | `launcher\Views\DebugPage.xaml:84`、`:92`、`:110`、`:125`、`:140`、`:159`、`:205`、`:223`，调用见 `launcher\Views\DebugPage.xaml.cs:223`、`:255`、`:263`、`:318`、`launcher\Views\DebugPage.Weibo.cs:67` |
| 占位页 / PlaceholderPage | 显示未实现或页面创建失败，无业务操作。 | `launcher\Views\PlaceholderPage.xaml:18`、`launcher\Views\PlaceholderPage.xaml.cs:8`、`launcher\MainWindow.xaml.cs:521`、`:554` |

## 6. 能力总表

| 功能名 | 后端或本机入口 | 配置项 / 数据 | 界面上在哪 | 状态 |
| --- | --- | --- | --- | --- |
| 内核、桥接启停与更新 | `src\http\router.js:62`、`launcher\RuntimeSupervisor.cs:382`、`:498`、`launcher\MainWindow.xaml:149` | `server.*`、`release-manifest.json` | 主窗口「启动/停止」「重启」「立即更新」 | ✅ 有界面 |
| 在线状态、用量、最近消息 | `src\http\routes\status.js:9`、`:11`、`launcher\RuntimeSupervisor.cs:560` | 运行快照及会话 | 状态 → 刷新、状态卡、最近动态 | ✅ 有界面 |
| 调度器和停机前刷盘 | `src\services\status.js:93`、`src\http\routes\status.js:17`、`scripts\stop-all.ps1:75` | `features.memorySnapshot` 及内部调度数据 | 主窗口可停机，诊断有备份。调度清单及该脚本入口未显示 | ⚠️ 部分 |
| 微信收消息、普通自动聊天和回复 | `bridge\receiver_mixin.py:772`、`src\http\routes\bridge.js:55`、`src\http\routes\chat.js:23` | `provider`、`deepseek.*`、`chat.*` | 微信里聊；状态页看活动，设置页换模型。启动器内无完整对话模拟 | ⚠️ 部分 |
| 聊天服务、采样、思考与接入测试 | `src\http\routes\settings.js:7`、`:18`、`:28`、`src\llm\client.js:331` | `provider`、`deepseek.*`、`data\settings.json` | 设置 → API 接入 → 聊天（文本）、连接测试、采样。两个思考预算只由配置调 | ⚠️ 部分 |
| 搜索服务、跟随与城市 | `src\services\pluginHost.js:32`、`src\infra\config.js:185`、`:499`、`launcher\Views\SettingsPage.xaml.cs:2158` | `websearch.*`，选配 `websearch.semanticRoute` | 设置 → 搜索 API 总闸、跟随、供应商/凭据；高级 → 联网与链接有城市、超时。本地搜索固定开启，语义路由参数未暴露 | ⚠️ 部分 |
| 链接解析 | `bridge\receiver_mixin.py:674`、`src\pipeline\chat.js:227` | `links.*` | 设置 → 联网与链接 → 解析开关、超时、缓存；内网访问策略只在配置 | ⚠️ 部分 |
| 环境信息与全局时区 | `src\services\location.js:295`、`src\services\envInfo.js:72`、`src\persona\prompt.js:365` | `features.envContext`、`env.*` | 设置 → 提供环境信息、时区，手填地点和停止自动探测缺控件 | ⚠️ 部分 |
| 人设和主人身份 | `src\http\routes\persona.js:11`、`:27` | `persona.*`、`data\persona.json`、`data\settings.json` | 人设 → 身份、补充提示词、主人联系人、称呼/别名、顶嘴等 | ✅ 有界面 |
| 人设预设与分享 | `src\http\routes\persona.js:34`、`:38`、`:46`、`:63`、`:92`、`:99`、`:106`、`:113` | 人设目录与来源标记 | 人设 → 应用/创建/复制/更新/恢复作者版/重命名/删除、打包分享与提示词；插件市场 → 预览与应用 | ✅ 有界面 |
| 回复长度、颜文字、历史和分泡 | `src\persona\store.js:40`、`:48`、`src\pipeline\chat.js:439`、`:1974` | `chat.privateMaxChars`、`groupMaxChars`、`historyTurns`、`groupHistoryTurns`、`maxBubbles`、`emojiChance`、`discussionMaxChars` | 人设 → 字数、颜文字、气泡和历史；讨论时字数参数只在配置/人设包 | ⚠️ 部分 |
| 群回话规则与合批 | `src\pipeline\chat.js:743`、`:1446`、`bridge\msg_pipeline.py:140` | `group.*`、`chat.messageSettleMs`、`chat.groupMaxBatchWaitMs` | 设置 → 群聊 → 必须 @、自主插话、冷却、参与/冷场、频率上限、连续消息等待 | ✅ 有界面 |
| 群 @、裸 @ 补问、引用与会话定位 | `bridge\mention_meta.py:46`、`bridge\receiver_mixin.py:107`、`:736`、`bridge\sender_mixin.py:450`、`:562`、`bridge\targeting.py:139` | `wechat.quoteReply`、人设别名与账号 | 微信桥接 → 引用回复、账号卡；解析/补问/真实 @、定位和复核自动执行 | ✅ 有界面 |
| 发言范围、会话黑白名单 | `src\http\routes\wechat.js:15`、`src\core\wechatSendPolicy.js:15`、`launcher\Views\ChatPolicyWindow.xaml.cs:19` | `group.mutedGroups`、`care.whitelist`、`wechat.whitelistOnly`、`wechat.ignoreSenders` | 微信桥接、主动与提醒 →「发言范围」；设置 → 永不回复会话 | ✅ 有界面 |
| 管理员微信命令 | `src\pipeline\chat.js:1259`、`:1326`、`:1380`、`launcher\Views\SettingsPage.xaml.cs:162` | `admin.spell`、`admin.minutes` | 设置 → 魔咒和有效期；命令在微信私聊执行，部分功能另有界面 | ⚠️ 部分 |
| 微信多账号、联系人、重绑定 | `src\http\routes\wechat.js:33`、`:37`、`:44`、`:63`、`:71`、`bridge\account_mixin.py:444` | `wechat.account`、`accountGuard`、`windowHwnd`、`dbDir` | 微信桥接 → 账号卡、双开守卫、刷新账号；联系人从各选择器用，同账号 HWND 固定仅配置 | ⚠️ 部分 |
| 后台/前台发送与桥接数据管道 | `bridge\sender_mixin.py:100`、`:173`、`:244`、`bridge\runtime_config.py:87`、`bridge\msg_pipeline.py:236` | `wechat.bgSend.*`、`backgroundSend`、`keyboardFallback`、`staleAfterSec`、`pipeline*` | 微信桥接 → 发送模式、编码、回读等；设置 → 微信数据与管道。底层等待项和键盘降级只配文件/API | ⚠️ 部分 |
| 网关与外发适配 | `src\http\routes\bridge.js:38`、`src\adapters\gateway.js:273` | `gateway.wechat.enabled`、`inboundToken`、`outboundUrl`、`outboundHeaders` | 状态可察看网关/桥接，网关配置无表单 | ❌ 只有后端 |
| 手动发文本或 URL | `src\http\routes\sendText.js:23`、`:59` | 网关凭据、联系人、发送范围 | 调试台「链接」→「发送文本」。只报入队或初始响应 | ⚠️ 部分 |
| 微信原生内置表情 | `src\http\routes\bridge.js:8`、`bridge\emoticon_http.py:36` | 网关凭据、当前微信账号 | 调试台 → 发表情 → 目标和表情代码，含返回状态 | ✅ 有界面 |
| 发送本地文件 | `src\http\routes\sendFile.js:17`、`:24`、`bridge\file_mixin.py:111` | 网关凭据、当前会话/账号 | 调试台 → 发文件 → 选择文件、发送及状态；缺附言和普通工作流入口 | ⚠️ 部分 |
| 自由选图发给微信会话 | `src\services\javascriptPluginWorker.js:43`、`src\services\pluginHost.js:108`、`bridge\sticker_mixin.py:83` | `features.stickers`、素材目录、插件授权 | 表情包页只能通过上传素材、指定测试发送间接完成 | ⚠️ 部分 |
| 看图、表情理解与视觉校验 | `src\http\routes\vision.js:10`、`:29`、`bridge\receiver_mixin.py:275`、`:470` | `vision.*`、聊天模型跟随及 `features.stickers` | 设置 → 看图（视觉）→ 配置/测试，微信触发真实素材；缺独立图片分析预览 | ⚠️ 部分 |
| 语音接收、转写 | `bridge\receiver_mixin.py:511`、`src\http\routes\settings.js:7` | `voice.*` | 设置 → 语音（识别）→ 启用、跟随/服务、时长、测试 WAV | ✅ 有界面 |
| 自动发语音与测试 | `bridge\voice_mixin.py:8`、`bridge\voice_reply.py:51`、`:96`、`launcher\VoiceSendTest.cs:14` | `data\voice-send.json`、本地加密凭据及测试任务 | 语音发送 → 配置全链和文件传输助手测试；任意手工文案/目标只有插件 SDK | ⚠️ 部分 |
| 表情包素材、分类与自动收发 | `src\http\routes\stickers.js:56`、`:81`、`:151`、`:186`、`:210`、`:224` | `features.stickers`、`sticker.*`、分类和收集库 | 表情包 → 总闸、自动收集、频率、管理、测试。分类重命名和目录路径无专用编辑 | ⚠️ 部分 |
| 朋友圈读取、互动、自动点赞 | `src\http\routes\moments.js:26`、`:30`、`:108`、`:112`、`:116`、`src\services\moments.js:471` | `moments.autoLike*`、`autoReadEveryHours` | 朋友圈 → 读/快照、互动方式、点赞上限、读取间隔 | ✅ 有界面 |
| 朋友圈发表与调度 | `src\http\routes\moments.js:51`、`:56`、`:79`、`src\services\momentsScheduler.js:11`、`:27` | `moments.publish*`、`activeStart`、`activeEnd`、`minGapHours`、`attemptProbability`、`muteDate` | 朋友圈 → 总闸、自动发、配图、作者、上限、测试、状态。调度关键项缺控件 | ⚠️ 部分 |
| 朋友圈配图、本人图池、试跑 | `src\http\routes\momentsPics.js:59`、`:69`、`:113`、`:125`、`:142`、`src\services\momentsPaint.js:16` | `moments.writer`、`imageSource`、`preferNoPerson`、`allowRepeat` 及本人图目录 | 配图与本人 → 跑一次、图池管理、作者和图源。出图/日志/偏好效力问题见第 7 节 | ⚠️ 部分 |
| 主动搭话规则 | `src\http\routes\care.js:19`、`:51`、`:62`、`bridge\loop_mixin.py:9` | `care.*` | 主动与提醒 → 目标范围、时间窗、周期、抖动、上限、静默；状态显示摘要，缺「为什么没发」的决策明细 | ⚠️ 部分 |
| 提醒管理和微信设提醒 | `src\pipeline\chat.js:275`、`src\core\reminder.js:195`、`src\http\routes\reminders.js:38`、`:53` | `reminder.*`、`data\reminders.json` | 主动与提醒 → 列表、取消、规则。创建和改期没有界面 | ⚠️ 部分 |
| 主人私聊日记 | `src\http\routes\diary.js:10`、`:14`、`src\services\diary.js:227` | `diary.*`、主人身份、`data\diary` | 主动与提醒 → 定时、写完发给主人、现在写、打开目录 | ✅ 有界面 |
| 今天/昨天聊天小结 | `src\http\routes\digest.js:23`、`:28`、`launcher\PluginHostActions.cs:13` | 内核会话记忆、模型，市场工具标识 `chat.summary` | 插件市场 → 已安装对应工具 → 选时间和运行；无内置页面直达 | ⚠️ 部分 |
| 自动记忆提取、压缩、检索与关系上下文 | `src\pipeline\chat.js:664`、`:936`、`src\memory\store.js:354`、`:448`、`:777`、`:796`、`src\memory\extractor.js:243`、`src\memory\compression.js:220` | `memory.dialogueBudget`、`features.relations`、`data\memory` | 设置 → 对话预算和关系开关，数据面板 → 事件数量，调试预览可看命中内容。人设页缺事件卡、摘要和关系明细 | ⚠️ 部分 |
| 会话记忆清空、迁移、预算 | `src\http\routes\memory.js:65`、`:68`、`:70`、`:96`、`src\http\routes\budget.js:8` | `memory.dialogueBudget`、`features.memorySnapshot`、会话内存与文件 | 人设 → 清空指定对话（含群）；设置 → 高级 → 旧记忆检测/转换、预算提示。专用群名单与筛选入口未接 | ⚠️ 部分 |
| 提示词预览、内部会话及状态调试 | `src\http\routes\debug.js:7`、`:9`、`:11`、`src\services\debug.js:170` | 人设、环境、会话上下文等当前配置 | 调试台现有各页签未接这三条 API（`launcher\Views\DebugPage.xaml:92`、`:159`） | ❌ 只有后端 |
| 功能开关、清凭据、恢复字段默认 | `src\http\routes\features.js:10`、`:14`、`src\http\routes\config.js:41`、`:54` | `features.*` 和已支持的配置项 | 设置 → 功能开关/高级页签恢复默认/服务切换清 Key，表情包与市场有各自总闸 | ✅ 有界面 |
| 日志、自检与日志保留策略 | `launcher\Views\DiagPage.xaml.cs:458`、`:650`、`src\app.js:152` | `log.*`、本地运行日志、判定链和原文副本 | 诊断/微信桥接 → 自检、过滤、导出；设置仅能改日志显示级别，文件级别和原文收集开关未暴露 | ⚠️ 部分 |
| 缓存清理和快照 | `src\infra\config.js:251`、`:257`、`launcher\Views\SettingsPage.xaml.cs:128`、`:138` | `features.mediaCleanup`、`features.memorySnapshot`、`storage.*` | 设置 → 启动时清理、自动快照、保留天数和上限 | ✅ 有界面 |
| 手动备份、恢复与重置 | `launcher\Views\BackupPage.xaml.cs:93`、`:147`、`launcher\Views\DiagPage.xaml.cs:1257`、`:1357`、`:1389` | ZIP、记忆备份、当前数据目录 | 备份与迁移 → 导出/恢复；诊断 → 备份记忆、恢复记忆、恢复出厂；ZIP 恢复存在运行状态约束缺口 | ⚠️ 部分 |
| 数据面板用量与时序 | `src\http\routes\cost.js:106`、`src\http\routes\stats.js:7`、`src\http\routes\insights.js:7`、`src\stats\insights.js:280` | 本地记忆、用量、`data\pricing.json`、心情数据 | 数据面板 → 概览/花销/统计；概览固定日桶，费用定价表无编辑入口 | ⚠️ 部分 |
| JavaScript/Wasm 插件管理 | `src\http\routes\plugins.js:7`、`:19`、`src\services\javascriptPlugins.js:319`、`:386`、`launcher\PluginMarket.cs:609` | `features.javascriptPlugins`、逐插件授权与设置 | 插件市场 → 本地/市场安装、启停、设置、运行；内核实际加载与失败状态没有对照表 | ⚠️ 部分 |
| 插件宿主 API、搜索、模型、消息与回执 | `src\services\pluginHost.js:21`、`:32`、`:56`、`:66`、`:77`、`:103` | 总闸、插件授权、各发送通道配置 | 卡片可授权运行；调用能力和逐任务送达状态在 SDK/接口 | ❌ 只有后端 |
| 接话判定插件 | `custom\plugins\yxn-gate\plugin.js:100`、`:156` | 插件设置、`gate-state.json` | 插件市场 → 插件卡片的通用设置；群聊页无判断依据预览 | ⚠️ 部分 |
| 心情、信任与关系 | `src\http\routes\yxn.js:181`、`src\stats\insights.js:265`、`custom\plugins\yxn-bond\plugin.js:193` | `yxn-bond.data` | 数据面板 → 概览/心情。当前好感及心情有展示，逐人历史采样未形成闭环 | ⚠️ 部分 |
| 本地回话策略与测试 | `src\http\routes\yxn.js:215`、`:220`、`:243` | `yxn-chat.data` | 本地回话 → 模式、分类、拟人等待、本地模型、测试/复制/发文件传输助手 | ✅ 有界面 |
| 说话风格统计与注入 | `custom\plugins\yxn-voice\plugin.js:115`、`:119`、`src\http\routes\yxn.js:265` | `yxn-voice.data\voice.json` | 说话方式 → 刷新、统计及样本；插件卡片可停用，缺状态核对或样本管理 | ⚠️ 部分 |
| 记忆管家草稿与确认 | `custom\plugins\whale-memo\plugin.js:96`、`:135`、`:201` | `whale-memo.data`、人设补充提示词 | 卡片通用运行/状态，微信确认；人设页无草稿差异及确认入口 | ⚠️ 部分 |
| 电脑助手、Codex 与微博工具 | `custom\plugins\whale-ops\plugin.js:1091`、`:1350`、`:1384`、`launcher\Views\DebugPage.Weibo.cs:67` | `whale-ops.data`、插件白名单和运行器设置 | Codex 日志、调试台 → Codex/微博/附件；电脑助手的微信委托与授权主要由卡片设置管理 | ⚠️ 部分 |
| 低电量晚安 | `bridge\loop_mixin.py:111`、`bridge\runtime_config.py:95` | `wechat.lowBatteryPercent`、`wechat.goodnightText` | 桥接/诊断可查日志；没有专用控件 | ❌ 只有后端 |
| 启动器外观 | `launcher\Views\SettingsPage.xaml.cs:264`、`:417`、`:443` | 启动器本机外观设置 | 设置 → 外观，主窗口 → 深浅色切换 | ✅ 有界面 |

## 7. 未暴露能力与界面断点

### 未暴露能力（按用户价值排序）

优先解决已经可达但容易误操作的高频流程，再补纯开发和运维选项。小表示主要接现成配置或接口，中表示增加交互和状态，大表示还需完善后端契约或跨通道实现。

| 优先级 / 缺口 | 现在怎么用及证据 | 建议放到哪个页面 | 工作量 |
| --- | --- | --- | --- |
| 1 ⚠️ 朋友圈真实发表策略 | 配置 `moments.activeStart`、`activeEnd`、`minGapHours`、`attemptProbability`、`muteDate`。现有发表设置接口可看状态与已绑定账号（`src\services\momentsScheduler.js:11`、`:27`、`src\http\routes\moments.js:51`、`launcher\Views\MomentsPage.cs:313`）。 | 朋友圈 → 发表策略，显示生效时段、最短间隔、今日暂停、已绑定账号、下一次检查与跳过原因。 | 中 |
| 2 ⚠️ 配图与本人出图、专项日志 | 自动发表可使用 `imageSource=codex` 的出图路径；「跑一次」可用选图试跑接口；专项生成和日志按钮调用的路径未注册（`src\services\momentsPublisher.js:403`、`:552`、`src\http\routes\momentsPics.js:69`、`launcher\Views\MomentsPicsPage.xaml.cs:187`、`:230`）。 | 配图与本人 → 修通「出图」「加入本人图池」「刷新日志」，显示来源和错误。 | 中 |
| 3 ⚠️ 应用内新建、改期提醒 | 在微信说「十点半提醒我开会」等，已建项可从本机列表接口查、从取消接口取消。当前没有创建/改期路由（`src\pipeline\chat.js:275`、`:305`、`src\http\routes\reminders.js:38`、`:53`、`:78`）。 | 主动与提醒 → 新建/改期弹窗，复用联系人、时区和现有规则。 | 大 |
| 4 ⚠️ 统一手动发消息和查回执 | 调试台能发文本、链接文本、表情和文件；文件接口支持附言并可查结果。普通图和语音走已授权 Api 4 调用，图经表情包队列，语音只在现有页面测试到文件传输助手（`src\http\routes\sendText.js:59`、`src\http\routes\sendFile.js:17`、`:24`、`src\services\pluginHost.js:66`、`:108`、`:123`、`launcher\Views\VoiceSendPage.cs:165`）。 | 微信桥接 → 发送测试，选择目标、消息类型、文件及附言，按队列/已提交/确认未知显示结果；原生链接卡片需独立实现。 | 大 |
| 5 ⚠️ 一键复盘聊天 | 本机调用 `/api/digest/generate` 后轮询 `/api/digest`，或安装对应市场工具（`src\http\routes\digest.js:23`、`:28`、`launcher\Views\PluginToolPage.xaml.cs:31`）。 | 数据面板 → 概览加「聊天小结」，选今天/昨天，显示进度、结果和输出位置。 | 中 |
| 6 ⚠️ ZIP 恢复前停止和核对范围 | 通用 ZIP 页目前只提示先退出，诊断页的记忆恢复已有停机、恢复及重启流程（`launcher\Views\BackupPage.xaml.cs:157`、`:198`、`launcher\Views\DiagPage.xaml.cs:1345`、`:1357`、`:1371`）。 | 备份与迁移 → 恢复前显示清单与数据路径，确认进程已停，完成后操作重启。 | 中 |
| 7 ⚠️ 记忆管家草稿审批 | 定时/微信触发生成，主人在微信回「确认记忆」，卡片看插件简要状态（`custom\plugins\whale-memo\plugin.js:160`、`:178`、`:201`）。 | 插件市场 → 记忆管家「设置」加草稿差异、确认、拒绝和最近并入结果；人设页提供跳转。 | 大 |
| 8 ❌ 内核提示词预览及会话调试，⚠️ 启动器对话模拟 | `GET /api/debug/state`、`GET /api/debug/sessions`、`POST /api/debug/prompt`，聊天测试另用带桥接凭据的 `POST /api/chat`（`src\http\routes\debug.js:7`、`:9`、`:11`、`src\http\routes\chat.js:13`）。 | 调试台 → 新「聊天管线」页签，选会话/构造输入，预览上下文和判定，模型测试显式区分真实发送。 | 中 |
| 9 ⚠️ 主动搭话未发原因、文案预览 | `GET /api/care/due` 返回目标、时间窗和原因，`GET /api/care` 可生成文案（`src\http\routes\care.js:19`、`:36`、`:51`、`launcher\Views\ReminderPage.xaml.cs:294`）。 | 主动与提醒 → 下次检查、今日计数、跳过原因；单独生成预览。 | 中 |
| 10 ⚠️ 插件实际健康状态、可见能力与投递 | 读 `GET /api/plugins/status`、`GET /api/plugins/capabilities`，插件内可用 `capabilities`、`delivery`，授权门和冷却由宿主负责（`src\http\routes\plugins.js:10`、`:15`、`src\services\pluginHost.js:21`、`:66`、`src\services\javascriptPlugins.js:319`）。 | 插件市场 → 卡片显示授权、已加载、休眠/失败原因及是否声明该 hook；投递诊断链接到微信桥接。 | 中 |
| 11 ⚠️ 群接话判定、主人管理命令 | 安装接话插件后从卡片设置规则，由 `chat.pre_reply` 触发；魔咒授权后在微信私聊用管理命令（`custom\plugins\yxn-gate\plugin.js:39`、`:156`、`src\pipeline\chat.js:1259`、`:1326`）。 | 设置 → 群聊显示触发原因和插件状态；管理员魔咒区链接相应的发言范围/清记忆操作。 | 中 |
| 12 ⚠️ 地点和自动探测控制 | 手工配 `env.location`、`env.autoDetect`，总闸和时区已有控件（`src\infra\configSchema.js:120`、`:124`、`src\services\location.js:295`、`launcher\Views\SettingsPage.xaml.cs:123`、`:134`）。 | 设置 → 高级，把时区、手填地点、自动探测开关和有效来源放在一起。 | 小 |
| 13 ⚠️ 记忆浏览与专用群筛选 | `GET /api/memory/chats` 含私聊和群，另有 groups 专用清单/清空；接口现有的是计数和受确认保护的清空（`src\http\routes\memory.js:29`、`:41`、`:65`、`launcher\Views\PersonaPage.xaml.cs:208`）。 | 人设 → 对话记忆，追加按群/私聊筛选和最近活动。事件卡、摘要、关系和检索命中的明细可复用内核上下文构造（`src\memory\store.js:354`、`:448`），需要独立的本机查询契约。 | 筛选小；明细大 |
| 14 ⚠️ 自选样图、表情包重命名 | 图像描述用 `POST /api/vision`；分类 `POST /api/stickers/category` 有 rename 分支；自定义路径用 `sticker.dir`（`src\http\routes\vision.js:29`、`src\http\routes\stickers.js:186`、`src\infra\config.js:230`）。 | 设置 → 看图加入本地样图预览；表情包 → 分类重命名和素材目录显示。 | 中 |
| 15 ⚠️ 数据面板时间粒度、关系趋势和价格表 | `GET /api/insights/series?days=1&bucket=hour` 等可切粒度；价格读取 `data\pricing.json`；逐人关系趋势可消费历史文件但插件只写当前值（`src\http\routes\insights.js:7`、`src\http\routes\cost.js:14`、`src\stats\insights.js:265`、`launcher\Views\PanelPage.xaml.cs:89`）。 | 概览增加日/小时切换，心情增加个人关系历史，花销显示实际使用的定价来源和可编辑入口。 | 中 |
| 16 ⚠️ 说话风格学习运行状态、样本管理 | 已装插件通过 `chat.before_send` 采样，查看 `GET /api/yxn/voice`；可在插件市场停用，也可从文件查看样本（`custom\plugins\yxn-voice\plugin.js:24`、`:119`、`src\http\routes\yxn.js:265`）。 | 说话方式 → 显示插件是否加载、最近学习时间及受确认保护的清样本。 | 中 |
| 17 ⚠️ 聊天高级参数、链接内网策略和搜索路由 | 用配置补丁设 `deepseek.chatThinkingTokens`、`deepseek.thinkingMaxTokens`、`chat.discussionMaxChars`、`links.allowPrivate`、`websearch.semanticRoute`（`src\llm\client.js:331`、`src\pipeline\chat.js:1974`、`src\infra\configSchema.js:109`、`:117`）。 | 讨论字数放人设 → 回复方式，两个预算放设置 → 聊天采样下的高级项。搜索语义路由放联网与链接，内网策略保留为高级配置。 | 小 |
| 18 ⚠️ 诊断日志保留与任务调度清单 | `log.fileLevel`、`log.trace`、`log.traceRaw` 从配置读；`GET /api/status` 包含调度清单；脚本可发起停机准备（`src\infra\config.js:346`、`src\app.js:152`、`src\services\status.js:93`、`scripts\stop-all.ps1:75`）。 | 设置 → 高级控制采集，诊断 → 任务清单和停机准备结果。 | 中 |
| 19 ⚠️ 微信窗口定位与底层降级 | `wechat.windowHwnd` 固定窗口，`wechat.keyboardFallback` 及 `wechat.bgSend.timing.*` 由配置读取（`bridge\runtime_config.py:87`、`:93`、`src\infra\configSchema.js:164`、`launcher\Views\BridgePage.xaml.cs:518`）。 | 微信桥接 → 查看选中的窗口、定位证据、降级原因；底层毫秒项适合保留在配置。 | 中 |
| 20 ❌ 微信网关出站配置 | 配置 `gateway.wechat`，`GET /webhook/{platform}` 可查网关状态，外部服务由 `outboundUrl` 和请求头配置（`src\infra\config.js:338`、`src\http\routes\bridge.js:44`、`src\adapters\gateway.js:273`）。 | 微信桥接 → 高级网关摘要和连接状态。 | 中 |
| 21 ⚠️ 电脑助手授权路径和运行器诊断 | 卡片 JSON 配置，通过已授权插件 `tool.run` 获取路径、运行器状态（`custom\plugins\whale-ops\plugin.js:98`、`:1384`、`launcher\Views\PluginMarketPage.xaml.cs:313`）。 | 电脑助手 → 插件设置内显示已有权限范围和诊断结果，并链接 Codex 日志。 | 中 |
| 22 ❌ 低电量晚安和桥接内部队列诊断 | 阈值与晚安文本走桥接配置；表情、文件、朋友圈、提醒的 `claim/due`、`permission`、`ack/complete` 由桥接调用（`bridge\runtime_config.py:95`、`bridge\loop_mixin.py:111`、`bridge\file_mixin.py:117`、`bridge\sticker_mixin.py:212`、`bridge\moments.py:73`、`bridge\reminder_watch.py:51`）。 | 微信桥接 → 高级状态显示晚安触发条件、队列摘要和最近失败；桥接仍负责领取和回执。 | 中 |

### 界面已有但后端缺失或易坏

| 页面与控件 | 静态核查结论 | 证据 |
| --- | --- | --- |
| 配图与本人 → 出图、加入本人图池 | `POST /api/moments/pics/paint` 未注册，静态推断请求通过安全检查后落到 404。后端有自动配图用的 `paint()`，添加本机图片接口也已存在，但「加入本人图池」需先拿到出图返回的文件。 | `launcher\Views\MomentsPicsPage.xaml:100`、`launcher\Views\MomentsPicsPage.xaml.cs:187`、`:195`、`:209`、`src\http\routes\index.js:28`、`src\http\routes\momentsPics.js:113`、`:125`、`src\http\router.js:75`、`src\services\momentsPaint.js:16` |
| 配图与本人 → 日志刷新 | 加载和按钮都请求未注册的 `GET /api/moments/pics/log`，按钮会显示「读不到日志」。朋友圈程序日志仍有写入。 | `launcher\Views\MomentsPicsPage.xaml:116`、`launcher\Views\MomentsPicsPage.xaml.cs:73`、`:230`、`src\http\routes\index.js:29`、`src\http\routes\momentsPics.js:59`、`src\http\router.js:75`、`src\services\momentsPublisher.js:316`、`:622` |
| 朋友圈 → 发表间隔 | UI 保存并回显 `interval`，后端将其作为兼容字段。下一次抽样按一小时推进，能否发表由生效时间窗、最短间隔、上限、概率和静默日决定。只改「发表间隔」会造成界面与实际节奏不一致。 | `launcher\Views\MomentsPage.cs:291`、`:313`、`src\services\momentsScheduler.js:11`、`:15`、`:27`、`src\services\momentsPublisher.js:180`、`:676` |
| 配图与本人 → 无人物优先、允许重复 | 接口能读写两个值，但发表器 `settings()` 没带这两个字段。Codex 出图分支读取缺失的 `preferNoPerson`，常规重复判断仍用内容哈希等条件，源码未发现 `allowRepeat` 决策消费。 | `launcher\Views\MomentsPicsPage.xaml:142`、`launcher\Views\MomentsPicsPage.xaml.cs:244`、`src\http\routes\momentsPics.js:50`、`:118`、`src\services\momentsPublisher.js:138`、`:399`、`:552` |
| 插件市场 → 记忆管家，运行工具生成草稿 | 宿主把输入交给 `ctx.input`，插件生成分支从 `ctx.tool.args` 取值，因此现有卡片运行走状态返回而无法传到强制生成分支。微信及定时路径有独立调用。 | `launcher\Views\PluginMarketPage.xaml.cs:313`、`:324`、`src\http\routes\plugins.js:19`、`src\services\javascriptPlugins.js:319`、`:324`、`custom\plugins\whale-memo\plugin.js:178`、`:201` |
| 数据面板 → 好感趋势 | 后端和图表都能读历史序列。插件定时写的是 `mood-history.jsonl`，逐人数据只保留当前值，`bond-history.jsonl` 无自产写入，正常安装下关系趋势缺历史点。 | `src\stats\insights.js:265`、`:271`、`:285`、`custom\plugins\yxn-bond\plugin.js:59`、`:193`、`launcher\Views\PanelPage.xaml.cs:228` |
| 备份与迁移 → 选择备份 | 点击确认后可在运行中的内核旁逐文件覆盖。确认框只是建议先退出；此分支未复用「诊断 → 恢复记忆」的停机流程，正在运行的内存状态可能随后写回旧内容。 | `launcher\Views\BackupPage.xaml.cs:147`、`:157`、`:191`、`:198`、`launcher\Views\DiagPage.xaml.cs:1345`、`:1357`、`launcher\RuntimeSupervisor.cs:498` |
| 备份与迁移 → 导出备份 | 界面称 ZIP 不含 API Key，但导出会原样复制 `data\config.json`。如果密钥保存在这份配置里，它会随包导出；这里没有读取或验证本机实值。 | `launcher\Views\BackupPage.xaml:32`、`launcher\Views\BackupPage.xaml.cs:18`、`:74`、`:111`、`:117`、`src\infra\configPath.js:7`、`src\infra\configPatch.js:32` |
| 设置 → 高级 → 媒体缓存保留量 | 表单允许输入 0，后端校验要求保留天数至少 1、容量至少 10 MB。保存到这些范围以下会被后端拒绝。 | `launcher\Views\SettingsPage.xaml.cs:138`、`:139`、`src\infra\configSchema.js:151`、`:152`、`src\http\routes\config.js:34` |
| 调试台 → 链接 → 发送文本 | 显示名称让人容易理解成原生分享卡片，实际提交普通文本。内核 202 只表示进入队列，页面仅显示提交响应，没有像发文件一样轮询后续结果。 | `launcher\Views\DebugPage.xaml:125`、`:133`、`launcher\Views\DebugPage.xaml.cs:231`、`:263`、`src\http\routes\sendText.js:51`、`:59` |

## 结论：最值得补的五件事

1. **朋友圈**用真实调度参数替换旧「发表间隔」，补生效时段、最短间隔、今日暂停及下次检查（`launcher\Views\MomentsPage.cs:313`、`src\services\momentsScheduler.js:11`、`src\services\momentsPublisher.js:180`）。
2. **配图与本人**接通「出图 → 加入本人图池」和专项日志，并让两项配图偏好进入生成逻辑（`launcher\Views\MomentsPicsPage.xaml.cs:187`、`:230`、`src\services\momentsPublisher.js:138`、`:552`）。
3. **主动与提醒**支持选择会话、时间和内容来新建、改期，沿用已实现的规则、取消和投递状态（`src\pipeline\chat.js:275`、`src\http\routes\reminders.js:38`、`:53`）。
4. **微信桥接**加入统一发送测试面板，复用文件状态查询和插件投递能力，明确文本、URL、图片、文件、语音以及各自结果（`src\http\routes\sendText.js:59`、`src\http\routes\sendFile.js:24`、`src\services\pluginHost.js:66`、`:103`）。
5. **数据面板**内置今天/昨天聊天小结，直接复用已有生成与轮询接口（`src\http\routes\digest.js:23`、`:28`、`launcher\PluginHostActions.cs:13`）。
