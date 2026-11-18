import io
p = r"C:\dev\whale-girl\src\http\routes\yxn.js"
s = io.open(p, encoding="utf-8").read()
s = s.replace("const { json, readBody } = require('../util');",
              "const { json, readBody } = require('../util');\nconst localReply = require('../../services/localReply');", 1)
anchor = """  router.get('/api/yxn/voice', (runtime, req, res) => {"""
block = """  router.post('/api/yxn/chat/local-test', async (runtime, req, res) => {
    const { dataDir } = runtime.config.paths;
    const body = (await readBody(req)) || {};
    const model = readJson(path.join(chatDir(dataDir), 'local-model.json'), { enabled: false, cmd: '', modelPath: '', maxTokens: 64, minFreeRamMB: 512 });
    const timeoutMs = Math.min(120000, Math.max(5000, Number(body.timeoutMs) || 60000));
    const result = await localReply.generate({
      text: body.text, instruction: body.instruction, config: model, timeoutMs,
    });
    let job = null;
    if (result.ok && body.send) {
      const chat = String(body.chat || '文件传输助手');
      if (chat !== '文件传输助手' && chat !== 'filehelper') {
        return json(res, 400, { ok: false, error: '调试发送目前只支持文件传输助手' });
      }
      const item = runtime.reminders.enqueueNow({
        wxid: 'filehelper', name: '文件传输助手', chatType: 'private', text: result.text, kind: 'debug',
      });
      job = { jobId: item.id, status: 'queued', chat: '文件传输助手' };
    }
    return json(res, 200, { ok: result.ok, ...result, job });
  });

  router.get('/api/yxn/voice', (runtime, req, res) => {"""
assert anchor in s
s = s.replace(anchor, block, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
