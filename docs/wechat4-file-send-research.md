# Windows 微信 4.x 文件发送研究

## 结论与上线顺序

Whale Girl 已有可复用的前台发送链路。用现有桥接完成联系人与账号核验，发送留到微信已经在前台且可安全操作的时机。用户允许短暂切换时再尝试激活，忙碌或锁屏时留在队列。严格零抢焦点的发送需要在具体微信构建上同时验证后台生成附件草稿和后台提交两个动作。当前证据足够开发实验适配器，还不足以默认开启它。

## 开源实现对照

| 实现 | 文件发送轨迹 | 对本项目的意义 |
|---|---|---|
| WCFerry | Python `send_file(path, receiver)` 发 `FUNC_SEND_FILE` RPC，由加载到微信进程的原生组件处理。 | 可绕过桌面焦点，代价是 DLL 注入、私有接口和构建绑定。公开版本证据指向 3.9.12 系列，无法用来证明适配 4.1/4.2。进程内故障及每次客户端升级的维护成本超过项目需求。[Python 客户端](https://github.com/lich0821/WeChatFerry/blob/master/clients/python/wcferry/client.py) · [原始构建说明](https://github.com/lich0821/WeChatFerry/blob/master/README.MD) · [可追溯分支](https://github.com/wukangcheng2944/WeChatFerry) |
| wxauto | `SendFiles` 调用 `_show()`、定位编辑区、写 CF_HDROP、发 Ctrl+V、检查编辑区后发 Enter。旧版还会 Ctrl+A。 | 可参考数据格式。Ctrl+A 会覆盖草稿，项目应先检查编辑区为空。[发送源码](https://github.com/cluic/wxauto/blob/main/wxauto/wxauto.py) · [剪贴板源码](https://github.com/cluic/wxauto/blob/main/wxauto/utils.py) |
| wxauto4 | 官方安装文档列出微信 4.1，免费版列至 4.1.8.107。本次查阅的官方 GitHub 主分支仅 README。可检查的公开衍生版 `chatbox.send_file` 写 CF_HDROP、`editbox.SendKeys('{Ctrl}v')`，随后 `sendbtn.Click()`。 | 衍生版的点击与按键不能证明官方版本的行为，也不能证明后台可发。剪贴板可在后台写，真实 Ctrl+V 的目标取决于前台线程的键盘焦点。[官方文档](https://docs.wxauto.org/docs/install.html) · [官方仓库](https://github.com/cluic/wxauto4) · [衍生版源码](https://github.com/AngeCoo/wxauto-4.0/blob/main/wxauto4/ui/chatbox.py) |
| wxrpa | `wxrpa/api.py` 的 `drop_files` 分配可移动全局内存，写入 Unicode DROPFILES，向 HWND 投递 WM_DROPFILES。作者标明 post 文件路径没实测。 | 实现忽略 PostMessageW 返回值，未验证接收窗口、附件草稿或提交。只能当作传输实验参考。[源码](https://github.com/Eyeing0721/wxrpa/blob/main/wxrpa/api.py) · [项目说明](https://github.com/Eyeing0721/wxrpa) |
| pywechat 的 pyweixin | 4.x 的 `Files.send_files_to_friend` 导航到目标，写 CF_HDROP，使用 pyautogui 发 Ctrl+V 和 Alt+S。 | 真实桌面输入依赖前台。源码每批最多 9 个是其实现策略，不能推出所有微信版本的上限。[文件发送](https://github.com/Hello-Mr-Crab/pywechat/blob/main/src/pyweixin/WeChatAuto.py) · [剪贴板](https://github.com/Hello-Mr-Crab/pywechat/blob/main/src/pyweixin/WinSettings.py) |
| YuYuWechat v3 | 服务接口排队后调用 bridge，仓库自带 pyweixin，文件路径同样是 CF_HDROP、Ctrl+V、Alt+S。项目说明列微信 4.1.6+，运行要求给出 4.1.8 与解锁桌面，并记录讲述人辅助启用 UIA 的经验。 | HTTP 后台接单和桌面后台发送是两件事。讲述人步骤是项目经验，需按实际构建验证。[v3 说明](https://github.com/xieyumc/YuYuWechat/tree/v3) · [服务入口](https://github.com/xieyumc/YuYuWechat/blob/v3/YuYuWechatV3_Server/wechat_app/views.py) · [内置 pyweixin](https://github.com/xieyumc/YuYuWechat/blob/v3/pywechat/pyweixin/WeChatAuto.py) |
| Whale Girl 内置 wechatauto 与桥接 | 内置实现有 CF_HDROP 路径。本仓库 `bridge/file_transport.py` 使用隐藏窗口持有剪贴板，`bridge/file_mixin.py` 复用发送锁与账号定位，`bridge/sticker_transport.py` 把 Ctrl+V、草稿检查、Enter 和发送证据串起来。 | 保留现有保护与待确认处理。前台链路已有实现，后台研究只需增加构建级探测和适配。 |

## WM_DROPFILES 跨进程与微信接收

**跨进程可以解析。** 本机 Windows NT 10.0.17763 上，两个独立 Python 进程以相同权限运行。发送端向自建 Tk 窗口投递已解锁的 `GMEM_MOVEABLE | GMEM_ZEROINIT` 块，`PostMessageW` 返回 1。发送端句柄为 `0x15e79b00008`，接收端 WM_DROPFILES 获得 `0x22776a20078`，`DragQueryFileW` 返回 1 个文件并解析出 `C:\probe.txt`。这是该系统构建对这条消息做跨进程转换的直接证据。测试窗口由实验程序自己处理 WM_DROPFILES，无需先注册真实鼠标投放。没有打开微信、操纵微信界面或发送文件。ReactOS 的公开实现也对跨进程 WM_DROPFILES 做专门转换，可用于理解机制，Windows 的内部实现以本机观测为准。[WM_DROPFILES](https://learn.microsoft.com/en-us/windows/win32/shell/wm-dropfiles) · [PostMessageW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postmessagew) · [ReactOS 实现](https://doxygen.reactos.org/d4/d8c/win32ss_2user_2user32_2windows_2message_8c_source.html)

普通 HGLOBAL 属于进程，不能拿本进程句柄当作目标进程的裸地址。WM_DROPFILES 的行为也不能外推到任意带指针的异步消息。此实测写法无需 `VirtualAllocEx` 或 `WriteProcessMemory`。远程虚拟内存地址本身也不能提供一个符合 `DragQueryFile` 和 `DragFinish` 契约的可移动 HGLOBAL。投递失败时释放本地块，成功后交给系统和接收方处理。接收方用 `DragFinish` 释放有效 HDROP，消息成功入队只说明 Windows 接受了投递。跨完整性级别可能被 UIPI 拒绝，记录错误并保持现有权限配置。[DragFinish](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-dragfinish) · [PostMessageW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-postmessagew)

**微信是否接受 WM_DROPFILES 仍未知。** 本机没有运行中的微信供测，查阅的源码也没有 4.1.x 或 4.2.x 主窗的可靠注册证据。按版本、语言与窗口类型枚举主窗和独立会话窗及其真实子 HWND，读取 `GetWindowLongPtrW(hwnd, GWL_EXSTYLE)` 的 `WS_EX_ACCEPTFILES (0x10)`。标志是传统接收能力的线索，不能单凭它确认微信处理逻辑或调用过哪个函数。没有标志也不能排除 OLE `RegisterDragDrop` / `IDropTarget`，资源管理器拖进去成功同样不能证明 WM_DROPFILES 有效。UIA 编辑器可能是虚拟元素，`NativeWindowHandle=0` 时须找到经验证的真实宿主 HWND。对能映射到真实窗口的编辑区，将屏幕坐标用 `ScreenToClient` 映射到该 HWND，填入 `DROPFILES.pt`。严禁根据标题猜测目标后对所有子窗广播。[DragAcceptFiles](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-dragacceptfiles) · [RegisterDragDrop](https://learn.microsoft.com/en-us/windows/win32/api/ole2/nf-ole2-registerdragdrop)

**提交是独立动作。** 粘贴实现普遍另发 Enter、Alt+S 或点发送。真实拖放和 WM_DROPFILES 在微信中的结果要分别实测。观察附件草稿、预览确认框和新增的发送气泡，只有确认对应草稿尚未提交时才执行一次提交。首选已验证的 UIA `InvokePattern.Invoke()`，它不注入键鼠，但 provider 可能激活窗口。如果查到真正的 Win32 Button HWND，可以单独试 `BM_CLICK`，微软文档指出非活动对话框上可能失败。`PostMessage(WM_KEYDOWN/UP, VK_RETURN)` 可以入队，是否触发发送取决于微信的窗口路由、控件与回车设置。给 Ctrl 和 V 分别投递按键消息也无法保证微信看到正确的修饰键状态。`WM_PASTE` 的标准编辑控件契约没有 CF_HDROP 文件支持，仅适合作为具体构建上的次级实验。后台提交未验证时，把任务标记为待确认，避免将可能存在的草稿再粘贴一份。[UIA Invoke](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationinvokepattern-invoke) · [BM_CLICK](https://learn.microsoft.com/en-us/windows/win32/controls/bm-click) · [WM_PASTE](https://learn.microsoft.com/en-us/windows/win32/dataxchg/wm-paste)

## Python 接入骨架

先保留生产默认的前台链路。后台实验开关绑定微信完整版本、窗口类型、Windows 构建和实测的投放目标。适配器沿用现有桥接的文件指纹、审批、账号与目标核验、发送锁、真实焦点核验和确认逻辑。下面的 `ui` 是现有桥接的薄适配层，其方法契约写在代码后。

```python
def submit_file(job, ui, capabilities):
    with ui.send_lock, ui.gui_lock:
        target = ui.resolve_exact(job)
        path, fingerprint = ui.validate_file(job)
        before = ui.snapshot(target)
        if not before.empty or not ui.allowed(job, target):
            return "deferred"

        if capabilities.background_file_send and ui.background_ready(target):
            if ui.unchanged(job, target, path, fingerprint, before):
                # 此动作和后台提交均需在该客户端构建上通过验收。
                # 调用抛异常或超时时，除非明确证实尚未入队，按结果不明处理。
                if ui.try_post_drop(target, path):
                    draft = ui.wait_exact_attachment(target, path, before)
                    if draft is None:
                        return ui.confirm_or_hold(job, target, before)
                    if not ui.can_commit(job, target, path, fingerprint, draft):
                        return ui.hold(job, target)
                    ui.invoke_send_once(target, draft)
                    return ui.confirm_or_hold(job, target, before)

        # 必须确定上一条路径尚未入队，才可走前台。
        return ui.send_with_existing_guarded_transport(job, target)
```

`snapshot` 包含账号、会话、窗口、空草稿及消息水位。`try_post_drop` 仅在明确未提交给 Windows 时返回 False。`wait_exact_attachment` 核对本任务附件数量、文件名及可读大小，文本占位符单独不足以证明文件身份。`can_commit` 重新校验权限、账号、接收者、草稿和文件指纹。`confirm_or_hold` 检查发送水位之后同一会话中新出现的己方附件及本地失败提示。`submitted` 表示本地提交有证据，收件端验收单独记录。适配层捕获投放后异常并保留任务为待确认，禁止异常驱动的重复发送。崩溃恢复时先查提交记录和草稿。

以下是本次双进程验证脚本。它不需要微信或第三方 Python 包，适用于带 Tk 的 64 位 Windows Python。脚本以自有窗口演示投递函数，微信实验应使用已核验的目标 HWND 与客户区坐标。

```python
import ctypes as c, ctypes.wintypes as w, sys, tkinter as tk, subprocess, struct
U=c.WinDLL('user32',use_last_error=True)
K=c.WinDLL('kernel32',use_last_error=True)
S=c.WinDLL('shell32',use_last_error=True)
def bind(d,n,r,*a):
 f=getattr(d,n); f.restype=r; f.argtypes=a; return f
P=c.c_void_p
I=c.c_ssize_t
post=bind(U,'PostMessageW',w.BOOL,w.HWND,w.UINT,w.WPARAM,w.LPARAM)
alloc=bind(K,'GlobalAlloc',P,w.UINT,c.c_size_t)
lock=bind(K,'GlobalLock',P,P)
unlock=bind(K,'GlobalUnlock',w.BOOL,P)
free=bind(K,'GlobalFree',P,P)
query=bind(S,'DragQueryFileW',w.UINT,P,w.UINT,w.LPWSTR,w.UINT)
finish=bind(S,'DragFinish',None,P)
if len(sys.argv)>1:
 data=struct.pack('<IiiII',20,0,0,0,1)+('C:\\probe.txt\0\0').encode('utf-16-le')
 h=alloc(0x42,len(data)); c.memmove(lock(h),data,len(data)); unlock(h)
 ok=post(int(sys.argv[1]),0x233,h,0); print('post',ok,c.get_last_error(),hex(h),flush=True)
 if not ok: free(h)
 sys.exit()
r=tk.Tk(); r.withdraw()
h=r.winfo_id()
CB=c.WINFUNCTYPE(I,w.HWND,w.UINT,w.WPARAM,w.LPARAM)
setproc=bind(U,'SetWindowLongPtrW',I,w.HWND,c.c_int,CB)
call=bind(U,'CallWindowProcW',I,I,w.HWND,w.UINT,w.WPARAM,w.LPARAM)
@CB
def proc(hwnd,msg,wp,lp):
 if msg==0x233:
  buf=c.create_unicode_buffer(512); n=query(wp,0xffffffff,None,0)
  if n: query(wp,0,buf,len(buf)); finish(wp)
  print('received',hex(wp),n,buf.value,flush=True); return 0
 return call(old,hwnd,msg,wp,lp)
old=setproc(h,-4,proc)
p=subprocess.Popen([sys.executable,__file__,str(h)])
r.after(1500,r.quit); r.mainloop(); p.wait()
```

### 回退、用户影响与验收

1. 后台实验只对已打开且能精确识别的会话启用。若需要在用户的主窗中切换聊天，主窗内容本身就会变化。独立聊天窗口可以隔离这种影响，但首次创建、最小化和恢复是分别验证的动作。
2. 后台能力缺失或明确未投递时，若微信已在前台且目标编辑器拥有焦点，走现有 CF_HDROP。否则等待用户空闲且允许短暂激活，再用现有定位与焦点保护。检查 `GetForegroundWindow`、`GetGUIThreadInfo`、UIA 焦点和 `GetLastInputInfo`。在粘贴和提交前各核验一次。若用户主动切走，停止按键，保留原窗口或草稿供核查。
3. 按现有实现用 `OpenClipboard(owner)`、`EmptyClipboard`、`SetClipboardData`、`CloseClipboard`，用 `GetClipboardSequenceNumber` 检测并发写入。剪贴板会影响其它应用。若实现恢复，只对能完整保存的格式启用，并在持有剪贴板锁时确认版本仍是本任务写入的值。遇到延迟渲染或未知格式时按用户策略延期。前台发键走现有 UIA SendKeys 或验证过的 SendInput。窗口恢复仅在原窗口仍有效、微信仍是本任务激活的前台且用户未重新操作时尝试。
4. 一旦附件可能进入草稿、发送动作可能已触发或结果不明，停止自动回退。日志只记阶段、错误类型或 Win32 错误码、窗口状态、数量与时序。监听本地新消息对照，可进一步让自有测试接收端核对 SHA-256。
5. 验收矩阵至少覆盖完整 4.1.x 与 4.2.x 构建、主窗与独立聊天窗、前台与后台被覆盖、最小化、不同语言/DPI、聊天快捷键、正在输入、剪贴板竞争、同名联系人、窗口销毁重建和不同权限。先在自建接收窗重复实验，再用文件传输助手或自有测试账号，分别测试资源管理器拖入、单次 WM_DROPFILES 只观察、UIA Invoke、前台回退。记录前台窗口变化事件而非仅比较首尾，避免漏掉短暂抢焦点。使用唯一中文文件名的无敏感小文本，覆盖已有草稿和异步超时，确认无错发与重发。后台方案只有在附件与发送结果均可观察、前台从未变化、正常键鼠输入未受影响时才算通过。

