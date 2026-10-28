package io.github.kotaooka.keiba

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.os.SystemClock
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.Charset
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.coroutines.resume

/**
 * WebView でページを開き、assets/scraper.js の解析関数を呼んでデータを集める。
 * PC版 keiba_scraper.py の fetch_page / collect_race に相当する。
 * すべて UI スレッドから呼ぶこと（WebView の制約）。
 */
class Scraper(
    private val web: WebView,
    private val ksSource: String,
    private val log: (String) -> Unit,
    private val step: (key: String, state: String, detail: String) -> Unit,
) {

    companion object {
        const val NETKEIBA = "https://nar.netkeiba.com"

        // PC版と同じ UA（スマホ用 UA だと netkeiba がスマホ版ページを返し、構造が変わる）
        const val UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

        const val TIMEOUT_PAGE = 20_000L      // ページロード待機 (ms)
        const val TIMEOUT_SELECTOR = 10_000L  // 要素出現待機 (ms)
        const val RETRY = 2                   // ページ取得の試行回数
        const val REQUEST_INTERVAL = 2_000L   // サイトへのアクセス間隔の下限 (ms)。サーバ負荷を避けるため短くしない

        // netkeiba の競馬場コード（scraper.js の KEIBA_CODES と同じ）
        val KEIBA_CODES = linkedMapOf(
            "門別" to "30", "盛岡" to "35", "水沢" to "36",
            "浦和" to "42", "船橋" to "43", "大井" to "44", "川崎" to "45",
            "金沢" to "46", "笠松" to "47", "名古屋" to "48",
            "園田" to "50", "姫路" to "51", "高知" to "54", "佐賀" to "55",
            "帯広(ば)" to "65",
        )

        private val CHARSET_RE = Regex("""charset\s*=\s*["']?([A-Za-z0-9_\-]+)""", RegexOption.IGNORE_CASE)

        /** HTML のバイト列を文字にする。文字コードは応答ヘッダ → ページの meta の順に探し、無ければ EUC-JP（netkeiba の地方版） */
        fun decodeHtml(bytes: ByteArray, contentType: String?): String {
            val name = contentType?.let { CHARSET_RE.find(it)?.groupValues?.get(1) }
                ?: CHARSET_RE.find(String(bytes, 0, minOf(bytes.size, 4096), Charsets.ISO_8859_1))?.groupValues?.get(1)
                ?: "EUC-JP"
            val cs = runCatching { Charset.forName(name) }.getOrElse { Charset.forName("EUC-JP") }
            return String(bytes, cs)
        }
    }

    // 読み込み完了の通知。成功は空文字、失敗はエラー内容
    private var pageLoaded: CompletableDeferred<String>? = null
    private var lastAccess = 0L

    init {
        configure()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure() {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            userAgentString = UA
            useWideViewPort = true
            loadWithOverviewMode = true
            blockNetworkImage = true  // 画像は使わないので読まない（通信量と負荷を減らす）
        }
        web.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {}

            override fun onPageFinished(view: WebView, url: String) {
                pageLoaded?.complete("")
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) pageLoaded?.complete(error.description?.toString() ?: "読み込みエラー")
            }

            // ページを描く部分（レンダラー）が落ちても、アプリごと落ちないようにする
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                pageLoaded?.complete("ページの表示が止まりました")
                return true
            }
        }
    }

    /** 前回のアクセスから REQUEST_INTERVAL たつまで待つ（ページ遷移・表の切替の前に必ず呼ぶ） */
    private suspend fun waitInterval() {
        val rest = REQUEST_INTERVAL - (SystemClock.elapsedRealtime() - lastAccess)
        if (rest > 0) delay(rest)
        lastAccess = SystemClock.elapsedRealtime()
    }

    /** ページを開く。失敗時は RETRY 回まで再試行し、最後は false を返す */
    private suspend fun load(url: String): Boolean {
        for (attempt in 1..RETRY) {
            waitInterval()
            val done = CompletableDeferred<String>()
            pageLoaded = done
            web.loadUrl(url)
            val result = try {
                withTimeoutOrNull(TIMEOUT_PAGE) { done.await() }
            } catch (e: kotlinx.coroutines.CancellationException) {
                web.stopLoading()
                throw e
            } finally {
                pageLoaded = null
            }
            when (result) {
                null -> log("  ページ取得タイムアウト（$attempt/${RETRY}回目）")
                "" -> return true
                else -> log("  ページ取得失敗（$attempt/${RETRY}回目）: $result")
            }
        }
        return false
    }

    /**
     * ページを描画せずに HTML だけを取る（広告やスクリプトを読まないので速い）。
     * 結果ページのように、HTML の時点で中身が入っているページだけに使う。アクセス間隔は load と同じく守る。失敗したら null
     */
    private suspend fun fetchHtml(url: String): String? {
        for (attempt in 1..RETRY) {
            waitInterval()
            val html = withContext(Dispatchers.IO) {
                runCatching {
                    val con = (URL(url).openConnection() as HttpURLConnection).apply {
                        connectTimeout = TIMEOUT_PAGE.toInt()
                        readTimeout = TIMEOUT_PAGE.toInt()
                        setRequestProperty("User-Agent", UA)
                        setRequestProperty("Accept-Language", "ja")
                    }
                    try {
                        if (con.responseCode != 200) error("HTTP ${con.responseCode}")
                        decodeHtml(con.inputStream.use { it.readBytes() }, con.contentType)
                    } finally {
                        con.disconnect()
                    }
                }
            }
            html.onSuccess { return it }
            log("  ページ取得失敗（$attempt/${RETRY}回目）: ${html.exceptionOrNull()?.message}")
        }
        return null
    }

    /** まだ何も開いていなければ空のページを開く（JavaScript を動かす場所を作る。通信はしない） */
    private suspend fun ensurePage() {
        if (web.url != null) return
        val done = CompletableDeferred<String>()
        pageLoaded = done
        web.loadUrl("about:blank")
        try { withTimeoutOrNull(5_000) { done.await() } } finally { pageLoaded = null }
    }

    /** JavaScript を実行し、結果を JSON 文字列のまま返す（evaluateJavascript の仕様） */
    private suspend fun evalRaw(script: String): String = suspendCancellableCoroutine { cont ->
        web.evaluateJavascript(script) { cont.resume(it ?: "null") }
    }

    /** scraper.js が未注入なら注入する */
    private suspend fun ensureKs() {
        if (evalRaw("typeof window.KS !== 'undefined'") != "true") {
            evalRaw(ksSource + "\n;true")
        }
    }

    /** KS の関数を呼び、結果を JSON 文字列で返す。例外は {"__error": ...} として返す */
    private suspend fun call(expr: String): String {
        ensureKs()
        return evalRaw("(function(){try{return $expr}catch(e){return {__error:String(e)}}})()")
    }

    /** 収集用の WebView で KS の式を実行し、結果を JSON の文字列で返す（自動の答え合わせで使う） */
    suspend fun evalKs(expr: String): String = call(expr)

    /** 文字列を返す JS の結果を Kotlin の文字列に戻す */
    private fun decodeString(raw: String): String =
        if (raw == "null") "" else (JSONTokener(raw).nextValue() as? String ?: raw)

    /** 条件式が true になるまで待つ。タイムアウトしたら false */
    private suspend fun waitFor(cond: String, timeoutMs: Long = TIMEOUT_SELECTOR): Boolean {
        val end = SystemClock.elapsedRealtime() + timeoutMs
        while (SystemClock.elapsedRealtime() < end) {
            ensureKs()
            if (evalRaw("(function(){try{return !!($cond)}catch(e){return false}})()") == "true") return true
            delay(300)
        }
        return false
    }

    private fun q(s: String): String = JSONObject.quote(s)

    // ========== 開催一覧 ==========

    /** 開催一覧を JSON 配列の文字列で返す（[{name, races:[{race_id,no,time,title,heads}]}]）。読めなければ null */
    suspend fun fetchRaceList(raceDate: String): String? {
        if (!load("$NETKEIBA/top/race_list_sub.html?kaisai_date=$raceDate")) return null
        waitFor("document.querySelector('dl.RaceList_DataList')", 5_000)
        val raw = call("KS.parseRaceList(document)")
        return if (runCatching { JSONArray(raw) }.isSuccess) raw else null
    }

    // ========== 即PAT・A-PAT の発売カレンダー ==========

    /** その月の発売カレンダー（keiba.go.jp）を読み、JSON の文字列で返す。読めなければ null。yyyymm は "202610" */
    suspend fun fetchPatCalendar(yyyymm: String): String? {
        if (!load("https://www.keiba.go.jp/jranet/calendar/$yyyymm.html")) return null
        waitFor("document.querySelector('.calendar ul.stable li')", 5_000)
        val raw = call("KS.parsePatCalendar(document)")
        return if (raw.startsWith("{") && !raw.contains("\"__error\"")) raw else null
    }

    // ========== レース結果（答え合わせ用） ==========

    /**
     * 結果ページの着順・払戻を JSON の文字列で返す。開けなければ null（未確定でも読めた分を返す）。
     * 結果ページは HTML に表が入っているので、描画せずに HTML を取って解析する。取れないときだけ WebView で開く。
     * 確定した結果は当日の傾向用に端末に置く（自動の答え合わせや記録の画面で取った結果も、次の収集で使い回せるように）
     */
    suspend fun fetchResult(raceId: String): String? {
        val url = "$NETKEIBA/race/result.html?race_id=$raceId"
        var raw: String? = null
        val html = fetchHtml(url)
        if (html != null) {
            ensurePage()
            val r = call("KS.parseResult(new DOMParser().parseFromString(${q(html)}, 'text/html'))")
            if (r.startsWith("{") && !r.contains("\"__error\"")) raw = r
            else log("  結果ページを解析できず、画面で開き直します: ${r.take(120)}")
        }
        if (raw == null) {
            if (!load(url)) return null
            // 着順表と払戻表が描画されるまで待つ（未確定のときは出ないので、待ちきれずに読めた分で判定する）
            waitFor("KS.resultReady(document)")
            val r = call("KS.parseResult(document)")
            if (!r.startsWith("{") || r.contains("\"__error\"")) return null
            raw = r
        }
        val out: String = raw ?: return null
        if (call("KS.resultFinished($out)").trim() == "true") runCatching { java.io.File(dayResultsDir(), "$raceId.json").writeText(out) }
        return out
    }

    /** 確定した結果を置く場所（3日より古いものは fetchDayResults で消す） */
    private fun dayResultsDir() = java.io.File(web.context.filesDir, "day_results").apply { mkdirs() }

    // ========== 当日の結果 ==========

    /**
     * 同じ日・同じ競馬場で、このレースより前の確定済みレースの結果を新しい順に最大 Config.DAY_RESULTS_MAX レース読む（PC版の scrape_day_results）。
     * lastStarted は、このレースより前で発走済みのいちばん新しいレース番号（画面の一覧の発走時刻から。0 はなし、-1 は分からない）。
     * まだ発走していないレース・確定していないレースは飛ばして前へ読む。確定した結果が見つかったあとに未確定が2つ続くか、
     * サイトから読んだページが DAY_RESULTS_MAX + 2 を超えたらやめる。確定した結果は端末に置いて使い回す（3日で消す）
     */
    private suspend fun fetchDayResults(code: String, raceDate: String, raceNo: Int, lastStarted: Int): String {
        step("today", "run", "")
        val t0 = SystemClock.elapsedRealtime()
        val dir = dayResultsDir()
        // 古い結果を消す
        val old = System.currentTimeMillis() - 3L * 24 * 3600 * 1000
        dir.listFiles()?.forEach { if (it.lastModified() < old) it.delete() }
        val today = Jst.format("yyyyMMdd")
        val top = when {
            raceDate > today -> 0
            lastStarted >= 0 -> minOf(lastStarted, raceNo - 1)
            else -> raceNo - 1
        }
        val out = JSONArray()
        var misses = 0
        var fetched = 0
        for (n in top downTo 1) {
            if (out.length() >= Config.DAY_RESULTS_MAX || fetched >= Config.DAY_RESULTS_MAX + 2) break
            val rid = "${raceDate.substring(0, 4)}$code${raceDate.substring(4, 8)}${"%02d".format(n)}"
            val f = java.io.File(dir, "$rid.json")
            var res: JSONObject? = if (f.exists()) runCatching { JSONObject(f.readText()) }.getOrNull() else null
            if (res == null) {
                step("today", "run", "${n}R")
                fetched++
                // 確定していれば fetchResult が f に書く
                if (fetchResult(rid) != null && f.exists()) res = runCatching { JSONObject(f.readText()) }.getOrNull()
            }
            if (res != null) {
                out.put(JSONObject().put("レース番号", n).put("結果", res))
                misses = 0
            } else if (out.length() > 0 && ++misses >= 2) break
        }
        log("  当日の結果: 確定済み ${out.length()}レース（${(SystemClock.elapsedRealtime() - t0) / 1000}秒）")
        step("today", if (out.length() > 0) "ok" else "skip", if (out.length() > 0) "${out.length()}レース" else "なし")
        return out.toString()
    }

    // ========== 1レース分の収集 ==========

    /** 収集の結果。成功なら json（{text, info, at}）、失敗なら error に理由 */
    data class Outcome(val json: String?, val error: String?)

    private fun count(raw: String, arr: Boolean = false): Int =
        runCatching { if (arr) JSONArray(raw).length() else JSONObject(raw).length() }.getOrDefault(0)

    /**
     * 1レース分を集めて AI 貼り付け用テキストを作る。段階ごとに step(キー, 状態, 詳細) を呼ぶ。
     * キーは ui.html の STEPS と同じ。状態は run / ok / warn / ng / skip。
     */
    suspend fun collectRace(keibajo: String, raceDate: String, raceNo: Int, lastStarted: Int = -1): Outcome {
        val code = KEIBA_CODES[keibajo] ?: return Outcome(null, "未対応の競馬場です: $keibajo")
        val raceId = "${raceDate.substring(0, 4)}$code${raceDate.substring(4, 8)}${"%02d".format(raceNo)}"
        val oddsUrl = "$NETKEIBA/odds/?race_id=$raceId&type="
        log("収集対象: $keibajo ${raceDate.substring(0, 4)}/${raceDate.substring(4, 6)}/${raceDate.substring(6)} ${raceNo}R（race_id: $raceId）")

        // ---- 当日の結果（当日の傾向に使う。オッズをなるべく新しくするため、オッズより先に読む） ----
        val dayResults = fetchDayResults(code, raceDate, raceNo, lastStarted)

        // ---- 出馬表 ----
        step("shutuba", "run", "")
        if (!load("$NETKEIBA/race/shutuba.html?race_id=$raceId")) {
            step("shutuba", "ng", "")
            return Outcome(null, "出馬表のページを開けませんでした。通信状態を確認してください。")
        }
        if (!waitFor("document.querySelector('table.ShutubaTable, dl.HorseList')")) log("  要素待機タイムアウト（取得できた分で続行）")
        val shutuba = call("KS.parseShutuba(document)")
        val nHorses = runCatching { JSONObject(shutuba).getJSONArray("horses").length() }.getOrDefault(0)
        log("  出馬表: ${nHorses}頭取得")
        if (nHorses == 0) {
            step("shutuba", "ng", "0頭")
            return Outcome(null, "出馬表を読めませんでした。出馬表がまだ出ていないか、ページの構造が変わった可能性があります。")
        }
        step("shutuba", "ok", "${nHorses}頭")

        // ---- 馬柱（keiba.go.jp） ----
        step("keibago", "run", "")
        var keibago = "{}"
        val kgUrl = decodeString(call("KS.keibagoUrl(${q(keibajo)}, ${q(raceDate)}, $raceNo)"))
        if (kgUrl.isEmpty()) {
            log("  keiba.go.jp のコード未定義のため取得しません: $keibajo")
            step("keibago", "skip", "対象外")
        } else if (load(kgUrl)) {
            if (!waitFor("document.querySelector('section.cardTable')")) log("  要素待機タイムアウト（取得できた分で続行）")
            keibago = call("KS.parseKeibago(document)")
            val n = count(keibago)
            log("  keiba.go.jp 解析: ${n}頭")
            step("keibago", if (n > 0) "ok" else "warn", "${n}頭")
        } else {
            step("keibago", "warn", "開けず")
        }

        // ---- 単勝・複勝 ----
        step("tanfuku", "run", "")
        var tanFuku = "{}"
        if (load(oddsUrl + "b1")) {
            // 単勝・複勝の両方にオッズの数字が入るまで待つ（複勝が空のうちに読まないため）
            if (!waitFor("KS.tanfukuReady(document)")) log("  複勝オッズの表示待ちがタイムアウト（取得できた分で続行）")
            tanFuku = call("KS.parseTanFuku(document)")
            val n = count(tanFuku)
            log("  単複オッズ: ${n}頭取得")
            step("tanfuku", if (n > 0) "ok" else "warn", "${n}頭")
        } else {
            step("tanfuku", "warn", "開けず")
        }

        // ---- ワイド ----
        step("wide", "run", "")
        var wide = "[]"
        if (load(oddsUrl + "b5")) {
            waitFor("document.querySelector('td.Odds[cart-item]')")
            wide = call("KS.topCombos(KS.extractCombos(document, {}))")
            val n = count(wide, true)
            log("  ワイド: ${n}組取得")
            step("wide", if (n > 0) "ok" else "warn", "${n}組")
        } else {
            step("wide", "warn", "開けず")
        }

        // ---- 三連複：まず上位人気一覧（1ページ）から読み、読めなければ軸ごとの表から集める ----
        step("sanren", "run", "")
        var sanren = "[]"
        var sanrenNote = ""
        if (load(oddsUrl + "b0")) {
            waitFor("document.body && document.body.innerText.includes('3連複')")
            sanren = call("KS.parseNinkiSanren(document)")
        }
        if (count(sanren, true) > 0) {
            val n = count(sanren, true)
            log("  三連複: ${n}組取得（上位人気一覧）")
            step("sanren", "ok", "${n}組")
        } else {
            log("  上位人気一覧から読めなかったため、軸ごとの表から集めます")
            sanren = "[]"
            if (load(oddsUrl + "b7")) {
                waitFor("document.querySelector('td.Odds[cart-item]')")
                call("(window.__ksAll = KS.extractCombos(document, {}), true)")
                val axes = runCatching { JSONArray(call("KS.axisValues(document)")) }.getOrNull() ?: JSONArray()
                var skipped = 0
                for (i in 0 until axes.length()) {
                    step("sanren", "run", "軸 ${i + 1}/${axes.length()}")
                    val before = decodeString(call("KS.comboSignature(document)"))
                    waitInterval()
                    call("KS.selectAxis(document, ${q(axes.getString(i))})")
                    // 切替前の表にも同じ要素があるため、中身が変わりオッズの数字が入るまで待つ
                    if (waitFor("KS.comboChanged(document, ${q(before)})")) {
                        call("(KS.extractCombos(document, window.__ksAll), true)")
                    } else {
                        skipped++
                    }
                }
                if (skipped > 0) {
                    sanrenNote = "三連複オッズは軸 ${axes.length()}頭中 ${skipped}頭分の表を読めなかった（人気上位10組が不完全な可能性）"
                    log("  ※$sanrenNote")
                }
                sanren = call("KS.topCombos(window.__ksAll || {})")
            }
            val n = count(sanren, true)
            log("  三連複: ${n}組取得（軸ごとの表）")
            step("sanren", if (n > 0 && sanrenNote.isEmpty()) "ok" else "warn", "${n}組")
        }

        // ---- テキスト作成 ----
        step("build", "run", "")
        val now = Date()
        val collectedAt = Jst.format("yyyy-MM-dd HH:mm:ss", now)
        val parts = """{"keibajo":${q(keibajo)},"race_date":${q(raceDate)},"race_no":$raceNo,""" +
            """"shutuba":$shutuba,"keibago":${safeObj(keibago)},"tan_fuku":${safeObj(tanFuku)},""" +
            """"wide":${safeArr(wide)},"sanren":${safeArr(sanren)},"sanren_note":${q(sanrenNote)},""" +
            """"collected_at":${q(collectedAt)},"day_results":$dayResults}"""
        val built = call("KS.buildWithInfo($parts)")
        val obj = runCatching { JSONObject(built) }.getOrNull()
        if (obj == null || !obj.has("text")) {
            log("テキストの作成に失敗しました: ${built.take(200)}")
            step("build", "ng", "")
            return Outcome(null, "テキストの作成に失敗しました。詳細ログを確認してください。")
        }
        obj.put("at", Jst.format("yyyy-MM-dd HH:mm", now))
        step("build", "ok", "${obj.getString("text").lines().size}行")
        return Outcome(obj.toString(), null)
    }

    // 解析に失敗した部品（{__error} や null）は空として扱う
    private fun safeObj(raw: String): String =
        if (raw.startsWith("{") && !raw.contains("\"__error\"")) raw else "{}"

    private fun safeArr(raw: String): String = if (raw.startsWith("[")) raw else "[]"
}
