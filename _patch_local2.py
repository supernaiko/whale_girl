import io, re
p = r"C:\dev\whale-girl\custom\plugins\yxn-chat\plugin.js"
s = io.open(p, encoding="utf-8").read()
m = re.search(r"async function generateLocalModelReply\([^)]*\) \{.*?\n\}\n", s, re.S)
assert m, "no stub"
new = open(r"C:\dev\whale-girl\_local_impl.js", encoding="utf-8").read()
s = s[:m.start()] + new + s[m.end():]
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("patched")
