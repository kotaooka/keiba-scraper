package io.github.kotaooka.keiba

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.webkit.WebView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/**
 * 予約したレースを1回だけ自動で収集する（アプリを閉じていても動くよう、通知を出して常駐する）。
 * 収集の中身は画面からの収集と同じ Scraper。結果は BackgroundResults に置き、通知で知らせる。
 */
class CollectService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var web: WebView? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val r = runCatching { JSONObject(intent?.getStringExtra("reservation") ?: "") }.getOrNull()
        if (r == null) { stopSelf(); return START_NOT_STICKY }
        val title = Reservations.titleOf(r)
        val resultMode = intent?.getStringExtra("mode") == "result"

        Notifier.ensureChannels(this)
        val running = Notification.Builder(this, Notifier.CHANNEL_RUN)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(if (resultMode) "答え合わせ中：$title" else "自動収集中：$title")
            .setContentText(if (resultMode) "レースの結果を取得しています" else "出馬表・オッズ・過去5走を集めています")
            .setOngoing(true)
            .build()
        startForeground(r.optString("key").hashCode(), running, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)

        if (resultMode) {
            scope.launch { checkResult(r, title) }
            return START_NOT_STICKY
        }

        scope.launch {
            val key = r.optString("key")
            val outcome = if (!CollectLock.mutex.tryLock()) {
                Scraper.Outcome(null, "画面からの収集と重なったため、自動収集を見送りました")
            } else try {
                val w = WebView(this@CollectService).also { web = it }
                val ks = assets.open("scraper.js").bufferedReader(Charsets.UTF_8).use { it.readText() }
                val scraper = Scraper(w, ks, log = {}, step = { _, _, _ -> })
                // 5分たっても終わらなければあきらめる
                withTimeoutOrNull(5 * 60_000L) {
                    scraper.collectRace(r.optString("venue"), r.optString("date"), r.optInt("no"))
                } ?: Scraper.Outcome(null, "時間内に終わりませんでした")
            } catch (e: Exception) {
                Scraper.Outcome(null, e.message ?: "エラー")
            } finally {
                CollectLock.mutex.unlock()
            }

            if (outcome.json != null) {
                val obj = JSONObject(outcome.json)
                BackgroundResults.add(this@CollectService, key, obj)
                Notifier.post(this@CollectService, "$key|done".hashCode(), "収集しました：$title",
                    "${r.optString("time")} 発走。オッズは ${obj.optString("at").takeLast(5)} 時点。タップで開いて AI へ送れます",
                    Notifier.openIntent(this@CollectService, "open", r))
            } else {
                Notifier.post(this@CollectService, "$key|done".hashCode(), "自動収集できませんでした：$title",
                    "${outcome.error ?: ""}。タップすると開いて収集します", Notifier.openIntent(this@CollectService, "collect", r))
            }
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    /** 結果ページを1回読み、記録した買い目で答え合わせして通知する。未確定ならあとで読み直す */
    private suspend fun checkResult(r: JSONObject, title: String) {
        val key = r.optString("key")
        val raceId = r.optString("race_id")
        var finished = false
        var message = ""
        if (!CollectLock.mutex.tryLock()) {
            // 画面からの収集と重なったので、少しあとに読み直す
            ResultChecks.retry(this, key)
        } else try {
            val w = WebView(this).also { web = it }
            val ks = assets.open("scraper.js").bufferedReader(Charsets.UTF_8).use { it.readText() }
            val scraper = Scraper(w, ks, log = {}, step = { _, _, _ -> })
            val res = withTimeoutOrNull(2 * 60_000L) { scraper.fetchResult(raceId) }
            if (res != null) {
                val bets = r.optJSONArray("bets") ?: org.json.JSONArray()
                // 答え合わせは scraper.js の settleBets（PC版と同じ計算）で行う
                val judged = JSONObject(scraper.evalKs(
                    "(function(){const res=$res;if(!KS.resultFinished(res))return {finished:false};" +
                        "const rows=KS.settleBets({'結果':res,'AI':{'買い目':$bets}});" +
                        "const top=Object.entries(res['着順']).filter(([,x])=>/^[123]$/.test(x)).sort((a,b)=>a[1]-b[1]).map(([n,x])=>x+'着 '+n+'番').join('・');" +
                        "return {finished:true,rows:rows,top:top};})()"))
                if (judged.optBoolean("finished")) {
                    finished = true
                    RaceResults.add(this, raceId, JSONObject(res),
                        java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.JAPAN).format(java.util.Date()))
                    val rows = judged.optJSONArray("rows")
                    val top = judged.optString("top")
                    message = when {
                        rows == null -> "結果：$top（払戻を読めない券種がありました）"
                        rows.length() == 0 -> "見送り。結果：$top"
                        else -> {
                            var spent = 0; var ret = 0; var hit = 0
                            for (i in 0 until rows.length()) {
                                val x = rows.getJSONObject(i)
                                spent += x.optInt("金額"); ret += x.optInt("払戻")
                                if (x.optString("判定") == "的中") hit++
                            }
                            val d = ret - spent
                            val sign = if (d >= 0) "+" else "−"
                            (if (hit > 0) "的中 $sign${"%,d".format(kotlin.math.abs(d))}円" else "不的中 −${"%,d".format(spent)}円") + "。結果：$top"
                        }
                    }
                }
            }
        } catch (e: Exception) {
            // 読めなかったときは、あとで読み直す
        } finally {
            if (CollectLock.mutex.isLocked) CollectLock.mutex.unlock()
        }

        if (finished) {
            ResultChecks.remove(this, key)
            Notifier.post(this, "$key|result".hashCode(), "答え合わせ：$title", "$message。タップで予想の記録を開きます",
                Notifier.openIntent(this, "records", r))
        } else if (!ResultChecks.retry(this, key)) {
            Notifier.post(this, "$key|result".hashCode(), "答え合わせ：$title",
                "結果を自動で取得できませんでした。タップすると取得します", Notifier.openIntent(this, "fetch", r))
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        web?.destroy()
        super.onDestroy()
    }
}
