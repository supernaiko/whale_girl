import io

p = r"C:\Users\1\Documents\deepseek-harness\default-workspace\whale-ops\tests\run-tests.js"
s = io.open(p, encoding="utf-8").read()
s = s.replace("(await gen('随便帮我弄个md', { model: async () => plan }))",
              "(await gen('帮我建个md文件', { model: async () => plan }))")
s = s.replace("(await gen('随便看看', { model: async () => '",
              "(await gen('在桌面看看文件', { model: async () => '")
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("patched")
