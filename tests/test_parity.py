"""PC版（keiba_scraper.py）とアプリ版（scraper.js）で、同じ入力から同じ結果になるかを確かめる。
使い方: python tests/test_parity.py（node と tests/node_modules の jsdom が要る）"""
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
import keiba_scraper as ks  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402

FX = HERE / "fixtures"


def rd(n):
    return (FX / n).read_text(encoding="utf-8")


def py_side():
    out = {}
    out["race_list"] = ks.parse_race_list(rd("race_list.html"))
    soup = BeautifulSoup(rd("shutuba.html"), "html.parser")
    out["shutuba"] = {"horses": ks.parse_shutuba(soup), "race_info": ks.scrape_race_info(soup)}
    out["shutuba_dl"] = ks.parse_shutuba(BeautifulSoup(rd("shutuba_dl.html"), "html.parser"))
    out["keibago"] = ks.parse_keibago(rd("keibago.html"))
    out["keibago_banei"] = ks.parse_keibago(rd("keibago_banei.html"))
    out["tan_fuku"] = ks.parse_tan_fuku(rd("odds_b1_ookuchi.html"))
    for k in "abcd":
        out[f"tf_{k}"] = ks.parse_tan_fuku(rd(f"tf_{k}.html"))
    for k in "abc":
        out[f"ninki_{k}"] = ks.parse_ninki_sanren(rd(f"ninki_{k}.html"))
    out["axis"] = ks.axis_values(BeautifulSoup(rd("axis.html"), "html.parser"))
    allc = {}
    ks._extract_combos(rd("odds_b5.html"), allc)
    out["wide"] = [{"組み合わせ": c["組み合わせ"], "オッズ": c["オッズ表示"]} for c in sorted(allc.values(), key=lambda x: x["オッズ"])[:10]]
    out["result"] = ks.parse_result(rd("result_real.html"))
    # collect_race の後半と同じ流れで本文を作る
    horses = json.loads(json.dumps(out["shutuba"]["horses"], ensure_ascii=False))
    for h in horses:
        d = out["keibago"].get(h["馬番"])
        if not d:
            continue
        if d["過去成績"] or h.get("要補完"):
            h["過去成績"] = d["過去成績"]
        h["条件別成績"], h["持ち時計"], h["コンビ"] = d["条件別成績"], d["持ち時計"], d["コンビ"]
    for h in horses:
        ks.add_derived_fields(h, "20261025")
    merged = ks.merge_data(horses, out["tan_fuku"])
    pr = ks.add_market_prob(merged)
    w = ks.check_data(merged)
    w.append("三連複テスト注記")
    dr2 = json.loads(json.dumps(out["result"]))
    dr2["4角"], dr2["条件"] = {}, ""
    day = [{"レース番号": 5, "結果": out["result"]}, {"レース番号": 3, "結果": dr2}]
    text = ks.format_for_ai(merged, "盛岡", "20261025", 1, out["shutuba"]["race_info"], out["wide"], out["wide"][:2], w, pr, day)
    out["text"] = re.sub(r"収集時刻: [^/\n]*", "収集時刻: X ", text)
    out["prompts"] = {f"{b}-{m}": ks.prompt_text(b, m, e) for b, m, e in [(1000, 3, 1.2), (3000, 5, 1.25), (500, 1, 1.0)]}
    ps = [0.35, 0.2, 0.12, 0.1, 0.08, 0.06, 0.04, 0.03, 0.015, 0.005]
    out["harville"] = ks.harville({str(i + 1): p for i, p in enumerate(ps)})
    out["summary"] = ks.compute_summary(json.loads(rd("records.json")))
    out["ai_block"] = ks.parse_ai_block(rd("ai_answer.txt"))
    return out


def norm(x):
    """35.0 と 35 を同じに扱う。並び順の違う dict も同じに扱う"""
    if isinstance(x, float) and x.is_integer():
        return int(x)
    if isinstance(x, dict):
        return {str(k): norm(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [norm(v) for v in x]
    return x


def diff(a, b, path, out):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            diff(a.get(k, "<無い>"), b.get(k, "<無い>"), path + [k], out)
    elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        for i, (x, y) in enumerate(zip(a, b)):
            diff(x, y, path + [i], out)
    elif a != b:
        out.append((path, a, b))


def main():
    py = norm(py_side())
    js = norm(json.loads(subprocess.run(["node", str(HERE / "parity.js")], capture_output=True, text=True, encoding="utf-8", check=True).stdout))
    found = []
    diff(py, js, [], found)
    for path, a, b in found[:20]:
        if isinstance(a, str) and isinstance(b, str) and "\n" in a:
            la, lb = a.split("\n"), b.split("\n")
            i = next((i for i, (x, y) in enumerate(zip(la, lb)) if x != y), min(len(la), len(lb)))
            print(f"差: {'/'.join(map(str, path))} {i + 1}行目\n  PC : {la[i] if i < len(la) else '<無い>'}\n  JS : {lb[i] if i < len(lb) else '<無い>'}")
        else:
            print(f"差: {'/'.join(map(str, path))}\n  PC : {str(a)[:200]}\n  JS : {str(b)[:200]}")
    print(f"PC版とアプリ版の差: {len(found)}件（比べた項目 {len(py)}）")
    sys.exit(1 if found else 0)


if __name__ == "__main__":
    main()
