# keiba_scraper.py v4

import sys
import re
from datetime import datetime
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
except ImportError:
    print("pip install playwright && playwright install chromium を実行してください。")
    sys.exit(1)

try:
    from bs4 import BeautifulSoup
except ImportError:
    print("pip install beautifulsoup4 を実行してください。")
    sys.exit(1)


# ========== 設定 ==========

KEIBA_CODES = {
    "門別": "30", "盛岡": "35", "水沢": "36",
    "浦和": "42", "船橋": "43", "大井": "44", "川崎": "45",
    "金沢": "46", "笠松": "48", "名古屋": "49",
    "園田": "50", "姫路": "51", "高知": "54", "佐賀": "55",
}

# keiba.go.jp (NAR公式) の競馬場コード — netkeiba と異なる
# 姫路のみ未確認
KEIBAGO_CODES = {
    "門別": "36", "盛岡": "10", "水沢": "11",
    "浦和": "18", "船橋": "19", "大井": "20", "川崎": "21",
    "金沢": "22", "笠松": "23", "名古屋": "24",
    "園田": "27", "姫路": "28", "高知": "31", "佐賀": "32",
}

OUTPUT_DIR = Path(__file__).parent / "output"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

COND_MAP = {"稍": "稍重", "不": "不良", "良": "良", "重": "重",
            "稍重": "稍重", "不良": "不良"}

TIMEOUT_PAGE     = 20000  # ページロード待機 (ms)
TIMEOUT_SELECTOR = 10000  # セレクタ出現待機 (ms)


# ========== メイン処理 ==========

def main():
    print("=" * 60)
    print("  地方競馬 自動収集スクリプト v4（netkeiba + keiba.go.jp）")
    print("=" * 60)

    OUTPUT_DIR.mkdir(exist_ok=True)
    codes = list(KEIBA_CODES.keys())

    while True:
        # ===== レース選択 =====
        print("\n競馬場を選択してください:")
        for i, name in enumerate(codes, 1):
            print(f"  {i:2d}. {name}")

        while True:
            try:
                idx = int(input("\n番号を入力: ")) - 1
                if 0 <= idx < len(codes):
                    keibajo_name = codes[idx]
                    keibajo_code = KEIBA_CODES[keibajo_name]
                    break
            except ValueError:
                pass
            print("正しい番号を入力してください。")

        today = datetime.now().strftime("%Y%m%d")
        date_input = input(f"\nレース日（YYYYMMDD）[Enter={today}]: ").strip()
        race_date = date_input if date_input else today

        while True:
            try:
                race_no = int(input("レース番号（例: 3）: "))
                if 1 <= race_no <= 12:
                    break
            except ValueError:
                pass
            print("1〜12の数字を入力してください。")

        year  = race_date[:4]
        month = race_date[4:6]
        day   = race_date[6:8]
        race_id = f"{year}{keibajo_code}{month}{day}{race_no:02d}"

        url_shutuba  = f"https://nar.netkeiba.com/race/shutuba.html?race_id={race_id}"
        url_tan_fuku = f"https://nar.netkeiba.com/odds/?race_id={race_id}&type=b1"
        url_wide     = f"https://nar.netkeiba.com/odds/?race_id={race_id}&type=b5"
        url_sanren   = f"https://nar.netkeiba.com/odds/?race_id={race_id}&type=b7"

        print(f"\n収集対象: {keibajo_name} {year}/{month}/{day} {race_no}R")
        print(f"race_id: {race_id}")
        print("\nブラウザを起動中...")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            ctx = browser.new_context(user_agent=UA)
            page = ctx.new_page()

            # 出馬表
            print("\n[出馬表 取得中]")
            shutuba_data, shutuba_soup = scrape_shutuba(page, url_shutuba)

            # レース基本情報
            race_info = scrape_race_info(shutuba_soup)
            print(
                f"  距離:{race_info['距離']} / 馬場:{race_info['馬場種別']} "
                f"/ 状態:{race_info['馬場状態']} / クラス:{race_info['クラス']}"
            )

            # プレミアム限定馬への keiba.go.jp 補完
            premium_horses = [h for h in shutuba_data if h.get("過去成績_premium")]
            if premium_horses:
                print(f"\n[keiba.go.jp から過去成績補完中] {len(premium_horses)}頭がプレミアム限定")
                keibago_map = scrape_keibago_past5(page, keibajo_name, race_date, race_no)
                if keibago_map:
                    for h in shutuba_data:
                        no = h["馬番"]
                        if h.get("過去成績_premium") and no in keibago_map:
                            h["過去成績"] = keibago_map[no]
                            h["過去成績_premium"] = False
                            print(f"  馬番{no}: {len(h['過去成績'])}走補完完了")
                        elif h.get("過去成績_premium"):
                            print(f"  馬番{no}: keiba.go.jp でも取得できず")
                else:
                    print("  keiba.go.jp の取得に失敗しました")

            # 単勝・複勝
            print("\n[単勝・複勝オッズ 取得中]")
            tan_fuku = scrape_tan_fuku(page, url_tan_fuku)

            # ワイド
            print("\n[ワイドオッズ 取得中]")
            wide_top = scrape_combo_odds(page, url_wide, "ワイド")

            # 三連複
            print("\n[三連複オッズ 取得中]")
            sanren_top = scrape_combo_odds(page, url_sanren, "三連複")

            browser.close()

        if not shutuba_data:
            print("\n出馬表のデータが取得できませんでした。")
            print("race_idが正しいか確認してください:", url_shutuba)
        else:
            merged = merge_data(shutuba_data, tan_fuku)

            output_text = format_for_claude(
                merged, keibajo_name, race_date, race_no,
                race_info=race_info,
                wide_top=wide_top,
                sanren_top=sanren_top,
            )

            print("\n" + "=" * 70)
            print(output_text)
            print("=" * 70)

            filename = OUTPUT_DIR / f"{race_date}_{keibajo_name}{race_no}R.txt"
            filename.write_text(output_text, encoding="utf-8")
            print(f"\nファイル保存: {filename}")
            print("\n上記テキストをコピーして以下のAIに貼り付けてください:")
            print("  Claude  : https://claude.ai")
            print("  Copilot : https://copilot.microsoft.com")

        # ===== 続行確認 =====
        ans = input("\n別のレースを予想しますか？ [Y/n]: ").strip().lower()
        if ans in ("n", "no"):
            print("\n終了します。")
            break


# ========== 共通: ページ取得 ==========

def fetch_page(page, url, wait_selector=None, timeout=TIMEOUT_PAGE):
    page.goto(url, wait_until="domcontentloaded", timeout=timeout)
    if wait_selector:
        try:
            page.wait_for_selector(wait_selector, timeout=TIMEOUT_SELECTOR)
        except PlaywrightTimeout:
            print("  要素待機タイムアウト（続行）")
    return page.content()


# ========== 出馬表スクレイピング（dl.HorseList 対応） ==========

def scrape_shutuba(page, url):
    """出馬表を取得。(horses_list, soup) のタプルを返す"""
    html = fetch_page(page, url, ".HorseList, table")
    soup = BeautifulSoup(html, "html.parser")
    horses = []

    dl_list = soup.select("dl.HorseList")

    if not dl_list:
        # フォールバック: tr 構造 (旧ページ)
        return _scrape_shutuba_tr(soup), soup

    for dl in dl_list:
        try:
            h = _parse_dl_horse(dl)
            if h and h.get("馬番", "").isdigit():
                horses.append(h)
        except Exception:
            continue

    print(f"  出馬表: {len(horses)}頭取得")
    premium_count = sum(1 for h in horses if h.get("過去成績_premium"))
    if premium_count:
        print(f"  うち過去成績プレミアム限定: {premium_count}頭")
    return horses, soup


def _parse_dl_horse(dl):
    """dl.HorseList 1要素から horse dict を生成する"""
    h = {}

    # 取消チェック
    h["取消"] = (
        "Cancel" in (dl.get("class") or [])
        or bool(dl.select_one(".Cancel_Txt"))
    )

    # 枠番: class="Waku1" … "Waku8" (Waku_Horse ではない)
    for dt in dl.find_all("dt"):
        classes = " ".join(dt.get("class") or [])
        if re.search(r"\bWaku[1-8]\b", classes) and "Waku_Horse" not in classes:
            h["枠番"] = dt.get_text(strip=True)
            break

    # 馬番
    wh = dl.select_one("dt.Waku_Horse")
    h["馬番"] = wh.get_text(strip=True) if wh else ""

    # 馬名
    name_a = dl.select_one("dt.HorseName a")
    h["馬名"] = name_a.get_text(strip=True) if name_a else ""

    # 脚質: dt.Horse06 > div.Type > span
    type_el = dl.select_one(".Horse06 .Type span")
    h["脚質"] = type_el.get_text(strip=True) if type_el else ""

    # 馬体重 / 増減
    wt_el = dl.select_one(".Horse07 span.transition-color")
    if wt_el:
        wt_text = wt_el.get_text(separator="", strip=True)
        m = re.search(r"(\d+)kg\s*\(([+-]?\d+)\)", wt_text)
        if m:
            h["馬体重"] = int(m.group(1))
            h["体重増減"] = int(m.group(2))
        else:
            h["馬体重"] = "未発表"
            h["体重増減"] = 0
    else:
        h["馬体重"] = "未発表"
        h["体重増減"] = 0

    # 性齢 (dd.Jockey span.Barei → "牡3 黒鹿" の最初のトークン)
    barei = dl.select_one("dd.Jockey span.Barei")
    if barei:
        tokens = barei.get_text(strip=True).split()
        h["性齢"] = tokens[0] if tokens else ""
    else:
        h["性齢"] = ""

    # 騎手 (span.Change の "替" を除外)
    jockey_a = dl.select_one("dd.Jockey a")
    if jockey_a:
        for ch in jockey_a.select(".Change"):
            ch.decompose()
        h["騎手"] = jockey_a.get_text(strip=True)
    else:
        h["騎手"] = ""

    # 斤量 (dd.Jockey の最後のテキスト行から数値を抽出)
    jockey_dd = dl.select_one("dd.Jockey")
    h["斤量"] = ""
    if jockey_dd:
        for line in reversed(jockey_dd.get_text(separator="\n").split("\n")):
            cleaned = re.sub(r"[▲△☆★]", "", line).strip()
            if re.match(r"^\d{2}\.\d$", cleaned):
                h["斤量"] = cleaned
                break

    # 調教師 (dt.Horse05 の最初の a — "高知・目迫大輔" → "目迫大輔")
    trainer_els = dl.select(".Horse05 a")
    if trainer_els:
        raw = trainer_els[0].get_text(strip=True)
        h["調教師"] = re.sub(r"^[^・・]+[・・]", "", raw)
    else:
        h["調教師"] = ""

    # 過去5走 (netkeiba free 分)
    past_lis = dl.select("dd.Past_Wrapper li.Past")
    h["過去成績"] = [r for r in (_parse_netkeiba_past_li(li) for li in past_lis) if r]

    # プレミアム限定フラグ
    h["過去成績_premium"] = bool(dl.select("dd.Past_Wrapper li.Past5_Sample"))

    return h


def _parse_netkeiba_past_li(li):
    """li.Past 1要素から過去成績レコードを生成する"""
    rec = {}

    # 着順
    num_el = li.select_one(".Data04 .Num")
    if num_el:
        t = num_el.get_text(strip=True)
        rec["着順"] = t + "着" if t.isdigit() else t
    else:
        return None

    # 日付・競馬場
    data01 = li.select_one(".Data01")
    if data01:
        raw = data01.get_text(strip=True)
        m = re.match(r"(\d{2}/\d{2})\s*(.+?)\s*(\d+)R", raw)
        if m:
            rec["日付"] = m.group(1)
            rec["競馬場"] = m.group(2).strip()

    # 距離・馬場種別 (e.g. "ダ1400" → "ダ1400m")
    dist_el = li.select_one(".Data09")
    if dist_el:
        d = dist_el.get_text(strip=True)
        rec["距離"] = d + "m" if d and d[-1].isdigit() else d

    # 馬場状態
    cond_el = li.select_one(".Data11")
    if cond_el:
        rec["馬場"] = COND_MAP.get(cond_el.get_text(strip=True), cond_el.get_text(strip=True))

    # タイム
    time_el = li.select_one(".Data12")
    if time_el:
        rec["タイム"] = time_el.get_text(strip=True)

    # コーナー通過順
    corners = [c.get_text(strip=True) for c in li.select(".Data20 .Corner") if c.get_text(strip=True) != "-"]
    rec["通過"] = "-".join(corners)

    # 上がり3F ("後43.9" → "43.9")
    last3f_el = li.select_one(".Data21")
    if last3f_el:
        m2 = re.search(r"(\d{2}\.\d)", last3f_el.get_text(strip=True))
        rec["上がり"] = m2.group(1) if m2 else ""

    return rec


def _scrape_shutuba_tr(soup):
    """旧 tr.HorseList 構造へのフォールバック"""
    horses = []
    rows = (
        soup.select("tr.HorseList") or
        soup.select("tr.Shutuba_HorseList") or
        [r for r in soup.select("tbody tr") if len(r.find_all("td")) >= 6]
    )
    for row in rows:
        cells = row.find_all("td")
        if len(cells) < 6:
            continue
        try:
            horse = {
                "枠番": cells[0].get_text(strip=True),
                "馬番": cells[1].get_text(strip=True),
                "脚質": "",
                "過去成績": [],
                "過去成績_premium": True,
            }
            name_el = row.select_one(".HorseName a") or row.select_one("td:nth-child(4) a")
            horse["馬名"] = name_el.get_text(strip=True) if name_el else cells[3].get_text(strip=True)
            horse["性齢"] = cells[4].get_text(strip=True) if len(cells) > 4 else ""
            horse["斤量"] = cells[5].get_text(strip=True) if len(cells) > 5 else ""
            jockey_el = row.select_one(".Jockey a")
            horse["騎手"] = jockey_el.get_text(strip=True) if jockey_el else (cells[6].get_text(strip=True) if len(cells) > 6 else "")
            horse["調教師"] = ""
            weight_el = row.select_one(".Weight")
            if weight_el:
                wt = weight_el.get_text(strip=True)
                m = re.match(r"(\d+)\(([+-]?\d+)\)", wt)
                if m:
                    horse["馬体重"] = int(m.group(1))
                    horse["体重増減"] = int(m.group(2))
                else:
                    horse["馬体重"] = wt
                    horse["体重増減"] = 0
            else:
                horse["馬体重"] = "未発表"
                horse["体重増減"] = 0
            horse["取消"] = bool(row.select_one(".Cancel") or "取消" in row.get_text())
            if horse["馬番"].isdigit():
                horses.append(horse)
        except (IndexError, AttributeError):
            continue
    print(f"  出馬表(tr): {len(horses)}頭取得")
    return horses


# ========== レース基本情報 ==========

def scrape_race_info(soup):
    """出馬表 soup からレース条件（距離・馬場種別・馬場状態・クラス）を取得"""
    info = {"距離": "不明", "馬場種別": "不明", "馬場状態": "不明", "クラス": ""}

    # RaceData01: "16:05発走 / ダ1400m (右) / 天候:晴 / 馬場:稍"
    rd1 = soup.select_one(".RaceData01")
    if rd1:
        text = rd1.get_text(separator=" ", strip=True)
        m = re.search(r"(ダート|ダ|芝|障害|障)\s*(\d+)\s*m", text)
        if m:
            surface_map = {"ダ": "ダート", "障": "障害"}
            info["馬場種別"] = surface_map.get(m.group(1), m.group(1))
            info["距離"] = m.group(2) + "m"
        m2 = re.search(r"馬場[:：]\s*(良|稍重|稍|重|不良|不)", text)
        if m2:
            info["馬場状態"] = COND_MAP.get(m2.group(1), m2.group(1))

    # RaceData02: "2回 高知 5日目 サラ系３歳 3歳 10頭 ..."
    rd2 = soup.select_one(".RaceData02")
    if rd2:
        text2 = rd2.get_text(separator=" ", strip=True)
        m3 = re.search(r"(重賞|オープン|A[12]|B|C[1-3]|サラ系\S+)", text2)
        if m3:
            info["クラス"] = m3.group(1)

    return info


# ========== keiba.go.jp 過去成績補完 ==========

def scrape_keibago_past5(page, keibajo_name, race_date, race_no):
    """
    keiba.go.jp の DetalInfo ページから全馬の過去5走を取得する。
    返り値: {馬番(str): [past_race_dict, ...]}
    """
    code = KEIBAGO_CODES.get(keibajo_name)
    if not code:
        print(f"  keiba.go.jp コード未定義: {keibajo_name}")
        return {}

    year  = race_date[:4]
    month = race_date[4:6]
    day   = race_date[6:8]
    url = (
        f"https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/DebaTable"
        f"?k_babaCode={code}&k_raceDate={year}%2F{month}%2F{day}&k_raceNo={race_no}"
    )
    print(f"  keiba.go.jp: {url}")
    try:
        html = fetch_page(page, url, "section.cardTable")
        return _parse_keibago_table(html)
    except Exception as e:
        print(f"  keiba.go.jp 取得エラー: {e}")
        return {}


def _parse_keibago_table(html):
    """section.cardTable の tbody から全馬の過去5走を抽出する"""
    soup = BeautifulSoup(html, "html.parser")
    result = {}

    table = soup.select_one("section.cardTable table tbody")
    if not table:
        print("  section.cardTable が見つかりません")
        return result

    rows = table.find_all("tr", recursive=False)

    # tBorder が各馬の先頭行
    # 各馬は 5行ずつ (tBorder + 後続4行)
    i = 0
    while i < len(rows):
        if "tBorder" not in (rows[i].get("class") or []):
            i += 1
            continue

        # 5行取得
        horse_rows = rows[i: i + 5]
        if len(horse_rows) < 5:
            break

        horse_no, past5 = _parse_keibago_horse(horse_rows)
        if horse_no:
            result[horse_no] = past5

        i += 5

    print(f"  keiba.go.jp 解析: {len(result)}頭")
    return result


def _parse_keibago_horse(horse_rows):
    """keiba.go.jp の5行ブロックから (馬番, past5_list) を返す"""
    row1, row2, row3, row4, row5 = horse_rows

    # 馬番
    horse_no_td = row1.select_one("td.horseNum")
    if not horse_no_td:
        return None, []
    horse_no = horse_no_td.get_text(strip=True)

    # 過去5走 基本情報 (row1 の div.raceInfo × 5)
    race_infos = row1.select("td div.raceInfo")

    # タイム・コーナー・上がり (row4 の td[2:])
    row4_tds = row4.find_all("td")
    time_tds = row4_tds[2:] if len(row4_tds) >= 7 else row4_tds[max(0, len(row4_tds) - 5):]

    past5 = []
    for idx, ri in enumerate(race_infos[:5]):
        rec = _parse_keibago_raceinfo(ri)
        if rec is None:
            continue

        # タイム・コーナー・上がり を結合
        if idx < len(time_tds):
            t = time_tds[idx].get_text(strip=True)
            m1 = re.search(r"(\d:\d{2}\.\d)", t)
            if m1:
                rec["タイム"] = m1.group(1)
            m2 = re.search(r"(\d{1,2}(?:-\d{1,2}){1,3})", t)
            if m2:
                rec["通過"] = m2.group(1)
            m3 = re.search(r"(\d{2}\.\d)\s*$", t)
            if m3:
                rec["上がり"] = m3.group(1)

        past5.append(rec)

    return horse_no, past5


def _parse_keibago_raceinfo(ri):
    """div.raceInfo 1要素から過去成績レコードを生成する"""
    rec = {}

    # 着順 (span.pastRank)
    rank_el = ri.select_one(".pastRank")
    if not rank_el:
        return None
    rank_classes = " ".join(rank_el.get("class") or [])
    rank_text = rank_el.get_text(strip=True)

    if "rank_01" in rank_classes:
        rec["着順"] = "1着"
    elif "rank_02" in rank_classes:
        rec["着順"] = "2着"
    elif "rank_03" in rank_classes:
        rec["着順"] = "3着"
    elif rank_text.isdigit():
        rec["着順"] = rank_text + "着"
    else:
        rec["着順"] = rank_text  # "取止", "除外" 等

    # div.raceInfo のテキストを行で処理
    lines = [l.strip() for l in ri.get_text(separator="\n").split("\n") if l.strip()]

    for line in lines:
        # 日付・馬場・頭数: "26.03.17　良　12頭" or "26.03.17　稍重　12頭"
        m_date = re.search(
            r"(\d{2})\.(\d{2})\.(\d{2})\s+(良|稍重|稍|重|不良|不)\s+(\d+)頭", line
        )
        if m_date:
            rec["日付"] = f"20{m_date.group(1)}/{m_date.group(2)}/{m_date.group(3)}"
            rec["馬場"] = COND_MAP.get(m_date.group(4), m_date.group(4))
            continue

        # 競馬場・馬場種別・距離: "浦和　左1400　2番" or "Ｊ小倉　右1000　4番"
        # "Ｊ福島　芝右1200　16番"
        m_venue = re.search(
            r"([^\s　]+)\s*[　\s]+(芝)?[右左][内外]?(\d{3,4})\s*[　\s]+\d+番", line
        )
        if m_venue:
            venue = m_venue.group(1).lstrip("Ｊ")  # JRA場の全角"Ｊ"を除去
            surface = "芝" if m_venue.group(2) else "ダ"
            rec["競馬場"] = venue
            rec["距離"] = surface + m_venue.group(3) + "m"

    return rec if rec.get("日付") else None


# ========== 単勝・複勝オッズ ==========

def scrape_tan_fuku(page, url):
    html = fetch_page(page, url, "table.RaceOdds_HorseList_Table")
    soup = BeautifulSoup(html, "html.parser")

    tables = soup.select("table.RaceOdds_HorseList_Table")
    print(f"  RaceOdds_HorseList_Table: {len(tables)}テーブル検出")

    if not tables:
        print("  ⚠️ テーブルが見つかりません。フォールバック処理へ。")
        return _fallback_tan_fuku(html)

    def parse_odds_table(table):
        result = {}
        for row in table.select("tr"):
            tds = row.find_all("td")
            if len(tds) < 4:
                continue
            horse_no = None
            for td in tds[:3]:
                t = td.get_text(strip=True)
                if t.isdigit() and 1 <= int(t) <= 18:
                    horse_no = t
                    break
            if not horse_no:
                continue
            odds_el = row.select_one("td.Odds span") or row.select_one("td.Odds")
            if odds_el:
                odds_text = odds_el.get_text(strip=True)
            else:
                odds_text = "--"
                for td in reversed(tds):
                    t = td.get_text(strip=True)
                    if re.match(r"^\d{1,4}\.\d+$", t):
                        odds_text = t
                        break
            result[horse_no] = odds_text
        return result

    tan_dict  = parse_odds_table(tables[0])
    fuku_dict = parse_odds_table(tables[1]) if len(tables) >= 2 else {}

    print(f"  単勝: {len(tan_dict)}頭 / 複勝: {len(fuku_dict)}頭")

    odds_dict = {}
    for no in set(tan_dict) | set(fuku_dict):
        odds_dict[no] = {"単勝": tan_dict.get(no, "--"), "複勝": fuku_dict.get(no, "--")}

    print(f"  単複オッズ合計: {len(odds_dict)}頭取得")
    return odds_dict


def _fallback_tan_fuku(html):
    soup = BeautifulSoup(html, "html.parser")
    odds_dict = {}
    for row in soup.find_all("tr"):
        tds = row.find_all("td")
        if len(tds) < 3:
            continue
        horse_no = None
        for td in tds[:3]:
            t = td.get_text(strip=True)
            if t.isdigit() and 1 <= int(t) <= 18:
                horse_no = t
                break
        if not horse_no:
            continue
        nums = re.findall(r"\d{1,4}\.\d+", row.get_text())
        if nums and horse_no not in odds_dict:
            odds_dict[horse_no] = {"単勝": nums[0], "複勝": "--"}
    print(f"  フォールバック単複: {len(odds_dict)}頭取得")
    return odds_dict


# ========== ワイド・三連複 ==========

def scrape_combo_odds(page, url, label):
    html = fetch_page(page, url, "table.Odds_Table")
    all_combos = {}

    def extract_from_html(html_content):
        soup = BeautifulSoup(html_content, "html.parser")
        for td in soup.select("td.Odds[cart-item]"):
            cart = td.get("cart-item", "")
            m = re.search(r"_c0_(.+)$", cart)
            if not m:
                continue
            horses = m.group(1).split("_")
            if not all(h.isdigit() for h in horses):
                continue
            combo_key = "-".join(sorted(horses, key=int))
            raw = td.get_text(separator=" ", strip=True).replace(",", "")
            nums = re.findall(r"\d+\.\d+", raw)
            if not nums:
                continue
            odds_low = float(nums[0])
            if combo_key not in all_combos or odds_low < all_combos[combo_key]["オッズ"]:
                combo_display = "-".join(horses)
                odds_display = f"{nums[0]} - {nums[1]}" if len(nums) >= 2 else nums[0]
                all_combos[combo_key] = {
                    "組み合わせ": combo_display,
                    "オッズ": odds_low,
                    "オッズ表示": odds_display,
                }

    extract_from_html(html)

    if "type=b7" in url:
        soup_init = BeautifulSoup(html, "html.parser")
        options = soup_init.select("#list_select_horse option")
        horse_values = [opt.get("value") for opt in options if opt.get("value")]
        first_val = horse_values[0] if horse_values else None

        for val in horse_values:
            if val == first_val:
                continue
            try:
                page.select_option("#list_select_horse", value=val)
                page.wait_for_selector("td.Odds[cart-item]", timeout=TIMEOUT_SELECTOR)
                extract_from_html(page.content())
            except Exception:
                continue

    sorted_combos = sorted(all_combos.values(), key=lambda x: x["オッズ"])[:10]
    result = [{"組み合わせ": c["組み合わせ"], "オッズ": c["オッズ表示"]} for c in sorted_combos]

    print(f"  {label}: {len(result)}組取得（全{len(all_combos)}組中）")
    return result


# ========== データマージ ==========

def merge_data(shutuba, tan_fuku):
    for horse in shutuba:
        no = horse["馬番"]
        if no in tan_fuku:
            horse.update(tan_fuku[no])
        else:
            horse.setdefault("単勝", "--")
            horse.setdefault("複勝", "--")
    return shutuba


# ========== Claude貼り付け用テキスト整形 ==========

def format_for_claude(horses, keibajo, date, race_no,
                      race_info=None, wide_top=None, sanren_top=None):
    d = f"{date[:4]}/{date[4:6]}/{date[6:]}"
    ri = race_info or {}
    lines = [
        f"【{d} {keibajo} {race_no}R 出馬表 + オッズ + 過去成績】",
        f"収集時刻: {datetime.now().strftime('%H:%M:%S')}",
        "",
        f"レース条件: {ri.get('馬場種別','不明')} {ri.get('距離','不明')} "
        f"/ 馬場状態: {ri.get('馬場状態','不明')} / クラス: {ri.get('クラス','不明')}",
        "",
        f"{'馬番':>3} {'馬名':<14} {'性齢':>4} {'斤量':>4} "
        f"{'騎手':<8} {'調教師':<8} {'馬体重':>10} {'単勝':>6} {'複勝':>13} {'脚質':>4}",
        "-" * 90,
    ]

    for h in horses:
        if h.get("取消"):
            lines.append(f"  {h['馬番']:>2} {h['馬名']:<14} ※取消")
            continue

        weight = h.get("馬体重", "未発表")
        diff   = h.get("体重増減", 0)
        weight_str = (
            f"{weight}({'+' if diff >= 0 else ''}{diff})"
            if isinstance(weight, int) else str(weight)
        )

        lines.append(
            f"  {h['馬番']:>2} {h['馬名']:<14} {h.get('性齢',''):>4} "
            f"{h.get('斤量',''):>4} {h.get('騎手',''):<8} "
            f"{h.get('調教師',''):<8} {weight_str:>10} "
            f"{h.get('単勝','--'):>6} {h.get('複勝','--'):>13} "
            f"{h.get('脚質',''):>4}"
        )

    lines.append("-" * 90)

    # 各馬の過去成績
    lines.append("")
    lines.append("【各馬の過去成績（直近5走）】")
    lines.append(
        f"  {'馬番':>3} {'馬名':<14}  "
        f"{'日付':<12} {'競馬場':>6} {'距離':>7} {'馬場':>4} "
        f"{'着順':>4} {'タイム':>8} {'通過':>10} {'上がり':>6}"
    )
    lines.append("  " + "-" * 82)

    for h in horses:
        if h.get("取消"):
            continue
        no   = h["馬番"]
        name = h["馬名"]
        hist = h.get("過去成績", [])
        is_premium = h.get("過去成績_premium", False)

        prefix = f"  {no:>3} {name:<14}"

        if not hist:
            note = "（keiba.go.jp 未取得）" if is_premium else "（過去成績なし）"
            lines.append(f"{prefix}  {note}")
            continue

        for i, r in enumerate(hist):
            row_prefix = prefix if i == 0 else " " * (3 + 1 + 14 + 2)
            lines.append(
                f"{row_prefix}  "
                f"{r.get('日付',''):<12} "
                f"{r.get('競馬場',''):>6} "
                f"{r.get('距離',''):>7} "
                f"{r.get('馬場',''):>4} "
                f"{r.get('着順',''):>4} "
                f"{r.get('タイム',''):>8} "
                f"{r.get('通過',''):>10} "
                f"{r.get('上がり',''):>6}"
            )

    # ワイド人気上位
    if wide_top:
        lines.append("")
        lines.append("【ワイド 人気上位】")
        for i, c in enumerate(wide_top[:10], 1):
            lines.append(f"  {i:2d}位  {c['組み合わせ']:<8}  {c['オッズ']}倍")

    # 三連複人気上位
    if sanren_top:
        lines.append("")
        lines.append("【三連複 人気上位】")
        for i, c in enumerate(sanren_top[:10], 1):
            lines.append(f"  {i:2d}位  {c['組み合わせ']:<8}  {c['オッズ']}倍")

    lines += [
        "",
        "【Claudeへの指示】",
        "上記データをもとに、このレースで的中する可能性が最も高い買い方を予想してください。",
        "本命一点買いより、配当とのバランスが取れた買い目を優先してください。",
        "",
        "■ 分析観点（優先度順に考慮すること）",
        "・人気と実力の乖離：単勝オッズが高いのに過去成績が優秀な馬（穴馬）を特定する",
        "・距離・コース適性：過去成績と今回条件（ダート/芝・距離・回り）を照合",
        "・近走トレンド：直近3〜5走の着順・タイム・上がりが上昇傾向か下降傾向か",
        "・騎手の実力と状態：有力騎手か、このコースで実績があるか",
        "・脚質と展開：逃/先/差/追の構成から有利な脚質を判断",
        "・馬体重増減は、過去成績と照らして好走パターンに合致しているか",
        "",
        "■ 消去ステップ",
        "まず明確に不利な馬を理由とともに除外し、残った馬で買い目を構成してください。",
        "",
        "■ 出力フォーマット（必ずこの順で出力）",
        "1. 【消去馬】馬番・馬名・消去理由を箇条書き",
        "2. 【注目馬・穴馬】人気より実力が上と判断した馬を理由つきで列挙",
        "3. 【予想順位】1着候補／2着候補／3着候補 を各1〜2頭",
        "4. 【買い目と資金配分】",
        "   - 持ち金1000円・合計3点以内",
        "   - 券種（単勝/複勝/ワイド/三連複）と組み合わせ・金額を明示",
        "   - 各買い目の推定期待値（オッズ × 推定的中率）を記載",
        "5. 【総評】50字以内で結論",
    ]

    return "\n".join(lines)


if __name__ == "__main__":
    main()
