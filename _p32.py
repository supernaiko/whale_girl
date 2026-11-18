import io
p = r"C:\dev\whale-girl\src\services\localReply.js"
s = io.open(p, encoding="utf-8").read()
s = s.replace("'--no-display-prompt', '--single-turn', '--no-warmup'],", "'--no-display-prompt', '--no-warmup', '--no-jinja'],", 1)
old = """  const lines = String(raw || '').split(/\\r?\\n/);"""
new = """  const all = String(raw || '').split(/\\r?\\n/);
  const tag = all.map((line, i) => (line.includes('<|im_start|>assistant') ? i : -1)).filter(i => i >= 0).pop();
  if (tag !== undefined && tag >= 0) {
    const after = all.slice(tag + 1)
      .map(line => line.replace(/<\\|[^|]*\\|>/g, '').trim())
      .filter(line => line && !line.startsWith('[ Prompt:') && !line.startsWith('Exiting') && !line.startsWith('> '));
    let cut = after.join(' ').trim();
    if (cut.length > 80) cut = cut.slice(0, 80);
    if (/sorry|as an ai|无法|不能协助/i.test(cut)) return '';
    return cut.replace(/^["'「」]+|["'「」]+$/g, '').trim();
  }
  const lines = all;"""
assert old in s
s = s.replace(old, new, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
