import json, io
p = r"C:\dev\whale-girl\app\data\plugins\yxn-chat.data\brain.json"
d = json.load(io.open(p, encoding="utf-8-sig"))
for b, items in list(d["buckets"].items())[:4]:
    print(b, "->", " / ".join(x["text"] for x in items[:5]))
