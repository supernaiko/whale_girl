# -*- coding: utf-8 -*-
"""不合并输入队列的窗口激活兼容层。"""


def unlock_foreground():
    import win32api

    # 正在按修饰键或鼠标时，合成 Alt 会干扰用户的操作。
    if any(win32api.GetAsyncKeyState(key) & 0x8000
           for key in (0x10, 0x11, 0x12, 0x5B, 0x5C, 0x01, 0x02)):
        return False
    try:
        win32api.keybd_event(0x12, 0, 0, 0)
    finally:
        win32api.keybd_event(0x12, 0, 2, 0)
    return True


def activate(hwnd, *, retry=False):
    import ctypes
    from ctypes import wintypes
    import win32gui

    if not hwnd or not win32gui.IsWindow(hwnd):
        return False
    # 同步恢复 + 合并输入队列会等待目标 GUI 线程；双开时会把另一个微信也拖住。
    user32 = ctypes.windll.user32
    show = user32.ShowWindowAsync
    show.argtypes = [wintypes.HWND, ctypes.c_int]
    show.restype = wintypes.BOOL
    if win32gui.IsIconic(hwnd):
        show(hwnd, 9)
    elif not win32gui.IsWindowVisible(hwnd):
        show(hwnd, 4)
    try:
        if retry:
            import time

            if unlock_foreground():
                time.sleep(0.04)
        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        return False
    return win32gui.GetForegroundWindow() == hwnd


def _steal_foreground(hwnd):
    """仅发送恢复时短暂绑定输入线程，退出前必须拆开。"""
    import win32api
    import win32gui
    import win32process

    attached = []
    current = win32api.GetCurrentThreadId()
    try:
        if not unlock_foreground():
            return False
        foreground = win32gui.GetForegroundWindow()
        threads = [win32process.GetWindowThreadProcessId(hwnd)[0]]
        if foreground:
            threads.append(win32process.GetWindowThreadProcessId(foreground)[0])
        for thread in dict.fromkeys(threads):
            if thread and thread != current:
                win32process.AttachThreadInput(current, thread, True)
                attached.append(thread)
        win32gui.SetForegroundWindow(hwnd)
    finally:
        for thread in reversed(attached):
            try:
                win32process.AttachThreadInput(current, thread, False)
            except Exception:
                # 一个窗口线程已经退出时，仍须尝试拆开其它绑定。
                pass
    return win32gui.GetForegroundWindow() == hwnd


def _bring_to_front(hwnd):
    """Upstream strategy: clear the foreground lock, topmost, attach, activate; then undo."""
    import ctypes
    import time

    import win32gui

    user32 = ctypes.windll.user32
    SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW = 0x2, 0x1, 0x40
    SPI_GETFOREGROUNDLOCKTIMEOUT, SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2000, 0x2001
    prev_lock = ctypes.c_uint32(0)
    got_lock = user32.SystemParametersInfoW(
        SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ctypes.byref(prev_lock), 0)
    user32.SystemParametersInfoW(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, ctypes.c_void_p(0), 0)
    try:
        for _ in range(3):
            if win32gui.GetForegroundWindow() == hwnd:
                break
            fg = win32gui.GetForegroundWindow()
            tid_fg = user32.GetWindowThreadProcessId(fg, None) if fg else 0
            tid_t = user32.GetWindowThreadProcessId(hwnd, None)
            attached = False
            if tid_fg and tid_fg != tid_t:
                try:
                    user32.AttachThreadInput(tid_fg, tid_t, True)
                    attached = True
                except Exception:
                    attached = False
            try:
                user32.SetWindowPos(hwnd, ctypes.c_void_p(-1), 0, 0, 0, 0,
                                    SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW)
                user32.SetForegroundWindow(hwnd)
                user32.SetActiveWindow(hwnd)
                user32.BringWindowToTop(hwnd)
            finally:
                if attached:
                    try:
                        user32.AttachThreadInput(tid_fg, tid_t, False)
                    except Exception:
                        pass
            time.sleep(0.25)
        user32.SetWindowPos(hwnd, ctypes.c_void_p(-2), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE)
    finally:
        if got_lock:
            user32.SystemParametersInfoW(
                SPI_SETFOREGROUNDLOCKTIMEOUT, 0, ctypes.c_void_p(prev_lock.value), 0)
    return win32gui.GetForegroundWindow() == hwnd


def _render_window_ready(hwnd, *, min_width=500):
    """微信渲染子窗口（MMUIRenderSubWindow）铺开到正常宽度才算就绪。

    窗口从最小化恢复后，Qt 渲染子窗口会先停留在极小尺寸（如 160）再异步
    铺开；此期间 UIA 树里没有消息列表，发送/图片兜底会卡住或失败。
    返回是否就绪。
    """
    import ctypes

    import win32gui

    if not hwnd or not win32gui.IsWindow(hwnd) or win32gui.IsIconic(hwnd):
        return False
    user32 = ctypes.windll.user32
    found = []

    def _cb(h, _):
        try:
            buf = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(h, buf, 256)
            if buf.value.startswith('MMUIRenderSubWindow'):
                rr = win32gui.GetWindowRect(h)
                w = rr[2] - rr[0]
                ht = rr[3] - rr[1]
                if w > 0 and ht > 0:
                    found.append((w * ht, w))
        except Exception:
            pass
        return True

    win32gui.EnumChildWindows(hwnd, _cb, None)
    if found:
        # 取面积最大的渲染子窗口
        return max(found, key=lambda t: t[0])[1] >= min_width
    # 找不到渲染子窗口：回退按主窗口尺寸判断
    rr = win32gui.GetWindowRect(hwnd)
    return (rr[2] - rr[0]) >= min_width


def wait_render_ready(hwnd, *, timeout=5.0, min_width=500):
    """恢复微信窗口后等待渲染子窗口铺开（UIA 消息列表可用的前兆）。"""
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        if _render_window_ready(hwnd, min_width=min_width):
            return True
        time.sleep(0.2)
    return _render_window_ready(hwnd, min_width=min_width)


def normalize_window(hwnd, *, width=1024, height=735):
    """把微信主窗统一成固定中等尺寸：不要最大化，也不要停在极小尺寸。

    实测（用户 2026-11-22）：窗口最大化时 Qt 侧栏比例/DPI 校准会漂，
    图片兜底截图和坐标点击错位→白屏；把窗口缩小后恢复正常。另一头，窗口刚从
    托盘恢复时会短暂停在 160×28，消息列表根本没渲染。两种极端都归一到固定尺寸。
    """
    import ctypes
    import time

    import win32gui

    if not hwnd or not win32gui.IsWindow(hwnd):
        return False
    try:
        if win32gui.IsZoomed(hwnd):
            win32gui.ShowWindow(hwnd, 9)  # SW_RESTORE
            time.sleep(0.15)
        rect = win32gui.GetWindowRect(hwnd)
        w, h = rect[2] - rect[0], rect[3] - rect[1]
        if w < 700 or h < 450:
            # SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE：只改大小，不动位置和焦点
            ctypes.windll.user32.SetWindowPos(hwnd, None, 0, 0, width, height, 0x0002 | 0x0004 | 0x0010)
            time.sleep(0.2)
        return True
    except Exception:
        return False


def activate_target(hwnd):
    """发送路径恢复前台：先像人一样恢复窗口，再走上游的置顶+挂接前台线程激活。"""
    import time

    import win32gui

    if not hwnd or not win32gui.IsWindow(hwnd):
        return False
    try:
        # 统一成固定中等尺寸：最大化会漂校准、极小是恢复中间态，两者都会让截图兜底失准。
        normalize_window(hwnd)
        if win32gui.IsIconic(hwnd):
            restored = False
            try:
                from targeting import _restore_from_taskbar
            except Exception:
                _restore_from_taskbar = None
            if _restore_from_taskbar:
                restored = bool(_restore_from_taskbar())
            if not restored:
                # 微信收到托盘后任务栏按钮可能不在 Shell_TrayWnd 里，直接 SW_RESTORE 兜底。
                win32gui.ShowWindowAsync(hwnd, 9)
            for _ in range(10):
                if not win32gui.IsIconic(hwnd):
                    break
                time.sleep(0.12)
            # 窗口已恢复，但 Qt 渲染子窗口还会异步铺开；等它就绪，否则 UIA 树空。
            wait_render_ready(hwnd)
        elif not win32gui.IsWindowVisible(hwnd):
            win32gui.ShowWindowAsync(hwnd, 4)
            time.sleep(0.15)
            wait_render_ready(hwnd)
        if win32gui.GetForegroundWindow() == hwnd:
            wait_render_ready(hwnd)
            return True
        if _bring_to_front(hwnd):
            wait_render_ready(hwnd)
        return win32gui.GetForegroundWindow() == hwnd
    except Exception:
        return False


def install():
    from wechatauto.guia import WeChatGUI
    from wechatauto.uia_driver import WeChatUIA

    # 上游 bring_to_front 自己会做 HWND_TOPMOST + AttachThreadInput + SetForegroundWindow，
    # 比我们之前的简化实现可靠；这里不再覆盖它，只兜住控件级 _activate 的旧同步路径。

    def activate_control(self, win):
        return activate(win.NativeWindowHandle)

    WeChatUIA._activate = activate_control
