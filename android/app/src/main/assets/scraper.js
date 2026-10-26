// scraper.js — keiba_scraper.py（PC版）の解析・整形を移植したもの。
// アプリの WebView が各ページを開いたあとにこのファイルを注入し、KS.xxx(document) を呼ぶ。
// PC版の解析を直したときは、ここも同じように直す（android/README の「PC版との対応」参照）。
(function (global) {
  "use strict";

  // ========== 設定（PC版と同じ値） ==========

  // netkeiba の競馬場コード（race_id の5〜6桁目）
  const KEIBA_CODES = {
    "門別": "30", "盛岡": "35", "水沢": "36",
    "浦和": "42", "船橋": "43", "大井": "44", "川崎": "45",
    "金沢": "46", "笠松": "47", "名古屋": "48",
    "園田": "50", "姫路": "51", "高知": "54", "佐賀": "55",
    "帯広(ば)": "65",
  };
  const CODE_TO_NAME = {};
  for (const [k, v] of Object.entries(KEIBA_CODES)) CODE_TO_NAME[v] = k;

  // keiba.go.jp (NAR公式) の競馬場コード — netkeiba と異なる
  const KEIBAGO_CODES = {
    "門別": "36", "盛岡": "10", "水沢": "11",
    "浦和": "18", "船橋": "19", "大井": "20", "川崎": "21",
    "金沢": "22", "笠松": "23", "名古屋": "24",
    "園田": "27", "姫路": "28", "高知": "31", "佐賀": "32",
  };

  const NETKEIBA = "https://nar.netkeiba.com";
  const COND_MAP = { "稍": "稍重", "不": "不良", "良": "良", "重": "重", "稍重": "稍重", "不良": "不良" };

  // 買い目の条件の既定値（PC版の BUDGET・MAX_BETS・EV_MIN と同じ）。アプリでは設定画面で変えられる
  const EV_MIN = 1.2;
  const DEFAULT_SETTINGS = { budget: 1000, max_bets: 3, ev_min: EV_MIN };

  // AI への指示文（PC版の PROMPT_TEXT と同じ文面にそろえる）
  const PROMPT_TEXT = `
【AIへの指示】
上記データだけを使って、このレースの買い目を決めてください。

■ 目的と制約
・目的は回収率（期待値）の最大化です。的中率の高さは目的ではありません。
・予算は{BUDGET}円、最大{MAX_BETS}点、各100円単位。期待値が{EV_MIN}以上の買い目がなければ「見送り」と答えてください。
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
5. 買い目：期待値 = 推定的中率 × オッズ で計算する。複勝・ワイドのオッズは幅の下限を使う。期待値{EV_MIN}以上の候補から、期待値の高い順に最大{MAX_BETS}点を選び、資金を配分する。

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
`;

  // ========== 文字列ユーティリティ ==========

  // BeautifulSoup の get_text(sep, strip=True) と同じ：テキストノードを前後空白を除いて sep でつなぐ
  function gt(el, sep) {
    if (!el) return "";
    const doc = el.ownerDocument || el;
    const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
    const parts = [];
    let n;
    while ((n = walker.nextNode())) {
      const p = n.nodeValue.trim();
      if (p) parts.push(p);
    }
    return parts.join(sep || "");
  }

  // BeautifulSoup の get_text()（前後空白を除かない）
  function raw(el) {
    return el ? el.textContent : "";
  }

  // 全角文字を2、半角文字を1とした表示幅（Python の east_asian_width が F/W/A の文字を2とするのに近づける）
  function charWidth(c) {
    const cp = c.codePointAt(0);
    if (cp < 0x80) return 1;
    if ((cp >= 0xff61 && cp <= 0xff9f)) return 1; // 半角カナ
    if (cp >= 0x1100) return 2;
    // ラテン補助・記号などの曖昧幅（A）は2として扱う（PC版と同じ）
    if (cp >= 0xa1) return AMBIGUOUS.has(cp) ? 2 : 1;
    return 1;
  }
  // 0x00A1〜0x10FF の曖昧幅のうち出力に出うる主なもの
  const AMBIGUOUS = new Set([0xa1, 0xa4, 0xa7, 0xa8, 0xaa, 0xad, 0xae, 0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb6, 0xb7,
    0xb8, 0xb9, 0xba, 0xbc, 0xbd, 0xbe, 0xbf, 0xc6, 0xd0, 0xd7, 0xd8, 0xde, 0xdf, 0xe0, 0xe1, 0xe6, 0xe8, 0xe9,
    0xea, 0xec, 0xed, 0xf0, 0xf2, 0xf3, 0xf7, 0xf8, 0xf9, 0xfa, 0xfc, 0xfe]);

  function dispWidth(s) {
    let w = 0;
    for (const c of String(s)) w += charWidth(c);
    return w;
  }

  function pad(s, width, align) {
    s = String(s);
    const space = " ".repeat(Math.max(0, width - dispWidth(s)));
    return align === ">" ? space + s : s + space;
  }

  function hasClassMatching(el, re) {
    return [...el.classList].some((c) => re.test(c));
  }

  function nowStamp() {
    const d = new Date();
    const z = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
  }

  // ========== 開催一覧 ==========

  function parseRaceList(doc) {
    const venues = [];
    for (const dl of doc.querySelectorAll("dl.RaceList_DataList")) {
      const races = [];
      for (const li of dl.querySelectorAll("li.RaceList_DataItem")) {
        const a = li.querySelector("a[href*='race_id=']");
        if (!a) continue;
        const m = (a.getAttribute("href") || "").match(/race_id=(\d{12})/);
        if (!m) continue;
        const raceId = m[1];
        const data = li.querySelector(".RaceData");
        const timeEl = data ? data.querySelector("span") : null;
        const heads = raw(li).match(/(\d+)頭/);
        const titleEl = li.querySelector(".ItemTitle");
        races.push({
          race_id: raceId,
          no: parseInt(raceId.slice(-2), 10),
          time: gt(timeEl),
          title: gt(titleEl),
          heads: heads ? heads[1] : "",
        });
      }
      if (!races.length) continue;
      const code = races[0].race_id.slice(4, 6);
      let name = CODE_TO_NAME[code];
      if (!name) {
        // 未登録の競馬場は見出しから名前を取る（"9回 盛岡 4日目" → "盛岡"）
        const title = dl.querySelector(".RaceList_DataTitle");
        const rawTitle = title ? gt(title, " ") : code;
        name = rawTitle.replace(/\d+回|\d+日目/g, "").trim() || code;
      }
      venues.push({ name, races });
    }
    return venues;
  }

  // 発走前で最も早いレースの位置。全レース終了なら最終レース
  function nextRaceIndex(races, raceDate) {
    const now = new Date();
    const z = (n) => String(n).padStart(2, "0");
    const today = `${now.getFullYear()}${z(now.getMonth() + 1)}${z(now.getDate())}`;
    if (raceDate !== today) return 0;
    for (let i = 0; i < races.length; i++) {
      const m = races[i].time.match(/^(\d{1,2}):(\d{2})$/);
      if (m && (+m[1] > now.getHours() || (+m[1] === now.getHours() && +m[2] > now.getMinutes()))) return i;
    }
    return races.length - 1;
  }

  // ========== 出馬表 ==========

  function parseShutuba(doc) {
    const rows = doc.querySelectorAll("table.ShutubaTable tr.HorseList");
    let horses;
    if (rows.length) {
      horses = [...rows].map(parseTrHorse).filter(Boolean);
    } else {
      horses = [...doc.querySelectorAll("dl.HorseList")].map(parseDlHorse).filter(Boolean);
    }
    const kyaku = parseKyakuType(doc);
    for (const h of horses) {
      if (!h["脚質"]) h["脚質"] = kyaku[h["馬番"]] || "";
    }
    return { horses, race_info: parseRaceInfo(doc) };
  }

  function parseTrHorse(tr) {
    const tds = [...tr.querySelectorAll("td")];
    const umaban = tds.find((td) => hasClassMatching(td, /^Umaban/));
    const no = gt(umaban);
    if (!/^\d+$/.test(no)) return null;
    const waku = tds.find((td) => hasClassMatching(td, /^Waku\d/));
    const nameA = tr.querySelector(".HorseName a");

    const h = {
      "枠番": gt(waku),
      "馬番": no,
      "馬名": nameA ? (nameA.getAttribute("title") || gt(nameA)) : "",
      "性齢": gt(tr.querySelector(".Age")),
      "騎手": gt(tr.querySelector("td.Jockey a")),
      "調教師": gt(tr.querySelector("td.Trainer a")),
      "脚質": "",
      "過去成績": [],
      "要補完": true,
    };

    h["斤量"] = "";
    for (const td of tr.querySelectorAll("td.Txt_C")) {
      const t = gt(td).replace(/[▲△☆★◇]/g, "");
      if (/^\d{2}\.\d$/.test(t)) {
        h["斤量"] = t;
        break;
      }
    }

    const m = gt(tr.querySelector("td.Weight")).match(/(\d{3})\s*\(([+-]?\d+)\)/);
    if (m) {
      h["馬体重"] = parseInt(m[1], 10);
      h["体重増減"] = parseInt(m[2], 10);
    } else {
      h["馬体重"] = "未発表";
      h["体重増減"] = 0;
    }

    const oddsM = gt(tr.querySelector("td.Popular.Txt_R")).match(/\d+\.\d/);
    h["単勝_出馬表"] = oddsM ? oddsM[0] : "";
    const ninki = gt(tr.querySelector("td.Popular.Txt_C"));
    h["人気"] = /^\d+$/.test(ninki) ? ninki : "";

    const rowText = raw(tr);
    h["取消"] = tr.classList.contains("Cancel") || rowText.includes("取消") || rowText.includes("除外");
    return h;
  }

  function parseKyakuType(doc) {
    const result = {};
    for (const tr of doc.querySelectorAll("table.Kyaku_Type tr")) {
      const label = gt(tr.querySelector("th"));
      for (const num of tr.querySelectorAll(".Kyaku_Type_Num")) {
        if (/^\d+$/.test(gt(num))) result[gt(num)] = label;
      }
    }
    return result;
  }

  function parseDlHorse(dl) {
    const h = { "取消": dl.classList.contains("Cancel") || !!dl.querySelector(".Cancel_Txt") };

    for (const dt of dl.querySelectorAll("dt")) {
      const classes = dt.getAttribute("class") || "";
      if (/\bWaku[1-8]\b/.test(classes) && !classes.includes("Waku_Horse")) {
        h["枠番"] = gt(dt);
        break;
      }
    }

    h["馬番"] = gt(dl.querySelector("dt.Waku_Horse"));
    if (!/^\d+$/.test(h["馬番"])) return null;
    h["馬名"] = gt(dl.querySelector("dt.HorseName a"));
    h["脚質"] = gt(dl.querySelector(".Horse06 .Type span"));

    const wt = dl.querySelector(".Horse07 span.transition-color");
    const m = wt ? gt(wt).match(/(\d+)kg\s*\(([+-]?\d+)\)/) : null;
    if (m) {
      h["馬体重"] = parseInt(m[1], 10);
      h["体重増減"] = parseInt(m[2], 10);
    } else {
      h["馬体重"] = "未発表";
      h["体重増減"] = 0;
    }

    const barei = dl.querySelector("dd.Jockey span.Barei");
    const tokens = barei ? gt(barei).split(/\s+/).filter(Boolean) : [];
    h["性齢"] = tokens.length ? tokens[0] : "";

    const jockeyA = dl.querySelector("dd.Jockey a");
    if (jockeyA) for (const ch of jockeyA.querySelectorAll(".Change")) ch.remove();
    h["騎手"] = gt(jockeyA);

    h["斤量"] = "";
    const jockeyDd = dl.querySelector("dd.Jockey");
    if (jockeyDd) {
      const lines = gt(jockeyDd, "\n").split("\n").reverse();
      for (const line of lines) {
        const cleaned = line.replace(/[▲△☆★]/g, "").trim();
        if (/^\d{2}\.\d$/.test(cleaned)) {
          h["斤量"] = cleaned;
          break;
        }
      }
    }

    const trainer = dl.querySelector(".Horse05 a");
    h["調教師"] = gt(trainer).replace(/^[^・]+・/, "");

    const past = [...dl.querySelectorAll("dd.Past_Wrapper li.Past")].map(parseNetkeibaPastLi).filter(Boolean);
    h["過去成績"] = past;
    h["要補完"] = dl.querySelectorAll("dd.Past_Wrapper li.Past5_Sample").length > 0 || !past.length;
    h["単勝_出馬表"] = "";
    h["人気"] = "";
    return h;
  }

  function parseNetkeibaPastLi(li) {
    const numEl = li.querySelector(".Data04 .Num");
    if (!numEl) return null;
    const t = gt(numEl);
    const rec = { "着順": /^\d+$/.test(t) ? t + "着" : t };

    const m = gt(li.querySelector(".Data01")).match(/(\d{2}\/\d{2})\s*(.+?)\s*(\d+)R/);
    if (m) {
      rec["日付"] = m[1];
      rec["競馬場"] = m[2].trim();
    }
    const d = gt(li.querySelector(".Data09"));
    rec["距離"] = d && /\d$/.test(d) ? d + "m" : d;
    const cond = gt(li.querySelector(".Data11"));
    rec["馬場"] = COND_MAP[cond] || cond;
    rec["タイム"] = gt(li.querySelector(".Data12"));
    rec["通過"] = [...li.querySelectorAll(".Data20 .Corner")].map((c) => gt(c)).filter((c) => c !== "-").join("-");
    const m2 = gt(li.querySelector(".Data21")).match(/(\d{2}\.\d)/);
    rec["上がり"] = m2 ? m2[1] : "";
    return rec;
  }

  // ========== レース基本情報 ==========

  function parseRaceInfo(doc) {
    const info = { "レース名": "", "発走": "", "距離": "不明", "馬場種別": "不明",
      "馬場状態": "不明", "クラス": "", "頭数": "" };
    info["レース名"] = gt(doc.querySelector(".RaceName"));

    const rd1 = doc.querySelector(".RaceData01");
    if (rd1) {
      const text = gt(rd1, " ");
      const m0 = text.match(/(\d{1,2}:\d{2})発走/);
      if (m0) info["発走"] = m0[1];
      const m = text.match(/(ダート|ダ|芝|障害|障)\s*(\d+)\s*m/);
      if (m) {
        info["馬場種別"] = { "ダ": "ダート", "障": "障害" }[m[1]] || m[1];
        info["距離"] = m[2] + "m";
      }
      const m2 = text.match(/馬場[:：]\s*(良|稍重|稍|重|不良|不)/);
      if (m2) info["馬場状態"] = COND_MAP[m2[1]] || m2[1];
    }

    const rd2 = doc.querySelector(".RaceData02");
    if (rd2) {
      for (const span of rd2.querySelectorAll("span")) {
        const s = gt(span);
        if (/サラ|アラ|ばん|歳|一般|重賞|オープン|[A-C]\d/.test(s)) {
          info["クラス"] = s;
          break;
        }
      }
      const m3 = raw(rd2).match(/(\d+)頭/);
      if (m3) info["頭数"] = m3[1];
    }
    return info;
  }

  // ========== keiba.go.jp 馬柱 ==========

  function keibagoUrl(keibajo, raceDate, raceNo) {
    const code = KEIBAGO_CODES[keibajo];
    if (!code) return null;
    return "https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/DebaTable" +
      `?k_babaCode=${code}&k_raceDate=${raceDate.slice(0, 4)}%2F${raceDate.slice(4, 6)}%2F${raceDate.slice(6)}` +
      `&k_raceNo=${raceNo}`;
  }

  function directChildren(el, tag) {
    return [...el.children].filter((c) => c.tagName === tag);
  }

  function parseKeibago(doc) {
    const result = {};
    const tbody = doc.querySelector("section.cardTable table tbody");
    if (!tbody) return result;
    const blocks = [];
    let cur = null;
    for (const row of directChildren(tbody, "TR")) {
      if (row.classList.contains("tBorder")) {
        cur = [row];
        blocks.push(cur);
      } else if (cur) {
        cur.push(row);
      }
    }
    for (const rows of blocks) {
      if (rows.length < 5) continue;
      const [no, data] = parseKeibagoHorse(rows);
      if (no) result[no] = data;
    }
    return result;
  }

  function parseKeibagoHorse(rows) {
    const [r0, r1, r2, r3, r4] = rows;
    const no = gt(r0.querySelector("td.horseNum"));
    if (!/^\d+$/.test(no)) return [null, {}];
    const data = { "過去成績": [], "条件別成績": {}, "持ち時計": "", "コンビ": "" };

    const arrival = r0.querySelector("table.arrival");
    if (arrival) {
      for (const tr of arrival.querySelectorAll("tr")) {
        const tds = [...tr.querySelectorAll("td")].map((td) => gt(td).replace(/\u00a0/g, ""));
        if (tds.length === 5 && ["全", "左", "右", "場", "距"].includes(tds[0])) {
          data["条件別成績"][tds[0]] = tds.slice(1).join("");
        } else if (tds.length === 2) {
          data["持ち時計"] = tds[1] ? `${tds[0]}（${tds[1]}）` : tds[0];
        }
      }
    }

    for (const td of directChildren(r1, "TD")) {
      const m = gt(td, " ").match(/^\d{2}\.\d\s+(\d+-\d+-\d+-\d+)$/);
      if (m) {
        data["コンビ"] = m[1];
        break;
      }
    }

    const cols = [r0, r1, r2, r3, r4].map((r) => directChildren(r, "TD").slice(-5));
    if (cols.some((c) => c.length < 5)) return [no, data];

    for (let k = 0; k < 5; k++) {
      const rec = parseKeibagoRaceInfo(cols[0][k].querySelector("div.raceInfo"));
      if (!rec) continue;
      rec["クラス"] = gt(cols[1][k]);

      const m = gt(cols[2][k], " ").match(/(\d+)人\s+(\d{3})?\s*(\S+)?\s+(\d{2}\.\d)/);
      if (m) {
        rec["人気"] = m[1];
        rec["体重"] = m[2] || "";
        rec["騎手"] = m[3] || "";
        rec["斤量"] = m[4];
      }

      const t = gt(cols[3][k], " ");
      const m1 = t.match(/\d:\d{2}\.\d/);
      rec["タイム"] = m1 ? m1[0] : "";
      const m2 = t.match(/\b\d{1,2}(?:-\d{1,2}){1,3}\b/);
      rec["通過"] = m2 ? m2[0] : "";
      const m3 = t.match(/(\d{2}\.\d)\s*$/);
      rec["上がり"] = m3 ? m3[1] : "";

      const m4 = gt(cols[4][k], " ").match(/^(\d+\.\d)/);
      rec["差"] = m4 ? (rec["着順"] === "1着" ? "-" : "+") + m4[1] : "";

      data["過去成績"].push(rec);
    }
    return [no, data];
  }

  function parseKeibagoRaceInfo(ri) {
    if (!ri) return null;
    const rankEl = ri.querySelector(".pastRank");
    if (!rankEl) return null;
    const rankText = gt(rankEl);
    const mRank = (rankEl.getAttribute("class") || "").match(/rank_(\d{2})/);
    let rec;
    if (/^\d+$/.test(rankText)) rec = { "着順": rankText + "着" };
    else if (mRank && rankText === "") rec = { "着順": `${parseInt(mRank[1], 10)}着` };
    else rec = { "着順": rankText };

    const text = gt(ri, " ");
    const mDate = text.match(/(\d{2})\.(\d{2})\.(\d{2})\s+(良|稍重|稍|重|不良|不)\s+(\d+)頭/);
    if (!mDate) return null;
    rec["日付"] = `20${mDate[1]}/${mDate[2]}/${mDate[3]}`;
    rec["馬場"] = COND_MAP[mDate[4]] || mDate[4];
    rec["頭数"] = mDate[5];

    const after = text.slice(mDate.index + mDate[0].length);
    const mVenue = after.match(/(\S+)\s+(芝)?([右左直])[内外線]?(\d{3,4})\s+(\d+)番/);
    if (mVenue) {
      rec["競馬場"] = mVenue[1].replace(/^Ｊ+/, "");
      rec["JRA"] = mVenue[1].startsWith("Ｊ");
      rec["回り"] = mVenue[3];
      rec["距離"] = (mVenue[2] ? "芝" : "ダ") + mVenue[4] + "m";
      rec["馬番"] = mVenue[5];
    }
    return rec;
  }

  // ========== オッズ ==========

  function rowHorseNo(tr) {
    const chk = tr.querySelector("input.HorseCheck_Select, input[type=checkbox]");
    if (chk) {
      const m = (chk.getAttribute("value") || "").match(/_c\d+_(\d+)$/);
      if (m) return m[1];
    }
    const tds = tr.querySelectorAll("td");
    if (tds.length >= 2 && /^\d+$/.test(gt(tds[1]))) return gt(tds[1]);
    return null;
  }

  // オッズのセルの文字を整える（PC版の fmt_odds と同じ）。単勝 "16.2"、複勝 "2.0 - 4.8"、数字が無ければ "--"
  function fmtOdds(text, place) {
    const nums = String(text).replace(/,/g, "").match(/\d+\.\d+/g);
    if (!nums) return "--";
    return place && nums.length >= 2 ? `${nums[0]} - ${nums[1]}` : nums[0];
  }

  // 表は見出しで見分け、見分けられなければ1つ目を単勝・2つ目を複勝とする（PC版の parse_tan_fuku と同じ）
  function parseTanFuku(doc) {
    const tables = [...doc.querySelectorAll("table.RaceOdds_HorseList_Table")];
    const kinds = tables.map((t) => tableKind(doc, t));
    let tanT = tables[0] || null, fukuT = tables[1] || null;
    if (kinds.includes("単勝") && kinds.includes("複勝")) { tanT = tables[kinds.indexOf("単勝")]; fukuT = tables[kinds.indexOf("複勝")]; }
    const parseTable = (table, place) => {
      const result = {};
      if (!table) return result;
      for (const tr of table.querySelectorAll("tr")) {
        const no = rowHorseNo(tr);
        const oddsEl = tr.querySelector("td.Odds");
        if (no && oddsEl) result[no] = fmtOdds(gt(oddsEl, " "), place);
      }
      return result;
    };
    const tan = parseTable(tanT, false);
    const fuku = parseTable(fukuT, true);
    const out = {};
    for (const no of new Set([...Object.keys(tan), ...Object.keys(fuku)])) {
      out[no] = { "単勝": tan[no] || "--", "複勝": fuku[no] || "--" };
    }
    return out;
  }

  // 組み合わせオッズを all（{組み合わせ: {...}}）に足し込む
  function extractCombos(doc, all) {
    for (const td of doc.querySelectorAll("td.Odds[cart-item]")) {
      const m = (td.getAttribute("cart-item") || "").match(/_c0_(.+)$/);
      if (!m) continue;
      const horses = m[1].split("_");
      if (!horses.every((h) => /^\d+$/.test(h))) continue;
      const key = horses.slice().sort((a, b) => +a - +b).join("-");
      const nums = gt(td, " ").replace(/,/g, "").match(/\d+\.\d+/g);
      if (!nums) continue;
      const low = parseFloat(nums[0]);
      if (!(key in all) || low < all[key]["オッズ"]) {
        all[key] = {
          "組み合わせ": key,
          "オッズ": low,
          "オッズ表示": nums.length >= 2 ? `${nums[0]} - ${nums[1]}` : nums[0],
        };
      }
    }
    return all;
  }

  function topCombos(all) {
    return Object.values(all).sort((a, b) => a["オッズ"] - b["オッズ"]).slice(0, 10)
      .map((c) => ({ "組み合わせ": c["組み合わせ"], "オッズ": c["オッズ表示"] }));
  }

  // 三連複の軸馬の選択肢のうち、まだ表示していないもの（表示中・取消・除外の馬は除く）。PC版の axis_values と同じ
  function axisValues(doc) {
    const sel = doc.querySelector("#list_select_horse");
    if (!sel) return [];
    const opts = [...sel.querySelectorAll("option")];
    const selOpt = opts.find((o) => o.hasAttribute("selected"));
    const current = selOpt ? selOpt.getAttribute("value") : (opts.length ? opts[0].getAttribute("value") : null);
    return opts.filter((o) => o.getAttribute("value") && o.getAttribute("value") !== current && !/取消|除外/.test(raw(o)))
      .map((o) => o.getAttribute("value"));
  }

  // 人気順の表を見分けるための券種名（PC版の _BET_LABELS と同じ）
  const BET_LABELS = { "3連複": "3連複", "三連複": "3連複", "3連単": "3連単", "三連単": "3連単",
    "馬単": "馬単", "馬連": "馬連", "ワイド": "ワイド", "単勝": "単勝", "複勝": "複勝", "枠連": "枠連", "枠単": "枠単" };

  // 単勝・複勝の両方の表にオッズの数字が入ったか（PC版の _TANFUKU_READY_JS と同じ）
  function tanfukuReady(doc) {
    const t = [...doc.querySelectorAll("table.RaceOdds_HorseList_Table")];
    if (t.length < 2) return false;
    const n = (x) => [...x.querySelectorAll("td.Odds")].filter((e) => /\d+\.\d/.test(e.innerText)).length;
    const a = n(t[0]), b = n(t[1]);
    return a > 0 && b >= a;
  }

  // 表の直前の文字（最大40個の文字列）と表の1行目から、どの券種の表かを決める（PC版の _table_kind と同じ）
  function tableKind(doc, table) {
    const walker = doc.createTreeWalker(doc.body || doc, 4);
    const prev = [];
    let n;
    while ((n = walker.nextNode())) {
      if (table.contains(n) || (table.compareDocumentPosition(n) & 4 /* FOLLOWING */)) break;
      const t = n.nodeValue.trim();
      if (t) prev.push(t);
    }
    const first = table.querySelector("tr");
    const firstText = first ? rawSep(first).replace(/\s+/g, " ") : "";
    const text = prev.slice(-40).join(" ") + " " + (firstText || "");
    let best = null, pos = -1;
    for (const [label, kind] of Object.entries(BET_LABELS)) {
      const i = text.lastIndexOf(label);
      if (i > pos) { best = kind; pos = i; }
    }
    return best;
  }

  // テキストノードを半角空白でつなぐ（BeautifulSoup の get_text(" ") と同じ）
  function rawSep(el) {
    const doc = el.ownerDocument || el;
    const walker = doc.createTreeWalker(el, 4);
    const parts = [];
    let n;
    while ((n = walker.nextNode())) parts.push(n.nodeValue);
    return parts.join(" ");
  }

  // 上位人気一覧（type=b0）から三連複の人気上位を読む（PC版の parse_ninki_sanren と同じ）
  function parseNinkiSanren(doc) {
    let out = [];
    for (const table of doc.querySelectorAll("table")) {
      if (tableKind(doc, table) !== "3連複") continue;
      for (const tr of table.querySelectorAll("tr")) {
        const tds = [...tr.querySelectorAll("td")];
        let combo = null, odds = null;
        for (let i = 0; i < tds.length; i++) {
          const nums = rawSep(tds[i]).match(/\d+(?:\.\d+)?/g) || [];
          if (combo === null && nums.length === 3 && nums.every((x) => !x.includes("."))) {
            combo = nums.slice().sort((a, b) => +a - +b).join("-");
            const nx = tds.slice(i + 1).find((x) => /\d+\.\d/.test(rawSep(x)));
            const m = nx ? rawSep(nx).replace(/,/g, "").match(/\d+\.\d/) : null;
            odds = m ? m[0] : null;
            break;
          }
        }
        if (combo && odds) out.push({ "組み合わせ": combo, "オッズ": odds });
      }
      if (out.length) break;
    }
    out = out.map((c, i) => [c, i]).sort((a, b) => parseFloat(a[0]["オッズ"]) - parseFloat(b[0]["オッズ"]) || a[1] - b[1]).map((x) => x[0]);
    return out.slice(0, 10);
  }

  // オッズ表の中身を1本の文字列にする（切替前後の比較用。PC版の _COMBO_SIG_JS と同じ）
  function comboSignature(doc) {
    return [...doc.querySelectorAll("td.Odds[cart-item]")]
      .map((e) => e.getAttribute("cart-item") + ":" + e.innerText).join("|");
  }

  // 表の中身が before から変わり、オッズの数字が入っていれば true（PC版の _COMBO_CHANGED_JS と同じ）
  function comboChanged(doc, before) {
    const cells = [...doc.querySelectorAll("td.Odds[cart-item]")];
    const sig = cells.map((e) => e.getAttribute("cart-item") + ":" + e.innerText).join("|");
    return cells.length > 0 && sig !== before && cells.some((e) => /\d+\.\d/.test(e.innerText));
  }

  // 三連複の軸を切り替える（select の値を変えて change を発火する）
  function selectAxis(doc, value) {
    const sel = doc.querySelector("#list_select_horse");
    if (!sel) return false;
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // ========== データマージ・計算 ==========

  function mergeData(horses, tanFuku) {
    for (const h of horses) {
      const odds = tanFuku[h["馬番"]] || {};
      h["単勝"] = odds["単勝"] || "--";
      h["複勝"] = odds["複勝"] || "--";
      if (["", "--"].includes(h["単勝"]) && h["単勝_出馬表"]) h["単勝"] = h["単勝_出馬表"];
    }
    return horses;
  }

  function parseYmd(s, fmt) {
    // fmt: "YYYYMMDD" or "YYYY/MM/DD"
    const m = fmt === "YYYYMMDD" ? String(s).match(/^(\d{4})(\d{2})(\d{2})$/) : String(s).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  }

  function addDerivedFields(h, raceDate) {
    const past = h["過去成績"] || [];
    h["前走間隔"] = "";
    h["乗替"] = "";
    h["斤量差"] = "";
    if (!past.length) return;
    const last = past[0];
    const a = parseYmd(raceDate, "YYYYMMDD");
    const b = parseYmd(last["日付"] || "", "YYYY/MM/DD");
    if (a !== null && b !== null) h["前走間隔"] = `${Math.round((a - b) / 86400000)}日`;
    const nowJ = h["騎手"] || "";
    const lastJ = last["騎手"] || "";
    if (nowJ && lastJ) {
      h["乗替"] = nowJ.startsWith(lastJ) || lastJ.startsWith(nowJ) ? "なし" : `あり（前走 ${lastJ}）`;
    }
    const x = Number(h["斤量"]);
    const y = Number(last["斤量"]);
    if (h["斤量"] && last["斤量"] && !isNaN(x) && !isNaN(y)) {
      const diff = x - y;
      h["斤量差"] = (diff >= 0 ? "+" : "-") + Math.abs(diff).toFixed(1);
    }
  }

  // 市場勝率(%)を h["市場勝率"] に入れ、単勝の払戻率の目安を返す（全頭そろわなければ null）
  function addMarketProb(horses) {
    const inv = {};
    for (const h of horses) {
      if (h["取消"]) continue;
      const o = Number(h["単勝"]);
      if (h["単勝"] && !isNaN(o) && o > 0) inv[h["馬番"]] = 1 / o;
    }
    const total = Object.values(inv).reduce((s, v) => s + v, 0);
    for (const h of horses) {
      h["市場勝率"] = total && h["馬番"] in inv ? inv[h["馬番"]] / total * 100 : null;
    }
    const active = horses.filter((h) => !h["取消"]).length;
    return total && Object.keys(inv).length === active ? 1 / total : null;
  }

  function checkData(horses) {
    const active = horses.filter((h) => !h["取消"]);
    const items = [
      ["単勝", (h) => ["", "--"].includes(h["単勝"] ?? "")],
      ["複勝", (h) => ["", "--"].includes(h["複勝"] ?? "")],
      ["騎手", (h) => !h["騎手"]],
      ["調教師", (h) => !h["調教師"]],
      ["脚質", (h) => !h["脚質"]],
      ["過去成績", (h) => !(h["過去成績"] && h["過去成績"].length)],
    ];
    const warnings = [];
    for (const [label, missing] of items) {
      const nos = active.filter(missing).map((h) => h["馬番"]);
      if (nos.length) warnings.push(`${label}未取得: 馬番 ${nos.join(", ")}`);
    }
    if (active.some((h) => h["馬体重"] === "未発表")) warnings.push("馬体重は未発表（発走約2時間前に発表）");
    return warnings;
  }

  // ========== AI貼り付け用テキスト整形 ==========

  // 期待値の下限の表示（PC版の fmt_ev と同じ：1.2 / 1.25 / 1.0）
  function fmtEv(v) { const s = Number(v).toFixed(2); return s.endsWith("0") ? s.slice(0, -1) : s; }

  // AI への指示文（PC版の prompt_text と同じ）
  function promptText(settings) {
    const st = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    return PROMPT_TEXT.split("{BUDGET}").join(String(st.budget)).split("{MAX_BETS}").join(String(st.max_bets))
      .split("{EV_MIN}").join(fmtEv(st.ev_min)).trim().split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");
  }

  // ========== 予想の記録と答え合わせ（PC版の record / verify と同じ形式・同じ計算） ==========

  // 全角数字を半角に（Python の \d・int() は全角数字も読むので、それに合わせる）
  const toHalf = (t) => String(t).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

  // '12.5' '12.5%' '1,000円' などを数にする。読めなければ null（PC版の _num）
  function num(text) {
    const t = toHalf(text).replace(/[%％円,，\s]/g, "");
    if (t === "" || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
    return parseFloat(t);
  }

  // 券種名をそろえる（三連複→3連複 など。PC版の normalize_bet_type）
  function normalizeBetType(name) {
    const t = String(name).replace(/\s/g, "").replace(/三/g, "3").replace(/３/g, "3");
    return { "3複": "3連複", "3単": "3連単" }[t] || t;
  }

  // 券種ごとの [組み合わせの頭数, 着順の順序を区別するか]（PC版の BET_SPECS）
  const BET_SPECS = {
    "単勝": [1, false], "複勝": [1, false],
    "枠連": [2, false], "馬連": [2, false], "ワイド": [2, false],
    "枠単": [2, true], "馬単": [2, true],
    "3連複": [3, false], "3連単": [3, true],
  };

  // 組み合わせを照合用の文字列にする（順序を区別しない券種は昇順。PC版の combo_key）
  function comboKey(betType, numbers) {
    let nums = numbers.map((n) => String(parseInt(toHalf(n), 10)));
    if (!(BET_SPECS[betType] || [0, false])[1]) nums = nums.slice().sort((a, b) => +a - +b);
    return nums.join("-");
  }

  // AI の回答から #PRED と #BET を読む。#PRED が無ければ null（PC版の parse_ai_block）
  function parseAiBlock(text) {
    let lines = String(text).replace(/\r/g, "").split("\n").map((l) => l.trim());
    if (!lines.includes("#PRED")) return null;
    // 指示文の書式例にも #PRED があるので、最後の #PRED から読む
    lines = lines.slice(lines.lastIndexOf("#PRED"));
    const pred = {}, bets = [];
    let section = null;
    for (const ln of lines) {
      if (ln === "#PRED" || ln === "#BET") { section = ln; continue; }
      if (!ln || ln.startsWith("```")) {
        if (section === "#BET" && ln.startsWith("```")) break;
        continue;
      }
      const cells = ln.split(/[,，\t]/).map((c) => c.trim());
      if (section === "#PRED" && cells.length >= 3 && /^\d+$/.test(toHalf(cells[0]))) {
        const win = num(cells[1]), place = num(cells[2]);
        if (win !== null && place !== null) pred[String(parseInt(toHalf(cells[0]), 10))] = { "勝率": win, "複勝率": place };
      } else if (section === "#BET" && cells.length >= 3) {
        const betType = normalizeBetType(cells[0]);
        const nums = toHalf(cells[1]).match(/\d+/g) || [];
        const amount = num(cells[2]);
        if (betType in BET_SPECS && nums.length && amount) {
          bets.push({ "券種": betType, "組み合わせ": comboKey(betType, nums), "金額": Math.trunc(amount) });
        }
      }
    }
    if (!Object.keys(pred).length) return null;
    return { "予想": pred, "買い目": bets };
  }

  // netkeiba の race_id（年4桁＋競馬場コード2桁＋月日4桁＋レース番号2桁）
  function raceIdOf(date, venue, no) {
    const code = KEIBA_CODES[venue];
    return code ? `${date.slice(0, 4)}${code}${date.slice(4, 8)}${String(no).padStart(2, "0")}` : null;
  }

  // 収集の結果から記録を作る（PC版の new_record と同じ形。AI の回答と結果はあとで入る）
  function newRecord(date, venue, no, res) {
    const info = res.info || {};
    const horses = {};
    for (const h of info.horses || []) {
      horses[String(parseInt(h.no, 10))] = { "馬名": h.name, "単勝": h.odds, "市場勝率": h.prob == null ? null : h.prob, "取消": !!h.cancel };
    }
    return {
      race_id: raceIdOf(date, venue, no), "日付": date, "競馬場": venue, "レース番号": +no,
      "レース名": info.race_name || "", "クラス": info.cls || "", "収集時刻": res.at || "",
      "払戻率": info.payout_rate == null ? null : info.payout_rate, "馬": horses, "AI": null, "結果": null,
    };
  }

  // 結果ページの着順表と払戻表が描画されたか（PC版の _RESULT_READY_JS と同じ）
  function resultReady(doc) {
    const hasOrder = [...doc.querySelectorAll("table")].some(
      (t) => t.innerText.includes("着順") && t.innerText.includes("馬番") && t.querySelectorAll("td").length > 10);
    const hasPay = /単勝[\s\S]{0,80}円/.test(doc.body.innerText);
    return hasOrder && hasPay;
  }

  // 結果ページから着順と払戻を読む（PC版の parse_result）
  function parseResult(doc) {
    const order = {}, notes = [];
    const cellTexts = (tr) => [...tr.querySelectorAll("th, td")].map((c) => raw(c).replace(/\s+/g, ""));
    for (const table of doc.querySelectorAll("table")) {
      const rows = [...table.querySelectorAll("tr")];
      const head = rows.find((tr) => tr.querySelector("th"));
      if (!head) continue;
      const headers = cellTexts(head);
      if (!headers.includes("着順") || !headers.includes("馬番")) continue;
      const iRank = headers.indexOf("着順"), iNo = headers.indexOf("馬番");
      for (const tr of rows) {
        const tds = tr.querySelectorAll("td");
        if (tds.length <= Math.max(iRank, iNo)) continue;
        const no = toHalf(raw(tds[iNo])).replace(/\D/g, "");
        const rank = raw(tds[iRank]).replace(/\s+/g, "");
        if (no) order[String(parseInt(no, 10))] = rank;
      }
      if (Object.keys(order).length) break;
    }
    const payouts = {};
    for (const tr of doc.querySelectorAll("tr")) {
      const cells = tr.querySelectorAll("th, td");
      if (cells.length < 3) continue;
      const betType = normalizeBetType(raw(cells[0]));
      if (!(betType in BET_SPECS)) continue;
      const k = BET_SPECS[betType][0];
      const nums = toHalf(rawSep(cells[1])).match(/\d+/g) || [];
      const pays = [...toHalf(rawSep(cells[2])).matchAll(/([\d,]+)\s*円/g)].map((m) => parseInt(m[1].replace(/,/g, ""), 10));
      if (!pays.length) continue;
      const combos = [];
      for (let i = 0; i < nums.length; i += k) combos.push(nums.slice(i, i + k));
      if (combos.length !== pays.length || combos.some((c) => c.length !== k)) {
        notes.push(`${betType}の払戻を読めませんでした（組み合わせ ${combos.length} / 払戻 ${pays.length}）`);
        continue;
      }
      const table = payouts[betType] || (payouts[betType] = {});
      combos.forEach((c, i) => { table[comboKey(betType, c)] = pays[i]; });
    }
    return { "着順": order, "払戻": payouts, "注記": notes };
  }

  // 確定した結果か（1頭でも着順の数字があり、単勝の払戻が読めた）
  function resultFinished(res) {
    return !!res && Object.values(res["着順"]).some((v) => /^\d+$/.test(v)) && "単勝" in res["払戻"];
  }

  // 買い目ごとの払戻（払戻の表に無い券種があれば null。取消馬を含む買い目は返還。PC版の settle_bets）
  function settleBets(record) {
    const res = record["結果"], ai = record["AI"];
    const scratched = new Set(Object.entries(res["着順"]).filter(([, r]) => r === "取消" || r === "除外").map(([n]) => n));
    const rows = [];
    for (const b of ai["買い目"]) {
      let ret, status;
      if (b["組み合わせ"].split("-").some((n) => scratched.has(n))) { ret = b["金額"]; status = "返還"; }
      else if (!(b["券種"] in res["払戻"])) return null;
      else {
        const pay = res["払戻"][b["券種"]][b["組み合わせ"]];
        ret = pay ? Math.floor(b["金額"] / 100) * pay : 0;
        status = pay ? "的中" : "不的中";
      }
      rows.push(Object.assign({}, b, { "払戻": ret, "判定": status }));
    }
    return rows;
  }

  // 馬ごとの [市場, AI勝率, AI複勝率, 1着か, 複勝圏か]（取消を除き合計1にそろえ直す。PC版の horse_rows）
  function horseRows(record) {
    const res = record["結果"], pred = record["AI"]["予想"];
    const runners = Object.entries(res["着順"]).filter(([, r]) => r !== "取消" && r !== "除外").map(([n]) => n);
    const rows = [];
    for (const no of runners) {
      const m = (record["馬"][no] || {})["市場勝率"];
      const a = pred[no];
      if (m == null || a == null) return [];
      rows.push({ "馬番": no, "市場": m / 100, "AI勝率": a["勝率"] / 100, "AI複勝率": a["複勝率"] / 100, "着順": res["着順"][no] });
    }
    const sm = rows.reduce((t, r) => t + r["市場"], 0), sa = rows.reduce((t, r) => t + r["AI勝率"], 0);
    const placeN = runners.length >= 8 ? 3 : 2;
    for (const r of rows) {
      r["市場"] /= sm; r["AI勝率"] /= sa;
      r["1着"] = r["着順"] === "1" ? 1 : 0;
      r["複勝圏"] = /^\d+$/.test(r["着順"]) && +r["着順"] <= placeN ? 1 : 0;
    }
    return rows;
  }

  // Python の random.Random(seed).randrange と同じ乱数（ブートストラップの区間を PC版とそろえるため）
  // Python の random.Random(seed) と同じ乱数列を出す（MT19937 と randrange）
  function PyRandom(seed) {
    const N = 624, M = 397;
    const mt = new Uint32Array(N); let mti = N + 1;
    const initGenrand = (s) => {
      mt[0] = s >>> 0;
      for (mti = 1; mti < N; mti++) {
        const prev = mt[mti - 1] ^ (mt[mti - 1] >>> 30);
        mt[mti] = (Math.imul(1812433253, prev) + mti) >>> 0;
      }
    };
    const initByArray = (key) => {
      initGenrand(19650218);
      let i = 1, j = 0;
      for (let k = Math.max(N, key.length); k; k--) {
        const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
        i++; j++;
        if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
        if (j >= key.length) j = 0;
      }
      for (let k = N - 1; k; k--) {
        const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
        i++;
        if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      }
      mt[0] = 0x80000000;
    };
    const genrand = () => {
      let y;
      if (mti >= N) {
        let kk;
        for (kk = 0; kk < N - M; kk++) {
          y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
          mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
        }
        for (; kk < N - 1; kk++) {
          y = (mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff);
          mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
        }
        y = (mt[N - 1] & 0x80000000) | (mt[0] & 0x7fffffff);
        mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
        mti = 0;
      }
      y = mt[mti++];
      y ^= y >>> 11;
      y ^= (y << 7) & 0x9d2c5680;
      y ^= (y << 15) & 0xefc60000;
      y ^= y >>> 18;
      return y >>> 0;
    };
    // 整数の seed は 32ビットずつに分けて init_by_array に渡す（0 は [0]）
    let s = Math.abs(seed), key = [];
    do { key.push(s % 0x100000000); s = Math.floor(s / 0x100000000); } while (s > 0);
    initByArray(key);
    const getrandbits = (k) => genrand() >>> (32 - k);
    return {
      randrange(n) {
        const k = Math.floor(Math.log2(n)) + 1;  // n.bit_length()
        let r = getrandbits(k);
        while (r >= n) r = getrandbits(k);
        return r;
      },
    };
  }

  // レース単位で復元抽出して統計量の95%区間を返す（PC版の bootstrap_ci）
  function bootstrapCi(valuesFn, n, b = 2000, seed = 0) {
    const rng = PyRandom(seed);
    const stats = [];
    for (let t = 0; t < b; t++) {
      const idx = Array.from({ length: n }, () => rng.randrange(n));
      const v = valuesFn(idx);
      if (v != null) stats.push(v);
    }
    if (!stats.length) return [null, null];
    stats.sort((x, y) => x - y);
    return [stats[Math.floor(0.025 * stats.length)], stats[Math.floor(0.975 * stats.length) - 1]];
  }

  // (予測確率, 実績0/1) を区間に分け、[下限, 上限, 件数, 予測の平均%, 実績%] を返す（PC版の calibration_table）
  function calibrationTable(pairs, edges) {
    const out = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i], hi = edges[i + 1];
      const sel = pairs.filter(([p]) => (lo <= p * 100 && p * 100 < hi) || (hi === 100 && p * 100 === 100));
      if (sel.length) {
        out.push([lo, hi, sel.length, sel.reduce((t, [p]) => t + p, 0) / sel.length * 100, sel.reduce((t, [, y]) => t + y, 0) / sel.length * 100]);
      }
    }
    return out;
  }

  const sumOf = (arr) => arr.reduce((t, v) => t + v, 0);

  // 記録から回収率・精度・キャリブレーションを計算する（PC版の compute_summary と同じ数値）
  function computeSummary(records) {
    const races = records.filter((r) => r["AI"] && r["結果"]);
    const out = {
      n_races: races.length,
      n_no_ai: records.filter((r) => !r["AI"]).length,
      n_no_result: records.filter((r) => r["AI"] && !r["結果"]).length,
      bets: null, bet_rows: [], brier: null, calib_win: null, calib_place: null,
    };
    if (!races.length) return out;

    const betRows = [], perRace = [];
    let skipped = 0, unknown = 0;
    for (const r of races) {
      const rows = settleBets(r);
      if (rows === null) { unknown++; continue; }
      if (!rows.length) { skipped++; continue; }
      for (const row of rows) betRows.push(Object.assign({ race_id: r.race_id, "日付": r["日付"], "競馬場": r["競馬場"], "レース番号": r["レース番号"] }, row));
      perRace.push([sumOf(rows.map((x) => x["金額"])), sumOf(rows.map((x) => x["払戻"]))]);
    }
    const bets = { bought: perRace.length, skipped, unknown, spent: null, ret: null, ci: null, hit_races: 0, by_type: [] };
    if (perRace.length) {
      bets.spent = sumOf(perRace.map((x) => x[0]));
      bets.ret = sumOf(perRace.map((x) => x[1]));
      bets.hit_races = perRace.filter((x) => x[1] > 0).length;
      const [lo, hi] = bootstrapCi((idx) => {
        const s = sumOf(idx.map((i) => perRace[i][0]));
        return s ? sumOf(idx.map((i) => perRace[i][1])) / s : null;
      }, perRace.length);
      bets.ci = lo !== null ? [lo, hi] : null;
      const byType = new Map();
      for (const x of betRows) {
        const t = byType.get(x["券種"]) || [0, 0, 0, 0];
        t[0] += 1; t[1] += x["判定"] === "的中" ? 1 : 0; t[2] += x["金額"]; t[3] += x["払戻"];
        byType.set(x["券種"], t);
      }
      bets.by_type = [...byType.entries()].map(([k, v]) => [k, ...v]);
    }
    out.bets = bets;
    out.bet_rows = betRows;

    const raceRows = races.map(horseRows).filter((rows) => rows.length);
    if (raceRows.length) {
      const brier = (rows, key) => sumOf(rows.map((x) => (x[key] - x["1着"]) ** 2));
      const bm = raceRows.map((rows) => brier(rows, "市場"));
      const ba = raceRows.map((rows) => brier(rows, "AI勝率"));
      const n = raceRows.length;
      const diff = ba.map((a, i) => a - bm[i]);
      const [lo, hi] = bootstrapCi((idx) => sumOf(idx.map((i) => diff[i])) / idx.length, n);
      out.brier = { n, market: sumOf(bm) / n, ai: sumOf(ba) / n, diff: sumOf(diff) / n, ci: [lo, hi] };
      const all = raceRows.flat();
      const edges = [0, 5, 10, 20, 35, 100];
      out.calib_win = {
        edges,
        ai: calibrationTable(all.map((x) => [x["AI勝率"], x["1着"]]), edges),
        market: calibrationTable(all.map((x) => [x["市場"], x["1着"]]), edges),
      };
      const place = all.map((x) => [x["AI複勝率"], x["複勝圏"]]);
      out.calib_place = {
        brier: sumOf(place.map(([p, y]) => (p - y) ** 2)) / place.length,
        rows: calibrationTable(place, [0, 10, 20, 35, 50, 70, 100]),
      };
    }
    return out;
  }

  // ========== 即PAT・A-PAT の発売カレンダー（keiba.go.jp/jranet/calendar/YYYYMM.html） ==========

  // カレンダーの競馬場名を netkeiba の名前（KEIBA_CODES のキー）にそろえる
  const PAT_VENUE_ALIASES = { "帯広": "帯広(ば)", "ばんえい": "帯広(ば)", "帯広ばんえい": "帯広(ば)" };

  // 発売範囲 "全R" / "1～5R" を {all, from, to} にする。読めなければ null
  function parsePatRange(text) {
    const t = String(text).replace(/\s/g, "");
    if (/^全R?$/.test(t) || t === "全レース") return { all: true, from: 1, to: 99 };
    const m = t.match(/(\d+)[～~〜\-－](\d+)R?/);
    if (m) return { all: false, from: +m[1], to: +m[2] };
    const one = t.match(/^(\d+)R$/);
    return one ? { all: false, from: +one[1], to: +one[1] } : null;
  }

  /**
   * 1か月分の発売カレンダーを読む。返り値：
   * {days: {"27": {kind: "apat"|"pat", time: "10:00～20:48", venues: {"大井": {all, from, to, text, night, race}}}}}
   * kind：apat＝即PAT・A-PAT の両方で買える日、pat＝即PAT だけで買える日。発売のない日は days に入れない。
   * カレンダーの部分が見つからなければ null（ページの構造が変わったとき）
   */
  function parsePatCalendar(doc) {
    const list = doc.querySelector(".calendar ul.stable");
    if (!list) return null;
    const days = {};
    for (const li of list.querySelectorAll(":scope > li[name^='day']")) {
      const day = String(parseInt(li.getAttribute("name").slice(3), 10));
      const cls = li.classList;
      const kind = cls.contains("apat") ? "apat" : cls.contains("pat") ? "pat" : null;
      if (!kind && li.getAttribute("data-pat") !== "buy") continue;
      const header = li.querySelector("header");
      const time = ((header && header.getAttribute("title")) || "").replace("発売時刻", "").trim();
      const venues = {};
      for (const dl of li.querySelectorAll(".section dl")) {
        let venue = gt(dl.querySelector("dt"));
        let rangeText = gt([...dl.querySelectorAll(":scope > dd")].find((d) => !d.classList.contains("name")));
        let race = gt(dl.querySelector("dd.name > span"));
        // 重賞の行は書き方が違う（<p class="buy"><span>船橋</span> 全R</p>）
        const buy = dl.querySelector("p.buy");
        if (!venue && buy) {
          venue = gt(buy.querySelector("span"));
          rangeText = gt(buy, " ").replace(venue, "").trim();
          const ps = [...dl.querySelectorAll(".grade a > p")].filter((p) => !p.classList.contains("buy") && !p.querySelector("strong"));
          race = ps.length ? gt(ps[0]) : race;
        }
        if (!venue) continue;
        venue = PAT_VENUE_ALIASES[venue] || venue;
        const range = parsePatRange(rangeText);
        venues[venue] = Object.assign({ text: rangeText, night: dl.classList.contains("night"), race },
          range || { all: false, from: null, to: null });
      }
      days[day] = { kind: kind || "pat", time, venues };
    }
    return { days };
  }

  // 作ったテキストの指示文の部分だけを、今の条件で書き直す（収集し直さずに条件を変えられる）
  function withSettings(text, settings) {
    const i = text.indexOf("【AIへの指示】");
    return i < 0 ? text : text.slice(0, i) + promptText(settings);
  }

  function formatForAi(horses, keibajo, date, raceNo, ri, wideTop, sanrenTop, warnings, payoutRate, collectedAt, settings) {
    ri = ri || {};
    const d = `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6)}`;
    let title = `${d} ${keibajo} ${raceNo}R`;
    if (ri["レース名"]) title += ` ${ri["レース名"]}`;
    const lines = [
      `【${title} 出馬表 + オッズ + 過去成績】`,
      `収集時刻: ${collectedAt}` + (ri["発走"] ? ` / 発走: ${ri["発走"]}` : ""),
      "",
      `レース条件: ${ri["馬場種別"] || "不明"} ${ri["距離"] || "不明"} ` +
        `/ 馬場状態: ${ri["馬場状態"] || "不明"} / クラス: ${ri["クラス"] || "不明"}` +
        (ri["頭数"] ? ` / ${ri["頭数"]}頭` : ""),
      "",
    ];
    if (payoutRate) {
      lines.push(`単勝の払戻率（オッズから逆算した目安）: ${(payoutRate * 100).toFixed(1)}%` +
        "　※市場勝率は控除分を除いて合計100%にそろえた値", "");
    }

    const cols = [["馬番", 4, ">"], ["馬名", 20, "<"], ["性齢", 5, "<"], ["斤量", 5, ">"],
      ["騎手", 11, "<"], ["調教師", 11, "<"], ["馬体重", 9, ">"],
      ["単勝", 7, ">"], ["市場勝率", 9, ">"], ["人気", 5, ">"], ["複勝", 12, ">"], ["脚質", 5, "<"]];
    lines.push(cols.map(([c, w, a]) => pad(c, w, a)).join(" "));
    const rule = "-".repeat(cols.reduce((s, [, w]) => s + w, 0) + cols.length - 1);
    lines.push(rule);

    for (const h of horses) {
      if (h["取消"]) {
        lines.push(`${pad(h["馬番"], 4, ">")} ${pad(h["馬名"], 20)} ※取消・除外`);
        continue;
      }
      const weight = h["馬体重"] ?? "未発表";
      const diff = h["体重増減"] || 0;
      const weightStr = typeof weight === "number" ? `${weight}(${diff >= 0 ? "+" : "-"}${Math.abs(diff)})` : String(weight);
      const vals = [h["馬番"], h["馬名"], h["性齢"] || "", h["斤量"] || "",
        h["騎手"] || "", h["調教師"] || "", weightStr,
        h["単勝"] || "--",
        h["市場勝率"] != null ? `${h["市場勝率"].toFixed(1)}%` : "--",
        h["人気"] || "", h["複勝"] || "--", h["脚質"] || ""];
      lines.push(vals.map((v, i) => pad(v, cols[i][1], cols[i][2])).join(" "));
    }
    lines.push(rule);

    const pcols = [["日付", 10, "<"], ["競馬場", 8, "<"], ["回", 2, "<"], ["距離", 7, "<"],
      ["馬場", 4, "<"], ["頭数", 4, ">"], ["馬番", 4, ">"], ["人気", 4, ">"],
      ["着順", 4, ">"], ["差", 5, ">"], ["タイム", 6, ">"], ["通過", 11, ">"],
      ["上がり", 6, ">"], ["騎手", 8, "<"], ["斤量", 4, ">"], ["体重", 4, ">"], ["クラス", 0, "<"]];
    lines.push(
      "", "【各馬の過去成績（直近5走、上が新しい）】",
      "凡例: 差=1着馬とのタイム差（+は遅れた秒数、-は自身が1着で2着馬につけた差）／回=回り（左・右）",
      "      成績=1着-2着-3着-着外（全=全成績、左・右=回り別、場=今回の競馬場、距=今回の距離）",
      "      騎手コンビ=今回の騎手でのこの馬の成績／前走間隔・乗替・斤量差は今回との比較",
      "",
      pcols.map(([c, w, a]) => pad(c, w, a)).join(" "),
    );
    lines.push("-".repeat(130));

    for (const h of horses) {
      if (h["取消"]) continue;
      const cond = h["条件別成績"] || {};
      const info = [];
      if (Object.keys(cond).length) info.push("成績 " + Object.entries(cond).map(([k, v]) => `${k}${v}`).join(" "));
      if (h["持ち時計"]) info.push(`持ち時計 ${h["持ち時計"]}`);
      if (h["コンビ"]) info.push(`騎手コンビ ${h["コンビ"]}`);
      for (const key of ["前走間隔", "乗替", "斤量差"]) if (h[key]) info.push(`${key} ${h[key]}`);
      lines.push(`■ ${h["馬番"]} ${h["馬名"]}` + (info.length ? "｜" + info.join("｜") : ""));

      const hist = h["過去成績"] || [];
      if (!hist.length) {
        lines.push("  （過去成績を取得できず）");
        continue;
      }
      for (const r0 of hist) {
        const r = Object.assign({}, r0);
        if (r["JRA"]) r["競馬場"] = (r["競馬場"] || "") + "(J)";
        r["回"] = r["回り"] || "";
        lines.push(pcols.map(([c, w, a]) => pad(r[c] ?? "", w, a)).join(" "));
      }
      lines.push("");
    }

    for (const [label, combos] of [["ワイド", wideTop], ["三連複", sanrenTop]]) {
      if (combos && combos.length) {
        lines.push("", `【${label} 人気上位】`);
        combos.slice(0, 10).forEach((c, i) => {
          lines.push(`  ${String(i + 1).padStart(2)}位  ${pad(c["組み合わせ"], 8)}  ${c["オッズ"]}倍`);
        });
      }
    }

    if (warnings && warnings.length) {
      lines.push("", "【データの欠損】", ...warnings.map((w) => `・${w}`));
    }

    lines.push("", ...promptText(settings).split("\n"));
    return lines.map((l) => l.replace(/\s+$/, "")).join("\n");
  }

  // 収集した部品から AI 貼り付け用テキストを作る（PC版 collect_race の後半）
  // parts: {keibajo, race_date, race_no, shutuba:{horses,race_info}, keibago:{}, tan_fuku:{}, wide:[], sanren:[], sanren_note}
  function build(parts) {
    const horses = parts.shutuba.horses;
    const card = parts.keibago || {};
    for (const h of horses) {
      const d = card[h["馬番"]];
      if (!d) continue;
      if ((d["過去成績"] && d["過去成績"].length) || h["要補完"]) h["過去成績"] = d["過去成績"];
      h["条件別成績"] = d["条件別成績"];
      h["持ち時計"] = d["持ち時計"];
      h["コンビ"] = d["コンビ"];
    }
    for (const h of horses) addDerivedFields(h, parts.race_date);
    mergeData(horses, parts.tan_fuku || {});
    const payoutRate = addMarketProb(horses);
    const warnings = checkData(horses);
    if (parts.sanren_note) warnings.push(parts.sanren_note);
    for (const n of parts.notes || []) warnings.push(n);
    return formatForAi(horses, parts.keibajo, parts.race_date, parts.race_no, parts.shutuba.race_info,
      parts.wide, parts.sanren, warnings, payoutRate, parts.collected_at || nowStamp(), parts.settings);
  }

  // build と同じテキストに、画面の要約に使う情報を添えて返す（アプリの結果画面用）
  function buildWithInfo(parts) {
    const text = build(parts);  // build が horses に単勝・市場勝率を書き込む
    const horses = parts.shutuba.horses;
    const ri = parts.shutuba.race_info || {};
    const active = horses.filter((h) => !h["取消"]);
    const total = active.reduce((s, h) => s + (h["市場勝率"] != null ? 1 / Number(h["単勝"]) : 0), 0);
    const warnings = checkData(horses);
    if (parts.sanren_note) warnings.push(parts.sanren_note);
    return {
      text,
      info: {
        race_name: ri["レース名"] || "",
        start: ri["発走"] || "",
        course: [ri["馬場種別"], ri["距離"]].filter((v) => v && v !== "不明").join(" "),
        cond: ri["馬場状態"] && ri["馬場状態"] !== "不明" ? ri["馬場状態"] : "",
        cls: ri["クラス"] || "",
        heads: active.length,
        payout_rate: total && active.every((h) => h["市場勝率"] != null) ? 1 / total : null,
        warnings,
        wide: (parts.wide || []).length,
        sanren: (parts.sanren || []).length,
        horses: horses.map((h) => ({
          no: h["馬番"], waku: h["枠番"] || "", name: h["馬名"] || "", cancel: !!h["取消"],
          odds: h["単勝"] || "--", prob: h["市場勝率"], jockey: h["騎手"] || "",
          ninki: h["人気"] || "", fuku: h["複勝"] || "", sex_age: h["性齢"] || "", kinryo: h["斤量"] || "",
          weight: typeof h["馬体重"] === "number" ? `${h["馬体重"]}(${h["体重増減"] >= 0 ? "+" : ""}${h["体重増減"]})` : (h["馬体重"] || ""),
          kyaku: h["脚質"] || "", trainer: h["調教師"] || "",
          cond: h["条件別成績"] || {}, mochi: h["持ち時計"] || "", combo: h["コンビ"] || "",
          interval: h["前走間隔"] || "", norikae: h["乗替"] || "", kinryo_diff: h["斤量差"] || "",
          // 画面の小さな表に出す過去5走（上が新しい）
          past: (h["過去成績"] || []).map((r) => ({
            date: (r["日付"] || "").replace(/^\d{4}\//, ""), venue: (r["競馬場"] || "") + (r["JRA"] ? "(J)" : ""),
            dist: r["距離"] || "", baba: r["馬場"] || "", heads: r["頭数"] || "", ninki: r["人気"] || "",
            rank: (r["着順"] || "").replace(/着$/, ""), diff: r["差"] || "", agari: r["上がり"] || "",
            time: r["タイム"] || "", pass: r["通過"] || "", cls: r["クラス"] || "", jockey: r["騎手"] || "",
          })),
        })),
      },
    };
  }

  global.KS = {
    buildWithInfo,
    NETKEIBA, KEIBA_CODES, CODE_TO_NAME, KEIBAGO_CODES, EV_MIN, DEFAULT_SETTINGS, fmtEv, promptText, withSettings,
    parsePatCalendar, parsePatRange,
    parseAiBlock, raceIdOf, newRecord, resultReady, parseResult, resultFinished, settleBets, horseRows, computeSummary, comboKey, BET_SPECS,
    gt, dispWidth, pad,
    parseRaceList, nextRaceIndex,
    parseShutuba, parseRaceInfo, parseKyakuType,
    keibagoUrl, parseKeibago,
    parseTanFuku, fmtOdds, tanfukuReady, extractCombos, topCombos, axisValues, parseNinkiSanren, comboSignature, comboChanged, selectAxis,
    mergeData, addDerivedFields, addMarketProb, checkData, formatForAi, build,
  };
})(typeof window !== "undefined" ? window : globalThis);
