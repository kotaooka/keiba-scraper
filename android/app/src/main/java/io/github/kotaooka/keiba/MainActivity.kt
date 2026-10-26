package io.github.kotaooka.keiba

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
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
    private var debug = false

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
                override fun onPageFinished(view: WebView, url: String) = applyTheme()
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

        val ks = assets.open("scraper.js").bufferedReader(Charsets.UTF_8).use { it.readText() }
        scraper = Scraper(work, ks,
            log = { line -> js("App.onLog(${JSONObject.quote(line)})") },
            step = { key, s, detail -> js("App.onStep(${JSONObject.quote(key)},${JSONObject.quote(s)},${JSONObject.quote(detail)})") })

        // 収集済みの記録は ui.html の localStorage（この端末のアプリ内だけ）に置く
        ui.loadUrl("file:///android_asset/ui.html")
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

    private fun applyTheme() = js("App.setTheme('${if (isDark()) "dark" else "light"}')")

    /** ステータスバー・ナビゲーションバーを画面の背景色（DESIGN.md の --bg）に合わせる */
    @Suppress("DEPRECATION")
    private fun applySystemBars() {
        val dark = isDark()
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
                setBusy(true)
                try {
                    val out = scraper.collectRace(keibajo, date, raceNo)
                    if (out.json != null) {
                        copyText(JSONObject(out.json).getString("text"))
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
                    setBusy(false)
                }
            }
        }

        @JavascriptInterface
        fun cancel() = runOnUiThread { job?.cancel() }

        @JavascriptInterface
        fun copy(text: String) = runOnUiThread { copyText(text) }

        @JavascriptInterface
        fun share(text: String) = runOnUiThread {
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
            startActivity(Intent.createChooser(send, "AI アプリへ送る"))
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
