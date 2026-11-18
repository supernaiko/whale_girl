"""纯参数与出站记录匹配测试，无需微信和 Windows UI。"""

from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from emoticon import matches_outgoing, parse_request


class EmoticonTests(unittest.TestCase):
    def test_normalizes_a_single_code(self):
        for value in ('微笑', '[微笑]', ' [微笑] '):
            self.assertEqual(parse_request({'chat': ' 会话 ', 'code': value}), ('会话', '[微笑]'))

    def test_rejects_invalid_code_or_target(self):
        for value in ('🙂', '[微笑][捂脸]', '[微笑', '微笑\n捂脸', 'a' * 21, {}):
            with self.assertRaisesRegex(ValueError, '^invalid_code$'):
                parse_request({'chat': '会话', 'code': value})
        for value in ('', '会话\n', 'a' * 121, ['会话']):
            with self.assertRaisesRegex(ValueError, '^invalid_chat$'):
                parse_request({'chat': value, 'code': '微笑'})

    def test_matches_only_exact_new_outgoing_text(self):
        want = {'type': '文本', 'content': '[微笑]', 'sort_seq': 12, 'sender_username': 'self'}
        rows = [
            {**want, 'sort_seq': 10}, {**want, 'sender_username': 'other'},
            {**want, 'sender_username': '', 'sender_id': 2},
            {**want, 'content': '[捂脸]'}, {**want, 'content': '[微笑]和[微笑]'},
            {**want, 'type': '动画表情'}, want,
        ]
        self.assertEqual(matches_outgoing(object(), rows, 10, 'self', '[微笑]'), [want])


if __name__ == '__main__':
    unittest.main()
