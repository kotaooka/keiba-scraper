// アプリ版（scraper.js）で、PC版と同じ計算をして JSON で出す（test_parity.py から呼ぶ）
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const ROOT = path.join(__dirname, "..");
const FX = path.join(__dirname, "fixtures");
const g = {};
new Function("globalThis", "window", fs.readFileSync(path.join(ROOT, "android/app/src/main/assets/scraper.js"), "utf8"))(g, g);
const KS = g.KS;
const doc = (n) => new JSDOM(fs.readFileSync(path.join(FX, n), "utf8")).window.document;
const out = {};
// 各ページの解析
out.race_list = KS.parseRaceList(doc("race_list.html"));
out.shutuba = KS.parseShutuba(doc("shutuba.html"));
out.shutuba_dl = KS.parseShutuba(doc("shutuba_dl.html")).horses;
out.keibago = KS.parseKeibago(doc("keibago.html"));
out.keibago_banei = KS.parseKeibago(doc("keibago_banei.html"));
out.tan_fuku = KS.parseTanFuku(doc("odds_b1_ookuchi.html"));
for (const k of "abcd") out[`tf_${k}`] = KS.parseTanFuku(doc(`tf_${k}.html`));
for (const k of "abc") out[`ninki_${k}`] = KS.parseNinkiSanren(doc(`ninki_${k}.html`));
out.axis = KS.axisValues(doc("axis.html"));
out.wide = KS.topCombos(KS.extractCombos(doc("odds_b5.html"), {}));
out.result = KS.parseResult(doc("result_real.html"));
// AI へ送るテキスト（当日の傾向・市場計算を含む）
const parts = { keibajo: "盛岡", race_date: "20261025", race_no: 1,
  shutuba: JSON.parse(JSON.stringify(out.shutuba)), keibago: out.keibago, tan_fuku: out.tan_fuku,
  wide: out.wide, sanren: out.wide.slice(0, 2), sanren_note: "三連複テスト注記", collected_at: "X" };
const dr2 = JSON.parse(JSON.stringify(out.result)); dr2["4角"] = {}; dr2["条件"] = "";
parts.day_results = [{ "レース番号": 5, "結果": out.result }, { "レース番号": 3, "結果": dr2 }];
out.text = KS.build(parts).replace(/収集時刻: [^/\n]*/, "収集時刻: X ");
// 指示文（条件を変えたとき）
out.prompts = {};
for (const [b, m, e] of [[1000, 3, 1.2], [3000, 5, 1.25], [500, 1, 1.0]]) out.prompts[`${b}-${m}`] = KS.promptText({ budget: b, max_bets: m, ev_min: e });
// Harville 法
const ps = [0.35, 0.2, 0.12, 0.1, 0.08, 0.06, 0.04, 0.03, 0.015, 0.005];
const probs = {}; ps.forEach((p, i) => { probs[String(i + 1)] = p; });
out.harville = KS.harville(probs);
// 記録の集計（回収率・精度・CLV）
out.summary = KS.computeSummary(JSON.parse(fs.readFileSync(path.join(FX, "records.json"), "utf8")));
// AI の回答の読み取り
out.migrated = [{ "レース番号": "7", "日付": "20261025", "競馬場": "盛岡" }, { schema: 2, "AI": null }, "x", { "馬": [], "レース番号": 3 }]
  .concat(JSON.parse(fs.readFileSync(path.join(FX, "records.json"), "utf8")).slice(0, 3)).map((r) => KS.migrateRecord(r));
out.ai_block = KS.parseAiBlock(fs.readFileSync(path.join(FX, "ai_answer.txt"), "utf8"));
process.stdout.write(JSON.stringify(out));
