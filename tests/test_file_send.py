"""回归文件发送的会话定位、窗口重试及附件校验。"""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call, patch
import sqlite3
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from file_mixin import FileSendMixin
from sticker_transport import FileTargetError, file_alias_match, guarded_send, resolve_file_target


class Contacts:
    def __init__(self, rows):
        self.rows = rows

    def _contact_conn(self):
        conn = sqlite3.connect(':memory:')
        conn.execute('CREATE TABLE contact (username, nick_name, remark)')
        conn.executemany('INSERT INTO contact VALUES (?, ?, ?)', self.rows)
        return conn


class FileSendTest(unittest.TestCase):
    def setUp(self):
        self.db = Contacts([('wxid_peer', 'Peer', 'Friend')])
        self.item = {'chat': 'Friend', 'path': 'C:/test.txt', 'size': 4, 'modifiedNs': '1'}
        self.uia = SimpleNamespace(current_chat=Mock(return_value='Another'), open_chat=Mock(return_value=False))
        self.desktop = SimpleNamespace(foreground=Mock(return_value=True))
        self.runtime = FileSendMixin()
        self.runtime.__dict__.update(
            db=self.db, send_lock=threading.Lock(), gui_lock=threading.Lock(),
            ACCOUNT={'hwnd': 100}, ui_chat_name=lambda canonical, shown: shown,
            gui=SimpleNamespace(main_hwnd=100, use_window=Mock(return_value=True),
                                _get_uia=Mock(return_value=self.uia)),
            account_send_allowed=Mock(return_value=True), send_policy_allows=Mock(return_value=True),
            attachment_account_valid=Mock(return_value=True), sticker_activity_allowed=Mock(return_value=True),
            sticker_quarantine_allows=Mock(return_value=True), sticker_draft_quarantine={},
            force_foreground=Mock(return_value=False), snapshot_win_state=Mock(return_value={'fg': 20}),
            restore_win_state=Mock(),
        )
        self.transport = Mock(return_value={'status': 'confirmed', 'error': ''})
        self.activated = Mock(return_value=True)
        self.warn = Mock()
        self.sleep = Mock()
        for target, value in {
            'file_mixin.G.guarded_sticker_send': self.transport,
            'file_mixin.G.WindowsDesktop': Mock(return_value=self.desktop),
            'file_mixin.G.log_warn': self.warn,
            'file_mixin.G.time.sleep': self.sleep,
            'file_mixin.activate': self.activated,
        }.items():
            patcher = patch(target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def send(self):
        return self.runtime.send_file(self.item, lambda: True)

    def test_skips_navigation_when_normalized_title_matches(self):
        self.uia.current_chat.return_value = '　微信：Ｆｒｉｅｎｄ　'
        self.assertEqual(self.send(), 'submitted')
        self.uia.open_chat.assert_not_called()
        self.assertEqual(self.transport.call_args.args[7], 'wxid_peer')

    def test_falls_back_to_next_searchable_alias_and_reads_the_title(self):
        def open_chat(alias, retries):
            if alias == 'Peer':
                self.uia.current_chat.return_value = 'Ｐｅｅｒ - 微信'
            return False
        self.uia.open_chat.side_effect = open_chat
        self.assertEqual(self.send(), 'submitted')
        self.assertEqual(self.uia.open_chat.call_args_list, [
            call('Friend', retries=1),
            call('Peer', retries=1),
        ])
        self.assertIn(call(0.3), self.sleep.call_args_list)
        log = self.warn.call_args.args[0]
        self.assertIn('stage=open_chat_fail', log)
        self.assertIn('aliases=3 hwnd=100', log)
        for raw in ('wxid_peer', 'Friend', 'Another'):
            self.assertNotIn(raw, log)

    def test_never_transports_when_all_searches_leave_the_wrong_chat(self):
        self.db.rows += [('wxid_peer', 'Another alias', 'Last alias')]
        self.uia.open_chat.return_value = True
        self.assertEqual(self.send(), 'target_unavailable')
        self.assertEqual(self.uia.open_chat.call_count, 3)
        self.transport.assert_not_called()

    def test_retries_window_verification_and_foreground_activation(self):
        self.runtime.attachment_account_valid.side_effect = [False, True, True, True, True]
        self.desktop.foreground.side_effect = [False, False, True, True]
        self.uia.current_chat.return_value = 'Friend'
        self.assertEqual(self.send(), 'submitted')
        self.runtime.force_foreground.assert_called_once_with(100)
        self.activated.assert_called_once_with(100, retry=True)
        self.runtime.restore_win_state.assert_called_once_with({'fg': 20})
        logs = ' '.join(entry.args[0] for entry in self.warn.call_args_list)
        self.assertIn('stage=hwnd_invalid', logs)
        self.assertIn('stage=foreground_fail', logs)

    def test_retries_file_validation_twice_with_the_original_fingerprint(self):
        self.uia.current_chat.return_value = 'Friend'
        self.transport.return_value = {'status': 'failed', 'error': 'file_changed', 'reason': 'mtime mismatch'}
        self.assertEqual(self.send(), 'file_changed')
        self.assertEqual([entry.kwargs['file_expected'] for entry in self.transport.call_args_list],
                         [(4, '1')] * 3)
        self.assertIn("stage=send_unconfirmed reason='mtime mismatch' attempt=3", self.warn.call_args.args[0])

    def test_does_not_retry_after_paste_may_have_happened(self):
        self.uia.current_chat.return_value = 'Friend'
        self.transport.return_value = {'status': 'unconfirmed', 'error': 'file changed after paste',
                                       'draft_may_remain': True}
        self.assertEqual(self.send(), 'unconfirmed')
        self.transport.assert_called_once()
        self.assertTrue(self.runtime.sticker_draft_quarantine['wxid_peer']['file_mode'])


class FileIdentityTest(unittest.TestCase):
    def test_width_and_wechat_edge_affixes_do_not_hide_name_collisions(self):
        db = Contacts([('wxid_first', 'Peer', 'Friend'), ('wxid_second', '微信：Ｐｅｅｒ', '')])
        with self.assertRaisesRegex(FileTargetError, 'target_ambiguous'):
            resolve_file_target(db, 'Peer')
        self.assertEqual(resolve_file_target(db, 'wxid_first'),
                         ('wxid_first', {'wxid_first', 'Friend'}))
        self.assertFalse(file_alias_match('Peer', {'Friend'}))
        self.assertFalse(file_alias_match('AB', {'A B'}))
        self.assertFalse(file_alias_match('User II', {'User Ⅱ'}))

    def test_validates_real_file_metadata_with_a_specific_reason(self):
        from file_transport import FileChangedError, validate_file

        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp).resolve() / 'fixture.txt'
            file.write_bytes(b'test')
            info = file.stat()
            validate_file(str(file), (4, str(info.st_mtime_ns)))
            with self.assertRaisesRegex(FileChangedError, '修改时间'):
                validate_file(str(file), (4, str(info.st_mtime_ns - 1)))

    def test_normalized_title_passes_attachment_guards_and_confirms_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp).resolve() / 'fixture.txt'
            path.write_bytes(b'test')
            expected = (4, str(path.stat().st_mtime_ns))
            control = SimpleNamespace(Name='Ｐｅｅｒ - 微信 按住鼠标 语音输入文字',
                                      ControlTypeName='EditControl', AutomationId='root.chat_input_field')
            uia = SimpleNamespace(hwnd=100, _win=SimpleNamespace(NativeWindowHandle=100),
                                  current_chat=lambda: '微信：Ｐｅｅｒ', _chat_input=lambda: control)
            desktop = SimpleNamespace(foreground=lambda hwnd: True, focused=lambda control, hwnd: True,
                                      value=Mock(side_effect=[''] * 3 + ['\ufffc'] * 2),
                                      clipboard_matches=lambda path: True)
            message = {'sort_seq': 1, 'type': '文件', 'sender_username': 'mock-sender',
                       'content': '<msg><appmsg><type>6</type><title>fixture.txt</title></appmsg></msg>'}
            db = SimpleNamespace(account='mock-account', wxid='mock-sender', get_messages=lambda *a, **k: [],
                                 get_new_messages=lambda *a, **k: [message])
            gui = SimpleNamespace(main_hwnd=100)
            with patch('file_transport.copy_file_to_clipboard'), patch('file_transport.send_file_key') as key:
                outcome = guarded_send(gui, uia, 100, {'Peer'}, str(path), None, db, 'peer',
                                       gate=lambda: True, account_valid=lambda: True, activity_allowed=lambda: True,
                                       desktop=desktop, sleep=lambda seconds: None, file_expected=expected)
            self.assertEqual(outcome['status'], 'confirmed')
            self.assertEqual(key.call_args_list, [call(control, '{Ctrl}v'), call(control, '{Enter}')])


if __name__ == '__main__':
    unittest.main()
