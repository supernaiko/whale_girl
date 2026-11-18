import io, sys
p = sys.argv[1]
s = io.open(p, encoding="utf-8").read()
anchor = 'shutil.copyfile(zip_path, os.path.join(plugins_dir, f"{pid}.zip"))'
add = anchor + '\n    open(os.path.join(plugins_dir, f"{pid}.enabled"), "wb").close()'
if 'f"{pid}.enabled"' not in s:
    s = s.replace(anchor, add)
    io.open(p, "w", encoding="utf-8", newline="\n").write(s)
print("marker patched" if 'f"{pid}.enabled"' in s else "anchor missing")
