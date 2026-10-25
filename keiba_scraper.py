# keiba_scraper.py v5
# 地方競馬の出馬表・オッズ・過去成績を netkeiba / keiba.go.jp から集め、
# AI に貼り付けるテキストを作る。
#
# 使い方:
#   python keiba_scraper.py                 … 対話形式（当日の開催一覧から選ぶ）
#   python keiba_scraper.py 盛岡 5           … 当日の盛岡5R を直接取得
#   python keiba_scraper.py 盛岡 5 1025      … 日付を指定（YYYYMMDD / MMDD / M/D も可）

import re
import subprocess
import sys
import unicodedata
from datetime import datetime
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
except ImportError:
    print("playwright が入っていません。setup.bat を実行してください。")
    sys.exit(1)

try:
    from bs4 import BeautifulSoup
except ImportError:
    print("beautifulsoup4 が入っていません。setup.bat を実行してください。")
    sys.exit(1)


# ========== 設定 ==========

# netkeiba の競馬場コード（race_id の5〜6桁目）
KEIBA_CODES = {
    "門別": "30", "盛岡": "35", "水沢": "36",
    "浦和": "42", "船橋": "43", "大井": "44", "川崎": "45",
    "金沢": "46", "笠松": "48", "名古屋": "49",
    "園田": "50", "姫路": "51", "高知": "54", "佐賀": "55",
    "帯広(ば)": "65",
}
CODE_TO_NAME = {v: k for k, v in KEIBA_CODES.items()}

# keiba.go.jp (NAR公式) の競馬場コード — netkeiba と異なる
# 姫路は未確認。帯広(ばんえい)は未定義のため過去成績の補完をしない
KEIBAGO_CODES = {
    "門別": "36", "盛岡": "10", "水沢": "11",
    "浦和": "18", "船橋": "19", "大井": "20", "川崎": "21",
    "金沢": "22", "笠松": "23", "名古屋": "24",
    "園田": "27", "姫路": "28", "高知": "31", "佐賀": "32",
}

NETKEIBA = "https://nar.netkeiba.com"
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
RETRY            = 2      # ページ取得の試行回数


# ========== 表示幅（全角=2）を考慮した整形 ==========

def disp_width(s):
    """全角文字を2、半角文字を1として表示幅を返す"""
    return sum(2 if unicodedata.east_asian_width(c) in "FWA" else 1 for c in str(s))


def pad(s, width, align="<"):
    """表示幅で左寄せ(<)・右寄せ(>)する"""
    s = str(s)
    space = " " * max(0, width - disp_width(s))
    return s + space if align == "<" else space + s


# ========== 入力処理 ==========

def parse_date(text, today=None):
    """日付入力を YYYYMMDD に正規化する。不正なら None を返す。
    受け付ける形式: 空(=当日) / YYYYMMDD / MMDD / M/D / YYYY/M/D / YYYY-MM-DD"""
    today = today or datetime.now()
    t = text.strip()
    try:
        if not t:
            d = today
        elif re.fullmatch(r"\d{8}", t):
            d = datetime.strptime(t, "%Y%m%d")
        elif re.fullmatch(r"\d{4}", t):
            d = datetime(today.year, int(t[:2]), int(t[2:]))
        else:
            parts = [p for p in re.split(r"[/\-.]", t) if p]
            if len(parts) == 2:
                d = datetime(today.year, int(parts[0]), int(parts[1]))
            elif len(parts) == 3:
                d = datetime(int(parts[0]), int(parts[1]), int(parts[2]))
            else:
                return None
    except ValueError:
        return None
    return d.strftime("%Y%m%d")


def ask_date():
    today = datetime.now().strftime("%Y%m%d")
    while True:
        d = parse_date(input(f"\nレース日 [Enter={today[:4]}/{today[4:6]}/{today[6:]}]（例: 1025, 10/25）: "))
        if d:
            return d
        print("日付として読めませんでした。例: 20261025 / 1025 / 10/25")


def ask_choice(prompt, n, default=None):
    """1〜n の番号入力。Enter で default を返す"""
    while True:
        s = input(prompt).strip()
        if not s and default is not None:
            return default
        if s.isdigit() and 1 <= int(s) <= n:
            return int(s)
        print(f"1〜{n} の番号を入力してください。")


# ========== 共通: ページ取得 ==========

def fetch_page(page, url, wait_selector=None, timeout=TIMEOUT_PAGE):
    """ページを開いて HTML を返す。失敗時は RETRY 回まで再試行し、最後は None を返す"""
    for attempt in range(1, RETRY + 1):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=timeout)
            if wait_selector:
                try:
                    page.wait_for_selector(wait_selector, timeout=TIMEOUT_SELECTOR)
                except PlaywrightTimeout:
                    print("  要素待機タイムアウト（取得できた分で続行）")
            return page.content()
        except Exception as e:
            print(f"  ページ取得失敗（{attempt}/{RETRY}回目）: {type(e).__name__}")
    return None


# ========== 開催一覧 ==========

def fetch_race_list(page, race_date):
    """指定日の開催一覧を取得する。
    返り値: [{"name": 競馬場名, "races": [{"race_id","no","time","title","heads"}...]}, ...]"""
    url = f"{NETKEIBA}/top/race_list_sub.html?kaisai_date={race_date}"
    html = fetch_page(page, url)
    if not html:
        return []
    return parse_race_list(html)


def parse_race_list(html):
    soup = BeautifulSoup(html, "html.parser")
    venues = []
    for dl in soup.select("dl.RaceList_DataList"):
        races = []
        for li in dl.select("li.RaceList_DataItem"):
            a = li.select_one("a[href*='race_id=']")
            if not a:
                continue
            m = re.search(r"race_id=(\d{12})", a.get("href", ""))
            if not m:
                continue
            race_id = m.group(1)
            data = li.select_one(".RaceData")
            time_el = data.select_one("span") if data else None
            heads = re.search(r"(\d+)頭", li.get_text())
            title_el = li.select_one(".ItemTitle")
            races.append({
                "race_id": race_id,
                "no": int(race_id[-2:]),
                "time": time_el.get_text(strip=True) if time_el else "",
                "title": title_el.get_text(strip=True) if title_el else "",
                "heads": heads.group(1) if heads else "",
            })
        if not races:
            continue
        code = races[0]["race_id"][4:6]
        name = CODE_TO_NAME.get(code)
        if not name:
            # 未登録の競馬場は見出しから名前を取る（"9回 盛岡 4日目" → "盛岡"）
            title = dl.select_one(".RaceList_DataTitle")
            raw = title.get_text(" ", strip=True) if title else code
            name = re.sub(r"\d+回|\d+日目", "", raw).strip() or code
        venues.append({"name": name, "races": races})
    return venues


def next_race_index(races, race_date, now=None):
    """発走前で最も早いレースの位置を返す。全レース終了なら最終レース"""
    now = now or datetime.now()
    if race_date != now.strftime("%Y%m%d"):
        return 0
    for i, r in enumerate(races):
        m = re.fullmatch(r"(\d{1,2}):(\d{2})", r["time"])
        if m and (int(m.group(1)), int(m.group(2))) > (now.hour, now.minute):
            return i
    return len(races) - 1


def choose_race(page, race_date):
    """開催一覧から競馬場・レースを選ばせる。(競馬場名, レース番号) を返す"""
    venues = fetch_race_list(page, race_date)
    if not venues:
        print("\n開催一覧を取得できませんでした。競馬場とレース番号を直接入力してください。")
        return choose_race_manual()

    print("\nこの日の開催:")
    for i, v in enumerate(venues, 1):
        r0, r1 = v["races"][0], v["races"][-1]
        print(f"  {i:2d}. {pad(v['name'], 10)} {len(v['races'])}R（{r0['time']}〜{r1['time']}）")
    vi = ask_choice("\n競馬場の番号: ", len(venues))
    venue = venues[vi - 1]

    races = venue["races"]
    nxt = next_race_index(races, race_date)
    print(f"\n{venue['name']} のレース:")
    for i, r in enumerate(races):
        mark = " ← 次" if i == nxt and race_date == datetime.now().strftime("%Y%m%d") else ""
        print(f"  {r['no']:2d}R  {r['time']:>5}  {pad(r['title'], 24)} {r['heads']:>2}頭{mark}")
    nos = [r["no"] for r in races]
    while True:
        s = input(f"\nレース番号 [Enter={races[nxt]['no']}R]: ").strip().upper().rstrip("R")
        if not s:
            return venue["name"], races[nxt]["no"]
        if s.isdigit() and int(s) in nos:
            return venue["name"], int(s)
        print(f"この日のレース番号から選んでください: {', '.join(map(str, nos))}")


def choose_race_manual():
    names = list(KEIBA_CODES.keys())
    for i, name in enumerate(names, 1):
        print(f"  {i:2d}. {name}")
    name = names[ask_choice("\n競馬場の番号: ", len(names)) - 1]
    no = ask_choice("レース番号（1〜12）: ", 12)
    return name, no


# ========== 出馬表 ==========

def scrape_shutuba(page, url):
    """出馬表を取得。(horses, soup) を返す。取得失敗時は ([], None)"""
    html = fetch_page(page, url, "table.ShutubaTable, dl.HorseList")
    if not html:
        return [], None
    soup = BeautifulSoup(html, "html.parser")
    horses = parse_shutuba(soup)
    print(f"  出馬表: {len(horses)}頭取得")
    return horses, soup


def parse_shutuba(soup):
    """出馬表 soup から馬のリストを作る。
    現行ページ（table.ShutubaTable）を優先し、旧ページ（dl.HorseList）にも対応する"""
    rows = soup.select("table.ShutubaTable tr.HorseList")
    if rows:
        horses = [h for h in (_parse_tr_horse(tr) for tr in rows) if h]
    else:
        horses = [h for h in (_parse_dl_horse(dl) for dl in soup.select("dl.HorseList")) if h]

    # 脚質は出馬表下の「脚質」表から馬番で引く
    kyaku = parse_kyaku_type(soup)
    for h in horses:
        if not h.get("脚質"):
            h["脚質"] = kyaku.get(h["馬番"], "")
    return horses


def _text(el):
    return el.get_text(strip=True) if el else ""


def _parse_tr_horse(tr):
    """table.ShutubaTable の tr.HorseList 1行から horse dict を作る"""
    umaban = tr.find("td", class_=re.compile(r"^Umaban"))
    no = _text(umaban)
    if not no.isdigit():
        return None
    waku = tr.find("td", class_=re.compile(r"^Waku\d"))
    name_a = tr.select_one(".HorseName a")

    h = {
        "枠番": _text(waku),
        "馬番": no,
        "馬名": (name_a.get("title") or _text(name_a)) if name_a else "",
        "性齢": _text(tr.select_one(".Age")),
        "騎手": _text(tr.select_one("td.Jockey a")),
        "調教師": _text(tr.select_one("td.Trainer a")),
        "脚質": "",
        "過去成績": [],
        "要補完": True,  # 現行ページは出馬表に過去成績がないため keiba.go.jp で補完する
    }

    # 斤量（td.Txt_C のうち "54.0" 形式のもの。▲などの減量記号は除く）
    h["斤量"] = ""
    for td in tr.select("td.Txt_C"):
        t = re.sub(r"[▲△☆★◇]", "", td.get_text(strip=True))
        if re.fullmatch(r"\d{2}\.\d", t):
            h["斤量"] = t
            break

    # 馬体重 "432(0)" / "430(-3)" / 未発表は数字なし
    m = re.search(r"(\d{3})\s*\(([+-]?\d+)\)", _text(tr.select_one("td.Weight")))
    if m:
        h["馬体重"], h["体重増減"] = int(m.group(1)), int(m.group(2))
    else:
        h["馬体重"], h["体重増減"] = "未発表", 0

    # 出馬表に載っている単勝・人気（オッズページが取れなかったときの予備）
    odds_m = re.search(r"\d+\.\d", _text(tr.select_one("td.Popular.Txt_R")))
    h["単勝_出馬表"] = odds_m.group(0) if odds_m else ""
    ninki = _text(tr.select_one("td.Popular.Txt_C"))
    h["人気"] = ninki if ninki.isdigit() else ""

    row_text = tr.get_text()
    h["取消"] = "Cancel" in (tr.get("class") or []) or "取消" in row_text or "除外" in row_text
    return h


def parse_kyaku_type(soup):
    """脚質表（table.Kyaku_Type）から {馬番: 脚質} を作る"""
    result = {}
    for tr in soup.select("table.Kyaku_Type tr"):
        label = _text(tr.find("th"))
        for num in tr.select(".Kyaku_Type_Num"):
            if _text(num).isdigit():
                result[_text(num)] = label
    return result


def _parse_dl_horse(dl):
    """旧ページ dl.HorseList 1要素から horse dict を作る"""
    h = {"取消": "Cancel" in (dl.get("class") or []) or bool(dl.select_one(".Cancel_Txt"))}

    for dt in dl.find_all("dt"):
        classes = " ".join(dt.get("class") or [])
        if re.search(r"\bWaku[1-8]\b", classes) and "Waku_Horse" not in classes:
            h["枠番"] = dt.get_text(strip=True)
            break

    h["馬番"] = _text(dl.select_one("dt.Waku_Horse"))
    if not h["馬番"].isdigit():
        return None
    h["馬名"] = _text(dl.select_one("dt.HorseName a"))
    h["脚質"] = _text(dl.select_one(".Horse06 .Type span"))

    wt = dl.select_one(".Horse07 span.transition-color")
    m = re.search(r"(\d+)kg\s*\(([+-]?\d+)\)", wt.get_text(separator="", strip=True)) if wt else None
    if m:
        h["馬体重"], h["体重増減"] = int(m.group(1)), int(m.group(2))
    else:
        h["馬体重"], h["体重増減"] = "未発表", 0

    barei = dl.select_one("dd.Jockey span.Barei")
    tokens = barei.get_text(strip=True).split() if barei else []
    h["性齢"] = tokens[0] if tokens else ""

    jockey_a = dl.select_one("dd.Jockey a")
    if jockey_a:
        for ch in jockey_a.select(".Change"):
            ch.decompose()
    h["騎手"] = _text(jockey_a)

    h["斤量"] = ""
    jockey_dd = dl.select_one("dd.Jockey")
    if jockey_dd:
        for line in reversed(jockey_dd.get_text(separator="\n").split("\n")):
            cleaned = re.sub(r"[▲△☆★]", "", line).strip()
            if re.match(r"^\d{2}\.\d$", cleaned):
                h["斤量"] = cleaned
                break

    trainer = dl.select_one(".Horse05 a")
    h["調教師"] = re.sub(r"^[^・]+・", "", _text(trainer))

    past = [r for r in (_parse_netkeiba_past_li(li) for li in dl.select("dd.Past_Wrapper li.Past")) if r]
    h["過去成績"] = past
    h["要補完"] = bool(dl.select("dd.Past_Wrapper li.Past5_Sample")) or not past
    h["単勝_出馬表"], h["人気"] = "", ""
    return h


def _parse_netkeiba_past_li(li):
    """旧ページ li.Past 1要素から過去成績レコードを作る"""
    num_el = li.select_one(".Data04 .Num")
    if not num_el:
        return None
    t = num_el.get_text(strip=True)
    rec = {"着順": t + "着" if t.isdigit() else t}

    m = re.match(r"(\d{2}/\d{2})\s*(.+?)\s*(\d+)R", _text(li.select_one(".Data01")))
    if m:
        rec["日付"], rec["競馬場"] = m.group(1), m.group(2).strip()

    d = _text(li.select_one(".Data09"))
    rec["距離"] = d + "m" if d and d[-1].isdigit() else d
    cond = _text(li.select_one(".Data11"))
    rec["馬場"] = COND_MAP.get(cond, cond)
    rec["タイム"] = _text(li.select_one(".Data12"))
    corners = [c.get_text(strip=True) for c in li.select(".Data20 .Corner") if c.get_text(strip=True) != "-"]
    rec["通過"] = "-".join(corners)
    m2 = re.search(r"(\d{2}\.\d)", _text(li.select_one(".Data21")))
    rec["上がり"] = m2.group(1) if m2 else ""
    return rec


# ========== レース基本情報 ==========

def scrape_race_info(soup):
    """出馬表 soup からレース条件を取得"""
    info = {"レース名": "", "発走": "", "距離": "不明", "馬場種別": "不明",
            "馬場状態": "不明", "クラス": "", "頭数": ""}
    if soup is None:
        return info

    info["レース名"] = _text(soup.select_one(".RaceName"))

    # RaceData01: "14:05発走 / ダ1200m (左) / 天候:小雨 / 馬場:不"
    rd1 = soup.select_one(".RaceData01")
    if rd1:
        text = rd1.get_text(separator=" ", strip=True)
        m0 = re.search(r"(\d{1,2}:\d{2})発走", text)
        if m0:
            info["発走"] = m0.group(1)
        m = re.search(r"(ダート|ダ|芝|障害|障)\s*(\d+)\s*m", text)
        if m:
            info["馬場種別"] = {"ダ": "ダート", "障": "障害"}.get(m.group(1), m.group(1))
            info["距離"] = m.group(2) + "m"
        m2 = re.search(r"馬場[:：]\s*(良|稍重|稍|重|不良|不)", text)
        if m2:
            info["馬場状態"] = COND_MAP.get(m2.group(1), m2.group(1))

    # RaceData02: "9回 盛岡 4日目 サラ系一般 C2 9頭"
    rd2 = soup.select_one(".RaceData02")
    if rd2:
        spans = [s.get_text(strip=True) for s in rd2.find_all("span")]
        for s in spans:
            if re.search(r"サラ|アラ|ばん|歳|一般|重賞|オープン|[A-C]\d", s):
                info["クラス"] = s
                break
        m3 = re.search(r"(\d+)頭", rd2.get_text())
        if m3:
            info["頭数"] = m3.group(1)
    return info


# ========== keiba.go.jp 過去成績補完 ==========

def scrape_keibago_past5(page, keibajo_name, race_date, race_no):
    """keiba.go.jp の出馬表ページから全馬の過去5走を取得する。
    返り値: {馬番(str): [past_race_dict, ...]}"""
    code = KEIBAGO_CODES.get(keibajo_name)
    if not code:
        print(f"  keiba.go.jp のコード未定義のため補完しません: {keibajo_name}")
        return {}

    url = (
        "https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/DebaTable"
        f"?k_babaCode={code}&k_raceDate={race_date[:4]}%2F{race_date[4:6]}%2F{race_date[6:]}"
        f"&k_raceNo={race_no}"
    )
    html = fetch_page(page, url, "section.cardTable")
    if not html:
        return {}
    try:
        return _parse_keibago_table(html)
    except Exception as e:
        print(f"  keiba.go.jp 解析エラー: {e}")
        return {}


def _parse_keibago_table(html):
    """section.cardTable の tbody から全馬の過去5走を抽出する。
    各馬は tBorder 行から始まるブロック（通常5行）"""
    soup = BeautifulSoup(html, "html.parser")
    result = {}
    table = soup.select_one("section.cardTable table tbody")
    if not table:
        print("  section.cardTable が見つかりません")
        return result

    # tBorder 行ごとにブロックへ分ける（行数を5行固定と決め打ちしない）
    blocks, cur = [], None
    for row in table.find_all("tr", recursive=False):
        if "tBorder" in (row.get("class") or []):
            cur = [row]
            blocks.append(cur)
        elif cur is not None:
            cur.append(row)

    for rows in blocks:
        if len(rows) < 4:
            continue
        horse_no, past5 = _parse_keibago_horse(rows)
        if horse_no:
            result[horse_no] = past5

    print(f"  keiba.go.jp 解析: {len(result)}頭")
    return result


def _parse_keibago_horse(rows):
    """keiba.go.jp の馬1頭分のブロックから (馬番, past5_list) を返す"""
    row1 = rows[0]
    horse_no = _text(row1.select_one("td.horseNum"))
    if not horse_no.isdigit():
        return None, []

    race_infos = row1.select("td div.raceInfo")

    # タイム・コーナー・上がりの行（通常4行目）
    row4_tds = rows[3].find_all("td")
    time_tds = row4_tds[2:] if len(row4_tds) >= 7 else row4_tds[max(0, len(row4_tds) - 5):]

    past5 = []
    for idx, ri in enumerate(race_infos[:5]):
        rec = _parse_keibago_raceinfo(ri)
        if rec is None:
            continue
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
    """div.raceInfo 1要素から過去成績レコードを作る"""
    rank_el = ri.select_one(".pastRank")
    if not rank_el:
        return None
    rank_classes = " ".join(rank_el.get("class") or [])
    rank_text = rank_el.get_text(strip=True)
    m_rank = re.search(r"rank_0([1-3])", rank_classes)
    if m_rank:
        rec = {"着順": f"{m_rank.group(1)}着"}
    elif rank_text.isdigit():
        rec = {"着順": rank_text + "着"}
    else:
        rec = {"着順": rank_text}  # "取止", "除外" 等

    for line in (l.strip() for l in ri.get_text(separator="\n").split("\n")):
        if not line:
            continue
        # "26.03.17　良　12頭"
        m_date = re.search(r"(\d{2})\.(\d{2})\.(\d{2})\s+(良|稍重|稍|重|不良|不)\s+(\d+)頭", line)
        if m_date:
            rec["日付"] = f"20{m_date.group(1)}/{m_date.group(2)}/{m_date.group(3)}"
            rec["馬場"] = COND_MAP.get(m_date.group(4), m_date.group(4))
            continue
        # "浦和　左1400　2番" / "Ｊ福島　芝右1200　16番"
        m_venue = re.search(r"([^\s　]+)\s*[　\s]+(芝)?[右左直][内外線]?(\d{3,4})\s*[　\s]+\d+番", line)
        if m_venue:
            rec["競馬場"] = m_venue.group(1).lstrip("Ｊ")
            rec["距離"] = ("芝" if m_venue.group(2) else "ダ") + m_venue.group(3) + "m"

    return rec if rec.get("日付") else None


# ========== 単勝・複勝オッズ ==========

def _row_horse_no(tr):
    """オッズ表の1行から馬番を返す。
    枠番の列（同枠2頭目も枠番が入る）を馬番と取り違えないよう、
    選択チェックボックスの value（"..._c0_9"）を優先する"""
    chk = tr.select_one("input.HorseCheck_Select, input[type=checkbox]")
    if chk:
        m = re.search(r"_c0_(\d+)$", chk.get("value", ""))
        if m:
            return m.group(1)
    tds = tr.find_all("td")
    if len(tds) >= 2 and tds[1].get_text(strip=True).isdigit():
        return tds[1].get_text(strip=True)  # 0列目=枠番、1列目=馬番
    return None


def parse_tan_fuku(html):
    """単勝・複勝ページの HTML から {馬番: {"単勝","複勝"}} を作る"""
    soup = BeautifulSoup(html, "html.parser")
    tables = soup.select("table.RaceOdds_HorseList_Table")

    def parse_table(table):
        result = {}
        for tr in table.select("tr"):
            no = _row_horse_no(tr)
            odds_el = tr.select_one("td.Odds")
            if no and odds_el:
                result[no] = odds_el.get_text(" ", strip=True) or "--"
        return result

    tan = parse_table(tables[0]) if tables else {}
    fuku = parse_table(tables[1]) if len(tables) >= 2 else {}
    return {no: {"単勝": tan.get(no, "--"), "複勝": fuku.get(no, "--")} for no in set(tan) | set(fuku)}


def scrape_tan_fuku(page, url):
    html = fetch_page(page, url, "table.RaceOdds_HorseList_Table td.Odds")
    if not html:
        return {}
    odds = parse_tan_fuku(html)
    print(f"  単複オッズ: {len(odds)}頭取得")
    return odds


# ========== ワイド・三連複 ==========

def _extract_combos(html, all_combos):
    soup = BeautifulSoup(html, "html.parser")
    for td in soup.select("td.Odds[cart-item]"):
        m = re.search(r"_c0_(.+)$", td.get("cart-item", ""))
        if not m:
            continue
        horses = m.group(1).split("_")
        if not all(h.isdigit() for h in horses):
            continue
        key = "-".join(sorted(horses, key=int))
        nums = re.findall(r"\d+\.\d+", td.get_text(separator=" ", strip=True).replace(",", ""))
        if not nums:
            continue
        low = float(nums[0])
        if key not in all_combos or low < all_combos[key]["オッズ"]:
            all_combos[key] = {
                "組み合わせ": key,
                "オッズ": low,
                "オッズ表示": f"{nums[0]} - {nums[1]}" if len(nums) >= 2 else nums[0],
            }


def scrape_combo_odds(page, url, label):
    html = fetch_page(page, url, "td.Odds[cart-item]")
    if not html:
        return []
    all_combos = {}
    _extract_combos(html, all_combos)

    # 三連複は軸馬ごとに表が切り替わるので、全軸馬を順に読む
    if "type=b7" in url:
        options = BeautifulSoup(html, "html.parser").select("#list_select_horse option")
        values = [o.get("value") for o in options if o.get("value")]
        for val in values[1:]:
            try:
                page.select_option("#list_select_horse", value=val)
                page.wait_for_selector("td.Odds[cart-item]", timeout=TIMEOUT_SELECTOR)
                _extract_combos(page.content(), all_combos)
            except Exception:
                continue

    top = sorted(all_combos.values(), key=lambda x: x["オッズ"])[:10]
    print(f"  {label}: {len(top)}組取得（全{len(all_combos)}組中）")
    return [{"組み合わせ": c["組み合わせ"], "オッズ": c["オッズ表示"]} for c in top]


# ========== データマージ・チェック ==========

def merge_data(horses, tan_fuku):
    for h in horses:
        odds = tan_fuku.get(h["馬番"], {})
        h["単勝"] = odds.get("単勝", "--")
        h["複勝"] = odds.get("複勝", "--")
        # オッズページで取れなかった単勝は出馬表の値で埋める
        if h["単勝"] in ("", "--") and h.get("単勝_出馬表"):
            h["単勝"] = h["単勝_出馬表"]
    return horses


def check_data(horses):
    """取得漏れを一覧にする（出力テキストにも載せ、AI に欠損を伝える）"""
    active = [h for h in horses if not h.get("取消")]
    items = [
        ("単勝", lambda h: h.get("単勝") in ("", "--")),
        ("複勝", lambda h: h.get("複勝") in ("", "--")),
        ("騎手", lambda h: not h.get("騎手")),
        ("調教師", lambda h: not h.get("調教師")),
        ("脚質", lambda h: not h.get("脚質")),
        ("過去成績", lambda h: not h.get("過去成績")),
    ]
    warnings = []
    for label, missing in items:
        nos = [h["馬番"] for h in active if missing(h)]
        if nos:
            warnings.append(f"{label}未取得: 馬番 {', '.join(nos)}")
    if any(h.get("馬体重") == "未発表" for h in active):
        warnings.append("馬体重は未発表（発走約2時間前に発表）")
    return warnings


# ========== クリップボード ==========

def copy_to_clipboard(text):
    """Windows のクリップボードへコピーする。成功したら True"""
    if sys.platform != "win32":
        return False
    try:
        # clip.exe は BOM 付き UTF-16 を Unicode として受け取る
        subprocess.run(["clip"], input=text.encode("utf-16"), check=True)
        return True
    except Exception:
        pass
    try:
        import tkinter
        root = tkinter.Tk()
        root.withdraw()
        root.clipboard_clear()
        root.clipboard_append(text)
        root.update()
        root.destroy()
        return True
    except Exception:
        return False


# ========== AI貼り付け用テキスト整形 ==========

def format_for_ai(horses, keibajo, date, race_no, race_info=None,
                  wide_top=None, sanren_top=None, warnings=None):
    d = f"{date[:4]}/{date[4:6]}/{date[6:]}"
    ri = race_info or {}
    title = f"{d} {keibajo} {race_no}R"
    if ri.get("レース名"):
        title += f" {ri['レース名']}"
    lines = [
        f"【{title} 出馬表 + オッズ + 過去成績】",
        f"収集時刻: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
        + (f" / 発走: {ri['発走']}" if ri.get("発走") else ""),
        "",
        f"レース条件: {ri.get('馬場種別', '不明')} {ri.get('距離', '不明')} "
        f"/ 馬場状態: {ri.get('馬場状態', '不明')} / クラス: {ri.get('クラス') or '不明'}"
        + (f" / {ri['頭数']}頭" if ri.get("頭数") else ""),
        "",
    ]

    cols = [("馬番", 4, ">"), ("馬名", 20, "<"), ("性齢", 5, "<"), ("斤量", 5, ">"),
            ("騎手", 11, "<"), ("調教師", 11, "<"), ("馬体重", 9, ">"),
            ("単勝", 7, ">"), ("人気", 5, ">"), ("複勝", 12, ">"), ("脚質", 5, "<")]
    lines.append(" ".join(pad(c, w, a) for c, w, a in cols))
    rule = "-" * (sum(w for _, w, _ in cols) + len(cols) - 1)
    lines.append(rule)

    for h in horses:
        if h.get("取消"):
            lines.append(f"{pad(h['馬番'], 4, '>')} {pad(h['馬名'], 20)} ※取消・除外")
            continue
        weight = h.get("馬体重", "未発表")
        diff = h.get("体重増減", 0)
        weight_str = f"{weight}({diff:+d})" if isinstance(weight, int) else str(weight)
        vals = [h["馬番"], h["馬名"], h.get("性齢", ""), h.get("斤量", ""),
                h.get("騎手", ""), h.get("調教師", ""), weight_str,
                h.get("単勝", "--"), h.get("人気", ""), h.get("複勝", "--"), h.get("脚質", "")]
        lines.append(" ".join(pad(v, w, a) for v, (_, w, a) in zip(vals, cols)))
    lines.append(rule)

    # 各馬の過去成績
    pcols = [("日付", 10, "<"), ("競馬場", 6, "<"), ("距離", 7, "<"), ("馬場", 4, "<"),
             ("着順", 4, ">"), ("タイム", 6, ">"), ("通過", 11, ">"), ("上がり", 6, ">")]
    lines += ["", "【各馬の過去成績（直近5走）】",
              f"{pad('馬番', 4, '>')} {pad('馬名', 20)} " + " ".join(pad(c, w, a) for c, w, a in pcols)]
    lines.append("-" * (4 + 1 + 20 + 1 + sum(w for _, w, _ in pcols) + len(pcols) - 1))

    for h in horses:
        if h.get("取消"):
            continue
        prefix = f"{pad(h['馬番'], 4, '>')} {pad(h['馬名'], 20)} "
        hist = h.get("過去成績", [])
        if not hist:
            lines.append(prefix + "（過去成績を取得できず）")
            continue
        for i, r in enumerate(hist):
            row = " ".join(pad(r.get(c, ""), w, a) for c, w, a in pcols)
            lines.append((prefix if i == 0 else " " * disp_width(prefix)) + row)

    for label, combos in (("ワイド", wide_top), ("三連複", sanren_top)):
        if combos:
            lines += ["", f"【{label} 人気上位】"]
            for i, c in enumerate(combos[:10], 1):
                lines.append(f"  {i:2d}位  {pad(c['組み合わせ'], 8)}  {c['オッズ']}倍")

    if warnings:
        lines += ["", "【データの欠損】"] + [f"・{w}" for w in warnings]

    lines += [
        "",
        "【AIへの指示】",
        "上記データをもとに、このレースで的中する可能性が最も高い買い方を予想してください。",
        "本命一点買いより、配当とのバランスが取れた買い目を優先してください。",
        "データの欠損がある項目は、推測で補わず欠損として扱ってください。",
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
    return "\n".join(line.rstrip() for line in lines)


# ========== 1レース分の収集 ==========

def collect_race(page, keibajo_name, race_date, race_no):
    code = KEIBA_CODES.get(keibajo_name)
    if not code:
        print(f"未対応の競馬場です: {keibajo_name}")
        return
    race_id = f"{race_date[:4]}{code}{race_date[4:8]}{race_no:02d}"
    url_shutuba = f"{NETKEIBA}/race/shutuba.html?race_id={race_id}"
    odds_url = f"{NETKEIBA}/odds/?race_id={race_id}&type="

    print(f"\n収集対象: {keibajo_name} {race_date[:4]}/{race_date[4:6]}/{race_date[6:]} {race_no}R"
          f"（race_id: {race_id}）")

    print("\n[出馬表]")
    horses, soup = scrape_shutuba(page, url_shutuba)
    if not horses:
        print("出馬表を取得できませんでした。日付・競馬場・レース番号を確認してください:")
        print(f"  {url_shutuba}")
        return
    race_info = scrape_race_info(soup)
    print(f"  {race_info['レース名']} / {race_info['馬場種別']}{race_info['距離']} "
          f"/ 馬場:{race_info['馬場状態']} / {race_info['クラス']}")

    need = [h for h in horses if h.get("要補完") and not h.get("取消")]
    if need:
        print(f"\n[過去成績: keiba.go.jp から取得] {len(need)}頭")
        past_map = scrape_keibago_past5(page, keibajo_name, race_date, race_no)
        for h in need:
            if h["馬番"] in past_map:
                h["過去成績"] = past_map[h["馬番"]]

    print("\n[単勝・複勝オッズ]")
    tan_fuku = scrape_tan_fuku(page, odds_url + "b1")
    print("\n[ワイドオッズ]")
    wide_top = scrape_combo_odds(page, odds_url + "b5", "ワイド")
    print("\n[三連複オッズ]")
    sanren_top = scrape_combo_odds(page, odds_url + "b7", "三連複")

    merged = merge_data(horses, tan_fuku)
    warnings = check_data(merged)
    text = format_for_ai(merged, keibajo_name, race_date, race_no, race_info,
                         wide_top, sanren_top, warnings)

    print("\n" + "=" * 70)
    print(text)
    print("=" * 70)

    OUTPUT_DIR.mkdir(exist_ok=True)
    path = OUTPUT_DIR / f"{race_date}_{keibajo_name}{race_no}R.txt"
    path.write_text(text, encoding="utf-8")
    print(f"\nファイル保存: {path}")
    if warnings:
        print("取得できなかった項目:")
        for w in warnings:
            print(f"  ・{w}")
    if copy_to_clipboard(text):
        print("\n★ クリップボードにコピーしました。AI のチャット欄に貼り付けてください。")
    else:
        print("\nクリップボードへのコピーに失敗しました。上のファイルを開いてコピーしてください。")


# ========== メイン ==========

def parse_args(argv):
    """コマンドライン引数 [競馬場] [レース番号] [日付] を解釈する"""
    if not argv:
        return None
    name = argv[0]
    if name.isdigit() and name in CODE_TO_NAME:
        name = CODE_TO_NAME[name]
    if name not in KEIBA_CODES:
        print(f"競馬場名が不明です: {argv[0]}（使えるもの: {' / '.join(KEIBA_CODES)}）")
        sys.exit(1)
    no_text = argv[1].upper().rstrip("R") if len(argv) >= 2 else ""
    if not (no_text.isdigit() and 1 <= int(no_text) <= 12):
        print("レース番号を 1〜12 で指定してください。例: keiba_scraper.py 盛岡 5")
        sys.exit(1)
    date = parse_date(argv[2]) if len(argv) >= 3 else parse_date("")
    if not date:
        print(f"日付として読めません: {argv[2]}")
        sys.exit(1)
    return name, int(no_text), date


def main():
    print("=" * 60)
    print("  地方競馬 自動収集スクリプト v5（netkeiba + keiba.go.jp）")
    print("=" * 60)

    direct = parse_args(sys.argv[1:])

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_context(user_agent=UA).new_page()
        try:
            if direct:
                name, no, date = direct
                collect_race(page, name, date, no)
                return

            race_date = ask_date()
            while True:
                name, no = choose_race(page, race_date)
                collect_race(page, name, race_date, no)

                ans = input("\n続けますか？ [Enter=別のレース / d=日付を変える / q=終了]: ").strip().lower()
                if ans in ("q", "n", "no"):
                    break
                if ans == "d":
                    race_date = ask_date()
        except KeyboardInterrupt:
            print("\n中断しました。")
        finally:
            browser.close()
    print("\n終了します。")


if __name__ == "__main__":
    main()
