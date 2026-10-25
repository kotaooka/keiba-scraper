package io.github.kotaooka.keiba

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.os.SystemClock
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.coroutines.resume

/**
 * WebView でページを開き、assets/scraper.js の解析関数を呼んでデータを集める。
 * PC版 keiba_scraper.py の fetch_page / collect_race に相当する。
 * すべて UI スレッドから呼ぶこと（WebView の制約）。
 */
class Scraper(private val web: WebView, private val ksSource: String, private val log: (String) -> Unit) {

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
            val result = withTimeoutOrNull(TIMEOUT_PAGE) { done.await() }
            pageLoaded = null
            when (result) {
                null -> log("  ページ取得タイムアウト（$attempt/${RETRY}回目）")
                "" -> return true
                else -> log("  ページ取得失敗（$attempt/${RETRY}回目）: $result")
            }
        }
        return false
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

    data class Race(val raceId: String, val no: Int, val time: String, val title: String, val heads: String)
    data class Venue(val name: String, val races: List<Race>)

    suspend fun fetchRaceList(raceDate: String): List<Venue>? {
        if (!load("$NETKEIBA/top/race_list_sub.html?kaisai_date=$raceDate")) return null
        waitFor("document.querySelector('dl.RaceList_DataList')", 5_000)
        val raw = call("KS.parseRaceList(document)")
        val arr = runCatching { JSONArray(raw) }.getOrNull() ?: return null
        return (0 until arr.length()).map { i ->
            val v = arr.getJSONObject(i)
            val races = v.getJSONArray("races")
            Venue(v.getString("name"), (0 until races.length()).map { j ->
                val r = races.getJSONObject(j)
                Race(r.getString("race_id"), r.getInt("no"), r.optString("time"), r.optString("title"), r.optString("heads"))
            })
        }
    }

    // ========== 1レース分の収集 ==========

    /** 収集して AI 貼り付け用テキストを返す。出馬表が取れなければ null */
    suspend fun collectRace(keibajo: String, raceDate: String, raceNo: Int): String? {
        val code = KEIBA_CODES[keibajo] ?: run { log("未対応の競馬場です: $keibajo"); return null }
        val raceId = "${raceDate.substring(0, 4)}$code${raceDate.substring(4, 8)}${"%02d".format(raceNo)}"
        val oddsUrl = "$NETKEIBA/odds/?race_id=$raceId&type="
        val notes = mutableListOf<String>()
        log("収集対象: $keibajo ${raceDate.substring(0, 4)}/${raceDate.substring(4, 6)}/${raceDate.substring(6)} ${raceNo}R（race_id: $raceId）")

        log("[出馬表]")
        if (!load("$NETKEIBA/race/shutuba.html?race_id=$raceId")) return null
        if (!waitFor("document.querySelector('table.ShutubaTable, dl.HorseList')")) log("  要素待機タイムアウト（取得できた分で続行）")
        val shutuba = call("KS.parseShutuba(document)")
        val nHorses = runCatching { JSONObject(shutuba).getJSONArray("horses").length() }.getOrDefault(0)
        log("  出馬表: ${nHorses}頭取得")
        if (nHorses == 0) {
            log("出馬表を取得できませんでした。日付・競馬場・レース番号を確認してください。")
            return null
        }

        log("[馬柱: keiba.go.jp]")
        var keibago = "{}"
        val kgUrl = decodeString(call("KS.keibagoUrl(${q(keibajo)}, ${q(raceDate)}, $raceNo)"))
        if (kgUrl.isEmpty()) {
            log("  keiba.go.jp のコード未定義のため取得しません: $keibajo")
        } else if (load(kgUrl)) {
            if (!waitFor("document.querySelector('section.cardTable')")) log("  要素待機タイムアウト（取得できた分で続行）")
            keibago = call("KS.parseKeibago(document)")
            log("  keiba.go.jp 解析: ${runCatching { JSONObject(keibago).length() }.getOrDefault(0)}頭")
        }

        log("[単勝・複勝オッズ]")
        var tanFuku = "{}"
        if (load(oddsUrl + "b1")) {
            waitFor("document.querySelector('table.RaceOdds_HorseList_Table td.Odds')")
            tanFuku = call("KS.parseTanFuku(document)")
            log("  単複オッズ: ${runCatching { JSONObject(tanFuku).length() }.getOrDefault(0)}頭取得")
        }

        log("[ワイドオッズ]")
        var wide = "[]"
        if (load(oddsUrl + "b5")) {
            waitFor("document.querySelector('td.Odds[cart-item]')")
            wide = call("KS.topCombos(KS.extractCombos(document, {}))")
            log("  ワイド: ${runCatching { JSONArray(wide).length() }.getOrDefault(0)}組取得")
        }

        log("[三連複オッズ]")
        var sanren = "[]"
        var sanrenNote = ""
        if (load(oddsUrl + "b7")) {
            waitFor("document.querySelector('td.Odds[cart-item]')")
            call("(window.__ksAll = KS.extractCombos(document, {}), true)")
            val axes = runCatching { JSONArray(call("KS.axisValues(document)")) }.getOrNull() ?: JSONArray()
            var skipped = 0
            // 三連複は軸馬ごとに表が切り替わるので、全軸馬を順に読む
            for (i in 1 until axes.length()) {
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
            log("  三連複: ${runCatching { JSONArray(sanren).length() }.getOrDefault(0)}組取得")
        }

        val collectedAt = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.JAPAN).format(Date())
        val parts = """{"keibajo":${q(keibajo)},"race_date":${q(raceDate)},"race_no":$raceNo,""" +
            """"shutuba":$shutuba,"keibago":${safeObj(keibago)},"tan_fuku":${safeObj(tanFuku)},""" +
            """"wide":${safeArr(wide)},"sanren":${safeArr(sanren)},"sanren_note":${q(sanrenNote)},""" +
            """"notes":${JSONArray(notes)},"collected_at":${q(collectedAt)}}"""
        val text = decodeString(call("KS.build($parts)"))
        if (text.isEmpty() || text.startsWith("{")) {
            log("テキストの作成に失敗しました: ${text.take(200)}")
            return null
        }
        return text
    }

    // 解析に失敗した部品（{__error} や null）は空として扱う
    private fun safeObj(raw: String): String =
        if (raw.startsWith("{") && !raw.contains("\"__error\"")) raw else "{}"

    private fun safeArr(raw: String): String = if (raw.startsWith("[")) raw else "[]"
}
