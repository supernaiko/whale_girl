import io
p = r"C:\dev\whale-girl\custom\plugins\yxn-chat\plugin.js"
s = io.open(p, encoding="utf-8").read()
if "node:child_process" not in s:
    s = s.replace("const os = require('node:os');", "const os = require('node:os');\nconst { spawn } = require('node:child_process');", 1)
if "exports.generateLocalModelReply" not in s:
    s = s.replace("exports.calculateDelayMs = calculateDelayMs;", "exports.calculateDelayMs = calculateDelayMs;\nexports.generateLocalModelReply = generateLocalModelReply;", 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
