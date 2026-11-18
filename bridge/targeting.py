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


def _dismiss_popup(hwnd):
    import win32gui
    import win32process

    popup = win32gui.GetLastActivePopup(hwnd)
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


def _list(uia, hwnd, names, aliases, ready):
    if not ready():
        return False
    _hotkey(hwnd, 0x1B)
    uia.back_to_chat_tab()
    rows = uia._session_rows_of(uia._win)
    exact = [(name, control) for name, control in rows if file_alias_match(name, aliases)]
    if len(exact) != 1 or not ready():
        return False
    control = exact[0][1]
    # 使用驱动的点击原语以保留 MMUI 渲染层穿透兼容。
    uia._click_ctrl(control)
    time.sleep(0.08)
    if not ready():
        return False
    uia._click_ctrl(control)
    time.sleep(0.2)
    return _verified(uia, aliases, ready)


def _recent(uia, hwnd, names, aliases, ready):
    if _verified(uia, aliases, ready):
        return True
    if not ready():
        return False
    # 搜索/切页可能替换整棵树，重新锚定主窗后再读最近会话，不能复用旧 COM 控件。
    root = uia._anchor(hwnd)
    if root is None or int(root.NativeWindowHandle) != hwnd:
        return False
    uia._win = root
    rows = uia._session_rows_of(root)[:12]
    exact = [(name, control) for name, control in rows if file_alias_match(name, aliases)]
    if len(exact) != 1 or not ready():
        return False
    uia._click_ctrl(exact[0][1])
    time.sleep(0.2)
    return _verified(uia, aliases, ready)


def locate_and_activate(runtime, shown, aliases, *, gate, account_valid=None,
                        refresh_aliases=None, log=None):
    """调用方持有发送锁和 GUI 锁；最多三轮，返回 (hwnd, uia)。

    每轮通过原账号闸重新认窗；枚举结果只能选已验证账号的句柄，绝不按标题猜账号。
    重试只覆盖导航，发送及可能残留草稿后的处理仍由原发送事务负责。
    """
    import win32gui
    import win32process

    steps = (('search', _search), ('list', _list), ('recent', _recent))
    for round_no in range(1, 4):
        hwnd, focus, reason, detail = 0, 0, 'TargetUnavailable', 'not_ready'
        reported = False
        try:
            if not gate():
                raise TargetUnavailable()
            account = runtime.ACCOUNT
            hwnd = int(account.get('hwnd') or 0)
            detail = 'window_not_found'
            candidates = main_window_candidates(hwnd)
            pid = int(account.get('pid') or 0)
            if not account.get('verified') or not any(
                    h == hwnd and (not pid or p == pid) for h, p in candidates):
                raise TargetUnavailable()

            def valid_account():
                return (bool(runtime.ACCOUNT.get('verified'))
                        and int(runtime.ACCOUNT.get('hwnd') or 0) == hwnd
                        and (not pid or win32process.GetWindowThreadProcessId(hwnd)[1] == pid)
                        and (account_valid is None or account_valid(hwnd)))

            if not valid_account():
                raise TargetUnavailable()
            detail = 'foreground_unavailable'
            _dismiss_popup(hwnd)
            activated = activate_target(hwnd)
            focus = win32gui.GetForegroundWindow()
            if focus != hwnd:
                # 恢复主窗后 Windows 可能先把其模态窗带到前台，此时才能取消它。
                _dismiss_popup(hwnd)
                activated = activate_target(hwnd)
                focus = win32gui.GetForegroundWindow()
            if not activated or focus != hwnd or not gate() or not valid_account():
                raise TargetUnavailable()
            # 搜索浮层和菜单可能共用主窗句柄，Esc 只取消浮层，不确认任何操作。
            _hotkey(hwnd, 0x1B)
            gui = runtime.gui
            detail = 'uia_unavailable'
            if gui is None or not gui.use_window(hwnd) or int(gui.main_hwnd) != hwnd:
                raise TargetUnavailable()
            uia = gui._get_uia(refresh=round_no > 1)
            if (uia is None or int(getattr(uia, 'hwnd', 0) or 0) not in (0, hwnd)
                    or int(getattr(getattr(uia, '_win', None), 'NativeWindowHandle', 0) or 0) != hwnd):
                raise TargetUnavailable()
            current_aliases = set(refresh_aliases() if refresh_aliases else aliases)
            names = [name for name in dict.fromkeys([shown, *sorted(current_aliases)])
                     if name in current_aliases and name and not re.fullmatch(
                         r'(?:wxid_[A-Za-z0-9_-]+|[A-Za-z0-9_-]+@chatroom)', name, re.I)]

            def ready():
                return (gate() and valid_account() and int(gui.main_hwnd) == hwnd
                        and win32gui.GetForegroundWindow() == hwnd)

            for step, navigate in steps:
                reason = 'not_verified'
                try:
                    ok = navigate(uia, hwnd, names, current_aliases, ready)
                    ok = bool(ok and _verified(uia, current_aliases, ready))
                except Exception as exc:
                    ok, reason = False, type(exc).__name__
                focus = win32gui.GetForegroundWindow()
                if log:
                    log('[target] round=%d hwnd=%d focus=%d step=%s %s type=%s'
                        ' code=%s status=0 detail=%s'
                        % (round_no, hwnd, focus, step, 'ok' if ok else 'fail', reason if not ok else 'none',
                           'target_not_verified' if not ok else 'none', 'title_or_navigation' if not ok else 'verified'))
                reported = True
                if ok:
                    return hwnd, uia
        except Exception as exc:
            reason = type(exc).__name__
            try:
                focus = win32gui.GetForegroundWindow()
            except Exception:
                pass
        if not reported and log:
            for step, _ in steps:
                log('[target] round=%d hwnd=%d focus=%d step=%s fail type=%s'
                    ' code=target_unavailable status=0 detail=%s'
                    % (round_no, hwnd, focus, step, reason, detail))
        if round_no < 3:
            time.sleep(0.4)
    raise TargetUnavailable()
