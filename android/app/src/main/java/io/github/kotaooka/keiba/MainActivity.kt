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
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * 画面は assets/ui.html（UI 用の WebView）で描き、収集は裏の WebView（Scraper）で行う。
 * UI → Kotlin は Bridge（window.Android）、Kotlin → UI は App.xxx() の呼び出し。
 */
class MainActivity : Activity() {

    private val scope: CoroutineScope = MainScope()
    private var job: Job? = null

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
                    applyTheme()
                    deliverPendingOpen()
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
        readOpenIntent(intent)
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
        runOnUiThread { ui.evaluateJavascript(script, null) }
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
        @JavascriptInterface
        fun loadRaceList(date: String) = runOnUiThread {
            // 前の読み込み・収集が残っていれば止めてから読む（日付を続けて変えたときなど）
            job?.cancel()
            job = scope.launch {
                val list = try { scraper.fetchRaceList(date) } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
                js("App.onRaceList(${list ?: "null"})")
            }
        }

        @JavascriptInterface
        fun collect(keibajo: String, date: String, raceNo: Int) = runOnUiThread {
            job?.cancel()
            job = scope.launch {
                val me = coroutineContext[Job]
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

        @JavascriptInterface
        fun openUrl(url: String) = runOnUiThread {
            startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url)))
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
