import io
p = r"C:\dev\whale-girl\custom\plugins\yxn-chat\plugin.js"
s = io.open(p, encoding="utf-8").read()
old = """    const marker = lines.findIndex((line) => line.trim().startsWith('> '));
    if (marker < 0) return undefined;
    const body = [];
    for (const line of lines.slice(marker + 1)) {"""
new = """    const marker = lines.findIndex((line) => line.trim().startsWith('> '));
    if (marker < 0) return undefined;
    const body = [];
    const skip = Math.max(0, prompt.split('\\n').length - 1);
    for (const line of lines.slice(marker + 1 + skip)) {"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
