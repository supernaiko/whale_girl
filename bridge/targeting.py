"""发送前统一恢复窗口和会话；不粘贴附件、不输入正文、不按发送键。"""
import time
import re

from sticker_transport import file_alias_match
from window_activation import activate_target


class TargetUnavailable(RuntimeError):
    code = 'target_unavailable'

    def __init__(self):
        super().__init__(self.code)


def main_window_candidates(pinned=0):
    import win32gui
    import win32process

    found = []

    def visit(hwnd, _):
        try:
            cls = (win32gui.GetClassName(hwnd) or '').casefold()
            title = (win32gui.GetWindowText(hwnd) or '').casefold()
            native = cls in {'wechatmainwndforpc', 'mmui::mainwindow'}
            qt = 'qwindowicon' in cls
            named = '微信' in title or 'wechat' in title or 'weixin' in title
            # 标题只提供候选；主循环仍须核对已验证账号的句柄和 PID。
            if 'login' in cls or not (native or named or qt and hwnd == pinned):
                return True
            rect = (win32gui.GetWindowPlacement(hwnd)[4] if win32gui.IsIconic(hwnd)
                    else win32gui.GetWindowRect(hwnd))
            if rect[2] - rect[0] >= 250 and rect[3] - rect[1] >= 250:
                found.append((int(hwnd), int(win32process.GetWindowThreadProcessId(hwnd)[1])))
        except Exception:
            pass
        return True

    win32gui.EnumWindows(visit, None)
    return found


def _hotkey(hwnd, key, control=False):
    import win32api
    import win32gui

    if win32gui.GetForegroundWindow() != hwnd:
        return False
    try:
        if control:
            win32api.keybd_event(0x11, 0, 0, 0)
        try:
            win32api.keybd_event(key, 0, 0, 0)
        finally:
            win32api.keybd_event(key, 0, 2, 0)
    finally:
        if control:
            win32api.keybd_event(0x11, 0, 2, 0)
    return True


def _restore_from_taskbar(name_hint="Weixin.exe"):
    """Click the WeChat taskbar button, the same way a user would, so Qt repaints properly."""
    try:
        import uiautomation as auto

        auto.SetGlobalSearchTimeout(0.8)
        task = auto.PaneControl(searchDepth=1, ClassName="Shell_TrayWnd")
        if not task.Exists(0.3):
            return False

        def walk(root, depth=0):
            if depth > 8:
                return
            try:
                children = root.GetChildren()
            except Exception:
                return
            for child in children:
                yield child
                for sub in walk(child, depth + 1):
                    yield sub

        for ctrl in walk(task):
            try:
                if ctrl.ControlTypeName != "ButtonControl":
                    continue
                ident = (ctrl.AutomationId or "") + " " + (ctrl.Name or "")
                if name_hint.lower() in ident.lower() or "微信" in ident:
                    ctrl.Click()
                    return True
            except Exception:
                continue
    except Exception:
        return False
    return False


def _last_active_popup(hwnd):
    """pywin32 不是每个版本都有 GetLastActivePopup，走 user32 兜底。"""
    try:
        import ctypes
        return int(ctypes.windll.user32.GetLastActivePopup(int(hwnd)))
    except Exception:
        return int(hwnd)


def _dismiss_popup(hwnd):
    import win32gui
    import win32process

    popup = _last_active_popup(hwnd)
    if not popup or popup == hwnd or not win32gui.IsWindowVisible(popup):
        return
    if win32process.GetWindowThreadProcessId(popup)[1] != win32process.GetWindowThreadProcessId(hwnd)[1]:
        return
    # 只取消属于该主窗的弹层，不确认对话框，也不关闭其它应用。
    if win32gui.GetAncestor(popup, 3) == hwnd and win32gui.GetForegroundWindow() == popup:
        _hotkey(popup, 0x1B)
        time.sleep(0.1)


def _verified(uia, aliases, ready):
    return ready() and file_alias_match(uia.current_chat(), aliases)


def _search(uia, hwnd, names, aliases, ready):
    if _verified(uia, aliases, ready):
        return True
    if not ready():
        return False
    uia.back_to_chat_tab()
    for name in names:
        if not ready() or not _hotkey(hwnd, ord('F'), control=True):
            return False
        time.sleep(0.1)
        box = uia._search_box(uia._win, expand=True)
        # 只给已找到的搜索控件 SetValue；不向不确定的焦点粘贴搜索词。
        if box is None or not ready() or not uia._set_text(box, name):
            continue
        time.sleep(0.2)
        results = uia._collect_results(name, settle=0.4)
        exact = [row for row in results if file_alias_match(row.get('name'), aliases)]
        if len(exact) != 1 or not ready():
            continue
        uia._click_ctrl(exact[0]['cell'])
        time.sleep(0.2)
        if _verified(uia, aliases, ready):
            return True
    return False


def _open_chat_any(uia, hwnd, names, aliases, ready):
    """用 wechatauto 的 open_chat（搜索+点开+核对）逐个试，兼容没有 _session_rows_of 的版本。"""
    for name in names:
        if not ready():
            return False
        try:
            ok = uia.open_chat(name)
        except Exception:
            ok = False
        if ok and _verified(uia, aliases, ready):
            return True
    return False


def _list(uia, hwnd, names, aliases, ready):
    return _open_chat_any(uia, hwnd, names, aliases, ready)


def _recent(uia, hwnd, names, aliases, ready):
    return _open_chat_any(uia, hwnd, names, aliases, ready)


def locate_and_activate(runtime, shown, aliases, *, gate, account_valid=None,
                        refresh_aliases=None, log=None):
    """把窗口拉到前台，切到目标会话并核对。与上游 sticker 通道同策略，不再自定义三轮导航。"""
    import win32gui

    hwnd = int(runtime.ACCOUNT.get('hwnd') or 0) or runtime.find_weixin_hwnd()
    if not hwnd:
        raise TargetUnavailable()
    for round_no in (1, 2, 3):
        if not gate():
            raise TargetUnavailable()
        # 1) 前台
        if win32gui.GetForegroundWindow() != hwnd:
            if not activate_target(hwnd):
                _dismiss_popup(hwnd)
                if not activate_target(hwnd):
                    raise TargetUnavailable()
            for _ in range(12):
                if win32gui.IsWindowVisible(hwnd) and not win32gui.IsIconic(hwnd):
                    break
                time.sleep(0.15)
        _dismiss_popup(hwnd)
        if account_valid is not None and not account_valid(hwnd):
            raise TargetUnavailable()
        gui = runtime.gui
        if gui is None or not gui.use_window(hwnd):
            raise TargetUnavailable()
        uia = gui._get_uia(refresh=round_no > 1)
        if uia is None:
            raise TargetUnavailable()
        current_aliases = set(refresh_aliases() if refresh_aliases else aliases)
        cur = None
        try:
            cur = uia.current_chat()
        except Exception:
            cur = None
        if cur and file_alias_match(cur, current_aliases):
            runtime.UIA_CACHE['u'] = uia
            return hwnd, uia
        # 2) 打开会话（wechatauto 内建搜索+点开+回读，兼容没有 _session_rows_of 的版本）
        keys = [name for name in dict.fromkeys([shown, *sorted(current_aliases)]) if name]
        opened = False
        try:
            opened = bool(uia.open_chat(keys))
        except Exception:
            opened = False
        if not opened:
            for name in keys:
                try:
                    if uia.open_chat(name):
                        opened = True
                        break
                except Exception:
                    continue
        if opened:
            try:
                now_cur = uia.current_chat()
            except Exception:
                now_cur = None
            if now_cur and file_alias_match(now_cur, current_aliases):
                runtime.UIA_CACHE['u'] = uia
                return hwnd, uia
        if log:
            log('[target] round=%d opened=%s cur=%r' % (round_no, opened, cur))
        time.sleep(0.3)
    raise TargetUnavailable()
