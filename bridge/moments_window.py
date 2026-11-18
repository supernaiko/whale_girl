"""朋友圈和表情包共用的限时前台切换。"""
import time

from window_activation import unlock_foreground


def activate_verified_window(runtime, hwnd, pid, allowed, *, pause=time.sleep,
                             unlock=unlock_foreground, probe=lambda details: None):
    import win32gui as win
    import win32process as process

    attempts = 0

    def valid():
        return bool(win.IsWindow(hwnd) and process.GetWindowThreadProcessId(hwnd)[1] == pid)

    def ready():
        return (valid() and win.GetForegroundWindow() == hwnd
                and win.IsWindowVisible(hwnd) and not win.IsIconic(hwnd))

    try:
        # 单窗绑定等入口只记录 HWND，此处固定第一次核验到的进程。
        if not pid and win.IsWindow(hwnd):
            pid = process.GetWindowThreadProcessId(hwnd)[1]
        if not pid or not valid() or not allowed():
            return False
        # SetForegroundWindow 可能返回失败/抛异常，但窗口其实已经在前台。
        if ready():
            return True
        previous = win.GetForegroundWindow()
        for attempt in range(2):
            if not valid() or not allowed():
                return False
            if win.GetForegroundWindow() not in (0, previous, hwnd):
                return False
            if attempt:
                if not unlock():
                    return False
                pause(0.05)
                if not valid() or not allowed():
                    return False
                if win.GetForegroundWindow() not in (0, previous, hwnd):
                    return False
            attempts += 1
            try:
                runtime.force_foreground(hwnd)
            except Exception:
                pass
            # ShowWindowAsync 只表示恢复请求已投递，必须等实际前台状态。
            for tick in range(11):
                if not valid():
                    return False
                if ready():
                    # 等待期间只读窗口状态；即将操作时才重新核对远程任务闸。
                    return bool(allowed() and ready())
                foreground = win.GetForegroundWindow()
                if foreground and foreground not in (previous, hwnd):
                    return False
                if tick < 10:
                    pause(0.05)
        return False
    except Exception:
        return False
    finally:
        try:
            foreground = win.GetForegroundWindow()
            probe({'window': True, 'attempts': attempts, 'ready': ready(),
                   'sameProcess': bool(foreground and process.GetWindowThreadProcessId(foreground)[1] == pid),
                   'visible': bool(win.IsWindowVisible(hwnd)), 'iconic': bool(win.IsIconic(hwnd))})
        except Exception:
            pass
