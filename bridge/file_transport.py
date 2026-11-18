"""文件附件的路径核验与 Windows 剪贴板格式。"""
from pathlib import Path
import stat
import struct
import time


class FileChangedError(ValueError):
    pass


def validate_file(path, expected):
    try:
        candidate = Path(path)
        if not candidate.is_absolute():
            raise FileChangedError('需要绝对文件路径')
        real = candidate.resolve(strict=True)
        info = real.stat()
        if real != candidate:
            raise FileChangedError('文件解析路径与入队时不一致')
        if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 ** 3:
            raise FileChangedError('文件类型或大小超出允许范围')
        if info.st_size != expected[0]:
            raise FileChangedError('文件大小与入队时不一致')
        if str(info.st_mtime_ns) != expected[1]:
            raise FileChangedError('文件修改时间与入队时不一致')
        return str(real), (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
    except (OSError, TypeError) as exc:
        raise FileChangedError('文件已无法读取') from exc


def copy_file_to_clipboard(path):
    import pywintypes
    import win32clipboard as clipboard
    import win32con
    import win32gui

    # EmptyClipboard 会把所有权转给 OpenClipboard 的窗口。用本线程的隐藏窗口，避免借用微信句柄。
    owner = win32gui.CreateWindow('STATIC', '', 0, 0, 0, 0, 0, 0, 0, 0, None)
    try:
        for attempt in range(5):
            try:
                clipboard.OpenClipboard(owner)
                break
            except pywintypes.error:
                if attempt == 4:
                    raise
                time.sleep(0.05)
        try:
            # DROPFILES 的 pFiles 指向双空字符结尾的 Unicode 路径列表，fWide 必须为 1。
            dropfiles = struct.pack('<IiiII', 20, 0, 0, 0, 1)
            clipboard.EmptyClipboard()
            clipboard.SetClipboardData(win32con.CF_HDROP, dropfiles + (path + '\0\0').encode('utf-16-le'))
        finally:
            clipboard.CloseClipboard()
    finally:
        win32gui.DestroyWindow(owner)


def send_file_key(control, key):
    # 微信 4.2 的文件粘贴走 UIA SendKeys，仍由外层在每次按键前核对真实焦点。
    control.SendKeys(key, waitTime=0.1)
