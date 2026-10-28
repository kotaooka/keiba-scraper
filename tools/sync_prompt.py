"""AI への指示文（PROMPT_TEXT・MODE_TEXT）を keiba_scraper.py から scraper.js へ書き写す。
指示文を直すときは keiba_scraper.py だけを直し、このスクリプトを実行する。
  python tools/sync_prompt.py          … scraper.js を書き換える
  python tools/sync_prompt.py --check  … 書き写し忘れがあれば終了コード 1（CI で使う）"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import keiba_scraper as ks  # noqa: E402

JS = ROOT / "android/app/src/main/assets/scraper.js"
BEGIN = "  // ===== 自動生成ここから：tools/sync_prompt.py が keiba_scraper.py の PROMPT_TEXT・MODE_TEXT から書く。直接直さない ====="
END = "  // ===== 自動生成ここまで ====="


def block():
    mode = json.dumps(ks.MODE_TEXT, ensure_ascii=False, indent=2).replace("\n", "\n  ")
    return "\n".join([
        BEGIN,
        "  // AI への指示文（{GOAL} などは買い方ごとの文、{BUDGET} などは予想の条件に置き換える）",
        f"  const PROMPT_TEXT = {json.dumps(ks.PROMPT_TEXT, ensure_ascii=False)};",
        "  // 買い方ごとの指示文の部品",
        f"  const MODE_TEXT = {mode};",
        END,
    ])


def main():
    src = JS.read_text(encoding="utf-8")
    i, j = src.find(BEGIN), src.find(END)
    if i < 0 or j < 0:
        sys.exit("scraper.js に自動生成の目印がありません")
    new = src[:i] + block() + src[j + len(END):]
    if "--check" in sys.argv:
        if new != src:
            print("scraper.js の指示文が keiba_scraper.py と違います。python tools/sync_prompt.py を実行してください")
            sys.exit(1)
        print("指示文は keiba_scraper.py と同じです")
        return
    if new != src:
        JS.write_text(new, encoding="utf-8")
        print("scraper.js の指示文を書き直しました")
    else:
        print("変更はありません")


if __name__ == "__main__":
    main()
