上游 Banan1cee/whale_girl 更新了 32 个提交（upstream/main 已 fetch 到本地，最新 6910513，tag 到 v4.1.7.1）。我们的 fork（C:\dev\whale-girl，dev 分支）是旧基线 + 大量自己的改动，直接 merge 会炸，所以**按补丁移植**，不要 `git merge`。

## 我们的自定义改动（必须保住，不能被覆盖）
- `src/services/momentsPhotos.js`、`weiboPosts.js`、`photo_clean.py`、`momentsPublisher.js`（photoPrimary、微博改写、去水印）
- `src/pipeline/chat.js` 的 `EMOJI_TONES`/`emojiTone`（表情按语气选）
- `src/services/care.js`/`careChat.js`（主动消息时段/节日/不重复）
- `src/persona/prompt.js` 的 `PRIVACY_RULE` 与非主人剔除「我们之间」
- `bridge/` 里我们加的 file_mixin.py / file_transport.py / emoticon*.py 与前台激活重试
- `launcher/Views/CodexLogPage.*`、`DebugPage.*`、`DebugProcess.cs`、`MainWindow` 的导航改动
- `custom/plugins/whale-ops`、`whale-memo`

## 要移植的上游修复（逐个 `git show <sha>` 看，理解后改到我们的文件里）
1. `4b4035a` 保留异常表情标记后的回复正文 —— `src/core/replyMarks.js`。**优先级最高**：很可能就是「发了表情正文丢了」的根因。
2. `fcb89af` 修正非主人魔咒与链接提示 —— `src/persona/prompt.js`、`src/pipeline/chat.js` 各一两行；注意我们这两个文件已经改过，要语义合并不要整体覆盖。
3. `34de5dd` 朋友圈前台误判与选图窗口间歇退出 —— `bridge/moments_publish.py`、新增 `bridge/moments_window.py`、`bridge/moments_worker.py`。我们没改过这三个文件，可以基本照搬，但要注意我们 `send_file` 用的前台激活函数在 `bridge/window_activation.py`，两边要复用同一套。
4. `2c3d02d` 等已绑定微信窗口进前台 —— `bridge/sticker_mixin.py`、`bridge/moments_window.py`；我们改过 sticker_mixin（加了 target_unavailable 重试），要合并而不是覆盖。
5. `82207c6` 限时读取已核对的图片预览 —— `bridge/image_ui_fallback.py`、`bridge/receiver_mixin.py`（接收图片卡住/超时相关）。

其余提交（launcher 更新源测速、插件市场布局、发布清单、refactor T01/T14 之类）先只做判断：哪些影响用户可见行为、和我们的功能有没有冲突，列个表给我，不要动。

## 硬性要求
- 每个移植的补丁都要能说出「为什么它对应我们遇到的哪个现象」；说不清就不要动。
- 移植完：`node --check` 所有改过的 js；`python -m py_compile` 所有改过的 py；跑 `tests/` 下相关测试（`app\runtime\node.exe tests\<file>.test.js`、`app\runtime\python\python.exe tests\<file>.py`），失败的要么修要么明确标注「上游测试依赖上游未移植的模块」。
- 跑一次 `python tests\privacy_scan.py`（如果存在）确认没引入隐私命中。
- 不要 commit、不要 push、不要 publish、不要重启鲸鲸、不要动 `app\` 下的运行时文件。
- 最后给我一张表：上游提交 → 移植到哪些文件 → 对应我们哪个现象 → 测试结果；以及「判断为不移植」的提交和理由。
