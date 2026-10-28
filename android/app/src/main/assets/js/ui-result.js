// 結果画面：出走馬・走破タイム・送るテキスト・見出しのナビ・Kotlin から呼ばれる App・AI の回答の読み込み・版情報と更新
// ui.html から順に読み込む（ふつうの <script> なので、上のファイルの const や function はそのまま使える）。
// 読み込む順番に意味がある（ui-core → ui-result → ui-records → ui-settings）。起動時の処理は ui-settings.js の最後
// ===== 結果 =====
const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>';

function shareLabel() { try { return Native.shareTarget() || ""; } catch (e) { return ""; } }

function showResult(venue, race, res, fresh) {
  state.job = null;
  if (!state.result || state.result.res !== res) state.open = new Set();
  state.result = { venue, race, res, fresh };
  showScreen("result");
  renderResult();
}

function renderResult() {
  const { venue, race, res, fresh } = state.result;
  const body = $("detailBody"); body.replaceChildren();
  const info = res.info;
  const r = { ...race, title: info.race_name || race.title, time: info.start || race.time, heads: info.heads || race.heads };
  body.append(raceHead(venue, r));

  const chips = el("div", "chips");
  for (const c of [info.course, info.cond && `馬場 ${info.cond}`, info.cls]) if (c) chips.append(el("span", "chip", c));
  const pi = patInfo(state.date, venue), onPat = patRace(pi, +race.no);
  if (onPat === true) chips.append(el("span", "chip pat", `${PAT_KIND[pi.kind]}で発売`));
  else if (onPat === false) chips.append(el("span", "chip", "即PAT・A-PAT は発売なし"));
  body.append(chips);

  // 発走までの時間と、オッズを取ってからの時間
  const tl = el("p", "time-line"); tl.id = "timeLine"; body.append(tl);
  const row = el("div", "btn-row");
  const again = el("button", "btn secondary"); again.id = "againBtn";
  again.onclick = () => startCollect(venue, race);
  const alarm = el("button", "btn secondary"); alarm.innerHTML = ICON_BELL; alarm.append(document.createTextNode("通知・自動"));
  alarm.onclick = () => openReserve(venue, r);
  row.append(again, alarm);
  body.append(row);
  // レース映像は画面の上の方に大きく出す（小窓で開くので、見ながらこの画面を操作できる）
  const lv = liveButton(venue, "wide"); lv.append(el("small", null, "小窓で開きます"));
  body.append(lv);
  updateTimeLine();
  const resBox = el("div", "sec-box"); resBox.id = "sec-res";
  const infoBox = el("div", "sec-box");
  let speedCard = null;
  // 発走したら、結果ページを読んで着順と払戻を出す（記録があればそのまま答え合わせする）
  {
    const umNow = untilMin(state.date, res.info.start || race.time);
    const rk = cacheKey(state.date, venue, race.no);
    const recNow = readRecords()[rk];
    const got = (recNow && recNow["結果"]) || res.result || null;
    if (umNow != null && umNow <= 0) {
      const fb = el("button", "btn " + (got ? "secondary" : "primary") + " result-btn",
        state.fetching ? "結果を取得中…" : got ? "レース結果を取り直す" : "レース結果を取得");
      fb.disabled = !!state.fetching;
      fb.onclick = () => fetchRaceResult(venue, race);
      resBox.append(fb);
      if (!got && umNow > -10) resBox.append(el("p", "note", "結果は確定してから（発走の10〜15分後ごろ）取れます"));
    }
    if (got) resBox.append(resultCard(got, res.info));
  }
  const cond = el("button", "cond-line");
  cond.append(el("span", null, "AI への条件"), el("b", null, betSummary(betSettings()) + (promptTemplate() ? "・指示文は書き換え中" : "")), el("span", "go", "変更 ›"));
  cond.onclick = () => { state.back = "result"; showSettings(); };
  // AI の回答を記録したあとは、条件が「AI の予想」欄に出るので、記録する前（送る前の確認）だけ出す
  if (!(readRecords()[cacheKey(state.date, venue, race.no)] || {})["AI"]) infoBox.append(cond);

  // オッズの動き（取り直したとき）
  if (res.info.predicted) {
    const pc = el("div", "card warn-card");
    pc.append(el("h3", null, "発売前：単勝は予想オッズです"));
    pc.append(el("p", null, "netkeiba の AI が戦績から出した予想で、実際の投票ではありません。市場勝率・期待値は参考値です。発売が始まったら「オッズを更新」で取り直してください（複勝・ワイド・三連複のオッズも発売後に取れます）"));
    infoBox.append(pc);
  }
  if (res.diff) {
    const dc = el("div", "card diff-card");
    dc.append(el("h3", null, `前回（${res.diff.prevAt}）からの変化`));
    if (!res.diff.items.length) dc.append(el("p", "note", "単勝10%以上の動き・取消・騎手変更・馬体重の発表はありません"));
    else {
      const ul = el("ul", "diff-list");
      for (const it of res.diff.items) {
        const li = el("li"); li.append(el("b", null, `${it.no} ${it.name}　`));
        it.changes.forEach((c, i) => { if (i) li.append(document.createTextNode("／")); li.append(el("span", c.kind === "odds" ? (c.down ? "dn" : "upc") : null, c.text)); });
        ul.append(li);
      }
      dc.append(ul);
      dc.append(el("p", "note", "↓は売れて下がった、↑は上がった。この変化は AI へ送るテキストにも入ります"));
    }
    infoBox.append(dc);
  }
  // オッズの注記（複勝の大口投票の疑い）
  if (info.odds_notes && info.odds_notes.length) {
    const nc = el("div", "card note-card"); nc.append(el("h3", null, "オッズの注記"));
    const ul = el("ul"); for (const n of info.odds_notes) ul.append(el("li", null, n)); nc.append(ul);
    nc.append(el("p", "note", "AI へ送るテキストにも入っています"));
    infoBox.append(nc);
  }

  // 欠損（1行に畳む）
  if (info.warnings.length) {
    const w = el("details", "card warn-card"); keepOpen(w, "warn");
    const sm = el("summary");
    sm.append(el("span", null, `! 欠損 ${info.warnings.length}件`), el("span", "first", info.warnings[0]));
    w.append(sm);
    const ul = el("ul"); for (const x of info.warnings) ul.append(el("li", null, x)); w.append(ul);
    w.append(el("p", "note", "欠損は AI への指示で「推測で補わず市場評価に寄せる」ように伝えています"));
    infoBox.append(w);
  }

  // 各馬
  const hc = el("div", "card");
  const hh = el("h3", null, "各馬");
  if (info.payout_rate) hh.append(el("span", "aside num", `払戻率 ${(info.payout_rate * 100).toFixed(1)}%`));
  const seg = el("div", "seg small");
  for (const [k, label] of [["no", "馬番順"], ["ninki", "人気順"]]) {
    const b = el("button", null, label); b.setAttribute("aria-pressed", String(state.sort === k));
    b.onclick = () => { state.sort = k; renderResult(); };
    seg.append(b);
  }
  hh.append(seg);
  hc.append(hh);
  const list = el("div", "horses");
  const maxP = Math.max(...info.horses.map((h) => h.prob || 0), 1);
  const horses = info.horses.slice();
  if (state.sort === "ninki") horses.sort((a, b) => (a.cancel - b.cancel) || ((b.prob ?? -1) - (a.prob ?? -1)) || (+a.no - +b.no));
  for (const h of horses) {
    const rw = el("div", "horse" + (h.cancel ? " cancel" : "") + (state.open.has(h.no) ? " open" : ""));
    rw.append(el("span", "n" + (h.waku ? ` w${h.waku}` : ""), h.no));
    const nm = el("span", "nm", h.name); if (h.jockey) nm.append(el("small", null, h.jockey)); rw.append(nm);
    const pb = el("span", "pb");
    if (!h.cancel) { const i = el("i"); i.style.width = `${(h.prob || 0) / maxP * 100}%`; pb.append(i); }
    rw.append(pb);
    rw.append(el("span", "pr", h.cancel ? "取消" : h.prob != null ? `${h.prob.toFixed(1)}%` : "--"));
    rw.append(el("span", "od", h.cancel ? "" : h.odds));
    rw.onclick = () => { state.open.has(h.no) ? state.open.delete(h.no) : state.open.add(h.no); renderResult(); };
    list.append(rw);
    if (state.open.has(h.no)) list.append(horseDetail(h));
  }
  hc.append(list);
  const lg = el("div", "legend");
  lg.append(el("span", null, "行をタップで過去5走"));
  lg.append(el("span", null, "市場勝率・単勝"));
  hc.append(lg);
  hc.id = "sec-horses";

  // 同条件の走破タイム（過去5走のうち、今回と同じ競馬場・同じ距離のレースの最速）
  const sp = res.info.speed;
  if (sp && sp.rows && sp.rows.length) {
    const sc = el("div", "card");
    const sh = el("h3", null, "走破タイム"); sh.append(el("span", "aside", sp["条件"])); sc.append(sh);
    const tb = el("table", "rec-table speed-table");
    const hr = el("tr"); for (const [t, cls] of [["馬"], ["タイム", "r"], ["差", "r"], ["馬場"], ["上がり", "r"]]) hr.append(el("th", cls || null, t)); tb.append(hr);
    const top = sp.rows[0].sec;
    sp.rows.forEach((x, i) => {
      const tr = el("tr");
      tr.append(el("td", null, `${x["馬番"]} ${x["馬名"]}`), el("td", "r t", x.time),
        el("td", "r num", i === 0 ? "最速" : `+${(x.sec - top).toFixed(1)}`), el("td", null, x["馬場"] || "--"),
        el("td", "r num", x["上がり"] != null ? x["上がり"].toFixed(1) : "--"));
      tb.append(tr);
    });
    sc.append(tb);
    if (sp.none && sp.none.length) sc.append(el("p", "note", `同条件の走歴なし：${sp.none.join("・")}番`));
    addHelp(sc, "speed", [`過去5走のうち、今回と同じ競馬場・同じ距離（${sp["条件"]}）のレースの最速タイム。条件の違うレースのタイムは比べられないので入れていません。馬場状態で速さが変わるので、馬場も見てください`]);
    sc.id = "sec-time"; speedCard = sc;
  }

  // 画面の並び：AI の回答を記録したあとは、判断に使う「AI の予想」「買った馬券」を上に出す
  const recNow0 = readRecords()[cacheKey(state.date, venue, race.no)];
  const hasAi = !!(recNow0 && recNow0["AI"]);
  const ai = aiCard(venue, race); ai.id = "sec-ai";
  const own = ownCard(venue, race); own.id = "sec-own";
  const pc = el("details", "card preview"); pc.id = "sec-text";
  keepOpen(pc, "text");
  const sendText = textFor(res);
  pc.append(el("summary", null, `送るテキストを見る（${sendText.split("\n").length}行）`));
  pc.append(el("pre", null, sendText));
  const textNote = el("p", "note", `ワイド上位 ${info.wide}組・三連複上位 ${info.sanren}組も送ります。収集 ${res.at}` + (fresh ? "（テキストはコピー済み）" : ""));
  const order = hasAi ? [resBox, ai, own, infoBox, hc, speedCard, pc, textNote] : [resBox, infoBox, hc, speedCard, ai, own, pc, textNote];
  // 見出しのナビ（押すとその場所へ。画面の上に固定）
  const navItems = [["sec-res", "結果", resBox.childElementCount > 0], ["sec-ai", "AI予想", true], ["sec-own", "馬券", true], ["sec-horses", "出走馬", true], ["sec-time", "タイム", !!speedCard], ["sec-text", "テキスト", true]]
    .filter((x) => x[2]).sort((a, b) => order.findIndex((n) => n && n.id === a[0]) - order.findIndex((n) => n && n.id === b[0]));
  body.append(secNav(navItems));
  for (const n of order) if (n && (n !== resBox || resBox.childElementCount)) body.append(n);

  // 送る（画面の下に固定）
  const bar = el("div", "send-bar");
  const send = el("button", "btn primary");
  send.innerHTML = ICON_SEND;
  const target = shareLabel();
  const lbl = el("span", "lbl", "AI へ送る");
  lbl.append(el("small", null, target ? `${target}・長押しで変更` : "送り先を選ぶ"));
  send.append(lbl);
  onPress(send, () => { markSent(venue, race); Native.share(textFor(res), false); }, () => { markSent(venue, race); Native.share(textFor(res), true); });
  const copy = el("button", "btn secondary sub"); copy.innerHTML = ICON_COPY; copy.append(document.createTextNode("コピー"));
  copy.onclick = () => { markSent(venue, race); Native.copy(textFor(res)); toast("コピーしました"); };
  bar.append(send, copy);
  // 投票の入口はいつも出す（発売カレンダーが手元にない・競馬場名が合わないときに消えないように）
  {
    const pat = el("button", "btn secondary sub");
    pat.innerHTML = ICON_PAT;
    pat.append(document.createTextNode("即PAT"));
    pat.setAttribute("aria-label", "即PAT（地方競馬ネット投票）を開く");
    pat.onclick = openPat;
    bar.append(pat);
  }
  body.append(bar);
}

// 結果画面の見出しナビ。押すとその場所へ移る。いま見ている場所に印を付ける
function secNav(items) {
  const nav = el("nav", "sec-nav");
  nav.setAttribute("aria-label", "この画面の中の移動");
  for (const [id, label] of items) {
    const b = el("button", null, label); b.dataset.sec = id;
    b.onclick = () => {
      const t = document.getElementById(id); if (!t) return;
      const hdr = document.querySelector("#detail .appbar");
      window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - (hdr ? hdr.offsetHeight : 0) - nav.offsetHeight - 8, behavior: "smooth" });
    };
    nav.append(b);
  }
  requestAnimationFrame(markSecNav);
  return nav;
}
function markSecNav() {
  const nav = document.querySelector(".sec-nav");
  if (!nav || state.screen !== "result") return;
  const hdr = document.querySelector("#detail .appbar");
  nav.style.top = `${hdr ? hdr.offsetHeight : 0}px`;
  const line = (hdr ? hdr.offsetHeight : 0) + nav.offsetHeight + 24;
  let cur = null;
  for (const b of nav.children) { const t = document.getElementById(b.dataset.sec); if (t && t.getBoundingClientRect().top <= line) cur = b; }
  for (const b of nav.children) b.classList.toggle("on", b === cur);
}
window.addEventListener("scroll", () => { if (state.screen === "result") markSecNav(); }, { passive: true });
// <details> の開閉を、画面を描き直しても保つ
function keepOpen(d, key) {
  state.openDetails = state.openDetails || new Set();
  if (state.openDetails.has(key)) d.open = true;
  d.addEventListener("toggle", () => { if (d.open) state.openDetails.add(key); else state.openDetails.delete(key); });
}
// 説明文を「?」の中に畳む（押すと開く。開いた状態は描き直しても保つ）
function addHelp(card, key, texts) {
  state.helpOpen = state.helpOpen || new Set();
  const h3 = card.querySelector("h3");
  const box = el("div", "help-box" + (state.helpOpen.has(key) ? "" : " hidden"));
  for (const t of [].concat(texts)) box.append(el("p", null, t));
  const b = el("button", "help-btn", "?");
  b.setAttribute("aria-label", "説明を表示"); b.setAttribute("aria-expanded", String(state.helpOpen.has(key)));
  b.onclick = (e) => {
    e.stopPropagation();
    const open = box.classList.toggle("hidden") === false;
    if (open) state.helpOpen.add(key); else state.helpOpen.delete(key);
    b.setAttribute("aria-expanded", String(open));
  };
  if (h3) { h3.append(b); h3.after(box); } else card.prepend(box);
  return card;
}

// 発走まで・取得から何分かを30秒ごとに書き直す。取得から10分以上たっていたら「オッズを更新」を目立たせる
function updateTimeLine() {
  if (state.screen !== "result" || !state.result) return;
  const { race, res } = state.result;
  const tl = $("timeLine"), again = $("againBtn");
  if (!tl || !again) return;
  const um = untilMin(state.date, res.info.start || race.time);
  const ago = agoMin(res.at);
  tl.replaceChildren();
  if (um != null) {
    const a = el("span"); a.append(document.createTextNode(um > 0 ? "発走まで " : ""), el("b", null, um > 0 ? fmtUntil(um).replace("あと", "") : "発走済み"));
    tl.append(a);
  }
  // 発走まで90分を切ってから、取って10分以上たったオッズを目立たせる（前日や朝のうちは更新しても変わりにくい）
  const stale = um != null && um > 0 && um <= 90 && ago != null && ago >= 10;
  const agoText = ago < 1 ? "1分以内" : ago < 60 ? `${Math.floor(ago)}分前` : `${Math.floor(ago / 60)}時間${Math.floor(ago % 60)}分前`;
  if (ago != null) tl.append(el("span", stale ? "stale" : null, `オッズは${agoText}に取得`));
  again.className = "btn " + (stale ? "stale" : "secondary");
  // 古いことは上の行（オッズは○分前に取得）と色で伝え、ボタンの文言は短く保つ
  again.textContent = um != null && um <= 0 ? "取り直す" : stale ? "! オッズを更新" : "オッズを更新";
}

function horseDetail(h) {
  const d = el("div", "hdetail");
  const a = [h.sex_age, h.kinryo && `斤量 ${h.kinryo}${h.kinryo_diff ? `（前走比 ${h.kinryo_diff}）` : ""}`,
    h.weight && `馬体重 ${h.weight}`, h.kyaku && `脚質 ${h.kyaku}`, h.interval && `前走から ${h.interval}`, h.norikae && `乗替 ${h.norikae}`].filter(Boolean);
  if (a.length) d.append(el("p", null, a.join("・")));
  const condText = Object.entries(h.cond || {}).map(([k, v]) => `${k}${v}`).join(" ");
  const b = [condText && `成績 ${condText}`, h.mochi && `持ち時計 ${h.mochi}`, h.combo && `騎手コンビ ${h.combo}`, h.ninki && `${h.ninki}番人気`, h.fuku && h.fuku !== "--" && `複勝 ${h.fuku}`].filter(Boolean);
  if (b.length) d.append(el("p", null, b.join("｜")));
  if (!h.past || !h.past.length) { d.append(el("p", null, "過去成績を取得できませんでした")); return d; }
  const t = el("table", "past");
  const tr0 = el("tr"); for (const x of ["日付", "場", "距離", "馬場", "人", "着/頭", "差", "上り"]) tr0.append(el("th", null, x)); t.append(tr0);
  for (const p of h.past) {
    const tr = el("tr");
    const rank = /^\d+$/.test(p.rank) ? +p.rank : null;
    const cells = [p.date, p.venue, p.dist, p.baba, p.ninki, `${p.rank}${p.heads ? `/${p.heads}` : ""}`, p.diff, p.agari];
    cells.forEach((v, i) => { const td = el("td", i === 5 && rank != null ? (rank === 1 ? "win" : rank <= 3 ? "place" : null) : null, v || ""); tr.append(td); });
    t.append(tr);
  }
  d.append(t);
  return d;
}

// ===== Kotlin から呼ばれる =====
const App = {
  onRaceList(list) {
    state.loading = false;
    if (!state.listDate) state.listDate = state.date;
    state.venues = list;
    if (list && !list.some((v) => v.name === state.venue)) {
      const saved = store.get(LAST_VENUE_KEY, null);
      state.venue = list.some((v) => v.name === saved) ? saved : (orderedVenues()[0] || {}).name || null;
    }
    renderVenues(); renderRaces();
  },
  onStep(key, s, detail) { setStep(key, s, detail); },
  onLog(line) { addLog(line); },
  onResult(res, error) {
    const job = state.job;
    if (!job || state.screen !== "collect") return;
    if (!res) {
      // 失敗・中止：進捗画面のまま、理由と戻る操作を出す
      const body = $("detailBody");
      const act = body.querySelector(".sticky-actions"); if (act) act.remove();
      const card = el("div", "card warn-card");
      card.append(el("h3", null, error === "cancel" ? "中止しました" : "× 収集できませんでした"));
      if (error && error !== "cancel") card.append(el("p", "note", error));
      body.append(card);
      const a = el("div", "end-actions");
      const retry = el("button", "btn primary", "もう一度収集する"); retry.onclick = () => startCollect(job.venue, job.race);
      const back = el("button", "btn quiet", "レース一覧に戻る"); back.onclick = goHome;
      a.append(retry, back); body.append(a);
      return;
    }
    setPreview(false);
    const at = res.at;
    const c = readCache(); const ck = cacheKey(state.date, job.venue, job.race.no);
    // 同じレースを取り直したときは、前回の収集と比べたオッズの動きを残す
    const prev = c[ck];
    if (prev && prev.info) res.diff = { prevAt: prev.at.slice(11, 16), items: KS.diffRaces(prev.info, res.info) };
    // 取得済みのレース結果は取り直しても残す
    const entry = { at, text: res.text, info: res.info, diff: res.diff || null, result: (prev && prev.result) || null };
    c[ck] = entry; writeCache(c);
    Native.copy(textFor(res));
    showResult(job.venue, job.race, Object.assign({}, entry), true);
  },
  // 戻るボタン：一覧以外なら一覧へ戻して true、一覧なら false（アプリを閉じる）
  back() {
    if (!$("sheet").classList.contains("hidden")) { closeSheet(); return true; }
    if (state.debug) { setPreview(false); return true; }
    if (state.screen === "home") return false;
    if (state.screen === "settings" && state.back === "result" && state.result) { state.back = null; showScreen("result"); renderResult(); return true; }
    if (state.screen === "result" && state.fromRecords) { state.fromRecords = false; showRecords(); return true; }
    // 設定の画面から開いた画面は、設定へ戻る
    if (state.parent === "prefs" && ["settings", "records", "about"].includes(state.screen)) { showScreen("prefs"); renderPrefs(); return true; }
    if (state.screen === "collect" && state.job) { Native.cancel(); }
    goHome(); return true;
  },
  setTheme(t) { App.setSystemDark(t === "dark"); },
  // 端末のダークモードの状態（Kotlin から起動時と切り替え時に届く）
  setSystemDark(d) { systemDark = !!d; applyTheme(); },
  onUpdateInfo(latest, error) { onUpdateInfo(latest, error); },
  openFromNotification(p) { openFromNotification(p); },
  onPatCalendar(month, data) { onPatCalendar(month, data); },
  onRaceResult(raceId, res) { onRaceResult(raceId, res); },
  onResultsDone(err) { onResultsDone(err); },
  // 読み込んだファイルの中身（書き出しと同じ JSON。配列か {records: [...]}）を記録へ足す
  onImported(text, err) {
    if (text == null) { toast(err ? `読み込めませんでした（${err}）` : "読み込みを取りやめました"); return; }
    let items;
    try { items = JSON.parse(text); } catch (e) { toast("JSON として読めませんでした"); return; }
    items = Array.isArray(items) ? items : items && Array.isArray(items.records) ? items.records : [];
    const recs = readRecords();
    let added = 0, merged = 0, skipped = 0;
    for (const r of items) {
      if (!validRecord(r)) { skipped++; continue; }
      const k = cacheKey(r["日付"], r["競馬場"], r["レース番号"]);
      const cur = recs[k];
      if (!cur) { recs[k] = r; added++; continue; }
      let ch = false;
      if (!cur["AI"] && r["AI"]) {
        cur["AI"] = r["AI"]; ch = true;
        for (const f of ["買い方", "EV_MIN", "HIT_MIN", "HIT_EV_MIN", "予算", "予想オッズ"]) if (r[f] != null) cur[f] = r[f];
      }
      if (!cur["結果"] && r["結果"]) { cur["結果"] = r["結果"]; ch = true; }
      if (!ownBetsOf(cur).length && ownBetsOf(r).length) { cur["購入"] = r["購入"]; cur["購入時刻"] = r["購入時刻"]; ch = true; }
      if (ch) merged++;
    }
    writeRecords(recs); updateRecBadge();
    const dropped = Object.keys(recs).length - Object.keys(readRecords()).length;
    toast(`読み込みました（新しい記録 ${added}件・足した記録 ${merged}件` + (skipped ? `・形式が違って読めない記録 ${skipped}件` : "") +
      (dropped > 0 ? `。500件を超えた古い記録 ${dropped}件は残せませんでした` : "") + "）");
    if (state.screen === "records") renderRecords();
  },
  onExported(ok, err) { toast(ok ? "書き出しました" : err ? `書き出せませんでした（${err}）` : "書き出しを取りやめました"); },
  // アプリに戻ってきたとき：自動収集の結果・予約・送り先を読み直す
  onResume() {
    followToday();
    mergeBackgroundResults(); mergeRaceResults(); loadReservations(); updateRecBadge();
    if (state.screen === "home" && !state.loading) renderRaces();
    if (state.screen === "result" && state.result) renderResult();
    if (state.screen === "records" && !state.fetching) renderRecords();
    if (state.screen === "prefs") renderPrefs();
  },
  onUpdateState(s, detail) { onUpdateState(s, detail); },
  // 画面に戻ってきた（窓が前に出た）とき。AI の回答がコピーされていれば記録を勧める
  onFocus() { checkClipboardAnswer(); },
};
window.App = App;

// ===== AI の回答をクリップボードから読み込む =====
// 結果画面で AI へ送った（コピーした）レースに戻ってきたとき、クリップボードに記録用ブロック（#PRED）があれば
// 「このレースに記録しますか」と出す。送ってから3時間以内・AI の回答をまだ記録していないときだけ読む
// （Android 12 以降はほかのアプリのコピーを読むと「貼り付けました」と出るため、必要なときだけ読む）
const SENT_KEY = "keiba-sent";
const SENT_TTL = 3 * 3600 * 1000;
function markSent(venue, race) { store.set(SENT_KEY, { key: cacheKey(state.date, venue, race.no), at: Date.now() }); }
function checkClipboardAnswer() {
  if (state.screen !== "result" || !state.result) return;
  const { venue, race, res } = state.result;
  const key = cacheKey(state.date, venue, race.no);
  const sent = store.get(SENT_KEY, null);
  if (!sent || sent.key !== key || Date.now() - sent.at > SENT_TTL) return;
  const rec = readRecords()[key];
  if (rec && rec["AI"]) return;
  // クリップボードが前に見たときから変わっていなければ読まない
  let stamp = -1;
  try { stamp = Number(Native.clipStamp()); } catch (e) {}
  if (stamp > 0 && stamp === state.clipStamp) return;
  state.clipStamp = stamp;
  let text = "";
  try { text = Native.readClipboard() || ""; } catch (e) {}
  if (!text.trim() || text.trim() === textFor(res).trim()) return;
  const parsed = KS.parseAiBlock(text);
  if (!parsed) return;
  showClipOffer(key, text, parsed);
}
function showClipOffer(key, text, parsed) {
  hideClipOffer();
  const { venue, race } = state.result;
  const box = el("div", "clip-offer"); box.id = "clipOffer";
  const n = parsed["買い目"].length + (parsed["的中買い目"] || []).length;
  box.append(el("b", null, "AI の回答がコピーされています"),
    el("p", null, `${venue} ${race.no}R に記録しますか？（買い目 ${n}点${parsed["予想"] ? `・${Object.keys(parsed["予想"]).length}頭の推定勝率` : ""}）`));
  const row = el("div", "btn-row");
  const ok = el("button", "btn primary", "記録する");
  ok.onclick = () => { if (state.result && cacheKey(state.date, state.result.venue, state.result.race.no) === key) pasteAiAnswer(text); else hideClipOffer(); };
  const no = el("button", "btn secondary", "記録しない"); no.onclick = hideClipOffer;
  row.append(ok, no); box.append(row);
  document.body.append(box);
}
function hideClipOffer() { const b = $("clipOffer"); if (b) b.remove(); }

// ===== 版情報と更新 =====
const UPDATE_KEY = "keiba-update";  // 最後に確認した結果（{at, latest}）
const current = (() => { try { return JSON.parse(Native.appInfo()); } catch (e) { return { versionCode: 0, versionName: "?", commit: "", builtAt: "" }; } })();
const upd = { checking: false, latest: null, error: null, at: null, state: null, detail: "" };
(() => { try { const c = JSON.parse(localStorage.getItem(UPDATE_KEY) || "null"); if (c) { upd.latest = c.latest; upd.at = c.at; } } catch (e) {} })();
const hasUpdate = () => !!(upd.latest && upd.latest.versionCode > current.versionCode);

function checkUpdate() {
  upd.checking = true; upd.error = null;
  renderUpdateUi();
  Native.checkUpdate();
}
function onUpdateInfo(latest, error) {
  upd.checking = false;
  if (latest) {
    upd.latest = latest; upd.at = new Date().toISOString(); upd.error = null;
    try { localStorage.setItem(UPDATE_KEY, JSON.stringify({ at: upd.at, latest })); } catch (e) {}
  } else {
    upd.error = error || "確認できませんでした";
  }
  renderUpdateUi();
}
function onUpdateState(s, detail) { upd.state = s; upd.detail = detail; renderUpdateUi(); }

function renderUpdateUi() {
  // 一覧の上のお知らせ帯
  const bar = $("updateBar");
  if (hasUpdate()) {
    bar.replaceChildren();
    bar.append(el("span", null, "新しいバージョン "));
    bar.append(el("b", "num", `v${upd.latest.versionName}`));
    bar.append(el("span", null, " があります"));
    bar.append(el("span", "go", "更新 ›"));
    bar.classList.remove("hidden");
  } else bar.classList.add("hidden");
  $("prefsDot").classList.toggle("hidden", !hasUpdate());
  if (state.screen === "prefs") renderPrefs();
  if (state.screen === "about") renderAbout();
}

function fmtAt(iso) { const d = new Date(iso); return isNaN(d) ? "" : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }

function showAbout() {
  showScreen("about");
  renderAbout();
  // 開いたら確認する（直前に確認していれば省く）
  if (!upd.checking && (!upd.at || Date.now() - new Date(upd.at) > 60 * 1000)) checkUpdate();
}

function renderAbout() {
  const body = $("detailBody"); body.replaceChildren();
  const head = el("div", "about-head");
  const logo = el("div", "logo");
  logo.innerHTML = '<svg viewBox="0 0 108 108" width="52" height="52"><path fill="none" stroke="#F2E6C9" stroke-width="9" stroke-linecap="round" d="M38,74 L38,52 A16,16 0 0 1 70,52 L70,74"/></svg>';
  const t = el("div"); t.append(el("h2", null, "地方競馬データ収集"));
  t.append(el("p", "num", `v${current.versionName}`));
  head.append(logo, t); body.append(head);

  // 更新の状態
  const card = el("div", "card");
  const st = el("div", "status");
  if (upd.checking) { st.classList.add("run"); st.append(el("span", "ic"), el("span", null, "最新版を確認しています…")); }
  else if (upd.error && !upd.latest) { st.classList.add("ng"); st.append(el("span", "ic", "×"), el("span", null, "確認できませんでした")); }
  else if (hasUpdate()) { st.classList.add("new"); st.append(el("span", "ic", "↑"), el("span", null, `新しいバージョン v${upd.latest.versionName} があります`)); }
  else if (upd.latest) { st.classList.add("ok"); st.append(el("span", "ic", "✓"), el("span", null, "最新版です")); }
  card.append(st);
  if (upd.error) card.append(el("p", "note", `理由：${upd.error}。通信状態を確認して、もう一度確認してください`));
  if (upd.at && !upd.checking) card.append(el("p", "note", `確認 ${fmtAt(upd.at)}`));

  if (hasUpdate()) {
    const btn = el("button", "btn primary");
    btn.style.width = "100%"; btn.style.marginTop = "12px";
    const s = upd.state;
    if (s === "download") {
      btn.disabled = true; btn.textContent = `ダウンロード中… ${upd.detail}%`;
      card.append(btn);
      const bar = el("div", "bar"); const f = el("i"); f.style.width = `${upd.detail}%`; bar.append(f); card.append(bar);
    } else {
      btn.textContent = s === "install" ? "インストール画面をもう一度開く" : "更新する（ダウンロードしてインストール）";
      btn.onclick = () => Native.installUpdate(upd.latest.versionName);
      card.append(btn);
      if (s === "permission") card.append(el("p", "note", "設定画面で「この提供元のアプリを許可」をオンにして戻ったら、もう一度「更新する」を押してください（初回だけ必要です）"));
      if (s === "install") card.append(el("p", "note", "インストール画面で「更新」を押すと新しい版に置き換わります。収集済みの記録やテーマの設定はそのまま残ります"));
      if (s === "error") card.append(el("p", "note", `${upd.detail}。「リリースページを開く」から手動でダウンロードすることもできます`));
    }
  }
  const row = el("div", "btn-row"); row.style.marginTop = "12px";
  const again = el("button", "btn secondary", "もう一度確認"); again.disabled = upd.checking; again.onclick = checkUpdate;
  const page = el("button", "btn secondary", "リリースページ"); page.onclick = () => Native.openUrl("https://github.com/kotaooka/keiba-scraper/releases/tag/android-latest");
  row.append(again, page); card.append(row);
  body.append(card);

  // 最近の変更
  if (upd.latest && upd.latest.changes && upd.latest.changes.length) {
    const c = el("div", "card");
    c.append(el("h3", null, "最近の変更"));
    const ul = el("ul", "changes");
    const mine = (current.builtAt || "").slice(0, 10);
    for (const ch of upd.latest.changes) {
      const li = el("li", hasUpdate() && ch.date >= mine ? "newer" : null);
      li.append(el("span", null, ch.date), el("span", null, ch.text));
      ul.append(li);
    }
    c.append(ul);
    if (hasUpdate()) c.append(el("p", "note", "太字は、このアプリのビルド日以降の変更です"));
    body.append(c);
  }

  // 表示
  const tc = el("div", "card");
  tc.append(el("h3", null, "表示"));
  const seg = el("div", "seg");
  for (const k of THEMES) {
    const b = el("button", null, { auto: "自動", light: "ライト", dark: "ダーク" }[k]);
    b.dataset.themeChoice = k; b.setAttribute("aria-pressed", String(k === themePref));
    b.onclick = () => setThemePref(k);
    seg.append(b);
  }
  tc.append(seg);
  tc.append(el("p", "note", "「自動」は端末のダークモードに合わせます"));
  body.append(tc);

  // このビルド
  const ic = el("div", "card");
  ic.append(el("h3", null, "このビルド"));
  const dl = el("dl", "kv");
  for (const [k, v] of [["バージョン", `v${current.versionName}（${current.versionCode}）`], ["ビルド日時", current.builtAt ? `${current.builtAt} JST` : "—"],
    ["コミット", current.commit || "—"], ["データの取得元", "netkeiba（開催一覧・出馬表・オッズ・結果）、keiba.go.jp（馬柱・過去5走・即PAT の発売カレンダー）"]]) {
    dl.append(el("dt", null, k), el("dd", k === "コミット" ? "num" : null, v));
  }
  ic.append(dl);
  body.append(ic);
}
