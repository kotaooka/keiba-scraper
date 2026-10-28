"""設定値（判断の基準・件数・時刻）が PC版・アプリ（scraper.js）・Kotlin でそろっているかを確かめる。
使い方: python tests/test_config.py"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import keiba_scraper as ks  # noqa: E402

js = json.loads(subprocess.run(
    ["node", "-e", "const g={};new Function('globalThis','window',require('fs').readFileSync(process.argv[1],'utf8'))(g,g);"
     "process.stdout.write(JSON.stringify(g.KS.CONFIG))", str(ROOT / "android/app/src/main/assets/scraper.js")],
    capture_output=True, text=True, encoding="utf-8", check=True).stdout)
kt_src = (ROOT / "android/app/src/main/java/io/github/kotaooka/keiba/Config.kt").read_text(encoding="utf-8")
kt = {k: float(v) for k, v in re.findall(r"const val (\w+) = ([\d.]+)", kt_src)}

errors = []
# PC版にもある値
for name in ("PAYBACK_MAX_ODDS", "CLV_VIEW_POINTS", "VERDICT_MIN_RACES", "DAY_RESULTS_MAX"):
    if getattr(ks, name) != js.get(name):
        errors.append(f"{name}: PC版 {getattr(ks, name)} ／ アプリ {js.get(name)}")
# Kotlin にもある値
for name, v in kt.items():
    if js.get(name) is None or float(js[name]) != v:
        errors.append(f"{name}: Kotlin {v} ／ アプリ {js.get(name)}")
# 指示文の「元返し」の倍率が設定値どおりか
if f"下限が{ks.PAYBACK_MAX_ODDS}倍以下" not in ks.prompt_text():
    errors.append("指示文に PAYBACK_MAX_ODDS が入っていない")

for e in errors:
    print("差:", e)
print(f"設定値の確認：{'差 ' + str(len(errors)) + '件' if errors else 'そろっています'}（アプリ {len(js)}項目・Kotlin {len(kt)}項目）")
sys.exit(1 if errors else 0)
