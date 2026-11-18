import io
p = r"C:\dev\whale-girl\src\services\localReply.js"
s = io.open(p, encoding="utf-8").read()
old = """const DEFAULT_PROMPT = (text, instruction) => [
  instruction || '你叫雅小奈，在微信私聊里随口回一句，口语、短、不要解释，不要自称AI，不超过30字。',
  '对方说：' + text,
  '你回：',
].join('\\n');"""
new = """const SYSTEM = '你叫雅小奈，在微信私聊里随口回一句。口语、短，别重复对方的话，别解释，别自称AI，一次只回一句，不超过25字。';
const DEFAULT_PROMPT = (text, instruction) => [
  '<|im_start|>system',
  (instruction || SYSTEM),
  '<|im_end|>',
  '<|im_start|>user',
  text,
  '<|im_end|>',
  '<|im_start|>assistant',
  '',
].join('\\n');"""
assert old in s
s = s.replace(old, new, 1)
s = s.replace("'--no-display-prompt', '--single-turn', '--no-warmup', '--jinja'],", "'--no-display-prompt', '--single-turn', '--no-warmup'],", 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("ok")
