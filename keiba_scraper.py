# keiba_scraper.py v5
# 地方競馬の出馬表・オッズ・過去成績を netkeiba / keiba.go.jp から集め、
# AI に貼り付けるテキストを作る。
#
# 使い方:
#   python keiba_scraper.py                 … 対話形式（当日の開催一覧から選ぶ）
#   python keiba_scraper.py 盛岡 5           … 当日の盛岡5R を直接取得
#   python keiba_scraper.py 盛岡 5 1025      … 日付を指定（YYYYMMDD / MMDD / M/D も可）

import json
import random
import re
import subprocess
import sys
import time
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
    "金沢": "46", "笠松": "47", "名古屋": "48",
    "園田": "50", "姫路": "51", "高知": "54", "佐賀": "55",
    "帯広(ば)": "65",
}
CODE_TO_NAME = {v: k for k, v in KEIBA_CODES.items()}
# コマンドラインで受け付ける別名
NAME_ALIASES = {"帯広": "帯広(ば)", "ばんえい": "帯広(ば)", "帯広ばんえい": "帯広(ば)"}

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

# 買い目に採用する期待値の下限。
# 控除率（約20〜25%）を越えるには市場より大きく高い確率を見積もる必要があり、
# 多数の候補から期待値の最大値を選ぶと推定の上振れを拾いやすいので、1.0 より高く取る。
# 検証（verify）の実績を見て決め直す
EV_MIN = 1.2

# AI への指示文（出力テキストの末尾に付ける）。文言を変えるときはここだけ直す
# {EV_MIN} は実行時に EV_MIN の値に置き換わる
PROMPT_TEXT = """
【AIへの指示】
上記データだけを使って、このレースの買い目を決めてください。

■ 目的と制約
・目的は回収率（期待値）の最大化です。的中率の高さは目的ではありません。
・予算は1000円、最大3点、各100円単位。期待値が{EV_MIN}以上の買い目がなければ「見送り」と答えてください。
・データにない情報（騎手のコース実績、調教、血統、ニュースなど）は使わないでください。
・「データの欠損」にある項目は推測で補わず、その分だけ評価を市場評価に寄せてください。
・ワイド・三連複は、表にある人気上位10組の中からだけ選んでください（それ以外はオッズ不明のため）。

■ 手順
1. 市場評価：出馬表の「市場勝率」（単勝オッズからスクリプトで計算済み）をそのまま使い、再計算しない。「--」の馬は単勝オッズがないため計算から外れている。
2. 展開：脚質と過去の通過順から、逃げ・先行になりそうな馬とペース（速い/普通/遅い）を判断する。
3. 各馬の評価：次の観点で、市場評価より上か下かを判断する。
   ・人気と着順：過去走で人気より上の着順に来ているか（人気以上に走る馬か、人気を裏切る馬か）
   ・負け幅：着順より「差」を重視する。頭数が少ないレースの着順は割り引いて見る
   ・条件適性：今回と同じ馬場種別・近い距離（±200m）での着順、「成績」の左・右・場・距
   ・クラス：過去走のクラスと今回のクラスを比べ、昇級・降級を判断する。中央(J)のレースは別物として扱う
   ・近走の推移：直近3走の着順・差・上がりが良化しているか悪化しているか
   ・タイム：同じ競馬場・同じ距離・近い馬場状態のレース同士でだけ比べる（条件が違うタイムは比べない）
   ・前走間隔：中1週以内や3か月以上は割り引いて考える
   ・騎手：乗り替わりの有無と騎手コンビ成績
   ・斤量差・馬体重の増減（好走時の体重と比べる）、展開との相性
4. 推定確率：全頭に推定勝率と推定複勝率を付ける。推定勝率は合計100%、推定複勝率は合計300%（出走7頭以下は複勝が2着までなので200%）にそろえる。市場勝率から大きく動かす馬には、データ上の根拠を必ず示す。根拠が弱いときは市場勝率に近い値にする。
5. 買い目：期待値 = 推定的中率 × オッズ で計算する。複勝・ワイドのオッズは幅の下限を使う。期待値{EV_MIN}以上の候補から、期待値の高い順に最大3点を選び、資金を配分する。

■ 出力フォーマット（この順で出力）
1. 【前提】出走頭数、欠損データ、市場勝率が「--」の馬
2. 【展開予想】逃げ・先行候補とペースを2〜3行で
3. 【全頭評価】表形式：馬番｜馬名｜市場勝率｜推定勝率｜推定複勝率｜根拠（データを引用して1行）
4. 【買い目】表形式：券種｜組み合わせ｜金額｜使用オッズ｜推定的中率｜期待値　（見送りの場合はその理由）
5. 【総評】50字以内
6. 【記録用】最後に次の形式のブロックをコードブロックで出力する。見送りの場合も #PRED は全頭分出し、#BET は見出し行だけにする。数値は%の数字だけ（%記号は付けない）。以下は書式の例。
#PRED
馬番,推定勝率,推定複勝率
1,12.5,35.0
#BET
券種,組み合わせ,金額
ワイド,3-7,500
"""

TIMEOUT_PAGE     = 20000  # ページロード待機 (ms)
TIMEOUT_SELECTOR = 10000  # セレクタ出現待機 (ms)
RETRY            = 2      # ページ取得の試行回数
REQUEST_INTERVAL = 2.0    # サイトへのアクセス間隔の下限 (秒)。サーバ負荷を避けるため短くしない


RECORD_DIR = OUTPUT_DIR / "records"  # 予想と結果の記録（1レース1ファイル）


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

_last_access = 0.0


def wait_interval():
    """前回のアクセスから REQUEST_INTERVAL 秒たつまで待つ（ページ遷移・表の切替の前に必ず呼ぶ）"""
    global _last_access
    rest = REQUEST_INTERVAL - (time.monotonic() - _last_access)
    if rest > 0:
        time.sleep(rest)
    _last_access = time.monotonic()


def fetch_page(page, url, wait_selector=None, timeout=TIMEOUT_PAGE):
    """ページを開いて HTML を返す。失敗時は RETRY 回まで再試行し、最後は None を返す"""
    for attempt in range(1, RETRY + 1):
        try:
            wait_interval()
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


# ========== keiba.go.jp 過去成績・馬柱 ==========

def scrape_keibago(page, keibajo_name, race_date, race_no):
    """keiba.go.jp の出馬表（馬柱）から全馬の過去5走と成績集計を取得する。
    返り値: {馬番(str): {"過去成績": [...], "条件別成績": {...}, "持ち時計": str, "コンビ": str}}"""
    code = KEIBAGO_CODES.get(keibajo_name)
    if not code:
        print(f"  keiba.go.jp のコード未定義のため取得しません: {keibajo_name}")
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
        return parse_keibago(html)
    except Exception as e:
        print(f"  keiba.go.jp 解析エラー: {e}")
        return {}


def parse_keibago(html):
    """section.cardTable の馬柱を馬ごとのブロック（tBorder 行から始まる5行）に分けて解析する"""
    soup = BeautifulSoup(html, "html.parser")
    result = {}
    tbody = soup.select_one("section.cardTable table tbody")
    if not tbody:
        print("  section.cardTable が見つかりません")
        return result

    blocks, cur = [], None
    for row in tbody.find_all("tr", recursive=False):
        if "tBorder" in (row.get("class") or []):
            cur = [row]
            blocks.append(cur)
        elif cur is not None:
            cur.append(row)

    for rows in blocks:
        if len(rows) < 5:
            continue
        no, data = _parse_keibago_horse(rows)
        if no:
            result[no] = data

    print(f"  keiba.go.jp 解析: {len(result)}頭")
    return result


def _cells(row):
    """行の直下の td だけを返す（着別成績の入れ子テーブルの td を含めない）"""
    return row.find_all("td", recursive=False)


def _parse_keibago_horse(rows):
    """馬1頭分の5行から (馬番, data) を返す。
    各行の末尾5セルが 前走〜5走前 に対応する:
      1行目: 着順・日付・馬場・頭数・競馬場・回り距離・馬番
      2行目: レース名（クラス）
      3行目: 人気・馬体重・騎手・斤量
      4行目: タイム・通過順・上がり3F
      5行目: 1着馬とのタイム差・相手馬（自身が1着のときは2着馬との差）"""
    r0, r1, r2, r3, r4 = rows[:5]
    no = _text(r0.select_one("td.horseNum"))
    if not no.isdigit():
        return None, {}

    data = {"過去成績": [], "条件別成績": {}, "持ち時計": "", "コンビ": ""}

    # 着別成績（全・左・右・場・距）と最高タイム
    arrival = r0.select_one("table.arrival")
    if arrival:
        for tr in arrival.find_all("tr"):
            tds = [td.get_text(strip=True).replace("\xa0", "") for td in tr.find_all("td")]
            if len(tds) == 5 and tds[0] in ("全", "左", "右", "場", "距"):
                data["条件別成績"][tds[0]] = "".join(tds[1:])
            elif len(tds) == 2:
                data["持ち時計"] = f"{tds[0]}（{tds[1]}）" if tds[1] else tds[0]

    # 今回の騎手とこの馬のコンビ成績（"54.0 0-1-0-4" の後半）
    for td in _cells(r1):
        m = re.fullmatch(r"\d{2}\.\d\s+(\d+-\d+-\d+-\d+)", td.get_text(" ", strip=True))
        if m:
            data["コンビ"] = m.group(1)
            break

    cols = [_cells(r)[-5:] for r in (r0, r1, r2, r3, r4)]
    if any(len(c) < 5 for c in cols):
        return no, data

    for k in range(5):
        rec = _parse_keibago_raceinfo(cols[0][k].select_one("div.raceInfo"))
        if rec is None:
            continue
        rec["クラス"] = cols[1][k].get_text(strip=True)

        # "7人 432 菅原辰 54.0"
        m = re.search(r"(\d+)人\s+(\d{3})?\s*(\S+)?\s+(\d{2}\.\d)", cols[2][k].get_text(" ", strip=True))
        if m:
            rec["人気"] = m.group(1)
            rec["体重"] = m.group(2) or ""
            rec["騎手"] = m.group(3) or ""
            rec["斤量"] = m.group(4)

        # "1:15.9 7-6 37.6"
        t = cols[3][k].get_text(" ", strip=True)
        m1 = re.search(r"\d:\d{2}\.\d", t)
        rec["タイム"] = m1.group(0) if m1 else ""
        m2 = re.search(r"\b\d{1,2}(?:-\d{1,2}){1,3}\b", t)
        rec["通過"] = m2.group(0) if m2 else ""
        m3 = re.search(r"(\d{2}\.\d)\s*$", t)
        rec["上がり"] = m3.group(1) if m3 else ""

        # "1.7 カンフーヒーロー"：負けは +1.7（勝ち馬から遅れた秒）、勝ちは -1.0（2着につけた差）
        m4 = re.match(r"(\d+\.\d)", cols[4][k].get_text(" ", strip=True))
        if m4:
            rec["差"] = ("-" if rec["着順"] == "1着" else "+") + m4.group(1)
        else:
            rec["差"] = ""

        data["過去成績"].append(rec)
    return no, data


def _parse_keibago_raceinfo(ri):
    """div.raceInfo 1要素から過去成績レコードを作る。
    例: "7 26.10.19 稍重 10頭 / 盛岡 左1200 2番"、"16 26.08.30 良 16頭 / Ｊ札幌 芝右2000 8番" """
    if ri is None:
        return None
    rank_el = ri.select_one(".pastRank")
    if not rank_el:
        return None
    rank_text = rank_el.get_text(strip=True)
    m_rank = re.search(r"rank_(\d{2})", " ".join(rank_el.get("class") or []))
    if rank_text.isdigit():
        rec = {"着順": rank_text + "着"}
    elif m_rank and rank_text == "":
        rec = {"着順": f"{int(m_rank.group(1))}着"}
    else:
        rec = {"着順": rank_text}  # "取止", "除外" 等

    text = ri.get_text(" ", strip=True)
    m_date = re.search(r"(\d{2})\.(\d{2})\.(\d{2})\s+(良|稍重|稍|重|不良|不)\s+(\d+)頭", text)
    if not m_date:
        return None
    rec["日付"] = f"20{m_date.group(1)}/{m_date.group(2)}/{m_date.group(3)}"
    rec["馬場"] = COND_MAP.get(m_date.group(4), m_date.group(4))
    rec["頭数"] = m_date.group(5)

    m_venue = re.search(r"(\S+)\s+(芝)?([右左直])[内外線]?(\d{3,4})\s+(\d+)番", text[m_date.end():])
    if m_venue:
        rec["競馬場"] = m_venue.group(1).lstrip("Ｊ")
        rec["JRA"] = m_venue.group(1).startswith("Ｊ")
        rec["回り"] = m_venue.group(3)
        rec["距離"] = ("芝" if m_venue.group(2) else "ダ") + m_venue.group(4) + "m"
        rec["馬番"] = m_venue.group(5)
    return rec


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


# オッズ表の中身を1本の文字列にする（切替前後の比較用）
_COMBO_SIG_JS = """() => [...document.querySelectorAll('td.Odds[cart-item]')]
    .map(e => e.getAttribute('cart-item') + ':' + e.innerText).join('|')"""

# 表の中身が切替前と違い、オッズの数字が入っていれば true
_COMBO_CHANGED_JS = """(before) => {
    const cells = [...document.querySelectorAll('td.Odds[cart-item]')];
    const sig = cells.map(e => e.getAttribute('cart-item') + ':' + e.innerText).join('|');
    return cells.length > 0 && sig !== before && cells.some(e => /\\d+\\.\\d/.test(e.innerText));
}"""


def axis_values(soup):
    """三連複の軸馬の選択肢のうち、まだ表示していないもの（表示中・取消・除外の馬は除く）"""
    sel = soup.select_one("#list_select_horse")
    if not sel:
        return []
    opts = sel.select("option")
    current = next((o.get("value") for o in opts if o.has_attr("selected")), opts[0].get("value") if opts else None)
    return [o.get("value") for o in opts
            if o.get("value") and o.get("value") != current
            and not re.search(r"取消|除外", o.get_text())]


# 人気順の表を見分けるための券種名（表の直前の見出しや表の1行目に出る）
_BET_LABELS = {"3連複": "3連複", "三連複": "3連複", "3連単": "3連単", "三連単": "3連単",
               "馬単": "馬単", "馬連": "馬連", "ワイド": "ワイド", "単勝": "単勝", "枠連": "枠連", "枠単": "枠単"}


def _table_kind(table):
    """表の直前の文字（最大40個の文字列）と表の1行目から、どの券種の表かを決める"""
    prev = [t.strip() for t in table.find_all_previous(string=True, limit=200) if t.strip()][:40]
    first = table.find("tr")
    text = " ".join(reversed(prev)) + " " + (re.sub(r"\s+", " ", first.get_text(" ")) if first else "")
    best, pos = None, -1
    for label, kind in _BET_LABELS.items():
        i = text.rfind(label)
        if i > pos:
            best, pos = kind, i
    return best


def parse_ninki_sanren(html):
    """上位人気一覧（type=b0）から三連複の人気上位を読む。[{"組み合わせ","オッズ"}] を人気順で返す"""
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for table in soup.find_all("table"):
        if _table_kind(table) != "3連複":
            continue
        for tr in table.find_all("tr"):
            tds = tr.find_all("td")
            combo, odds = None, None
            for i, td in enumerate(tds):
                nums = re.findall(r"\d+(?:\.\d+)?", td.get_text(" "))
                if combo is None and len(nums) == 3 and all("." not in n for n in nums):
                    combo = "-".join(sorted(nums, key=int))
                    m = next((re.search(r"\d+\.\d", x.get_text(" ").replace(",", "")) for x in tds[i + 1:]
                              if re.search(r"\d+\.\d", x.get_text(" "))), None)
                    odds = m.group(0) if m else None
                    break
            if combo and odds:
                out.append({"組み合わせ": combo, "オッズ": odds})
        if out:
            break
    out.sort(key=lambda c: float(c["オッズ"]))
    return out[:10]


def scrape_sanren(page, odds_url):
    """三連複の人気上位10組を返す。まず上位人気一覧（1ページ）から読み、読めなければ軸ごとの表から集める"""
    html = fetch_page(page, odds_url + "b0")
    if html:
        try:
            page.wait_for_function("() => document.body.innerText.includes('3連複')", timeout=TIMEOUT_SELECTOR)
            html = page.content()
        except PlaywrightTimeout:
            pass
        top = parse_ninki_sanren(html)
        if top:
            print(f"  三連複: {len(top)}組取得（上位人気一覧）")
            return top, ""
    print("  上位人気一覧から読めなかったため、軸ごとの表から集めます")
    return scrape_combo_odds(page, odds_url + "b7", "三連複")


def scrape_combo_odds(page, url, label):
    """人気上位10組と注記（読めなかった部分があれば）を返す"""
    html = fetch_page(page, url, "td.Odds[cart-item]")
    if not html:
        return [], ""
    all_combos = {}
    _extract_combos(html, all_combos)

    # 三連複は軸馬ごとに表が切り替わるので、全軸馬を順に読む
    note = ""
    if "type=b7" in url:
        values = axis_values(BeautifulSoup(html, "html.parser"))
        skipped = []
        for val in values:
            try:
                before = page.evaluate(_COMBO_SIG_JS)
                wait_interval()
                page.select_option("#list_select_horse", value=val)
                # 切替前の表にも td.Odds[cart-item] はあるため、セレクタ待ちでは古い表を読んでしまう。
                # 表の中身（組み合わせとオッズ）が切替前から変わり、オッズの数字が入るまで待つ
                page.wait_for_function(_COMBO_CHANGED_JS, arg=before, timeout=TIMEOUT_SELECTOR)
                _extract_combos(page.content(), all_combos)
            except Exception:
                skipped.append(val)
        if skipped:
            note = (f"三連複オッズは軸 {len(values)}頭中 {len(skipped)}頭分の表を読めなかった"
                    "（人気上位10組が不完全な可能性）")
            print(f"  ※{note}")

    top = sorted(all_combos.values(), key=lambda x: x["オッズ"])[:10]
    print(f"  {label}: {len(top)}組取得（全{len(all_combos)}組中）")
    return [{"組み合わせ": c["組み合わせ"], "オッズ": c["オッズ表示"]} for c in top], note


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


def add_derived_fields(h, race_date):
    """前走からの間隔・乗り替わり・斤量差をスクリプト側で計算する"""
    past = h.get("過去成績") or []
    h["前走間隔"], h["乗替"], h["斤量差"] = "", "", ""
    if not past:
        return
    last = past[0]
    try:
        days = (datetime.strptime(race_date, "%Y%m%d")
                - datetime.strptime(last.get("日付", ""), "%Y/%m/%d")).days
        h["前走間隔"] = f"{days}日"
    except ValueError:
        pass
    # keiba.go.jp の騎手名は略記（例: 菅原辰）なので前方一致で比べる
    now_j, last_j = h.get("騎手", ""), last.get("騎手", "")
    if now_j and last_j:
        h["乗替"] = "なし" if now_j.startswith(last_j) or last_j.startswith(now_j) else f"あり（前走 {last_j}）"
    try:
        diff = float(h.get("斤量", "")) - float(last.get("斤量", ""))
        h["斤量差"] = f"{diff:+.1f}"
    except ValueError:
        pass


def add_market_prob(horses):
    """単勝オッズから各馬の市場勝率(%)を計算して h["市場勝率"] に入れる。
    市場勝率 =（1/オッズ）÷ 全出走馬の（1/オッズ）の合計。
    返り値は単勝の払戻率の目安 = 1 ÷ Σ(1/オッズ)（オッズの端数切り捨てがあるので概算）"""
    inv = {}
    for h in horses:
        if h.get("取消"):
            continue
        try:
            odds = float(h.get("単勝", ""))
        except ValueError:
            continue
        if odds > 0:
            inv[h["馬番"]] = 1 / odds
    total = sum(inv.values())
    for h in horses:
        h["市場勝率"] = inv[h["馬番"]] / total * 100 if total and h["馬番"] in inv else None
    # 単勝が欠けた馬がいると Σ(1/オッズ) が小さくなり払戻率を過大に見積もるので、全頭そろったときだけ返す
    active = sum(1 for h in horses if not h.get("取消"))
    return 1 / total if total and len(inv) == active else None


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
                  wide_top=None, sanren_top=None, warnings=None, payout_rate=None):
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
    if payout_rate:
        lines += [f"単勝の払戻率（オッズから逆算した目安）: {payout_rate * 100:.1f}%"
                  "　※市場勝率は控除分を除いて合計100%にそろえた値", ""]

    cols = [("馬番", 4, ">"), ("馬名", 20, "<"), ("性齢", 5, "<"), ("斤量", 5, ">"),
            ("騎手", 11, "<"), ("調教師", 11, "<"), ("馬体重", 9, ">"),
            ("単勝", 7, ">"), ("市場勝率", 9, ">"), ("人気", 5, ">"), ("複勝", 12, ">"), ("脚質", 5, "<")]
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
                h.get("単勝", "--"),
                f"{h['市場勝率']:.1f}%" if h.get("市場勝率") is not None else "--",
                h.get("人気", ""), h.get("複勝", "--"), h.get("脚質", "")]
        lines.append(" ".join(pad(v, w, a) for v, (_, w, a) in zip(vals, cols)))
    lines.append(rule)

    # 各馬の過去成績
    pcols = [("日付", 10, "<"), ("競馬場", 8, "<"), ("回", 2, "<"), ("距離", 7, "<"),
             ("馬場", 4, "<"), ("頭数", 4, ">"), ("馬番", 4, ">"), ("人気", 4, ">"),
             ("着順", 4, ">"), ("差", 5, ">"), ("タイム", 6, ">"), ("通過", 11, ">"),
             ("上がり", 6, ">"), ("騎手", 8, "<"), ("斤量", 4, ">"), ("体重", 4, ">"), ("クラス", 0, "<")]
    lines += [
        "", "【各馬の過去成績（直近5走、上が新しい）】",
        "凡例: 差=1着馬とのタイム差（+は遅れた秒数、-は自身が1着で2着馬につけた差）／回=回り（左・右）",
        "      成績=1着-2着-3着-着外（全=全成績、左・右=回り別、場=今回の競馬場、距=今回の距離）",
        "      騎手コンビ=今回の騎手でのこの馬の成績／前走間隔・乗替・斤量差は今回との比較",
        "",
        " ".join(pad(c, w, a) for c, w, a in pcols),
    ]
    lines.append("-" * 130)

    for h in horses:
        if h.get("取消"):
            continue
        cond = h.get("条件別成績") or {}
        info = []
        if cond:
            info.append("成績 " + " ".join(f"{k}{v}" for k, v in cond.items()))
        if h.get("持ち時計"):
            info.append(f"持ち時計 {h['持ち時計']}")
        if h.get("コンビ"):
            info.append(f"騎手コンビ {h['コンビ']}")
        for key in ("前走間隔", "乗替", "斤量差"):
            if h.get(key):
                info.append(f"{key} {h[key]}")
        lines.append(f"■ {h['馬番']} {h['馬名']}" + ("｜" + "｜".join(info) if info else ""))

        hist = h.get("過去成績", [])
        if not hist:
            lines.append("  （過去成績を取得できず）")
            continue
        for r in hist:
            r = dict(r)
            if r.get("JRA"):
                r["競馬場"] = r.get("競馬場", "") + "(J)"
            r["回"] = r.get("回り", "")
            lines.append(" ".join(pad(r.get(c, ""), w, a) for c, w, a in pcols))
        lines.append("")

    for label, combos in (("ワイド", wide_top), ("三連複", sanren_top)):
        if combos:
            lines += ["", f"【{label} 人気上位】"]
            for i, c in enumerate(combos[:10], 1):
                lines.append(f"  {i:2d}位  {pad(c['組み合わせ'], 8)}  {c['オッズ']}倍")

    if warnings:
        lines += ["", "【データの欠損】"] + [f"・{w}" for w in warnings]

    lines += ["", *PROMPT_TEXT.replace("{EV_MIN}", f"{EV_MIN:.1f}").strip().split("\n")]
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

    print("\n[馬柱: keiba.go.jp]")
    card = scrape_keibago(page, keibajo_name, race_date, race_no)
    for h in horses:
        d = card.get(h["馬番"])
        if not d:
            continue
        # keiba.go.jp の過去成績は人気・騎手・着差なども含むので、取れたら優先して使う
        if d["過去成績"] or h.get("要補完"):
            h["過去成績"] = d["過去成績"]
        h["条件別成績"] = d["条件別成績"]
        h["持ち時計"] = d["持ち時計"]
        h["コンビ"] = d["コンビ"]
    for h in horses:
        add_derived_fields(h, race_date)

    print("\n[単勝・複勝オッズ]")
    tan_fuku = scrape_tan_fuku(page, odds_url + "b1")
    print("\n[ワイドオッズ]")
    wide_top, _ = scrape_combo_odds(page, odds_url + "b5", "ワイド")
    print("\n[三連複オッズ]")
    sanren_top, sanren_note = scrape_sanren(page, odds_url)

    merged = merge_data(horses, tan_fuku)
    payout_rate = add_market_prob(merged)
    warnings = check_data(merged)
    if sanren_note:
        warnings.append(sanren_note)
    text = format_for_ai(merged, keibajo_name, race_date, race_no, race_info,
                         wide_top, sanren_top, warnings, payout_rate)

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

    record = new_record(race_id, keibajo_name, race_date, race_no, race_info, merged, payout_rate)
    save_record(record)
    ask_ai_answer(record, path.with_name(path.stem + "_ai.txt"), text)


# ========== 予想の記録 ==========

def new_record(race_id, keibajo, race_date, race_no, race_info, horses, payout_rate):
    """収集時点のオッズと市場勝率を記録用の dict にする（AI の回答と結果はあとで入る）"""
    ri = race_info or {}
    return {
        "race_id": race_id,
        "日付": race_date,
        "競馬場": keibajo,
        "レース番号": race_no,
        "レース名": ri.get("レース名", ""),
        "クラス": ri.get("クラス", ""),
        "収集時刻": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "EV_MIN": EV_MIN,
        "払戻率": payout_rate,
        "馬": {
            str(int(h["馬番"])): {"馬名": h.get("馬名", ""), "単勝": h.get("単勝", "--"),
                        "市場勝率": h.get("市場勝率"), "取消": bool(h.get("取消"))}
            for h in horses
        },
        "AI": None,
        "結果": None,
    }


def record_path(race_id):
    return RECORD_DIR / f"{race_id}.json"


def save_record(record):
    RECORD_DIR.mkdir(parents=True, exist_ok=True)
    record_path(record["race_id"]).write_text(
        json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")


def load_records():
    if not RECORD_DIR.exists():
        return []
    recs = []
    for f in sorted(RECORD_DIR.glob("*.json")):
        try:
            recs.append(json.loads(f.read_text(encoding="utf-8")))
        except (OSError, ValueError) as e:
            print(f"  記録を読めませんでした: {f.name}（{e}）")
    return recs


def read_clipboard():
    """Windows のクリップボードの文字列を返す。読めなければ空文字"""
    if sys.platform == "win32":
        try:
            r = subprocess.run(
                ["powershell", "-NoProfile", "-Command",
                 "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw"],
                capture_output=True, check=True)
            return r.stdout.decode("utf-8", errors="replace")
        except Exception:
            pass
    try:
        import tkinter
        root = tkinter.Tk()
        root.withdraw()
        text = root.clipboard_get()
        root.destroy()
        return text
    except Exception:
        return ""


def _num(text):
    """'12.5' '12.5%' '1,000円' などを float にする。読めなければ None"""
    t = re.sub(r"[%％円,，\s]", "", str(text))
    try:
        return float(t)
    except ValueError:
        return None


def normalize_bet_type(name):
    """券種名をそろえる（三連複→3連複 など）"""
    t = re.sub(r"\s", "", str(name)).replace("三", "3").replace("３", "3")
    return {"3複": "3連複", "3単": "3連単"}.get(t, t)


# 券種ごとの (組み合わせの頭数, 着順の順序を区別するか)
BET_SPECS = {
    "単勝": (1, False), "複勝": (1, False),
    "枠連": (2, False), "馬連": (2, False), "ワイド": (2, False),
    "枠単": (2, True), "馬単": (2, True),
    "3連複": (3, False), "3連単": (3, True),
}


def combo_key(bet_type, numbers):
    """組み合わせを照合用の文字列にする。順序を区別しない券種は昇順に並べる"""
    nums = [str(int(n)) for n in numbers]
    if not BET_SPECS.get(bet_type, (0, False))[1]:
        nums = sorted(nums, key=int)
    return "-".join(nums)


def parse_ai_block(text):
    """AI の回答から #PRED と #BET のブロックを読む。#PRED がなければ None を返す。
    返り値: {"予想": {馬番: {"勝率": %, "複勝率": %}}, "買い目": [{"券種","組み合わせ","金額"}]}"""
    lines = [ln.strip() for ln in text.replace("\r", "").split("\n")]
    if "#PRED" not in lines:
        return None
    # 指示文の書式例にも #PRED があるので、最後に出てくる #PRED から読む
    lines = lines[len(lines) - 1 - lines[::-1].index("#PRED"):]
    pred, bets, section = {}, [], None
    for ln in lines:
        if ln in ("#PRED", "#BET"):
            section = ln
            continue
        if not ln or ln.startswith("```"):
            if section == "#BET" and ln.startswith("```"):
                break
            continue
        cells = [c.strip() for c in re.split(r"[,，\t]", ln)]
        if section == "#PRED" and len(cells) >= 3 and cells[0].isdigit():
            win, place = _num(cells[1]), _num(cells[2])
            if win is not None and place is not None:
                pred[str(int(cells[0]))] = {"勝率": win, "複勝率": place}
        elif section == "#BET" and len(cells) >= 3:
            bet_type = normalize_bet_type(cells[0])
            nums = re.findall(r"\d+", cells[1])
            amount = _num(cells[2])
            if bet_type in BET_SPECS and nums and amount:
                bets.append({"券種": bet_type, "組み合わせ": combo_key(bet_type, nums),
                             "金額": int(amount)})
    if not pred:
        return None
    return {"予想": pred, "買い目": bets}


def ask_ai_answer(record, ai_text_path, scraped_text=None):
    """AI の回答をクリップボードから読み、記録に加える。s で記録しない"""
    while True:
        ans = input("\nAI の回答（記録用ブロックを含む全文）をコピーしたら Enter"
                    " [s=記録しない]: ").strip().lower()
        if ans == "s":
            print("  記録しませんでした（あとで run.bat record で記録できます）。")
            return False
        text = read_clipboard()
        if scraped_text and text.strip() == scraped_text.strip():
            print("  クリップボードの中身が収集データのままです。AI の回答をコピーしてください。")
            continue
        parsed = parse_ai_block(text)
        if not parsed:
            print("  記録用ブロック（#PRED）が見つかりません。回答の全文をコピーし直してください。")
            continue
        total = sum(v["勝率"] for v in parsed["予想"].values())
        if abs(total - 100) > 5:
            print(f"  ※推定勝率の合計が {total:.1f}% です（100% から外れています）。そのまま記録します。")
        record["AI"] = {**parsed, "記録時刻": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
        save_record(record)
        ai_text_path.write_text(text, encoding="utf-8")
        bets = parsed["買い目"]
        desc = " / ".join(f"{b['券種']} {b['組み合わせ']} {b['金額']}円" for b in bets) or "見送り"
        print(f"  記録しました: {len(parsed['予想'])}頭の予想、買い目 {desc}")
        return True


def run_record():
    """AI の回答が未記録のレースを選んで、あとから記録する"""
    recs = [r for r in load_records() if not r.get("AI")]
    if not recs:
        print("\nAI の回答が未記録のレースはありません。")
        return
    recs = recs[-15:]
    print("\nAI の回答が未記録のレース（新しい順に最大15件）:")
    recs.reverse()
    for i, r in enumerate(recs, 1):
        print(f"  {i:2d}. {r['日付']} {r['競馬場']} {r['レース番号']}R {r.get('レース名', '')}")
    r = recs[ask_choice("\n番号: ", len(recs)) - 1]
    path = OUTPUT_DIR / f"{r['日付']}_{r['競馬場']}{r['レース番号']}R_ai.txt"
    ask_ai_answer(r, path)


# ========== レース結果の取得 ==========

# 着順表と払戻表が描画されるまで待つ（クラス名に頼らず、見出しの文字で判定する）
_RESULT_READY_JS = """() => {
    const hasOrder = [...document.querySelectorAll('table')].some(
        t => t.innerText.includes('着順') && t.innerText.includes('馬番')
             && t.querySelectorAll('td').length > 10);
    const hasPay = /単勝[\\s\\S]{0,80}円/.test(document.body.innerText);
    return hasOrder && hasPay;
}"""


def _cell_texts(tr):
    return [re.sub(r"\s+", "", c.get_text()) for c in tr.find_all(["th", "td"])]


def parse_result(html):
    """結果ページから着順と払戻を読む。
    返り値: {"着順": {馬番: "1" / "取消" など}, "払戻": {券種: {組み合わせ: 円(100円あたり)}}, "注記": [...]}"""
    soup = BeautifulSoup(html, "html.parser")
    order, notes = {}, []

    # 着順表: 見出し行に「着順」と「馬番」がある表
    for table in soup.find_all("table"):
        rows = table.find_all("tr")
        head = next((tr for tr in rows if tr.find("th")), None)
        if not head:
            continue
        headers = _cell_texts(head)
        if "着順" not in headers or "馬番" not in headers:
            continue
        i_rank, i_no = headers.index("着順"), headers.index("馬番")
        for tr in rows:
            tds = tr.find_all("td")
            if len(tds) <= max(i_rank, i_no):
                continue
            no = re.sub(r"\D", "", tds[i_no].get_text())
            rank = re.sub(r"\s+", "", tds[i_rank].get_text())
            if no:
                order[str(int(no))] = rank
        if order:
            break

    # 払戻表: 行の先頭が券種名で、続くセルが「組み合わせ」「払戻（○円）」の行
    payouts = {}
    for tr in soup.find_all("tr"):
        cells = tr.find_all(["th", "td"])
        if len(cells) < 3:
            continue
        bet_type = normalize_bet_type(cells[0].get_text())
        if bet_type not in BET_SPECS:
            continue
        k = BET_SPECS[bet_type][0]
        nums = re.findall(r"\d+", cells[1].get_text(" "))
        pays = [int(x.replace(",", "")) for x in re.findall(r"([\d,]+)\s*円", cells[2].get_text(" "))]
        if not pays:
            continue
        combos = [nums[i:i + k] for i in range(0, len(nums), k)]
        if len(combos) != len(pays) or any(len(c) != k for c in combos):
            notes.append(f"{bet_type}の払戻を読めませんでした（組み合わせ {len(combos)} / 払戻 {len(pays)}）")
            continue
        table = payouts.setdefault(bet_type, {})
        for c, pay in zip(combos, pays):
            table[combo_key(bet_type, c)] = pay
    return {"着順": order, "払戻": payouts, "注記": notes}


def scrape_result(page, race_id):
    url = f"{NETKEIBA}/race/result.html?race_id={race_id}"
    html = fetch_page(page, url)
    if not html:
        return None
    try:
        page.wait_for_function(_RESULT_READY_JS, timeout=TIMEOUT_SELECTOR)
        html = page.content()
    except PlaywrightTimeout:
        pass  # 未確定のときは表が出ない。取れた分で判定する
    res = parse_result(html)
    finished = any(v.isdigit() for v in res["着順"].values())
    if not finished or "単勝" not in res["払戻"]:
        return None
    res["取得時刻"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return res


# ========== 検証 ==========

def settle_bets(record):
    """買い目ごとの払戻を計算する。払戻が読めていない券種があれば None を返す
    （出走取消を含む買い目は返還として購入額をそのまま戻す）"""
    res, ai = record["結果"], record["AI"]
    scratched = {no for no, rank in res["着順"].items() if rank in ("取消", "除外")}
    rows = []
    for b in ai["買い目"]:
        if set(b["組み合わせ"].split("-")) & scratched:
            ret, status = b["金額"], "返還"
        elif b["券種"] not in res["払戻"]:
            return None
        else:
            pay = res["払戻"][b["券種"]].get(b["組み合わせ"])
            ret = b["金額"] // 100 * pay if pay else 0
            status = "的中" if pay else "不的中"
        rows.append({**b, "払戻": ret, "判定": status})
    return rows


def horse_rows(record):
    """キャリブレーション用に、馬ごとの (市場勝率, AI勝率, AI複勝率, 1着か, 複勝圏か) を作る。
    取消・除外の馬を除き、市場勝率と AI 勝率は残った馬で合計1にそろえ直す"""
    res, pred = record["結果"], record["AI"]["予想"]
    runners = [no for no, rank in res["着順"].items() if rank not in ("取消", "除外")]
    rows = []
    for no in runners:
        m = record["馬"].get(no, {}).get("市場勝率")
        a = pred.get(no)
        if m is None or a is None:
            return []  # 欠けがあるレースは比較が公平でないので使わない
        rows.append({"馬番": no, "市場": m / 100, "AI勝率": a["勝率"] / 100,
                     "AI複勝率": a["複勝率"] / 100, "着順": res["着順"][no]})
    sm, sa = sum(r["市場"] for r in rows), sum(r["AI勝率"] for r in rows)
    place_n = 3 if len(runners) >= 8 else 2  # 7頭以下は複勝が2着まで
    for r in rows:
        r["市場"] /= sm
        r["AI勝率"] /= sa
        r["1着"] = 1 if r["着順"] == "1" else 0
        r["複勝圏"] = 1 if r["着順"].isdigit() and int(r["着順"]) <= place_n else 0
    return rows


def bootstrap_ci(values_fn, n_items, b=2000, seed=0):
    """レース単位で復元抽出して統計量の95%区間（2.5%・97.5%点）を返す"""
    rng = random.Random(seed)
    stats = []
    for _ in range(b):
        idx = [rng.randrange(n_items) for _ in range(n_items)]
        v = values_fn(idx)
        if v is not None:
            stats.append(v)
    if not stats:
        return None, None
    stats.sort()
    return stats[int(0.025 * len(stats))], stats[int(0.975 * len(stats)) - 1]


def calibration_table(pairs, edges):
    """(予測確率, 実績0/1) の組を区間に分け、件数・予測の平均・実績の割合を返す"""
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        sel = [(p, y) for p, y in pairs if lo <= p * 100 < hi or (hi == 100 and p * 100 == 100)]
        if sel:
            out.append((lo, hi, len(sel), sum(p for p, _ in sel) / len(sel) * 100,
                        sum(y for _, y in sel) / len(sel) * 100))
    return out


def summarize(records):
    """記録済みのレースから回収率・キャリブレーションを集計してテキストを返す"""
    lines = ["=" * 60, "  検証結果", "=" * 60]
    races = [r for r in records if r.get("AI") and r.get("結果")]
    lines.append(f"対象: 結果まで記録済みのレース {len(races)}件"
                 f"（AI 回答なし {sum(1 for r in records if not r.get('AI'))}件・"
                 f"結果未取得 {sum(1 for r in records if r.get('AI') and not r.get('結果'))}件は除外）")
    if not races:
        return "\n".join(lines)

    # ---- 回収率 ----
    bet_rows, per_race, skipped, unknown = [], [], 0, 0
    for r in races:
        rows = settle_bets(r)
        if rows is None:
            unknown += 1
            continue
        if not rows:
            skipped += 1
            continue
        for row in rows:
            bet_rows.append({"race_id": r["race_id"], "日付": r["日付"], "競馬場": r["競馬場"],
                             "レース番号": r["レース番号"], **row})
        per_race.append((sum(x["金額"] for x in rows), sum(x["払戻"] for x in rows)))
    lines += ["", "【回収率】",
              f"  買ったレース {len(per_race)}件 / 見送り {skipped}件"
              + (f" / 払戻を読めず除外 {unknown}件" if unknown else "")]
    if per_race:
        spent = sum(a for a, _ in per_race)
        ret = sum(b for _, b in per_race)
        hit_races = sum(1 for a, b in per_race if b > 0)
        lo, hi = bootstrap_ci(
            lambda idx: (sum(per_race[i][1] for i in idx) / s if (s := sum(per_race[i][0] for i in idx)) else None),
            len(per_race))
        lines.append(f"  購入 {spent:,}円 → 払戻 {ret:,}円　回収率 {ret / spent * 100:.1f}%"
                     + (f"（95%区間 {lo * 100:.0f}〜{hi * 100:.0f}%）" if lo is not None else ""))
        lines.append(f"  的中したレース {hit_races}/{len(per_race)}件")
        by_type = {}
        for x in bet_rows:
            t = by_type.setdefault(x["券種"], [0, 0, 0, 0])
            t[0] += 1
            t[1] += x["判定"] == "的中"
            t[2] += x["金額"]
            t[3] += x["払戻"]
        for k, (n, hit, a, b) in by_type.items():
            lines.append(f"  {pad(k, 6)} {n:3d}点 的中{hit:3d}点　購入 {a:,}円 → {b:,}円（{b / a * 100:.0f}%）")

    # ---- 推定確率の精度 ----
    race_rows = [rows for r in races if (rows := horse_rows(r))]
    lines += ["", "【推定勝率の精度（ブライアスコア、小さいほど良い）】"]
    if race_rows:
        def brier(rows, key):
            return sum((x[key] - x["1着"]) ** 2 for x in rows)
        bm = [brier(rows, "市場") for rows in race_rows]
        ba = [brier(rows, "AI勝率") for rows in race_rows]
        n = len(race_rows)
        diff = [a - m for a, m in zip(ba, bm)]
        lo, hi = bootstrap_ci(lambda idx: sum(diff[i] for i in idx) / len(idx), n)
        lines.append(f"  対象 {n}レース　市場 {sum(bm) / n:.4f} / AI {sum(ba) / n:.4f}")
        lines.append(f"  AI − 市場 = {sum(diff) / n:+.4f}（95%区間 {lo:+.4f}〜{hi:+.4f}）")
        if hi < 0:
            lines.append("  → AI の推定勝率は市場（単勝オッズ）より当たっている")
        elif lo > 0:
            lines.append("  → AI の推定勝率は市場（単勝オッズ）より外れている")
        else:
            lines.append("  → AI と市場の差は、このレース数では区別できない")

        all_rows = [x for rows in race_rows for x in rows]
        edges = [0, 5, 10, 20, 35, 100]
        lines += ["", "【キャリブレーション：推定勝率】（推定○%の馬が実際に何%勝ったか）",
                  "  区間        件数  AI推定  実際    |  件数  市場推定  実際"]
        ai_tab = {(lo, hi): v for lo, hi, *v in calibration_table([(x["AI勝率"], x["1着"]) for x in all_rows], edges)}
        mk_tab = {(lo, hi): v for lo, hi, *v in calibration_table([(x["市場"], x["1着"]) for x in all_rows], edges)}
        for lo_, hi_ in zip(edges[:-1], edges[1:]):
            a = ai_tab.get((lo_, hi_))
            m = mk_tab.get((lo_, hi_))
            fa = f"{a[0]:5d}  {a[1]:5.1f}% {a[2]:5.1f}%" if a else f"{'':5}  {'':6} {'':6}"
            fm = f"{m[0]:5d}  {m[1]:6.1f}%  {m[2]:5.1f}%" if m else ""
            lines.append(f"  {lo_:3d}〜{hi_:3d}%  {fa}  |  {fm}")

        place_pairs = [(x["AI複勝率"], x["複勝圏"]) for x in all_rows]
        bp = sum((p - y) ** 2 for p, y in place_pairs) / len(place_pairs)
        lines += ["", f"【キャリブレーション：推定複勝率】（ブライアスコア {bp:.4f}）",
                  "  区間        件数  AI推定  実際"]
        for lo_, hi_, cnt, mp, act in calibration_table(place_pairs, [0, 10, 20, 35, 50, 70, 100]):
            lines.append(f"  {lo_:3d}〜{hi_:3d}%  {cnt:5d}  {mp:5.1f}% {act:5.1f}%")

        # Excel で見る用の明細
        OUTPUT_DIR.mkdir(exist_ok=True)
        with open(OUTPUT_DIR / "verify_horses.csv", "w", encoding="utf-8-sig", newline="") as f:
            f.write("race_id,日付,競馬場,R,馬番,市場勝率,AI勝率,AI複勝率,着順\n")
            for r, rows in ((r, horse_rows(r)) for r in races):
                for x in rows:
                    f.write(f"{r['race_id']},{r['日付']},{r['競馬場']},{r['レース番号']},{x['馬番']},"
                            f"{x['市場'] * 100:.2f},{x['AI勝率'] * 100:.2f},{x['AI複勝率'] * 100:.2f},{x['着順']}\n")
    else:
        lines.append("  市場勝率と AI 推定がそろったレースがありません。")

    if bet_rows:
        with open(OUTPUT_DIR / "verify_bets.csv", "w", encoding="utf-8-sig", newline="") as f:
            f.write("race_id,日付,競馬場,R,券種,組み合わせ,金額,払戻,判定\n")
            for x in bet_rows:
                f.write(f"{x['race_id']},{x['日付']},{x['競馬場']},{x['レース番号']},{x['券種']},"
                        f"{x['組み合わせ']},{x['金額']},{x['払戻']},{x['判定']}\n")

    if len(races) < 30:
        lines += ["", f"※レース数が {len(races)}件と少ないため、区間が広く結論は出せません。"
                      "目安として50レース以上たまってから判断してください。"]
    return "\n".join(lines)


def run_verify():
    """結果が未取得のレースの結果を取りに行き、集計を表示・保存する"""
    recs = load_records()
    today = datetime.now().strftime("%Y%m%d")
    pending = [r for r in recs if r.get("AI") and not r.get("結果") and r["日付"] <= today]
    if pending:
        print(f"\n結果を取得します: {len(pending)}件")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_context(user_agent=UA).new_page()
            try:
                for r in pending:
                    label = f"{r['日付']} {r['競馬場']} {r['レース番号']}R"
                    res = scrape_result(page, r["race_id"])
                    if not res:
                        print(f"  {label}: 結果未確定または取得できず（あとで再実行してください）")
                        continue
                    r["結果"] = res
                    save_record(r)
                    note = f"（{' / '.join(res['注記'])}）" if res["注記"] else ""
                    print(f"  {label}: 取得しました{note}")
            finally:
                browser.close()
    else:
        print("\n結果を取りに行くレースはありません。")

    text = summarize(load_records())
    print("\n" + text)
    OUTPUT_DIR.mkdir(exist_ok=True)
    (OUTPUT_DIR / "verify_summary.txt").write_text(text, encoding="utf-8")
    print(f"\n集計を保存しました: {OUTPUT_DIR / 'verify_summary.txt'}")


# ========== メイン ==========

def parse_args(argv):
    """コマンドライン引数 [競馬場] [レース番号] [日付] を解釈する"""
    if not argv:
        return None
    name = argv[0]
    if name.isdigit() and name in CODE_TO_NAME:
        name = CODE_TO_NAME[name]
    name = NAME_ALIASES.get(name, name)
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

    cmd = sys.argv[1].lower() if len(sys.argv) >= 2 else ""
    if cmd in ("verify", "検証"):
        run_verify()
        return
    if cmd in ("record", "記録"):
        run_record()
        return

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
