"""
debug_scraper.py
netkeibaのHTML構造を確認してkeiba_scraper.pyのセレクタを修正するためのデバッグツール。

使い方:
    python debug_scraper.py
    → debug_output/ フォルダにHTMLとセレクタ候補が保存される
"""

from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup
from pathlib import Path
import time

# デバッグ用URL（門別11R: 2026年5月6日）
# race_id形式: YYYY + 競馬場コード(2桁) + MMDD + レース番号(2桁)
RACE_ID   = "202630050611"
URL_SHUTUBA = f"https://nar.netkeiba.com/race/shutuba.html?race_id={RACE_ID}"
URL_ODDS    = f"https://nar.netkeiba.com/odds/index.html?race_id={RACE_ID}&type=b6"
OUTPUT_DIR  = Path("debug_output")

def fetch(page, url, label):
    """指定URLを開いてHTMLを返す。networkidleまで最大30秒待機"""
    print(f"\n[{label}] 読み込み中: {url}")
    try:
        # networkidleで動的コンテンツの読み込みを待つ
        page.goto(url, wait_until="networkidle", timeout=30000)
    except Exception:
        # タイムアウト時もHTMLを取得して確認する
        print(f"  ※タイムアウト（現時点のHTMLで続行）")
    time.sleep(3)
    return page.content()

def analyze(html, label):
    """HTMLのテーブル・クラス構造を解析してレポートを返す"""
    soup = BeautifulSoup(html, "html.parser")
    lines = [f"=== {label} HTML解析レポート ===", f"HTML長: {len(html)} bytes", ""]

    # --- テーブル一覧 ---
    tables = soup.find_all("table")
    lines.append(f"【テーブル数】{len(tables)}")
    for i, t in enumerate(tables[:10]):
        rows = t.find_all("tr")
        lines.append(f"  table[{i}] class={t.get('class')} id={t.get('id')} → {len(rows)}行")
    lines.append("")

    # --- trのクラス一覧 ---
    tr_classes = {}
    for tr in soup.find_all("tr"):
        c = tuple(tr.get("class") or [])
        tr_classes[c] = tr_classes.get(c, 0) + 1
    lines.append("【trのクラス一覧】")
    for c, cnt in sorted(tr_classes.items(), key=lambda x: -x[1]):
        lines.append(f"  {list(c) or '(クラスなし)'} : {cnt}個")
    lines.append("")

    # --- tdを5個以上持つtrの最初の3行 ---
    lines.append("【tdが5個以上の行（最初の3件）】")
    found = 0
    for tr in soup.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) >= 5:
            texts = [td.get_text(strip=True)[:20] for td in tds[:10]]
            lines.append(f"  class={tr.get('class')} → {texts}")
            found += 1
            if found >= 3:
                break
    if not found:
        lines.append("  （見つかりませんでした）")
    lines.append("")

    # --- 馬名らしき要素を探す ---
    lines.append("【'HorseName'または'horse'を含むクラスの要素】")
    candidates = soup.find_all(class_=lambda c: c and any(
        kw in " ".join(c).lower() for kw in ["horse", "shutuba", "race_table"]
    ))
    for el in candidates[:10]:
        lines.append(f"  <{el.name}> class={el.get('class')} text='{el.get_text(strip=True)[:40]}'")
    if not candidates:
        lines.append("  （見つかりませんでした）")
    lines.append("")

    # --- JavaScript読み込み前の可能性チェック ---
    if len(html) < 5000:
        lines.append("⚠️ HTMLが非常に短い（JSで動的読み込みの可能性）")
        lines.append("   → headless=False で試してみてください")

    return "\n".join(lines)

def main():
    OUTPUT_DIR.mkdir(exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"]
        )
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 800},
        )
        page = context.new_page()

        # 出馬表
        html_shutuba = fetch(page, URL_SHUTUBA, "出馬表")
        (OUTPUT_DIR / "shutuba.html").write_text(html_shutuba, encoding="utf-8")
        report_s = analyze(html_shutuba, "出馬表")
        print(report_s)
        (OUTPUT_DIR / "report_shutuba.txt").write_text(report_s, encoding="utf-8")

        # オッズ
        html_odds = fetch(page, URL_ODDS, "オッズ")
        (OUTPUT_DIR / "odds.html").write_text(html_odds, encoding="utf-8")
        report_o = analyze(html_odds, "オッズ")
        print(report_o)
        (OUTPUT_DIR / "report_odds.txt").write_text(report_o, encoding="utf-8")

        browser.close()

    print(f"\n✅ デバッグファイルを {OUTPUT_DIR.resolve()} に保存しました。")
    print("   report_shutuba.txt と report_odds.txt の内容をClaudeに貼り付けてください。")

if __name__ == "__main__":
    main()
