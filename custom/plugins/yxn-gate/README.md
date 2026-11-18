# 接话判定 · yxn-gate

雅小奈的接话插件。通过鲸鲸 JavaScript API 4 的 `chat.pre_reply` 评估私聊和群聊消息。锁定版本范围为旧代 4.1.2 起、正式代 1.0.0 起。

## 本地安装

在此目录用 Node.js 18 或更新版本生成 ZIP。

```powershell
node install.js --pack
```

在鲸鲸「插件市场 → 从本地安装」选择生成的 `yxn-gate-0.1.0.zip`。打开「启用 JavaScript 插件（实验性）」总开关，再到插件卡片确认持续授权和 `system.full` 完整系统权限，启用「接话判定」。更新后在卡片重新启用。

开发目录也可以显式授权后直装。下列命令将安装并启用插件，写入仓库的 `app/data/plugins/`，沿用已有设置。启动器的实验总开关需单独打开。

```powershell
node install.js --enable-full-access
```

`system.full` 允许插件以当前 Windows 用户权限运行。开启模型复判后，处于复判区间的本轮消息和最多 10 条近期聊天会交给当前配置的模型。使用云端模型时，这些内容会发送给模型服务商，并可能产生费用。可在插件设置关闭复判。

## 设置

在「插件市场 → 已安装 → 接话判定 → 设置」编辑 JSON。可只填需要调整的字段。运行时按默认值、卡片设置、`yxn-gate.data/config.json` 的顺序逐字段覆盖，每轮都会重新读取本地文件。无效值沿用上一层，文件解析失败时会记日志。

```json
{
  "enabled": true,
  "private": { "base": 0.92, "min": 0.35, "max": 0.99 },
  "group": { "base": 0.30, "min": 0.05, "max": 0.85 },
  "keywords": ["小奈", "雅小奈", "奈奈"],
  "quietHours": { "start": "23:30", "end": "07:00" },
  "judge": { "enabled": true, "low": 0.25, "high": 0.65, "timeoutMs": 8000 },
  "silent": { "consecutiveNo": 3, "maxSilentMs": 600000, "wakeOnMessages": 8 }
}
```

| 设置 | 含义 |
| --- | --- |
| `enabled` | 设为 `false` 时交回宿主判断。 |
| `private`、`group` | 各自的起始概率、下限和上限，取值 `0` 到 `1`。 |
| `keywords` | 命中词语时给概率加分。固定称呼「小奈」「雅小奈」「奈奈」还会触发叫名字加分和解除静默。 |
| `quietHours` | 按运行机器的本地时钟，使用 `HH:mm`。起始时刻计入时段，结束时刻退出，设为同一时刻可关闭该项。 |
| `judge` | `enabled` 开启模型复判，`low` 和 `high` 为包含端点的区间。`timeoutMs` 可填 `1` 到 `18000`，单位为毫秒。 |
| `silent` | 连续跳过 `consecutiveNo` 次进入静默。静默期满 `maxSilentMs`、收到第 `wakeOnMessages` 条消息、被 @ 或被叫名字时，重新评估当前消息。三个字段均为正整数。 |

静默期间直接跳过，不运行概率链或模型。静默解除后，复判区间内以模型结果决定是否接话，`yes` 开头才接话，超时和异常均跳过。其余消息按最终概率 `p` 掷骰。回复冷却和密度的时间戳存于 `yxn-gate.data/state.json`，会话每次写入时最多保留其最近十分钟的 50 条回复判定时间戳。活跃度、连发和疲劳规则使用宿主提供的近期会话历史，宿主最多给 12 条记录。宿主缺少昵称或关系数据时，复判使用发言人编号和未知关系。

## 日志

在鲸鲸的数据目录打开 `plugins/yxn-gate.data/decisions.jsonl`。每行对应一轮判定或一条错误。旧文件轮转为 `decisions.jsonl.1`。开发时也可过滤控制台中的 `[yxn-gate]`。

```json
{"chatId":"demo-group","p":0.35,"action":"skip","reason":"judge_no","steps":["base","quiet_group","clamp"]}
```

- `p` 是裁剪后的概率。静默或设置关闭时为 `null`。
- `action` 为 `wake`、`skip` 或 `pass`，分别表示请求宿主接话、跳过和交回宿主。宿主仍执行自己的静默和限流。
- `reason` 中的 `silent` 表示静默跳过，`judge_no` 表示复判未通过。概率跳过时记录最大扣分步骤，无扣分时记录 `base`。模型失败的具体类型、代码和阶段在前一条错误记录中查看。
- `steps` 列出基线、命中的调整规则与最终裁剪，顺序与计算一致。日志只存会话 ID 和判定相关字段，分享前请遮盖会话 ID。

## 本地测试

```powershell
node --check plugin.js
node --test tests/run-tests.js
```
