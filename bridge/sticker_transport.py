"""Fail-closed, one-shot sticker transport. Importing this module does no UI work.

There is deliberately no navigation, visibility/foreground manipulation, OCR,
retry, or dependency on WeChatGUI.send_image. The operator must already have
opened the unique target in the pinned foreground main window. The transport
may focus its verified empty input once. Missing UIA evidence means no Enter.
"""
import hashlib
import json
import os
import re
import stat
import time
import unicodedata

MAX_BYTES = 64 * 1024 * 1024
IMAGE_TYPES = {'.gif': 'GIF', '.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.webp': 'WEBP'}
MEDIA_TYPES = {'图片', '表情', '动画表情'}

FILE_TYPES = {'文件', '文件/链接/卡片', '链接/卡片'}


def _file_marker(path):
    """算出「怎么证明刚发出去的就是这张图」的指纹。"""
    try:
        with open(path, 'rb') as handle:
            digest = hashlib.md5(handle.read()).hexdigest()
        return {'md5': digest, 'name': os.path.basename(path)}
    except Exception:
        return None


def _message_matches(message, marker, exact=False):
    """Only structured attachment evidence can strongly identify an upload.

    A normal text reply such as '找不到a.gif' is NOT delivery confirmation.
    """
    kind = message.get('type')
    if kind not in MEDIA_TYPES | FILE_TYPES or not isinstance(marker, dict):
        return False
    try:
        import xml.etree.ElementTree as ET
        content = str(message.get('content') or '')
        sender = str(message.get('sender_username') or '')
        if exact and sender and content.startswith(sender + ':\n'):
            content = content[len(sender) + 2:]
        tree = ET.fromstring(content)
    except Exception:
        return False
    wanted_md5 = str(marker.get('md5') or '').lower()
    wanted_name = str(marker.get('name') or '')
    if exact:
        # Wx 数据库把文件和网页、引用放在同一类，文件卡片具体是 appmsg 类型 6。
        app = tree.find('appmsg')
        return bool(kind in FILE_TYPES and wanted_name and app is not None
                    and app.findtext('type', '').strip() == '6'
                    and app.findtext('title', '') == wanted_name)
    for node in tree.iter():
        tag = str(node.tag).lower()
        for attr, value in node.attrib.items():
            if wanted_md5 and 'md5' in attr.lower() and str(value).lower() == wanted_md5:
                return True
        if wanted_md5 and 'md5' in tag and str(node.text or '').strip().lower() == wanted_md5:
            return True
        if (kind in FILE_TYPES and wanted_name and tag in {'title', 'filename', 'file_name'}
                and str(node.text or '').strip() == wanted_name):
            return True
    return False


def result(status, error='', draft_may_remain=False, draft_observed=False):
    if status not in {'confirmed', 'unconfirmed', 'failed', 'cancelled'}:
        status = 'failed'
    outcome = {'status': status, 'error': str(error)}
    if draft_may_remain:
        outcome['draft_may_remain'] = True
    if draft_observed:
        outcome['draft_observed'] = True
    return outcome


def is_on(value):
    return value is True or (isinstance(value, (str, int, float))
                            and str(value).strip().lower() in {'1', 'true', 'yes', 'on', '开'})


def read_enabled_config(config_path):
    """Only this config read is permitted while the local master switch is off."""
    try:
        with open(config_path, encoding='utf-8-sig') as stream:
            cfg = json.load(stream)
        return cfg if isinstance(cfg, dict) and is_on((cfg.get('features') or {}).get('stickers')) else None
    except Exception:
        return None


class StickerImageError(ValueError):
    """A file rejection safe to display without revealing its path."""


def _verify_image(path, expected):
    from PIL import Image
    try:
        with Image.open(path) as image:
            if image.format != expected:
                raise StickerImageError('图片内容与扩展名不匹配。请用图片工具另存为 PNG 或 GIF，再放回分类文件夹。')
            if image.width * image.height > 16000000:
                raise StickerImageError('图片像素过多，请缩小尺寸后再试。')
            image.verify()
    except Image.DecompressionBombError as exc:
        raise StickerImageError('图片像素过多，请缩小尺寸后再试。') from exc
    except (OSError, SyntaxError) as exc:
        raise StickerImageError('无法读取图片内容，请重新导出图片后再试。') from exc


def validate_path(path, root, image_check=None):
    """Reject escapes, reparse points/symlinks, nonimages and changed files.

    Returns a fingerprint for revalidation before paste. Paths/errors are never
    echoed to the result (a job can originate in an untrusted webhook response).

    注意：不能要求「abspath 必须等于 realpath」。Windows 的 8.3 短名
    （用户名那种短名目录）和 junction 都会让两者不同，而它们本身不是链接；
    以前按这个相等性判断，导致 TEMP 带短名的机器上一张表情包也发不出去。
    链接/重解析点改由下面的 lstat 逐级检查负责。
    """
    root = os.path.abspath(os.fspath(root))
    candidate = os.path.abspath(os.fspath(path))
    real_root, real_file = os.path.realpath(root), os.path.realpath(candidate)
    try:
        inside = os.path.commonpath([real_root, real_file]) == real_root
    except ValueError:                     # 不同盘符：commonpath 直接抛
        inside = False
    if not inside or real_file == real_root:
        raise ValueError('sticker path is outside the approved directory or uses a link')
    for start in {candidate, real_file}:
        cursor = start
        while True:
            info = os.lstat(cursor)
            if (stat.S_ISLNK(info.st_mode)
                    or getattr(info, 'st_file_attributes', 0) & 0x400):
                raise ValueError('sticker links/reparse points are not allowed')
            parent = os.path.dirname(cursor)
            if parent == cursor:
                break
            cursor = parent
    info = os.stat(real_file)
    extension = os.path.splitext(real_file)[1].lower()
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_BYTES or extension not in IMAGE_TYPES:
        raise ValueError('sticker must be an approved image of at most 64 MiB')
    (image_check or _verify_image)(real_file, IMAGE_TYPES[extension])
    with open(real_file, 'rb') as stream:
        digest = hashlib.sha256(stream.read(MAX_BYTES + 1)).hexdigest()
    after = os.stat(real_file)
    if (info.st_size, info.st_mtime_ns, info.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise ValueError('sticker changed while validating')
    return real_file, (after.st_size, after.st_mtime_ns, after.st_ino, digest)


def _contacts(db, key):
    rows = db.search_contact(key)
    # Runtime search_contact has LIMIT 50. A truncated result cannot prove uniqueness.
    if not isinstance(rows, list) or len(rows) >= 50:
        raise ValueError('contact search is unavailable or truncated')
    return [row for row in rows if isinstance(row, dict)]


def _input_title(raw):
    # The runtime appends this known accessibility hint, not a recipient name.
    # No substring/partial matching or unread-count stripping is permitted.
    return re.sub(r'(?:(?:长按|按住)鼠标\s*)?语音输入(?:文字)?$', '', str(raw or '').strip()).strip()


def resolve_target(db, shown, username=''):
    """Resolve an exact canonical username and unambiguous exact title aliases.

    No first search hit, substring, group-member alias or cached open-chat name.
    Every admitted alias is checked for collisions across exact contact hits.
    """
    key = str(username or shown or '').strip()
    if not key:
        raise ValueError('target is empty')
    hits = _contacts(db, key)
    exact = [row for row in hits if key in {str(row.get(k) or '').strip()
                                           for k in ('username', 'nick_name', 'remark')}]
    ids = {str(row.get('username') or '').strip() for row in exact}
    ids.discard('')
    filehelper = key in {'filehelper', '文件传输助手'}
    if filehelper:
        if ids - {'filehelper'}:
            raise ValueError('target name is ambiguous')
        canonical = 'filehelper'
        aliases = {'filehelper', '文件传输助手'}
    else:
        if len(ids) != 1:
            raise ValueError('target cannot be resolved uniquely')
        canonical = next(iter(ids))
        if username and canonical != str(username).strip():
            raise ValueError('canonical target does not match requested username')
        row = next(row for row in exact if row.get('username') == canonical)
        aliases = {canonical, str(row.get('nick_name') or '').strip(), str(row.get('remark') or '').strip()}
        aliases.discard('')
    safe = set()
    for alias in aliases:
        others = _contacts(db, alias)
        matched = {str(row.get('username') or '').strip() for row in others
                   if alias in {candidate for k in ('username', 'nick_name', 'remark')
                                for candidate in (str(row.get(k) or '').strip(), _input_title(row.get(k)))}}
        if matched - {canonical}:
            continue
        safe.add(alias)
    if not safe:
        raise ValueError('all target aliases are ambiguous')
    return canonical, frozenset(safe)


class FileTargetError(ValueError):
    pass


def _file_title(raw):
    value = re.sub(r'[\u3000\uff01-\uffdc\uffe0-\uffee]+',
                   lambda match: unicodedata.normalize('NFKC', match[0]), str(raw or ''))
    value = unicodedata.normalize('NFC', value).strip()
    bare = re.sub(r'^微信[\s:·|–—-]*|[\s:·|–—-]*微信$', '', value).strip()
    return bare or value


def file_alias_match(current, aliases):
    title = _file_title(current)
    return bool(title) and any(title == _file_title(alias) for alias in aliases)


def resolve_file_target(db, requested):
    """从当前账号的联系人库核对归一化后的标题是否仍然唯一。"""
    key = _file_title(requested)
    if not key:
        raise FileTargetError('empty_target')
    conn = db._contact_conn()
    if conn is None:
        raise FileTargetError('contact_db_unavailable')
    try:
        rows = conn.execute('SELECT username, nick_name, remark FROM contact').fetchall()
    finally:
        conn.close()
    names_by_user = {'filehelper': {'filehelper', '文件传输助手'}}
    owners = {}
    for username, nick, remark in rows:
        username = str(username or '').strip()
        if username:
            names_by_user.setdefault(username, set()).update(
                str(name).strip() for name in (username, nick, remark) if str(name or '').strip())
    # SQLite LIKE 看不到全半角等价项。它们必须参与查重，才能用同一规则核验窗口。
    for username, names in names_by_user.items():
        for name in names:
            for title in {_file_title(name), _file_title(_input_title(name))}:
                if title:
                    owners.setdefault(title, set()).add(username)
    candidates = owners.get(key, set())
    if not candidates:
        raise FileTargetError('target_not_found')
    if len(candidates) != 1:
        raise FileTargetError('target_ambiguous')
    canonical = next(iter(candidates))
    aliases = frozenset(name for name in names_by_user[canonical]
                        if owners[_file_title(name)] == {canonical})
    return canonical, aliases


def account_evidence_allowed(*, configured_account, db_account, reason, explicit_pin,
                             account_dirs, visible_windows=None):
    """May the current window be trusted for this account?

    规则（从宽到严）：
      1. 手动钉过窗口 → 认。
      2. **本机只登着一个微信（只有一个主窗）→ 认。**
         这时候根本不存在「从别的号发出去」的可能，历史账号目录多不多无关。
         以前这里要求「先在启动器里选账号」，结果默认配置下表情包一条也发不出去。
      3. 账号目录只有一个 → 认。
      4. 多开（多个主窗）且分不清 → 要求：启动器里明确选了账号，且数据库就是用
         这个号打开的，否则拒绝（这时候猜错真的会从别人的号发消息）。
    """
    wanted = str(configured_account or '').strip()
    current = str(db_account or '').strip()
    # A configured/DB mismatch must never be bypassed merely by counting windows.
    if wanted and wanted != current:
        return False
    count = None
    if visible_windows is not None:
        try:
            count = int(visible_windows)
        except (TypeError, ValueError):
            return False
        if count < 1:
            return False
    if explicit_pin:
        return True
    if count == 1:
        return bool(current)
    if str(reason or '').startswith('命中最近会话'):
        return bool(current)
    if count is None and len(account_dirs or []) == 1:
        return bool(current)
    return bool(wanted and current and wanted == current)


def db_identity(db):
    identity = (str(getattr(db, 'account', '') or ''), str(getattr(db, 'wxid', '') or ''))
    if not all(identity):
        raise ValueError('database account identity is unavailable')
    return identity


def watermark(db, username):
    rows = db.get_messages(username, limit=20)
    if not isinstance(rows, list):
        raise ValueError('database baseline is unavailable')
    return max((int(row.get('sort_seq') or 0) for row in rows), default=0)


def _outgoing(db, message, own_username):
    sender = str(message.get('sender_username') or '')
    if not sender and message.get('shard') and message.get('sender_id') is not None:
        resolver = getattr(db, 'sender_username', None)
        if callable(resolver):
            sender = str(resolver(message['shard'], message['sender_id']) or '')
    # real_sender_id is SHARD-LOCAL. In particular, sender_id == 2 is not proof.
    return sender == own_username


def confirm_delivery(db, username, baseline, identity, gate, timeout=5.0,
                     clock=time.monotonic, sleep=time.sleep, marker=None, exact=False):
    deadline = clock() + timeout
    while True:
        if not gate():
            return result('unconfirmed', 'send was attempted; switch/generation changed before confirmation; do not retry')
        try:
            if db_identity(db) != identity:
                return result('unconfirmed', 'database account changed; do not retry')
            messages = db.get_new_messages(username, since_seq=baseline, limit=30)
            fresh = [m for m in messages if int(m.get('sort_seq') or 0) > baseline
                     and _outgoing(db, m, identity[1])]
            # 现场问题：把 gif 粘进输入框后，微信有时发成「文件卡片」而不是「图片/表情」，
            # 老逻辑只认 MEDIA_TYPES，于是明明发出去了还报「未确认」。
            # 现在先用 md5 / 文件名认领，认不到再看类型。
            strong = [m for m in fresh if _message_matches(m, marker, exact=exact)]
            if len(strong) == 1:
                return result('confirmed')
            if len(strong) > 1:
                return result('unconfirmed', 'multiple outgoing messages match the sticker; delivery is ambiguous; do not retry')
            candidates = [] if exact else [m for m in fresh if m.get('type') in MEDIA_TYPES]
            # More than one candidate is ambiguous. Never claim which image was sent.
            if len(candidates) == 1:
                return result('confirmed')
            if len(candidates) > 1:
                return result('unconfirmed', 'multiple outgoing media messages; delivery is ambiguous; do not retry')
        except Exception:
            return result('unconfirmed', 'database confirmation unavailable; do not retry')
        if clock() >= deadline:
            return result('unconfirmed', 'no new outgoing media message confirmed; do not retry')
        sleep(0.25)


class WindowsDesktop:
    """Lazy adapter; constructed only after all master/account gates passed."""
    def __init__(self):
        import win32gui
        import uiautomation
        self.windows = win32gui
        self.automation = uiautomation

    def foreground(self, hwnd):
        return bool(self.windows.IsWindow(hwnd)
                    and self.windows.GetForegroundWindow() == hwnd
                    and self.windows.GetAncestor(hwnd, 2) == hwnd)

    def focused(self, control, hwnd):
        focused = self.automation.GetFocusedControl()
        return bool(control.HasKeyboardFocus and focused is not None
                    and control.GetRuntimeId() and control.GetRuntimeId() == focused.GetRuntimeId()
                    and focused.GetTopLevelControl().NativeWindowHandle == hwnd)

    def focus(self, control):
        control.SetFocus()

    def value(self, control):
        pattern = control.GetValuePattern()
        if pattern is None:
            raise ValueError('input value pattern is unavailable')
        return pattern.Value

    def clipboard_matches(self, path):
        import win32clipboard
        win32clipboard.OpenClipboard()
        try:
            files = win32clipboard.GetClipboardData(15)  # CF_HDROP, not text/bitmap
            return (len(files) == 1
                    and os.path.normcase(os.path.abspath(files[0])) == os.path.normcase(path))
        finally:
            win32clipboard.CloseClipboard()


def _alias_match(current, aliases):
    # Only strip surrounding UIA whitespace. Casefold/removing INTERNAL spaces
    # merges distinct contacts ('A B' vs 'AB'), unlike resolve_target's proof.
    cur = str(current or '').strip()
    return bool(cur) and any(str(alias or '').strip() == cur for alias in (aliases or ()))


def _is_blank(value):
    """微信输入框「空」时 UIA 读到的并不是空字符串，而是 '\n'（有时带空格）。

    现场问题：只要按 `!= ''` 判断，输入框永远算「有草稿」，私聊里表情包
    一张也发不出去（日志：input contains a draft）。
    """
    return isinstance(value, str) and value.strip() == ''


def _is_attachment(value):
    """粘贴附件后输入框里只剩一个占位符 U+FFFC（前后可能有换行）。"""
    return str(value if value is not None else '').strip() == '\ufffc'


def alias_match(current, aliases):
    """公开的标题比较：只忽略首尾空白，保留收件人身份。"""
    return _alias_match(current, aliases)


def _uia_bound_to(uia, hwnd):
    """Accept the shipped driver's public binding and older private bindings.

    WeChatUIA(hwnd=...) stores hwnd, not _pinned_hwnd. An explicitly unbound
    public driver must still fail closed, even if private metadata is stale.
    Callers separately verify the live root, account, chat and input control.
    """
    try:
        missing = object()
        public = getattr(uia, 'hwnd', missing)
        legacy = int(getattr(uia, '_pinned_hwnd', 0) or 0)
        if int(hwnd) <= 0:
            return False
        if public is missing:
            return legacy == hwnd
        return int(public or 0) == hwnd and legacy in (0, hwnd)
    except (AttributeError, TypeError, ValueError):
        return False


def quarantined_input_value(gui, hwnd, aliases, *, file_mode=False):
    """Read-only proof for a quarantined target; never creates/rebinds UIA.

    None means unavailable or a different target. Empty string is useful only
    after nonempty draft/value evidence was observable for this quarantine.
    """
    match = file_alias_match if file_mode else _alias_match
    try:
        if gui is None or int(gui.main_hwnd) != hwnd:
            return None
        uia = getattr(gui, '_uia', None)
        if (uia is None or not _uia_bound_to(uia, hwnd)
                or uia._win is None or int(uia._win.NativeWindowHandle) != hwnd
                or not match(uia.current_chat(), aliases)):
            return None
        control = uia._chat_input()
        if (control is None or getattr(control, 'ControlTypeName', '') != 'EditControl'
                or not match(_input_title(getattr(control, 'Name', '')), aliases)
                or 'chat_input_field' not in str(getattr(control, 'AutomationId', '')).split('.')):
            return None
        pattern = control.GetValuePattern()
        value = pattern.Value if pattern is not None else None
        return value if isinstance(value, str) else None
    except Exception:
        return None


def guarded_send(gui, uia, hwnd, aliases, path, root, db, username, gate,
                 account_valid, activity_allowed, desktop=None, image_check=None,
                 sleep=time.sleep, confirm_timeout=5.0, file_expected=None):
    """One paste and at most one Enter; the caller owns send_lock + gui_lock.

    gate must reread disk and backend generation. Returns structured evidence,
    never a truthy response object pretending that a failed operation succeeded.
    Cancellation after paste is *unconfirmed*, as a draft may remain. No global
    cleanup keys are sent into a possibly changed window; clear such drafts by
    hand before any future send.
    """
    touched = False
    draft_observed = False
    file_mode = file_expected is not None
    match = file_alias_match if file_mode else _alias_match
    if file_mode:
        try:
            from .file_transport import validate_file, copy_file_to_clipboard, send_file_key, FileChangedError
        except ImportError:
            from file_transport import validate_file, copy_file_to_clipboard, send_file_key, FileChangedError

    def check_path(candidate):
        if file_mode:
            return validate_file(candidate, file_expected)
        return validate_path(candidate, root, image_check)

    try:
        if not gate():
            return result('cancelled', 'file permission changed' if file_mode
                          else 'stickers are disabled or generation expired')
        if not aliases or not hwnd or not account_valid():
            return result('failed', 'account window or target evidence unavailable' if file_mode
                          else 'account or activity gate rejected the sticker')
        if not activity_allowed():
            return result('failed', 'file activity gate rejected the send' if file_mode
                          else 'account or activity gate rejected the sticker')
        desktop = desktop or WindowsDesktop()
        identity = db_identity(db)
        baseline = watermark(db, username)
        approved, fingerprint = check_path(path)

        def guard(*, require_focus=True):
            # Potentially blocking HTTP/DB work precedes immediate window/title/focus reads.
            if not gate() or not activity_allowed() or not account_valid() or db_identity(db) != identity:
                return None
            if (not desktop.foreground(hwnd) or int(getattr(gui, 'main_hwnd', 0)) != hwnd
                    or not _uia_bound_to(uia, hwnd)
                    or uia._win is None or int(uia._win.NativeWindowHandle) != hwnd
                    or not match(uia.current_chat(), aliases)):
                return None
            control = uia._chat_input()
            if (control is None or getattr(control, 'ControlTypeName', '') != 'EditControl'
                    or not match(_input_title(getattr(control, 'Name', '')), aliases)):
                return None
            aid = str(getattr(control, 'AutomationId', '') or '')
            if 'chat_input_field' not in aid.split('.') or (require_focus and not desktop.focused(control, hwnd)):
                return None
            return control

        def guard_problem():
            """只读：返回第一条不满足的条件名，失败日志才有可操作信息。"""
            try:
                if not gate():
                    return 'gate(reloaded config/generation)'
                if not activity_allowed():
                    return 'activity gate (game/fullscreen/away)'
                if not account_valid():
                    return 'account evidence changed'
                if db_identity(db) != identity:
                    return 'database account changed'
                if not desktop.foreground(hwnd):
                    return 'WeChat is not the foreground window'
                if int(getattr(gui, 'main_hwnd', 0)) != hwnd:
                    return 'window driver points at another window'
                if not _uia_bound_to(uia, hwnd):
                    return 'UIA is pinned to another window'
                if uia._win is None or int(uia._win.NativeWindowHandle) != hwnd:
                    return 'UIA root window changed'
                chat = uia.current_chat()
                if not match(chat, aliases):
                    if file_mode:
                        return 'current chat title did not match'
                    return 'current chat title is %r, expected one of %r' % (chat, sorted(aliases))
                control = uia._chat_input()
                if control is None:
                    return 'chat input control not found'
                if getattr(control, 'ControlTypeName', '') != 'EditControl':
                    return 'chat input is not an EditControl'
                if not match(_input_title(getattr(control, 'Name', '')), aliases):
                    if file_mode:
                        return 'chat input title did not match'
                    return 'chat input title is %r, expected one of %r' % (
                        getattr(control, 'Name', ''), sorted(aliases))
                if 'chat_input_field' not in str(getattr(control, 'AutomationId', '') or '').split('.'):
                    return 'chat input has an unexpected AutomationId'
                if not desktop.focused(control, hwnd):
                    return 'chat input does not have keyboard focus'
                return ''
            except Exception as exc:                       # noqa: BLE001
                return 'guard read failed: %s' % type(exc).__name__ if file_mode else 'guard read failed: %r' % (exc,)

        control = guard(require_focus=False)
        if control is None:
            problem = guard_problem() or 'unknown guard state'
            return result('failed', 'cannot send yet: ' + problem)
        # 刚发完文字时微信输入框偶尔还有短暂残留（私聊里尤其常见），
        # 这里只「等它自己清空」，绝不替用户按删除键；等不到才失败。
        for _ in range(20):
            if _is_blank(desktop.value(control)):
                break
            sleep(0.2)
            control = guard(require_focus=False)
            if control is None:
                return result('cancelled', 'send gates changed while waiting for an empty input')
        else:
            return result('failed', 'input contains a draft; clear it manually before sending')
        # Validation can take time. Repeat guards before changing the clipboard/pasting.
        if check_path(approved)[1] != fingerprint:
            if file_mode:
                return {**result('failed', 'file_changed'), 'reason': 'file identity changed before paste'}
            return result('failed', 'sticker file changed before paste')
        # 后台文字发送可能留下焦点在会话列表。只给已核验的空输入框设置一次焦点，
        # 并重新读取账号、会话、控件和真实键盘焦点，再允许粘贴。
        control = guard(require_focus=False)
        if control is None:
            return result('cancelled', 'before paste: ' + (guard_problem() or 'send gates changed'))
        if not desktop.focused(control, hwnd):
            if not _is_blank(desktop.value(control)):
                return result('cancelled', 'target or draft changed before focusing the chat input')
            desktop.focus(control)
            if guard() is None:
                return result('failed', 'cannot send yet: ' + (guard_problem() or 'chat input focus could not be verified'))
        control = guard()
        if control is None:
            return result('cancelled', 'before paste: ' + (guard_problem() or 'send gates changed'))
        if not _is_blank(desktop.value(control)):
            return result('cancelled', 'input acquired a draft before paste')
        if file_mode:
            copy_file_to_clipboard(approved)
        elif not gui.copy_files_to_clipboard([approved]):
            return result('failed', 'unable to prepare attachment clipboard')
        control = guard()
        if control is None or not _is_blank(desktop.value(control)) or not desktop.clipboard_matches(approved):
            return result('cancelled', 'target/focus/switch/draft/clipboard changed before paste')
        # Mark uncertain BEFORE calling a side-effectful function (it can partially act then raise).
        touched = True
        if file_mode:
            send_file_key(control, '{Ctrl}v')
        else:
            gui._input.key(0x56, ctrl=True)  # one Ctrl+V; no select-all/delete or paste retry
        for _ in range(10 if file_mode else 1):
            sleep(0.4)
            control = guard()
            value = desktop.value(control) if control is not None else None
            draft_observed = isinstance(value, str) and not _is_blank(value)
            if not file_mode or control is None or not _is_blank(value):
                break
        if not _is_attachment(value):
            return result('unconfirmed', 'no exact attachment draft evidence; Enter not pressed; clear draft manually; do not retry',
                          draft_may_remain=True, draft_observed=draft_observed)
        if file_mode and check_path(approved)[1] != fingerprint:
            return result('unconfirmed', 'file changed after paste', draft_may_remain=True, draft_observed=True)
        # Recheck immediately at the irreversible action boundary, including backend generation.
        control = guard()
        if control is None:
            return result('unconfirmed', 'send gates changed after paste (focus/target lost); Enter not pressed; clear draft manually; do not retry',
                          draft_may_remain=True, draft_observed=draft_observed)
        _post = desktop.value(control)
        if not _is_attachment(_post):
            if file_mode:
                return result('unconfirmed', 'attachment draft changed before Enter',
                              draft_may_remain=True, draft_observed=draft_observed)
            # 带上实际读到的值，才能判断是「微信把附件又转成文字」还是「读不到」
            return result('unconfirmed',
                          'send gates changed after paste (input reads %r); Enter not pressed; clear draft manually; do not retry'
                          % (str(_post)[:40],),
                          draft_may_remain=True, draft_observed=draft_observed)
        if file_mode:
            send_file_key(control, '{Enter}')
        else:
            gui._input.key(0x0D)  # exactly one Enter, never Ctrl+Enter or retry
        outcome = confirm_delivery(db, username, baseline, identity, gate,
                                   timeout=confirm_timeout, sleep=sleep,
                                   marker={'name': os.path.basename(approved)} if file_mode else _file_marker(approved),
                                   exact=file_mode)
        if outcome['status'] != 'confirmed':
            outcome.update(draft_may_remain=True, draft_observed=draft_observed)
        return outcome
    except Exception as exc:
        if touched:
            reason = ('file validation failed after paste: ' + str(exc)
                      if file_mode and isinstance(exc, FileChangedError)
                      else 'attachment action is uncertain; a draft may remain; do not retry')
            return result('unconfirmed', reason,
                          draft_may_remain=True, draft_observed=draft_observed)
        if isinstance(exc, StickerImageError):
            return result('failed', str(exc))
        if file_mode and isinstance(exc, FileChangedError):
            return {**result('failed', 'file_changed'), 'reason': str(exc)}
        if file_mode:
            return result('failed', 'file transport raised ' + type(exc).__name__)
        return result('failed', 'sticker safety checks or transport are unavailable')
