import io
p = r"C:\dev\whale-girl\src\services\localReply.js"
s = io.open(p, encoding="utf-8").read()
old = "const SYSTEM = '你叫雅小奈，在微信私聊里随口回一句。口语、短，别解释，别自称AI，一次只回一句，不超过25字。';"
new = "const SYSTEM = '你是雅小奈，二十出头的女生，在微信上跟熟人聊天。说话短、口语、带点懒散；不解释、不劝人、不说教；一次只回一句，15字以内。示例：对方说「今天好累啊」你回「那就早点躺平」；对方说「在干嘛呢」你回「躺着刷手机呢」。';"
assert old in s
s = s.replace(old, new, 1)
s = s.replace("module.exports = { generate, freeMB, SYSTEM };", "module.exports = { generate, freeMB, SYSTEM, parseReply };", 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)

q = r"C:\dev\whale-girl\custom\plugins\yxn-chat\plugin.js"
t = io.open(q, encoding="utf-8-sig").read()
anchor = "async function generateLocalModelReply({ localModel, message, bucket, deadline }) {"
add = """let sharedLocalReply;
try {
  sharedLocalReply = require('../../../src/services/localReply');
} catch {
  sharedLocalReply = null;
}

async function generateLocalModelReply({ localModel, message, bucket, deadline }) {
  if (sharedLocalReply && localModel && localModel.enabled === true) {
    const timeoutMs = Math.min(60000, Math.max(5000, Number(deadline || 0) - Date.now()));
    const result = await sharedLocalReply.generate({ text: String(message?.text || ''), config: localModel, timeoutMs });
    if (result && result.ok) return result.text;
    if (result && localModel.serverUrl) return undefined;
  }"""
assert anchor in t
t = t.replace(anchor, add, 1)
io.open(q, "w", encoding="utf-8", newline="\n").write(t)
print("ok")
