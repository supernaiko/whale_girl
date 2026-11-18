import io
p = r"C:\dev\whale-girl\src\services\localReply.js"
s = io.open(p, encoding="utf-8").read()
start = s.index("function parseReply(")
end = s.index("/**", start)
new = """function parseReply(raw, prompt) {
  const clean = String(raw || '')
    .replace(/<\\|[^|]*\\|>/g, '')
    .split(/\\r?\\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('[ Prompt:') && !line.startsWith('Exiting'));
  const lines = String(raw || '').split(/\\r?\\n/);
  const marker = lines.findIndex(line => line.trim().startsWith('> '));
  let body = clean;
  if (marker >= 0) {
    const skip = Math.max(0, prompt.split('\\n').length - 1);
    body = [];
    for (const line of lines.slice(marker + 1 + skip)) {
      const row = line.replace(/<\\|[^|]*\\|>/g, '').trim();
      if (!row) { if (body.length) break; else continue; }
      if (row.startsWith('[ Prompt:') || row.startsWith('Exiting')) break;
      body.push(row);
    }
  }
  let reply = body.join(' ').replace(/^["'「」]+|["'「」]+$/g, '').trim();
  if (!reply || reply.length > 80) return '';
  if (/sorry|as an ai|无法|不能协助|不能提供/i.test(reply)) return '';
  return reply;
}

"""
s = s[:start] + new + s[end:]
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
