package io.github.kotaooka.keiba

import android.annotation.SuppressLint
import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.PackageManager
import android.graphics.drawable.GradientDrawable
import android.util.Rational
import android.util.TypedValue
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
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
 * - 小窓（ピクチャー・イン・ピクチャー）：映像を小さな窓で流したまま、アプリの画面に戻って操作できる。
 *   「小窓にして操作」・戻る操作・ホームへ移る操作で小窓になり、小窓を閉じると映像の画面も終わる
 * 映像専用版のページ以外へのリンクは、ブラウザで開く。
 * 小窓の間もアプリの画面を前に出せるよう、この画面はアプリの画面とは別のタスクで開く（AndroidManifest の taskAffinity）。
 */
class LiveActivity : Activity() {

    private lateinit var web: WebView
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private lateinit var root: FrameLayout
    private lateinit var bar: LinearLayout
    private var track = ""

    companion object {
        const val HOST = "simple.keiba-lv-st.jp"
        private const val EXTRA_TRACK = "track"

        /** 映像専用版の競馬場名（obihiro・kouchi など）。空なら競馬場を選ぶ一覧を開く */
        fun start(ctx: Context, track: String) {
            val t = if (Regex("^[a-z]{2,20}$").matches(track)) track else ""
            ctx.startActivity(Intent(ctx, LiveActivity::class.java).putExtra(EXTRA_TRACK, t)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }

        // 横向き・小窓のときに映像だけを画面いっぱいにする（ページの幅は 700px 固定なので vw・vh で合わせる）
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
                    hideBars(true)
                }

                override fun onHideCustomView() = hideCustom()
            }
        }
        // 縦向きの画面の下に「小窓にして操作」「閉じる」を置く（映像はページの上の方に出るので、下は空いている）
        bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(16), dp(10), dp(16), dp(16))
            if (canPip()) addView(barButton("小窓にして操作", primary = true) { toPip(showApp = true) },
                LinearLayout.LayoutParams(0, dp(52), 2f).apply { marginEnd = dp(8) })
            addView(barButton("閉じる", primary = false) { finish() }, LinearLayout.LayoutParams(0, dp(52), 1f))
        }
        root = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(web, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(bar, FrameLayout.LayoutParams(MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        }
        setContentView(root)
        updatePipParams()
        load(intent)
    }

    private fun load(i: Intent?) {
        track = i?.getStringExtra(EXTRA_TRACK).orEmpty()
        web.loadUrl("https://$HOST/" + if (track.isNotEmpty()) "?track=$track" else "")
    }

    // 小窓のまま、アプリから別の競馬場の映像を開いたとき（同じ競馬場なら読み直さずに大きく戻すだけ）
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val t = intent.getStringExtra(EXTRA_TRACK).orEmpty()
        if (t != track || t.isEmpty()) load(intent)
    }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    // アプリの暗い配色（ui.html のダーク表示）に合わせたボタン
    private fun barButton(label: String, primary: Boolean, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        textSize = 15f
        setTextColor(if (primary) Color.parseColor("#1a1206") else Color.parseColor("#f1e9dc"))
        background = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat()
            setColor(Color.parseColor(if (primary) "#f0a83a" else "#1e1a16"))
            if (!primary) setStroke(dp(1), Color.parseColor("#3a322a"))
        }
        stateListAnimator = null
        setOnClickListener { onClick() }
    }

    private fun canPip() = packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    // 小窓は 16:9。Android 12 以降はホームへ移る操作で自動的に小窓になる
    private fun updatePipParams() {
        if (!canPip()) return
        val b = PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) b.setAutoEnterEnabled(true)
        runCatching { setPictureInPictureParams(b.build()) }
    }

    /** 小窓にする。showApp なら、続けてアプリの画面を前に出す。小窓にできない端末では閉じる */
    private fun toPip(showApp: Boolean) {
        val ok = canPip() && runCatching {
            enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(Rational(16, 9)).build())
        }.getOrDefault(false)
        if (!ok) { finish(); return }
        if (showApp) {
            try {
                startActivity(Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
            } catch (_: Exception) {}
        }
    }

    // ホームボタンなどでほかへ移るとき（Android 11 以前。12 以降は setAutoEnterEnabled が受け持つ）
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S && canPip() && !isInPictureInPictureMode) toPip(showApp = false)
    }

    override fun onPictureInPictureModeChanged(inPip: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(inPip, newConfig)
        applyOrientation()
    }

    // 小窓を閉じた（×・下へ払う）ときは onStop が小窓のまま呼ばれる。映像の画面ごと終える
    override fun onStop() {
        super.onStop()
        if (isInPictureInPictureMode) finish()
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

    /** 横向き・小窓なら映像を広げてバーを隠す。縦向きなら元に戻す */
    private fun applyOrientation() {
        val pip = isInPictureInPictureMode
        val land = pip || resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        bar.visibility = if (land) View.GONE else View.VISIBLE
        val css = if (land) FILL_CSS else ""
        web.evaluateJavascript(
            "(function(){var s=document.getElementById('kz-fill');if(!s){s=document.createElement('style');s.id='kz-fill';" +
                "(document.head||document.documentElement).appendChild(s);}s.textContent=${org.json.JSONObject.quote(css)};})()", null)
        hideBars(land || customView != null)
    }

    private fun hideBars(on: Boolean) {
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
            // 戻る操作では閉じずに小窓にして、アプリの画面へ戻る
            else -> toPip(showApp = true)
        }
    }

    // 裏に回ったら音も止める（戻ると続きから）。小窓の間は流し続ける
    override fun onPause() { if (!isInPictureInPictureMode) web.onPause(); super.onPause() }
    override fun onResume() { super.onResume(); web.onResume() }

    override fun onDestroy() {
        web.stopLoading()
        web.destroy()
        super.onDestroy()
    }
}
