import io, json, sys
plugins = sys.argv[1]
settings = {"owners": ["wxid_REPLACE_ME"], "hour": 21, "minLines": 10}
grant_path = plugins + "\\whale-memo.flow-grant.json"
with io.open(grant_path, encoding="utf-8-sig") as fh:
    grant = json.load(fh)
grant["settings"] = settings
with io.open(grant_path, "w", encoding="utf-8", newline="\n") as fh:
    json.dump(grant, fh, ensure_ascii=False, separators=(",", ":"))
with io.open(plugins + "\\whale-memo.flow-settings.json", "w", encoding="utf-8", newline="\n") as fh:
    json.dump(settings, fh, ensure_ascii=False, separators=(",", ":"))
print("grant", json.dumps(grant, ensure_ascii=False))
