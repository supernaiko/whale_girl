# 朋友圈自动发布调度改造报告

## 规则与默认值

- 自动发表按 `env.timezone` 判断作息和日期；留空使用系统时区。
- 活跃时段为 `[08:00, 23:30)`，23:30–08:00 不自动发表。
- 默认每天最多 2 条；两条自动发表之间至少 3 小时。
- 经已绑定账号的桥接轮询驱动；首次在线建立计时点，一小时后开始抽样。每次抽样以 0.25 概率尝试生成。抽样时间落盘，频繁轮询或重启不会在一小时内重抽；离线和连续三天以上未发均不补发。
- `moments.muteDate` 等于当天 `YYYY-MM-DD` 时跳过当天。
- 概率命中后仍须有当天有效聊天、日记摘要或事件卡；无素材记录 `no_material`，不调用模型。模型返回空字符串、空白、JSON null 或空 text，记录 `skip_no_text`，不重试、不入队、不占额度。
- 只有非空且通过既有过滤、去重的草稿才进入队列；生成完毕到领取期间跨入休息时间也会拦截。
- 每次轮询记一条 `[moments] tick eligible=... reason=...`，不记录正文。模型调试输出也只记录结果长度。
- 保留既有手动发表语义：不受自动额度约束、不占自动额度。未确认或丢失回执的自动发表保留额度和冷却；明确失败才回退。

## 配置与接口

可覆盖字段：`activeStart`、`activeEnd`、`maxPerDay`、`minGapHours`、`attemptProbability`、`muteDate`。默认分别为 `08:00`、`23:30`、`2`、`3`、`0.25`、空字符串。

兼容读取 `publishMaxPerDay`；新字段 `maxPerDay` 优先。保留旧版 `maxPerDay=0` 不限自动额度的语义。已有明确配置会覆盖新默认值，没有改写用户实际配置。

`intervalHours`、旧配置 `publishIntervalHours` 和接口旧字段 `interval` 继续兼容，缺失或非法时默认 6；这些字段不再控制自动发表周期。通过发表设置接口保存时同步新旧字段，避免旧客户端保存后失效。

`GET/POST /api/moments/publish-settings` 通过既有 settings/status 展开返回 `nextEligibleAt`、`todayCount`、`muteDate`，同时保留 `nextCheckAt`、`count` 等旧字段。`nextEligibleAt` 是最早可能尝试的 epoch 毫秒，不承诺届时发表；未启用、账号未绑定、状态异常或首次在线尚未建立计时点时为 null。

## 本次改动文件

- `src/services/momentsScheduler.js`：新增纯函数 `eligibleNow`、资格原因和最早时间计算、默认配置归一化。
- `src/services/momentsPublisher.js`：接入概率调度、持久冷却、tick 日志、当天素材入口、空输出跳过及领取前复核。
- `src/infra/config.js`、`src/infra/configSchema.js`：默认值与新字段校验。
- `src/services/configCommands.js`：发表设置新字段保存及兼容字段同步，在线/离线共用。
- `config/config.example.json`：配置示例与说明。
- `tests/moments.test.js`：保留原有 28 项场景，将固定六小时场景改为确定性小时抽样，新增 12 项场景。
- `tests/refactor-t03-config-values.test.js`：补充新旧间隔同步保存的预期。
- `docs/CHANGELOG.md`：在现有未发布的 4.2.0 条目补充改进记录；package 版本保持 4.2.0。
- `_report_moments.md`：本报告，按本次用户指定位置存放。

路由已有展开逻辑，不需要修改 `src/http/routes/moments.js`。未修改 `app/data/config.json`、运行包副本或启动器，也未启动实际桥接或发表真实朋友圈。

## 验证结果

- 修改前基线：`node --test tests/moments.test.js` 为 27/28；旧固定间隔场景受真实凌晨时间影响而失败。新增纯函数用例在实现前确认失败。
- `node --test tests/moments.test.js`：40/40 通过。覆盖凌晨、上限、两小时间隔、静音、正常十点、时段端点、跨日/时区、配置覆盖、概率边界、重启不重抽、多日空白、空素材、空模型输出、日记/事件卡、领取冷却及夜间领取复核。
- `node tests/refactor-t03-moments-caller.test.js`：5/5 通过。
- `node tests/launcher-offline-config.test.js`：4/4 通过。
- `node tests/refactor-t03-config-values.test.js`：30/30 通过。
- `node tests/config-schema.test.js`：11/11 通过。
- `node tests/time.test.js`：12/12 通过。
- `node scripts/check-layers.js`：通过，157 个文件无反向依赖。
- 本次相关文件的 `git diff --check`：通过。
- `node scripts/release-check.js`：版本、CHANGELOG、资源等检查通过；隐私检查被现有文件中的隐私项拦截。
- `node scripts/privacy-scan.js .`：未通过，5 处均位于本次未改动的运行包声卡文件、现有插件脚本、架构文档及备份状态文件；未擅自清理用户文件。

## 协作边界

在独立本地分支 `fix/moments-routine-scheduler` 工作，保留进入任务前已有未提交改动。开始与交付阶段核对 origin main（`c3b63a8`）及待合并 PR，交付前也读取 upstream main（`6910513`）；查询时两个仓库均无待合并 PR。没有提交、推送、开 PR 或发布安装包。

工作过程中检测到其他会话对同一个 `momentsPublisher.js` 并发加入人设/心情提示词和选图改动。已保留这些写入；本任务自身没有修改文案提示词与配图算法，报告中的调度范围不包含这些并发改动。验证使用临时目录、假素材、假模型和可注入时钟/随机数，没有调用真实朋友圈发布。
