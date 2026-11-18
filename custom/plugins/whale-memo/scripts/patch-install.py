import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
old = '    if meta.get("ExecutionTimeoutMs"):\n        flow["executionTimeoutMs"] = meta["ExecutionTimeoutMs"]'
new = old + '\n    if meta.get("IntervalSeconds"):\n        flow["intervalSeconds"] = meta["IntervalSeconds"]'
if new not in s:
    s = s.replace(old, new)
    io.open(p, "w", encoding="utf-8").write(s)
print("patched" if new in s else "pattern missing")
