import io
p = r"C:\dev\llama\ptest2.txt"
s = "<|im_start|>system\n你叫雅小奈，在微信私聊里随口回一句。口语、短，别重复对方的话，别解释，别自称AI，一次只回一句，不超过25字。\n<|im_end|>\n<|im_start|>user\n今天好累啊，不想上班\n<|im_end|>\n<|im_start|>assistant\n"
io.open(p, "w", encoding="utf-8", newline="\n").write(s)
