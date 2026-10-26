package io.github.kotaooka.keiba

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.webkit.WebView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject

/**
 * 予約したレースを裏で1回だけ処理する（アプリを閉じていても動くよう、通知を出して常駐する）。
 * - 自動収集：画面からの収集と同じ Scraper で集め、BackgroundResults に置いて通知する
 * - 答え合わせ（mode=result）：結果ページを読み、記録した買い目で的中・不的中を通知する
 * 複数の依頼が重なってもよいように、動いている件数を数え、最後の1件が終わったときにだけ止まる。
 */
class CollectService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var running = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifier.ensureChannels(this)
        val r = runCatching { JSONObject(intent?.getStringExtra("reservation") ?: "") }.getOrNull()
        val title = r?.let { Reservations.titleOf(it) } ?: ""
        val resultMode = intent?.getStringExtra("mode") == "result"

        // startForegroundService で起こされたら、何もしないときでも先に startForeground を呼ぶ（呼ばないと落とされる）
        val ongoing = Notification.Builder(this, Notifier.CHANNEL_RUN)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(if (resultMode) "答え合わせ中：$title" else "自動収集中：$title")
            .setContentText(if (resultMode) "レースの結果を取得しています" else "出馬表・オッズ・過去5走を集めています")
            .setOngoing(true)
            .build()
        // 常駐の通知は1つの番号を使い回す（レースごとに変えると、止めたときに前の通知が残る）
        startForeground(FOREGROUND_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)

        if (r == null) { finishOne(); return START_NOT_STICKY }
        running++
        scope.launch {
            try {
                if (resultMode) checkResult(r, title) else collect(r, title)
            } finally {
                running--
                finishOne()
            }
        }
        return START_NOT_STICKY
    }

    /** 動いている依頼がなくなったら止まる */
    private fun finishOne() {
        if (running > 0) return
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** 収集用の WebView を1回分だけ作り、終わったら壊す */
    private suspend fun <T> withScraper(block: suspend (Scraper) -> T): T {
        val w = WebView(this)
        try {
            val ks = assets.open("scraper.js").bufferedReader(Charsets.UTF_8).use { it.readText() }
            return block(Scraper(w, ks, log = {}, step = { _, _, _ -> }))
        } finally {
            w.stopLoading()
            w.destroy()
        }
    }

    private suspend fun collect(r: JSONObject, title: String) {
        val key = r.optString("key")
        val outcome = if (!CollectLock.mutex.tryLock()) {
            Scraper.Outcome(null, "画面からの収集と重なったため、自動収集を見送りました")
        } else try {
            withScraper { scraper ->
                // 5分たっても終わらなければあきらめる
                withTimeoutOrNull(5 * 60_000L) {
                    scraper.collectRace(r.optString("venue"), r.optString("date"), r.optInt("no"))
                } ?: Scraper.Outcome(null, "時間内に終わりませんでした")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Scraper.Outcome(null, e.message ?: "エラー")
        } finally {
            CollectLock.mutex.unlock()
        }

        if (outcome.json != null) {
            val obj = JSONObject(outcome.json)
            BackgroundResults.add(this, key, obj)
            Notifier.post(this, "$key|done".hashCode(), "収集しました：$title",
                "${r.optString("time")} 発走。オッズは ${obj.optString("at").takeLast(5)} 時点。タップで開いて AI へ送れます",
                Notifier.openIntent(this, "open", r))
        } else {
            Notifier.post(this, "$key|done".hashCode(), "自動収集できませんでした：$title",
                "${outcome.error ?: ""}。タップすると開いて収集します", Notifier.openIntent(this, "collect", r))
        }
    }

    /** 結果ページを1回読み、記録した買い目で答え合わせして通知する。未確定ならあとで読み直す */
    private suspend fun checkResult(r: JSONObject, title: String) {
        val key = r.optString("key")
        val raceId = r.optString("race_id")
        if (!CollectLock.mutex.tryLock()) {
            // 画面からの収集と重なった。回数に数えずに少しあとで読み直す
            ResultChecks.retry(this, key, countTry = false)
            return
        }
        var message: String? = null
        try {
            message = withScraper { scraper ->
                val res = withTimeoutOrNull(2 * 60_000L) { scraper.fetchResult(raceId) } ?: return@withScraper null
                val bets = r.optJSONArray("bets") ?: JSONArray()
                val hitBets = r.optJSONArray("hit_bets")  // 的中重視の買い目（記録していなければ null）
                // 答え合わせは scraper.js の settleBets（PC版と同じ計算）で行う
                val judged = JSONObject(scraper.evalKs(
                    "(function(){const res=$res;if(!KS.resultFinished(res))return {finished:false};" +
                        "const rec={'結果':res,'AI':{'買い目':$bets,'的中買い目':${hitBets ?: "[]"}}};" +
                        "const rows=KS.settleBets(rec,'買い目');const hit=KS.settleBets(rec,'的中買い目');" +
                        "const top=Object.entries(res['着順']).filter(([,x])=>/^[123]$/.test(x)).sort((a,b)=>a[1]-b[1]).map(([n,x])=>x+'着 '+n+'番').join('・');" +
                        "return {finished:true,rows:rows,hit:hit,top:top};})()"))
                if (!judged.optBoolean("finished")) return@withScraper null
                RaceResults.add(this, raceId, JSONObject(res), Jst.stamp())
                val top = judged.optString("top")
                // 期待値重視と的中重視の両方を記録していれば、両方の収支を並べる
                val evText = summarize(judged.optJSONArray("rows"))
                val hitText = if (hitBets != null) summarize(judged.optJSONArray("hit")) else null
                when {
                    hitText == null -> "$evText。結果：$top"
                    bets.length() == 0 && r.optString("mode") == "hit" -> "$hitText。結果：$top"
                    else -> "期待値重視 $evText／的中重視 $hitText。結果：$top"
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // 読めなかったときは、あとで読み直す
        } finally {
            CollectLock.mutex.unlock()
        }

        if (message != null) {
            ResultChecks.remove(this, key)
            Notifier.post(this, "$key|result".hashCode(), "答え合わせ：$title", "$message。タップで予想の記録を開きます",
                Notifier.openIntent(this, "records", r))
        } else if (!ResultChecks.retry(this, key)) {
            Notifier.post(this, "$key|result".hashCode(), "答え合わせ：$title",
                "結果を自動で取得できませんでした。タップすると取得します", Notifier.openIntent(this, "fetch", r))
        }
    }

    /** 通知の文：「的中 +1,440円」「不的中 −1,000円」「見送り」 */
    private fun summarize(rows: JSONArray?): String = when {
        rows == null -> "払戻を読めない券種あり"
        rows.length() == 0 -> "見送り"
        else -> {
            var spent = 0; var ret = 0; var hit = 0
            for (i in 0 until rows.length()) {
                val x = rows.getJSONObject(i)
                spent += x.optInt("金額"); ret += x.optInt("払戻")
                if (x.optString("判定") == "的中") hit++
            }
            val d = ret - spent
            val sign = if (d >= 0) "+" else "−"
            if (hit > 0) "的中 $sign${"%,d".format(kotlin.math.abs(d))}円" else "不的中 −${"%,d".format(spent)}円"
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val FOREGROUND_ID = 7001
    }
}
