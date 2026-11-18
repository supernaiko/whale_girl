# whale-memo 记忆管家

鲸鲸（whale_girl）的 Api 4 插件：每天晚上从你和鲸鲸的聊天里提炼长期记忆，先给草稿，你回「确认记忆」才并入人设。

## 行为

- 记录：主人在私聊里说的每句话写入插件数据目录的 `chat.jsonl`（保留最近 300 条）。
- 提炼：每天 21:00 后第一次 tick，把最近 120 条聊天交给 `whale.model`，提炼三类内容：
  - 事实（身份、生活、工作、喜好）
  - 约定（时间、暗号、边界）
  - 习惯（称呼、语气、用词）
- 草稿：写入 `draft.md` / `draft.json`，并通过 `sendText` 发到主人私聊。
- 落地：主人回「确认记忆」（或「记下来」「并入人设」「记忆确认」），插件把条目追加到 `data/persona.json` 的 `customPrompt` 末尾，段落标题 `【我们之间】`，去重，最多 1600 字。
- 备份：第一次并入前把原 `customPrompt` 存到插件数据目录 `persona.bak.json`。

## 触发词

| 你说 | 效果 |
| --- | --- |
| 整理记忆 / 现在整理 / 生成记忆 | 立刻整理一次并回草稿（不等 21 点） |
| 确认记忆 / 记下来 / 并入人设 | 把待确认草稿并入人设 |

## 设置（插件设置 JSON）

```json
{ "owners": ["wxid_..."], "hour": 21, "minLines": 10, "maxItems": 3, "sendToOwner": true }
```

- `owners`：允许记录的主人 wxid，留空则所有私聊都记录。
- `hour`：每天几点后允许自动整理。
- `minLines`：至少积累多少条才整理。

## 安装

```powershell
python scripts\build.py
python scripts\install.py "C:\Users\<你>\AppData\Local\Programs\WhaleGirl\data\plugins"
```

装完重启鲸鲸。

## 已知限制

- 只记录主人在私聊里发的话；鲸鲸自己的回复不记录（宿主没有把回复广播给插件的钩子）。
- 直接改 `persona.json` 可能在鲸鲸运行期间被内存里的配置覆盖；优先走 `/api/config` 的 `persona.customPrompt` 补丁（插件已这样做，失败才回退到写文件）。
- 记忆是「日志」，人设是「宪法」：本插件只往人设末尾追加【我们之间】段，不改原有性格与背景。
