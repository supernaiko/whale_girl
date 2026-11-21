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


def activate_target(hwnd):
    """发送路径恢复前台：先像人一样恢复窗口，再走上游的置顶+挂接前台线程激活。"""
    import time

    import win32gui

    if not hwnd or not win32gui.IsWindow(hwnd):
        return False
    try:
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
        elif not win32gui.IsWindowVisible(hwnd):
            win32gui.ShowWindowAsync(hwnd, 4)
            time.sleep(0.15)
        if win32gui.GetForegroundWindow() == hwnd:
            return True
        return _bring_to_front(hwnd)
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
