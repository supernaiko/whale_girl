"""只读取 Windows 剪贴板回执，不加载微信或发送按键。"""
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from file_transport import copy_file_to_clipboard
from sticker_transport import _message_matches

try:
    import win32clipboard as clipboard
    import win32con
except ImportError:
    clipboard = None


class FileRecordTest(unittest.TestCase):
    def test_parse_file_card_and_ignore_quote_with_same_title(self):
        msg = {'type': '文件/链接/卡片', 'sender_username': 'mock-user'}
        marker = {'name': '季度 简报.pdf'}
        for app_type, expected in [('6', True), ('57', False)]:
            msg['content'] = ('mock-user:\n<msg><appmsg><title>季度 简报.pdf</title>'
                              f'<type>{app_type}</type></appmsg></msg>')
            self.assertEqual(_message_matches(msg, marker, exact=True), expected)


@unittest.skipUnless(clipboard is not None, '需要 Windows 和 pywin32')
class FileClipboardTest(unittest.TestCase):
    def test_hdrop_round_trip(self):
        clipboard.OpenClipboard()
        try:
            if clipboard.EnumClipboardFormats(0):
                self.skipTest('为保留已有剪贴板内容，仅在剪贴板为空时执行')
        finally:
            clipboard.CloseClipboard()

        with tempfile.TemporaryDirectory() as tmp:
            file = Path(tmp) / '季度 简报.pdf'
            file.write_bytes(b'fixture')
            copy_file_to_clipboard(str(file))
            clipboard.OpenClipboard()
            try:
                paths = clipboard.GetClipboardData(win32con.CF_HDROP)
                self.assertEqual(paths, (str(file),))
                self.assertEqual(Path(paths[0]).name, file.name)
            finally:
                clipboard.EmptyClipboard()
                clipboard.CloseClipboard()


if __name__ == '__main__':
    unittest.main()
