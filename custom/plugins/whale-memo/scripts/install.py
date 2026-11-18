#!/usr/bin/env python3
"""把本地构建写进鲸鲸的插件目录（等价于「从本地安装」的结果）。

鲸鲸的落盘格式（见 src/services/javascriptPlugins.js:52-79）：
  <id>.zip              原始安装包（人看的，宿主不读）
  <id>.flow.json        JSON：{id, api, kind, hooks, permissions, javascript}，
                        javascript 里装 plugin.js 的源码字符串
  <id>.flow-grant.json  {enabled, fullAccess, hash=sha256(flow.json 字节), settings}
  <id>.flow-settings.json  设置镜像（仅 settings 部分）
改代码后 hash 必须重算，否则校验失败、插件静默不加载。

用法：python scripts/install.py "C:\\Users\\1\\AppData\\Local\\Programs\\WhaleGirl\\data\\plugins"
"""
import hashlib
import json
import os
import shutil
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    plugins_dir = sys.argv[1]
    with open(os.path.join(ROOT, "plugin.json"), encoding="utf-8") as fh:
        meta = json.load(fh)
    pid = meta["Id"]
    with open(os.path.join(ROOT, "plugin.js"), encoding="utf-8") as fh:
        source = fh.read()
    flow = {
        "id": pid,
        "api": 4,
        "kind": meta["Kind"],
        "hooks": meta["Hooks"],
        "permissions": meta["Permissions"],
        "javascript": source,
    }
    if meta.get("ExecutionTimeoutMs"):
        flow["executionTimeoutMs"] = meta["ExecutionTimeoutMs"]
    if meta.get("IntervalSeconds"):
        flow["intervalSeconds"] = meta["IntervalSeconds"]
    code = json.dumps(flow, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    zip_path = os.path.join(ROOT, "dist", f"{pid}-{meta['Version']}.zip")
    if not os.path.exists(zip_path):
        print(f"missing {zip_path}, run build.py first")
        return 1

    os.makedirs(plugins_dir, exist_ok=True)
    grant_path = os.path.join(plugins_dir, f"{pid}.flow-grant.json")
    settings = {}
    if os.path.exists(grant_path):
        try:
            with open(grant_path, encoding="utf-8") as fh:
                settings = json.load(fh).get("settings") or {}
        except (OSError, ValueError):
            pass

    digest = hashlib.sha256(code).hexdigest()
    with open(os.path.join(plugins_dir, f"{pid}.flow.json"), "wb") as fh:
        fh.write(code)
    with open(os.path.join(plugins_dir, f"{pid}.flow-settings.json"), "w", encoding="utf-8") as fh:
        json.dump(settings, fh, ensure_ascii=False)
    with open(grant_path, "w", encoding="utf-8") as fh:
        json.dump({"enabled": True, "fullAccess": True, "hash": digest, "settings": settings}, fh, ensure_ascii=False)
    shutil.copyfile(zip_path, os.path.join(plugins_dir, f"{pid}.zip"))
    open(os.path.join(plugins_dir, f"{pid}.enabled"), "wb").close()

    print(f"installed {pid} v{meta['Version']} -> {plugins_dir}")
    print(f"  flow.json  {len(code)} bytes  sha256 {digest}")
    print(f"  settings   {json.dumps(settings, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
