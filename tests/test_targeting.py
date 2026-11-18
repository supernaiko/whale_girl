"""纯模拟回归：不导入真实 Win32/UIA，不连接微信，不发送消息。"""
import contextlib
import importlib
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import Mock, call, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
import targeting
import window_activation


class TargetingTests(unittest.TestCase):
    def setUp(self):
        self.foreground = 100
        self.root = types.SimpleNamespace(NativeWindowHandle=100)
        self.uia = types.SimpleNamespace(
            hwnd=100, _win=self.root, current_chat=Mock(return_value='Other'),
            back_to_chat_tab=Mock(), _search_box=Mock(return_value=object()),
            _set_text=Mock(return_value=False), _collect_results=Mock(return_value=[]),
            _session_rows_of=Mock(return_value=[]), _anchor=Mock(return_value=self.root),
            _click_ctrl=Mock())
        self.runtime = types.SimpleNamespace(
            ACCOUNT={'hwnd': 100, 'pid': 400, 'verified': True},
            gui=types.SimpleNamespace(main_hwnd=100, use_window=Mock(return_value=True),
                                      _get_uia=Mock(return_value=self.uia)))
        self.windows = {100: ('Qt51514QWindowIcon', '自定义主窗标题', 400)}
        self.native = types.SimpleNamespace(
            IsWindow=lambda h: h in self.windows,
            EnumWindows=Mock(side_effect=lambda cb, data: [cb(h, data) for h in self.windows]),
            GetClassName=lambda h: self.windows[h][0], GetWindowText=lambda h: self.windows[h][1],
            GetWindowRect=lambda h: (0, 0, 1000, 700),
            GetWindowPlacement=lambda h: (0, 2, (), (), (0, 0, 1000, 700)),
            IsIconic=lambda h: True, IsWindowVisible=lambda h: True,
            GetForegroundWindow=lambda: self.foreground, GetLastActivePopup=lambda h: h,
            GetAncestor=lambda h, mode: 100, ShowWindow=Mock(),
            SetForegroundWindow=Mock(side_effect=self.set_foreground))
        self.process = types.SimpleNamespace(
            GetWindowThreadProcessId=lambda h: (h + 1, self.windows[h][2]),
            AttachThreadInput=Mock())
        self.api = types.SimpleNamespace(
            GetCurrentThreadId=lambda: 5, GetAsyncKeyState=lambda key: 0,
            keybd_event=Mock())
        self.log, self.pause = Mock(), Mock()
        for patcher in (
            patch.dict(sys.modules, win32gui=self.native, win32process=self.process, win32api=self.api),
            patch.object(targeting.time, 'sleep', self.pause),
            patch.object(targeting, 'activate_target', return_value=True),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def set_foreground(self, hwnd):
        self.foreground = hwnd

    def locate(self, **kwargs):
        return targeting.locate_and_activate(
            self.runtime, 'Friend', {'Friend'}, gate=lambda: True, log=self.log, **kwargs)

    def test_first_two_rounds_fail_third_succeeds_with_fresh_handle(self):
        def search(uia, hwnd, names, aliases, ready):
            if search.call_count == 3:
                uia.current_chat.return_value = 'Friend'
                return True
            return False

        search = Mock(side_effect=search)
        with patch.object(targeting, '_search', search), \
                patch.object(targeting, '_list', return_value=False), \
                patch.object(targeting, '_recent', return_value=False):
            self.assertEqual(self.locate(), (100, self.uia))
        self.assertEqual(self.native.EnumWindows.call_count, 3)
        self.assertEqual(self.runtime.gui._get_uia.call_count, 3)
        self.assertEqual(self.pause.call_args_list, [call(0.4), call(0.4)])
        self.assertIn('round=3 hwnd=100 focus=100 step=search ok', self.log.call_args.args[0])

    def test_three_rounds_fail_with_unchanged_public_code(self):
        with patch.object(targeting, '_search', return_value=False) as search, \
                patch.object(targeting, '_list', return_value=False) as listed, \
                patch.object(targeting, '_recent', return_value=False) as recent:
            with self.assertRaisesRegex(targeting.TargetUnavailable, '^target_unavailable$') as error:
                self.locate()
        self.assertEqual(error.exception.code, 'target_unavailable')
        self.assertEqual([search.call_count, listed.call_count, recent.call_count], [3, 3, 3])
        self.assertEqual(self.log.call_count, 9)

    def test_search_failure_uses_exact_list_row_and_double_clicks(self):
        row = object()
        self.uia._session_rows_of.return_value = [('Friend', row), ('Friend II', object())]
        self.uia._click_ctrl.side_effect = lambda control: setattr(self.uia.current_chat, 'return_value', 'Friend')
        self.assertEqual(self.locate(), (100, self.uia))
        self.assertEqual(self.uia._click_ctrl.call_args_list, [call(row), call(row)])
        self.assertIn('step=list ok', self.log.call_args.args[0])

    def test_recent_fallback_reanchors_after_stale_list(self):
        row = object()
        fresh_root = types.SimpleNamespace(NativeWindowHandle=100)
        self.uia._anchor.return_value = fresh_root
        self.uia._session_rows_of.side_effect = [[], [('Friend', row)]]
        self.uia._click_ctrl.side_effect = lambda control: setattr(self.uia.current_chat, 'return_value', 'Friend')
        self.locate()
        self.uia._anchor.assert_called_once_with(100)
        self.assertIs(self.uia._win, fresh_root)
        self.assertIn('step=recent ok', self.log.call_args.args[0])

    def test_renamed_chat_refreshes_aliases_each_round(self):
        self.uia.current_chat.return_value = 'New name'
        refresh = Mock(side_effect=[{'Old name'}, {'Old name'}, {'New name'}])
        self.assertEqual(self.locate(refresh_aliases=refresh), (100, self.uia))
        self.assertEqual(refresh.call_count, 3)
        self.assertNotIn('New name', ' '.join(c.args[0] for c in self.log.call_args_list))

    def test_search_sets_only_search_control_and_clicks_unique_exact_result(self):
        row = object()
        self.uia._set_text.return_value = True
        self.uia._collect_results.return_value = [{'name': 'Friend', 'cell': row}]
        self.uia._click_ctrl.side_effect = lambda control: setattr(self.uia.current_chat, 'return_value', 'Friend')
        self.locate()
        self.api.keybd_event.assert_has_calls([
            call(0x11, 0, 0, 0), call(ord('F'), 0, 0, 0),
            call(ord('F'), 0, 2, 0), call(0x11, 0, 2, 0)])
        self.uia._click_ctrl.assert_called_once_with(row)
        self.assertIn('step=search ok', self.log.call_args.args[0])

    def test_ambiguous_search_and_list_results_are_not_clicked(self):
        self.uia._set_text.return_value = True
        self.uia._collect_results.return_value = [
            {'name': 'Friend', 'cell': object()}, {'name': 'Friend', 'cell': object()}]
        self.uia._session_rows_of.return_value = [('Friend', object()), ('Friend', object())]
        with self.assertRaises(targeting.TargetUnavailable):
            self.locate()
        self.uia._click_ctrl.assert_not_called()

    def test_wrong_chat_is_rejected_even_when_navigation_claims_success(self):
        with patch.object(targeting, '_search', return_value=True):
            with self.assertRaises(targeting.TargetUnavailable):
                self.locate()

    def test_foreground_is_read_back_before_navigation(self):
        self.foreground = 999
        with patch.object(targeting, '_search') as search:
            with self.assertRaises(targeting.TargetUnavailable):
                self.locate()
        search.assert_not_called()

    def test_replaced_window_is_reacquired_on_next_round(self):
        def refresh_gate():
            if self.pause.call_count:
                self.windows = {200: ('WeChatMainWndForPC', '改过标题', 500)}
                self.runtime.ACCOUNT.update(hwnd=200, pid=500)
                self.runtime.gui.main_hwnd = self.foreground = 200
                self.root.NativeWindowHandle = self.uia.hwnd = 200
                self.uia.current_chat.return_value = 'Friend'
            return True

        self.windows = {}
        hwnd, _ = targeting.locate_and_activate(
            self.runtime, 'Friend', {'Friend'}, gate=refresh_gate, log=self.log)
        self.assertEqual(hwnd, 200)
        self.assertEqual(self.native.EnumWindows.call_count, 2)

    def test_other_account_and_reused_handle_are_not_selected(self):
        for verified, pid in ((False, 400), (True, 999)):
            with self.subTest(verified=verified, pid=pid):
                self.runtime.ACCOUNT.update(verified=verified, pid=pid)
                self.windows[200] = ('WeChatMainWndForPC', '微信', 500)
                with patch.object(targeting, 'activate_target') as activate:
                    with self.assertRaises(targeting.TargetUnavailable):
                        self.locate()
                activate.assert_not_called()

    def test_uia_bound_to_another_window_is_rejected(self):
        self.root.NativeWindowHandle = 200
        with self.assertRaises(targeting.TargetUnavailable):
            self.locate()
        self.uia._click_ctrl.assert_not_called()

    def test_window_enumeration_handles_titles_classes_and_minimized_size(self):
        self.windows.update({
            200: ('WeChatMainWndForPC', '任意标题', 500),
            300: ('Qt663QWindowIcon', '我的微信', 600),
            400: ('mmui::LoginWindow', '微信', 700),
            500: ('OtherApp', '微信', 800),
        })
        self.assertEqual(targeting.main_window_candidates(100), [(100, 400), (200, 500), (300, 600), (500, 800)])

    def test_owned_foreground_popup_is_cancelled_but_other_process_is_untouched(self):
        self.windows[150] = ('Dialog', '提示', 400)
        self.foreground = 150
        self.native.GetLastActivePopup = lambda h: 150
        targeting._dismiss_popup(100)
        self.api.keybd_event.assert_any_call(0x1B, 0, 0, 0)
        self.api.keybd_event.reset_mock()
        self.windows[150] = ('Dialog', '其它应用', 500)
        targeting._dismiss_popup(100)
        self.api.keybd_event.assert_not_called()

    def test_popup_brought_forward_by_restore_is_cancelled_before_navigation(self):
        self.windows[150] = ('Dialog', '提示', 400)
        self.foreground = 999
        self.native.GetLastActivePopup = lambda h: 150
        self.uia.current_chat.return_value = 'Friend'

        def activate(hwnd):
            self.foreground = 150 if activate.call_count == 1 else hwnd
            return self.foreground == hwnd

        activate = Mock(side_effect=activate)
        self.api.keybd_event.side_effect = lambda key, *a: self.set_foreground(100) if key == 0x1B else None
        with patch.object(targeting, 'activate_target', activate):
            self.assertEqual(self.locate(), (100, self.uia))
        self.assertEqual(activate.call_count, 2)

    def test_steal_restores_window_and_detaches_both_input_threads(self):
        self.windows[200] = ('OtherApp', 'Other', 500)
        self.foreground = 200
        self.assertTrue(window_activation.activate_target(100))
        self.native.ShowWindow.assert_called_once_with(100, 9)
        self.process.AttachThreadInput.assert_has_calls([
            call(5, 101, True), call(5, 201, True),
            call(5, 201, False), call(5, 101, False)])
        self.api.keybd_event.assert_has_calls([call(0x12, 0, 0, 0), call(0x12, 0, 2, 0)])

    def test_steal_detaches_when_set_foreground_raises(self):
        self.foreground = 100
        self.native.SetForegroundWindow.side_effect = RuntimeError('simulated')
        with self.assertRaises(RuntimeError):
            window_activation._steal_foreground(100)
        self.process.AttachThreadInput.assert_has_calls([call(5, 101, True), call(5, 101, False)])

    def test_detach_attempts_remaining_thread_when_one_thread_exits(self):
        self.windows[200] = ('OtherApp', 'Other', 500)
        self.foreground = 200
        self.process.AttachThreadInput.side_effect = [None, None, RuntimeError('thread exited'), None]
        self.assertTrue(window_activation._steal_foreground(100))
        self.assertEqual(self.process.AttachThreadInput.call_args_list[-1], call(5, 101, False))

    def test_held_modifier_does_not_synthesize_alt_or_attach_threads(self):
        self.api.GetAsyncKeyState = lambda key: 0x8000 if key == 0x11 else 0
        self.assertFalse(window_activation._steal_foreground(100))
        self.api.keybd_event.assert_not_called()
        self.process.AttachThreadInput.assert_not_called()

    def test_new_uia_boot_accepts_renamed_main_classes_and_keeps_login_out(self):
        import uia_boot

        for cls in ('WeChatMainWndForPC', 'mmui::MainWindow'):
            self.windows[100] = (cls, '任意标题', 400)
            self.assertTrue(uia_boot.is_wechat_account_window(self.native, 100))
        self.windows[100] = ('Qt51514QWindowIcon', '我的微信', 400)
        self.assertTrue(uia_boot.is_wechat_account_window(self.native, 100))
        self.windows[100] = ('Qt51514QWindowIcon', '微信设置', 400)
        self.assertFalse(uia_boot.is_wechat_account_window(self.native, 100))

    def test_logs_do_not_include_exception_content_or_contact_names(self):
        with patch.object(targeting, '_search', side_effect=RuntimeError('private chat body')):
            with self.assertRaises(targeting.TargetUnavailable):
                self.locate()
        logs = ' '.join(c.args[0] for c in self.log.call_args_list)
        self.assertIn('RuntimeError', logs)
        for secret in ('private chat body', 'Friend', 'Other'):
            self.assertNotIn(secret, logs)


class SendWiringTests(unittest.TestCase):
    def setUp(self):
        self.engine = types.SimpleNamespace(
            _SendStateScope=lambda *a, **k: contextlib.nullcontext(),
            safe_id=lambda value: 'redacted', safe_name=lambda value: 'redacted',
            log=Mock(), log_warn=Mock(), log_error=Mock(),
            time=types.SimpleNamespace(time=lambda: 1, sleep=Mock()),
            WindowsDesktop=lambda: types.SimpleNamespace(foreground=lambda hwnd: True),
            resolve_sticker_target=Mock(return_value=('peer', {'Friend'})),
            guarded_sticker_send=Mock(return_value={'status': 'confirmed', 'error': ''}),
            sticker_result=lambda status, error='', **kwargs: {'status': status, 'error': error, **kwargs},
            ROOT='C:/fixture', os=__import__('os'), SEND_STATE={},
            BACKGROUND_SEND=False, STICKER_TEST_ON=False, BG_SEND={'enabled': False}, QUOTE_REPLY=False,
            ChatIdentityError=type('ChatIdentityError', (RuntimeError,), {}))
        self.patcher = patch.dict(sys.modules, engine=self.engine)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.modules = {}
        for name in ('account_mixin', 'file_mixin', 'sender_mixin', 'sticker_mixin'):
            old = sys.modules.pop(name, None)
            self.addCleanup(self.restore_module, name, old)
            self.modules[name] = importlib.import_module(name)

    @staticmethod
    def restore_module(name, old):
        sys.modules.pop(name, None)
        if old is not None:
            sys.modules[name] = old

    def runtime(self, mixin):
        runtime = mixin()
        runtime.__dict__.update(
            db=object(), ACCOUNT={'hwnd': 100, 'verified': True},
            gui=types.SimpleNamespace(main_hwnd=100), UIA_CACHE={},
            send_lock=threading.Lock(), gui_lock=threading.Lock(),
            account_send_allowed=lambda *a: True, send_policy_allows=lambda *a: True,
            sticker_activity_allowed=lambda *a: True, attachment_account_valid=lambda *a: True,
            sticker_quarantine_allows=lambda *a, **kw: True, sticker_draft_quarantine={},
            ui_chat_name=lambda u, shown: shown, sticker_gate=lambda *a: True,
            sticker_config_now=lambda: {'sticker': {'dir': 'C:/fixture'}},
            restore_win_state=Mock(), aliases_for=lambda *a: ['Friend'])
        return runtime

    def test_file_calls_shared_locator_and_transports_only_once(self):
        mod = self.modules['file_mixin']
        runtime = self.runtime(mod.FileSendMixin)
        uia = object()
        with patch.object(mod, 'resolve_file_target', return_value=('peer', {'Friend'})), \
                patch.object(mod, 'locate_and_activate', return_value=(100, uia)) as locate:
            result = runtime.send_file({'chat': 'Friend', 'path': 'fake.txt', 'size': 4, 'modifiedNs': '1'}, lambda: True)
        self.assertEqual(result, 'submitted')
        locate.assert_called_once()
        self.engine.guarded_sticker_send.assert_called_once()

    def test_file_three_round_failure_maps_to_existing_code_without_transport(self):
        mod = self.modules['file_mixin']
        runtime = self.runtime(mod.FileSendMixin)
        with patch.object(mod, 'resolve_file_target', return_value=('peer', {'Friend'})), \
                patch.object(mod, 'locate_and_activate', side_effect=targeting.TargetUnavailable()):
            result = runtime.send_file({'chat': 'Friend'}, lambda: True)
        self.assertEqual(result, 'target_unavailable')
        self.engine.guarded_sticker_send.assert_not_called()

    def test_file_keeps_original_fingerprint_and_validation_retries(self):
        mod = self.modules['file_mixin']
        runtime = self.runtime(mod.FileSendMixin)
        self.engine.guarded_sticker_send.return_value = {'status': 'failed', 'error': 'file_changed'}
        with patch.object(mod, 'resolve_file_target', return_value=('peer', {'Friend'})), \
                patch.object(mod, 'locate_and_activate', return_value=(100, object())):
            result = runtime.send_file({'chat': 'Friend', 'path': 'fake.txt', 'size': 4, 'modifiedNs': '1'}, lambda: True)
        self.assertEqual(result, 'file_changed')
        self.assertEqual([c.kwargs['file_expected'] for c in self.engine.guarded_sticker_send.call_args_list],
                         [(4, '1')] * 3)

    def test_uncertain_file_is_quarantined_without_repeating_transport(self):
        mod = self.modules['file_mixin']
        runtime = self.runtime(mod.FileSendMixin)
        self.engine.guarded_sticker_send.return_value = {
            'status': 'unconfirmed', 'error': 'uncertain', 'draft_may_remain': True}
        with patch.object(mod, 'resolve_file_target', return_value=('peer', {'Friend'})), \
                patch.object(mod, 'locate_and_activate', return_value=(100, object())):
            result = runtime.send_file({'chat': 'Friend', 'path': 'fake.txt', 'size': 4, 'modifiedNs': '1'}, lambda: True)
        self.assertEqual(result, 'unconfirmed')
        self.engine.guarded_sticker_send.assert_called_once()
        self.assertTrue(runtime.sticker_draft_quarantine['peer']['file_mode'])

    def test_sticker_calls_shared_locator_and_transports_only_once(self):
        mod = self.modules['sticker_mixin']
        runtime = self.runtime(mod.StickerMixin)
        with patch.object(mod, 'locate_and_activate', return_value=(100, object())) as locate:
            result = runtime.send_sticker('fake.png', 'Friend', 'peer', 'g1', 'job')
        self.assertEqual(result['status'], 'confirmed')
        locate.assert_called_once()
        self.engine.guarded_sticker_send.assert_called_once()

    def test_sticker_locator_failure_never_pastes(self):
        mod = self.modules['sticker_mixin']
        runtime = self.runtime(mod.StickerMixin)
        with patch.object(mod, 'locate_and_activate', side_effect=targeting.TargetUnavailable()):
            result = runtime.send_sticker('fake.png', 'Friend', 'peer', 'g1', 'job')
        self.assertEqual(result, {'status': 'failed', 'error': 'target_unavailable'})
        self.engine.guarded_sticker_send.assert_not_called()

    def test_native_emoticon_uses_shared_locator(self):
        mod = self.modules['sender_mixin']
        runtime = self.runtime(mod.SenderMixin)
        with patch.object(targeting, 'locate_and_activate', return_value=(100, object())) as locate, \
                patch.object(mod, 'send_pasted_emoticon', return_value={'status': 'confirmed', 'reason': ''}) as send:
            self.assertEqual(runtime.send_emoticon('Friend', '微笑')['status'], 'confirmed')
        locate.assert_called_once()
        send.assert_called_once()

    def test_uncertain_sticker_is_quarantined_without_repeating_transport(self):
        mod = self.modules['sticker_mixin']
        runtime = self.runtime(mod.StickerMixin)
        self.engine.guarded_sticker_send.return_value = {
            'status': 'unconfirmed', 'error': 'uncertain', 'draft_may_remain': True}
        with patch.object(mod, 'locate_and_activate', return_value=(100, object())):
            result = runtime.send_sticker('fake.png', 'Friend', 'peer', 'g1', 'job')
        self.assertEqual(result['status'], 'unconfirmed')
        self.engine.guarded_sticker_send.assert_called_once()
        self.assertIn('peer', runtime.sticker_draft_quarantine)

    def test_text_uses_shared_locator_before_body_send(self):
        runtime = self.runtime(self.modules['sender_mixin'].SenderMixin)
        uia = types.SimpleNamespace(send_text=Mock(return_value=True))
        runtime._require_chat_identity = Mock()
        runtime._input_value = lambda u: ''
        with patch.object(targeting, 'locate_and_activate', return_value=(100, uia)) as locate:
            self.assertTrue(runtime.uia_send('fixture body', 'Friend'))
        locate.assert_called_once()
        uia.send_text.assert_called_once_with('fixture body')

    def test_text_locator_failure_uses_existing_identity_error_exit(self):
        runtime = self.runtime(self.modules['sender_mixin'].SenderMixin)
        with patch.object(targeting, 'locate_and_activate', side_effect=targeting.TargetUnavailable()):
            with self.assertRaisesRegex(self.engine.ChatIdentityError, '^target_unavailable$'):
                runtime.uia_send('fixture body', 'Friend')

    def test_public_send_text_stops_after_locator_exhaustion_and_returns_false(self):
        runtime = self.runtime(self.modules['sender_mixin'].SenderMixin)
        runtime.chat_paused = runtime.is_self_chat = lambda *a: False
        runtime.group_is_alive = lambda *a: True
        runtime.gui._get_uia = Mock(return_value=object())
        runtime.bind_gui_window = Mock()
        runtime.with_window_on_top = Mock(side_effect=AssertionError('legacy preactivation used'))
        with patch.object(targeting, 'locate_and_activate', side_effect=targeting.TargetUnavailable()) as locate:
            self.assertFalse(runtime.send_text('fixture body', 'Friend', 'peer'))
        locate.assert_called_once()
        runtime.with_window_on_top.assert_not_called()

    def test_verified_renamed_window_still_counts_as_an_account_window(self):
        runtime = self.runtime(self.modules['account_mixin'].AccountMixin)
        runtime.ACCOUNT['pid'] = 400
        self.engine.uia_boot = types.SimpleNamespace(account_window_candidates=lambda *a: [])
        driver = types.SimpleNamespace(WeChatUIA=lambda: types.SimpleNamespace(_wechat_hwnds=lambda: [100]))
        with patch.dict(sys.modules, {'win32gui': types.SimpleNamespace(),
                                      'win32process': types.SimpleNamespace(),
                                      'wechatauto.uia_driver': driver}), \
                patch.object(targeting, 'main_window_candidates', return_value=[(100, 400)]):
            self.assertEqual(runtime.wechat_main_window_count(), 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
