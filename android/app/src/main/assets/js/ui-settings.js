// 予想の条件・ケリー基準・通知と自動収集の予約・設定の画面・日付の操作と起動時の処理
// ui.html から順に読み込む（ふつうの <script> なので、上のファイルの const や function はそのまま使える）。
// 読み込む順番に意味がある（ui-core → ui-result → ui-records → ui-settings）。起動時の処理は ui-settings.js の最後
// ===== 予想の条件（予算・点数・期待値の下限） =====
// AI への指示文に入れる。送る・コピーするときの値で指示文を書き直すので、収集済みのレースにもそのまま効く
const BET_KEY = "keiba-bet-settings";
const BET_LIMITS = { budget: [100, 100000, 100], max_bets: [1, 10, 1], ev_min: [1.0, 3.0, 0.05], hit_min: [10, 80, 5], hit_ev_min: [0.5, 1.5, 0.05] };
function betSettings() {
  const d = (window.KS && KS.DEFAULT_SETTINGS) || { budget: 1000, max_bets: 3, ev_min: 1.2, mode: "both", hit_min: 30, hit_ev_min: 0.9 };
  const v = Object.assign({}, d, store.get(BET_KEY, {}));
  const clamp = (k) => { const [lo, hi] = BET_LIMITS[k]; v[k] = Math.min(hi, Math.max(lo, Number(v[k]) || d[k])); };
  ["budget", "max_bets", "ev_min", "hit_min", "hit_ev_min"].forEach(clamp);
  v.ev_min = Math.round(v.ev_min * 100) / 100;
  v.hit_ev_min = Math.round(v.hit_ev_min * 100) / 100;
  if (!["ev", "hit", "both"].includes(v.mode)) v.mode = d.mode;
  // 1点100円なので、点数は予算で買える数まで
  v.max_bets = Math.min(v.max_bets, Math.floor(v.budget / 100));
  return v;
}
// 指示文（設定画面で書き換えたもの。未設定なら既定の指示文）
const PROMPT_KEY = "keiba-prompt";
function promptTemplate() { const t = store.get(PROMPT_KEY, null); return t && t.trim() ? t : null; }
const fmtEv = (v) => (window.KS ? KS.fmtEv(v) : String(v));
const yen = (n) => `${Number(n).toLocaleString("ja-JP")}円`;
function betSummary(b) {
  const ev = `期待値 ${fmtEv(b.ev_min)} 以上`, hit = `的中率 ${b.hit_min}%以上・期待値 ${fmtEv(b.hit_ev_min)} 以上`;
  if (b.mode === "both") return `期待値重視と的中重視の両方（それぞれ予算 ${yen(b.budget)}・最大${b.max_bets}点）`;
  return `予算 ${yen(b.budget)}・最大${b.max_bets}点・${b.mode === "ev" ? `期待値重視（${ev}）` : `的中重視（${hit}）`}`;
}
// 送る・コピー・表示するテキスト（指示文を今の条件で書き直したもの）
function textFor(res) {
  if (!window.KS) return res.text;
  let t = KS.withSettings(res.text, Object.assign({}, betSettings(), { template: promptTemplate() }));
  if (res.diff) {
    const block = KS.formatDiff(res.diff.items, res.diff.prevAt);
    const j = t.indexOf("【AIへの指示】");
    const head = j >= 0 ? t.slice(0, j) : t;
    const i = head.indexOf("【データの欠損】") >= 0 ? head.indexOf("【データの欠損】") : j;
    if (i >= 0) t = t.slice(0, i) + block + "\n\n" + t.slice(i);
  }
  return t;
}

function showSettings() {
  closeMenu();
  showScreen("settings");
  renderSettings();
}
function renderSettings() {
  const b = betSettings();
  const body = $("detailBody"); body.replaceChildren();
  body.append(el("h2", "race-title", "予想の条件と指示文"));
  body.append(el("p", "race-sub", "AI への指示文に入れる条件です。収集済みのレースにも、次に送るときから効きます"));

  const card = el("div", "card");
  const save = (k, v) => { const cur = store.get(BET_KEY, {}); cur[k] = v; store.set(BET_KEY, cur); renderSettings(); };

  // 買い方
  const f0 = el("div", "field");
  f0.append(el("label", null, "買い方"), el("p", "hint", "両方にすると、1回の回答で2通りの買い目を出させ、別々に記録・答え合わせします"));
  const seg = el("div", "seg3 wide");
  for (const [m, label] of [["ev", "期待値重視"], ["hit", "的中重視"], ["both", "両方"]]) {
    const x = el("button", b.mode === m ? "on" : null, label); x.onclick = () => save("mode", m); seg.append(x);
  }
  f0.append(seg);
  card.append(f0);

  // 予算
  const f1 = el("div", "field");
  f1.append(el("label", null, "予算"), el("p", "hint", b.mode === "both" ? "1レースで使う金額（期待値重視・的中重視それぞれに）。1点は100円単位" : "1レースで使う金額。1点は100円単位"));
  f1.append(stepper(yen(b.budget), b.budget <= 100, b.budget >= 100000,
    () => save("budget", b.budget - (b.budget > 3000 ? 500 : 100)), () => save("budget", b.budget + (b.budget >= 3000 ? 500 : 100))));
  const picks1 = el("div", "chips-pick");
  for (const v of [500, 1000, 2000, 3000, 5000, 10000]) {
    const x = el("button", null, yen(v)); x.setAttribute("aria-pressed", String(b.budget === v)); x.onclick = () => save("budget", v); picks1.append(x);
  }
  f1.append(picks1);
  card.append(f1);

  // 点数
  const f2 = el("div", "field");
  f2.append(el("label", null, "最大点数"), el("p", "hint", b.mode === "ev" ? "買い目の数の上限。期待値の高い順にこの点数まで選びます"
    : b.mode === "hit" ? "買い目の数の上限。推定的中率の高い順にこの点数まで選びます" : "買い目の数の上限（期待値重視・的中重視それぞれに）"));
  const maxByBudget = Math.min(10, Math.floor(b.budget / 100));
  f2.append(stepper(`${b.max_bets}点`, b.max_bets <= 1, b.max_bets >= maxByBudget,
    () => save("max_bets", b.max_bets - 1), () => save("max_bets", b.max_bets + 1)));
  if (maxByBudget < 10) f2.append(el("p", "note", `予算 ${yen(b.budget)} では ${maxByBudget}点まで（1点100円）`));
  card.append(f2);

  // 期待値の下限
  const f3 = el("div", "field");
  f3.append(el("label", null, b.mode === "both" ? "期待値重視：期待値の下限" : "期待値の下限"), el("p", "hint", "これ未満の買い目は選ばず、無ければ「見送り」にします"));
  f3.append(stepper(fmtEv(b.ev_min), b.ev_min <= 1.0, b.ev_min >= 3.0,
    () => save("ev_min", Math.round((b.ev_min - 0.05) * 100) / 100), () => save("ev_min", Math.round((b.ev_min + 0.05) * 100) / 100)));
  const picks3 = el("div", "chips-pick");
  for (const v of [1.0, 1.1, 1.2, 1.3, 1.5]) {
    const x = el("button", null, fmtEv(v)); x.setAttribute("aria-pressed", String(b.ev_min === v)); x.onclick = () => save("ev_min", v); picks3.append(x);
  }
  f3.append(picks3);
  f3.append(el("p", "note small", "1.0 は「賭けた額が平均で戻る」水準です。単勝・複勝の控除率はおよそ20〜25%なので、市場より大きく高い確率を見積もらないと 1.0 を超えません。推定の上振れを拾いやすいため、既定は 1.2 にしています"));
  if (b.mode !== "hit") card.append(f3);
  if (b.mode !== "ev") {
    const f4 = el("div", "field");
    f4.append(el("label", null, "的中重視：推定的中率の下限"), el("p", "hint", "これ以上当たりそうな買い目だけから選びます"));
    f4.append(stepper(`${b.hit_min}%`, b.hit_min <= 10, b.hit_min >= 80, () => save("hit_min", b.hit_min - 5), () => save("hit_min", b.hit_min + 5)));
    card.append(f4);
    const f5 = el("div", "field");
    f5.append(el("label", null, "的中重視：期待値の下限"), el("p", "hint", "1.0 未満にすると、平均では損をすると分かっていて買うことになります"));
    f5.append(stepper(fmtEv(b.hit_ev_min), b.hit_ev_min <= 0.5, b.hit_ev_min >= 1.5,
      () => save("hit_ev_min", Math.round((b.hit_ev_min - 0.05) * 100) / 100), () => save("hit_ev_min", Math.round((b.hit_ev_min + 0.05) * 100) / 100)));
    card.append(f5);
  }
  body.append(card);

  // 賭け金の目安（ケリー基準）：AI の予想欄に、買い目ごとの金額の目安を出す
  const kc = el("div", "card");
  kc.append(el("h3", null, "賭け金の目安（ケリー基準）"));
  const k = kellySettings();
  kc.append(el("p", "note", "AI の推定的中率とオッズから、資金を長く増やすのに最適な賭け金の割合（ケリー基準）を出し、その一部だけ賭けた金額を AI の予想欄に並べます。推定がずれていると賭けすぎになるので、1/4 以下をおすすめします"));
  const kf1 = el("div", "field");
  kf1.append(el("label", null, "ケリーの何分の1を賭けるか"));
  const kseg = el("div", "seg3 wide");
  for (const [v, label] of [[0, "なし"], [0.125, "1/8"], [0.25, "1/4"], [0.5, "1/2"]]) {
    const x = el("button", k.frac === v ? "on" : null, label); x.onclick = () => saveKelly("frac", v); kseg.append(x);
  }
  kf1.append(kseg); kc.append(kf1);
  if (k.frac > 0) {
    const kf2 = el("div", "field");
    kf2.append(el("label", null, "資金"), el("p", "hint", "競馬に使ってよいお金の総額。賭け金の目安はこの額に対する割合から出します"));
    const stepK = k.bankroll >= 100000 ? 10000 : k.bankroll >= 20000 ? 5000 : 1000;
    kf2.append(stepper(yen(k.bankroll), k.bankroll <= 1000, k.bankroll >= 10000000,
      () => saveKelly("bankroll", Math.max(1000, k.bankroll - stepK)), () => saveKelly("bankroll", k.bankroll + stepK)));
    const kp = el("div", "chips-pick");
    for (const v of [10000, 30000, 50000, 100000, 300000]) {
      const x = el("button", null, yen(v)); x.setAttribute("aria-pressed", String(k.bankroll === v)); x.onclick = () => saveKelly("bankroll", v); kp.append(x);
    }
    kf2.append(kp); kc.append(kf2);
  }
  body.append(kc);
  function saveKelly(key, v) { const cur = store.get(KELLY_KEY, {}); cur[key] = v; store.set(KELLY_KEY, cur); renderSettings(); }

  // 指示文のうち条件が入る行
  const pc = el("div", "card");
  pc.append(el("h3", null, "指示文に入る文"));
  const lines = (window.KS ? KS.promptText(Object.assign({}, b, { template: promptTemplate() })) : "").split("\n").filter((l) => /\d+円|期待値|的中重視/.test(l)).slice(0, 6);
  pc.append(el("pre", "prompt-preview", lines.join("\n")));
  body.append(pc);

  // 指示文の編集
  const tc = el("div", "card");
  const th = el("h3", null, "指示文");
  if (promptTemplate()) th.append(el("span", "badge mod", "書き換え中"));
  tc.append(th);
  tc.append(el("p", "note", "AI への指示文を書き換えられます。{GOAL}・{BET_STEP}・{BET_OUTPUT}・{BLOCK_NOTE}・{BET_BLOCK} は上の買い方の文に、{BUDGET}・{MAX_BETS}・{EV_MIN}・{HIT_MIN}・{HIT_EV_MIN} は上の条件に置き換わります。記録と答え合わせを使うなら、最後の記録用ブロック（{BET_BLOCK}）の指示は残してください"));
  const ta = el("textarea", "prompt-edit");
  ta.value = (promptTemplate() || KS.PROMPT_TEXT).trim();
  ta.spellcheck = false;
  tc.append(ta);
  const prow = el("div", "btn-row"); prow.style.marginTop = "8px";
  const psave = el("button", "btn secondary", "指示文を保存");
  psave.onclick = () => {
    let t = ta.value.trim();
    if (!t.startsWith("【AIへの指示】")) t = "【AIへの指示】\n" + t;  // 見出しは書き直しの目印なので必ず付ける
    if (t.trim() === KS.PROMPT_TEXT.trim()) { store.set(PROMPT_KEY, null); toast("既定の指示文と同じなので、既定に戻しました"); renderSettings(); return; }
    store.set(PROMPT_KEY, t);
    toast(t.includes("#PRED") ? "指示文を保存しました" : "保存しました（#PRED の指示が無いので、記録は読めません）");
    renderSettings();
  };
  const preset = el("button", "btn quiet", "既定の指示文に戻す");
  preset.onclick = () => { if (preset.dataset.armed) { store.set(PROMPT_KEY, null); toast("既定の指示文に戻しました"); renderSettings(); } else { preset.dataset.armed = "1"; preset.textContent = "もう一度押すと戻します"; } };
  prow.append(psave, preset); tc.append(prow);
  body.append(tc);

  const reset = el("button", "btn quiet", "条件をすべて既定値に戻す");
  reset.style.width = "100%"; reset.style.marginTop = "12px";
  reset.onclick = () => { store.set(BET_KEY, {}); renderSettings(); toast("既定値に戻しました"); };
  body.append(reset);
  body.append(el("p", "note", "既定値は、買い方：両方・予算 1,000円・最大3点・期待値 1.2・的中重視の推定的中率 30%以上・的中重視の期待値 0.9 です（PC版の BET_MODE・BUDGET・MAX_BETS・EV_MIN・HIT_MIN・HIT_EV_MIN と同じ）。指示文の書き換えは戻りません"));
}
// ===== 賭け金の目安（ケリー基準） =====
// 1点だけ買うときの最適な割合 f = (p×o − 1) ÷ (o − 1)（p=的中率、o=オッズ。複勝・ワイドは下限）。
// その frac 倍を資金に掛け、100円単位に切り捨てる。同時に何点も買うときは本来もっと小さくなるので、合計も並べる
const KELLY_KEY = "keiba-kelly";
const KELLY_DEFAULT = { frac: 0.25, bankroll: 30000 };
function kellySettings() {
  const k = Object.assign({}, KELLY_DEFAULT, store.get(KELLY_KEY, {}));
  if (![0, 0.125, 0.25, 0.5].includes(k.frac)) k.frac = KELLY_DEFAULT.frac;
  if (!(k.bankroll >= 1000)) k.bankroll = KELLY_DEFAULT.bankroll;
  return k;
}
function kellyAmount(p, odds) {
  const k = kellySettings();
  if (!(k.frac > 0) || p == null || !(odds > 1)) return null;
  const f = (p * odds - 1) / (odds - 1);
  if (f <= 0) return 0;
  return Math.floor(k.bankroll * k.frac * f / 100) * 100;
}
function kellyLabel() { const k = kellySettings(); return { 0.125: "1/8", 0.25: "1/4", 0.5: "1/2" }[k.frac] || ""; }

function stepper(label, minDisabled, maxDisabled, dec, inc) {
  const w = el("div", "stepper");
  const m = el("button", null, "−"); m.disabled = minDisabled; m.onclick = dec; m.setAttribute("aria-label", "減らす");
  const v = el("div", "val", label);
  const p = el("button", null, "+"); p.disabled = maxDisabled; p.onclick = inc; p.setAttribute("aria-label", "増やす");
  w.append(m, v, p);
  return w;
}

// ===== 通知・自動収集の予約 =====
// Kotlin 側（Reservations）が持つ予約の写し。キーは cacheKey と同じ
let reservations = {};
function loadReservations() {
  try { reservations = {}; for (const r of JSON.parse(Native.getReservations() || "[]")) reservations[r.key] = r; } catch (e) { reservations = {}; }
}
function hhmm(ms) { const d = jstOf(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }

const NOTIFY_KINDS = [
  ["weight", "馬体重の発表ごろ", 110, "発走の約1時間50分前"],
  ["m20", "発走20分前", 20, ""],
  ["m5", "発走5分前", 5, ""],
];
const AUTO_CHOICES = [0, 30, 20, 10];

function openReserve(venue, race) {
  const time = race.time;
  const um = untilMin(state.date, time);
  if (um == null) { toast("発走時刻が分からないため設定できません"); return; }
  if (um <= 0) { toast("発走済みのレースです"); return; }
  const start = Date.now() + um * 60000;
  const key = cacheKey(state.date, venue, race.no);
  const cur = reservations[key] || { notify: [], auto: 0 };
  const sh = $("sheet"); sh.replaceChildren();
  sh.append(el("div", "grip"));
  sh.append(el("h3", null, `${venue} ${race.no}R ${race.title || ""}`));
  sh.append(el("p", "sub", `${time} 発走（${fmtUntil(um)}）`));

  sh.append(el("h4", null, "通知"));
  const checks = {};
  for (const [k, label, before, note] of NOTIFY_KINDS) {
    const at = start - before * 60000;
    const past = at <= Date.now();
    const o = el("label", "opt" + (past ? " disabled" : ""));
    const cb = el("input"); cb.type = "checkbox"; cb.checked = !past && cur.notify.includes(k); cb.disabled = past;
    checks[k] = cb;
    const t = el("span", "t", label); t.append(el("small", null, `${hhmm(at)}${note ? `・${note}` : ""}${past ? "（過ぎています）" : ""}`));
    o.append(cb, t); sh.append(o);
  }

  sh.append(el("h4", null, "自動収集（その時刻に1回だけ収集して通知）"));
  const name = "auto-" + Date.now();
  let autoSel = cur.auto || 0;
  for (const m of AUTO_CHOICES) {
    const at = start - m * 60000;
    const past = m > 0 && at <= Date.now();
    const o = el("label", "opt" + (past ? " disabled" : ""));
    const rb = el("input"); rb.type = "radio"; rb.name = name; rb.checked = autoSel === m && !past; rb.disabled = past;
    rb.onchange = () => { autoSel = m; renderExactNote(); };
    const t = el("span", "t", m ? `発走${m}分前` : "しない");
    if (m) t.append(el("small", null, `${hhmm(at)}${past ? "（過ぎています）" : ""}`));
    o.append(rb, t); sh.append(o);
  }
  const exactBox = el("div"); sh.append(exactBox);
  function renderExactNote() {
    exactBox.replaceChildren();
    let ok = true; try { ok = Native.exactAlarmAllowed(); } catch (e) {}
    if (autoSel && !ok) {
      exactBox.append(el("p", "note", "「アラームとリマインダー」が許可されていないため、時刻になったら通知だけ出します（通知をタップすると収集します）。自動で収集させるには許可してください"));
      const b = el("button", "btn secondary preview-btn", "許可の設定を開く"); b.onclick = () => Native.openExactAlarmSettings(); exactBox.append(b);
    }
  }
  renderExactNote();

  const act = el("div", "end-actions");
  const save = el("button", "btn primary", "保存");
  save.onclick = () => {
    const notify = Object.keys(checks).filter((k) => checks[k].checked);
    if (!notify.length && !autoSel) { removeReserve(key); closeSheet(); return; }
    let notifOk = true; try { notifOk = Native.notificationsAllowed(); } catch (e) {}
    if (!notifOk) Native.requestNotifications();
    const res = JSON.parse(Native.setReservation(JSON.stringify({ key, date: state.date, venue, no: race.no, title: race.title || "", time, start: Math.round(start), notify, auto: autoSel })) || "{}");
    loadReservations(); closeSheet(); renderRaces();
    toast(res.ok ? (autoSel && !res.exact ? "保存しました（自動収集は通知で知らせます）" : "保存しました") : "保存できませんでした");
  };
  act.append(save);
  if (reservations[key]) {
    const del = el("button", "btn quiet", "予約を消す"); del.onclick = () => { removeReserve(key); closeSheet(); }; act.append(del);
  }
  sh.append(act);
  $("sheet").classList.remove("hidden"); $("sheetScrim").classList.remove("hidden");
}
function removeReserve(key) { Native.removeReservation(key); loadReservations(); renderRaces(); toast("予約を消しました"); }
function closeSheet() { $("sheet").classList.add("hidden"); $("sheetScrim").classList.add("hidden"); }
$("sheetScrim").onclick = closeSheet;

// 通知から開いたとき（Kotlin から呼ばれる）
function openFromNotification(p) {
  if (!p || !p.r) return;
  const r = p.r;
  closeSheet(); closeMenu();
  if (state.screen === "collect" && state.job) { Native.cancel(); state.job = null; }
  state.parent = null; state.fromRecords = false; state.back = null;
  // 答え合わせの通知：予想の記録を開く（取れていなければその場で取りに行く）
  if (p.type === "records" || p.type === "fetch") {
    mergeRaceResults();
    showRecords();
    const rec = readRecords()[r.key];
    if (p.type === "fetch" && rec && !rec["結果"]) fetchResults([r.key]);
    return;
  }
  state.homeDate = null;
  if (state.date !== r.date) { state.date = r.date; renderDate(); loadRaceList(); }
  state.venue = r.venue;
  const race = { no: r.no, title: r.title, time: r.time };
  const c = readCache()[r.key];
  if (p.type === "collect" && !c) { startCollect(r.venue, race); return; }
  if (c) { showResult(r.venue, race, c); return; }
  goHome(); renderVenues();
}

// 自動収集の結果を収集済みの記録へ取り込む
function mergeBackgroundResults() {
  let list = [];
  try { list = JSON.parse(Native.takeBackgroundResults() || "[]"); } catch (e) {}
  if (!list.length) return;
  const c = readCache();
  for (const x of list) {
    const prev = c[x.key];
    const diff = prev && prev.info ? { prevAt: prev.at.slice(11, 16), items: KS.diffRaces(prev.info, x.info) } : null;
    c[x.key] = { at: x.at, text: x.text, info: x.info, diff, result: (prev && prev.result) || null };
  }
  writeCache(c);
}

function goHome() {
  state.job = null; state.result = null; state.fromRecords = false; state.parent = null;
  // 記録から別の日のレースを開いていたら、一覧の日付に戻す
  if (state.homeDate) { state.date = state.homeDate; state.homeDate = null; renderDate(); }
  showScreen("home");
  if (state.listStale || state.listDate !== state.date) loadRaceList(); else renderRaces();
}

function toast(msg) {
  const t = $("toast"); t.textContent = msg;
  // 結果画面は下に固定のボタンがあるので、その上に出す
  t.classList.toggle("over-bar", state.screen === "result" && !!document.querySelector(".send-bar"));
  t.classList.add("show");
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove("show"), 1600);
}

// ===== メニュー =====
// 以前のメニューの名残（呼ぶところが残っていても動くように）
function closeMenu() { $("scrim").classList.add("hidden"); }
$("scrim").onclick = closeMenu;
$("prefsBtn").onclick = showPrefs;
$("recordsTop").onclick = () => { state.parent = null; showRecords(); };
// 収集用の WebView が開いているページを画面の下半分に出す（読み取れないときの確認用）
function togglePreview() { setPreview(!state.debug); }
function setPreview(on) {
  if (state.debug === on) return;
  state.debug = on; Native.setDebug(on); renderPreviewBtn();
}
function renderPreviewBtn() {
  if (state.screen === "prefs") renderPrefs();
  $("previewBar").classList.toggle("hidden", !state.debug);
  document.body.classList.toggle("previewing", state.debug);
  const b = $("previewBtn"); if (b) b.textContent = state.debug ? "サイトのプレビューを閉じる" : "取得中のサイトをプレビュー";
}
$("previewClose").onclick = () => setPreview(false);
$("updateBar").onclick = showAbout;
$("themeBtn").onclick = () => {
  const next = THEMES[(THEMES.indexOf(themePref) + 1) % THEMES.length];
  setThemePref(next); toast(`表示：${THEME_LABEL[next]}`);
};

// ===== 設定の画面（トップの歯車から） =====
function showPrefs() { state.parent = null; state.back = null; showScreen("prefs"); renderPrefs(); }
function renderPrefs() {
  const body = $("detailBody"); body.replaceChildren();
  body.append(el("h2", "race-title", "設定"));
  const group = (title) => { body.append(el("p", "pref-group", title)); const l = el("div", "pref-list"); body.append(l); return l; };
  const row = (list, title, sub, right, onClick, cls) => {
    const r = el(onClick ? "button" : "div", "pref-row" + (cls ? " " + cls : ""));
    const tx = el("div", "tx"); tx.append(el("b", null, title)); if (sub) tx.append(el("small", null, sub));
    r.append(tx);
    if (right) r.append(right);
    if (onClick) { r.append(el("span", "chev", "›")); r.onclick = onClick; }
    list.append(r); return r;
  };
  const sub = (fn) => () => { state.parent = "prefs"; fn(); };

  // 予想
  const g1 = group("予想");
  row(g1, "予想の条件と指示文", betSummary(betSettings()) + (promptTemplate() ? "・指示文を書き換え中" : ""), null, sub(() => { state.back = null; showSettings(); }));
  const n = pendingResults().length;
  row(g1, "予想の記録と答え合わせ", `記録 ${Object.keys(readRecords()).length}件`, n ? el("span", "val warn", `結果待ち ${n}`) : null, sub(showRecords));

  // 表示
  const g2 = group("表示");
  const seg = el("div", "seg3");
  for (const t of THEMES) {
    const b = el("button", themePref === t ? "on" : null, { auto: "自動", light: "ライト", dark: "ダーク" }[t]);
    b.onclick = () => { setThemePref(t); renderPrefs(); };
    seg.append(b);
  }
  row(g2, "画面の色", "自動は端末に合わせる", seg);

  // 通知・自動収集
  const g3 = group("通知・自動収集");
  let exact = true; try { exact = Native.exactAlarmAllowed(); } catch (e) {}
  row(g3, "アラームとリマインダー", exact ? "許可済み。アプリを閉じていても、時刻どおりに自動収集・答え合わせをします"
    : "未許可。時刻になったら通知だけを出します（タップで収集・答え合わせ）",
    el("span", "val" + (exact ? "" : " warn"), exact ? "許可済み" : "未許可"),
    exact ? null : () => { try { Native.openExactAlarmSettings(); } catch (e) {} });

  // 取れないとき
  const g4 = group("取れないとき");
  const sw = el("span", "switch" + (state.debug ? " on" : ""));
  const pvRow = el("button", "pref-row");
  { const tx = el("div", "tx"); tx.append(el("b", null, "取得中のサイトをプレビュー"), el("small", null, "裏で開いているページを下半分に表示")); pvRow.append(tx, sw); }
  pvRow.onclick = () => togglePreview(); pvRow.setAttribute("aria-pressed", String(!!state.debug));
  g4.append(pvRow);
  const clr = row(g4, "収集済みのレースを消す", "予想の記録は残ります", null, () => {
    if (!clr.dataset.armed) { clr.dataset.armed = "1"; clr.querySelector("b").textContent = "もう一度押すと消します"; return; }
    try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
    toast("収集済みのレースを消しました（予想の記録は残ります）"); renderPrefs();
  }, "danger");

  // アプリ
  const g5 = group("アプリ");
  row(g5, "更新・このアプリについて", `v${current.versionName}`,
    hasUpdate() ? el("span", "val warn", `v${upd.latest.versionName} があります`) : null, sub(showAbout));
}

// ===== 日付の操作 =====
$("prevDay").onclick = () => shiftDate(-1);
$("nextDay").onclick = () => shiftDate(1);
$("dateInput").onchange = (e) => { const v = e.target.value; if (v) setDate(v.replace(/-/g, "")); };
$("dateInput").onclick = (e) => { try { e.target.showPicker(); } catch (err) { /* 未対応なら標準の動き */ } };
$("backBtn").onclick = () => App.back();

// 日付が変わったとき：今日を見ていたなら新しい今日へ移る（それ以外は「今日」などの表示だけ直す）
let openedOn = todayStr();
function followToday() {
  const t = todayStr();
  if (t === openedOn) return;
  const wasToday = state.date === openedOn;
  openedOn = t;
  if (wasToday && state.screen === "home") setDate(t); else renderDate();
}
// 一覧の残り時間・結果画面の経過時間を30秒ごとに更新する
setInterval(() => {
  followToday();
  if (state.screen === "home" && !state.loading && state.date === todayStr()) renderRaces();
  if (state.screen === "result") updateTimeLine();
}, 30000);

// 一覧のいちばん上で下へ引っ張ると、開催一覧を読み直す
(() => {
  let y0 = null, dy = 0;
  const ptr = $("ptr"), txt = $("ptrText");
  window.addEventListener("touchstart", (e) => {
    y0 = state.screen === "home" && !state.loading && window.scrollY <= 0 && $("sheet").classList.contains("hidden") ? e.touches[0].clientY : null; dy = 0;
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    const h = Math.min(dy * 0.5, 72);
    ptr.classList.add("dragging"); ptr.style.height = `${h}px`;
    txt.textContent = h >= 56 ? "↑ 離すと読み直します" : "↓ 引っ張って読み直す";
  }, { passive: true });
  window.addEventListener("touchend", () => {
    if (y0 == null) return;
    ptr.classList.remove("dragging"); ptr.style.height = "0";
    if (Math.min(dy * 0.5, 72) >= 56) {
      // 引っ張ったときは発売カレンダーも読み直す
      const all = patStore(); delete all[patMonthOf(state.date)]; store.set(PAT_KEY, all);
      loadRaceList(); toast("開催一覧と即PATの発売を読み直しています");
    }
    y0 = null; dy = 0;
  });
})();

renderDate();
applyTheme();
mergeBackgroundResults();
mergeRaceResults();
loadReservations();
renderUpdateUi();
updateRecBadge();
if (window.Android) {
  loadRaceList();
  // 起動時の更新確認は6時間に1回まで（お知らせ帯に出すだけで、勝手には更新しない）
  if (!upd.at || Date.now() - new Date(upd.at) > 6 * 3600 * 1000) setTimeout(checkUpdate, 1500);
}
