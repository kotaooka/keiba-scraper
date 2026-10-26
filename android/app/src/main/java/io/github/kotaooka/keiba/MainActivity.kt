package io.github.kotaooka.keiba

import android.annotation.SuppressLint
import android.app.Activity
import android.Manifest
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import org.json.JSONObject
import java.io.File

/**
 * 画面は assets/ui.html（UI 用の WebView）で描き、収集は裏の WebView（Scraper）で行う。
 * UI → Kotlin は Bridge（window.Android）、Kotlin → UI は App.xxx() の呼び出し。
 */
class MainActivity : Activity() {

    private val scope: CoroutineScope = MainScope()
    private var job: Job? = null
    // 今の job が何か（"list" 一覧の読み込み / "collect" 収集 / "results" 結果の取得）
    private var jobKind = ""

    private lateinit var ui: WebView
    private lateinit var work: WebView
    private lateinit var scraper: Scraper
    private lateinit var updater: Updater
    private var updateJob: Job? = null
    private var debug = false
    // 画面がダーク表示か（UI のテーマ切替で決まる。未設定なら端末の設定に従う）
    private var uiDark: Boolean? = null
    // 通知から開いたときに、画面の読み込み後に UI へ渡す内容
    private var pendingOpen: String? = null
    private var pageReady = false
    // 画面の読み込み前に届いた UI への呼び出し（読み込み後にまとめて実行する）
    private val pendingJs = mutableListOf<String>()
    // 書き出し先を選んでもらっている間の、書き出す中身。アプリが裏で落とされても残るようファイルに置く
    private val pendingExportFile get() = File(filesDir, "pending_export.json")

    companion object {
        private const val REQ_EXPORT = 21
        private const val REQ_IMPORT = 22
        private const val MAX_IMPORT = 20 * 1024 * 1024
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 裏で収集する WebView は画面いっぱいの大きさで UI の下に置く
        // （大きさが 0 だとページ側の描画が止まることがあるため）
        work = WebView(this)
        ui = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true  // 収集済みの記録（localStorage）に使う
            settings.allowFileAccess = false
            setBackgroundColor(Color.TRANSPARENT)
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) {
                    pageReady = true
                    pendingJs.forEach { view.evaluateJavascript(it, null) }
                    pendingJs.clear()
                    applyTheme()
                    deliverPendingOpen()
                }

                // 画面の WebView のレンダラーが落ちたら、アプリを落とさずに画面を作り直す
                override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                    recreate()
                    return true
                }
            }
            addJavascriptInterface(Bridge(), "Android")
        }
        val root = FrameLayout(this).apply {
            fitsSystemWindows = true
            addView(work, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(ui, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        setContentView(root)
        applySystemBars()
        updater = Updater(this)

        val ks = assets.open("scraper.js").bufferedReader(Charsets.UTF_8).use { it.readText() }
        scraper = Scraper(work, ks,
            log = { line -> js("App.onLog(${JSONObject.quote(line)})") },
            step = { key, s, detail -> js("App.onStep(${JSONObject.quote(key)},${JSONObject.quote(s)},${JSONObject.quote(detail)})") })

        Notifier.ensureChannels(this)
        // 最近使ったアプリから開き直したときは、前に通知から開いたときの内容をもう一度実行しない
        val fromHistory = intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0
        if (savedInstanceState == null && !fromHistory) readOpenIntent(intent)
        // 収集済みの記録は ui.html の localStorage（この端末のアプリ内だけ）に置く
        ui.loadUrl("file:///android_asset/ui.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        readOpenIntent(intent)
        deliverPendingOpen()
    }

    // 戻ってきたら、自動収集の結果・予約・送り先を UI に読み直させる
    override fun onResume() {
        super.onResume()
        // 「アラームとリマインダー」を許可して戻ってきたときなどに、予約を正確な時刻で登録し直す
        Reservations.rescheduleAll(this)
        ResultChecks.rescheduleAll(this)
        if (pageReady) js("App.onResume()")
    }

    /** 通知のタップで開いたときの内容（open / collect と予約）を取り出す */
    private fun readOpenIntent(i: Intent?) {
        val type = i?.getStringExtra("open_type") ?: return
        val r = i.getStringExtra("reservation") ?: return
        pendingOpen = runCatching { JSONObject().put("type", type).put("r", JSONObject(r)).toString() }.getOrNull()
        i.removeExtra("open_type")
    }

    private fun deliverPendingOpen() {
        val p = pendingOpen ?: return
        if (!pageReady) return
        pendingOpen = null
        js("App.onResume(); App.openFromNotification($p)")
    }

    @Deprecated("書き出し先の選択（保存先の画面）から戻ったとき")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        // ファイルの読み書きはクラウドのファイルだと時間がかかるので、裏のスレッドで行う
        if (requestCode == REQ_IMPORT) {
            val uri = data?.data
            if (resultCode != RESULT_OK || uri == null) { js("App.onImported(null, '')"); return }
            scope.launch {
                val script = withContext(Dispatchers.IO) {
                    try {
                        val bytes = contentResolver.openInputStream(uri)?.use { s ->
                            val b = s.readNBytesCompat(MAX_IMPORT + 1)
                            b
                        } ?: ByteArray(0)
                        if (bytes.size > MAX_IMPORT) "App.onImported(null, ${JSONObject.quote("ファイルが大きすぎます")})"
                        else "App.onImported(${JSONObject.quote(bytes.toString(Charsets.UTF_8).removePrefix("\uFEFF"))}, null)"
                    } catch (e: Exception) {
                        "App.onImported(null, ${JSONObject.quote(e.message ?: "")})"
                    }
                }
                js(script)
            }
            return
        }
        if (requestCode != REQ_EXPORT) return
        val f = pendingExportFile
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null || !f.exists()) { f.delete(); js("App.onExported(false, '')"); return }
        scope.launch {
            val script = withContext(Dispatchers.IO) {
                try {
                    contentResolver.openOutputStream(uri)?.use { out -> f.inputStream().use { it.copyTo(out) } }
                    "App.onExported(true, '')"
                } catch (e: Exception) {
                    "App.onExported(false, ${JSONObject.quote(e.message ?: "")})"
                } finally {
                    f.delete()
                }
            }
            js(script)
        }
    }

    /** 上限までだけ読む（大きすぎるファイルでメモリを使い切らないように） */
    private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        while (out.size() < limit) {
            val n = read(buf, 0, minOf(buf.size, limit - out.size()))
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }

    override fun onDestroy() {
        scope.cancel()
        ui.destroy()
        work.destroy()
        super.onDestroy()
    }

    // 回転・ダークモード切替では画面を作り直さない（収集を止めないため）。表示色だけ合わせる
    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyTheme()
        applySystemBars()
    }

    @Deprecated("戻る操作は UI 側で判断する")
    override fun onBackPressed() {
        ui.evaluateJavascript("App.back()") { handled ->
            if (handled != "true") {
                @Suppress("DEPRECATION")
                super.onBackPressed()
            }
        }
    }

    private fun isDark(): Boolean =
        (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    /** 端末のダークモードの状態を UI に伝える（UI 側で「自動」のときに使う） */
    private fun applyTheme() = js("App.setSystemDark(${isDark()})")

    /** ステータスバー・ナビゲーションバーを画面の背景色（DESIGN.md の --bg）に合わせる */
    @Suppress("DEPRECATION")
    private fun applySystemBars() {
        val dark = uiDark ?: isDark()
        val bg = if (dark) Color.parseColor("#12100e") else Color.parseColor("#f2ebdf")
        window.statusBarColor = bg
        window.navigationBarColor = bg
        window.decorView.setBackgroundColor(bg)
        var flags = window.decorView.systemUiVisibility
        flags = if (dark) flags and View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR.inv() else flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            flags = if (dark) flags and View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR.inv() else flags or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
        }
        window.decorView.systemUiVisibility = flags
    }

    /** UI 側の JavaScript を実行する（どのスレッドから呼んでもよい） */
    private fun js(script: String) {
        runOnUiThread {
            if (isDestroyed) return@runOnUiThread
            if (pageReady) ui.evaluateJavascript(script, null) else pendingJs.add(script)
        }
    }

    private fun setBusy(busy: Boolean) {
        // 収集中は画面を消さない（WebView の読み込みが止まらないように）
        if (busy) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    /** 不具合調査用：画面の下半分に、収集用の WebView が開いているページを出す */
    private fun applyDebug() {
        val h = resources.displayMetrics.heightPixels
        ui.layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, if (debug) h / 2 else MATCH_PARENT, Gravity.TOP)
        work.layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, if (debug) h / 2 else MATCH_PARENT,
            if (debug) Gravity.BOTTOM else Gravity.TOP)
    }

    // ========== UI から呼ばれる（JavaScript のスレッドで呼ばれるので UI スレッドへ移す） ==========

    inner class Bridge {
        /**
         * 開催一覧を読む。patMonth（"202610" など）が空でなければ、続けて即PAT・A-PAT の発売カレンダーも読む
         * （UI 側で6時間以内に読んだ月は空にして渡す。カレンダーは月に1ページ）
         */
        @JavascriptInterface
        fun loadRaceList(date: String, patMonth: String) = runOnUiThread {
            // 前の読み込み・収集が残っていれば止めてから読む（日付を続けて変えたときなど）
            job?.cancel()
            jobKind = "list"
            job = scope.launch {
                val list = try { scraper.fetchRaceList(date) } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
                js("App.onRaceList(${list ?: "null"})")
                if (patMonth.isNotEmpty()) {
                    val cal = try { scraper.fetchPatCalendar(patMonth) } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
                    js("App.onPatCalendar(${JSONObject.quote(patMonth)}, ${cal ?: "null"})")
                }
            }
        }

        @JavascriptInterface
        fun collect(keibajo: String, date: String, raceNo: Int) = runOnUiThread {
            val prev = job
            prev?.cancel()
            jobKind = "collect"
            job = scope.launch {
                val me = coroutineContext[Job]
                // 前の処理が鍵を返すのを待ってから始める（すぐに tryLock すると「実行中」と断られることがある）
                prev?.cancelAndJoin()
                // 自動収集の実行中は重ねない（同じサイトへ同時にアクセスしないため）
                if (!CollectLock.mutex.tryLock()) {
                    js("App.onResult(null, ${JSONObject.quote("自動収集の実行中です。終わってからもう一度試してください。")})")
                    return@launch
                }
                setBusy(true)
                try {
                    val out = scraper.collectRace(keibajo, date, raceNo)
                    if (out.json != null) {
                        // コピーは UI 側で行う（指示文を今の予想の条件で書き直してから写すため）
                        js("App.onResult(${out.json})")
                    } else {
                        js("App.onResult(null, ${JSONObject.quote(out.error ?: "")})")
                    }
                } catch (e: CancellationException) {
                    // 別のレースの収集に置き換わったときは、新しい画面に「中止」を出さない
                    if (job === me) js("App.onResult(null, 'cancel')")
                    throw e
                } catch (e: Exception) {
                    js("App.onResult(null, ${JSONObject.quote("エラー: ${e.message}")})")
                } finally {
                    CollectLock.mutex.unlock()
                    setBusy(false)
                }
            }
        }

        @JavascriptInterface
        fun cancel() = runOnUiThread { job?.cancel() }

        // ---- 予想の記録と答え合わせ ----

        /** クリップボードの文字（AI の回答を貼り戻すため） */
        @JavascriptInterface
        fun readClipboard(): String {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = cm.primaryClip ?: return ""
            if (clip.itemCount == 0) return ""
            return clip.getItemAt(0).coerceToText(this@MainActivity)?.toString() ?: ""
        }

        /**
         * 結果ページを順に読む（race_id の JSON 配列）。1件ごとに App.onRaceResult、最後に App.onResultsDone。
         * 開催一覧の読み込みや収集の最中は重ねない
         */
        @JavascriptInterface
        fun fetchResults(idsJson: String) = runOnUiThread {
            // 一覧の読み込み中なら終わるのを待つ（通知から開いた直後など）。収集・結果の取得中は断る
            val prev = job
            if (prev?.isActive == true && jobKind != "list") { js("App.onResultsDone('busy')"); return@runOnUiThread }
            val ids = runCatching { org.json.JSONArray(idsJson) }.getOrNull() ?: org.json.JSONArray()
            jobKind = "results"
            job = scope.launch {
                try { prev?.join() } catch (e: CancellationException) { js("App.onResultsDone('cancel')"); throw e }
                if (!CollectLock.mutex.tryLock()) { js("App.onResultsDone('busy')"); return@launch }
                setBusy(true)
                try {
                    for (i in 0 until ids.length()) {
                        val id = ids.getString(i)
                        val res = try { scraper.fetchResult(id) } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
                        js("App.onRaceResult(${JSONObject.quote(id)}, ${res ?: "null"})")
                    }
                    js("App.onResultsDone(null)")
                } catch (e: CancellationException) {
                    js("App.onResultsDone('cancel')")
                    throw e
                } finally {
                    CollectLock.mutex.unlock()
                    setBusy(false)
                }
            }
        }

        /** 結果の自動取得を予約する（AI の回答を記録したとき） */
        @JavascriptInterface
        fun scheduleResultCheck(json: String): String = try {
            ResultChecks.set(this@MainActivity, JSONObject(json))
            JSONObject().put("ok", true).put("exact", Reservations.exactAllowed(this@MainActivity)).toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).toString()
        }

        @JavascriptInterface
        fun cancelResultCheck(key: String) = ResultChecks.remove(this@MainActivity, key)

        @JavascriptInterface
        fun takeRaceResults(): String = RaceResults.take(this@MainActivity)

        /** 書き出した記録のファイルを選んでもらい、中身を App.onImported に渡す */
        @JavascriptInterface
        fun importRecords() = runOnUiThread {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/plain", "application/octet-stream"))
            }
            @Suppress("DEPRECATION")
            startActivityForResult(intent, REQ_IMPORT)
        }

        /** 記録を JSON のファイルに書き出す（保存先は端末の画面で選んでもらう） */
        @JavascriptInterface
        fun exportRecords(json: String, fileName: String) = runOnUiThread {
            pendingExportFile.writeText(json)
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/json"
                putExtra(Intent.EXTRA_TITLE, fileName)
            }
            @Suppress("DEPRECATION")
            startActivityForResult(intent, REQ_EXPORT)
        }

        @JavascriptInterface
        fun copy(text: String) = runOnUiThread { copyText(text) }

        /**
         * AI アプリへ送る。choose=false なら前回選んだアプリへ直接送り、
         * choose=true か、まだ選んでいない・アプリが無いときは共有メニューを出して、選んだアプリを覚える
         */
        @JavascriptInterface
        fun share(text: String, choose: Boolean) = runOnUiThread {
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
            val target = ShareTarget.get(this@MainActivity)
            if (!choose && target != null) {
                try {
                    startActivity(Intent(send).setComponent(target))
                    return@runOnUiThread
                } catch (e: ActivityNotFoundException) {
                    // アンインストールされていたら選び直してもらう
                } catch (e: SecurityException) {
                }
            }
            val chosen = PendingIntent.getBroadcast(this@MainActivity, 0,
                Intent(this@MainActivity, ShareChosenReceiver::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            startActivity(Intent.createChooser(send, "AI アプリへ送る（選んだアプリを次から使います）", chosen.intentSender))
        }

        @JavascriptInterface
        fun shareTarget(): String = ShareTarget.label(this@MainActivity)

        // ---- 通知・自動収集の予約 ----

        @JavascriptInterface
        fun getReservations(): String = org.json.JSONArray(Reservations.list(this@MainActivity)).toString()

        @JavascriptInterface
        fun setReservation(json: String): String {
            return try {
                Reservations.set(this@MainActivity, JSONObject(json))
                JSONObject().put("ok", true).put("exact", Reservations.exactAllowed(this@MainActivity))
                    .put("notif", Notifier.allowed(this@MainActivity)).toString()
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", e.message).toString()
            }
        }

        @JavascriptInterface
        fun removeReservation(key: String) = Reservations.remove(this@MainActivity, key)

        @JavascriptInterface
        fun takeBackgroundResults(): String = BackgroundResults.take(this@MainActivity)

        @JavascriptInterface
        fun exactAlarmAllowed(): Boolean = Reservations.exactAllowed(this@MainActivity)

        @JavascriptInterface
        fun openExactAlarmSettings() = runOnUiThread {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, android.net.Uri.parse("package:$packageName")))
            }
        }

        @JavascriptInterface
        fun notificationsAllowed(): Boolean = Notifier.allowed(this@MainActivity)

        @JavascriptInterface
        fun requestNotifications() = runOnUiThread {
            if (Build.VERSION.SDK_INT >= 33) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }

        /** UI のテーマが決まったら、ステータスバーの色も合わせる */
        @JavascriptInterface
        fun setBarsDark(dark: Boolean) = runOnUiThread {
            uiDark = dark
            applySystemBars()
        }

        // ---- 版情報と更新 ----

        @JavascriptInterface
        fun appInfo(): String = updater.currentInfo().toString()

        @JavascriptInterface
        fun checkUpdate() = runOnUiThread {
            scope.launch {
                try {
                    val latest = updater.fetchLatest()
                    js("App.onUpdateInfo($latest, null)")
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    js("App.onUpdateInfo(null, ${JSONObject.quote(e.message ?: e.javaClass.simpleName)})")
                }
            }
        }

        @JavascriptInterface
        fun installUpdate(versionName: String) = runOnUiThread {
            if (updateJob?.isActive == true) return@runOnUiThread
            if (!updater.canInstall()) {
                // 初回は「この提供元のアプリを許可」が要る。設定画面から戻ったら、もう一度押してもらう
                updater.openInstallPermissionSettings()
                js("App.onUpdateState('permission', '')")
                return@runOnUiThread
            }
            updateJob = scope.launch {
                try {
                    js("App.onUpdateState('download', '0')")
                    updater.downloadAndInstall(versionName) { pct -> js("App.onUpdateState('download', '$pct')") }
                    js("App.onUpdateState('install', '')")
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    js("App.onUpdateState('error', ${JSONObject.quote(e.message ?: e.javaClass.simpleName)})")
                }
            }
        }

        /** ブラウザでページを開く（https のみ。即PAT の入口・リリースページなど） */
        @JavascriptInterface
        fun openUrl(url: String) = runOnUiThread {
            val uri = android.net.Uri.parse(url)
            if (uri.scheme != "https") return@runOnUiThread
            try {
                startActivity(Intent(Intent.ACTION_VIEW, uri))
            } catch (e: ActivityNotFoundException) {
                android.widget.Toast.makeText(this@MainActivity, "ブラウザが見つかりません", android.widget.Toast.LENGTH_SHORT).show()
            }
        }

        @JavascriptInterface
        fun setDebug(on: Boolean) = runOnUiThread {
            debug = on
            applyDebug()
        }
    }

    private fun copyText(text: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("地方競馬データ収集", text))
    }
}
