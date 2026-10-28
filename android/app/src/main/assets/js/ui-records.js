// 予想の記録と答え合わせ：AI の予想欄・買った馬券・AI なしの目安・記録の画面・収支の推移と内訳・CLV
// ui.html から順に読み込む（ふつうの <script> なので、上のファイルの const や function はそのまま使える）。
// 読み込む順番に意味がある（ui-core → ui-result → ui-records → ui-settings）。起動時の処理は ui-settings.js の最後
// ===== 予想の記録と答え合わせ =====
// 形式は PC版の output/records/<race_id>.json と同じ（書き出して PC版の verify にもかけられる）。キーは cacheKey
const REC_KEY = "keiba-records", AI_TEXT_KEY = "keiba-ai-texts";
// 記録を読む（古い形式の記録は今の形式に直して返す）
const readRecords = () => {
  const o = store.get(REC_KEY, {}), out = {};
  for (const [k, r] of Object.entries(o)) { const m = KS.migrateRecord(r); if (m) out[k] = m; }
  return out;
};
// 端末の時刻（日本時間）で「YYYY-MM-DD HH:MM:SS」。PC版の記録と同じ形
function localStamp(d) {
  d = d || jstNow();
  const z = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
}
// 0.4.18 までは記録時刻・取得時刻を UTC で残していたので、1回だけ端末の時刻に直す
(function fixUtcStamps() {
  const FLAG = "keiba-stamp-local";
  try {
    if (store.get(FLAG, false)) return;
    const recs = store.get(REC_KEY, null);
    if (recs && typeof recs === "object") {
      const conv = (t) => {
        if (typeof t !== "string") return t;
        const d = new Date(t.replace(" ", "T") + "Z");
        return isNaN(d) ? t : localStamp(jstOf(d.getTime()));
      };
      for (const r of Object.values(recs)) {
        if (r && r["AI"] && r["AI"]["記録時刻"]) r["AI"]["記録時刻"] = conv(r["AI"]["記録時刻"]);
        if (r && r["結果"] && r["結果"]["取得時刻"]) r["結果"]["取得時刻"] = conv(r["結果"]["取得時刻"]);
      }
      store.set(REC_KEY, recs);
    }
  } catch (e) { /* 直せなくても画面は動かす */ } finally {
    store.set(FLAG, true);
  }
})();
// 読み込んだ記録の形を確かめる（PC版の output/records/*.json と同じ形）
function validRecord(r) {
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  if (!isObj(r) || typeof r["日付"] !== "string" || !/^\d{8}$/.test(r["日付"]) || typeof r["競馬場"] !== "string" || !r["競馬場"]) return false;
  if (!Number.isInteger(r["レース番号"])) { const n = Number(r["レース番号"]); if (!Number.isInteger(n) || n < 1) return false; r["レース番号"] = n; }
  if (r["AI"] != null) {
    const a = r["AI"];
    if (!isObj(a) || !isObj(a["予想"]) || !Array.isArray(a["買い目"])) return false;
    // 予想は各馬の推定勝率・推定複勝率が数
    if (!Object.values(a["予想"]).every((v) => isObj(v) && Number.isFinite(v["勝率"]) && Number.isFinite(v["複勝率"]))) return false;
    const okBets = (xs) => xs.every((b) => isObj(b) && typeof b["券種"] === "string" && typeof b["組み合わせ"] === "string" && Number.isFinite(b["金額"]));
    if (!okBets(a["買い目"])) return false;
    if (a["的中買い目"] === null) delete a["的中買い目"];
    if (a["的中買い目"] != null && !(Array.isArray(a["的中買い目"]) && okBets(a["的中買い目"]))) return false;
    if (typeof a["記録時刻"] !== "string") a["記録時刻"] = "";
  }
  if (r["購入"] != null) {
    if (!Array.isArray(r["購入"]) || !r["購入"].every((b) => isObj(b) && typeof b["券種"] === "string" && typeof b["組み合わせ"] === "string" && Number.isFinite(b["金額"]))) return false;
  }
  if (r["結果"] != null) {
    const x = r["結果"];
    if (!isObj(x) || !isObj(x["着順"]) || !isObj(x["払戻"])) return false;
    // 払戻は券種ごとに {組み合わせ: 円}
    if (!Object.values(x["払戻"]).every((t) => isObj(t) && Object.values(t).every((v) => Number.isFinite(v)))) return false;
  }
  return true;
}
// 記録の新しさ（収集時刻。無ければ AI の記録時刻、それも無ければレースの日付）
function recOrder(r) {
  const d = String(r["日付"] || "");
  const fromDate = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)} 00:00` : "";
  return String(r["収集時刻"] || (r["AI"] && r["AI"]["記録時刻"]) || fromDate);
}
function writeRecords(recs) {
  // AI の回答か買った馬券のある記録は新しい順に 500件、データだけの記録（AI なし）は新しい順に 300件まで残す
  // （端末の保存の上限を超えないように。全部の控えは自動バックアップと書き出しにある）
  const keys = Object.keys(recs).sort((a, b) => recOrder(recs[b]).localeCompare(recOrder(recs[a])));
  const main = keys.filter((k) => !isDataOnly(recs[k])).slice(0, KS.CONFIG.RECORDS_MAX), data = keys.filter((k) => isDataOnly(recs[k])).slice(0, KS.CONFIG.DATA_RECORDS_MAX);
  const out = {}; for (const k of keys) if (main.includes(k) || data.includes(k)) out[k] = recs[k];
  store.set(REC_KEY, out);
}
function saveAiText(key, text) {
  // AI の回答の全文は大きいので、新しい30件だけ残す
  const t = store.get(AI_TEXT_KEY, {}); t[key] = { at: Date.now(), text };
  const keys = Object.keys(t).sort((a, b) => t[b].at - t[a].at).slice(0, 30);
  store.set(AI_TEXT_KEY, Object.fromEntries(keys.map((k) => [k, t[k]])));
}
// 発走から何分たったか（記録の日付と発走時刻から）
function sinceStart(rec) { const u = untilMin(rec["日付"], rec["発走"]); return u == null ? null : -u; }
// 結果を取りに行ってよい記録（AI の回答があり、結果がまだで、発走から15分たった）
function pendingResults() {
  return Object.entries(readRecords()).filter(([, r]) => (r["AI"] || ownBetsOf(r).length) && !r["結果"] && r.race_id && (sinceStart(r) ?? 0) >= 15);
}

// 結果画面の「AI の回答を貼り付けて記録」。given はクリップボードから先に読んでおいた回答
function pasteAiAnswer(given) {
  const { venue, race, res } = state.result;
  let text = typeof given === "string" ? given : "";
  if (!text) { try { text = Native.readClipboard() || ""; } catch (e) {} }
  hideClipOffer();
  if (!text.trim()) { toast("クリップボードが空です。AI の回答をコピーしてから押してください"); return; }
  if (text.trim() === textFor(res).trim()) { toast("クリップボードは送ったテキストのままです。AI の回答をコピーしてください"); return; }
  const parsed = KS.parseAiBlock(text);
  if (!parsed) { toast("記録用ブロック（#PRED）が見つかりません。回答の全文をコピーしてください"); return; }
  const key = cacheKey(state.date, venue, race.no);
  const recs = readRecords();
  const prevResult = recs[key] && recs[key]["結果"];
  const rec = Object.assign(KS.newRecord(state.date, venue, race.no, res), { "発走": res.info.start || race.time || "", "EV_MIN": betSettings().ev_min });
  rec["AI"] = Object.assign(parsed, { "記録時刻": localStamp() });
  // 画面に期待値を出すため、記録したときのオッズ（買い目ごと）・予算・総評も残す（PC版はこれらを使わない）
  rec["AI"]["オッズ"] = parsed["買い目"].map((b) => { const o = betOddsOf(b, res.info); return o ? o.text : null; });
  if (parsed["的中買い目"]) rec["AI"]["的中オッズ"] = parsed["的中買い目"].map((b) => { const o = betOddsOf(b, res.info); return o ? o.text : null; });
  // 記録したときの買い方と条件（指示文を書き換えていて #HIT が無いときは期待値重視として扱う）
  { const bs = betSettings(); rec["買い方"] = bs.mode !== "ev" && !parsed["的中買い目"] && promptTemplate() ? "ev" : bs.mode; rec["HIT_MIN"] = bs.hit_min; rec["HIT_EV_MIN"] = bs.hit_ev_min; }
  rec["AI"]["総評"] = aiComment(text);
  rec["予算"] = betSettings().budget;
  if (res.info.predicted) rec["予想オッズ"] = true;
  // 貼り直したときも、取得済みの結果と買った馬券は残す
  if (prevResult) rec["結果"] = prevResult;
  if (recs[key] && Array.isArray(recs[key]["購入"])) { rec["購入"] = recs[key]["購入"]; rec["購入時刻"] = recs[key]["購入時刻"]; }
  recs[key] = rec;
  writeRecords(recs); saveAiText(key, text);
  if (!prevResult) scheduleResultCheck(key, rec, race);
  const total = parsed["予想"] ? Object.values(parsed["予想"]).reduce((t, v) => t + v["勝率"], 0) : 100;
  toast(Math.abs(total - 100) > 5 ? `記録しました（推定勝率の合計が ${total.toFixed(1)}% です）` : "記録しました");
  renderResult(); updateRecBadge();
}

// AI の回答や買った馬券がないレースも、収集したら記録を作り、結果まで残す（あとで分析に使うデータ。通知はしない）。
// AI の回答・買った馬券・結果のある記録はそのまま。データだけの記録は、取り直したら新しいオッズで作り直す
function ensureDataRecord(date, venue, no, res, title) {
  const key = cacheKey(date, venue, no);
  const recs = readRecords();
  let rec = recs[key];
  const isNew = !(rec && (rec["AI"] || ownBetsOf(rec).length || rec["結果"]));
  if (isNew) {
    try { rec = Object.assign(KS.newRecord(date, venue, no, res), { "発走": (res.info && res.info.start) || "" }); } catch (e) { logError("データの記録", e); return; }
    if (!rec.race_id) return;
    if (res.info && res.info.predicted) rec["予想オッズ"] = true;
  }
  // AI なしの目安：発走前の収集なら、そのときのオッズで出し直して残す（結果が出たあとは変えない）
  const um = untilMin(date, rec["発走"]);
  if (!rec["結果"] && (um == null || um > 0)) {
    try {
      const mp = KS.marketPicks(res.info, betSettings());
      if (mp.computed) { rec["市場買い目"] = mp.bets; rec["市場記録時刻"] = res.at || ""; }
    } catch (e) { logError("AI なしの目安", e); }
  }
  recs[key] = rec; writeRecords(recs);
  if (isNew) scheduleResultCheck(key, rec, { title: title || "" });
}
const isDataOnly = (r) => !!r && !r["AI"] && !ownBetsOf(r).length;

// 発走の15分後に結果を自動で1回取り、的中・不的中を通知する（アプリを閉じていても。Kotlin の Reservations）
function scheduleResultCheck(key, rec, race) {
  const um = untilMin(rec["日付"], rec["発走"]);
  if (um == null || !rec.race_id) return;
  try {
    Native.scheduleResultCheck(JSON.stringify({ key, race_id: rec.race_id, date: rec["日付"], venue: rec["競馬場"], no: rec["レース番号"],
      title: rec["レース名"] || race.title || "", time: rec["発走"], start: Math.round(Date.now() + um * 60000),
      bets: rec["AI"] ? rec["AI"]["買い目"] : [],
      hit_bets: hasHitOf(rec) ? (rec["AI"]["的中買い目"] || []) : null,
      own_bets: ownBetsOf(rec).length ? rec["購入"] : null,
      mode: rec["AI"] ? (rec["買い方"] || "ev") : "none" }));
  } catch (e) { logError("結果の自動取得の予約", e); }
  // 発走5分前にオッズを取り直して、買い目の期待値を確かめる（AI の回答を記録したレースだけ）
  try {
    if (rec["AI"] && preCheckOn() && Native.schedulePreCheck) {
      const bs = betSettings();
      Native.schedulePreCheck(JSON.stringify({ key, race_id: rec.race_id, date: rec["日付"], venue: rec["競馬場"], no: rec["レース番号"],
        title: rec["レース名"] || race.title || "", time: rec["発走"], start: Math.round(Date.now() + um * 60000),
        bets: rec["買い方"] === "hit" ? [] : rec["AI"]["買い目"] || [], hit_bets: hasHitOf(rec) ? (rec["AI"]["的中買い目"] || []) : [],
        pred: rec["AI"]["予想"] || {}, ev_min: rec["EV_MIN"] != null ? rec["EV_MIN"] : bs.ev_min,
        hit_ev_min: rec["HIT_EV_MIN"] != null ? rec["HIT_EV_MIN"] : bs.hit_ev_min }));
    }
  } catch (e) { logError("締切前の確認の予約", e); }
}
// アプリを閉じている間に自動で取った結果を、記録へ入れる
function mergeRaceResults() {
  let list = [];
  try { list = JSON.parse(Native.takeRaceResults() || "[]"); } catch (e) { logError("裏で取った結果の読み込み", e); }
  if (!list.length) return;
  const recs = readRecords();
  for (const x of list) {
    const k = Object.keys(recs).find((kk) => recs[kk].race_id === x.race_id);
    if (k && !recs[k]["結果"] && x.result && KS.resultFinished(x.result)) {
      recs[k]["結果"] = Object.assign(x.result, { "取得時刻": x.at || "" });
      try { Native.cancelResultCheck(k); } catch (e) {}
    }
  }
  writeRecords(recs);
}

// 結果を取りに行く（race_id の配列）。1件ずつ App.onRaceResult で返ってくる
function fetchResults(keys) {
  const recs = readRecords();
  const ids = keys.map((k) => recs[k] && recs[k].race_id).filter(Boolean);
  if (!ids.length) return;
  if (state.fetching) { toast("結果を取得中です"); return; }
  state.fetching = { total: ids.length, done: 0, got: 0 };
  toast(`結果を取得しています（${ids.length}件）`);
  if (state.screen === "records") renderRecords();
  Native.fetchResults(JSON.stringify(ids));
}
// 結果画面の「レース結果を取得」：このレースの結果ページを1回読む（記録が無くても読める）
function fetchRaceResult(venue, race) {
  const raceId = KS.raceIdOf(state.date, venue, race.no);
  if (!raceId) { toast("この競馬場の結果ページが分かりません"); return; }
  if (state.fetching) { toast("結果を取得中です"); return; }
  state.resultTargets = state.resultTargets || {};
  state.resultTargets[raceId] = cacheKey(state.date, venue, race.no);
  state.fetching = { total: 1, done: 0, got: 0, single: true };
  toast("結果を取得しています");
  renderResult();
  Native.fetchResults(JSON.stringify([raceId]));
}
// 結果のカード（着順と払戻）
function resultCard(r, info) {
  const c = el("div", "card result-card");
  const h = el("h3", null, "レース結果");
  if (r["取得時刻"]) h.append(el("span", "aside", `取得 ${r["取得時刻"].slice(11, 16)}`));
  c.append(h);
  const nameOf = (no) => ((info.horses || []).find((x) => String(parseInt(x.no, 10)) === String(no)) || {}).name || "";
  const rows = Object.entries(r["着順"] || {}).sort((a, b) => {
    const na = /^\d+$/.test(a[1]) ? +a[1] : 999, nb = /^\d+$/.test(b[1]) ? +b[1] : 999;
    return na - nb || +a[0] - +b[0];
  });
  const tb = el("table", "rec-table");
  const hr = el("tr"); for (const [t, cls] of [["着", "r"], ["馬"]]) hr.append(el("th", cls || null, t)); tb.append(hr);
  rows.forEach(([no, rank], i) => {
    const tr = el("tr", i < 3 && /^\d+$/.test(rank) ? "top3" : null);
    tr.append(el("td", "r num", /^\d+$/.test(rank) ? rank : rank || "--"), el("td", null, `${no} ${nameOf(no)}`));
    tb.append(tr);
  });
  c.append(tb);
  const pay = r["払戻"] || {};
  const order = ["単勝", "複勝", "枠連", "馬連", "ワイド", "馬単", "3連複", "3連単", "枠単"];
  const types = Object.keys(pay).sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
  if (types.length) {
    const pt = el("table", "rec-table pay-table"); pt.style.marginTop = "10px";
    const ph = el("tr"); for (const [t, cls] of [["払戻"], ["組み合わせ"], ["100円あたり", "r"]]) ph.append(el("th", cls || null, t)); pt.append(ph);
    for (const t of types) {
      Object.entries(pay[t]).forEach(([combo, yenv], i) => {
        const tr = el("tr"); tr.append(el("td", null, i ? "" : t), el("td", "num", combo), el("td", "r num", yen(yenv))); pt.append(tr);
      });
    }
    c.append(pt);
  }
  if (Array.isArray(r["注記"]) && r["注記"].length) c.append(el("p", "note", r["注記"].join("・")));
  return c;
}
function onRaceResult(raceId, res) {
  if (state.fetching) state.fetching.done++;
  // 結果画面から取ったレース：収集済みのデータにも結果を置く（記録が無くても表示できるように）
  const ck = state.resultTargets && state.resultTargets[raceId];
  if (ck) {
    delete state.resultTargets[raceId];
    if (res && KS.resultFinished(res)) {
      const c = readCache();
      const r1 = Object.assign({}, res, { "取得時刻": localStamp() });
      if (c[ck]) { c[ck].result = r1; writeCache(c); }
      if (state.result && cacheKey(state.date, state.result.venue, state.result.race.no) === ck) state.result.res.result = r1;
      if (state.fetching) state.fetching.got = Math.max(state.fetching.got, 1);
    }
  }
  const recs = readRecords();
  const key = Object.keys(recs).find((k) => recs[k].race_id === raceId);
  if (key && res && KS.resultFinished(res)) {
    recs[key]["結果"] = Object.assign(res, { "取得時刻": localStamp() });
    writeRecords(recs);
    try { Native.cancelResultCheck(key); } catch (e) {}
    if (state.fetching) state.fetching.got++;
  }
  if (state.screen === "records") renderRecords();
}
function onResultsDone(err) {
  const f = state.fetching; state.fetching = null;
  if (f && f.single && !err) {
    toast(f.got ? "結果を取得しました" : "まだ結果が確定していません。少したってからもう一度押してください");
    updateRecBadge();
    if (state.screen === "result" && state.result) renderResult();
    return;
  }
  if (err === "busy") toast("ほかの読み込み中です。終わってからもう一度押してください");
  else if (err === "cancel") toast(f && f.got ? `結果の取得を途中でやめました（${f.got}件は取得済み）` : "結果の取得を取りやめました");
  else if (f) toast(f.got === f.total ? `結果を取得しました（${f.got}件）` : `結果を取得しました（${f.got}件。未確定 ${f.total - f.got}件はあとでもう一度）`);
  updateRecBadge();
  if (state.screen === "records") renderRecords();
  if (state.screen === "result" && state.result) renderResult();
}
// その日の記録の収支（AI の買い目どおりに買ったとして）。記録が無ければ null
// 的中重視の買い目を記録したレースか（#HIT を読んだか、買い方が的中重視・両方。PC版の集計と同じ判定）
function hasHitOf(r) { return !!r["AI"] && (Array.isArray(r["AI"]["的中買い目"]) || ["hit", "both"].includes(r["買い方"])); }
function dayPnl(date) {
  const rs = Object.values(readRecords()).filter((r) => r["日付"] === date && (r["AI"] || ownBetsOf(r).length));
  if (!rs.length) return null;
  // 自分の馬券・期待値重視（買い目）・的中重視（的中買い目）を別々に足す
  let d = 0, settled = 0, hd = 0, hSettled = 0, od = 0, oSettled = 0;
  for (const r of rs) {
    if (!r["結果"]) continue;
    let rows = null, hrows = null, orows = null;
    try { orows = ownBetsOf(r).length ? KS.settleBets(r, "購入") : null; } catch (e) { logError(`答え合わせ（${r.race_id}・買った馬券）`, e); }
    if (orows) { oSettled++; od += orows.reduce((t, x) => t + x["払戻"] - x["金額"], 0); }
    if (!r["AI"]) continue;
    try { rows = r["買い方"] === "hit" ? null : KS.settleBets(r, "買い目"); } catch (e) { logError(`答え合わせ（${r.race_id}・期待値重視）`, e); }
    try { hrows = hasHitOf(r) ? KS.settleBets(r, "的中買い目") : null; } catch (e) { logError(`答え合わせ（${r.race_id}・的中重視）`, e); }
    if (rows) { settled++; d += rows.reduce((t, x) => t + x["払戻"] - x["金額"], 0); }
    if (hrows) { hSettled++; hd += hrows.reduce((t, x) => t + x["払戻"] - x["金額"], 0); }
  }
  return { n: rs.length, settled: rs.filter((r) => r["結果"]).length, d, evSettled: settled, hd, hSettled, od, oSettled };
}
function updateRecBadge() { const n = pendingResults().length; $("recDot").classList.toggle("hidden", !n); }

// 結果画面の「AI の予想」欄
// 買い目のオッズ（収集したデータから。単勝・複勝は各馬、ワイド・3連複は人気上位10組にあれば）。
// 返り値 {text: 表示, low: 期待値・払戻の計算に使う倍率（幅があるときは下限）} か null
// 買い目のオッズと AI の見積もった的中率は scraper.js の計算を使う（締切前の点検と同じ計算にするため）
const betOddsOf = (b, info) => KS.betOddsFromInfo(b, info);
const betProbOf = (b, pred) => KS.betProbOf(b, pred);
// AI の回答から総評の一文を取り出す（見出し「総評」の行か、その次の行）
function aiComment(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/総評/.test(lines[i]) || /50字以内/.test(lines[i])) continue;
    const clean = (t) => t.replace(/^[#>*\s\-・\d.、]+/, "").replace(/[*`]/g, "").replace(/^【?総評】?[:：\s]*/, "").trim();
    let t = clean(lines[i]);
    for (let j = i + 1; !t && j < Math.min(lines.length, i + 4); j++) t = clean(lines[j]);
    if (t && !t.startsWith("#") && !/^【/.test(t)) return t.slice(0, 80);
  }
  return "";
}
// 発走の15分後の時刻（"HH:MM"）
function resultTimeOf(rec) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(rec["発走"] || "");
  if (!m) return "";
  const t = +m[1] * 60 + +m[2] + 15;
  return `${String(Math.floor(t / 60) % 24).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

// ===== AI の予想欄 =====
// AI の推定勝率から Harville 法で計算した的中率を引く関数（複勝・ワイド・3連複の見積もりと比べる）。推定勝率が欠けていれば常に null
function aiCalcProb(info, pred) {
  const running = (info.horses || []).filter((x) => !x.cancel);
  const probs = {};
  for (const h of running) {
    const a = pred[String(parseInt(h.no, 10))];
    if (!a) return () => null;
    probs[String(parseInt(h.no, 10))] = a["勝率"] / 100;
  }
  const hv = KS.harville(probs);
  const placeN = running.length >= 8 ? "top3" : "top2";
  return (b) => {
    if (!hv) return null;
    const key = String(b["組み合わせ"]).split("-").map((n) => String(parseInt(n, 10))).sort((x, y) => +x - +y).join("-");
    if (b["券種"] === "複勝") return hv[placeN][key] ?? null;
    if (b["券種"] === "ワイド") return hv.pair[key] ?? null;
    if (b["券種"] === "3連複") return hv.trio[key] ?? null;
    return null;
  };
}

// 買い目1点の行。ctx は {rec, info, pred, updated, recOdds, settled, evMin, calcProbOf}。返り値は {row, kelly}（kelly はケリーの金額か null）
function betRow(b, i, ctx) {
  const { rec, info, pred, updated, recOdds, settled, evMin, calcProbOf } = ctx;
  const s = settled && settled[i];
  const row = el("div", "bet");
  // 1行目：券種・組み合わせ（馬名）・金額・結果
  const top = el("div", "bet-top");
  const names = b["券種"].startsWith("枠") ? "" : b["組み合わせ"].split("-").map((n) => ((info.horses || []).find((x) => String(parseInt(x.no, 10)) === n) || {}).name || "").filter(Boolean).join("・");
  const what = el("span", "bet-what");
  what.append(el("b", null, `${b["券種"]} ${b["組み合わせ"]}`));
  if (names && b["組み合わせ"].split("-").length === 1) what.append(el("span", "bet-name", names));
  top.append(what, el("span", "bet-amt num", yen(b["金額"])));
  if (rec["結果"]) {
    top.append(el("span", "bet-res " + (s ? (s["判定"] === "的中" ? "hit" : s["判定"] === "返還" ? "back" : "miss") : "miss"),
      s ? (s["判定"] === "的中" ? `的中 ${yen(s["払戻"])}` : s["判定"] === "返還" ? `返還 ${yen(s["払戻"])}` : "不的中") : "払戻不明"));
  }
  row.append(top);
  if (names && b["組み合わせ"].split("-").length > 1) row.append(el("div", "bet-names", names));
  // オッズ・当たる確率・期待値を3列で。記録のあとにオッズを取り直していれば「今」の値も並べる
  const atRec = recOdds[i] ? { text: recOdds[i], low: parseFloat(/\d+(\.\d+)?/.exec(recOdds[i]) || "") } :
    (b["券種"] === "単勝" && rec["馬"] && rec["馬"][b["組み合わせ"]] ? { text: rec["馬"][b["組み合わせ"]]["単勝"], low: parseFloat(rec["馬"][b["組み合わせ"]]["単勝"]) } :
    (!updated ? betOddsOf(b, info) : null));
  const now = updated ? betOddsOf(b, info) : null;
  const p = betProbOf(b, pred);
  const recOk = !!(atRec && atRec.low > 0);
  const nowDiff = !!(now && now.low > 0 && (!recOk || now.text !== atRec.text));
  const wide = /\d\s*-\s*\d/.test(recOk ? atRec.text : nowDiff ? now.text : "");
  const shortOdds = (t) => String(t).replace(/\s*-\s*/, "-");
  const evOf = (o) => (o && o.low > 0 && p != null ? p * o.low : null);
  const evCls = (ev) => (Math.round(ev * 100) / 100 >= evMin - 1e-9 ? "ok" : "ng");
  const ev1 = evOf(recOk ? atRec : null), ev2 = nowDiff ? evOf(now) : null;
  const cell = (label, main, cls, sub, subCls) => {
    const k = el("div", "k" + (cls ? " " + cls : ""));
    k.append(el("small", null, label), el("b", "num" + (String(main).length > 5 ? " long" : ""), main));
    if (sub) k.append(el("i", subCls || null, sub));
    return k;
  };
  const kpi = el("div", "bet-kpi");
  kpi.append(
    cell(rec["予想オッズ"] && b["券種"] === "単勝" ? "オッズ（予想）" : "オッズ", recOk ? shortOdds(atRec.text) : "--", null, nowDiff ? `今 ${shortOdds(now.text)}` : null),
    cell("当たる確率", p != null ? `${(p * 100).toFixed(1)}%` : "--"),
    cell("期待値", ev1 != null ? ev1.toFixed(2) : "--", ev1 != null ? `ev ${evCls(ev1)}` : "ev", ev2 != null ? `今 ${ev2.toFixed(2)}` : null, ev2 != null ? evCls(ev2) : null));
  row.append(kpi);
  // 補足の1行：当たったときの払戻・AI の推定勝率から計算した的中率（Harville 法）・ケリー基準の金額の目安
  const extra = [];
  if (recOk) extra.push(el("span", null, `当たれば ${yen(Math.floor(b["金額"] / 100) * Math.round(atRec.low * 100))}${wide ? "以上" : ""}`));
  const cp = calcProbOf(b);
  // AI の推定勝率から計算した的中率は、AI の見積もりと大きく違うときだけ出す（同じくらいなら読む意味がないので）
  if (cp != null && p != null && Math.abs(p - cp) > Math.max(KS.CONFIG.CALC_FAR_POINTS, cp * KS.CONFIG.CALC_FAR_RATIO)) {
    extra.push(el("span", "calc-far", `勝率から計算 ${(cp * 100).toFixed(1)}%（AI と差が大きい）`));
  }
  // 複勝・ワイドで下限が1.1倍以下は、当たってもほぼ元返し（指示文でも選ばないよう伝えている）
  const lowNow = nowDiff ? now.low : recOk ? atRec.low : null;
  if ((b["券種"] === "複勝" || b["券種"] === "ワイド") && lowNow != null && lowNow <= KS.CONFIG.PAYBACK_MAX_ODDS) extra.push(el("span", "calc-far", "元返しに近い（当たっても増えない）"));
  const ko = lowNow;
  const ka = rec["結果"] ? null : kellyAmount(p, ko);
  if (ka != null) extra.push(el("span", "kelly", ka > 0 ? `ケリー${kellyLabel()} ${yen(ka)}` : `ケリー${kellyLabel()} 見送り`));
  if (extra.length) { const d = el("div", "bet-extra"); extra.forEach((x, j) => { if (j) d.append(el("span", "sep", "・")); d.append(x); }); row.append(d); }
  return { row, kelly: ka };
}

// 買い目の合計・ケリーの合計・どれかが当たる確率
function betTotals(bets, pred, kellyTotal, kellyN) {
  const total = bets.reduce((t, b) => t + b["金額"], 0);
  const sum = el("p", "bet-total");
  sum.append(document.createTextNode(`合計 ${yen(total)}`));
  if (kellyN) sum.append(el("span", "kelly-total", kellyTotal > 0 ? `ケリー${kellyLabel()}の目安 合計 ${yen(kellyTotal)}` : `ケリー${kellyLabel()}ではすべて見送り`));
  // どれかが当たる確率（AI の見積もり）。同じ券種の別の組み合わせ（単勝どうし・三連複どうしなど）は同時に当たらないので足せる。
  // 複勝・ワイドや券種が混ざると同時に当たることがあるので、幅（いちばん高い確率〜足した確率）で出す
  const ps = bets.map((b) => betProbOf(b, pred));
  if (ps.length && ps.every((x) => x != null)) {
    const exclusive = new Set(bets.map((b) => b["券種"])).size === 1 && !["複勝", "ワイド"].includes(bets[0]["券種"]) &&
      new Set(bets.map((b) => b["組み合わせ"])).size === bets.length;
    const total1 = Math.min(1, ps.reduce((t, x) => t + x, 0)), max1 = Math.max(...ps);
    const pct = (x) => `${(x * 100).toFixed(1)}%`;
    const range = !(exclusive || total1 - max1 < 0.0005);
    sum.append(el("span", "hit-any", range ? `どれかが当たる確率 ${pct(max1)}〜${pct(total1)}` : `どれかが当たる確率 ${pct(total1)}`));
    if (range) sum.append(el("span", "hint-s", "同時に当たることがあるので幅で表示"));
  }
  if (bets.some((b) => betProbOf(b, pred) == null)) sum.append(el("span", "note", "推定的中率が分からない買い目は、期待値を出していません（記録用ブロックに推定的中率の列が無い古い回答など）"));
  return sum;
}

// 買い目の一覧（key: "買い目" か "的中買い目"）
function betSection(ctx, key, oddsKey, title, condText, evMin) {
  const { rec, pred } = ctx;
  const ai = rec["AI"];
  const c = el("div", "bet-section");
  if (title) { const hh = el("h4", "bet-head", title); hh.append(el("span", "aside", condText)); c.append(hh); }
  else c.append(el("p", "ai-cond", condText));
  const bets = ai[key] || [];
  const settled = rec["結果"] ? KS.settleBets(rec, key) : null;
  if (!bets.length) { c.append(el("p", "ai-skip", "見送り（条件を満たす買い目なし）")); return c; }
  // 記録したときのオッズと、今のオッズ（記録のあとに取り直していれば）
  const rowCtx = Object.assign({}, ctx, { recOdds: ai[oddsKey] || [], settled, evMin });
  const list = el("div", "bet-list");
  let kellyTotal = 0, kellyN = 0;
  bets.forEach((b, i) => {
    const { row, kelly } = betRow(b, i, rowCtx);
    if (kelly != null) { kellyTotal += kelly; kellyN++; }
    list.append(row);
  });
  c.append(list, betTotals(bets, pred, kellyTotal, kellyN));
  if (settled) {
    const spent = settled.reduce((t, x) => t + x["金額"], 0), ret = settled.reduce((t, x) => t + x["払戻"], 0);
    const v = el("p", "verdict"); v.append(document.createTextNode("収支 "), el("b", ret - spent >= 0 ? "up" : "down", `${ret - spent >= 0 ? "+" : ""}${yen(ret - spent)}`), document.createTextNode(`（購入 ${yen(spent)} → 払戻 ${yen(ret)}）`));
    c.append(v);
  }
  return c;
}

// 市場と AI の比較の表（AI の推定勝率の高い順に6頭。買った馬は必ず入れる）。出す馬がいなければ null
function aiCompareTable(rec, info, pred) {
  const ai = rec["AI"];
  const boughtNos = new Set();
  for (const b of [...(ai["買い目"] || []), ...(ai["的中買い目"] || [])]) if (!b["券種"].startsWith("枠")) b["組み合わせ"].split("-").forEach((n) => boughtNos.add(n));
  const horses = (info.horses || []).filter((x) => !x.cancel);
  const all = horses.map((x) => ({ x, no: String(parseInt(x.no, 10)), ai: pred[String(parseInt(x.no, 10))] })).filter((r) => r.ai)
    .sort((a, b) => b.ai["勝率"] - a.ai["勝率"]);
  const rows = all.filter((r, i) => i < 6 || boughtNos.has(r.no));
  if (!rows.length) return null;
  const tb = el("table", "rec-table"); tb.style.marginTop = "12px";
  const hr = el("tr"); for (const [t, cls] of [["馬"], ["市場", "r"], ["AI勝率", "r"], ["差", "r"], ["AI複勝", "r"]]) hr.append(el("th", cls || null, t)); tb.append(hr);
  for (const { x, no, ai: a } of rows) {
    const d = a["勝率"] - (x.prob || 0);
    const ratio = x.prob ? a["勝率"] / x.prob : null;
    const tag = ratio != null && d >= 2 && ratio >= 1.3 ? ["pick", "狙い目"] : ratio != null && d <= -2 && ratio <= 0.9 ? ["over", "人気しすぎ"] : null;
    const tr = el("tr");
    if (boughtNos.has(no)) tr.className = "bought";
    const res = rec["結果"] && rec["結果"]["着順"][no];
    const name = el("td");
    if (boughtNos.has(no)) name.append(el("span", "buy-mark", "買"));
    name.append(document.createTextNode(`${x.no} ${x.name}${res && /^\d+$/.test(res) ? `（${res}着）` : ""}`));
    if (tag) name.append(el("span", "h-tag " + tag[0], tag[1]));
    tr.append(name, el("td", "r", x.prob != null ? `${x.prob.toFixed(1)}%` : "--"),
      el("td", "r", `${a["勝率"].toFixed(1)}%`), el("td", "r", `${d >= 0 ? "+" : ""}${d.toFixed(1)}`), el("td", "r", `${a["複勝率"].toFixed(0)}%`));
    tb.append(tr);
  }
  return tb;
}

// 結果が出る前／出たあとの一言（結果の着順、または結果をいつ取るか）
function aiResultNote(rec) {
  if (rec["結果"]) {
    const top = Object.entries(rec["結果"]["着順"]).filter(([, r]) => /^[123]$/.test(r)).sort((a, b) => +a[1] - +b[1]).map(([n, r]) => `${r}着 ${n}番`).join("・");
    return el("p", "note", `結果：${top}`);
  }
  const ss = sinceStart(rec);
  if (ss != null && ss >= KS.CONFIG.RESULT_DELAY_MINUTES && rec.race_id) return el("p", "note", "上の「レース結果を取得」で答え合わせできます");
  let exact = true; try { exact = Native.exactAlarmAllowed(); } catch (e) { logError("アラームの許可の確認", e); }
  const at = resultTimeOf(rec);
  return el("p", "note", !at ? `発走の${KS.CONFIG.RESULT_DELAY_MINUTES}分後から結果を取得できます`
    : exact ? `結果は ${at} ごろ自動で取得して通知します`
    : `結果は ${at} から取得できます（自動で取るには「アラームとリマインダー」の許可が要ります）`);
}

function aiCard(venue, race) {
  const key = cacheKey(state.date, venue, race.no);
  const rec = readRecords()[key];
  const c = el("div", "card ai-card");
  const h = el("h3", null, "AI の予想");
  c.append(h);
  if (!rec || !rec["AI"]) {
    c.append(el("p", "lead", "AI の回答をコピーしてから押すと記録します"));
    const b = el("button", "btn secondary preview-btn", "AI の回答を貼り付けて記録"); b.onclick = () => pasteAiAnswer(); c.append(b);
    return addHelp(c, "ai-empty", ["AI の回答（全文）をコピーしてから押すと、最後の記録用ブロック（#PRED・#BET）を読んで記録します。AI へ送ったあとこの画面に戻ると、コピーした回答を自動で見つけて記録を勧めます。結果が出たら答え合わせできます"]);
  }
  const ai = rec["AI"], pred = ai["予想"] || {};
  const aiHelp = ["買い目ごとに、オッズ（複勝・ワイドは幅の下限）× AI の推定した当たる確率 ＝ 期待値 を出します。期待値が条件の下限以上なら緑、下回れば黄。記録のあとにオッズを取り直していれば「今」の値も並べます（締切前に期待値が下限を割っていないかの確認に）",
    "「勝率から計算」は、AI の推定勝率から Harville 法で計算した複勝・ワイド・3連複の的中率です。AI の見積もりと大きく違うときだけ黄色で出します（AI の見積もりが自分の推定勝率と食い違っている印）",
    "「ケリー」は、推定的中率とオッズから出した最適な賭け金の割合 × 設定の割合（既定 1/4）× 資金 を100円単位にした目安です。1点ずつの計算なので、何点も買うときの合計は多めに出ます。割合と資金は「AI への条件」の画面で変えられます",
    "「どれかが当たる確率」は AI の見積もりです。複勝・ワイドや券種の違う買い目は同時に当たることがあるので、幅（いちばん高い確率〜足した確率）で出します"];
  { const t = String(ai["記録時刻"] || ""); h.append(el("span", "aside", t.length >= 16 ? `記録 ${+t.slice(5, 7)}/${+t.slice(8, 10)} ${t.slice(11, 16)}` : "")); }
  const info = state.result.res.info;
  const updated = state.result.res.at && rec["収集時刻"] && state.result.res.at !== rec["収集時刻"];
  const hasHit = hasHitOf(rec);
  const bs = betSettings();
  const evMin0 = rec["EV_MIN"] != null ? rec["EV_MIN"] : bs.ev_min;
  const hitEv0 = rec["HIT_EV_MIN"] != null ? rec["HIT_EV_MIN"] : bs.hit_ev_min;
  const hitMin0 = rec["HIT_MIN"] != null ? rec["HIT_MIN"] : bs.hit_min;
  if (rec["予算"]) c.append(el("p", "ai-cond", `予算 ${yen(rec["予算"])}` + (hasHit && rec["買い方"] !== "hit" ? "（期待値重視・的中重視それぞれ）" : "")));
  const ctx = { rec, info, pred, updated, calcProbOf: aiCalcProb(info, pred) };
  // 期待値重視（#BET）を出す。的中重視（#HIT）を記録していれば続けて出す（的中重視だけのときは期待値重視を省く）
  if (!(hasHit && rec["買い方"] === "hit")) c.append(betSection(ctx, "買い目", "オッズ", hasHit ? "期待値重視" : "", `期待値 ${KS.fmtEv(evMin0)} 以上`, evMin0));
  if (hasHit) c.append(betSection(ctx, "的中買い目", "的中オッズ", "的中重視", `的中率 ${hitMin0}%以上・期待値 ${KS.fmtEv(hitEv0)} 以上`, hitEv0));
  if (ai["総評"]) c.append(el("p", "ai-comment", `「${ai["総評"]}」`));
  c.append(aiResultNote(rec));
  const tb = aiCompareTable(rec, info, pred);
  if (tb) {
    c.append(tb);
    aiHelp.push((updated ? `市場は最新の収集（${state.result.res.at.slice(11, 16)}）の値。` : "") + "下の表は AI の推定勝率の高い順に6頭（買った馬は必ず表示）。差は AI − 市場（ポイント）。AI が市場より2ポイント以上・3割以上高く見る馬に「狙い目」、2ポイント以上・1割以上低く見る馬に「人気しすぎ」");
  }
  c.append(aiRecordButtons(key, race));
  return addHelp(c, "ai", aiHelp);
}

// 「貼り直す」「記録を消す」
function aiRecordButtons(key, race) {
  const row = el("div", "btn-row"); row.style.marginTop = "10px";
  const again = el("button", "btn quiet", "貼り直す"); again.onclick = pasteAiAnswer;
  const del = el("button", "btn quiet", "記録を消す");
  del.onclick = () => {
    if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "もう一度押すと消します"; return; }
    const r = readRecords();
    if (ownBetsOf(r[key]).length) {
      // 買った馬券は残し、AI の回答だけ消す
      r[key]["AI"] = null; delete r[key]["買い方"]; writeRecords(r); scheduleResultCheck(key, r[key], race);
    } else { delete r[key]; writeRecords(r); try { Native.cancelResultCheck(key); } catch (e) {} }
    renderResult(); updateRecBadge(); toast("AI の予想の記録を消しました");
  };
  row.append(again, del);
  return row;
}

// ===== AI なしの目安（市場の歪み） =====
// 単勝オッズの市場勝率から計算した的中率と、複勝・ワイド・3連複のオッズのずれから出す買い目。予想ではない
function marketCard(venue, race, info) {
  const c = el("div", "card market-card");
  c.append(el("h3", null, "AI なしの目安"));
  const rec = readRecords()[cacheKey(state.date, venue, race.no)];
  const mp = KS.marketPicks(info, betSettings());
  c.append(el("p", "ai-cond", `市場計算の的中率 ${KS.CONFIG.MARKET_PROB_MIN * 100}%以上・期待値 ${KS.fmtEv(KS.CONFIG.MARKET_EV_MIN)} 以上`));
  if (mp.cands.length) {
    const tb = el("table", "rec-table"); tb.style.marginTop = "6px";
    const hr = el("tr"); for (const [t, cls] of [["買い目"], ["的中率", "r"], ["オッズ", "r"], ["期待値", "r"]]) hr.append(el("th", cls || null, t)); tb.append(hr);
    for (const x of mp.cands) {
      const tr = el("tr");
      const name = el("td");
      if (x.pick) name.append(el("span", "buy-mark", "選"));
      name.append(document.createTextNode(`${x["券種"]} ${x["組み合わせ"]}`));
      tr.append(name, el("td", "r", `${(x.p * 100).toFixed(1)}%`), el("td", "r", x.odds), el("td", "r " + (x.pick ? "up" : ""), KS.fmtEv(x.ev)));
      tb.append(tr);
    }
    c.append(tb);
  }
  if (mp.bets.length) c.append(el("p", "bet-total", `選んだ組：${mp.bets.map((b) => `${b["券種"]} ${b["組み合わせ"]} ${yen(b["金額"])}`).join("・")}`));
  if (mp.reason) c.append(el("p", "ai-skip", mp.reason));
  // 結果が出たら、収集したときに残した買い目で答え合わせ
  if (rec && rec["結果"] && Array.isArray(rec["市場買い目"])) {
    let rows = null;
    try { rows = KS.settleBets(rec, "市場買い目"); } catch (e) { logError("AI なしの目安の答え合わせ", e); }
    if (rows && rows.length) {
      const spent = rows.reduce((t, x) => t + x["金額"], 0), ret = rows.reduce((t, x) => t + x["払戻"], 0);
      const v = el("p", "verdict"); v.append(document.createTextNode(`記録した目安（${String(rec["市場記録時刻"] || "").slice(11, 16)} のオッズ）の収支 `), el("b", ret - spent >= 0 ? "up" : "down", `${ret - spent >= 0 ? "+" : ""}${yen(ret - spent)}`));
      c.append(v);
    } else if (rows) c.append(el("p", "note", "記録した目安は見送りでした"));
  }
  return addHelp(c, "market", [
    "AI を使わずに、オッズだけから出す目安です。単勝オッズから出した各馬の勝率（市場勝率）をもとに、複勝・ワイド・3連複が当たる確率を計算し、その券種の実際のオッズ（複勝・ワイドは幅の下限）を掛けて期待値を出します。単勝と複勝などは別々に売られているので、計算より高いオッズのまま残っている組があれば、ここに出ます",
    "予想ではありません。単勝の市場の見立てをそのまま使うので、単勝は選びません。計算には、勝率から2・3着の確率を出す Harville 法を、人気馬の2・3着を多めに見積もるくせを抑えるよう補正して使っています",
    "発走前に収集するたびに、そのときのオッズで出し直して記録に残し、結果が出たら自動で答え合わせします。効くかどうかは、記録の画面の「回収率：AI なしの目安」で、レースがたまってから判断してください（締切までにオッズは動きます）",
  ]);
}

// ===== 買った馬券（自分で実際に買ったもの。AI の買い目とは別に記録して答え合わせする） =====
function ownBetsOf(r) { return r && Array.isArray(r["購入"]) ? r["購入"] : []; }
// 買った馬券を保存する（記録が無ければ、収集したデータから記録を作る）
function saveOwnBets(venue, race, list) {
  const res = state.result.res;
  const key = cacheKey(state.date, venue, race.no);
  const recs = readRecords();
  let rec = recs[key];
  if (!rec) {
    rec = Object.assign(KS.newRecord(state.date, venue, race.no, res), { "発走": res.info.start || race.time || "" });
    if (res.info.predicted) rec["予想オッズ"] = true;
  }
  rec["購入"] = list;
  rec["購入時刻"] = localStamp();
  recs[key] = rec;
  writeRecords(recs);
  if (!rec["結果"]) scheduleResultCheck(key, rec, race);
  renderResult(); updateRecBadge();
}
function ownCard(venue, race) {
  const key = cacheKey(state.date, venue, race.no);
  const rec = readRecords()[key];
  const own = ownBetsOf(rec);
  const info = state.result.res.info;
  const c = el("div", "card own-card");
  const h = el("h3", null, "買った馬券");
  if (rec && rec["購入時刻"] && own.length) { const t = rec["購入時刻"]; h.append(el("span", "aside", `記録 ${+t.slice(5, 7)}/${+t.slice(8, 10)} ${t.slice(11, 16)}`)); }
  c.append(h);
  if (!own.length) c.append(el("p", "lead", "実際に買った馬券を入れると答え合わせします"));
  addHelp(c, "own", ["実際に買った馬券を入れると、結果が出たときに答え合わせし、記録の画面で AI の買い目と別に集計します。即PAT の購入内容は自動では取り込めないので、手で入れます。AI の買い目をそのまま写すこともできます"]);
  const settled = rec && rec["結果"] && own.length ? (() => { try { return KS.settleBets(rec, "購入"); } catch (e) { return null; } })() : null;
  if (own.length) {
    const list = el("div", "bet-list");
    own.forEach((b, i) => {
      const row = el("div", "bet");
      const top = el("div", "bet-top");
      const what = el("span", "bet-what");
      what.append(el("b", null, `${b["券種"]} ${b["組み合わせ"]}`));
      const names = b["券種"].startsWith("枠") ? "" : b["組み合わせ"].split("-").map((n) => ((info.horses || []).find((x) => String(parseInt(x.no, 10)) === n) || {}).name || "").filter(Boolean).join("・");
      if (names) what.append(el("span", "bet-name", names));
      top.append(what, el("span", "bet-amt num", yen(b["金額"])));
      const s = settled && settled[i];
      if (rec["結果"]) top.append(el("span", "bet-res " + (s ? (s["判定"] === "的中" ? "hit" : s["判定"] === "返還" ? "back" : "miss") : "miss"),
        s ? (s["判定"] === "的中" ? `的中 ${yen(s["払戻"])}` : s["判定"] === "返還" ? `返還 ${yen(s["払戻"])}` : "不的中") : "払戻不明"));
      else {
        const x = el("button", "bet-del", "×"); x.setAttribute("aria-label", "この馬券を消す");
        x.onclick = () => { const l = own.slice(); l.splice(i, 1); saveOwnBets(venue, race, l); toast("消しました"); };
        top.append(x);
      }
      row.append(top);
      const o = betOddsOf(b, info);
      if (o && !rec["結果"]) row.append(el("div", "bet-ev", `今 ${o.text}倍・当たれば ${yen(Math.floor(b["金額"] / 100) * Math.round(o.low * 100))}${/\d\s*-\s*\d/.test(o.text) ? "以上" : ""}`));
      list.append(row);
    });
    c.append(list);
    c.append(el("p", "bet-total", `合計 ${yen(own.reduce((t, b) => t + b["金額"], 0))}`));
    if (settled) {
      const spent = settled.reduce((t, x) => t + x["金額"], 0), ret = settled.reduce((t, x) => t + x["払戻"], 0);
      const v = el("p", "verdict"); v.append(document.createTextNode("収支 "), el("b", ret - spent >= 0 ? "up" : "down", `${ret - spent >= 0 ? "+" : ""}${yen(ret - spent)}`), document.createTextNode(`（購入 ${yen(spent)} → 払戻 ${yen(ret)}）`));
      c.append(v);
    }
  }
  if (!rec || !rec["結果"]) {
    const row = el("div", "own-actions");
    const ai = rec && rec["AI"];
    const copy = (k, label) => {
      const src = ai && ai[k];
      if (!Array.isArray(src) || !src.length) return;
      const b = el("button", "btn secondary", label);
      b.onclick = () => { saveOwnBets(venue, race, own.concat(src.map((x) => ({ "券種": x["券種"], "組み合わせ": x["組み合わせ"], "金額": x["金額"] })))); toast("入れました"); };
      row.append(b);
    };
    copy("買い目", hasHitOf(rec || {}) ? "期待値重視の買い目を入れる" : "AI の買い目を入れる");
    copy("的中買い目", "的中重視の買い目を入れる");
    const add = el("button", "btn secondary", "1点ずつ入れる"); add.onclick = () => openOwnSheet(venue, race); row.append(add);
    if (own.length) {
      const clr = el("button", "btn quiet", "全部消す");
      clr.onclick = () => { if (!clr.dataset.armed) { clr.dataset.armed = "1"; clr.textContent = "もう一度押すと消します"; return; } saveOwnBets(venue, race, []); toast("消しました"); };
      row.append(clr);
    }
    c.append(row);
  }
  return c;
}
// 1点ずつ入れるシート（券種・馬番・金額）
function openOwnSheet(venue, race) {
  const info = state.result.res.info;
  const horses = (info.horses || []).filter((x) => !x.cancel);
  const TYPES = ["単勝", "複勝", "ワイド", "馬連", "馬単", "3連複", "3連単", "枠連", "枠単"];
  let type = "単勝", picks = [], amount = 100;
  const sh = $("sheet");
  function render() {
    sh.replaceChildren();
    sh.append(el("div", "grip"), el("h3", null, "買った馬券を入れる"), el("p", "sub", `${venue} ${race.no}R ${race.title || ""}`));
    sh.append(el("h4", null, "券種"));
    const tg = el("div", "chips-pick");
    for (const t of TYPES) { const b = el("button", null, t); b.setAttribute("aria-pressed", String(t === type)); b.onclick = () => { type = t; picks = []; render(); }; tg.append(b); }
    sh.append(tg);
    const [need, ordered] = KS.BET_SPECS[type];
    const waku = type.startsWith("枠");
    sh.append(el("h4", null, `${waku ? "枠番" : "馬番"}（${need}${waku ? "枠" : "頭"}${ordered ? "。着順の順に選ぶ" : ""}）`));
    const grid = el("div", "pick-grid");
    const items = waku ? [...new Set(horses.map((x) => x.waku).filter(Boolean))].sort((a, b) => a - b).map((w) => ({ no: String(+w), name: "" }))
      : horses.map((x) => ({ no: String(parseInt(x.no, 10)), name: x.name }));
    for (const it of items) {
      const idx = picks.indexOf(it.no);
      const b = el("button", "pick" + (idx >= 0 ? " on" : ""));
      b.append(el("b", null, it.no)); if (it.name) b.append(el("small", null, it.name));
      if (idx >= 0 && ordered) b.append(el("i", null, `${idx + 1}着`));
      b.onclick = () => { if (idx >= 0) picks.splice(idx, 1); else if (picks.length < need) picks.push(it.no); render(); };
      grid.append(b);
    }
    sh.append(grid);
    sh.append(el("h4", null, "金額"));
    const st = stepper(yen(amount), amount <= 100, amount >= 100000, () => { amount = Math.max(100, amount - 100); render(); }, () => { amount += 100; render(); });
    sh.append(st);
    const ag = el("div", "chips-pick");
    for (const v of [100, 200, 300, 500, 1000, 2000]) { const b = el("button", null, yen(v)); b.setAttribute("aria-pressed", String(v === amount)); b.onclick = () => { amount = v; render(); }; ag.append(b); }
    sh.append(ag);
    const act = el("div", "end-actions");
    const ok = el("button", "btn primary", picks.length === need ? `${type} ${KS.comboKey(type, picks)}・${yen(amount)} を入れる` : `${need - picks.length}つ選んでください`);
    ok.disabled = picks.length !== need;
    ok.onclick = () => {
      const recs = readRecords(); const cur = ownBetsOf(recs[cacheKey(state.date, venue, race.no)]);
      saveOwnBets(venue, race, cur.concat([{ "券種": type, "組み合わせ": KS.comboKey(type, picks), "金額": amount }]));
      closeSheet(); toast("入れました");
    };
    const cancel = el("button", "btn quiet", "やめる"); cancel.onclick = closeSheet;
    act.append(ok, cancel); sh.append(act);
  }
  render();
  sh.classList.remove("hidden"); $("sheetScrim").classList.remove("hidden");
}

// ===== 記録と答え合わせの画面 =====
function showRecords() { state.back = null; showScreen("records"); renderRecords(); }
// ===== 回収率の推移と内訳 =====
// 記録を発走の順（日付・発走時刻・競馬場・レース番号）に並べ、買った・買い目のあるレースだけで収支を足し上げる。
// 期待値重視・的中重視の数え方は computeSummary（PC版の _bet_summary）と同じ
function trendSeries(records) {
  const done = records.filter((r) => r["結果"]).sort((a, b) =>
    `${a["日付"]} ${a["発走"] || ""} ${a["競馬場"]} ${String(a["レース番号"]).padStart(2, "0")}`.localeCompare(`${b["日付"]} ${b["発走"] || ""} ${b["競馬場"]} ${String(b["レース番号"]).padStart(2, "0")}`));
  const defs = [
    { id: "own", label: "自分", key: "購入", ok: (r) => Array.isArray(r["購入"]) && r["購入"].length },
    { id: "ev", label: "AI期待値", key: "買い目", ok: (r) => r["AI"] && r["買い方"] !== "hit" },
    { id: "hit", label: "AI的中", key: "的中買い目", ok: (r) => r["AI"] && (Array.isArray(r["AI"]["的中買い目"]) || ["hit", "both"].includes(r["買い方"])) },
  ];
  const out = [];
  for (const d of defs) {
    let cum = 0, spent = 0, ret = 0; const pts = [];
    for (const r of done) {
      if (!d.ok(r)) continue;
      let rows = null; try { rows = KS.settleBets(r, d.key); } catch (e) { rows = null; }
      if (!rows || !rows.length) continue;
      const a = rows.reduce((t, x) => t + x["金額"], 0), b = rows.reduce((t, x) => t + x["払戻"], 0);
      spent += a; ret += b; cum += b - a;
      pts.push({ cum, roi: ret / spent * 100, date: r["日付"] });
    }
    if (pts.length) out.push(Object.assign({ pts, spent, ret }, d));
  }
  // AI の的中重視が無いときは「AI期待値」を「AI」と書く
  if (!out.some((x) => x.id === "hit")) out.forEach((x) => { if (x.id === "ev") x.label = "AI"; });
  return out;
}
function trendCard(records) {
  const series = trendSeries(records);
  if (!series.length || !series.some((x) => x.pts.length >= 2)) return null;
  const c = el("div", "card");
  c.append(el("h3", null, "収支の推移"));
  const W = 340, H = 190, L = 50, R = 10, T = 12, B = 26;
  const n = Math.max(...series.map((x) => x.pts.length));
  const vals = series.flatMap((x) => x.pts.map((p) => p.cum)).concat([0]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1000) { const m = (hi + lo) / 2; lo = m - 500; hi = m + 500; }
  // 目盛りは 1・2・5 の刻み
  const raw = (hi - lo) / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((v) => v >= raw);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const x = (i) => L + (n <= 1 ? 0 : i / (n - 1) * (W - L - R));
  const y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "trend");
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "収支の推移のグラフ");
  const mk = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; svg.append(e); return e; };
  for (let v = lo; v <= hi + 1e-6; v += step) {
    mk("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: v === 0 ? "zero" : "grid" });
    mk("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "tick" }, `${v > 0 ? "+" : ""}${Math.abs(v) >= 10000 ? `${(v / 10000).toLocaleString("ja-JP")}万` : v.toLocaleString("ja-JP")}`);
  }
  mk("text", { x: L, y: H - 6, class: "tick" }, "1");
  mk("text", { x: W - R, y: H - 6, "text-anchor": "end", class: "tick" }, `${n}レース目`);
  for (const s1 of series) {
    const d = s1.pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.cum).toFixed(1)}`).join(" ");
    mk("path", { d, class: `ln ln-${s1.id}` });
    const last = s1.pts[s1.pts.length - 1];
    mk("circle", { cx: x(s1.pts.length - 1), cy: y(last.cum), r: 3, class: `dot ln-${s1.id}` });
  }
  c.append(svg);
  // 凡例（線の種類と最後の値）
  const lg = el("div", "trend-legend");
  for (const s1 of series) {
    const last = s1.pts[s1.pts.length - 1];
    const it = el("span", `lg lg-${s1.id}`);
    it.append(el("i"), el("b", null, s1.label), document.createTextNode(` ${last.cum >= 0 ? "+" : ""}${yen(last.cum)}・回収率 ${last.roi.toFixed(1)}%・${s1.pts.length}レース`));
    lg.append(it);
  }
  c.append(lg);
  return addHelp(c, "trend", ["買ったレース（AI は買い目のあったレース）だけを発走の順に並べ、収支を足し上げています。30レース未満は偶然の当たり外れで大きく動くので、傾向の判断には使えません"]);
}
// 締切オッズとの比較（CLV）のカード（PC版の format_clv と同じ内容）
function clvCard(clv) {
  const c = el("div", "card");
  c.append(el("h3", null, "締切オッズとの比較（CLV）"));
  if (clv.n) {
    const big = el("div", "big-num " + (clv.ratio >= 1 ? "up" : "down"), `${clv.ratio.toFixed(3)}倍`);
    if (clv.ci) big.append(el("small", null, `95%区間 ${clv.ci[0].toFixed(3)}〜${clv.ci[1].toFixed(3)}`));
    c.append(big);
    c.append(el("p", "note", `AI の買い目に入った馬 ${clv.n}頭（${clv.n_races}レース）の、記録時の単勝オッズ ÷ 確定オッズの平均。` +
      `記録のあとに人気を集めた馬 ${(clv.up * 100).toFixed(0)}%・人気を落とした馬 ${(clv.down * 100).toFixed(0)}%`));
  }
  for (const [k, label] of [["hi", "高く"], ["lo", "低く"]]) {
    const x = clv[k];
    if (x.n) c.append(el("p", "note", `AI が市場より2ポイント以上${label}見た馬 ${x.n}頭：締切までに市場勝率が平均 ${x.move >= 0 ? "+" : ""}${x.move.toFixed(2)}ポイント`));
  }
  if (clv.n) {
    const v = clv.n_races < KS.CONFIG.VERDICT_MIN_RACES || !clv.ci ? `まだ判断できません（${KS.CONFIG.VERDICT_MIN_RACES}レース未満）`
      : clv.ci[0] > 1 ? "✓ AI の買った馬は記録のあとに人気を集めています（市場より先に評価できている可能性があります）"
      : clv.ci[1] < 1 ? "! AI の買った馬は記録のあとに人気を落としています（記録時のオッズで出した期待値は高めに出ています）"
      : "記録時と締切の差は、このレース数では区別できません";
    c.append(el("p", "verdict", v));
  }
  return addHelp(c, "clv", ["1倍より大きいほど、記録したときのオッズが締切より有利だったことを示します。回収率より少ないレース数で、予想に腕があるかが見える指標です。結果ページの確定単勝オッズを読めたレース（v0.4.35 から）で数えます"]);
}

// 内訳の表（競馬場別・月別など）。rows は computeSummary の bet_rows（買い目1点ずつ）
function breakdownTable(label, rows, keyOf) {
  const groups = new Map();
  for (const x of rows) {
    const k = keyOf(x);
    const g = groups.get(k) || { races: new Set(), n: 0, hit: 0, a: 0, r: 0 };
    g.races.add(`${x.race_id}|${x["日付"]}|${x["レース番号"]}`); g.n++; g.hit += x["判定"] === "的中" ? 1 : 0; g.a += x["金額"]; g.r += x["払戻"];
    groups.set(k, g);
  }
  if (groups.size < 2) return null;
  const det = el("details", "breakdown");
  det.append(el("summary", null, `${label}の内訳`));
  const tb = el("table", "rec-table");
  const hr = el("tr"); for (const [t, cls] of [[label.replace(/別$/, "")], ["レース", "r"], ["点数", "r"], ["的中", "r"], ["購入", "r"], ["回収率", "r"]]) hr.append(el("th", cls || null, t)); tb.append(hr);
  for (const [k, g] of [...groups.entries()].sort((a, b) => b[1].a - a[1].a || String(a[0]).localeCompare(String(b[0])))) {
    const tr = el("tr");
    tr.append(el("td", null, k), el("td", "r", g.races.size), el("td", "r", g.n), el("td", "r", g.hit), el("td", "r", g.a.toLocaleString("ja-JP")),
      el("td", "r " + (g.r >= g.a ? "up" : "down"), g.a ? `${(g.r / g.a * 100).toFixed(0)}%` : "--"));
    tb.append(tr);
  }
  det.append(tb);
  return det;
}

function renderRecords() {
  const body = $("detailBody"); body.replaceChildren();
  body.append(el("h2", "race-title", "予想の記録と答え合わせ"));
  const recs = readRecords();
  const all = Object.values(recs);
  body.append(el("p", "race-sub", `記録 ${all.filter((r) => !isDataOnly(r)).length}件・答え合わせ済み ${all.filter((r) => r["AI"] && r["結果"]).length}件`));
  const bar = recordsFetchBar(recs);
  if (bar) body.append(...bar);
  const sm = safeSummary(all);
  // 回収率（自分の馬券・AI の期待値重視・AI の的中重視は別々に）
  if (!sm.own_bets && !sm.bets && !sm.hit_bets && !sm.market_bets) {
    const c0 = el("div", "card"); c0.append(el("h3", null, "回収率"), el("p", "note", "結果まで記録したレースがまだありません")); body.append(c0);
  }
  // 収支の推移（発走の順に足し上げる）
  { const tc = trendCard(all); if (tc) body.append(tc); }
  for (const [bb, title, rowsAll] of [[sm.own_bets, "回収率：自分で買った馬券", sm.own_bet_rows], [sm.bets, sm.hit_bets ? "回収率：AI 期待値重視" : sm.own_bets ? "回収率：AI の買い目" : "回収率", sm.bet_rows], [sm.hit_bets, "回収率：AI 的中重視", sm.hit_bet_rows], [sm.market_bets, "回収率：AI なしの目安", sm.market_bet_rows]]) {
    if (bb) body.append(roiCard(bb, title, rowsAll, sm));
  }
  // 締切オッズとの比較（CLV）
  if (sm.clv) body.append(clvCard(sm.clv));
  body.append(recordsList(recs), recordsActions());
  // 推定勝率の精度（判断は CLV と回収率で足りるので、いちばん下に置く）
  body.append(brierCard(sm));
}

// 「結果待ち ○件」のボタン（取得中なら進み具合）。出すものがなければ null
function recordsFetchBar(recs) {
  const pend = pendingResults();
  // データだけの記録（AI の回答なし）で結果がまだのもの。ふだんは裏で取るが、取れなかった分はここでまとめて取る
  const dataPend = Object.entries(recs).filter(([, r]) => isDataOnly(r) && !r["結果"] && r.race_id && (sinceStart(r) ?? 0) >= KS.CONFIG.RESULT_DELAY_MINUTES && (sinceStart(r) ?? 0) < 3 * 24 * 60);
  if (state.fetching) {
    const c = el("div", "card"); c.append(el("h3", null, `結果を取得中… ${state.fetching.done} / ${state.fetching.total}`));
    const bar = el("div", "bar"); const f = el("i"); f.style.width = `${state.fetching.done / state.fetching.total * 100}%`; bar.append(f); c.append(bar);
    return [c];
  } else if (pend.length || dataPend.length) {
    const b = el("button", "update-bar");
    b.append(el("span", null, "結果待ち "), el("b", "num", `${pend.length + dataPend.length}件`));
    if (dataPend.length) b.append(el("span", null, `（データ ${dataPend.length}件）`));
    b.append(el("span", "go", "結果を取得 ›"));
    b.onclick = () => fetchResults(pend.concat(dataPend).map(([k]) => k));
    return [b, el("p", "note", "結果ページを1レースにつき1回、2秒おきに読みます")];
  }
  return null;
}

// 集計。形の崩れた記録があっても画面は出す（集計できない記録を除いて集計し直す）
function safeSummary(all) {
  let sm;
  try { sm = KS.computeSummary(all); } catch (e) {
    sm = KS.computeSummary(all.filter((r) => { try { KS.computeSummary([r]); return true; } catch (e2) { logError(`集計から外した記録（${r.race_id}）`, e2); return false; } }));
  }
  return sm;
}

// 回収率のカード（券種別の表と、競馬場別・月別の内訳）
function roiCard(b, title, rowsAll, sm) {
  const c1 = el("div", "card");
  c1.append(el("h3", null, title));
  if (!b || !b.bought) c1.append(el("p", "note", sm.n_races ? `買ったレースがまだありません（見送り ${b ? b.skipped : 0}件）` : "結果まで記録したレースがまだありません"));
  else {
    const roi = b.ret / b.spent * 100;
    const big = el("div", "big-num " + (roi >= 100 ? "up" : "down"), `${roi.toFixed(1)}%`);
    if (b.ci) big.append(el("small", null, `95%区間 ${(b.ci[0] * 100).toFixed(0)}〜${(b.ci[1] * 100).toFixed(0)}%`));
    c1.append(big);
    c1.append(el("p", "note", `購入 ${yen(b.spent)} → 払戻 ${yen(b.ret)}（収支 ${b.ret - b.spent >= 0 ? "+" : ""}${yen(b.ret - b.spent)}）・的中したレース ${b.hit_races}/${b.bought}（${(b.hit_races / b.bought * 100).toFixed(0)}%）・見送り ${b.skipped}件${b.unknown ? `・払戻を読めず除外 ${b.unknown}件` : ""}`));
    const tb = el("table", "rec-table");
    const hr = el("tr"); for (const [t, cls] of [["券種"], ["点数", "r"], ["的中", "r"], ["購入", "r"], ["払戻", "r"], ["回収率", "r"]]) hr.append(el("th", cls || null, t)); tb.append(hr);
    for (const [k, n, hit, a, r] of b.by_type) {
      const tr = el("tr"); tr.append(el("td", null, k), el("td", "r", n), el("td", "r", hit), el("td", "r", a.toLocaleString("ja-JP")), el("td", "r", r.toLocaleString("ja-JP")), el("td", "r " + (r >= a ? "up" : "down"), `${(r / a * 100).toFixed(0)}%`));
      tb.append(tr);
    }
    c1.append(tb);
    // 内訳：競馬場別・月別（開くと出す）
    for (const [label, keyOf] of [["競馬場別", (x) => x["競馬場"] || "?"], ["月別", (x) => { const d = String(x["日付"] || ""); return d.length >= 6 ? `${d.slice(0, 4)}/${d.slice(4, 6)}` : "?"; }]]) {
      const det = breakdownTable(label, rowsAll || [], keyOf);
      if (det) c1.append(det);
    }
  }
  return c1;
}

// 推定勝率の精度（ブライアスコア）のカード
function brierCard(sm) {
  const c2 = el("div", "card");
  c2.append(el("h3", null, "推定勝率の精度（ブライアスコア、小さいほど良い）"));
  if (!sm.brier) c2.append(el("p", "note", "市場勝率と AI の推定がそろったレースがまだありません"));
  else {
    const br = sm.brier;
    c2.append(el("p", null, `市場 ${br.market.toFixed(4)} ／ AI ${br.ai.toFixed(4)}（${br.n}レース）`));
    c2.append(el("p", "note", `AI − 市場 = ${br.diff >= 0 ? "+" : ""}${br.diff.toFixed(4)}（95%区間 ${br.ci[0] >= 0 ? "+" : ""}${br.ci[0].toFixed(4)}〜${br.ci[1] >= 0 ? "+" : ""}${br.ci[1].toFixed(4)}）`));
    if (br.n < KS.CONFIG.VERDICT_MIN_RACES) c2.append(el("p", "verdict", `まだ判断できません（${KS.CONFIG.VERDICT_MIN_RACES}レース未満）`));
    else c2.append(el("p", "verdict", br.ci[1] < 0 ? "✓ AI の推定勝率は、市場（単勝オッズ）より当たっています" : br.ci[0] > 0 ? "! AI の推定勝率は、市場（単勝オッズ）より外れています" : "AI と市場の差は、このレース数では区別できません"));
    // 推定○%の馬が実際に何%勝ったか（レース数が少ないうちは意味が薄いので畳んでおく）
    const det = el("details", "breakdown"); keepOpen(det, "calib");
    det.append(el("summary", null, "キャリブレーション（推定○%の馬が実際に何%勝ったか）"));
    const tb = el("table", "rec-table"); tb.style.marginTop = "6px";
    const hr = el("tr"); for (const [t, cls] of [["推定勝率"], ["件数", "r"], ["AI推定", "r"], ["実際", "r"]]) hr.append(el("th", cls || null, t)); tb.append(hr);
    for (const [lo, hi, cnt, mp, act] of sm.calib_win.ai) {
      const tr = el("tr"); tr.append(el("td", null, `${lo}〜${hi}%`), el("td", "r", cnt), el("td", "r", `${mp.toFixed(1)}%`), el("td", "r", `${act.toFixed(1)}%`)); tb.append(tr);
    }
    det.append(tb);
    det.append(el("p", "note", `推定複勝率のブライアスコア ${sm.calib_place.brier.toFixed(4)}`));
    c2.append(det);
  }
  if (sm.n_races && sm.n_races < KS.CONFIG.VERDICT_MIN_RACES) c2.append(el("p", "note", `※レース数が ${sm.n_races}件と少ないため、区間が広く結論は出せません。50レース以上たまってから判断してください`));
  return c2;
}

// 記録の一覧（新しい順に100件）
function recordsList(recs) {
  const list = el("div", "rec-list"); list.style.marginTop = "12px";
  const cache = readCache();
  const entries = Object.entries(recs).filter(([, r]) => !isDataOnly(r)).sort((a, b) => recOrder(b[1]).localeCompare(recOrder(a[1])));
  const dataRecs = Object.values(recs).filter(isDataOnly);
  if (dataRecs.length) list.append(el("p", "note", `ほかに、データとして記録したレース ${dataRecs.length}件（結果あり ${dataRecs.filter((r) => r["結果"]).length}件）。AI の回答がないレースも結果まで残し、書き出しと自動バックアップに入ります（あとで分析に使うため）`));
  for (const [key, r] of entries.slice(0, 100)) list.append(recordItem(key, r, cache));
  if (!entries.length) list.append(el("p", "note", "結果画面の「AI の回答を貼り付けて記録」で記録すると、ここに並びます"));
  return list;
}

// 一覧の1行（レース・買い目・収支）。押すとそのレースの結果画面を開く
function recordItem(key, r, cache) {
  const it = el("button", "rec-item");
  it.append(el("span", "t", `${r["日付"].slice(4, 6)}/${r["日付"].slice(6)} ${r["競馬場"]} ${r["レース番号"]}R ${r["レース名"] || ""}`));
  const desc = (xs) => xs.length ? xs.map((x) => `${x["券種"]} ${x["組み合わせ"]}：${yen(x["金額"])}`).join("　") : "見送り";
  const hasHit = r["AI"] && hasHitOf(r);
  const own = ownBetsOf(r);
  let keys = !r["AI"] ? [] : hasHit ? (r["買い方"] === "hit" ? [["的中買い目", "的中重視 "]] : [["買い目", "期待値重視 "], ["的中買い目", "的中重視 "]]) : [["買い目", own.length ? "AI " : ""]];
  if (own.length) keys = [["購入", "自分 "]].concat(keys);
  const betsOf = (k) => (k === "購入" ? own : (r["AI"] && r["AI"][k]) || []);
  it.append(el("span", "s", !keys.length ? "AI の回答なし" : keys.map(([k, lb]) => lb + desc(betsOf(k))).join(" ／ ")));
  let st;
  if (!keys.length) st = el("span", "st wait", "—");
  else if (!r["結果"]) st = el("span", "st wait", "結果待ち");
  else {
    const parts = keys.map(([k, lb]) => {
      let rows = null;
      try { rows = KS.settleBets(r, k); } catch (e) { logError(`記録の一覧（${r.race_id}）`, e); }
      if (!rows) return [lb + "払戻不明", "wait"];
      if (!rows.length) return [lb + "見送り", "wait"];
      const d = rows.reduce((t, x) => t + x["払戻"] - x["金額"], 0);
      return [`${lb}${d >= 0 ? "+" : ""}${d.toLocaleString("ja-JP")}`, d >= 0 ? "up" : "down"];
    });
    st = el("span", "st " + (parts.length === 1 ? parts[0][1] : "multi"));
    parts.forEach(([t, cls], i) => { if (i) st.append(el("br")); st.append(el("span", cls, t)); });
  }
  it.append(st);
  it.onclick = () => {
    const c = cache[key];
    if (!c) { toast("このレースの収集データは残っていません（記録だけ残っています）"); return; }
    if (state.date !== r["日付"]) { if (!state.homeDate) state.homeDate = state.date; state.date = r["日付"]; }
    state.fromRecords = true;
    showResult(r["競馬場"], { no: r["レース番号"], title: r["レース名"], time: r["発走"] }, c);
  };
  return it;
}

// 自動バックアップの状態と、書き出す・読み込む
function recordsActions() {
  const act = el("div", "end-actions");
  // 自動バックアップの状態
  {
    const b = backupInfo();
    const t = b.at ? (() => { const d = jstOf(b.at); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; })() : null;
    const box = el("div", "backup-line");
    box.append(el("b", null, "自動バックアップ"), el("span", null, t ? `最終 ${t}（${KS.CONFIG.BACKUP_DAYS}日ごと・ダウンロード/keiba-backup に新しい${KS.CONFIG.BACKUP_KEEP}件）` : `まだありません（${KS.CONFIG.BACKUP_DAYS}日ごと・ダウンロード/keiba-backup に新しい${KS.CONFIG.BACKUP_KEEP}件）`));
    if (b.ok === false) box.append(el("span", "warn", `前回は失敗：${b.err || ""}`));
    act.append(box);
    const now = el("button", "btn secondary", "今すぐバックアップ"); now.onclick = () => runBackup(true);
    act.append(now);
  }
  const ex = el("button", "btn secondary", "書き出す（PC版の verify にかける）");
  ex.onclick = () => {
    const d = jstNow(); const z = (n) => String(n).padStart(2, "0");
    Native.exportRecords(JSON.stringify(Object.values(readRecords()), null, 1), `keiba-records-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}.json`);
  };
  act.append(ex);
  const im = el("button", "btn secondary", "読み込む（書き出したファイルから戻す）");
  im.onclick = () => Native.importRecords();
  act.append(im);
  act.append(el("p", "note", "書き出したファイルは、機種変更や入れ直しのあとに「読み込む」で戻せます。PC へ移して run.bat import <ファイル> で取り込むと verify.bat でも集計できます"));
  return act;
}
