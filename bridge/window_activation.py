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


def activate_target(hwnd):
    """发送路径恢复前台：只做非阻塞激活，绝不合并输入队列（会卡死微信 UI 线程）。"""
    import time

    import win32gui

    if not hwnd or not win32gui.IsWindow(hwnd):
        return False
    try:
        if win32gui.IsIconic(hwnd):
            # 点任务栏按钮让微信自己恢复重绘，直接 SW_RESTORE 会白屏。
            try:
                from targeting import _restore_from_taskbar
            except Exception:
                return False
            if not _restore_from_taskbar():
                return False
            for _ in range(10):
                if not win32gui.IsIconic(hwnd):
                    break
                time.sleep(0.12)
        elif not win32gui.IsWindowVisible(hwnd):
            win32gui.ShowWindowAsync(hwnd, 4)
            time.sleep(0.15)
        if win32gui.GetForegroundWindow() == hwnd:
            return True
        for _ in range(2):
            try:
                unlock_foreground()
                win32gui.SetForegroundWindow(hwnd)
            except Exception:
                pass
            time.sleep(0.12)
            if win32gui.GetForegroundWindow() == hwnd:
                return True
    except Exception:
        return False
    return win32gui.GetForegroundWindow() == hwnd


def install():
    from wechatauto.guia import WeChatGUI
    from wechatauto.uia_driver import WeChatUIA

    def bring_to_front(self, keep_topmost=False):
        # 不能为抢焦点改全机前台锁，也不能把两个账号的输入线程绑在一起。
        return activate(self.main_hwnd)

    WeChatGUI.bring_to_front = bring_to_front
    WeChatUIA._force_foreground = staticmethod(activate)

    def activate_control(self, win):
        # 原来的 _activate 在失败后还会同步 ShowWindow/SetActive，不能再落回旧路径。
        return activate(win.NativeWindowHandle)

    WeChatUIA._activate = activate_control
