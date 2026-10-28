// アプリの画面（android/app/src/main/assets/ui.html）を Chromium で開き、主な操作を通して確かめる。
// 画面のエラー・幅360px での横はみ出し・主な要素の有無を見る。失敗があれば終了コード 1
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { JSDOM } = require("jsdom");
const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "android/app/src/main/assets");
const FX = path.join(__dirname, "fixtures");
const g = {};
new Function("globalThis", "window", fs.readFileSync(path.join(ASSETS, "scraper.js"), "utf8"))(g, g);
const doc = (n) => new JSDOM(fs.readFileSync(path.join(FX, n), "utf8")).window.document;

// 10頭のレースを作る（出馬表の書式は fixtures のものを使い回す）
const sh = g.KS.parseShutuba(doc("shutuba.html"));
const kg0 = g.KS.parseKeibago(doc("keibago.html"));
const odds = ["9.7", "22.9", "4.2", "9.4", "70.3", "1.9", "16.7", "12.0", "12.1", "179.8"];
const fuku = ["2.0 - 3.1", "4.2 - 6.8", "1.4 - 1.9", "2.2 - 3.4", "8.0 - 14.0", "1.1 - 1.3", "3.0 - 4.9", "2.4 - 3.8", "2.5 - 4.0", "12.0 - 20.0"];
function buildRace(at) {
  const s = JSON.parse(JSON.stringify(sh));
  s.race_info = Object.assign(s.race_info, { "発走": "14:40", "レース名": "C2四組", "距離": "1400m", "馬場種別": "ダート", "馬場状態": "良" });
  s.horses = odds.map((_, i) => ({ ...sh.horses[i % sh.horses.length], "馬番": String(i + 1), "枠番": String(Math.min(8, i + 1)), "馬名": `テストホース${i + 1}`, "取消": false }));
  const tf = {}; odds.forEach((o, i) => { tf[String(i + 1)] = { "単勝": o, "複勝": fuku[i] }; });
  const kg = {}; odds.forEach((_, i) => { const d = Object.values(kg0)[i % Object.keys(kg0).length]; if (d) kg[String(i + 1)] = d; });
  const wide = [{ "組み合わせ": "3-6", "オッズ": "1.8 - 2.4" }, { "組み合わせ": "6-8", "オッズ": "3.1 - 4.5" }];
  const sanren = [{ "組み合わせ": "3-6-8", "オッズ": "9.9" }];
  const res = g.KS.parseResult(doc("result_real.html"));
  const r = g.KS.buildWithInfo({ keibajo: "盛岡", race_date: "20261025", race_no: 7, shutuba: s, keibago: kg, tan_fuku: tf, wide, sanren, collected_at: "x",
    day_results: [{ "レース番号": 5, "結果": res }] });
  r.at = at;
  return r;
}
const races = Array.from({ length: 12 }, (_, i) => ({ no: i + 1, time: `${10 + Math.floor(i / 2)}:${i % 2 ? "40" : "05"}`, title: "C2", heads: "10" }));
races[6].time = "14:40";
const cal = g.KS.parsePatCalendar(doc("patcal_202610.html"));
const ai = fs.readFileSync(path.join(FX, "ai_answer.txt"), "utf8");
const records = JSON.parse(fs.readFileSync(path.join(FX, "records.json"), "utf8"));

const failures = [];
const check = (scheme, name, ok, detail) => { if (!ok) failures.push(`[${scheme}] ${name}${detail ? `：${detail}` : ""}`); };

(async () => {
  const browser = await chromium.launch();
  for (const scheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 360, height: 760 }, colorScheme: scheme, timezoneId: "Asia/Tokyo" });
    const errs = [];
    page.on("pageerror", (e) => errs.push(String(e)));
    await page.clock.install({ time: new Date("2026-10-25T13:30:00+09:00") });
    await page.goto("file://" + path.join(ASSETS, "ui.html"));
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

    // 一覧
    const home = await page.evaluate(({ cal, races }) => {
      Native.loadRaceList = () => {};
      state.date = "20261025"; renderDate();
      App.onPatCalendar("202610", cal);
      App.onRaceList([{ name: "盛岡", races }, { name: "高知", races }]);
      return { theme: !!document.getElementById("themeBtn"), races: document.querySelectorAll("#raceArea .race").length, ext: document.querySelectorAll(".ext-row button").length, fold: !!document.querySelector(".past-fold") };
    }, { cal, races });
    check(scheme, "一覧にレースが並ぶ", home.races > 0, JSON.stringify(home));
    check(scheme, "見出しに表示切り替えのボタンを出さない（設定の「画面の色」に一本化）", !home.theme);
    check(scheme, "レース映像・即PAT のボタン", home.ext === 2);
    check(scheme, "発走済みのレースを畳む", home.fold);
    check(scheme, "一覧が横にはみ出さない", (await overflow()) <= 0);

    // 収集 → 結果画面 → AI へ送る → AI の回答をコピーして戻る
    const res = await page.evaluate(({ r1, ai }) => {
      let clip = "", stamp = 1;
      Native.readClipboard = () => clip; Native.clipStamp = () => stamp;
      Native.copy = (t) => { clip = t; stamp++; }; Native.share = () => {};
      startCollect("盛岡", state.venues[0].races[6]);
      const steps = document.querySelectorAll(".steps li, .step-row, [data-step]").length;
      App.onResult(r1);
      const before = { nav: [...document.querySelectorAll(".sec-nav button")].map((b) => b.textContent), bar: document.querySelectorAll(".send-bar button").length };
      document.querySelectorAll(".send-bar button")[1].click();  // コピー
      clip = ai; stamp = 50; App.onFocus();
      const offer = !!document.getElementById("clipOffer");
      if (offer) document.querySelector("#clipOffer .btn.primary").click();
      const rec = readRecords()["20261025|盛岡|7"];
      return { steps, before, offer, recorded: !!(rec && rec["AI"]),
        nav: [...document.querySelectorAll(".sec-nav button")].map((b) => b.textContent),
        kpi: document.querySelectorAll("#sec-ai .bet-kpi").length,
        cond: !!document.querySelector(".cond-line"),
        text: document.querySelector("#sec-text summary") ? document.querySelector("#sec-text summary").textContent : "" };
    }, { r1: buildRace("2026-10-25 13:28"), ai });
    check(scheme, "結果画面の下のボタン3つ（送る・コピー・即PAT）", res.before.bar === 3, JSON.stringify(res.before));
    check(scheme, "AI の回答のコピーに気づいて記録を勧める", res.offer);
    check(scheme, "勧めから記録できる", res.recorded);
    check(scheme, "記録後は AI の予想が見出しの先頭（結果の次）", res.nav[0] === "AI予想", res.nav.join(","));
    check(scheme, "買い目が3列で出る", res.kpi > 0);
    check(scheme, "記録後は「AI への条件」の行を出さない", !res.cond);
    check(scheme, "送るテキスト", /送るテキストを見る/.test(res.text));
    check(scheme, "結果画面が横にはみ出さない", (await overflow()) <= 0);

    // 説明の「?」・買った馬券・即PAT 入力用の一覧
    const own = await page.evaluate(() => {
      const help = document.querySelector("#sec-ai .help-btn"); help.click();
      const helpOpen = !document.querySelector("#sec-ai .help-box").classList.contains("hidden");
      [...document.querySelectorAll("#sec-own button")].find((x) => x.textContent.includes("期待値重視の買い目を入れる")).click();
      const bets = document.querySelectorAll("#sec-own .bet").length;
      document.querySelector("#sec-own .pat-list-btn").click();
      const rows = document.querySelectorAll("#sheet .pat-row").length;
      closeSheet();
      [...document.querySelectorAll("#sec-own button")].find((x) => x.textContent === "1点ずつ入れる").click();
      const sheet = document.querySelector("#sheet h3").textContent;
      closeSheet();
      return { helpOpen, bets, rows, sheet, helpKept: (renderResult(), !document.querySelector("#sec-ai .help-box").classList.contains("hidden")) };
    });
    check(scheme, "説明の「?」が開く", own.helpOpen);
    check(scheme, "描き直しても説明が開いたまま", own.helpKept);
    check(scheme, "AI の買い目を買った馬券に写せる", own.bets > 0, JSON.stringify(own));
    check(scheme, "即PAT 入力用の一覧", own.rows > 0);
    check(scheme, "買った馬券を1点ずつ入れる画面", own.sheet === "買った馬券を入れる");

    // 記録の画面（収支の推移・CLV）
    const rec = await page.evaluate((records) => {
      const o = readRecords(); records.forEach((r, i) => { o[`${r["日付"]}|${r["競馬場"]}|${r["レース番号"]}|${i}`] = r; }); writeRecords(o);
      showRecords();
      return [...document.querySelectorAll(".card h3")].map((x) => x.textContent);
    }, records);
    check(scheme, "収支の推移", rec.some((t) => t.startsWith("収支の推移")), rec.join(","));
    check(scheme, "CLV", rec.some((t) => t.startsWith("締切オッズとの比較")));
    check(scheme, "記録の画面が横にはみ出さない", (await overflow()) <= 0);

    // 設定・予想の条件
    const st = await page.evaluate(() => {
      showPrefs(); const prefs = document.querySelectorAll(".pref-row").length;
      showSettings(); const kelly = [...document.querySelectorAll(".card h3")].some((x) => x.textContent.includes("ケリー"));
      return { prefs, kelly };
    });
    check(scheme, "設定の画面", st.prefs > 3);
    check(scheme, "ケリー基準の設定", st.kelly);
    check(scheme, "設定の画面が横にはみ出さない", (await overflow()) <= 0);

    check(scheme, "画面のエラーなし", errs.length === 0, errs.join(" / "));
    await page.close();
  }
  await browser.close();
  if (failures.length) { console.log(failures.join("\n")); console.log(`画面の確認：失敗 ${failures.length}件`); process.exit(1); }
  console.log("画面の確認：すべて通りました");
})();
