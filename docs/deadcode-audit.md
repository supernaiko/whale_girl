# JavaScript 死代码与重复逻辑审计

共扫描 **179 个** JavaScript 文件，其中 `src/` 167 个，`custom/plugins/` 12 个。发现 **dead-export 195 项**（A 156、B 39）、**dead-local 4 项**、**duplicate 13 组**、**dead-code 3 处**（A 2、B 1）。C 区是已证实仍有用的候选，统计为 37 项，单独列出。

审计取自本地 `dev` 工作树，源码复核基线为 `26dcee8f2092`。审计期间本地独立提交已合并 `stripTags`，本报告采用合并后的行号与统计。在开始和交付前，核对上游 `main` 为 `69105136f369`，唯一待合并 PR #185 涉及启动器语音及其 C# 测试。fork 的 `main` 为 `c3b63a817f19`，当时无待合并 PR。[上游 main](https://github.com/Banan1cee/whale_girl/commit/69105136f36928daf06e258352e27506502539f9) · [PR #185](https://github.com/Banan1cee/whale_girl/pull/185) · [fork main](https://github.com/supernaiko/whale_girl/commit/c3b63a817f19f06002a8f3419e023c4e40dc4b94)

## 范围与证据

- 候选来自 `src/`、`custom/plugins/` 的 `.js`，跳过各层 `tests`、`node_modules`、`app`。引用复核从仓库根目录运行，纳入 `tests/`、插件测试、`scripts/`、`bridge/`、安装副本及被忽略的本地探针。排除 Git 元数据、依赖、运行时、数据缓存、日志和临时原子写入文件。
- 用 Acorn 检查每个候选文件的语法树，枚举了 771 个具名 CommonJS 导出位置。按调用文件解析相对路径、`.js` 后缀、省略 `index.js` 的路径、绝对路径、解构别名和命名空间成员，再跟踪 `module.exports = require(...)` 与对象展开。对按键分派和路径变量补查文本调用点。扫描范围内的文件均可解析。
- 表中 `S` 按独立单词搜候选名字，`P` 搜结构正则。命中以文件及行号去重。同名定义、注释、旧补丁文本和副本仍计入文本命中。对 A/B 的死导出，判断使用与否以解析后的目标模块和成员为准。A 的建议默认只移除导出名，本文件内的调用和实现照旧，表内另有标出可删的定义。

在仓库根目录用 PowerShell 可复跑表中命令。

```powershell
$AuditGlobs = @(
  '-g', '!**/.git/**',
  '-g', '!**/node_modules/**',
  '-g', '!**/runtime/**',
  '-g', '!**/vendor/**',
  '-g', '!**/data/**',
  '-g', '!**/.venv/**',
  '-g', '!**/venv/**',
  '-g', '!**/wheelhouse/**',
  '-g', '!**/site-packages/**',
  '-g', '!**/dist-info/**',
  '-g', '!**/__pycache__/**',
  '-g', '!**/*.log',
  '-g', '!**/*.log.*',
  '-g', '!docs/deadcode-audit.md',
  '-g', '!**/*.tmpdir/**',
  '-g', '!**/*.tmp'
)
function S([string]$Pattern) { rg -n -o -w --no-heading --color never --hidden --no-ignore @AuditGlobs -e $Pattern . }
function P([string]$Pattern) { rg -n -o --no-heading --color never --hidden --no-ignore @AuditGlobs -e $Pattern . }
```

动态加载复核使用 `P 'createRequire|require\s*\(\s*(?:path\.join|workerData\.|id\b|runner\b|helperFile\b)|require\.resolve|entry\._compile|hooks\?\.\[input\.hook\]|exported\?\.\[input\.hook\]'`，共 38 个匹配行，其中安装副本 2 行。关键命中包括 `scripts/replay-trace.js:27–28`、`tests/memory-crash.test.js:83–84、311`、`tests/moments-codex.test.js:5`、`tests/location-privacy.test.js:16` 和 `src/services/javascriptPluginWorker.js:62、71`。另外核对 `tests/user-experience.test.js:7–17` 的 `source(relative)`、`custom/plugins/yxn-chat/plugin.js:315` 的宿主相对加载，以及 `_tlocal.js:1、4` 的绝对路径探针。库外安装的插件和兼容调用由 B 区条目确认。

## A 安全可删

| 类型 | 文件和行号 | 函数、常量或分支 | grep 命中及判断依据 | 建议动作 |
| --- | --- | --- | --- | --- |
| dead-code | `src/adapters/search/html.js:13` | `decodeEntities` 的 `key === '#39'` | `P 'key === ''#39''\|decodeEntities'` 命中本文件 5 行（3、13、23、30、42），安装或构建副本 12 行，其余文本 8 行。 正则第 6 行的数字分支在命名分支前。`&#39;` 进入数字捕获，同一输入到不了第 13 行。`src/adapters/links.js:18` 共用解码器。 | 删除命名备选里的 `#39` 和对应分支。保留十进制码点解码能力，回归单次转义、`&#39;` 和 `&#x27;`。 |
| dead-code | `src/services/wechat.js:132` | `wechatAccountsPayload` 的相同三元分支 | `P 'wanted\s*\?\s*''''\s*:\s*''''\|wechatAccountsPayload'` 命中本文件 3 行（121、132、206），安装或构建副本 8 行，其余文本 5 行。 条件两侧均为空字符串，`wanted` 已是普通局部字符串。`src/http/routes/wechat.js` 仍调用此服务。 | 将兜底简化为 `matchAccountDir(accounts, wanted) \|\| ''`，保留左侧原有的求值与回退。 |
| dead-export | `src/adapters/gateway.js:389` | `PLATFORMS`、`postJson` | `S 'postJson\|PLATFORMS'` 命中本文件 5 行（20、71、311、380、389），安装或构建副本 13 行，其余文本 25 行。 同名 `postJson` 在 search/transport、vision 和脚本中各自定义或从其他模块读取。网关内部仍使用自己的发送实现。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/adapters/links.js:360` | `cleanVideoDesc` | `S 'cleanVideoDesc'` 命中本文件 3 行（329、349、360），安装或构建副本 3 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/adapters/mediaCache.js:84` | `listFiles` | `S 'listFiles'` 命中本文件 4 行（13、24、41、84），安装或构建副本 4 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/adapters/search/apiSearch.js:102` | `cleanProviders` | `S 'cleanProviders'` 命中本文件 3 行（16、58、102），安装或构建副本 3 行，其余文本 0 行。 测试替换的是 `apiSearch` 方法，`cleanProviders` 只由模块内部调用。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/adapters/search/deepseek.js:52` | `BASE_URL`、`mapItem` | `S 'mapItem\|BASE_URL'` 命中本文件 5 行（11、14、42、49、52），安装或构建副本 11 行，其余文本 7 行。 `src/services/apiProbe.js:27–28` 动态选择适配器后只调用 `search`，`tests/search-apis.test.js` 同样按 `search` 设 mock。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/adapters/search/quota.js:65` | `read`、`used` | `S 'read\|used'` 命中本文件 6 行（23、46、47、54、59、65），安装或构建副本 50 行，其余文本 423 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/adapters/search/zhihu.js:101` | `BASE_URL`、`mapItem`、`quota`、`timeOf` | `S 'quota\|mapItem\|timeOf\|BASE_URL'` 命中本文件 9 行（前 6 行号 12、15、23、33、57、75），安装或构建副本 19 行，其余文本 15 行。 `src/services/apiProbe.js:27–28` 和 `src/adapters/search/apiSearch.js` 消费 `search`。同名 `quota` 来自 `./quota`，独立于这里的导出。 解析后的仓库消费者对所列模块属性均为 0。 | 删除这些导出键，另可移除未被内部读取的 `quota`（第 79 行）。保留其余内部定义。 |
| dead-export | `src/adapters/searchRouter.js:163` | `SYSTEM` | `S 'SYSTEM'` 命中本文件 3 行（20、76、163），安装或构建副本 17 行，其余文本 9 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/adapters/stickers.js:1013、1014` | `categoryFile`（1013）、`discoverCategories`（1013）、`EXTRA_PREFIX`（1013）、`EXTS`（1013）、`GENERIC`（1013）、`hasCategory`（1013）、`SYNONYMS`（1013）、`categoryDir`（1014）、`categoryImagesAsync`（1014） | `S 'EXTRA_PREFIX\|hasCategory\|categoryFile\|discoverCategories\|SYNONYMS\|GENERIC\|EXTS\|categoryImagesAsync\|categoryDir'` 命中本文件 33 行（前 6 行号 15、26、39、44、47、58），安装或构建副本 40 行，其余文本 17 行。 `tests/sticker-discovery.test.js:44` 自己声明 `categoryFile`，`EXTS` 在 `src/http/routes/momentsPics.js:29` 也是独立绑定。保留图库扫描和路由仍调用的其他导出。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/adapters/vision.js:344` | `maskKey` | `S 'maskKey'` 命中本文件 3 行（26、153、344），安装或构建副本 17 行，其余文本 17 行。 `server.js` 和设置、状态模块使用的是 `infra/config.maskKey`，这里的 `maskKey` 仍被视觉模块内部使用。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/core/context.js:168` | `makeStamper`、`MAX_PROMPT_TOKENS`、`MAX_TURN_CHARS`、`STAMP_GAP_MS` | `S 'MAX_TURN_CHARS\|MAX_PROMPT_TOKENS\|STAMP_GAP_MS\|makeStamper'` 命中本文件 12 行（前 6 行号 11、13、18、24、32、69），安装或构建副本 12 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 删除这些导出键，另可移除未被内部读取的 `makeStamper`（第 24 行）。保留其余内部定义。 |
| dead-export | `src/core/env.js:186` | `localizeEdition`、`tzOffsetLabel`、`WINDOWS_RELEASE` | `S 'tzOffsetLabel\|localizeEdition\|WINDOWS_RELEASE'` 命中本文件 7 行（前 6 行号 27、67、86、87、138、175），安装或构建副本 7 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/core/events.js:113` | `relativeLabel`、`STATUS_LABEL`、`timeLabel`、`TYPE_LABEL` | `S 'timeLabel\|relativeLabel\|TYPE_LABEL\|STATUS_LABEL'` 命中本文件 10 行（前 6 行号 17、25、56、64、68、76），安装或构建副本 14 行，其余文本 4 行。 `src/services/debug.js:28` 调用的是人设聚合入口的同名 `timeLabel`。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/core/history.js:29` | `stripHistoryPrefixes` | `S 'stripHistoryPrefixes'` 命中本文件 3 行（14、23、29），安装或构建副本 3 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/core/identity.js:36` | `MASTER_ASK_RE`、`MASTER_DENIAL_RE` | `S 'MASTER_DENIAL_RE\|MASTER_ASK_RE'` 命中本文件 5 行（10、12、20、25、36），安装或构建副本 5 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/core/reminder.js:231、234、235、236` | `extractWhat`（231）、`cnToNumber`（234）、`parseClockPhrase`（235）、`applyPeriod`（236） | `S 'extractWhat\|cnToNumber\|parseClockPhrase\|applyPeriod'` 命中本文件 15 行（前 6 行号 25、45、60、67、83、119），安装或构建副本 15 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/core/search/policy.js:48` | `inferKind`、`weatherSupported` | `S 'inferKind\|weatherSupported'` 命中本文件 5 行（15、24、33、34、48），安装或构建副本 5 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/core/text.js:61` | `SENSITIVE_PATTERNS` | `S 'SENSITIVE_PATTERNS'` 命中本文件 3 行（11、18、61），安装或构建副本 3 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/core/trace.js:161` | `chatTag`、`hash8`、`stateSummary` | `S 'hash8\|chatTag\|stateSummary'` 命中本文件 10 行（前 6 行号 28、44、46、50、119、120），安装或构建副本 10 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/core/trigger.js:129` | `herNames` | `S 'herNames'` 命中本文件 3 行（5、29、129），安装或构建副本 11 行，其余文本 10 行。 测试和流水线经 `src/core/addressing.js` 读取 `herNames`，`trigger` 经相同模块导入并在内部使用。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/http/range.js:38` | `DAY` | `S 'DAY'` 命中本文件 5 行（4、21、30、31、38），安装或构建副本 6 行，其余文本 24 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/infra/config.js:737、747、748` | `LOCAL_HOST_RE`（737）、`deepMerge`（747）、`readJson`（748） | `S 'LOCAL_HOST_RE\|deepMerge\|readJson'` 命中本文件 12 行（前 6 行号 12、366、371、389、395、407），安装或构建副本 59 行，其余文本 101 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/infra/configPatch.js:522、523、524、526、527、528、530` | `SETTINGS_SHADOW`（522）、`SECRET_PATHS`（523）、`isPlainObject`（524）、`setByPath`（526）、`coerceValue`（527）、`flattenPatch`（528）、`clearSettingsShadow`（530） | `S 'SETTINGS_SHADOW\|SECRET_PATHS\|isPlainObject\|setByPath\|coerceValue\|flattenPatch\|clearSettingsShadow'` 命中本文件 41 行（前 6 行号 18、32、42、57、61、73），安装或构建副本 47 行，其余文本 7 行。 `src/http/routes/config.js:40` 提到 `SECRET_PATHS` 是注释，调用方经清理接口处理；`coerceValue` 的另一处出现同样是注释。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/infra/features.js:174` | `defaults` | `S 'defaults'` 命中本文件 2 行（165、174），安装或构建副本 8 行，其余文本 39 行。 价格与语音测试里的 `defaults` 指向独立模块或变量。`isOn`、注册表、配置默认值等现有入口继续使用。 解析后的仓库消费者对所列模块属性均为 0。 | 删除这些导出键，另可移除未被内部读取的 `defaults`（第 165 行）。保留其余内部定义。 |
| dead-export | `src/infra/logger.js:180` | `callerSite`、`LEVELS` | `S 'LEVELS\|callerSite'` 命中本文件 7 行（前 6 行号 25、64、101、102、119、139），安装或构建副本 7 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/infra/modelFollow.js:35` | `officialChat` | `S 'officialChat'` 命中本文件 4 行（4、18、27、35），安装或构建副本 4 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/infra/textBudget.js:79` | `CJK_RE` | `S 'CJK_RE'` 命中本文件 3 行（19、28、79），安装或构建副本 3 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/infra/time.js:330、331、334、347、351` | `DAY_MS`（330）、`SYSTEM_TZ`（331）、`systemTimeZone`（334）、`formatWindow`（347）、`windowsText`（351） | `S 'DAY_MS\|SYSTEM_TZ\|systemTimeZone\|formatWindow\|windowsText'` 命中本文件 13 行（前 6 行号 15、16、39、40、44、167），安装或构建副本 33 行，其余文本 25 行。 解析后的仓库消费者对所列模块属性均为 0。 | 删除这些导出键，另可移除未被内部读取的 `DAY_MS`（第 15 行）、`systemTimeZone`（第 39 行）、`windowsText`（第 202 行）。保留其余内部定义。 |
| dead-export | `src/llm/client.js:1073、1074、1075、1076` | `thinkingPlan`（1073）、`pickText`（1074）、`stripThinking`（1075）、`reasoningTokensOf`（1076） | `S 'thinkingPlan\|pickText\|stripThinking\|reasoningTokensOf'` 命中本文件 17 行（前 6 行号 117、134、153、180、239、263），安装或构建副本 17 行，其余文本 2 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/backup.js:278、286、287` | `BUNDLE_VERSION`（278）、`backupDir`（286）、`FILES`（287） | `S 'BUNDLE_VERSION\|backupDir\|FILES'` 命中本文件 11 行（前 6 行号 16、21、43、91、100、142），安装或构建副本 12 行，其余文本 9 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/budget.js:124` | `BudgetExceededError` | `S 'BudgetExceededError'` 命中本文件 4 行（21、27、70、124），安装或构建副本 4 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/budgetPlan.js:205、208、209、210、211、212` | `cardCaps`（205）、`BOTTOMS`（208）、`CARD_BASE`（209）、`CARD_MAX`（210）、`RECENT_FLOOR`（211）、`MIN_DIALOGUE`（212） | `S 'cardCaps\|BOTTOMS\|CARD_BASE\|CARD_MAX\|RECENT_FLOOR\|MIN_DIALOGUE'` 命中本文件 19 行（前 6 行号 47、54、60、88、89、97），安装或构建副本 19 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/calibration.js:308、314、315` | `TokenCalibration`（308）、`modelKey`（314）、`defaultFile`（315） | `S 'TokenCalibration\|modelKey\|defaultFile'` 命中本文件 10 行（前 6 行号 72、78、82、87、130、279），安装或构建副本 10 行，其余文本 0 行。 生产和测试通过 `createCalibration` 构造对象，工厂内部使用 `TokenCalibration`。模块级兼容 API 另见 B。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/chatStore.js:743` | `normalizeEpisode`、`normalizeState`、`normalizeSummary`、`padSeq`、`readJson` | `S 'readJson\|normalizeSummary\|normalizeEpisode\|normalizeState\|padSeq'` 命中本文件 15 行（前 6 行号 22、40、59、70、110、147），安装或构建副本 60 行，其余文本 97 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/compression.js:296、297、300、301、304、308` | `SUMMARY_SYSTEM`（296）、`recentSince`（297）、`takeChunk`（300）、`parseSummary`（301）、`trimSummary`（304）、`resetSummary`（308） | `S 'SUMMARY_SYSTEM\|recentSince\|takeChunk\|parseSummary\|trimSummary\|resetSummary'` 命中本文件 22 行（前 6 行号 18、33、39、68、88、92），安装或构建副本 23 行，其余文本 2 行。 `src/memory/episode.js:212` 只在注释里说明这里不能调用 `resetSummary`，实际路径追加单段摘要。 解析后的仓库消费者对所列模块属性均为 0。 | 删除这些导出键，另可移除未被内部读取的 `resetSummary`（第 281 行）。保留其余内部定义。 |
| dead-export | `src/memory/episode.js:278、279、283、284、288、289` | `TOPIC_SHIFT_RE`（278）、`episodeStart`（279）、`episodeMessages`（283）、`speakersOf`（284）、`dateString`（288）、`DAY_MS`（289） | `S 'TOPIC_SHIFT_RE\|episodeStart\|episodeMessages\|speakersOf\|dateString\|DAY_MS'` 命中本文件 19 行（前 6 行号 10、20、22、28、48、77），安装或构建副本 43 行，其余文本 26 行。 `src/memory/store.js:240` 调的是 `personCard.dateString`；其他 `DAY_MS` 绑定来自 `src/memory/constants.js`。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/extractor.js:312` | `EPISODE_SYSTEM` | `S 'EPISODE_SYSTEM'` 命中本文件 3 行（122、266、312），安装或构建副本 3 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/format.js:305` | `indexLine`、`splitSentences` | `S 'splitSentences\|indexLine'` 命中本文件 5 行（59、107、158、238、305），安装或构建副本 5 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/hash.js:26` | `sha1Hex` | `S 'sha1Hex'` 命中本文件 5 行（9、14、18、23、26），安装或构建副本 5 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/migrate.js:615、619、620、621` | `writeImportNotice`（615）、`readMemoryJson`（619）、`canonicalChatId`（620）、`LEGACY_SOURCES`（621） | `S 'writeImportNotice\|readMemoryJson\|canonicalChatId\|LEGACY_SOURCES'` 命中本文件 13 行（前 6 行号 23、47、59、302、423、453），安装或构建副本 13 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/personCard.js:485、499` | `assertChat`（485）、`similarity`（499） | `S 'assertChat\|similarity'` 命中本文件 11 行（前 6 行号 45、68、257、298、328、341），安装或构建副本 11 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/relations.js:390、391、393、401、402` | `MAX_RELATIONS`（390）、`MAX_TEXT`（391）、`RELATION_WORDS`（393）、`pairOf`（401）、`relationId`（402） | `S 'MAX_RELATIONS\|MAX_TEXT\|RELATION_WORDS\|pairOf\|relationId'` 命中本文件 22 行（前 6 行号 37、39、52、57、111、117），安装或构建副本 25 行，其余文本 3 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/retrieval.js:150` | `bm25`、`overlap` | `S 'overlap\|bm25'` 命中本文件 7 行（前 6 行号 32、52、93、116、129、147），安装或构建副本 11 行，其余文本 8 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/memory/store.js:944` | `trimText` | `S 'trimText'` 命中本文件 8 行（前 6 行号 50、241、242、519、539、560），安装或构建副本 8 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/persona/portable.js:33` | `BOOLEANS`、`NUMBERS`、`STRINGS` | `S 'NUMBERS\|STRINGS\|BOOLEANS'` 命中本文件 7 行（前 6 行号 4、9、13、17、21、26），安装或构建副本 7 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/persona/presets.js:450、451、459` | `dirFor`（450）、`userDir`（451）、`USER_PREFIX`（459） | `S 'dirFor\|userDir\|USER_PREFIX'` 命中本文件 24 行（前 6 行号 18、27、42、47、115、125），安装或构建副本 24 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/persona/tokenCheck.js:106` | `effectiveDialogueBudget` | `S 'effectiveDialogueBudget'` 命中本文件 3 行（19、92、106），安装或构建副本 3 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/pipeline/chat.js:2358` | `isContextLengthError` | `S 'isContextLengthError'` 命中本文件 4 行（170、1641、2146、2358），安装或构建副本 4 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/services/budget.js:217` | `isPeakHour`、`systemVariants` | `S 'systemVariants\|isPeakHour'` 命中本文件 5 行（44、68、79、134、217），安装或构建副本 5 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/services/care.js:352` | `DEFAULT_WINDOW` | `S 'DEFAULT_WINDOW'` 命中本文件 3 行（24、81、352），安装或构建副本 3 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/services/contacts.js:135` | `MAX_ITEMS` | `S 'MAX_ITEMS'` 命中本文件 3 行（18、88、135），安装或构建副本 3 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/services/envInfo.js:145` | `resolvePlace` | `S 'resolvePlace'` 命中本文件 4 行（67、87、109、145），安装或构建副本 4 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/services/localReply.js:183` | `freeMB`、`SYSTEM` | `S 'freeMB\|SYSTEM'` 命中本文件 16 行（前 6 行号 13、25、31、66、115、147），安装或构建副本 30 行，其余文本 19 行。 `generate` 返回对象中的 `freeMB` 是数据字段。两个同名插件变量是模块内部绑定，未读取 `sharedLocalReply.freeMB`。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/services/location.js:359、361、368、369` | `refresh`（359）、`stop`（361）、`formatAccuracy`（368）、`FINE_ACCURACY_M`（369） | `S 'refresh\|stop\|formatAccuracy\|FINE_ACCURACY_M'` 命中本文件 14 行（前 6 行号 27、77、85、99、278、313），安装或构建副本 48 行，其余文本 180 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/services/momentsCodex.js:234` | `codexEntry` | `S 'codexEntry'` 命中本文件 5 行（17、23、84、208、234），安装或构建副本 5 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/services/momentsPhotos.js:293` | `baiduSearch`、`bingCandidates`、`bingSearch`、`download`、`exifCamera`、`photoSize` | `S 'photoSize\|exifCamera\|baiduSearch\|bingSearch\|bingCandidates\|download'` 命中本文件 16 行（前 6 行号 49、89、111、150、184、193），安装或构建副本 20 行，其余文本 82 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/services/momentsPublisher.js:726` | `parseDraft` | `S 'parseDraft'` 命中本文件 3 行（55、394、726），安装或构建副本 3 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/services/reminderService.js:451` | `MAX_ACTIVE_PER_CHAT`、`MAX_TOTAL` | `S 'MAX_TOTAL\|MAX_ACTIVE_PER_CHAT'` 命中本文件 9 行（前 6 行号 29、30、77、167、170、206），安装或构建副本 9 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/services/status.js:150` | `storeSummary`、`usageSnapshot` | `S 'storeSummary\|usageSnapshot'` 命中本文件 5 行（7、16、59、81、150），安装或构建副本 5 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/services/wechat.js:202、204` | `newestDbMtime`（202）、`readAccountsCache`（204） | `S 'newestDbMtime\|readAccountsCache'` 命中本文件 7 行（前 6 行号 11、64、97、123、195、202），安装或构建副本 7 行，其余文本 1 行。 `tests/wechat-scan-layouts.test.js:23` 注释提到 `newestDbMtime`，实际导入和覆盖的是 `scanWechatAccounts`，仍会间接使用该实现。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-export | `src/services/weiboPosts.js:138` | `parseCards` | `S 'parseCards'` 命中本文件 3 行（66、97、138），安装或构建副本 3 行，其余文本 0 行。 解析后的仓库消费者对所列模块属性均为 0。 | 移除列出的导出键，保留内部定义与调用。 |
| dead-local | `custom/plugins/whale-ops/plugin.js:31` | `APP_NAME` | `S 'APP_NAME'` 命中本文件 1 行（31），安装或构建副本 0 行，其余文本 0 行。 唯一命中是顶层字符串定义。命令分派和插件清单使用各自的值。 | 删除列出的顶层声明。 |
| dead-local | `custom/plugins/yxn-voice/plugin.js:20` | `num` | `S 'num'` 命中本文件 1 行（20），安装或构建副本 30 行，其余文本 90 行。 本文件唯一命中是定义。其他 `num` 属于不同模块的数值转换或不同作用域。 | 删除列出的顶层声明。 |
| dead-local | `src/services/localReply.js:15、17` | `AI_WORDS`（15）、`stripAiTone`（17） | `S 'AI_WORDS\|stripAiTone'` 命中本文件 2 行（15、17），安装或构建副本 2 行，其余文本 8 行。 两行分别是正则与函数定义。根目录 `_p46.py`、`_p47.py`、`_p48.py` 的命中是补丁文本或插入条件。实际生成路径经 `parseReply`，未读这两个绑定。 | 删除列出的顶层声明。 |

## B 需人工确认

| 类型 | 文件和行号 | 函数、常量或分支 | grep 命中及判断依据 | 建议动作 |
| --- | --- | --- | --- | --- |
| dead-code | `src/services/momentsCodex.js:118` | `onRaw(out)` 在成功路径重复调用 | `P 'input\.onRaw\(out\)\|\bonRaw\b'` 命中本文件 2 行（116、118），安装或构建副本 3 行，其余文本 1 行。 第 116 行在判断解析成功之前已调用，成功后第 118 行再调用。当前路由在 `src/http/routes/momentsPics.js:99` 仅给局部变量赋值，因此现有路径掩盖了重复通知。 | 先用一次成功和一次失败输出确认各回调一次。确认外部调用约定后保留第 116 行，删除第 118 行。 |
| dead-export | `src/adapters/websearch.js:28` | `bilibiliHot`、`bilibiliHotText`、`hotNews`、`hotNewsText`、`searchText`、`weiboHot` | `S 'searchText\|hotNews\|hotNewsText\|bilibiliHot\|bilibiliHotText\|weiboHot'` 命中本文件 7 行（前 6 行号 14、15、18、19、20、21），安装或构建副本 7 行，其余文本 0 行。 第 3 行明确给旧调用方和外部脚本保留接口。搜索服务现用结构化结果，其注入路径见 `src/services/search.js:39、123、131、156`。 | 核对已发布接口后逐项弃用，保留已有结构化调用。 |
| dead-export | `src/core/context.js:168` | `MAX_PROMPT_CHARS` | `S 'MAX_PROMPT_CHARS'` 命中本文件 2 行（15、168），安装或构建副本 4 行，其余文本 2 行。 第 14 行明确标为旧调用方兼容导出。`src/services/digest.js:20、200` 的同名常量是独立绑定。 | 确认存量客户端或本地插件的兼容需求后，再移除旧字符口径常量和导出。 |
| dead-export | `src/core/search/quality.js:132、133` | `relevanceScore`（132）、`tightenFreshness`（133） | `S 'relevanceScore\|tightenFreshness'` 命中本文件 7 行（前 6 行号 43、69、102、111、120、132），安装或构建副本 7 行，其余文本 0 行。 `src/adapters/websearch.js:4、27` 整体转导出。当前消费者未读取这两个具体键，外部旧脚本仍有兼容入口。 | 先确认 `websearch` 兼容约定，届时从兼容入口和源模块一并收缩，保留内部排序和时效逻辑。 |
| dead-export | `src/http/protocol.js:91` | `MAX_BODY` | `S 'MAX_BODY'` 命中本文件 3 行（5、33、91），安装或构建副本 3 行，其余文本 1 行。 `src/http/util.js:14` 整体转导出。`tests/http-hardening.test.js:127` 只在注释提到 `MAX_BODY`，测试通过 HTTP 请求间接覆盖限额。 | 确认旧 `http/util` 兼容调用后只删导出，保留请求体限额常量和校验。 |
| dead-export | `src/http/routes/yxn.js:304` | `helpers` | `S 'helpers'` 命中本文件 1 行（304），安装或构建副本 1 行，其余文本 36 行。 `src/http/routes/index.js:31、37` 导入并调用默认注册函数，未读取附加属性。其他同名 `helpers` 未指向这里。 | 确认本地脚本或插件没有从路由模块读取该附加属性，再删 `module.exports.helpers`。保留默认注册函数和路由仍用的两个实现。 |
| dead-export | `src/infra/configSchema.js:297` | `getByPath` | `S 'getByPath'` 命中本文件 4 行（3、275、284、297），安装或构建副本 16 行，其余文本 26 行。 第 3 行从 `./objpath` 导入后再导出。`tests/refactor-shared-helpers.test.js:14` 直接从 `objpath` 解构。 | 确认旧调用方可改用 `src/infra/objpath.js`，再去掉转导出，保留内部校验使用。 |
| dead-export | `src/infra/features.js:174` | `getByPath` | `S 'getByPath'` 命中本文件 3 行（13、148、174），安装或构建副本 16 行，其余文本 27 行。 第 13 行从 `./objpath` 导入。`tests/refactor-t03-config-values.test.js:60–61` 实际调用的是 `configPatch.getByPath`。 | 确认旧调用方可改用 `src/infra/objpath.js`，再移除这个转导出。 |
| dead-export | `src/memory/calibration.js:310、311、312、313、316` | `apply`（310）、`observe`（311）、`trimScale`（312）、`reset`（313）、`constants`（316） | `S 'apply\|observe\|trimScale\|reset\|constants'` 命中本文件 17 行（前 6 行号 146、163、215、267、290、291），安装或构建副本 87 行，其余文本 246 行。 第 282–304 行描述独立的模块级内存 API。Bot 在 `src/pipeline/chat.js:250–259` 用工厂，调用的是实例方法。测试同样从工厂创建实例。 | 确认用户脚本后才收缩模块级 API。保留工厂、实例方法和持久校准流程。 |
| dead-export | `src/memory/extractor.js:313` | `cleanIncoming` | `S 'cleanIncoming'` 命中本文件 3 行（14、29、313），安装或构建副本 7 行，其余文本 14 行。 第 14 行从 `./text` 导入后再导出。`tests/refactor-shared-helpers.test.js:80–84` 实际测试 `src/memory/text.js` 的导出。 | 确认兼容用途后移除 `extractor` 处的转导出，保留内部导入和统一清洗逻辑。 |
| dead-export | `src/persona/index.js:14` | `EMOJI_LEVEL_CHANCE` | `S 'EMOJI_LEVEL_CHANCE'` 命中本文件 1 行（14），安装或构建副本 4 行，其余文本 3 行。 第 3 行注明保留公共入口。`EMOJI_LEVEL_CHANCE` 在 `expression.js:30、37、51` 另有实现和模块导出。当前按键测试 `tests/persona-modules.test.js:16` 未列该键。 | 确认公共入口契约后移除这一层别名，表达模块和真实概率逻辑继续保留。 |
| dead-export | `src/persona/prompt.js:829、830、831、837、838` | `FIGHT_STYLE`（829）、`CORE_TEMPER`（830）、`MASTER_OBEY`（831）、`isLateNight`（837）、`dayLine`（838） | `S 'FIGHT_STYLE\|CORE_TEMPER\|MASTER_OBEY\|isLateNight\|dayLine'` 命中本文件 14 行（前 6 行号 122、269、285、296、344、502），安装或构建副本 14 行，其余文本 1 行。 `src/persona/index.js:4、8` 整体转导出，索引明示兼容旧入口；现有动态测试只断言第 16 行列出的键。 | 等公共入口约定明确再收缩。保留构建提示词仍读取的常量和函数。 |
| dead-export | `src/services/care.js:335、351` | `parseClock`（335）、`formatMinutes`（351） | `S 'parseClock\|formatMinutes'` 命中本文件 6 行（27、31、86、128、335、351），安装或构建副本 19 行，其余文本 20 行。 第 26 行明确这些同名入口用于兼容；`parseClock` 与 `formatMinutes` 分别转发 `time.parseClock` 和 `time.formatClock`。 | 确认旧调用方后只删过渡别名，保留 `src/infra/time.js` 的时间处理。 |
| dead-export | `src/services/location.js:358、364、365` | `detect`（358）、`systemPosition`（364）、`reverseGeocode`（365） | `S 'detect\|systemPosition\|reverseGeocode'` 命中本文件 9 行（前 6 行号 132、218、243、244、246、283），安装或构建副本 9 行，其余文本 5 行。 `tests/location-privacy.test.js:8、14–22` 读取源码并在 VM 中重绑定两个定位函数，再从内部 `detect` 建测试入口。已有动态测试和自动探测入口。 | 确认调试工具与插件调用后再考虑移除导出，保留 VM 测试需要的顶层绑定和真实定位流程。 |
| dead-export | `src/services/momentsPaint.js:30` | `characterCard` | `S 'characterCard'` 命中本文件 3 行（10、23、30），安装或构建副本 3 行，其余文本 2 行。 根目录忽略的 `_p_refs2.js:3、11–12` 读取指定模块源码并依赖 `characterCard` 文本，其他探针直接导入 `paint`。 | 先确认维护者是否保留这些本地探针的接口。只有 `characterCard` 的模块属性是候选，内部图像角色卡逻辑继续保留。 |
| dead-export | `custom/plugins/whale-memo/plugin.js:207` | `_internal.isOwner`、`_internal.mergeSection`、`_internal.rememberChat`、`_internal.settingsOf` | `S 'mergeSection\|settingsOf\|rememberChat\|isOwner'` 命中本文件 10 行（前 6 行号 11、48、54、55、96、116），安装或构建副本 0 行，其余文本 5 行。 `_internal` 由 `custom/plugins/whale-memo/tests/run-tests.js:39、147、149` 访问，已确认其 `parseModel` 成员活跃。列出的其他成员在当前调用链未见读取，测试探针是可直接导入的模块。 | 向插件维护者确认测试入口约定后，只收缩列出的键。 |
| dead-export | `custom/plugins/yxn-bond/plugin.js:232` | `__test.emptyState`、`__test.updatePerson` | `S 'emptyState\|updatePerson'` 命中本文件 7 行（前 6 行号 33、42、45、52、123、172），安装或构建副本 1 行，其余文本 2 行。 `custom/plugins/yxn-bond/tests/bond.test.js:5` 解构同一个 `__test`，取的是另外五个成员。 | 确认发行包或外部插件测试没有读取这两个成员后，仅移除对应键。 |
| dead-export | `custom/plugins/yxn-gate/plugin.js:224` | `__test.DEFAULTS`、`__test.readSettings` | `S 'readSettings\|DEFAULTS'` 命中本文件 8 行（前 6 行号 19、39、43、44、45、47），安装或构建副本 5 行，其余文本 14 行。 `custom/plugins/yxn-gate/tests/gate.test.js:10` 通过 `hooks.__test` 取 `scoreMessage`，并未取这两个成员。 | 确认插件测试入口约定，再移除这两个键。 |

## C 误报，保留

| 类型 | 文件和行号 | 函数、常量或分支 | grep 命中及判断依据 | 建议动作 |
| --- | --- | --- | --- | --- |
| dead-code | `src/pipeline/chat.js:1633` | `while (true)` 流式重试 | `P 'while \(true\)\|streamReply\|isContextLengthError'` 命中本文件 5 行（170、1633、1641、2146、2358），安装或构建副本 5 行，其余文本 3 行。 第 1639 行正常完成会 `break`，第 1641–1645 行只在尚未输出且未重试时 `continue`，其他错误抛出。第 1648 行从正常退出路径到达。 | 保留流式重试和退出后的用量记录。 |
| dead-code | `src/llm/client.js:465` | `isMock` getter | `S 'isMock'` 命中本文件 5 行（465、555、661、924、951），安装或构建副本 32 行，其余文本 114 行。 读取实例的 `mock`、`needsKey` 和 `apiKey`，提供商测试加载多种配置。 | 保留 getter 和调用。 |
| dead-code | `src/memory/chatStore.js:104` | `chatRoot` getter | `S 'chatRoot'` 命中本文件 7 行（前 6 行号 104、109、133、146、286、654），安装或构建副本 7 行，其余文本 0 行。 以实例目录计算路径，供本模块打开、恢复和写入聊天存储。 | 保留 getter。 |
| dead-code | `src/services/javascriptPluginWorker.js:47` | `context` getter | `P 'get context\(\|current\.run\(\|(?:sdk\|whale\|host)[?.]+context'` 命中本文件 2 行（47、77），安装或构建副本 2 行，其余文本 1 行。 在第 77 行的 `AsyncLocalStorage.run` 上下文中读取本次请求，宿主于初始化时把 getter 作为 `require('whale')` 的 SDK 暴露。 | 保留插件入口，避免破坏每次调用的上下文。 |
| dead-code | `custom/plugins/yxn-chat/plugin.js:327` | `generateLocalModelReply` 独立 CLI 回退 | `S 'sharedLocalReply\|generateLocalModelReply'` 命中本文件 8 行（前 6 行号 313、315、317、320、321、323），安装或构建副本 1 行，其余文本 8 行。 第 315 行按插件入口文件相对路径加载宿主；实际插件入口位于第 56 行指定的插件数据目录。加载失败进入 `catch`，一部分宿主生成失败也会继续走这一段。 | 保留可独立打包的回退。重构前先比较命令行参数和输出解析差异。 |
| dead-export | `custom/plugins/whale-memo/plugin.js:179、187、200、201、207` | `chat.pre_reply`（179）、`chat.generate`（187）、`timer.tick`（200）、`tool.run`（201）、`_internal`（207） | `S 'tool\.run\|chat\.pre_reply\|chat\.generate\|timer\.tick\|_internal'` 命中本文件 6 行（3、179、187、200、201、207），安装或构建副本 17 行，其余文本 150 行。 清单 `custom/plugins/whale-memo/plugin.json:11` 和 `javascriptPluginWorker.js:67–77` 证实宿主按键分派。`custom/plugins/whale-memo/tests/run-tests.js:39、147、149` 读取 `_internal.parseModel`。 | 保留清单里的钩子和 `_internal` 本身。 |
| dead-export | `custom/plugins/yxn-bond/plugin.js:227、228、229、232` | `chat.pre_reply`（227）、`chat.prompt`（228）、`timer.tick`（229）、`__test`（232） | `S 'chat\.pre_reply\|chat\.prompt\|timer\.tick\|__test'` 命中本文件 4 行（227、228、229、232），安装或构建副本 14 行，其余文本 119 行。 `javascriptPluginWorker.js:70–77` 按输入钩子取值。`custom/plugins/yxn-bond/tests/bond.test.js:5` 直接解构 `__test`。 | 保留已注册钩子和已测试的 `__test` 成员。 |
| dead-export | `custom/plugins/yxn-chat/plugin.js:442、446` | `hooks`（442）、`generateLocalModelReply`（446） | `S 'hooks\|generateLocalModelReply'` 命中本文件 4 行（320、405、442、446），安装或构建副本 22 行，其余文本 110 行。 默认 `hooks` 由 `javascriptPluginWorker.js:70–75` 读取。忽略的本地探针 `_tlocal.js:1、4` 以绝对路径直接导入并调用 `generateLocalModelReply`，运行路径 `plugin.js:405` 也使用同一实现。 | 保留钩子和探针用的导出。 |
| dead-export | `custom/plugins/yxn-voice/plugin.js:129、130、133` | `chat.prompt`（129）、`chat.before_send`（130）、`__test`（133） | `S 'chat\.prompt\|chat\.before_send\|__test'` 命中本文件 5 行（7、9、129、130、133），安装或构建副本 10 行，其余文本 47 行。 `custom/plugins/yxn-voice/plugin.json` 声明钩子，运行时在 `javascriptPluginWorker.js:70–77` 解析。`custom/plugins/yxn-voice/tests/voice.test.js:5` 读取 `__test`。 | 保留钩子和测试入口。 |
| dead-export | `src/adapters/search/bing.js:28` | `search` | `S 'search'` 命中本文件 3 行（20、21、28），安装或构建副本 102 行，其余文本 295 行。 `src/adapters/search/web.js:3、30、54` 用 `({ bing, so360 }[provider]).search(...)` 执行。 | 保留搜索适配器的导出。 |
| dead-export | `src/adapters/websearch.js:27` | `weatherResult` | `S 'weatherResult'` 命中本文件 2 行（25、27），安装或构建副本 5 行，其余文本 12 行。 `src/services/search.js:39、123` 将 `web` 作为默认注入并调用 `providers.weatherResult`。`tests/search-bot.test.js:246` 按字符串替换 `web.weatherResult`。 | 保留结构化天气结果的导出。 |
| dead-export | `src/core/master.js:164` | `stripAccountHash` | `S 'stripAccountHash'` 命中本文件 5 行（39、50、51、106、164），安装或构建副本 5 行，其余文本 1 行。 `tests/refactor-t05-owner-targets.test.js:187–188` 在字符串清单中枚举该名字，再用 `master[name]` 断言。 | 保留导出和测试。 |
| dead-export | `src/persona/prompt.js:839` | `buildBlocks` | `S 'buildBlocks'` 命中本文件 3 行（632、789、839），安装或构建副本 3 行，其余文本 3 行。 `tests/persona-modules.test.js:16` 在键列表里写入 `buildBlocks` 后用 `prompt[key]` 和 `persona[key]` 比较。 | 保留原模块和公共入口的导出。 |
| dead-export | `custom/plugins/yxn-gate/plugin.js:213、224` | `chat.pre_reply`（213）、`__test`（224） | `S 'chat\.pre_reply\|__test'` 命中本文件 2 行（213、224），安装或构建副本 8 行，其余文本 75 行。 `custom/plugins/yxn-gate/tests/gate.test.js:10、36` 从 `require('../plugin.js')` 的结果读取 `__test` 和 `chat.pre_reply`。宿主也按键调用。 | 保留这两个键。 |
| dead-export | `src/core/search/quality.js:133` | `parseSnippetAgeDays` | `S 'parseSnippetAgeDays'` 命中本文件 3 行（73、124、133），安装或构建副本 3 行，其余文本 11 行。 `src/adapters/websearch.js:4、27` 整体转导出。`tests/c1c2c3.test.js:66` 经 `websearch` 调用 `parseSnippetAgeDays`。 | 保留实现和转导出路径。 |
| dead-export | `src/infra/textBudget.js:74` | `estimateTokens` | `S 'estimateTokens'` 命中本文件 6 行（21、36、47、48、56、74），安装或构建副本 28 行，其余文本 40 行。 `src/memory/tokens.js:7` 转导出整个模块，`src/memory/budget.js:18` 和 `tests/token-calibration.test.js:18` 经旧路径解构。 | 保留转导出和使用。 |
| dead-export | `src/infra/configPatch.js:525` | `getByPath` | `S 'getByPath'` 命中本文件 7 行（前 6 行号 9、106、108、170、338、434），安装或构建副本 16 行，其余文本 23 行。 `tests/refactor-t03-config-values.test.js:60–61` 通过 `patcher.getByPath` 比较写盘与内存。 | 保留此转导出。 |
| dead-export | `src/memory/personCard.js:501` | `dateString` | `S 'dateString'` 命中本文件 3 行（176、211、501），安装或构建副本 7 行，其余文本 4 行。 `src/memory/store.js:240` 调用 `personCard.dateString(entry.ts)` 渲染日期。 | 保留导出签名，允许与其他日期实现共用格式化。 |
| dead-export | `src/persona/tokenCheck.js:106` | `PERSONA_MAX_TOKENS` | `S 'PERSONA_MAX_TOKENS'` 命中本文件 2 行（25、106），安装或构建副本 2 行，其余文本 4 行。 `tests/persona-token.test.js:10` 解构导入，第 21–22、67 行断言默认常量。 | 保留测试所需的导出。 |
| dead-export | `src/services/localReply.js:183` | `generate`、`parseReply` | `S 'generate\|parseReply'` 命中本文件 4 行（87、139、149、183），安装或构建副本 26 行，其余文本 163 行。 `custom/plugins/yxn-chat/plugin.js:315、323` 相对加载并调用 `generate`；`src/http/routes/yxn.js` 也使用它。`tests/local-reply.test.js` 直接覆盖 `parseReply`。 | 保留宿主入口和测试导出。 |
| dead-export | `src/services/momentsCodex.js:234` | `parseResult` | `S 'parseResult'` 命中本文件 3 行（55、115、234），安装或构建副本 3 行，其余文本 8 行。 `tests/moments-codex.test.js:5` 用 `path.join(__dirname, '..', 'src', 'services', 'momentsCodex')` 加载，第 8 行起使用 `codex.parseResult`。 | 保留导出，另按重复通知条目复核回调。 |
| dead-export | `src/http/routes/yxn.js:303` | `register` | `S 'register'` 命中本文件 2 行（180、303），安装或构建副本 29 行，其余文本 37 行。 `src/http/routes/index.js:31、37` 收集默认导出后调用 `register(router)`。 | 保留默认导出和路由注册。 |
| dead-export | `src/adapters/links.js:360` | `decodeEntities`、`stripTags` | `S 'decodeEntities\|stripTags'` 命中本文件 7 行（前 6 行号 18、50、56、247、254、263），安装或构建副本 23 行，其余文本 18 行。 `tests/security-release-regression.test.js:14–16` 直接测试 `links.decodeEntities`。第 18 行从 `search/html` 导入 `stripTags`，第 247、254、263 行调用，链接模块的第 360 行仍兼容转导出。该重复实现已由本地并行提交收束。 | 保留共享导入和导出。 |
| dead-export | `src/adapters/search/html.js:42` | `decodeEntities` | `S 'decodeEntities'` 命中本文件 4 行（3、23、30、42），安装或构建副本 11 行，其余文本 8 行。 链接模块在 `src/adapters/links.js:18` 解构导入，`tests/security-release-regression.test.js:14–16` 也直接测试它。 | 保留导出和数字码点解码。 |

## 重复函数

按函数体规范化匹配和相似度筛选后，对照了输入转换、默认值、正则与调用契约。A 可在保持签名的前提下合并，B 先核对打包、兼容或时区语义。

| 风险 | 函数组 | 文件和行号 | grep 命中 | 建议保留位置和清理动作 |
| --- | --- | --- | --- | --- |
| A | `isPlainObject` / `plainObject` / `object` / `plain` | `src/infra/config.js:349`；`src/infra/configPatch.js:42`；`src/services/messagePlugins.js:90`；`src/services/javascriptPlugins.js:16`；`src/memory/backup.js:14`；`custom/plugins/whale-ops/plugin.js:48` | `P '(?:\bfunction\s+(?:isPlainObject\|plainObject\|plain)\s*\(\|\bconst\s+object\s*=\s*value\s*=>)'` 命中 11 行，含安装或构建副本 5 行。表中列出实际纳入该组的实现。 | 宿主共用 `src/infra/configValues.js` 的纯判断，移除五处宿主定义。维持「非 null 对象且不是数组」的规则和现有对外导出。电脑助手插件保留自包含实现，等构建能随包带入共享代码再移除。 |
| A | `clamp` | `src/http/routes/yxn.js:10`；`src/memory/budgetPlan.js:91`；`src/memory/calibration.js:42`；`custom/plugins/yxn-bond/plugin.js:25` | `P '\bfunction\s+clamp\s*\('` 命中 7 行，含安装或构建副本 3 行。表中列出实际纳入该组的实现。 | 宿主实现收进 `src/infra/configValues.js`，移除三处宿主定义，插件内副本随单文件包保留。沿用 `Math.min(hi, Math.max(lo, value))` 的转换和边界顺序。 |
| A | `num` | `src/http/routes/yxn.js:11`；`custom/plugins/yxn-bond/plugin.js:26`；`custom/plugins/yxn-voice/plugin.js:20` | `P '\bfunction\s+num\s*\('` 命中 5 行，含安装或构建副本 1 行。表中列出实际纳入该组的实现。 | 先删除 yxn-voice 的未使用副本。宿主与 yxn-bond 各自保留现有实现，直到插件构建可内联同一份数值转换函数。转换空串、null 和非有限值的行为需一致。 |
| B | `bondTier` | `src/http/routes/yxn.js:24`；`custom/plugins/yxn-bond/plugin.js:113` | `P '\bfunction\s+bondTier\s*\('` 命中 3 行，含安装或构建副本 1 行。表中列出实际纳入该组的实现。 | 把阈值和文字以 `custom/plugins/yxn-bond` 的规则为准。宿主与插件发布版本能同步时，再从共享规则生成宿主副本并删除 `routes/yxn.js` 的手写版本。旧 `bond.json` 读取和单文件插件都需覆盖。 |
| B | `moodLabel` | `src/http/routes/yxn.js:13`；`custom/plugins/yxn-bond/plugin.js:102` | `P '\bfunction\s+moodLabel\s*\('` 命中 3 行，含安装或构建副本 1 行。表中列出实际纳入该组的实现。 | 以 `custom/plugins/yxn-bond` 的阈值规则为保留位置，宿主通过构建共享数据，届时移除 `routes/yxn.js` 的规则副本。保留插件传对象、路由传两个参数的适配。 |
| A | `clampNum` | `src/http/routes/yxn.js:77`；`src/memory/personCard.js:32` | `P '\bfunction\s+clampNum\s*\('` 命中 4 行，含安装或构建副本 2 行。表中列出实际纳入该组的实现。 | 在 `src/infra/configValues.js` 保留一个 `clampNum`，删除两处本地定义。保持有限数、默认值及小数行为。`src/core/text.js:49` 的 `clampInt` 仍保留整数截断。 |
| A | `p` / `pad` / `pad2` | `src/memory/backup.js:35`；`src/memory/episode.js:24、31`；`src/memory/personCard.js:213`；`src/services/digest.js:38`；`src/infra/time.js:88` | `P '(?:\bconst\s+(?:p\|pad)\s*=\s*\(n\)\s*=>\s*String\(n\)\.padStart\(2\|\bfunction\s+pad2\s*\()'` 命中 13 行，含安装或构建副本 6 行。表中列出实际纳入该组的实现。 | 复用 `src/infra/time.js:88` 的 `pad2`，删除其他内联补零；若与日期组同一批合并，日期函数内的补零只替换一次。 |
| B | `dateString` / 日报 `dayKey` | `src/memory/episode.js:22`；`src/memory/personCard.js:211`；`src/services/digest.js:39`；`src/infra/time.js:93` | `P '(?:\bfunction\s+(?:dateString\|dayKeyOf)\s*\(\|\bconst\s+dayKey\s*=\s*\(d\))'` 命中 8 行，含安装或构建副本 4 行。表中列出实际纳入该组的实现。 | 格式化收进 `src/infra/time.js`，用宿主本地年月日调用 `dayKeyOf`，边界对齐后删两份 `dateString` 和日报的 `dayKey` 本地定义。先验证本地跨日、非法时间戳及 `personCard.dateString` / digest 旧导出的行为。 |
| A | `clampText` / `clip` / `text` | `src/memory/extractor.js:19`；`src/memory/relations.js:87`；`src/memory/personCard.js:21` | `P '(?:\bfunction\s+clampText\s*\(\|\bfunction\s+clip\(value, max\)\|\bfunction\s+text\(value, max\s*=)'` 命中 7 行，含安装或构建副本 3 行。表中列出实际纳入该组的实现。 | 复用 `src/infra/text.js` 中拟新增的折叠空白函数，删除 extractor 和 relations 的重复定义。personCard 保留 `max = 200` 的薄调用或在调用点传相同缺省值。保持按 UTF‑16 截断的行为，使用独立入口保留同文件现有 `clean` 的 C0 清洗语义。 |
| A | `clamp01` | `src/memory/extractor.js:218`；`src/memory/relations.js:100` | `P '\bfunction\s+clamp01\s*\('` 命中 4 行，含安装或构建副本 2 行。表中列出实际纳入该组的实现。 | 保留位置 `src/infra/configValues.js`，可基于同组建议的 `clampNum` 提供 0–1 包装。删除两个记忆模块中的定义，保留非有限值的回退。 |
| A | `str` | `src/persona/presets.js:415`；`src/services/persona.js:27` | `P '\bconst\s+str\s*=\s*\(v,\s*max\)\s*=>\s*String'` 命中 4 行，含安装或构建副本 2 行。表中列出实际纳入该组的实现。 | 把「空值转空串、trim 后切长」放进 `src/infra/text.js`，删除两处内联箭头函数。各字段原有长度上限留在调用处。 |
| A | `effectiveDialogueBudget` / `dialogueBudget` | `src/persona/tokenCheck.js:19`；`src/services/budget.js:73`；`src/memory/budgetPlan.js:141` | `P '\bfunction\s+(?:effectiveDialogueBudget\|dialogueBudget\|planBudget)\s*\('` 命中 6 行，含安装或构建副本 3 行。表中列出实际纳入该组的实现。 | 把两份完全相同的配置取值逻辑放到 `src/memory/budgetPlan.js`，删前两处定义，保留 `services/budget` 的现有导出别名。保持分片入口 `planBudget` 自己的整数和默认处理。 |
| A | `cleanName` / `cleanDescription` / `tidy` | `src/persona/presets.js:258、262`；`src/services/location.js:51` | `P '\bfunction\s+(?:cleanName\|cleanDescription\|tidy)\s*\('` 命中 8 行，含安装或构建副本 4 行。表中列出实际纳入该组的实现。 | 把替换 CR/LF/TAB 后 trim 的公共步骤收进 `src/infra/text.js`。移除三个重复步骤；预设名称和简介各自仍按原限制截断，地名维持原来的不限长入口。 |

几组近似实现的输出契约不同。`src/memory/personCard.js:68` 的 `similarity` 用较长长度作分母，`src/memory/retrieval.js:32` 的 `overlap` 用较短长度。`src/memory/store.js:50` 的 `trimText` 仅移除 NUL 后裁剪，其他记忆文本助手会折叠空白。`src/core/trace.js:28` 按多个字段拼接后取 SHA-1 短摘要，`src/infra/privacy.js:12` 对单值取 SHA-256 短摘要。源码内 `xxhash|crc32` 命中为 `custom/plugins/whale-ops/plugin.js:635、649` 的一个 CRC32 定义及其调用。这些实现各有用途，保留。

## 交付自检

从 A 区选择三条未引用声明，分别重新执行下列全仓库命令。

| 文件和行号 | 命令 | 实际结果 |
| --- | --- | --- |
| `custom/plugins/whale-ops/plugin.js:31` | `S 'APP_NAME'` | 仅命中第 31 行定义。实际引用 0。 |
| `src/services/localReply.js:15` | `S 'AI_WORDS'` | 命中第 15 行定义、安装副本同一行和 `_p46.py`、`_p47.py`、`_p48.py` 的补丁文本。读取该绑定的代码 0。 |
| `src/services/localReply.js:17` | `S 'stripAiTone'` | 命中第 17 行定义、安装副本同一行和 `_p46.py`、`_p47.py` 的补丁文本。调用该函数的代码 0。 |

另用 Node 直接调用现有解码器，`&#39;`、`&#039;`、`&#x27;` 均解为单引号，`&amp;#39;` 只解一层。语法树检查未找到字面量 `if (false)`、固定返回常量的 getter 或语句块内跟在无条件终止语句后的语句。按注释块及连续注释行复核，也未定位到大段被注释的旧 JavaScript 实现。

