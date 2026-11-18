import io
p = r"C:\dev\whale-girl\tools\optimize-vocab.js"
s = io.open(p, encoding="utf-8").read()
s = s.replace("let maxTokens = 2400", "let maxTokens = 4000")
s = s.replace("maxTokens = 2400", "maxTokens = 4000")
s = s.replace("model = argOf('--model', 'deepseek-flash')", "model = argOf('--model', 'deepseek-chat')")
s = s.replace("const model = argOf('--model', 'deepseek-flash');", "const model = argOf('--model', 'deepseek-chat');")
s = s.replace("async function askDeepSeek({ key, model, system, user, maxTokens = 2400 }) {", "async function askDeepSeek({ key, model, system, user, maxTokens = 4000 }) {")
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
