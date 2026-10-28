package io.github.kotaooka.keiba

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout

/**
 * 地方競馬ライブの映像専用版（simple.keiba-lv-st.jp）をアプリ内で開く画面。
 * ページそのものを表示するだけで、映像の URL を抜き出して再生することはしない。
 * - 縦向き：ページをそのまま画面幅に合わせて表示
 * - 横向き：映像を画面いっぱいに広げ、ステータスバーなどを隠す
 * 映像専用版のページ以外へのリンクは、ブラウザで開く。
 */
class LiveActivity : Activity() {

    private lateinit var web: WebView
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private lateinit var root: FrameLayout

    companion object {
        const val HOST = "simple.keiba-lv-st.jp"
        private const val EXTRA_TRACK = "track"

        /** 映像専用版の競馬場名（obihiro・kouchi など）。空なら競馬場を選ぶ一覧を開く */
        fun start(ctx: Context, track: String) {
            val t = if (Regex("^[a-z]{2,20}$").matches(track)) track else ""
            ctx.startActivity(Intent(ctx, LiveActivity::class.java).putExtra(EXTRA_TRACK, t))
        }

        // 横向きのときに映像だけを画面いっぱいにする（ページの幅は 700px 固定なので vw・vh で合わせる）
        private const val FILL_CSS =
            "video{position:fixed!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;" +
                "z-index:2147483646!important;background:#000!important;object-fit:contain!important}" +
                "body{overflow:hidden!important}"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 見ている間は画面を消さない
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        web = WebView(this).apply {
            setBackgroundColor(Color.BLACK)
            settings.javaScriptEnabled = true      // ページの映像プレイヤー（hls.js）が使う
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false  // 開いたらすぐ再生する
            settings.useWideViewPort = true        // ページは幅 700px 固定。画面幅に縮めて表示する
            settings.loadWithOverviewMode = true
            settings.allowFileAccess = false
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                    val u = req.url
                    if (u.scheme == "https" && u.host == HOST) return false
                    openOutside(u)
                    return true
                }

                override fun onPageFinished(view: WebView, url: String) = applyOrientation()

                override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                    finish()
                    return true
                }
            }
            // ページの全画面ボタンに応える
            webChromeClient = object : WebChromeClient() {
                override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                    if (customView != null) { callback.onCustomViewHidden(); return }
                    customView = view; customCallback = callback
                    root.addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
                    setImmersive(true)
                }

                override fun onHideCustomView() = hideCustom()
            }
        }
        root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        setContentView(root)
        val track = intent.getStringExtra(EXTRA_TRACK).orEmpty()
        web.loadUrl("https://$HOST/" + if (track.isNotEmpty()) "?track=$track" else "")
    }

    private fun hideCustom() {
        val v = customView ?: return
        root.removeView(v)
        customView = null
        customCallback?.onCustomViewHidden(); customCallback = null
        applyOrientation()
    }

    private fun openOutside(u: Uri) {
        if (u.scheme != "https" && u.scheme != "http") return
        try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (_: ActivityNotFoundException) {}
    }

    /** 横向きなら映像を広げてバーを隠す。縦向きなら元に戻す */
    private fun applyOrientation() {
        val land = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        val css = if (land) FILL_CSS else ""
        web.evaluateJavascript(
            "(function(){var s=document.getElementById('kz-fill');if(!s){s=document.createElement('style');s.id='kz-fill';" +
                "(document.head||document.documentElement).appendChild(s);}s.textContent=${org.json.JSONObject.quote(css)};})()", null)
        setImmersive(land || customView != null)
    }

    private fun setImmersive(on: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val c = window.insetsController ?: return
            if (on) {
                c.hide(WindowInsets.Type.systemBars())
                c.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else c.show(WindowInsets.Type.systemBars())
        } else {
            // Android 10 は insetsController がないので、従来の方法で隠す
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (on)
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            else 0
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyOrientation()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            customView != null -> hideCustom()
            web.canGoBack() -> web.goBack()
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    // 裏に回ったら音も止める（戻ると続きから）
    override fun onPause() { web.onPause(); super.onPause() }
    override fun onResume() { super.onResume(); web.onResume() }

    override fun onDestroy() {
        web.stopLoading()
        web.destroy()
        super.onDestroy()
    }
}
