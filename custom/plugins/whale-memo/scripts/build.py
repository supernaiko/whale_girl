#!/usr/bin/env python3
"""把 plugin.json + plugin.js 打成鲸鲸可安装的 zip（根目录直接是这两个文件）。"""
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")


def main() -> int:
    with open(os.path.join(ROOT, "plugin.json"), encoding="utf-8") as fh:
        meta = json.load(fh)
    plugin_id = meta["Id"]
    version = meta["Version"]
    os.makedirs(DIST, exist_ok=True)
    target = os.path.join(DIST, f"{plugin_id}-{version}.zip")
    files = ["plugin.json", "plugin.js"]
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in files:
            zf.write(os.path.join(ROOT, name), name)
    print(f"built {target}")
    for name in files:
        print(f"  {name}  {os.path.getsize(os.path.join(ROOT, name))} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
