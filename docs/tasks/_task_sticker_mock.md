# 任务：sticker_transport 6 个 mock 测试失败的对账修复

## 背景
鲸鲸（whale_girl）的测试套件里有 6 个 Python mock 测试失败，均为「sticker 发送」子系统的 mock 契约漂移，属于历史遗留（pre-existing）。你的任务是：**逐项判断是「测试期望过期」还是「真实回归」，只修该修的一边，绝不改动生产路径的运行行为（除非确实是真回归）**。

## 运行方式（先复现）
```powershell
cd C:\dev\whale-girl
$env:WHALE_TEST_PYTHON="C:\dev\whale-girl\app\runtime\python\python.exe"
& "C:\dev\whale-girl\app\runtime\node.exe" --test --test-name-pattern="sticker" tests/sticker-service.test.js
```
失败集中在 JS 测试 `tests/sticker-service.test.js:463`（它调起 `tests/test_sticker_transport.py`）。也可以直接跑 Python：
```powershell
cd C:\dev\whale-girl
& "C:\dev\whale-girl\app\runtime\python\python.exe" -B -m unittest discover -s tests -p test_sticker_transport.py
```

## 6 个失败测试（tests/test_sticker_transport.py 内）
1. `test_bridge_brings_wechat_forward_instead_of_refusing` (:701)
2. `test_bridge_opens_exact_target_then_verifies_title` (:758)
3. `test_bridge_initializes_missing_uia_cache_before_attachment` (:767)
4. `test_bridge_bind_failure_never_transports` (:784)
5. `test_bridge_watchdog_clears_on_transport_exception_without_retry` (:805)
6. `test_unconfirmed_transport_quarantines_canonical_target` (:832)

失败形式都是 `'failed' != 'confirmed'` 或 `'failed' != 'unconfirmed'`——即被测函数 `send_sticker(...)` 返回 `'failed'`，而测试期待 `'confirmed'`/`'unconfirmed'`。

## 关键线索
- 被测代码：`bridge/sticker_mixin.py` 的 `send_sticker`（一个 mixin 方法，会调用 `bridge/targeting.py` 的 `locate_and_activate`、`bridge/window_activation.py` 的 `activate_target`/`_steal_foreground`、`bridge/moments_window.py` 的 `activate_verified_window`，以及 `guarded_sticker_send`、`snapshot_win_state`/`restore_win_state`）。
- 疑似根因：commit `a371806` 移植上游 `moments_window.py` 并改了 sticker 前台等待逻辑之后，测试里的 mock env（`send_environment()` / `bridge_functions(...)`，见 test_sticker_transport.py 中后段）与当前 `send_sticker` 实现不再对得上——mock 少了某个函数/参数，或断言了已重命名/删除的调用。
- 测试用 `tests/bridge_ast.py` 的 `load_function` 抽取真实 `bridge/*.py` 的函数体、塞进 mock env 里执行；`bridge_functions(...)` 会把 `send_sticker` 及其依赖（`open_attachment_chat`、`attachment_account_valid` 等）注入 env。mock env 里缺失任何真实函数现在引用的符号都会导致 `send_sticker` 提前走 `failed` 分支。

## 判定规则（必须遵守）
- 如果失败是因为 **mock env 缺函数/参数、或断言了已不存在的调用** → 修测试（补 mock / 改断言），**不要改生产代码**。
- 如果失败是因为 **`send_sticker` 生产逻辑真的会把「本应成功」的发送判成失败**（例如新增了错误的 return 'failed' 分支、漏了 fallback）→ 修 `bridge/sticker_mixin.py` 或相关 bridge 文件。
- 判定时对照 `bridge/sticker_mixin.py` 的真实 `send_sticker` 控制流，逐行看 mock 里 `force_foreground` / `WindowsDesktop` / `win32gui` / `gui.use_window` / `gui._get_uia` / `guarded_sticker_send` / `snapshot_win_state` / `restore_win_state` / `account_send_allowed` / `send_lock` 等符号是否都被正确注入、被正确调用。

## 验收标准
- 上面 6 个测试全绿；`tests/sticker-service.test.js` 里其他 sticker 相关测试不回退（保持通过）。
- `python -m py_compile bridge/sticker_mixin.py bridge/targeting.py bridge/window_activation.py bridge/moments_window.py` 全部通过（若改了 bridge）。
- 提交信息写清楚「修测试」还是「修真回归」，并说明每个失败的根因一句话。

## 注意
- 只改必要文件，最小 diff。
- 不要 `git push`；改完提交到本地 dev 分支即可，结果报告给我。
- 环境代理：`HTTPS_PROXY=http://127.0.0.1:10808`（若 codex 需要联网）。
- 工作目录 `C:\dev\whale-girl`。
