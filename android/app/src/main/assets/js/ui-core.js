// 画面の土台：表示テーマ・Kotlin とのやり取り・端末に残す設定・日付・収集済みの記録・即PAT の発売カレンダー・開催一覧・収集の進み具合
// ui.html から順に読み込む（ふつうの <script> なので、上のファイルの const や function はそのまま使える）。
// 読み込む順番に意味がある（ui-core → ui-result → ui-records → ui-settings）。起動時の処理は ui-settings.js の最後
"use strict";
// ===== 表示テーマ（自動・ライト・ダーク）=====
// 保存キーは QC Workbench の各ツールと同じ名前（DESIGN.md 1.5）。アプリ内だけに保存される
const THEME_KEY = "qc-workbench-theme";
const THEMES = ["auto", "light", "dark"];
const THEME_LABEL = { auto: "自動（端末に合わせる）", light: "ライト", dark: "ダーク" };
const THEME_ICON = {
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/></svg>',
};
let themePref = (() => { try { const t = localStorage.getItem(THEME_KEY); return THEMES.includes(t) ? t : "auto"; } catch (e) { return "auto"; } })();
let systemDark = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)").matches : false;
function applyTheme() {
  const dark = themePref === "auto" ? systemDark : themePref === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  if (window.Android && Android.setBarsDark) Android.setBarsDark(dark);
  const b = document.getElementById("themeBtn");
  if (b) { b.innerHTML = THEME_ICON[themePref] + `<span class="lb">${{ auto: "自動", light: "ライト", dark: "ダーク" }[themePref]}</span>`; b.setAttribute("aria-label", `表示：${THEME_LABEL[themePref]}`); }
  document.querySelectorAll("[data-theme-choice]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.themeChoice === themePref)));
}
function setThemePref(t) {
  themePref = t;
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* 保存できなくても切り替えは効く */ }
  applyTheme();
}

// ===== エラーの記録 =====
// 黙って捨てていたエラーを、端末の中に新しい順で ERR_MAX 件まで残す（設定 →「エラーの記録」で見られる。Kotlin 側の分と合わせて出す）
const ERR_KEY = "keiba-errors", ERR_MAX = 100;
function logError(where, e) {
  try {
    const list = JSON.parse(localStorage.getItem(ERR_KEY) || "[]");
    const d = new Date(Date.now() + (540 + new Date().getTimezoneOffset()) * 60000), z = (n) => String(n).padStart(2, "0");
    list.unshift({ at: `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`,
      where: String(where), msg: String((e && (e.stack || e.message)) || e).slice(0, 400) });
    localStorage.setItem(ERR_KEY, JSON.stringify(list.slice(0, ERR_MAX)));
  } catch (x) { /* 記録そのものに失敗したときは何もしない */ }
}
function readErrors() { try { return JSON.parse(localStorage.getItem(ERR_KEY) || "[]"); } catch (e) { return []; } }
window.addEventListener("error", (ev) => logError("画面（捕まえていないエラー）", ev.error || ev.message));
window.addEventListener("unhandledrejection", (ev) => logError("画面（捕まえていない Promise）", ev.reason));

// ===== Kotlin とのやり取り =====
// JS → Kotlin：window.Android（MainActivity の Bridge）
// Kotlin → JS：App.onRaceList / onStep / onLog / onResult / back / setTheme
const Native = window.Android || {
  // ブラウザで開いたとき用のダミー（画面の確認用）
  loadRaceList() {}, collect() {}, cancel() {}, copy() {}, share() {}, setDebug() {},
  setBarsDark() {}, checkUpdate() {}, installUpdate() {}, openUrl() {}, openLive() {},
  appInfo() { return JSON.stringify({ versionCode: 1005, versionName: "0.4.5", commit: "abc1234", builtAt: "2026-10-26 12:30" }); },
  shareTarget() { return "Claude"; }, getReservations() { return "[]"; },
  setReservation(j) { return JSON.stringify({ ok: true, exact: false, notif: true }); }, removeReservation() {},
  takeBackgroundResults() { return "[]"; }, exactAlarmAllowed() { return false; }, openExactAlarmSettings() {},
  notificationsAllowed() { return true; }, requestNotifications() {},
  readClipboard() { return ""; }, clipStamp() { return -1; }, errorLog() { return "[]"; }, clearErrorLog() {}, testNotify() {}, autoBackup() {}, schedulePreCheck() { return false; }, cancelPreCheck() {}, fetchResults() {}, exportRecords() {}, importRecords() {}, scheduleResultCheck() { return "{}"; }, cancelResultCheck() {}, takeRaceResults() { return "[]"; }
};

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

// 収集の段階（Scraper.kt の step キーと同じ）
const STEPS = [
  ["today", "当日の結果", "netkeiba・前のレース"],
  ["shutuba", "出馬表", "netkeiba"],
  ["keibago", "馬柱・過去5走", "keiba.go.jp"],
  ["tanfuku", "単勝・複勝オッズ", "netkeiba"],
  ["wide", "ワイドオッズ", "netkeiba"],
  ["sanren", "三連複オッズ", "netkeiba・上位人気一覧"],
  ["build", "テキストを作成", ""],
];

const state = {
  date: todayStr(), venues: null, venue: null, loading: false,
  screen: "home", job: null, debug: false,
  scrolled: false,      // 次のレースまで自動でスクロールしたか（読み込み・競馬場の切替ごとに1回だけ）
  result: null,         // 表示中の結果 {venue, race, res}
  sort: "no",           // 各馬の並び（no：馬番順、ninki：人気順）
  open: new Set(),      // 詳細を開いている馬番
};

// ===== 端末に残す設定（すべて try で包む。保存できなくても動く） =====
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { logError(`保存（${k}）`, e); } },
};
const FAV_KEY = "keiba-fav-venues", LAST_VENUE_KEY = "keiba-last-venue";
state.venue = store.get(LAST_VENUE_KEY, null);

// ===== 日付 =====
// 発走時刻は日本時間なので、端末を海外の時間帯にしていても日本時間で数える。
// jstNow() は「端末の時刻表示が日本時間になるようにずらした Date」（getHours などで日本時間が読める）
function jstShift() { return (540 + new Date().getTimezoneOffset()) * 60000; }
function jstNow() { return new Date(Date.now() + jstShift()); }
function jstOf(ms) { return new Date(ms + jstShift()); }
function todayStr() { return ymd(jstNow()); }
function ymd(d) { return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`; }
function parseYmd(s) { return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6)); }
function shiftDate(days) { const d = parseYmd(state.date); d.setDate(d.getDate() + days); setDate(ymd(d)); }
function setDate(s) { state.date = s; renderDate(); loadRaceList(); }
function renderDate() {
  const d = parseYmd(state.date), t = todayStr();
  $("dateText").textContent = `${state.date.slice(0, 4)}/${state.date.slice(4, 6)}/${state.date.slice(6)}`;
  $("weekText").textContent = `（${WEEK[d.getDay()]}）`;
  const diff = Math.round((d - parseYmd(t)) / 86400000);
  const tag = $("dateTag");
  tag.textContent = diff === 0 ? "今日" : diff === -1 ? "昨日" : diff === 1 ? "明日" : diff < 0 ? `${-diff}日前` : `${diff}日後`;
  tag.className = "tag" + (diff < 0 ? " past" : "");
  $("dateInput").value = `${state.date.slice(0, 4)}-${state.date.slice(4, 6)}-${state.date.slice(6)}`;
}

// ===== 収集済みの記録（この端末だけに保存。同じレースを何度も取りに行かないため） =====
const CACHE_KEY = "keiba-results";
function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") || {}; } catch (e) { return {}; } }
function writeCache(c) {
  // 新しい順に 40 件まで残す
  const keys = Object.keys(c).sort((a, b) => (c[b].at || "").localeCompare(c[a].at || "")).slice(0, 40);
  const out = {}; for (const k of keys) out[k] = c[k];
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(out)); } catch (e) { logError("収集済みの記録の保存", e); }
}
const cacheKey = (date, venue, no) => `${date}|${venue}|${no}`;

// ===== 即PAT・A-PAT の発売カレンダー =====
// keiba.go.jp の月ごとのカレンダーを、開催一覧を読むときに一緒に読む（6時間以内に読んだ月は読み直さない）
const PAT_KEY = "keiba-pat-calendar";
const PAT_KIND = { apat: "即PAT・A-PAT", pat: "即PATのみ" };
const patMonthOf = (date) => date.slice(0, 6);
function patStore() { return store.get(PAT_KEY, {}); }
function needPat(month) { const c = patStore()[month]; return !c || Date.now() - c.at > 6 * 3600 * 1000; }
state.patFailed = {};  // 読めなかった月
function onPatCalendar(month, data) {
  if (data && data.days) {
    const all = patStore(); all[month] = { at: Date.now(), days: data.days };
    // 新しい3か月分だけ残す
    const keep = Object.keys(all).sort().slice(-3); const out = {}; for (const k of keep) out[k] = all[k];
    store.set(PAT_KEY, out); delete state.patFailed[month];
  } else state.patFailed[month] = true;
  renderVenues();
  if (state.screen === "home" && !state.loading) renderRaces();
  if (state.screen === "result" && state.result) renderResult();
}
// その日・その競馬場の発売状況。status：sold（発売あり）/ none（発売なし）/ unknown（カレンダー未取得）
function patInfo(date, venue) {
  const cal = patStore()[patMonthOf(date)];
  if (!cal) return { status: state.patFailed[patMonthOf(date)] ? "failed" : "unknown" };
  const day = cal.days[String(parseInt(date.slice(6), 10))];
  const v = day && day.venues[venue];
  if (!v) return { status: "none" };
  return { status: "sold", kind: day.kind, time: day.time, v };
}
// そのレースが即PAT で買えるか（true / false / null＝分からない）
function patRace(info, no) {
  if (info.status === "none") return false;
  if (info.status !== "sold") return null;
  if (info.v.all) return true;
  if (info.v.from == null) return null;
  return no >= info.v.from && no <= info.v.to;
}
// 即PAT・A-PAT で地方競馬を買う入口（地方競馬ネット投票）。レースを指定して開く方法は公開されていないので、入口を開くだけ。
// 即PAT・A-PAT はスマホ版のログイン画面をブラウザで開く
const PAT_URL = "https://n.ipat.jra.go.jp/sp/index.cgi";
function openPat() { Native.openUrl(PAT_URL); }
// レース映像は地方競馬ライブの映像専用版（simple.keiba-lv-st.jp/?track=…）をアプリ内で開く。
// 競馬場名は映像専用版の映像プレイヤー（hls_movie_player.js の trackDict）と同じ
const LIVE_TRACK = { "帯広": "obihiro", "帯広(ば)": "obihiro", "ばんえい": "obihiro", "門別": "monbetsu", "盛岡": "morioka", "水沢": "mizusawa",
  "浦和": "urawa", "船橋": "funabashi", "大井": "ooi", "川崎": "kawasaki", "金沢": "kanazawa", "笠松": "kasamatsu",
  "名古屋": "nagoya", "園田": "sonoda", "姫路": "himeji", "高知": "kouchi", "佐賀": "saga" };
function liveTrack(venue) { return LIVE_TRACK[String(venue || "").replace(/\s/g, "")] || ""; }
function openLive(venue) { Native.openLive ? Native.openLive(liveTrack(venue)) : Native.openUrl("https://simple.keiba-lv-st.jp/"); }
const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><path d="M10 9v6l5-3z" fill="currentColor"/></svg>';
const ICON_BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>';
const ICON_PAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 12h8M13 9l3 3-3 3"/></svg>';
/** 「レース映像」の大きなボタン（小窓で開く） */
function liveButton(venue, cls) {
  const b = el("button", `btn secondary live-btn ${cls || ""}`.trim());
  b.innerHTML = ICON_PLAY;
  b.append(document.createTextNode("レース映像"));
  b.setAttribute("aria-label", `${venue || ""}のレース映像を小窓で開く`);
  b.onclick = () => openLive(venue);
  return b;
}
/** 「レース映像」「即PATを開く」の2つのボタン（発売の有無が分からなくても出す） */
function extLinks(venue) {
  const row = el("div", "btn-row ext-row");
  const pat = el("button", "btn secondary"); pat.innerHTML = ICON_PAT; pat.append(document.createTextNode("即PAT"));
  pat.setAttribute("aria-label", "即PAT（地方競馬ネット投票）を開く");
  pat.onclick = openPat;
  row.append(liveButton(venue), pat);
  return row;
}
const patRangeText = (v) => (v.all ? "全R" : v.from != null ? `${v.from}〜${v.to}R` : v.text);

// ===== 開催一覧 =====
function loadRaceList() {
  state.loading = true; state.venues = null; state.scrolled = false; state.listStale = false; state.listDate = state.date;
  renderVenues(); renderRaces();
  const month = patMonthOf(state.date);
  Native.loadRaceList(state.date, needPat(month) ? month : "");
}

// お気に入りの競馬場を先頭に（お気に入りに入れた順）
function orderedVenues() {
  const fav = store.get(FAV_KEY, []);
  const rank = (n) => { const i = fav.indexOf(n); return i < 0 ? 1e3 : i; };
  return (state.venues || []).map((v, i) => [v, i]).sort((a, b) => rank(a[0].name) - rank(b[0].name) || a[1] - b[1]).map((x) => x[0]);
}
function toggleFav(name) {
  const fav = store.get(FAV_KEY, []);
  const i = fav.indexOf(name);
  if (i < 0) fav.push(name); else fav.splice(i, 1);
  store.set(FAV_KEY, fav);
  toast(i < 0 ? `★ ${name} をお気に入りにしました（先頭に表示）` : `${name} をお気に入りから外しました`);
  renderVenues();
}
function selectVenue(name) {
  state.venue = name; state.scrolled = false;
  store.set(LAST_VENUE_KEY, name);
  renderVenues(); renderRaces(); window.scrollTo({ top: 0 });
}

function renderVenues() {
  const nav = $("venues"); nav.replaceChildren();
  if (!state.venues) return;
  const fav = store.get(FAV_KEY, []);
  for (const v of orderedVenues()) {
    const b = el("button", "venue");
    if (fav.includes(v.name)) b.append(el("span", "star", "★"));
    b.append(document.createTextNode(v.name));
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(state.venue === v.name));
    b.append(el("span", null, `${v.races.length}R`));
    const pi = patInfo(state.date, v.name);
    if (pi.status === "sold") b.append(el("span", "pat", pi.v.all ? "PAT" : `PAT ${patRangeText(pi.v)}`));
    onPress(b, () => selectVenue(v.name), () => toggleFav(v.name));
    nav.append(b);
  }
}

// 発走までの分（レース日と "HH:MM" から。発走時刻が無ければ null）
// このレースより前で、発走して2分以上たったいちばん新しいレースの番号（当日の傾向に使う結果をここから前へ読む）。
// 1つもなければ 0、分からなければ -1。次の次のレースを収集するときも、まだ発走していない間のレースは飛ばす
function lastStartedOf(venue, no) {
  if (state.date < todayStr()) return no - 1;
  if (state.date > todayStr()) return 0;
  const v = (state.venues || []).find((x) => x.name === venue);
  if (!v) return -1;
  for (let k = no - 1; k >= 1; k--) {
    const r = v.races.find((x) => +x.no === k);
    const u = r ? untilMin(state.date, r.time) : null;
    if (u != null && u <= -2) return k;
  }
  return 0;
}
function untilMin(date, time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time || "");
  if (!m) return null;
  const d = parseYmd(date); d.setHours(+m[1], +m[2], 0, 0);
  return (d - jstNow()) / 60000;
}
function fmtUntil(min) {
  if (min == null) return "";
  if (min <= 0) return "発走済み";
  const m = Math.ceil(min);
  return m < 60 ? `あと${m}分` : `あと${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}`;
}
// "YYYY-MM-DD HH:MM" を何分前か
function agoMin(at) { const d = new Date((at || "").replace(" ", "T")); return isNaN(d) ? null : (jstNow() - d) / 60000; }

// 長押しの判定（0.5秒）。長押しのあとの click は捨てる
function onPress(node, onTap, onLong) {
  let timer = null, long = false, sx = 0, sy = 0;
  const clear = () => { clearTimeout(timer); timer = null; };
  node.addEventListener("pointerdown", (e) => { long = false; sx = e.clientX; sy = e.clientY; clear(); timer = setTimeout(() => { long = true; onLong(); }, 500); });
  node.addEventListener("pointermove", (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clear(); });
  ["pointerup", "pointercancel", "pointerleave"].forEach((t) => node.addEventListener(t, clear));
  node.addEventListener("contextmenu", (e) => e.preventDefault());
  node.addEventListener("click", (e) => { if (long) { e.preventDefault(); long = false; return; } onTap(e); });
}

function minutesOf(t) { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; }

function renderRaces() {
  const area = $("raceArea"); area.replaceChildren();
  if (state.loading) {
    const list = el("div", "races");
    for (let i = 0; i < 6; i++) list.append(el("div", "skel"));
    area.append(list);
    return;
  }
  if (!state.venues || !state.venues.length) {
    const e = el("div", "empty");
    e.append(el("b", null, state.venues ? "この日の開催はありません" : "開催一覧を読み込めませんでした"));
    e.append(el("span", null, state.venues ? "日付を変えてください" : "通信状態を確認して、もう一度読み込んでください"));
    const retry = el("button", "btn secondary", "もう一度読み込む"); retry.onclick = loadRaceList;
    e.append(el("br")); e.append(retry);
    area.append(e);
    return;
  }
  const v = state.venues.find((x) => x.name === state.venue) || state.venues[0];
  state.venue = v.name;
  const isToday = state.date === todayStr();
  const now = jstNow(), nowMin = now.getHours() * 60 + now.getMinutes();
  let nextIdx = -1;
  if (isToday) nextIdx = v.races.findIndex((r) => { const m = minutesOf(r.time); return m != null && m > nowMin; });
  const cache = readCache();

  const head = el("div", "section-title");
  head.append(el("h2", null, `${v.name}　${v.races.length}レース`));
  head.append(el("p", null, "タップで収集・長押しで通知・自動収集"));
  area.append(head);
  const pnl = dayPnl(state.date);
  if (pnl) {
    const b = el("button", "day-pnl");
    b.append(el("span", null, state.date === todayStr() ? "今日" : "この日"), el("span", null, `記録 ${pnl.n}件・結果 ${pnl.settled}件`));
    const sign = (x) => `${x >= 0 ? "+" : ""}${yen(x)}`;
    // 自分の馬券を入れた日は、自分の収支を先に出す（AI の買い目どおりの場合はその後ろに小さく）
    if (pnl.oSettled) b.append(el("b", pnl.od >= 0 ? "up" : "down", `自分 ${sign(pnl.od)}`));
    if (pnl.oSettled && (pnl.evSettled || pnl.hSettled)) {
      const ai = el("span", "ai-pnl");
      if (pnl.evSettled) ai.append(document.createTextNode(`${pnl.hSettled ? "AI期待値" : "AI"} ${sign(pnl.d)}`));
      if (pnl.hSettled) ai.append(document.createTextNode(`${pnl.evSettled ? "・" : ""}AI的中 ${sign(pnl.hd)}`));
      b.append(ai);
    } else if (pnl.evSettled && pnl.hSettled) {
      b.append(el("b", pnl.d >= 0 ? "up" : "down", `期待値重視 ${sign(pnl.d)}`), el("b", pnl.hd >= 0 ? "up" : "down", `的中重視 ${sign(pnl.hd)}`));
    } else if (pnl.evSettled) b.append(el("b", pnl.d >= 0 ? "up" : "down", sign(pnl.d)));
    else if (pnl.hSettled) b.append(el("b", pnl.hd >= 0 ? "up" : "down", `的中重視 ${sign(pnl.hd)}`));
    b.append(el("span", "go", "記録 ›"));
    b.onclick = showRecords;
    area.append(b);
  }
  const pi = patInfo(state.date, v.name);
  if (pi.status === "sold") {
    const pl = el("p", "pat-line");
    pl.append(el("b", null, `${PAT_KIND[pi.kind]}で発売`), el("span", null, `${patRangeText(pi.v)}${pi.time ? `・${pi.time}` : ""}`));
    area.append(pl);
  } else if (pi.status === "none") {
    area.append(el("p", "pat-line none", `この日の${v.name}は、即PAT・A-PAT での発売はありません`));
  } else if (pi.status === "failed") {
    area.append(el("p", "pat-line none", "即PAT・A-PAT の発売カレンダーを読めませんでした（引っ張って読み直せます）"));
  }
  // 発売カレンダーを読めていなくても、投票とレース映像の入口はいつも出す
  area.append(extLinks(v.name));

  const list = el("div", "races");
  // 発走済みのレース（今日だけ）は畳んで、次のレースをすぐ見えるようにする
  const startedOf = (r) => isToday && minutesOf(r.time) != null && minutesOf(r.time) <= nowMin;
  const nPast = v.races.filter(startedOf).length;
  const fold = nPast >= 2 && !state.showPast;
  if (nPast >= 2) {
    const fb = el("button", "past-fold");
    fb.append(el("span", null, state.showPast ? `発走済み ${nPast}レースを畳む` : `発走済み ${nPast}レース`), el("span", "go", state.showPast ? "▲" : "▼"));
    fb.setAttribute("aria-expanded", String(!!state.showPast));
    fb.onclick = () => { state.showPast = !state.showPast; renderRaces(); };
    list.append(fb);
  }
  v.races.forEach((r, i) => {
    if (fold && startedOf(r)) return;
    const b = el("button", "race");
    const started = startedOf(r);
    if (started) b.classList.add("started");
    if (i === nextIdx) b.classList.add("next");
    const no = el("div", "no", String(r.no)); no.append(el("small", null, "R"));
    const mid = el("div");
    mid.append(el("div", "t", r.title || `${r.no}R`));
    const s = el("div", "s");
    s.append(el("span", "num", r.time || "--:--"));
    if (r.heads) s.append(el("span", null, `${r.heads}頭`));
    mid.append(s);
    // 発走までの時間は別の行に（行の折り返しでカードの高さがばらつかないように）
    const um = isToday ? untilMin(state.date, r.time) : null;
    if (um != null && um > 0) mid.append(el("div", "until" + (um <= 30 ? " soon" : ""), fmtUntil(um)));
    const badges = el("div", "badges");
    const c = cache[cacheKey(state.date, v.name, r.no)];
    if (i === nextIdx) badges.append(el("span", "badge next", "次"));
    else if (started) badges.append(el("span", "badge ended", "発走済み"));
    if (c) badges.append(el("span", "badge done", `✓ 収集済み ${c.at.slice(11, 16)}`));
    // 即PAT は一覧の上に範囲を出しているので、レースには対象外のときだけ出す
    const onPat = patRace(pi, r.no);
    if (onPat === false && pi.status === "sold") badges.append(el("span", "badge nopat", "即PAT対象外"));
    const rv = reservations[cacheKey(state.date, v.name, r.no)];
    if (rv) { const ab = el("span", "badge alarm"); ab.innerHTML = ICON_BELL; ab.append(document.createTextNode(rv.auto ? `自動 ${hhmm(rv.start - rv.auto * 60000)}` : "通知")); badges.append(ab); }
    if (!badges.childElementCount) badges.append(el("span", "chev", "›"));
    b.append(no, mid, badges);
    onPress(b, () => (c ? showResult(v.name, r, c) : startCollect(v.name, r)), () => openReserve(v.name, r));
    list.append(b);
  });
  area.append(list);
  if (nextIdx > 2 && !fold && !state.scrolled) requestAnimationFrame(() => {
    state.scrolled = true;
    // 次のレースの1つ前が上の帯のすぐ下に来るようにする
    const target = list.children[nextIdx - 1];
    const header = document.querySelector("#home .appbar");
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - header.offsetHeight - 8 });
  });
}

// ===== 収集 =====
function raceHead(venue, race) {
  const frag = document.createDocumentFragment();
  const h = el("h2", "race-title");
  h.append(document.createTextNode(`${venue} `));
  h.append(el("span", "num", `${race.no}R`));
  if (race.title) h.append(document.createTextNode(` ${race.title}`));
  frag.append(h);
  const d = parseYmd(state.date);
  frag.append(el("p", "race-sub", `${state.date.slice(0, 4)}/${state.date.slice(4, 6)}/${state.date.slice(6)}（${WEEK[d.getDay()]}）` +
    (race.time ? `　${race.time} 発走` : "") + (race.heads ? `　${race.heads}頭` : "")));
  return frag;
}

function showScreen(name) {
  state.screen = name;
  hideClipOffer();
  $("home").classList.toggle("hidden", name !== "home");
  $("backBtn").textContent = name === "settings" && state.back === "result" ? "‹ 結果に戻る"
    : name === "result" && state.fromRecords ? "‹ 記録に戻る"
    : state.parent === "prefs" && ["settings", "records", "about", "errors", "devtest"].includes(name) ? "‹ 設定" : "‹ レース一覧";
  $("detail").classList.toggle("hidden", name === "home");
  window.scrollTo({ top: 0 });
}

function startCollect(venue, race) {
  // 一覧の読み込み中に収集を始めると、Kotlin 側で一覧の読み込みが止まる。一覧に戻ったときに読み直す
  if (state.loading) state.listStale = true;
  state.job = { venue, race, steps: {}, log: [] };
  showScreen("collect");
  const body = $("detailBody"); body.replaceChildren();
  body.append(raceHead(venue, race));

  const card = el("div", "card");
  const h = el("h3", null, "収集中");
  const pct = el("span", "aside num", "0 / " + STEPS.length); pct.id = "stepCount";
  h.append(pct); card.append(h);
  const bar = el("div", "bar"); const fill = el("i"); fill.id = "barFill"; bar.append(fill); card.append(bar);
  const ul = el("ul", "steps"); ul.id = "steps";
  for (const [key, name, sub] of STEPS) {
    const li = el("li"); li.dataset.key = key; li.dataset.s = "wait";
    li.append(el("span", "ic"));
    const n = el("span", "name", name); if (sub) n.append(el("small", null, sub)); li.append(n);
    li.append(el("span", "det num"));
    ul.append(li);
  }
  card.append(ul);
  body.append(card);
  body.append(el("p", "note", "サイトに負荷をかけないよう、アクセスごとに2秒あけています。1レースで30秒〜1分ほどかかります"));
  const pv = el("button", "btn secondary preview-btn"); pv.id = "previewBtn"; pv.onclick = togglePreview;
  body.append(pv); renderPreviewBtn();

  const log = el("details", "log");
  log.append(el("summary", null, "詳細ログ"));
  const pre = el("pre"); pre.id = "logPre"; log.append(pre);
  body.append(log);

  const actions = el("div", "sticky-actions");
  const cancel = el("button", "btn danger", "中止する");
  cancel.onclick = () => { Native.cancel(); };
  actions.append(cancel);
  body.append(actions);

  Native.collect(venue, state.date, race.no, lastStartedOf(venue, race.no));
}

function setStep(key, s, detail) {
  if (!state.job) return;
  state.job.steps[key] = s;
  const li = document.querySelector(`#steps li[data-key="${key}"]`);
  if (li) {
    li.dataset.s = s;
    li.querySelector(".ic").textContent = { ok: "✓", warn: "!", ng: "×", skip: "–" }[s] || "";
    if (detail != null) li.querySelector(".det").textContent = detail;
  }
  const done = Object.values(state.job.steps).filter((v) => v !== "run").length;
  const fill = $("barFill"); if (fill) fill.style.width = `${Math.round(done / STEPS.length * 100)}%`;
  const cnt = $("stepCount"); if (cnt) cnt.textContent = `${done} / ${STEPS.length}`;
}

function addLog(line) {
  if (!state.job) return;
  state.job.log.push(line);
  const pre = $("logPre"); if (pre) { pre.textContent += (pre.textContent ? "\n" : "") + line; pre.scrollTop = pre.scrollHeight; }
}
