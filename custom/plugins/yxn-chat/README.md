# 本地回话

`yxn-chat` 是适用于鲸鲸 4.1.2 起的 API 4 消息插件。它在宿主已经决定回复时，从本地素材池按话题、权重、语气匹配度和使用时间挑选句子，再等待阅读和打字延迟。插件需要在鲸鲸的实验总开关下单独确认 `system.full` 完整系统权限并启用。

本地安装 ZIP 的根目录放 `plugin.json` 和 `plugin.js`。在此目录下可用 PowerShell 打包，然后在插件市场选择「从本地安装」。

```powershell
Compress-Archive -LiteralPath .\plugin.json, .\plugin.js -DestinationPath .\yxn-chat-1.0.0.zip
```

## 切换模式

打开「插件市场 → 已安装 → 本地回话 → 设置」，保存配置 JSON。设置中提供的字段会同步到插件数据目录的 `config.json`，省略的字段沿用数据目录中的值。设置为 `{}` 时使用该文件中的配置。

```json
{
  "mode": "probabilistic",
  "probability": 0.25,
  "readDelay": { "min": 3, "max": 30 },
  "typingMsPerChar": 120,
  "maxDelaySec": 45,
  "minFreeRamMB": 1024,
  "bucketsOff": []
}
```

| 模式 | 行为 |
| --- | --- |
| `off` | 默认模式。停用本地回复，首次种子导入和定时维护仍可运行。 |
| `fallback` | 仅在 `chat.generate` 收到 `reason` 或 `error` 时尝试从对应话题取句。 |
| `probabilistic` | 问候、想念、晚安、夸奖、吃喝、无聊和吐槽按 `probability` 尝试本地回复。 |

`bucketsOff` 填要关闭的分桶名，可用 `greeting`、`miss`、`goodnight`、`praise`、`food`、`bored`、`complain` 和 `other`。遇到空桶、电脑操作、Codex/DSH、链接、可识别的语音请求，或同一阶段已有插件给出正文时，保留原有流程。阅读延迟使用秒，打字延迟按 Unicode 字符计毫秒。等待最多 45 秒，剩余预算不足时缩短到剩余时间的 80%。

当前宿主先运行 `chat.generate`，再调用 DeepSeek。它在该阶段没有提供 `reason`、`error` 或 `finalText`，因此当前宿主可直接使用概率模式和种子池。失败兜底和学习有对应的插件逻辑，需由宿主提供这些字段才能生效。收到 `finalText` 时，学习与模式独立执行。同一素材 24 小时内只入库一次。

## 本地数据与迁移

宿主把 `whale.paths.pluginData` 指向其数据目录下的 `plugins/yxn-chat.data`。

| 文件 | 内容 |
| --- | --- |
| `brain.json` | `schema: 1`，人设的 `sweet`、`sharp`、`talky`，各桶候选及权重、来源和使用记录。统计 `picked` 记录抽中并返回的素材，`sent` 记录插件返回的本地正文，`skipped` 记录进入模式判定但未返回正文的次数。 |
| `pool.jsonl` | 只追加的原始素材，每行记录 `at`、`bucket`、`text` 和 `source`。来源为 `seed`、`learned` 或 `manual`。维护从活动池移除条目后，原文仍在此文件。 |
| `config.json` | 当前模式、概率、延迟、内存告警阈值和停用桶。 |
| `local-model.json` | 预留 `enabled`、`cmd`、`modelPath`、`maxTokens`。目前调用入口固定回退到加权池。 |
| `activity.log` | 最近 100 行运行记录，包含导入计数和内存告警。 |

首次启动读取宿主的 `memory/chats/*.jsonl` 及 `memory/chats/*/messages.jsonl`，提取 4–30 字的助手短句。种子导入会排除链接、@ 提及和在记忆元数据中出现过的人名，每桶最多 40 条，总数上限 400。每小时维护一次活动池，14 天未用的条目当次权重乘以 0.95，再移除权重低于 0.05 的条目，每桶保留最多 150 条。

1. 停用源端和目标端插件，等当前调用退出。
2. 在目标端安装同 ID 插件，把源端的整个 `yxn-chat.data` 目录复制到目标数据目录下的 `plugins/`。目录里若有中断写入留下的临时提交文件，也一并保留。
3. 在目标端插件卡片确认设置。如果希望完整沿用迁入配置，保存 `{}`，然后确认权限并重新启用。迁入的 `brain.json` 会沿用原有素材和使用记录。

数据目录包含聊天素材正文。备份和迁移时按原聊天记录的隐私范围保管。

## 测试

```sh
node --test tests/chat.test.js
```
