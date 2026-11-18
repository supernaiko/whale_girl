"""文件任务由桥接领走，所有附件按键都在现有微信发送锁内执行。"""
import engine as G
from runtime_kernel_api import KernelApi, KernelApiError


class FileSendMixin:
    def send_file(self, item, allowed):
        try:
            canonical, aliases = G.resolve_sticker_target(self.db, item['chat'])
            shown = self.ui_chat_name(canonical, item['chat'])
            if shown not in aliases:
                shown = next((alias for alias in sorted(aliases) if alias != canonical), canonical)
        except Exception as exc:
            G.log_warn('[send-file] stage=resolve_target type=%s' % type(exc).__name__)
            return 'target_unavailable'

        def gate():
            return (allowed() and self.account_send_allowed('文件附件')
                    and self.send_policy_allows(canonical, shown))

        with self.send_lock, G._SendStateScope(budget=60):
            if not gate() or not self.sticker_activity_allowed(canonical):
                return 'blocked'
            if not self.sticker_quarantine_allows(canonical, shown):
                return 'failed'
            hwnd = int(self.ACCOUNT.get('hwnd') or 0)
            if not hwnd or not self.attachment_account_valid(hwnd):
                return 'target_unavailable'

            desktop = G.WindowsDesktop()
            snap = None
            try:
                if not desktop.foreground(hwnd):
                    snap = self.snapshot_win_state()
                    if not self.force_foreground(hwnd) or not desktop.foreground(hwnd):
                        return 'target_unavailable'
                with self.gui_lock:
                    gui = self.gui
                    if gui is None or not gate() or not self.attachment_account_valid(hwnd):
                        return 'target_unavailable'
                    if not gui.use_window(hwnd) or int(gui.main_hwnd) != hwnd:
                        return 'target_unavailable'
                    uia = gui._get_uia()
                    if uia is None or not self.open_attachment_chat(uia, shown, aliases):
                        return 'target_unavailable'
                    outcome = G.guarded_sticker_send(
                        gui, uia, hwnd, aliases, item['path'], None, self.db, canonical,
                        gate=gate, account_valid=lambda: self.attachment_account_valid(hwnd),
                        activity_allowed=lambda: self.sticker_activity_allowed(canonical), desktop=desktop,
                        confirm_timeout=10.0, file_expected=(item['size'], item['modifiedNs']),
                    )
                    if outcome.get('draft_may_remain'):
                        self.sticker_draft_quarantine[canonical] = {
                            'hwnd': hwnd, 'aliases': aliases, 'draft_observed': bool(outcome.get('draft_observed')),
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
