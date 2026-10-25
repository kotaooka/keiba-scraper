package io.github.kotaooka.keiba

import android.app.Activity
import android.app.DatePickerDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.webkit.WebView
import android.widget.Button
import android.widget.CheckBox
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.Calendar

/**
 * 画面：日付を選ぶ → 開催一覧を読む → 競馬場・レースを選ぶ → 収集 → コピー/共有。
 * PC版の対話（run.bat）に相当する。
 */
class MainActivity : Activity() {

    private val scope: CoroutineScope = MainScope()
    private var job: Job? = null

    private lateinit var scraper: Scraper
    private lateinit var web: WebView
    private lateinit var dateButton: Button
    private lateinit var loadButton: Button
    private lateinit var venueBar: LinearLayout
    private lateinit var raceList: LinearLayout
    private lateinit var logView: TextView
    private lateinit var resultView: TextView
    private lateinit var actionBar: LinearLayout
    private lateinit var scroll: ScrollView

    private var raceDate = today()
    private var venues: List<Scraper.Venue> = emptyList()
    private var resultText = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        val ks = assets.open("scraper.js").bufferedReader(Charsets.UTF_8).use { it.readText() }
        scraper = Scraper(web, ks) { appendLog(it) }
        updateDateButton()
    }

    override fun onDestroy() {
        scope.cancel()
        web.destroy()
        super.onDestroy()
    }

    // ========== 画面の組み立て ==========

    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(12))
            // 画面上端のステータスバーに重ならないようにする
            fitsSystemWindows = true
        }

        val top = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        dateButton = Button(this).apply { setOnClickListener { pickDate() } }
        loadButton = Button(this).apply {
            text = "開催を読む"
            setOnClickListener { loadRaceList() }
        }
        top.addView(dateButton, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        top.addView(loadButton, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        root.addView(top)

        venueBar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        root.addView(HorizontalScrollView(this).apply { addView(venueBar) })

        raceList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(raceList)

        logView = TextView(this).apply {
            textSize = 12f
            setTextIsSelectable(true)
        }
        root.addView(logView, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(8) })

        actionBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            visibility = View.GONE
        }
        actionBar.addView(Button(this).apply {
            text = "コピー"
            setOnClickListener { copyResult() }
        }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        actionBar.addView(Button(this).apply {
            text = "共有（AIアプリへ）"
            setOnClickListener { shareResult() }
        }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        root.addView(actionBar)

        resultView = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 9f
            setTextIsSelectable(true)
            setHorizontallyScrolling(true)
        }
        root.addView(HorizontalScrollView(this).apply { addView(resultView) })

        // 不具合調査用：読み込んだページをそのまま表示する
        web = WebView(this)
        val webParams = LinearLayout.LayoutParams(MATCH_PARENT, 1)
        root.addView(CheckBox(this).apply {
            text = "読み込み中のページを表示（不具合調査用）"
            textSize = 12f
            setOnCheckedChangeListener { _, on ->
                webParams.height = if (on) dp(480) else 1
                web.layoutParams = webParams
            }
        }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(16) })
        root.addView(web, webParams)

        scroll = ScrollView(this).apply { addView(root) }
        setContentView(scroll)
    }

    // ========== 日付 ==========

    private fun today(): String {
        val c = Calendar.getInstance()
        return "%04d%02d%02d".format(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
    }

    private fun updateDateButton() {
        dateButton.text = "${raceDate.substring(0, 4)}/${raceDate.substring(4, 6)}/${raceDate.substring(6)}"
    }

    private fun pickDate() {
        DatePickerDialog(this, { _, y, m, d ->
            raceDate = "%04d%02d%02d".format(y, m + 1, d)
            updateDateButton()
            loadRaceList()
        }, raceDate.substring(0, 4).toInt(), raceDate.substring(4, 6).toInt() - 1, raceDate.substring(6).toInt()).show()
    }

    // ========== 開催一覧・レース選択 ==========

    private fun setBusy(busy: Boolean) {
        dateButton.isEnabled = !busy
        loadButton.isEnabled = !busy
        for (i in 0 until venueBar.childCount) venueBar.getChildAt(i).isEnabled = !busy
        for (i in 0 until raceList.childCount) raceList.getChildAt(i).isEnabled = !busy
        // 収集中は画面を消さない（WebView の読み込みが止まらないように）
        if (busy) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun loadRaceList() {
        if (job?.isActive == true) return
        venueBar.removeAllViews()
        raceList.removeAllViews()
        logView.text = ""
        job = scope.launch {
            setBusy(true)
            appendLog("開催一覧を読み込み中…")
            val list = scraper.fetchRaceList(raceDate)
            setBusy(false)
            if (list.isNullOrEmpty()) {
                appendLog("この日の開催が見つかりませんでした（開催なし、または読み込み失敗）。")
                return@launch
            }
            venues = list
            logView.text = ""
            for (v in list) {
                venueBar.addView(Button(this@MainActivity).apply {
                    text = "${v.name}\n${v.races.size}R"
                    textSize = 13f
                    setOnClickListener { showRaces(v) }
                })
            }
            if (list.size == 1) showRaces(list[0])
        }
    }

    /** 発走前で最も早いレースの位置（当日以外は先頭）。PC版の next_race_index と同じ */
    private fun nextRaceIndex(races: List<Scraper.Race>): Int {
        if (raceDate != today()) return 0
        val c = Calendar.getInstance()
        val now = c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE)
        races.forEachIndexed { i, r ->
            val m = Regex("""^(\d{1,2}):(\d{2})$""").find(r.time)
            if (m != null && m.groupValues[1].toInt() * 60 + m.groupValues[2].toInt() > now) return i
        }
        return races.size - 1
    }

    private fun showRaces(v: Scraper.Venue) {
        raceList.removeAllViews()
        raceList.addView(TextView(this).apply {
            text = "${v.name} のレース（タップで収集）"
            textSize = 14f
            setPadding(0, dp(8), 0, dp(4))
        })
        val next = nextRaceIndex(v.races)
        v.races.forEachIndexed { i, r ->
            val mark = if (i == next && raceDate == today()) "  ← 次" else ""
            raceList.addView(Button(this).apply {
                text = "%2dR  %5s  %s  %s頭%s".format(r.no, r.time, r.title, r.heads, mark)
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                isAllCaps = false
                setOnClickListener { collect(v.name, r.no) }
            })
        }
    }

    // ========== 収集 ==========

    private fun collect(keibajo: String, raceNo: Int) {
        if (job?.isActive == true) return
        logView.text = ""
        resultView.text = ""
        actionBar.visibility = View.GONE
        job = scope.launch {
            setBusy(true)
            val text = try {
                scraper.collectRace(keibajo, raceDate, raceNo)
            } finally {
                setBusy(false)
            }
            if (text == null) {
                appendLog("収集できませんでした。")
                return@launch
            }
            resultText = text
            resultView.text = text
            actionBar.visibility = View.VISIBLE
            copyResult()
            appendLog("★ 完了。「共有」から AI アプリへ送るか、コピー済みのテキストを貼り付けてください。")
            scroll.post { scroll.smoothScrollTo(0, actionBar.top) }
        }
    }

    private fun appendLog(line: String) {
        logView.append(if (logView.text.isEmpty()) line else "\n$line")
    }

    private fun copyResult() {
        if (resultText.isEmpty()) return
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("地方競馬 収集", resultText))
        Toast.makeText(this, "コピーしました", Toast.LENGTH_SHORT).show()
    }

    private fun shareResult() {
        if (resultText.isEmpty()) return
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, resultText)
        }
        startActivity(Intent.createChooser(send, "AI アプリへ送る"))
    }
}
