import json, io, os
p = r"C:\dev\whale-girl\app\data\plugins\yxn-chat.data\config.json"
s = json.load(io.open(p, encoding="utf-8-sig"))
s["mode"] = "fallback"
s["minFreeRamMB"] = 512
io.open(p, "w", encoding="utf-8", newline="\n").write(json.dumps(s, ensure_ascii=False, indent=2))
print(s["mode"], s["minFreeRamMB"])
