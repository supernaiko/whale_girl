# -*- coding: utf-8 -*-
"""Bridge runtime mixin: SenderMixin."""
import engine as G
from emoticon import outcome, parse_request, send_pasted_emoticon


class SenderMixin:

    def _with_target_window(self, send):
        # 定位函数负责恢复和抢前台，旧包装器的预激活失败不应抢先拦下恢复机会。
        snap = self.snapshot_win_state() if G.BACKGROUND_SEND else None
        try:
            return send()
        finally:
            if snap:
                self.restore_win_state(snap)

    def _locate_text_chat(self, who, username=''):
        from sticker_transport import resolve_file_target
        from targeting import locate_and_activate

        keys = self.aliases_for(username, who) if username else [who]
        latest_keys = list(keys)

        def refresh_aliases():
            nonlocal latest_keys
            # 按内部 ID 重读联系人，避免旧昵称/备注缓存让改名后的会话永远搜不到。
            fresh = resolve_file_target(self.db, username)[1] if username else keys
            # 未命名群原来就使用成员组合名；联系人库只有群 ID 时保留已有候选。
            latest_keys = list(keys if username.endswith('@chatroom') and set(fresh) == {username} else fresh)
            return latest_keys

        hwnd, uia = locate_and_activate(
            self, who, keys,
            gate=lambda: (self.account_send_allowed('UIA')
                          and self.send_policy_allows(username, who)),
            refresh_aliases=refresh_aliases, log=G.log)
        self.UIA_CACHE['u'] = uia
        return hwnd, uia, latest_keys

    def send_emoticon(self, chat, code, active=lambda: True):
        """专用的原生表情发送通道，避免通用文本通道把代码原样发出去。"""
        try:
            chat, code = parse_request({'chat': chat, 'code': code})
        except ValueError as exc:
            return outcome('failed', str(exc))
        try:
            canonical, aliases = G.resolve_sticker_target(self.db, chat)
            shown = next((alias for alias in sorted(aliases) if alias != canonical), canonical)
        except Exception as exc:
            G.log_warn('[emoticon] type=%s detail=resolve_target' % type(exc).__name__)
            return outcome('failed', 'target_unavailable')

        def allowed():
            return (active() and self.send_policy_allows(canonical, shown) and active())

        if not self.send_lock.acquire(timeout=2):
            return outcome('failed', 'bridge_busy')
        snap = None
        try:
            with G._SendStateScope(len(code), budget=20):
                if not allowed() or not self.sticker_activity_allowed(canonical):
                    return outcome('failed', 'send_blocked')
                if not self.sticker_quarantine_allows(canonical, shown):
                    return outcome('failed', 'draft_not_empty')
                hwnd = int(self.ACCOUNT.get('hwnd') or 0)

                def account_valid():
                    return (self.account_send_allowed('内置表情') and self.attachment_account_valid(hwnd))

                desktop = G.WindowsDesktop()
                if not desktop.foreground(hwnd):
                    snap = self.snapshot_win_state()
                with self.gui_lock:
                    if not active():
                        return outcome('failed', 'send_blocked')
                    from targeting import TargetUnavailable, locate_and_activate
                    try:
                        def refresh_aliases():
                            nonlocal aliases
                            _, aliases = G.resolve_sticker_target(self.db, shown, canonical)
                            return aliases

                        hwnd, uia = locate_and_activate(
                            self, shown, aliases,
                            gate=lambda: (allowed() and self.account_send_allowed('内置表情')
                                          and self.sticker_activity_allowed(canonical)),
                            account_valid=self.attachment_account_valid,
                            refresh_aliases=refresh_aliases, log=G.log)
                    except TargetUnavailable:
                        return outcome('failed', 'target_unavailable')
                    return send_pasted_emoticon(uia, desktop, hwnd, aliases, self.db, canonical,
                                                code, allowed, account_valid, G.log_warn)
        finally:
            try:
                self.restore_win_state(snap)
            finally:
                self.send_lock.release()

    def bg_send(self, text, chat_display_name, chat_username=''):
        """零焦点通道：用窗口消息打字 + 点发送，全程不抢前台。

        见 `bridge/bg_sender.py` 与 `docs/微信消息后台发送.md`。失败返回 False，
        由 send_text 继续走 UIA / 键盘 / OCR。**不动 gui、不碰 win32gui**，
        所以即使 wechatauto 的 UIA 引擎挂了这条也能用。
        """
        if not G.BG_SEND.get('enabled', True) or self.BG_STATS['disabled']:
            return False
        if G.time.time() < self.BG_STATS['cooldownUntil']:
            return False
        try:
            import bg_sender
        except Exception:
            try:
                from . import bg_sender
            except Exception as e:
                self.BG_STATS['disabled'] = True
                G.log('后台通道：模块导入失败，本次运行内关闭这条通道：', repr(e))
                return False
        hwnd = self._bg_hwnd()
        if not hwnd:
            return False
        try:
            bg_sender.configure(G.BG_SEND, state_file=G.os.path.join(G.ROOT, 'data', 'wechat-encoding.json'))
        except Exception:
            pass
        if chat_username:
            keys = self.aliases_for(chat_username, chat_display_name) or [chat_display_name]
        else:
            keys = [chat_display_name]
        t0 = G.time.time()
        try:
            ok, why = bg_sender.send(text, chat=keys, hwnd=hwnd, log=G.log, char_gap=G.BG_SEND.get('charGap', 0.04), strip_unencodable=G.BG_SEND.get('strip', True), verify=G.BG_SEND.get('verify', True), unhide=G.BG_SEND.get('unhide', True), char_mode=G.BG_SEND.get('charMode') or 'auto')
        except Exception as e:
            ok, why = (False, 'exception:' + type(e).__name__)
            G.log_warn('后台通道异常：', repr(e))
        self.BG_STATS['tried'] += 1
        self.BG_STATS['last'] = why
        self.BG_STATS['lastAt'] = G.time.time()
        G.log('[delivery] stage=background result=%s reason=%s' % ('submitted' if ok else 'failed', why))
        if why == 'chat_mismatch':
            raise G.ChatIdentityError('后台通道：当前会话不是目标 %s' % G.safe_name(chat_display_name))
        if why == 'content_mismatch':
            raise G.DraftDirtyError('正文回读校验未通过，本次输入已清理，未发送（%s）' % why)
        if why == 'input_not_empty':
            raise G.DraftDirtyError('目标输入框已有草稿，本条未输入也未发送，请先手动处理草稿（input_not_empty）')
        if why == 'input_dirty':
            raise G.DraftDirtyError('本次输入中断或清理未确认，已暂停发送，请检查目标输入框（input_dirty）')
        if why == 'residue_left':
            raise G.DraftDirtyError('已尝试点击发送但输入框未清空，请先核对微信是否已收到，避免重复补发（residue_left）')
        if ok:
            self.BG_STATS['ok'] += 1
            self.BG_STATS['treeFails'] = 0
            G.log('后台通道发送成功（%s，%.1fs）' % (why, G.time.time() - t0))
            return True
        G.log('后台通道没发出去（%s，%.1fs），换下一条通道：%s' % (why, G.time.time() - t0, G.safe_name(chat_display_name)))
        if why == 'tree_not_ready':
            self.BG_STATS['treeFails'] += 1
            if self.BG_STATS['treeFails'] >= 3:
                self.BG_STATS['cooldownUntil'] = G.time.time() + 600
                self.BG_STATS['treeFails'] = 0
                G.log_throttled('bg-tree-cooldown', '后台通道连续 3 次读不到控件树，先停 10 分钟再试（其余通道不受影响）。排查：python -m bridge --bg-probe')
        if why == 'uipi_denied':
            G.log_throttled('bg-uipi', '后台通道被 UIPI 拒绝：微信是管理员权限、桥接不是。把两边权限调成一样（都用管理员，或都不用）即可。')
        elif why == 'minimized':
            G.log_throttled('bg-min', '微信最小化了：零焦点通道要求窗口显示出来（用「显示但不激活」拉出来，不抢前台）。')
        elif why == 'tree_not_ready':
            G.log_throttled('bg-tree', '后台通道读不到控件树：确认微信没缩在托盘；4.2 需要 wechatauto 的 gate 热激活，必要时提权重试。诊断：python -m bridge --bg-probe')
        elif why == 'chat_not_found' and chat_username:
            G.log('后台通道：%s 不在会话列表里，改用会搜索的通道' % G.safe_name(chat_display_name))
        return False

    def uia_send(self, text, who, username=''):
        """优先用 UIA 发送：不依赖 OCR 找发送按钮，成功后返回 True。"""
        from targeting import TargetUnavailable

        # 微信半夜自更新/回收窗口后，UIA 手里还攥着旧窗口的 COM 指针/句柄，再碰一次
        # 直接 0xC0000005（访问违规，try/except 拦不住）。发送前先问窗口还在不在；
        # 不在就 return False，交给 send_text 走键盘/OCR 兜底，别把桥接进程搞死。
        if not self.wechat_window_alive():
            G.log('[delivery] stage=uia_send result=skipped reason=window_dead')
            return False

        try:
            with self.gui_lock:
                _, u, keys = self._locate_text_chat(who, username)
            self._require_chat_identity(u, who, keys, 'UIA')
            t_open = G.time.time()
            sent_ok = False
            try:
                sent_ok = bool(u.send_text(text))
            except G.ChatIdentityError:
                raise
            except Exception:
                sent_ok = False
            if not sent_ok:
                try:
                    with self.gui_lock:
                        _, u, keys = self._locate_text_chat(who, username)
                    self._require_chat_identity(u, who, keys, 'UIA 重试')
                    sent_ok = bool(u.send_text(text))
                except (G.ChatIdentityError, TargetUnavailable):
                    raise
                except Exception:
                    sent_ok = False
            G.log('UIA 发送耗时 %.1fs（打开会话+输入）' % (G.time.time() - t_open))
            if sent_ok:
                try:
                    leftover = self._input_value(u).strip()
                except Exception:
                    leftover = ''
                if leftover:
                    G.log('UIA 报发送成功但输入框还有 %d 字，补按一次回车' % len(leftover))
                    self.press_enter(False)
                return True
        except TargetUnavailable:
            G.log('[delivery] stage=resolve_target result=failed reason=target_unavailable')
            # 已经用尽三轮导航，交给 send_text 现有的身份异常出口停止换通道重试。
            raise G.ChatIdentityError('target_unavailable') from None
        except G.ChatIdentityError:
            raise
        except Exception as e:
            G.log_warn('UIA 发送异常：', repr(e))
        return False

    def recover_uia(self, reason=''):
        """强制重新热激活 UIA（rewrite gate byte + 校验），成功返回 True。

        微信跑久了会把 accessibility gate byte 归零，UIA 引擎就变成「假死」：
        能读消息、发不出去。以前只能重启桥接；这里让它自己救回来。
        """
        try:
            if self.gui is None:
                return False
            if not self.wechat_window_alive():
                with self.gui_lock:
                    self.UIA_CACHE['u'] = None
                G.log('UIA 重新热激活跳过（微信主窗当前不存在）')
                return False
            with self.gui_lock:
                u = self.gui._get_uia(refresh=True)
            self.UIA_CACHE['u'] = u
            if u is not None:
                G.log('UIA 已重新热激活%s' % ('（' + reason + '）' if reason else ''))
                return True
            G.log_warn('UIA 重新热激活失败%s' % ('（' + reason + '）' if reason else ''))
        except Exception as e:
            G.log('UIA 重新热激活异常：', repr(e))
        return False

    def keyboard_send(self, text, chat_display_name, chat_username=''):
        """统一核验会话后，用键盘粘贴正文并回读数据库确认。

        UIA 能读会话但不能发送时，仍可用 Win32 按键和剪贴板输入；定位和身份核验
        继续共用 UIA 的只读证据，不能向未知会话发送。
        代价：会抢前台、慢一些，所以只在 UIA 真的发不出去时用。
        """
        try:
            import ctypes
            import win32api
            import win32clipboard
            import win32con
            import win32gui
            user32 = ctypes.windll.user32
        except Exception as e:
            G.log('键盘通道不可用（缺少 win32 模块）：', repr(e))
            return False
        from targeting import TargetUnavailable
        try:
            with self.gui_lock:
                hwnd, uia, keys = self._locate_text_chat(chat_display_name, chat_username)
        except TargetUnavailable:
            return False

        def set_clip(t):
            opened = False
            for _ in range(5):
                try:
                    win32clipboard.OpenClipboard()
                    opened = True
                    break
                except Exception:
                    G.time.sleep(0.1)
            if not opened:
                raise RuntimeError('剪贴板打不开（可能被别的程序占用）')
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, t)
            finally:
                win32clipboard.CloseClipboard()

        def get_clip():
            """读出剪贴板当前文本；没有文本/读不到返回 None（M6 还原用）。"""
            for _ in range(5):
                try:
                    win32clipboard.OpenClipboard()
                    try:
                        return win32clipboard.GetClipboardData(win32clipboard.CF_UNICODETEXT)
                    finally:
                        win32clipboard.CloseClipboard()
                except Exception:
                    G.time.sleep(0.1)
            return None

        def restore_clip(saved):
            """发完把用户剪贴板还回去（M6）：以前发完剪贴板里一直留着要发的内容。"""
            if saved is None:
                return
            try:
                set_clip(saved)
            except Exception as e:
                G.log('键盘通道：还原剪贴板失败：', repr(e))

        def tap(vk, mods=()):
            for m in mods:
                user32.keybd_event(m, 0, 0, 0)
            user32.keybd_event(vk, 0, 0, 0)
            user32.keybd_event(vk, 0, 2, 0)
            for m in reversed(mods):
                user32.keybd_event(m, 0, 2, 0)
            G.time.sleep(0.12)

        t_start = G.time.time()
        saved_clip = get_clip()
        try:
            if win32gui.GetForegroundWindow() != hwnd:
                G.log('键盘通道：抢不到前台，放弃发送')
                return False
            self._require_chat_identity(uia, chat_display_name, keys, '键盘通道')
            set_clip(text)
            tap(ord('V'), (win32con.VK_CONTROL,))
            G.time.sleep(0.4)
            tap(win32con.VK_RETURN)
            want = str(text).strip()
            for _ in range(8):
                G.time.sleep(0.5)
                try:
                    msgs = self.db.get_messages(chat_username or chat_display_name, limit=5) or []
                except Exception:
                    msgs = []
                for m in msgs:
                    try:
                        if float(m.get('create_time') or 0) <= t_start:
                            continue
                    except Exception:
                        continue
                    if str(m.get('content') or '').strip() == want:
                        return True
            G.log_error('键盘通道：按键发了，但数据库里没确认到（可能发到了别的会话），这条按失败处理')
            return False
        except G.ChatIdentityError:
            raise
        except Exception as e:
            G.log('键盘通道按键失败：', repr(e))
            return False
        finally:
            restore_clip(saved_clip)

    # 连续发送失败只是暂时停发：以前一旦停掉就永久跳过，要重启桥接才恢复。
    def chat_paused(self, chat_username):
        """这个会话要不要停发：被移出群是长期失效，连续失败只停一会儿。"""
        if not chat_username:
            return False
        if chat_username in self.dead_chats:
            return True
        until = (self.dead_chat_until or {}).get(chat_username) or 0
        if until and G.time.time() < until:
            return True
        if until:
            self.dead_chat_until.pop(chat_username, None)
            G.log('重新尝试发送（停发时间已到）：', G.safe_name(chat_username))
        return False

    def pause_chat(self, chat_username, display):
        retry_sec = 300
        if not chat_username:
            return
        self.dead_chat_until[chat_username] = G.time.time() + retry_sec
        G.log('连续发送失败，先停掉这个会话 %d 分钟：%s'
              % (retry_sec // 60, G.safe_name(display)))

    def send_policy_allows(self, chat_username, chat_display_name):
        # 排队、模型生成或语音合成期间都可能改名单，发送前向内核核对当前规则。
        base = self.bot_url.rsplit('/webhook', 1)[0]
        headers = {'x-whale-bridge': '1', 'x-bot-token': self.token}
        try:
            response = G.LOCAL_HTTP.post(base + '/api/wechat/send-permission', headers=headers,
                                         json={'chatId': chat_username, 'name': chat_display_name}, timeout=3)
            policy = response.json() if response.status_code == 200 else None
            if isinstance(policy, dict) and policy.get('ok') is True:
                if policy.get('allowed') is True:
                    return True
                reason = {'not_whitelisted': '不在白名单内', 'unresolved_chat': '无法确认会话 ID'}.get(policy.get('reason'), '已静音')
                G.log_throttled('send-policy-' + reason, '发言范围：' + reason + '，跳过发送', ttl=60)
                return False
        except Exception:
            pass
        G.log_throttled('send-policy-unavailable', '发言范围：内核未确认允许发送，已暂停', ttl=60)
        return False

    def send_text(self, text, chat_display_name, chat_username='', force=False, quote_latest=False):
        from targeting import TargetUnavailable

        if chat_username and self.chat_paused(chat_username):
            G.log('跳过已失效的会话：', G.safe_name(chat_display_name))
            return False
        if chat_username and (not self.group_is_alive(chat_username)):
            self.dead_chats.add(chat_username)
            G.log('群里已经没有我了（被移出？），以后跳过：', G.safe_name(chat_display_name))
            return False
        if chat_username and self.is_self_chat(chat_username):
            # 微信里没有「和自己聊天」，只能发文件传输助手；否则会拿 wxid 去搜会话。
            chat_username, chat_display_name = 'filehelper', '文件传输助手'
        # 所有发送入口统一把「内部 id 当会话名」挡在这里。以前只有 care 会传 wxid，
        # 现在不管调用方是谁，都先换成昵称/备注；换不出来就放弃，别让 open_chat 空转。
        resolved = self.ui_chat_name(chat_username, chat_display_name)
        if not resolved:
            G.log('[delivery] stage=resolve_target result=failed reason=chat_name_unresolved chat=%s' % G.safe_id(chat_username or chat_display_name))
            G.log_throttled('send-no-name-' + str(chat_username or chat_display_name)[:18],
                            '发送跳过：%s 只拿到了内部 id，微信会话列表和搜索框都不认，先给 TA 加个备注再试' % G.safe_id(chat_username or chat_display_name),
                            ttl=600)
            return False
        chat_display_name = resolved
        display = G.safe_name(chat_display_name)
        account_ready = self.account_send_allowed('发送')
        with self.send_lock, G._SendStateScope(len(text)):
            if not self.send_policy_allows(chat_username, chat_display_name):
                return False
            if not self.sticker_quarantine_allows(chat_username, chat_display_name):
                return False
            t_start = G.time.time()
            allow_mark_dead = True
            if account_ready and not G.STICKER_TEST_ON and G.BG_SEND.get('enabled', True):
                G.SEND_STATE['start'] = G.time.time()
                try:
                    if self.bg_send(text, chat_display_name, chat_username):
                        self.fail_streak.pop(chat_username, None)
                        G.log('发送成功（后台通道，%.1fs）→ %s' % (G.time.time() - t_start, display))
                        return True
                except G.DraftDirtyError as e:
                    allow_mark_dead = False
                    G.log_error('发送暂停：%s' % e)
                    return False
                except G.ChatIdentityError as e:
                    G.log_error('会话核对没通过，这条不发（%s）：%s' % (display, e))
                    return False
                except Exception as e:
                    G.log('后台通道异常，继续用旧通道：', repr(e))
                if not G.BG_SEND.get('fallback', True):
                    allow_mark_dead = False
                    G.log_error('后台通道失败且已关闭前台兜底，这条不发：', display)
                    return False
            with self.gui_lock:
                if self.gui is None:
                    G.log('初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）')
                    self.gui = self.new_window_driver()
            self.bind_gui_window(self.gui)
            if quote_latest and G.QUOTE_REPLY:
                G.SEND_STATE['start'] = G.time.time()
                try:
                    # 不传 target_text：走上游 1.2.10 的「引用最近一条」路径
                    # （UIA 行控件 + 像素重心），图片/表情/换行也不会 OCR 匹配失败。
                    def quote_send():
                        with self.gui_lock:
                            _, u, keys = self._locate_text_chat(chat_display_name, chat_username)
                        self._require_chat_identity(u, chat_display_name, keys, '引用回复')
                        return self.gui.quote_msg(text, who=u.current_chat(), verify=False)

                    if self._with_target_window(quote_send):
                        G.log('引用回复成功 →', display)
                        return True
                    G.log('引用回复未确认浮层/发送，回退普通发送：', display)
                except (TargetUnavailable, G.ChatIdentityError):
                    return False
                except Exception as e:
                    G.log('引用回复失败，回退普通发送：', repr(e))
            uia_available = False
            try:
                uia_available = self.gui._get_uia() is not None
            except Exception:
                uia_available = False
            for attempt in (1, 2):
                t_att = G.time.time()
                G.SEND_STATE['start'] = G.time.time()
                try:
                    if self._with_target_window(lambda: self.uia_send(text, chat_display_name, chat_username)):
                        self.fail_streak.pop(chat_username, None)
                        G.log('发送成功（%.1fs）→ %s' % (G.time.time() - t_start, display))
                        return True
                    G.log('UIA 发送未成功（第 %d 次，%.1fs），准备重试' % (attempt, G.time.time() - t_att))
                except G.ChatIdentityError as e:
                    G.log_error('会话核对没通过，这条不发（%s）：%s' % (display, e))
                    return False
                except Exception as e:
                    G.log('UIA 发送异常（第 %d 次，%.1fs）：%r' % (attempt, G.time.time() - t_att, e))
                G.time.sleep(0.5)
            if uia_available:
                if self.recover_uia('发送失败'):
                    try:
                        if self._with_target_window(lambda: self.uia_send(text, chat_display_name, chat_username)):
                            self.fail_streak.pop(chat_username, None)
                            G.log('重新激活 UIA 后发送成功（%.1fs）→ %s' % (G.time.time() - t_start, display))
                            return True
                    except G.ChatIdentityError as e:
                        G.log_error('会话核对没通过，这条不发（%s）：%s' % (display, e))
                        return False
                    except Exception as e:
                        G.log('重新激活后仍失败：', repr(e))
                G.log('UIA 发不出去，跳过 OCR 兜底：', display)
            else:
                G.log_throttled('uia-unavailable', 'UIA 不可用：先试键盘通道；如果一直这样，到启动器「诊断」页点「UIA 自检」看原因（常见：微信需要重新登录、鲸鱼娘不是管理员而微信是、微信缩在托盘）', ttl=600)
                G.log('UIA 不可用，走 OCR 兜底')
            if G.KEYBOARD_FALLBACK:
                G.SEND_STATE['start'] = G.time.time()
                try:
                    if self.keyboard_send(text, chat_display_name, chat_username):
                        self.fail_streak.pop(chat_username, None)
                        G.log('发送成功（键盘通道，%.1fs）→ %s' % (G.time.time() - t_start, display))
                        return True
                except G.ChatIdentityError as e:
                    G.log_error('会话核对没通过，这条不发（%s）：%s' % (display, e))
                    return False
            if not uia_available:
                G.SEND_STATE['start'] = G.time.time()
                try:
                    with self.gui_lock:
                        try:
                            self.gui = self.new_window_driver()
                        except Exception as e:
                            G.log('重建窗口驱动失败：', repr(e))
                    self.bind_gui_window(self.gui)
                    _box = {}
                    _ocr_cancel = G.threading.Event()

                    def _ocr_send():
                        try:
                            if _ocr_cancel.is_set():
                                return
                            _box['r'] = self.with_window_on_top(lambda: not _ocr_cancel.is_set() and bool(self.gui.send_msg(text, chat_display_name, True)))
                        except Exception as _e:
                            _box['e'] = _e
                    _th = G.threading.Thread(target=_ocr_send, daemon=True)
                    _th.start()
                    _th.join(8)
                    if _th.is_alive():
                        G.log('OCR 兜底 8 秒没返回（卡在截屏），放弃这条，等下次消息')
                        _ocr_cancel.set()
                        resp = False
                    else:
                        if 'e' in _box:
                            raise _box['e']
                        resp = _box.get('r')
                    if bool(resp):
                        self.fail_streak.pop(chat_username, None)
                        return True
                    G.log('兜底发送失败：%s' % resp)
                except Exception as e:
                    G.log('兜底发送异常：%r' % e)
            if chat_username and allow_mark_dead:
                if G.time.time() - float(self.ACCOUNT.get('blockedAt') or 0) < 30:
                    G.log('账号窗口没确认，这条不算会话失效，先不发：', display)
                    return False
                self.fail_streak[chat_username] = self.fail_streak.get(chat_username, 0) + 1
                if self.fail_streak[chat_username] >= 2:
                    self.fail_streak[chat_username] = 0
                    self.pause_chat(chat_username, chat_display_name)
            G.log_error('发送最终失败，请把微信窗口保持在桌面、别最小化（这条 %d 字，正文不写日志）' % len(text))
            return False

    def send_at(self, member, text, chat_display_name, chat_username=''):
        """在群里真 @ 某个成员（UI 选人），失败返回 False 让调用方退回普通发送。"""
        if not member or not text:
            return False
        # 和 send_text 同一道闸：群名/成员名可能是 wxid，@ 的时候同样搜不到。
        chat_display_name = self.ui_chat_name(chat_username, chat_display_name)
        if not chat_display_name:
            return False
        if chat_username and (self.chat_paused(chat_username) or not self.group_is_alive(chat_username)):
            return False
        if not self.account_send_allowed('@ 成员'):
            return False
        with self.send_lock, G._SendStateScope(len(text)):
            if not self.send_policy_allows(chat_username, chat_display_name):
                return False
            if not self.sticker_quarantine_allows(chat_username, chat_display_name):
                return False
            with self.gui_lock:
                if self.gui is None:
                    G.log('初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）')
                    self.gui = self.new_window_driver()
            self.bind_gui_window(self.gui)
            try:
                ok = bool(self.with_window_on_top(lambda: self.gui.at_member(member, text, who=chat_display_name, verify=False)))
                if ok:
                    G.log('已 @ %s → %s' % (G.safe_name(member), G.safe_name(chat_display_name)))
                    return True
                G.log('@ 成员失败（%s），改用普通发送' % G.safe_name(member))
            except Exception as e:
                G.log('@ 成员异常：', repr(e))
        return False
