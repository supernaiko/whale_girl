"""文件任务由桥接领走，所有附件按键都在现有微信发送锁内执行。"""
import engine as G
from account_mixin import is_raw_chat_id
from runtime_kernel_api import KernelApi, KernelApiError
from sticker_transport import FileTargetError, resolve_file_target
from targeting import TargetUnavailable, locate_and_activate

RETRY_DELAY = 0.3
MAX_FILE_RETRIES = 2


class FileSendMixin:
    def send_file(self, item, allowed):
        canonical, shown, aliases, hwnd, uia = '', item['chat'], (), 0, None

        def warn(stage, reason, attempt=1, exc=None, current=None):
            if current is None and uia is not None:
                try:
                    current = uia.current_chat()
                except Exception:
                    pass
            G.log_warn('[send-file] stage=%s reason=%r attempt=%d canonical=%s shown=%s aliases=%d hwnd=%d current=%s type=%s' % (
                stage, reason, attempt, G.safe_id(canonical), G.safe_name(shown), len(aliases), hwnd,
                G.safe_name(current), type(exc).__name__ if exc else 'FileSendError'))

        try:
            canonical, aliases = resolve_file_target(self.db, shown)
            shown = self.ui_chat_name(canonical, shown)
            if shown not in aliases:
                shown = next((alias for alias in sorted(aliases)
                              if alias != canonical and not is_raw_chat_id(alias)), canonical)
        except Exception as exc:
            reason = str(exc) if isinstance(exc, FileTargetError) else 'contact_lookup_raised'
            warn('resolve_target', reason, exc=exc)
            return 'target_unavailable'

        def gate():
            return allowed() and self.send_policy_allows(canonical, shown)

        with self.send_lock, G._SendStateScope(budget=75):
            if not gate() or not self.sticker_activity_allowed(canonical):
                return 'blocked'
            if not self.sticker_quarantine_allows(canonical, shown):
                return 'failed'
            desktop = G.WindowsDesktop()
            snap = None
            try:
                with self.gui_lock:
                    if not gate():
                        return 'blocked'
                    if not desktop.foreground(int(self.ACCOUNT.get('hwnd') or 0)):
                        snap = self.snapshot_win_state()
                    try:
                        def refresh_aliases():
                            nonlocal aliases
                            _, aliases = resolve_file_target(self.db, canonical)
                            return aliases

                        hwnd, uia = locate_and_activate(
                            self, shown, aliases,
                            gate=lambda: (gate() and self.account_send_allowed('文件附件')
                                          and self.sticker_activity_allowed(canonical)),
                            account_valid=self.attachment_account_valid,
                            refresh_aliases=refresh_aliases, log=G.log_warn)
                    except TargetUnavailable:
                        return 'target_unavailable'
                    gui = self.gui

                    for attempt in range(1, MAX_FILE_RETRIES + 2):
                        outcome = G.guarded_sticker_send(
                            gui, uia, hwnd, aliases, item['path'], None, self.db, canonical,
                            gate=gate, account_valid=lambda: self.attachment_account_valid(hwnd),
                            activity_allowed=lambda: self.sticker_activity_allowed(canonical), desktop=desktop,
                            confirm_timeout=10.0, file_expected=(item['size'], item['modifiedNs']),
                        )
                        if outcome['status'] != 'confirmed':
                            warn('send_unconfirmed', outcome.get('reason') or outcome['error'], attempt)
                        # 一旦可能已经粘贴，不重走附件发送，避免留草稿或发出第二份。
                        if (outcome['status'] != 'failed' or outcome['error'] != 'file_changed'
                                or outcome.get('draft_may_remain') or attempt > MAX_FILE_RETRIES):
                            break
                        G.time.sleep(RETRY_DELAY)
                    if outcome.get('draft_may_remain'):
                        self.sticker_draft_quarantine[canonical] = {
                            'hwnd': hwnd, 'aliases': aliases, 'draft_observed': bool(outcome.get('draft_observed')),
                            'file_mode': True,
                        }
            finally:
                if snap:
                    try:
                        self.restore_win_state(snap)
                    except Exception as exc:
                        G.log_warn('[send-file] stage=restore_window type=%s' % type(exc).__name__)

        if outcome['status'] == 'confirmed':
            note = item.get('note', '').strip()
            if note:
                try:
                    if not gate() or not self.send_text(note, shown, canonical):
                        return 'note_failed'
                except Exception as exc:
                    G.log_warn('[send-file] stage=send_note type=%s' % type(exc).__name__)
                    return 'note_failed'
            return 'submitted'
        if outcome['error'] == 'file_changed':
            return 'file_changed'
        if outcome['status'] == 'cancelled':
            return 'blocked'
        return outcome['status']

    def file_send_loop(self, stop):
        api = KernelApi(G.LOCAL_HTTP, self.bot_url.rsplit('/webhook', 1)[0], self.token)
        while not stop.is_set():
            account = str(getattr(self.db, 'account', '') or '')
            try:
                if account and self.ACCOUNT.get('verified'):
                    item = api.post('/api/send-file/claim', json={'account': account}, timeout=3).get('item')
                    if item:
                        identity = {'id': item['id'], 'account': account}

                        def allowed():
                            try:
                                data = api.post('/api/send-file/permission', json=identity, timeout=3)
                                return not stop.is_set() and data.get('allowed') is True
                            except Exception:
                                return False

                        try:
                            status = self.send_file(item, allowed)
                        except Exception as exc:
                            G.log_warn('[send-file] stage=send type=%s' % type(exc).__name__)
                            status = 'failed'
                        api.post('/api/send-file/ack', json={**identity, 'status': status}, timeout=3)
            except Exception as exc:
                G.log_throttled('file-send-queue', '[send-file] stage=queue type=%s detail=%s' % (
                    type(exc).__name__, str(exc) if isinstance(exc, KernelApiError) else '任务处理失败'), ttl=60)
            stop.wait(2)
