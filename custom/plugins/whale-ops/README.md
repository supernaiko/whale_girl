# 电脑助手（whale-ops）· 鲸鲸 Api 4 插件

让鲸鲸在微信里替你动电脑：列文件、读文本、找文件、开软件；复杂活交给 DSH 跑完回你。

默认全部关闭，只认主人 wxid、只在白名单目录里活动；开软件和跑 DSH 是写操作，必须回「确认」。

## 装

1. 鲸鲸版本 ≥ 4.1.2（`appCompatibility` 已声明 4.1.2 与 2.x 启动器两个时代）。
2. 打开鲸鲸 → 设置 → 插件 → 安装本地 ZIP，选 `dist/whale-ops-1.3.0.zip`。
3. 安装后在插件设置里粘贴下面这份配置（**至少改 owners 和 roots**，否则插件不响应任何人）：

```json
{
  "prefix": "",
  "owners": ["wxid_你的微信号"],
  "roots": ["C:\\Users\\1\\Documents", "D:\\工作"],
  "apps": {
    "记事本": "notepad.exe",
    "计算器": "calc.exe",
    "资源管理器": "explorer.exe"
  },
  "dsh": {
    "workspace": "C:\\Users\\1\\Documents\\deepseek-harness\\default-workspace",
    "addDirs": [],
    "apiKey": "sk-...",
    "permissionMode": "workspace-write",
    "timeoutSeconds": 110,
    "syncWaitSeconds": 60
  }
}
```

`prefix` 默认留空 = 自然语言触发（「打开记事本」「读一下 D:\a.md」都认）；填 `"助手"` 就退回只认前缀的老模式。

`dsh.apiKey` 可以不填，改在启动鲸鲸的环境里设 `DEEPSEEK_API_KEY`（DSH 无头只认环境变量，不走桌面登录态）。不填就只会报“DSH 没拿到模型凭据”。

## 用

在微信里对鲸鲸说（私聊；群聊要显式配 `allowedGroups`）：

| 说法 | 作用 |
| --- | --- |
| `看看 D:\报告` 或直接发 `D:\报告` | 列目录（最多 60 项） |
| `读一下 D:\报告\a.md` | 读文本，≤ 64KB，只限文本扩展名 |
| `找 合同` | 按文件名找，最多 3 层、25 个结果 |
| `打开 记事本` | 需回「确认」 |
| `让 DSH 把这份报告整理成月报 在 D:\报告` | 需回「确认」，跑完发回本聊天 |
| `状态` / `帮助` / `取消` | 状态、帮助、取消待确认 |

前缀是可选的：`prefix` 为空时按上面的自然说法识别，认不出的消息一律 pass，不抢鲸鲸自己的聊天；填了 `"助手"` 就只认 `助手 …` 开头。

## 安全边界

- **主人**：`owners` 为空 = 谁都不用；必须是完整 wxid。
- **目录**：所有路径先 `realpath`，再校验仍在 `roots` 内，`..` 穿越和符号链接都拦。
- **软件**：只认 `apps` 里的名字，不接受任意命令/路径；启动用 `spawn`，不经过 shell。
- **确认**：`打开`/`让 DSH` 先挂起，5 分钟内回「确认」才执行，回「取消」丢弃。
- **DSH**：以 `workspace-write` 权限跑在 `dsh.workspace`，`--approval-policy never`（否则会卡在审批），超时 `taskkill /t /f` 整棵进程树。
- **审计**：只记动作、路径、耗时到 `whale.paths.pluginData/audit.jsonl`，不记聊天正文。

## 限制（别踩）

- Api 4 单次 hook 上限 120 秒（`ExecutionTimeoutMs` 已设 120000）。DSH 任务配置上限 110 秒；超过就先回执、跑完再用 `whale.sendText` 发结果——**但宿主可能在 hook 返回后回收 worker，长任务不保证送达**。超过两分钟的重活请拆成几段，或直接用 `让 DSH` 里更小的任务。
- `让 DSH` 每次可带 `在 <目录>` 指定工作目录，仍受 `roots` 约束。
- 插件跑在鲸鲸进程里，权限就是你的用户权限；`roots`/`apps` 别配太宽。

## 开发

```powershell
# 逻辑测试（不需要鲸鲸在跑，假的 ctx 直接喂 plugin.js）
node tests/run-tests.js

# 打包
python scripts/build.py
```

`tests/run-tests.js` 覆盖：唤醒/不抢话、主人与群聊作用域、列目录、读文本、二进制拒绝、`..` 穿越拒绝、越界路径拒绝、找文件、确认与取消、DSH 前置校验、回复截断。

## 目录

```
whale-ops/
├── plugin.json          # Api 4 清单
├── plugin.js            # 全部逻辑（零依赖，只用 node: 内置）
├── tests/run-tests.js   # 22 条本地用例
├── scripts/build.py     # 打 zip
└── dist/whale-ops-1.0.0.zip
```

## 自然语言（1.3.0）

不用固定前缀，主人直接说人话就行，插件先用规则匹配，匹配不上再交给宿主模型规划一步操作：

- 「随便放个测试数据」→ 自己定，直接建
- 「随便了你做」→ 接上一句，继续执行（15 分钟内有效）
- 「在桌面建个 xlsx，随便写点数据」→ 本地生成真正的 .xlsx（自带最小 zip 写入，不依赖 DSH）
- 写操作（打开软件、让 DSH、删除、覆盖）仍会先回一句「确认」

其他改动：`readFile` 遇到目录自动列目录；盘符（`D:\`）或只有目录名时直接列，不再报「文件不存在」。
