# fork 跟随上游的合并维护方案

目录：C:\dev\whale-girl  
分析日期：2026-11-19，北京时间  
范围：只读 Git / 源码分析；唯一工作树写入是本报告。以下整合、提交、构建命令都是以后使用的操作清单，本次没有执行。

## 1. 结论

**推荐 B：按上游正式 Release tag 整合，保留 dev 历史，并维护按功能划分的补丁队列；逐步采用 C 的目录隔离方式。** 每周只读检查 main 和待合并 PR，紧急修复单独评估提前接收。不要直接把 fork 覆盖成上游，也不要整文件选择本地版本来解决核心流程冲突。

依据：

1. 固定提交差异：dev 独有 7 个提交，61 个文件、+5539/-72 行；上游独有 32 个提交，114 个文件、+6680/-1395 行。本地大量代码在独立插件与新增文件，适合按功能维护。
2. 实际工作区比提交历史大。开始检查有 23 个已跟踪文件未提交；分析期间其他进程持续写源码，00:08 采样已收集到 30 个已跟踪修改、42 个相关未跟踪文件。采样期间数量也变化，不能把这些数字当作原子快照。正式整合前必须先稳定工作区，保存全部 W/U 功能。
3. 上游 main 与最新正式 tag 本身分叉。GitHub Compare 返回 v4.1.7.1...main 为 diverged：main 独有 39 个提交，tag 独有 4 个提交。**只追 main 会漏正式热修；只按版本数字大小判断也不可靠。**
4. 冲突主要集中在回复判定、发送确认和启动器生命周期。独立页面和选材模块应保留，上游新流程与本地需求需要逐行为整合。

首次完整整理与整合预留 2–3 人日；以后普通正式版本约 4–10 小时。时间均为规划估计，不是实测。

## 2. 本次核对结果

### 2.1 远端与版本

| 项目 | 实际结果 |
| --- | --- |
| origin | https://github.com/supernaiko/whale_girl.git |
| upstream | https://github.com/Banan1cee/whale_girl.git，原已配置，无需新增 |
| 当前分支 | dev |
| dev HEAD | 8cd8524f5dc916ff322d78d9ef154c9c20a9383a |
| upstream/main | 69105136f36928daf06e258352e27506502539f9 |
| 共同祖先 | c3b63a817f19f06002a8f3419e023c4e40dc4b94 |
| 本地 main / origin/main | c3b63a8，与 GitHub fork main 核对一致 |
| 上游 main 提交时间 | 2026-11-18 20:45:55 +08:00 |
| 最新正式 Release | v4.1.7.1，2026-11-18 13:18:45 +08:00 发布 |
| 正式 tag commit | 64b7dff054007697602b37792d46f5f9da3a0d80 |
| package.json | fork dev：4.2.0；upstream/main：4.1.8；均不能据此认定已发布 |
| 待合并 PR | 00:09 初查，00:16:50–51 交付复核，上游与 fork 均为 0 个 open PR |

PATH 中没有 git，实际使用 C:\dev\tools\git\cmd\git.exe。已通过 HTTPS_PROXY=http://127.0.0.1:10808 执行要求的 fetch upstream --depth=50。仓库仍为浅克隆；已找到共同祖先，且两侧独有提交集合均不含 shallow 边界，因此本报告的 7 / 32 比较没有截断在独有提交内。更早历史与 tag 祖先关系仍应按需 deepen；正式 tag 分叉另经 GitHub Compare API 核实。

本次执行的核心命令：

~~~powershell
$Git = 'C:\dev\tools\git\cmd\git.exe'
$Repo = 'C:\dev\whale-girl'
& $Git -C $Repo remote -v
$env:HTTPS_PROXY = 'http://127.0.0.1:10808'
& $Git -C $Repo fetch upstream --depth=50
& $Git -C $Repo log --oneline upstream/main..dev
& $Git -C $Repo log --oneline dev..upstream/main
& $Git -C $Repo diff --stat upstream/main...dev
& $Git -C $Repo status --short --untracked-files=all
& $Git -C $Repo diff HEAD --stat
~~~

三点 diff 只表示共同祖先到 dev 的已提交差异，不包含 W/U 文件。附录分别列出历史日志、61 文件统计与动态工作区清单。

### 2.2 分析边界

没有 commit、push、源码修改、分支切换或实际 merge；没有启动内核、微信、桥接、插件、模型或备份恢复。没有读取运行中的聊天数据、配置密钥或真实消息日志，没有运行测试或发布 EXE，因此不宣称回归已通过或 EXE 已更新。

分析期间观察到 bridge/file_mixin.py、sender_mixin.py、sticker_mixin.py、window_activation.py、momentsPublisher.js、配置模块等变化，以及 targeting.py、momentsScheduler.js 新增。这些来自其他写入进程。下面按采样内容分析，正式整合时必须重新盘点，不能直接恢复成本报告中的旧内容。

## 3. 必须保留的功能与文件归类

状态：**C**＝dev 独有提交包含；**W**＝已跟踪但未提交修改；**U**＝未跟踪。一个功能可能跨三种状态。完整逐文件归属见附录。

| 必保功能 | 文件与状态 | 维护落点 / 验收重点 |
| --- | --- | --- |
| 朋友圈实拍图、微博配图与文案改写 | C：src/services/momentsPhotos.js、weiboPosts.js、photo_clean.py、momentsPublisher.js；后者还有 W；U：momentsScheduler.js | 保留取图、清理、微博正文配合人设改写、失败回退。策略适合独立模块，发表授权和状态仍走宿主队列。新调度的冷却、静默日与额度一起迁移。 |
| 朋友圈窗口兼容 | W：bridge/moments_publish.py、moments_worker.py；U：moments_window.py；相关测试 | 上游已修实际前台和选图控件重建。采用上游新流程，再保留剩余本地行为，避免叠加两套激活逻辑。 |
| 文件发送 | C：src/http/routes/sendFile.js、src/services/fileSendQueue.js、bridge/file_mixin.py、file_transport.py；file_mixin.py 又有 W；共享 sticker_transport.py | 保留文件身份/目录约束、队列、账号目标核验、附件提交与确认。分析期间新增 U：bridge/targeting.py，要与调用方一起保存。 |
| 内置表情和表情包 | C：bridge/emoticon.py、emoticon_http.py、src/services/wechatEmoticon.js、bridge/app.py、sender_mixin.py、sticker_mixin.py、sticker_transport.py；部分还有 W | 保留独立内置表情通道及原表情包路径，接入上游新的尝试、取消和回执机制。 |
| 电脑助手 / 记忆管家 | C：custom/plugins/whale-ops/**、whale-memo/** | 保留 Codex 默认执行、明确点名才使用 DSH、记忆更新等业务。源码、测试与包版本独立维护；本轮未执行插件。 |
| Codex 步骤日志 | C：launcher/Views/CodexLogPage.xaml、.xaml.cs；MainWindow.xaml.cs 导航 | 保留 EXE 日志阅读页，与调试台分开验收。 |
| 调试台 / 微博调试 / 子进程取消 | U：launcher/Views/DebugPage.xaml、DebugPage.xaml.cs、DebugPage.Weibo.cs、launcher/DebugProcess.cs；W：Api.cs、MainWindow.xaml.cs | 页面内容独立，仅保留少量导航、认证请求和关闭取消接线。调试页能发消息和执行 CLI，本轮仅阅读。 |
| 花销页 | U：launcher/Views/CostPage.xaml、.xaml.cs、src/http/routes/cost.js、tests/cost-usage.test.js；W：src/llm/client.js | 当前增量主要为 DeepSeek usage 持久化、轮转、价格与缓存 token 统计。核对请求对应的 provider/model，不把此差异误认成 Codex provider。 |
| 心情 / 好感页 | U：launcher/Views/MoodPage.xaml、.xaml.cs、custom/plugins/yxn-bond/**、src/http/routes/yxn.js | 保留页面与 yxn-bond.data/bond.json 的数据契约、衰减和提示词注入。 |
| 说话方式页 | U：launcher/Views/VoicePage.xaml、.xaml.cs、custom/plugins/yxn-voice/**、src/http/routes/yxn.js | 实际插件采样自己的回复、注入风格提示，区别于语音合成。按实际实现维护。 |
| 备份与迁移页 | U：launcher/Views/BackupPage.xaml、.xaml.cs；W：MainWindow.xaml.cs | 保留导出范围和恢复前安全副本；后续回归用临时数据，不能直接操作真实 data。 |
| gate / bond / voice 插件 | U：custom/plugins/yxn-gate/**、yxn-bond/**、yxn-voice/** | 已是独立 Api 4 逻辑。gate 当前返回 wake/pass；保留宿主明确被叫到时的回复规则。插件包与运行状态分开。 |
| yxn / 花销 / 即时文本 API | U：src/http/routes/yxn.js、cost.js、sendText.js；W：routes/index.js、launcher/Api.cs | 保留 /api/yxn/status、/api/yxn/voice、/api/cost/usage、/api/send-text。文本发送复用即时队列；202/queued 只表示入队，不表示微信已送达。 |
| 非主人私域隔离 | C+W：src/persona/prompt.js；C：tests/privacy-private-section.test.js | 保留非主人不注入私域段的行为，同时接收新版人设、主人身份与链接事实边界修复。 |
| Codex provider；需求必保，源码待确认 | 已发现 whale-ops/plugin.js 的任务执行、CodexLogPage 与 DebugPage CLI；已检查 config.js / client.js 中未发现独立 codex provider 分支 | 作为迁移缺口：补源码位置、provider 注册、取消/超时/usage 契约和模拟测试后再认定保留。不能把 Codex 调试执行当作聊天 provider。 |

另需保存相关接线：src/app.js、routes/bridge.js、routes/plugins.js、src/services/pluginHost.js、javascriptPluginWorker.js、care.js、careChat.js，以及全部对应测试。分析期间 src/infra/config.js、configSchema.js、src/services/configCommands.js 出现 W 变化，应随新调度配置一起复核。

根目录任务草稿、_backup/、_codex_*.out/.err、一次性 patch 脚本属于待审材料，不进入功能队列；本轮没有清理。

### 3.1 已与上游一致的重复移植

采样时下列 5 个 W 文件与 upstream/main 内容相同，可在正式整合、测试确认后消除其“长期本地补丁”身份；本轮没有 restore/checkout：

- bridge/image_ui_fallback.py
- bridge/moments_worker.py
- bridge/receiver_mixin.py
- tests/test_moments_worker.py
- tests/test_received_media.py

### 3.2 插件化边界

Api 3 只有既定消息扩展点；Node.js、网络、定时、模型与完整系统能力使用最低 4.1.2 的 Api 4，声明 system.full 并逐插件确认，更新后重新启用。

gate/bond/voice、选材、助手和记忆业务适合独立插件。现有协议没有承诺第三方插件可以注册 WPF 左侧页面或任意宿主路由，市场规范要求插件操作位于卡片“设置”。所以保留专用 EXE 页面仍需薄宿主补丁，不能承诺全部插件化即可零改上游。

文件、表情、目标定位和确认状态也依赖宿主桥接。没有正式扩展点时保留受测试的适配补丁，不能用运行后字符串替换核心文件代替接口设计，vendor/runtime 继续只读。

docs/yxn-architecture.md 部分状态路径、hook 和“学习主人发言”描述已落后于实现。以当前 plugin.json、plugin.js 和路由实际路径为准；整理契约时不复制真实账号或聊天样本。

## 4. 冲突热点与解决顺序

已提交差异双方共同修改 7 个文件：bridge/sender_mixin.py、sticker_mixin.py、sticker_transport.py、src/pipeline/chat.js、src/persona/prompt.js、docs/CHANGELOG.md、tests/test_sticker_transport.py。这是文件交集，**不是实际文本冲突数**。本轮没有执行 merge，以下为静态语义风险评估。

| 优先级 / 文件 | 风险证据与解决方式 | 首次预计耗时 |
| --- | --- | --- |
| P0：src/pipeline/chat.js | 本地提交 +23/-4，上游 +198/-165，拆出 replyDecision / replyQuota / replyMarks。W 又改标记和魔咒校验。以新版流程为落点移植插件重试等行为；核对配额释放、取消、before_send、dispatched 顺序，不整段保留旧 finalize。 | 3–6 小时 |
| P0：bridge/sender_mixin.py、bg_sender.py、send_attempt.py、send_state.py、reminder_watch.py | 本地 sender 增表情通道；上游 sender +296/-105，并改发送尝试和成对回执。将表情/文件接入新生命周期，保留未确认不重发及账号绑定。 | 3–6 小时 |
| P0：bridge/sticker_mixin.py、sticker_transport.py、file_mixin.py、file_transport.py、window_activation.py、targeting.py | 本地文件复用表情传输，改变别名、文件指纹、剪贴板与确认。上游改前台核验。统一定位入口，同时保留文件/表情的不同确认语义。 | 2–4 小时 |
| P1：src/services/momentsPublisher.js、momentsPhotos.js、weiboPosts.js、photo_clean.py、momentsScheduler.js | 上游暂未改这些新增选材模块，文字冲突较低；W 调度、人设/心情输入耦合高。独立策略、保留宿主授权队列，联合测冷却/静默/额度。 | 2–4 小时 |
| P1：bridge/moments_publish.py、moments_window.py、moments_worker.py | 上游与本地出现同名新增 moments_window.py；调用的激活函数名不同。核对函数签名、调用方与测试，接收上游选图重建修复。 | 1–3 小时 |
| P1：launcher/MainWindow.xaml.cs | C 加 Codex 日志，W 加多个页面与退出取消。当前上游未改同一主窗口文件，但相邻生命周期和联系人服务重构，存在语义冲突。保留独立页、最少注册点。 | 1–2 小时 |
| P1：launcher/RuntimeSupervisor.cs、Api.cs、DebugProcess.cs | 上游加配置服务探测、LogSanitizer、进程生命周期修复；本地 W 抽 ReadPort 和调试请求。以新版为基础移植，避免整文件取本地丢修复。 | 1–2 小时 |
| P1：src/persona/prompt.js 与 persona/profile.js、conflict.js、store.js | 上游新模式、主人及链接边界与本地私域隔离叠加。测试主人/非主人私聊、群聊和链接失败。 | 1–2 小时 |
| P1：src/llm/client.js、infra/config*.js、configCommands.js、routes/cost.js | 用量落盘与配置仍在变化，未来 provider 适配会扩冲突。核对请求级模型信息、流式 usage、取消和计费。 | 1–2 小时 |
| P2：routes/index.js、bridge.js、plugins.js、sendFile.js、sendText.js、yxn.js；pluginHost.js、javascriptPluginWorker.js、src/app.js | 小量接线也可能静默漏能力。每个 API / SDK 方法做模拟契约测试，保持全部 /api/* 和认证闸。 | 0.5–1.5 小时 |
| P2：CHANGELOG、package.json、release-manifest.json、WhaleLauncher.exe、scripts / workflows | 开发号与正式号不同；EXE 无法文本合并。人工核对发布状态/更新源，从整合源码重发 EXE。 | 0.5–1 小时，另加构建 |
| P2：tests/** | 同名 U 测试可能阻止检出；移植上游测试与本地功能测试都要保留，不能选择较少的一边求绿。 | 1–2 小时 |

时间有重叠，不机械相加；首次整体含整理和回归约 2–3 人日。若 Codex provider 需要重新实现，另计。

## 5. 三种策略比较

估算面向熟悉 Node / Python / WPF 的维护者，1 人日＝8 小时，不含缺失功能重写或环境下载等待。

| 维度 | A：定期 merge upstream/main | B：正式 tag + 功能补丁队列 | C：独立插件 / 补丁目录 |
| --- | --- | --- | --- |
| 首次工作量 | 约 1–2 人日，立即处理 main 重构 | 约 1.5–2.5 人日整理；首次大整合约 2–3 人日 | 约 3–6 人日拆逻辑与接口，仍有宿主残余补丁 |
| 每次跟进 | 每周 2–6 小时，大重构可超 1 日 | 普通正式版本 4–10 小时，大重构 1–3 日 | 接口稳定后 2–6 小时，接口破坏时另计 |
| 风险 | 开发分支行为变化快，频繁冲突 | 发布基线可核验、可回退；修复可能延迟，需处理独立热修分支 | 一次拆分风险高，缺扩展点时无法做到零改宿主 |
| 维护成本 | 反复解 chat / bridge 冲突，容易遗漏 | 每版有明确功能、队列和验收证据，需维护队列 | 长期较低，但仍要跟踪宿主契约，补丁目录本身不会消灭冲突 |
| 适配结论 | 适合持续跟进开发版的维护者 | **当前推荐** | 作为 B 的渐进演进方向 |

B 的执行约束：

- 正常同步：dev 派生候选分支，merge 已核验 tag，保留历史，不 rebase 共享 dev。
- 补丁队列：用于审计、迁移和恢复；已随 dev/merge 带入的补丁不再 git am。
- 从新 tag 重建干净候选时才重放队列，与上述 merge 路线二选一，避免重复应用。
- c944a9c、e15442e 混合多个功能。原始 format-patch 是历史材料，不是已经拆好的功能队列；新工作按功能分提交，不重写共享历史。

建议逻辑队列：01-朋友圈素材、02-文件发送、03-内置表情、04-插件业务、05-私域隔离、06-WPF 页面、07-费用统计、08-yxn/文本路由、09-定位与调度；Codex provider 单列待确认。未来可放 custom/patches/，逐项记录基线 SHA、来源、依赖、测试、上游化状态。本轮没有创建补丁或目录。

## 6. 下次上游正式发版的操作清单

**以下供后续实施任务执行，本次仅写入报告。先让当前写入工作区的其他任务结束。**

### 步骤 0：保全并稳定本地功能（30–90 分钟）

重复 status，按功能保存 W/U，尤其是页面、插件、路由、定位与调度。后续提交源码时按具体文件明确暂存；不要 git add -A，把日志、备份、真实账号/密钥/数据带入。相关源码形成可恢复提交基线后才整合；运行数据由操作者按既有流程另存仓库外，本轮不操作。

~~~powershell
$Git = 'C:\dev\tools\git\cmd\git.exe'
$Repo = 'C:\dev\whale-girl'
$env:HTTPS_PROXY = 'http://127.0.0.1:10808'
& $Git -C $Repo status --short --untracked-files=all
& $Git -C $Repo diff HEAD --stat
& $Git -C $Repo ls-files --others --exclude-standard
~~~

### 步骤 1：确认 Release、tag SHA、main 与 PR（10–20 分钟）

选择非 draft / prerelease 的正式 Release，记录发布说明、是否独立热修，以及目标 commit。重新查 open PR。本次 v4.1.7.1 与 main 分叉，因此每次都要比较两边，不能假设 main 含全部正式版修复。

~~~powershell
& $Git -C $Repo fetch upstream --depth=50
& $Git -C $Repo ls-remote --tags upstream
$Tag = 'vX.Y.Z' # 替换为本次实际核验的正式 tag
$Refspec = 'refs/tags/' + $Tag + ':refs/upstream-releases/' + $Tag
& $Git -C $Repo fetch upstream $Refspec
if ($LASTEXITCODE -ne 0) { throw '获取正式 tag 失败' }
$Target = 'refs/upstream-releases/' + $Tag
$CommitRef = $Target + '^{commit}'
$TargetSha = (& $Git -C $Repo rev-parse $CommitRef).Trim()
if ($LASTEXITCODE -ne 0) { throw 'tag 无法解析为 commit' }
& $Git -C $Repo show --no-patch --format=fuller $TargetSha
& $Git -C $Repo merge-base dev $TargetSha
# 浅历史不足时按需执行，再重新核对：
# & $Git -C $Repo fetch upstream --deepen=100
~~~

独立 ref 命名避免覆盖同名 fork tag。第一次优先选择包含当前 main 必需修复的后续正式 tag；如缺少必须修复，明确评估单独提前接收，不悄悄把 main 当正式版合入。不要把 fork 4.2.0 降回上游号。

### 步骤 2：更新差异、功能队列与风险（20–45 分钟）

~~~powershell
& $Git -C $Repo log --oneline "dev..$TargetSha"
& $Git -C $Repo log --oneline "$TargetSha..dev"
& $Git -C $Repo diff --stat "$TargetSha...dev"
& $Git -C $Repo diff --name-status "dev...$TargetSha"
& $Git -C $Repo log --oneline "$TargetSha..upstream/main"
& $Git -C $Repo log --oneline "upstream/main..$TargetSha"
~~~

每个功能标为“保留 / 上游已实现 / 需适配 / 缺源码”。确认全部未跟踪代码已进入基线，移除队列中上游已完整实现且测试覆盖的补丁身份，保留历史记录。

### 步骤 3：恢复点与隔离候选（15–30 分钟）

仅在步骤 0 完成后执行。新 worktree 不连接运行中的 data；原始补丁不包含未提交文件。

~~~powershell
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Safety = "backup/dev-before-upstream-$Stamp"
$Branch = "sync/upstream-$Tag-$Stamp"
$Work = "C:\dev\whale-girl-sync-$Stamp"
& $Git -C $Repo branch $Safety dev
if ($LASTEXITCODE -ne 0) { throw '建立恢复分支失败' }
& $Git -C $Repo worktree add -b $Branch $Work dev
if ($LASTEXITCODE -ne 0) { throw '建立候选目录失败' }

# 可选：导出历史材料到仓库外；不直接等同于已整理功能队列。
$Artifact = "C:\dev\whale-integration-artifacts\$Stamp"
New-Item -ItemType Directory -Path $Artifact -Force | Out-Null
$Base = (& $Git -C $Repo merge-base dev upstream/main).Trim()
& $Git -C $Repo format-patch --binary --full-index --no-signature --output-directory $Artifact "$Base..dev"
~~~

原始 7 提交可导出保存，但混合功能仍需整理。后续有 merge 时，还应核对补丁材料是否涵盖手工冲突解决内容；恢复点分支保留完整已提交历史。

### 步骤 4：合入 tag，逐行为解冲突（普通版本 2–6 小时；首次 1–2 人日）

~~~powershell
& $Git -C $Work merge --no-commit --no-ff $TargetSha
& $Git -C $Work diff --name-only --diff-filter=U
& $Git -C $Work diff --check
# 若放弃，仅在这个原先干净的候选中执行：
# & $Git -C $Work merge --abort
~~~

按第 4 节 P0→P1→P2 顺序处理。chat 接新版判定/配额；桥接接新版发送生命周期；朋友圈保留独立选材；EXE 保留页面和最少接线。遇到同名未跟踪新增，先与上游版本比较，不能删除本地文件绕过。不要运行插件 install/patch 脚本作为验证。

### 步骤 5：隔离模拟回归（1–3 小时）

先审阅测试入口，确认使用临时目录、mock 网关/模型/桌面，不能连接当前真实微信/内核。逐文件运行，Python 用 -B 避免 __pycache__。文件被上游移动时先调整路径。

~~~powershell
Push-Location $Work
try {
  node tests/bot.test.js
  node tests/sticker-marker.test.js
  node tests/privacy-private-section.test.js
  node tests/send-file.test.js
  node tests/send-text.test.js
  node tests/wechat-emoticon.test.js
  node tests/moments.test.js
  node tests/cost-usage.test.js
  node tests/providers.test.js
  node custom/plugins/whale-memo/tests/run-tests.js
  node custom/plugins/whale-ops/tests/run-tests.js
  node custom/plugins/yxn-gate/tests/gate.test.js
  node custom/plugins/yxn-bond/tests/bond.test.js
  node custom/plugins/yxn-voice/tests/voice.test.js
  python -B tests/test_file_send.py
  python -B tests/test_file_clipboard.py
  python -B tests/test_emoticon.py
  python -B tests/test_sticker_transport.py
  python -B tests/test_moments_publish.py
  python -B tests/test_moments_window.py
  python -B tests/test_moments_worker.py
  python -B tests/test_image_ui_fallback.py
  node scripts/check-layers.js
  node scripts/release-check.js
  node scripts/privacy-scan.js .
  dotnet build launcher/WhaleLauncher.csproj -c Release
} finally {
  Pop-Location
}
~~~

执行者须检查每条原生命令的 $LASTEXITCODE；PowerShell 默认不会因非 0 自动停止。任何失败都阻止进入发布。这是最低受影响集合，不替代目标 tag 新增测试。

目标版本的回复判定/配额、取消、发送尝试与成对回执、服务生命周期、发布资源约束测试也必须接收并逐文件跑。当前 main 新增 refactor-t01、t09、t14、t18、t22 等测试，本地 dev 尚未全部包含。

需补充/确认覆盖：yxn 路由状态契约、调试进程取消、备份临时目录导出恢复、targeting 账号/同名会话/窗口变化、调度静默与额度，以及确有源码的 Codex provider 取消/超时/usage。现有测试不能自动证明这些功能全覆盖。本轮未运行。

### 步骤 6：版本与 EXE（20–60 分钟，整包构建另计）

package.json 与 CHANGELOG 最新版本一致；新增功能升次版本，修复/改进升补丁。已发布条目冻结，最新开发版不标已发布；更新弹窗摘要是第一节、最多 5 行，每行不超过 15 个汉字。历史 4.1.2 例外不自动适用新发布。

launcher 有变化就重新生成 EXE，不能沿用旧 EXE或直接选择上游候选二进制：

~~~powershell
Push-Location $Work
try {
  dotnet publish launcher/WhaleLauncher.csproj -c Release -o launcher/publish -p:PublishSingleFile=true -p:SelfContained=false
  if ($LASTEXITCODE -ne 0) { throw 'EXE 发布失败' }
  Copy-Item -LiteralPath launcher/publish/WhaleLauncher.exe -Destination .\WhaleLauncher.exe -Force
} finally {
  Pop-Location
}
~~~

没有 SDK 则标明“EXE 待发布”。补丁不做整包构建，但 launcher 修改仍需 EXE 发布；新增功能升次版本时做完整安装包测试。两个必需 CI 检查“测试 / 分层 / 编译”和“构建安装包”均须有结论；不能给 installer PR 加 paths 过滤；补丁按 version-gate 上报 skipped。

检查更新器是否会拉上游正式包覆盖 fork 功能。本轮未改更新源，未来发行须明确 fork 自身包、版本和更新边界，不能只靠 4.2.0 较大阻止未来覆盖，也不能删除安全闸。

### 步骤 7：交付前复核与回退（20–40 分钟，CI 等待另计）

重新查 main、tag 与 open PR，审阅全部冲突解决，按第 3 节逐项验收：

~~~powershell
& $Git -C $Repo ls-remote upstream refs/heads/main
& $Git -C $Work diff --check
& $Git -C $Work status --short
& $Git -C $Work diff --stat $Safety
~~~

后续实施任务经授权后才提交/推送 fork 整合分支并走 PR / CI，不直接 push main。日常开发以 dev 为基线时先审入 dev，再按 fork 的发布分支流程交付；更新补丁队列的目标 SHA、测试证据、EXE 和已上游化状态。

回退优先中止候选 merge 或丢弃未接受的隔离候选，原运行目录与 dev 不受整合影响；不要对运行目录 reset --hard / clean。已共享结果用后续 revert / 修复 PR，不重写共享历史。

## 7. 长期减负计划

| 阶段 | 行动 | 预计耗时 | 完成标准 |
| --- | --- | --- | --- |
| 保全基线 | 稳定 W/U、确认 provider 缺口、列模拟验收矩阵 | 0.5–1 人日 | 新 worktree 可获得全部必保功能源码，不依赖未跟踪文件 |
| 整理现有插件 | gate/bond/voice、memo/ops 保持独立源码、包和测试 | 0.5–1 人日 | 停用可回退宿主默认行为，更新保留配置并重新授权 |
| 收敛核心接线 | 独立选材/计量适配，页面内容独立、少量注册 | 1–2 人日 | chat / MainWindow 差异是可逐条解释的接线 |
| 固定残余补丁 | 发送/定位/路由/页面注册按宿主版本测试 | 1–2 人日，可跨版做 | 每个补丁有依赖和测试，上游具备能力后可明确退役 |
| 持续跟进 | 每周只读检查，正式版本跑本清单 | 每周 15–30 分钟；每版 4–10 小时起 | 接收 SHA、功能、测试与 EXE 有记录，冲突量逐版下降 |

阶段可以重叠，不一次全部重构。缺宿主接口时先记录缺口、保留薄补丁；向上游贡献接口或公开投稿属于另行授权任务。公开插件投稿只去 Banan1cee/whale-girl-plugins:main，本轮无任何外部写操作。

## 8. 在线核对来源

- [上游 main 固定提交](https://github.com/Banan1cee/whale_girl/commit/69105136f36928daf06e258352e27506502539f9)
- [上游 Releases](https://github.com/Banan1cee/whale_girl/releases)、[v4.1.7.1 正式版](https://github.com/Banan1cee/whale_girl/releases/tag/v4.1.7.1)
- [正式 tag 与 main 比较](https://github.com/Banan1cee/whale_girl/compare/v4.1.7.1...main)：GitHub API 核对 diverged、ahead_by=39、behind_by=4，共同祖先 d7496271d8453c6aae8901bb0a88a6bfc0b6c3dd
- [上游待合并 PR](https://github.com/Banan1cee/whale_girl/pulls)、[fork 待合并 PR](https://github.com/supernaiko/whale_girl/pulls)：00:09 核对均为空

以上为查询时点结果；下次实施必须重新获取。

## 附录 A：本地独有提交

~~~text
8cd8524 feat(whale-ops): 任务默认交给 Codex，dsh 仅在明确点名时使用（v1.4.6）
07383bc fix(bridge): 前台激活重试与会话别名兜底，修发文件 target_unavailable；插件失败自动重提
382fe46 隐私：非主人剔除「我们之间」私域段，并加私聊红线
e686b49 Codex 日志页改为步骤视图；版本号跟随
e15442e whale-ops: 主人免确认直接执行；新增发文件与内置表情桥接
4f0d951 启动器加 Codex 日志页：读 whale-ops 落盘的 run-*.log，左侧选运行右侧看内容
c944a9c 自维护起点：朋友圈实拍图/去水印 + 微博取图改写 + 记忆管家与电脑助手插件源码
~~~

## 附录 B：上游新增提交

~~~text
6910513 Merge pull request #181 from Banan1cee/test/whale-refactor-20261114-t18-phase1
5904c49 Update launcher candidate to the verified T22 main baseline
1a15663 Merge pull request #182 from Banan1cee/test/whale-refactor-20261114-t22-resource-containment
b307902 Write the full release archive with the existing ZIP library
5cffd00 Limit the launcher change to service lifecycle and logging
56fdfca Resolve Windows release resource paths before containment checks
b3cef13 Use canonical contact identity after launcher account switches
1c0dfec Preserve launcher lifecycle, local configuration and contact scoping
87f0a88 Merge pull request #180 from Banan1cee/test/whale-refactor-20261114-core-4b4035a
46e4bd7 更新表情标记和发布版本的回归测试
4b4035a 保留异常表情标记后的回复正文
4479b81 Prepare T01 reply decision and accounting
0b38301 Prepare paired bridge and reminder acknowledgements
daf6b67 Prepare T22 release policy and resource checks
2d31b4d Merge pull request #175 from Banan1cee/fix/image-preview-fallback-20261118
82207c6 bridge: 限时读取已核对的微信图片预览
2ce6b28 Merge pull request #173 from Banan1cee/fix/prompt-boundaries-persona-conflict-20261117
fcb89af launcher: 增加更新源测速并修正非主人魔咒与链接提示
fe0f43c Merge pull request #176 from Banan1cee/ui/plugin-market-layout-20261118
725ac33 Merge branch 'main' into ui/plugin-market-layout-20261118
a5f7539 Merge pull request #179 from Banan1cee/release/publish-4171-manifest-20261118
42ea05e release: 同步 4.1.7.1 正式更新清单
c6cda9e Merge pull request #178 from Banan1cee/fix/sticker-foreground-confirmation-20261118
2c3d02d fix(stickers): 等待已绑定的微信窗口进入前台
4c3a725 Merge branch 'main' into ui/plugin-market-layout-20261118
4592736 Merge pull request #177 from Banan1cee/fix/persona-conflict-warning-173
03829b5 fix: 新版保留主人称呼和诊断身份
1364c5e fix: 切换人设模式时按新模式校验长度
47f0bfb persona: 加入可切换的新版人设行为
580ffd8 launcher: 优化插件市场三列布局与文档入口
dab6855 Merge pull request #174 from Banan1cee/fix/moments-foreground-camera-20261117
34de5dd bridge: 修复朋友圈前台误判与选图窗口间歇退出
~~~

## 附录 C：三点 diff 改动面

命令：git diff --stat upstream/main...dev

~~~text
.gitignore                                         |    4 +
 bridge/app.py                                      |   12 +-
 bridge/emoticon.py                                 |  185 +++
 bridge/emoticon_http.py                            |   84 ++
 bridge/file_mixin.py                               |  215 +++
 bridge/file_transport.py                           |   62 +
 bridge/sender_mixin.py                             |   55 +
 bridge/sticker_mixin.py                            |   32 +-
 bridge/sticker_transport.py                        |  173 ++-
 bridge/window_activation.py                        |   16 +-
 custom/plugins/whale-memo/README.md                |   46 +
 custom/plugins/whale-memo/plugin.js                |  208 +++
 custom/plugins/whale-memo/plugin.json              |   19 +
 custom/plugins/whale-memo/scripts/build.py         |   30 +
 custom/plugins/whale-memo/scripts/install.py       |   79 ++
 custom/plugins/whale-memo/scripts/patch-install.py |    9 +
 custom/plugins/whale-memo/scripts/patch-marker.py  |    9 +
 custom/plugins/whale-memo/scripts/set-settings.py  |   12 +
 .../plugins/whale-memo/scripts/verify-install.js   |   16 +
 custom/plugins/whale-memo/tests/run-tests.js       |  154 +++
 custom/plugins/whale-ops/README.md                 |  107 ++
 custom/plugins/whale-ops/plugin.js                 | 1403 ++++++++++++++++++++
 custom/plugins/whale-ops/plugin.json               |   32 +
 custom/plugins/whale-ops/scripts/build.py          |   30 +
 custom/plugins/whale-ops/scripts/install.py        |   76 ++
 custom/plugins/whale-ops/scripts/patch_tests.py    |   10 +
 custom/plugins/whale-ops/tests/fake-dsh.js         |    9 +
 custom/plugins/whale-ops/tests/run-tests.js        |  390 ++++++
 custom/plugins/whale-ops/tests/test-dsh.js         |   56 +
 custom/plugins/whale-ops/tests/test-emoticon.js    |   54 +
 docs/CHANGELOG.md                                  |   17 +
 docs/插件JavaScriptApi4.md                         |    6 +
 launcher/MainWindow.xaml.cs                        |    2 +
 launcher/Views/CodexLogPage.xaml                   |  101 ++
 launcher/Views/CodexLogPage.xaml.cs                |  438 ++++++
 package.json                                       |    2 +-
 src/app.js                                         |    2 +
 src/http/routes/bridge.js                          |   20 +
 src/http/routes/index.js                           |    1 +
 src/http/routes/plugins.js                         |    2 +-
 src/http/routes/sendFile.js                        |   47 +
 src/persona/prompt.js                              |   10 +-
 src/pipeline/chat.js                               |   27 +-
 src/services/care.js                               |   11 +-
 src/services/careChat.js                           |    7 +
 src/services/fileSendQueue.js                      |  136 ++
 src/services/javascriptPluginWorker.js             |    1 +
 src/services/momentsPhotos.js                      |  292 ++++
 src/services/momentsPublisher.js                   |  192 ++-
 src/services/photo_clean.py                        |   98 ++
 src/services/pluginHost.js                         |    4 +-
 src/services/wechatEmoticon.js                     |   61 +
 src/services/weiboPosts.js                         |  138 ++
 start-dev.cmd                                      |   11 +
 tests/privacy-private-section.test.js              |   36 +
 tests/send-file.test.js                            |   82 ++
 tests/test_emoticon.py                             |   36 +
 tests/test_file_clipboard.py                       |   54 +
 tests/test_file_send.py                            |  171 +++
 tests/test_sticker_transport.py                    |    2 +-
 tests/wechat-emoticon.test.js                      |   17 +
 61 files changed, 5539 insertions(+), 72 deletions(-)
~~~

## 附录 D：完整本地改动归属

采样时间：2026-11-19T00:08:00+08:00。C 是固定提交集合，W/U 是动态工作区已观察集合，后者不保证采样后完整。只列相关源码、文档、测试与工具；根目录日志/备份/任务草稿未列入。表中的“同改”指共同祖先到上游 main 的文件交集，不是已验证的文本冲突。

| 文件 | 状态 | 归属 | 上游 |
| --- | --- | --- | --- |
| `.gitignore` | C | 配置 / 发布 / 开发入口 | — |
| `bridge/app.py` | C | 文件 / 表情 / 会话定位桥接 | — |
| `bridge/emoticon.py` | C | 文件 / 表情 / 会话定位桥接 | — |
| `bridge/emoticon_http.py` | C | 文件 / 表情 / 会话定位桥接 | — |
| `bridge/file_mixin.py` | C+W | 文件 / 表情 / 会话定位桥接 | — |
| `bridge/file_transport.py` | C | 文件 / 表情 / 会话定位桥接 | — |
| `bridge/image_ui_fallback.py` | W | 图片接收兜底 | 同改 |
| `bridge/moments_publish.py` | W | 朋友圈桥接 | 同改 |
| `bridge/moments_window.py` | U | 朋友圈桥接 | 同改 |
| `bridge/moments_worker.py` | W | 朋友圈桥接 | 同改 |
| `bridge/receiver_mixin.py` | W | 图片接收兜底 | 同改 |
| `bridge/sender_mixin.py` | C+W | 文件 / 表情 / 会话定位桥接 | 同改 |
| `bridge/sticker_mixin.py` | C+W | 文件 / 表情 / 会话定位桥接 | 同改 |
| `bridge/sticker_transport.py` | C | 文件 / 表情 / 会话定位桥接 | 同改 |
| `bridge/targeting.py` | U | 文件 / 表情 / 会话定位桥接 | — |
| `bridge/window_activation.py` | C+W | 文件 / 表情 / 会话定位桥接 | — |
| `custom/plugins/whale-memo/README.md` | C | 独立插件：whale-memo | — |
| `custom/plugins/whale-memo/plugin.js` | C | 独立插件：whale-memo | — |
| `custom/plugins/whale-memo/plugin.json` | C | 独立插件：whale-memo | — |
| `custom/plugins/whale-memo/scripts/build.py` | C | 独立插件：whale-memo | — |
| `custom/plugins/whale-memo/scripts/install.py` | C | 独立插件：whale-memo | — |
| `custom/plugins/whale-memo/scripts/patch-install.py` | C | 独立插件：whale-memo | — |
| `custom/plugins/whale-memo/scripts/patch-marker.py` | C | 独立插件：whale-memo | — |
| `custom/plugins/whale-memo/scripts/set-settings.py` | C | 独立插件：whale-memo | — |
| `custom/plugins/whale-memo/scripts/verify-install.js` | C | 独立插件：whale-memo | — |
| `custom/plugins/whale-memo/tests/run-tests.js` | C | 独立插件：whale-memo | — |
| `custom/plugins/whale-ops/README.md` | C | 独立插件：whale-ops | — |
| `custom/plugins/whale-ops/plugin.js` | C | 独立插件：whale-ops | — |
| `custom/plugins/whale-ops/plugin.json` | C | 独立插件：whale-ops | — |
| `custom/plugins/whale-ops/scripts/build.py` | C | 独立插件：whale-ops | — |
| `custom/plugins/whale-ops/scripts/install.py` | C | 独立插件：whale-ops | — |
| `custom/plugins/whale-ops/scripts/patch_tests.py` | C | 独立插件：whale-ops | — |
| `custom/plugins/whale-ops/tests/fake-dsh.js` | C | 独立插件：whale-ops | — |
| `custom/plugins/whale-ops/tests/run-tests.js` | C | 独立插件：whale-ops | — |
| `custom/plugins/whale-ops/tests/test-dsh.js` | C | 独立插件：whale-ops | — |
| `custom/plugins/whale-ops/tests/test-emoticon.js` | C | 独立插件：whale-ops | — |
| `custom/plugins/yxn-bond/.build-stamp` | U | 独立插件：yxn-bond | — |
| `custom/plugins/yxn-bond/build.js` | U | 独立插件：yxn-bond | — |
| `custom/plugins/yxn-bond/plugin.js` | U | 独立插件：yxn-bond | — |
| `custom/plugins/yxn-bond/plugin.json` | U | 独立插件：yxn-bond | — |
| `custom/plugins/yxn-bond/tests/bond.test.js` | U | 独立插件：yxn-bond | — |
| `custom/plugins/yxn-gate/README.md` | U | 独立插件：yxn-gate | — |
| `custom/plugins/yxn-gate/build.js` | U | 独立插件：yxn-gate | — |
| `custom/plugins/yxn-gate/install.js` | U | 独立插件：yxn-gate | — |
| `custom/plugins/yxn-gate/package.json` | U | 独立插件：yxn-gate | — |
| `custom/plugins/yxn-gate/plugin.js` | U | 独立插件：yxn-gate | — |
| `custom/plugins/yxn-gate/plugin.json` | U | 独立插件：yxn-gate | — |
| `custom/plugins/yxn-gate/tests/gate.test.js` | U | 独立插件：yxn-gate | — |
| `custom/plugins/yxn-gate/tests/run-tests.js` | U | 独立插件：yxn-gate | — |
| `custom/plugins/yxn-voice/build.js` | U | 独立插件：yxn-voice | — |
| `custom/plugins/yxn-voice/plugin.js` | U | 独立插件：yxn-voice | — |
| `custom/plugins/yxn-voice/plugin.json` | U | 独立插件：yxn-voice | — |
| `custom/plugins/yxn-voice/tests/voice.test.js` | U | 独立插件：yxn-voice | — |
| `docs/CHANGELOG.md` | C+W | 协议 / 设计 / 更新记录 | 同改 |
| `docs/yxn-architecture.md` | U | 协议 / 设计 / 更新记录 | — |
| `docs/插件JavaScriptApi4.md` | C | 协议 / 设计 / 更新记录 | — |
| `launcher/Api.cs` | W | EXE 页面 / 宿主接线 | — |
| `launcher/DebugProcess.cs` | U | EXE 页面 / 宿主接线 | — |
| `launcher/MainWindow.xaml.cs` | C+W | EXE 页面 / 宿主接线 | — |
| `launcher/RuntimeSupervisor.cs` | W | EXE 页面 / 宿主接线 | 同改 |
| `launcher/Views/BackupPage.xaml` | U | EXE 页面 / 宿主接线 | — |
| `launcher/Views/BackupPage.xaml.cs` | U | EXE 页面 / 宿主接线 | — |
| `launcher/Views/CodexLogPage.xaml` | C | Codex 日志 EXE | — |
| `launcher/Views/CodexLogPage.xaml.cs` | C | Codex 日志 EXE | — |
| `launcher/Views/CostPage.xaml` | U | EXE 页面 / 宿主接线 | — |
| `launcher/Views/CostPage.xaml.cs` | U | EXE 页面 / 宿主接线 | — |
| `launcher/Views/DebugPage.Weibo.cs` | U | EXE 页面 / 宿主接线 | — |
| `launcher/Views/DebugPage.xaml` | U | EXE 页面 / 宿主接线 | — |
| `launcher/Views/DebugPage.xaml.cs` | U | EXE 页面 / 宿主接线 | — |
| `launcher/Views/MoodPage.xaml` | U | EXE 页面 / 宿主接线 | — |
| `launcher/Views/MoodPage.xaml.cs` | U | EXE 页面 / 宿主接线 | — |
| `launcher/Views/VoicePage.xaml` | U | EXE 页面 / 宿主接线 | — |
| `launcher/Views/VoicePage.xaml.cs` | U | EXE 页面 / 宿主接线 | — |
| `package.json` | C | 配置 / 发布 / 开发入口 | — |
| `src/app.js` | C | 路由 / 插件 SDK / 服务接线 | — |
| `src/http/routes/bridge.js` | C | 路由 / 插件 SDK / 服务接线 | — |
| `src/http/routes/cost.js` | U | 费用计量 / 模型客户端 | — |
| `src/http/routes/index.js` | C+W | 路由 / 插件 SDK / 服务接线 | — |
| `src/http/routes/plugins.js` | C | 路由 / 插件 SDK / 服务接线 | — |
| `src/http/routes/sendFile.js` | C | 文件发送 | — |
| `src/http/routes/sendText.js` | U | 路由 / 插件 SDK / 服务接线 | — |
| `src/http/routes/yxn.js` | U | 路由 / 插件 SDK / 服务接线 | — |
| `src/infra/config.js` | W | 配置 / 发布 / 开发入口 | 同改 |
| `src/infra/configSchema.js` | W | 配置 / 发布 / 开发入口 | — |
| `src/llm/client.js` | W | 费用计量 / 模型客户端 | — |
| `src/persona/prompt.js` | C+W | 私域隔离 / 人设与链接边界 | 同改 |
| `src/pipeline/chat.js` | C+W | 消息流程 / 重试 | 同改 |
| `src/services/care.js` | C | 消息流程 / 重试 | — |
| `src/services/careChat.js` | C | 消息流程 / 重试 | — |
| `src/services/configCommands.js` | W | 配置 / 发布 / 开发入口 | — |
| `src/services/fileSendQueue.js` | C | 文件发送 | — |
| `src/services/javascriptPluginWorker.js` | C | 路由 / 插件 SDK / 服务接线 | — |
| `src/services/momentsPhotos.js` | C | 朋友圈选材 / 调度 / 发布 | — |
| `src/services/momentsPublisher.js` | C+W | 朋友圈选材 / 调度 / 发布 | — |
| `src/services/momentsScheduler.js` | U | 朋友圈选材 / 调度 / 发布 | — |
| `src/services/photo_clean.py` | C | 朋友圈选材 / 调度 / 发布 | — |
| `src/services/pluginHost.js` | C | 路由 / 插件 SDK / 服务接线 | — |
| `src/services/wechatEmoticon.js` | C | 内置表情 | — |
| `src/services/weiboPosts.js` | C | 朋友圈选材 / 调度 / 发布 | — |
| `start-dev.cmd` | C | 配置 / 发布 / 开发入口 | — |
| `tests/bot.test.js` | W | 配置 / 发布 / 开发入口 | 同改 |
| `tests/bridge-recovery.test.js` | W | 配置 / 发布 / 开发入口 | 同改 |
| `tests/cost-usage.test.js` | U | 费用计量 / 模型客户端 | — |
| `tests/moments.test.js` | W | 朋友圈选材 / 调度 / 发布 | — |
| `tests/privacy-private-section.test.js` | C | 配置 / 发布 / 开发入口 | — |
| `tests/send-file.test.js` | C | 配置 / 发布 / 开发入口 | — |
| `tests/send-text.test.js` | U | 配置 / 发布 / 开发入口 | — |
| `tests/server.test.js` | W | 配置 / 发布 / 开发入口 | 同改 |
| `tests/sticker-marker.test.js` | W | 配置 / 发布 / 开发入口 | 同改 |
| `tests/test_emoticon.py` | C | 配置 / 发布 / 开发入口 | — |
| `tests/test_engine_reminder_wiring.py` | W | 配置 / 发布 / 开发入口 | — |
| `tests/test_file_clipboard.py` | C | 配置 / 发布 / 开发入口 | — |
| `tests/test_file_send.py` | C | 配置 / 发布 / 开发入口 | — |
| `tests/test_image_ui_fallback.py` | U | 配置 / 发布 / 开发入口 | 同改 |
| `tests/test_moments_publish.py` | W | 朋友圈选材 / 调度 / 发布 | 同改 |
| `tests/test_moments_window.py` | U | 朋友圈选材 / 调度 / 发布 | 同改 |
| `tests/test_moments_worker.py` | W | 朋友圈选材 / 调度 / 发布 | 同改 |
| `tests/test_received_media.py` | W | 配置 / 发布 / 开发入口 | 同改 |
| `tests/test_sticker_transport.py` | C+W | 配置 / 发布 / 开发入口 | 同改 |
| `tests/wechat-emoticon.test.js` | C | 配置 / 发布 / 开发入口 | — |
| `tools/whale-logs/server.js` | U | 本地日志工具 | — |
| `tools/whale-logs/打开日志台.cmd` | U | 本地日志工具 | — |

## 附录 E：交付前动态工作区复核

2026-11-19 00:16:48–00:17:10 +08:00 再查：dev / upstream/main 的固定 SHA 未变化，远端 main 仍为 6910513，两仓库 open PR 仍为空；已跟踪修改增至 34 个，说明其他任务仍在进行。本轮只写报告，以下增量来自外部并发修改，不能以报告旧采样覆盖它们。

相对于附录 D，追加观察到的相关文件：

| 文件 | 状态 | 归属与整合要求 |
| --- | --- | --- |
| bridge/account_mixin.py | W | 账号绑定 / 会话定位；与 targeting.py、发送策略及上游身份核验联合审阅 |
| bridge/uia_boot.py | W | UIA 初始化；上游也修改此文件，列入桥接生命周期冲突热点 |
| config/config.example.json | W | 调度配置模板；与 configSchema、configCommands 和 momentsScheduler 一起保留兼容默认值 |
| tests/refactor-t03-config-values.test.js | W | 配置值回归，随新配置行为一并迁移 |
| tests/test_targeting.py | U | 统一会话定位测试；先确认模拟依赖，再加入步骤 5 的逐文件回归 |

原清单中的 bridge/sender_mixin.py、window_activation.py、targeting.py、src/services/momentsPublisher.js、tests/moments.test.js 内容也继续变化。尚未发现 src 下的独立 Codex provider 文件，交付复核的 config.js / client.js 搜索也未发现 codex 分支；需求缺口保持未确认，不据此删除需求。

报告 UTF-8 校验无替换字符、无未展开占位符，代码围栏配对完整，未包含真实账号 ID。源码仍在动态变化，实施前重新盘点是必要前置步骤。本轮没有执行测试。

## 附录 F：本轮写入说明

已执行授权的 upstream fetch、Git 只读比较、源码静态阅读与 GitHub 只读查询；唯一写入的工作树文件为本报告。未 commit、push、切换/合并分支、改源码、启动微信或操作用户数据。并发源码变化来自其他写入进程，未被本轮覆盖。未运行测试或发布 EXE。

