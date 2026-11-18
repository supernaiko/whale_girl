"""在桥接已有的本机单实例套接字上接收内置表情命令。"""

import hmac
import json
import select
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

from emoticon import outcome, parse_request


def start_emoticon_http(listener, runtime, log):
    address = listener.getsockname()

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            self.request.settimeout(2)
            super().setup()

        def log_message(self, *_args):
            # 默认日志包含完整 URL，调用方可能把凭据误放在查询串里。
            pass

        def reply(self, status, data):
            body = json.dumps(data).encode('utf-8')
            try:
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except OSError:
                pass

        def do_POST(self):
            if self.path != '/send_emoticon':
                return self.reply(404, outcome('failed', 'unknown_route'))
            token = str(runtime.token or '').encode('utf-8')
            got = self.headers.get('x-bot-token', '').encode('utf-8')
            if (self.headers.get('Origin') is not None
                    or self.headers.get('Host') != f'{address[0]}:{address[1]}'
                    or not token or not hmac.compare_digest(got, token)):
                return self.reply(403, outcome('failed', 'bridge_auth_failed'))
            if self.headers.get_content_type() != 'application/json':
                return self.reply(415, outcome('failed', 'invalid_request'))
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 1024 or self.headers.get('Transfer-Encoding') is not None:
                    raise ValueError('invalid_request')
                chat, code = parse_request(json.loads(self.rfile.read(length)))
            except (OSError, UnicodeError, ValueError) as exc:
                reason = str(exc) if str(exc) in {'invalid_chat', 'invalid_code'} else 'invalid_request'
                return self.reply(400, outcome('failed', reason))

            deadline = time.monotonic() + 15

            def active():
                # 客户端取消后不再点发送，也不接受本连接上的下一条请求。
                return time.monotonic() < deadline and not select.select([self.connection], [], [], 0)[0]

            try:
                result = runtime.send_emoticon(chat, code, active)
            except Exception as exc:
                log('[emoticon] type=%s detail=handler' % type(exc).__name__)
                result = outcome('unconfirmed', 'delivery_unverified')
            log('[emoticon] status=%s reason=%s' % (result['status'], result['reason'] or '-'))
            self.reply(200, result)

    server = HTTPServer(address, Handler, bind_and_activate=False)
    server.socket.close()
    server.socket = listener

    def serve():
        import pythoncom
        # UIA 控件应在发送线程的 COM apartment 内使用。
        pythoncom.CoInitialize()
        try:
            server.serve_forever()
        finally:
            pythoncom.CoUninitialize()

    threading.Thread(target=serve, name='emoticon-http', daemon=True).start()
    return server
