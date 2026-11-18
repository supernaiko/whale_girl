目标：让 bridge 的发送在「微信窗口标题被改 / 会话名被改 / 窗口最小化或被别的窗口盖住 / 有弹窗」时能自我恢复，而不是直接失败。

仓库：C:\dev\whale-girl（Windows，Python 代码在 bridge\，Node 在 src\）。

现在的问题（真实日志）：
- `[send-file] target_unavailable detail=无法唯一定位目标会话或验证微信窗口`
- 发文本/表情也会偶发 `target_not_verified`、`window_not_found`
- 目前 `bridge\window_activation.py` 里已经有 `_steal_foreground`（Alt 键 + AttachThreadInput），但只在部分路径用；`bridge\receiver_mixin.py`、`sticker_mixin.py`、`file_mixin.py` 各自找窗口/会话，逻辑重复且失败就放弃。

要做的事：
1. 抽一个统一的「定位并激活会话」函数（放 `bridge\window_activation.py` 或新文件 `bridge\targeting.py`），被 send_text / send_sticker / send_file 共用：
   - 枚举顶层窗口找微信主窗（标题变化、带「微信」字样、类名 WeChatMainWndForPC 都算）
   - 激活：ShowWindow(SW_RESTORE) → 若前台不是它，用 Alt 键 + AttachThreadInput 抢前台 → SetForegroundWindow → 校验 GetForegroundWindow
   - 会话定位：先试搜索框（Ctrl+F）输入会话名，再点结果；失败时尝试「会话列表里按名字找 + 双击」；再失败尝试「最近会话里标题匹配」
   - 每次失败重试最多 3 轮，轮间隔 0.4s，每轮重新取窗口句柄；三步都失败才抛 `target_unavailable`
2. 保持现有对外接口不变：`send_text(chat, text)`、`send_sticker`、`send_file` 的签名和异常码不要改（上层 `src\services\fileSendQueue.js` 依赖 target_unavailable / target_not_verified）。
3. 加日志：每轮记录 `[target] round=N hwnd=... focus=... step=search|list|recent ok/fail`，写进现有 bridge 日志。
4. 测试：`bridge\` 下若已有 pytest，就加 `tests\test_targeting.py`，用 monkeypatch 假 Win32 调用测「前两轮失败第三轮成功」「三轮失败抛 target_unavailable」；没有 pytest 就用纯 python unittest 跑得起来。不要真的去操作微信。

约束：
- 只改 bridge\ 下代码和新增测试；不动 src\ 的 JS。
- 不要发任何真实微信消息；不要改用户数据。
- 完成后跑一遍 `python -m py_compile` 所有改动文件，并说明改动清单与测试结果。
- 最后写一份 `C:\dev\whale-girl\_report_targeting.md`：改了什么、为什么、怎么验证、已知限制。
