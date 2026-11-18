"""微信内置表情的参数校验、粘贴与出站核对。"""

import re
import time

from sticker_transport import _input_title, _outgoing, alias_match, db_identity, watermark


def parse_request(body):
    if not isinstance(body, dict):
        raise ValueError('invalid_request')
    chat, code = body.get('chat'), body.get('code')
    if not isinstance(chat, str) or not 1 <= len(chat.strip()) <= 120 or re.search(r'[\x00-\x1f\x7f]', chat):
        raise ValueError('invalid_chat')
    if not isinstance(code, str):
        raise ValueError('invalid_code')
    code = code.strip()
    if code.startswith('[') and code.endswith(']'):
        code = code[1:-1]
    if not re.fullmatch(r'[A-Za-z0-9\u3400-\u9fff]{1,20}', code):
        raise ValueError('invalid_code')
    return chat.strip(), '[' + code + ']'


def outcome(status, reason=''):
    return {'ok': status == 'confirmed', 'status': status, 'reason': reason}


def matches_outgoing(db, messages, baseline, own_username, code):
    return [row for row in messages if int(row.get('sort_seq') or 0) > baseline
            and row.get('type') == '文本' and row.get('content') == code
            and _outgoing(db, row, own_username)]


def paste_code(control, code, check):
    import pywintypes
    import win32clipboard as clipboard

    saved = {}
    sequence = None
    try:
        clipboard.OpenClipboard()
        try:
            formats = []
            fmt = clipboard.EnumClipboardFormats(0)
            while fmt:
                formats.append(fmt)
                fmt = clipboard.EnumClipboardFormats(fmt)
            for fmt in formats:
                # Windows 能从 DIB 重新生成位图；原始 GDI 句柄不能当内存块复制。
                if fmt == clipboard.CF_BITMAP and {clipboard.CF_DIB, clipboard.CF_DIBV5}.intersection(formats):
                    continue
                try:
                    data = clipboard.GetGlobalMemory(clipboard.GetClipboardDataHandle(fmt))
                except pywintypes.error:
                    return 'clipboard_unavailable'
                if not data:
                    return 'clipboard_unavailable'
                saved[fmt] = data
            clipboard.EmptyClipboard()
            try:
                clipboard.SetClipboardText(code, clipboard.CF_UNICODETEXT)
            finally:
                sequence = clipboard.GetClipboardSequenceNumber()
        finally:
            clipboard.CloseClipboard()
            if sequence is not None:
                # Windows 可能在关闭剪贴板时才推进序列号。
                sequence = clipboard.GetClipboardSequenceNumber()
        if not check():
            return 'focus_unavailable'
        clipboard.OpenClipboard()
        try:
            if (clipboard.GetClipboardSequenceNumber() != sequence
                    or clipboard.GetClipboardData(clipboard.CF_UNICODETEXT) != code):
                return 'clipboard_unavailable'
        finally:
            clipboard.CloseClipboard()
        if clipboard.GetClipboardSequenceNumber() != sequence:
            return 'clipboard_unavailable'
        control.SendKeys('{Ctrl}v', waitTime=0.05)
        time.sleep(0.35)
        return ''
    finally:
        if sequence is not None and clipboard.GetClipboardSequenceNumber() == sequence:
            clipboard.OpenClipboard()
            try:
                if clipboard.GetClipboardSequenceNumber() == sequence:
                    clipboard.EmptyClipboard()
                    for fmt, data in saved.items():
                        clipboard.SetClipboardData(fmt, data)
            finally:
                clipboard.CloseClipboard()


def send_pasted_emoticon(uia, desktop, hwnd, aliases, db, chat, code, allowed, account_valid, log):
    from bg_sender import WeChatSender, _input_snapshot

    def composer():
        if (not desktop.foreground(hwnd) or int(uia.hwnd or 0) != hwnd
                or int(uia._win.NativeWindowHandle or 0) != hwnd
                or not alias_match(uia.current_chat(), aliases)):
            return None
        control = uia._chat_input()
        if (control is not None and control.ControlTypeName == 'EditControl'
                and 'chat_input_field' in control.AutomationId.split('.')
                and alias_match(_input_title(control.Name), aliases)):
            return control
        return None

    pasted = submitted = False
    try:
        identity = db_identity(db)
        baseline = watermark(db, chat)
        control = composer()
        if control is None:
            return outcome('failed', 'target_unavailable')
        value = desktop.value(control)
        if not isinstance(value, str) or value.strip():
            return outcome('failed', 'draft_not_empty')
        if not desktop.focused(control, hwnd):
            desktop.focus(control)
        if not allowed() or not account_valid():
            return outcome('failed', 'send_blocked')

        def check_empty():
            current = composer()
            return (current is not None and desktop.focused(current, hwnd)
                    and desktop.value(current) == value)

        if not check_empty():
            return outcome('failed', 'focus_unavailable')
        pasted = True
        paste_error = paste_code(control, code, check_empty)
        if paste_error:
            return outcome('failed', paste_error)
        input_after_paste = _input_snapshot()
        control = composer()
        if control is None or not desktop.focused(control, hwnd):
            return outcome('failed', 'draft_unverified')
        draft = desktop.value(control)
        if isinstance(draft, str) and draft.strip() == code:
            # 已确认这是刚粘进空框的普通文字，清掉它再返回错误。
            control.GetValuePattern().SetValue('')
            cleared = desktop.value(control)
            if not isinstance(cleared, str) or cleared.strip():
                return outcome('failed', 'draft_unverified')
            return outcome('failed', 'not_converted')
        if not isinstance(draft, str) or draft.strip() != '\ufffc':
            return outcome('failed', 'draft_unverified')

        # 发送按钮适用于配置了 Enter 或 Ctrl+Enter 的微信。明确核对按钮所在窗口。
        button = uia._win.ButtonControl(Name='发送')
        if not button.Exists(0.2) or not button.IsEnabled:
            return outcome('failed', 'draft_unverified')
        rect = button.BoundingRectangle
        if rect.right <= rect.left or rect.bottom <= rect.top:
            return outcome('failed', 'draft_unverified')
        if not allowed() or not account_valid() or db_identity(db) != identity:
            return outcome('failed', 'draft_unverified')
        control = composer()
        if (control is None or not desktop.focused(control, hwnd)
                or (desktop.value(control) or '').strip() != '\ufffc'
                or _input_snapshot() != input_after_paste):
            return outcome('failed', 'draft_unverified')
        submitted = True
        WeChatSender(hwnd).click_screen((rect.left + rect.right) // 2, (rect.top + rect.bottom) // 2)

        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and account_valid() and db_identity(db) == identity:
            matches = matches_outgoing(db, db.get_new_messages(chat, since_seq=baseline, limit=30),
                                       baseline, identity[1], code)
            if len(matches) == 1:
                return outcome('confirmed')
            if len(matches) > 1:
                break
            time.sleep(0.25)
        return outcome('unconfirmed', 'delivery_unverified')
    except Exception as exc:
        log('[emoticon] type=%s code=%s detail=%s' % (
            type(exc).__name__, getattr(exc, 'winerror', None) or '-',
            'confirm' if submitted else 'paste' if pasted else 'prepare'))
        if submitted:
            return outcome('unconfirmed', 'delivery_unverified')
        return outcome('failed', 'draft_unverified' if pasted else 'target_unavailable')
