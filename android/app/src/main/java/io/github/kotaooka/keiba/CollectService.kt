package io.github.kotaooka.keiba

import android.app.Notification
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import android.webkit.WebView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.sync.Mutex
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
    private var lastStartId = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifier.ensureChannels(this)
        val r = runCatching { JSONObject(intent?.getStringExtra("reservation") ?: "") }.getOrNull()
        val title = r?.let { Reservations.titleOf(it) } ?: ""
        val mode = intent?.getStringExtra("mode") ?: ""
        val resultMode = mode == "result"
        val preMode = mode == "precheck"

        // startForegroundService で起こされたら、何もしないときでも先に startForeground を呼ぶ（呼ばないと落とされる）
        val ongoing = Notification.Builder(this, Notifier.CHANNEL_RUN)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(if (resultMode) "答え合わせ中：$title" else if (preMode) "締切前のオッズを確認中：$title" else "自動収集中：$title")
            .setContentText(if (resultMode) "レースの結果を取得しています" else if (preMode) "オッズを取り直して、買い目の期待値を確かめています" else "出馬表・オッズ・過去5走を集めています")
            .setOngoing(true)
            .build()
        // 常駐の通知は1つの番号を使い回す（レースごとに変えると、止めたときに前の通知が残る）
        startForeground(FOREGROUND_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)

        lastStartId = startId
        if (r == null) { finishOne(); return START_NOT_STICKY }
        running++
        // 画面が消えていても途中で止まらないよう、1件ごとに CPU を起こしておく（長くても6分で放す）
        val wake = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "keiba:collect")
        wake.acquire(6 * 60_000L)
        scope.launch {
            try {
                when {
                    resultMode -> checkResult(r, title)
                    preMode -> preCheck(r, title)
                    else -> collect(r, title)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // 予期しないエラーでもアプリごと落とさない
            } finally {
                if (wake.isHeld) wake.release()
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
        stopSelf(lastStartId)
    }

    /** 裏の処理どうし・画面からの収集とは順番に行う（同じサイトへ同時にアクセスしない）。待っても取れなければ false */
    private suspend fun lockOrNull(mutex: Mutex, waitMs: Long): Boolean =
        withTimeoutOrNull(waitMs) { mutex.lock(); true } ?: false

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
        val outcome = if (!lockOrNull(CollectLock.mutex, 4 * 60_000L)) {
            Scraper.Outcome(null, "ほかの収集が終わらなかったため、自動収集を見送りました")
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
                "${r.optString("time")} 発走。オッズは ${obj.optString("at").takeLast(5)} 時点。「AI へ送る」でそのまま送れます",
                Notifier.openIntent(this, "open", r), listOf("AI へ送る" to Notifier.openIntent(this, "send", r)))
        } else {
            Notifier.post(this, "$key|done".hashCode(), "自動収集できませんでした：$title",
                "${outcome.error ?: ""}。タップすると開いて収集します", Notifier.openIntent(this, "collect", r))
        }
    }

    /** 結果ページを1回読み、記録した買い目で答え合わせして通知する。未確定ならあとで読み直す */
    private suspend fun checkResult(r: JSONObject, title: String) {
        val key = r.optString("key")
        val raceId = r.optString("race_id")
        if (!lockOrNull(CollectLock.mutex, 3 * 60_000L)) {
            // ほかの収集が長引いた。回数に数えずに少しあとで読み直す
            ResultChecks.retry(this, key, countTry = false)
            return
        }
        var message: String? = null
        // AI の回答も買った馬券もないレース（データとして結果まで記録するだけ）は、結果を残すだけで通知しない
        val silent = r.optString("mode") == "none" && (!r.has("own_bets") || r.isNull("own_bets"))
        try {
            message = withScraper { scraper ->
                val res = withTimeoutOrNull(2 * 60_000L) { scraper.fetchResult(raceId) } ?: return@withScraper null
                val bets = r.optJSONArray("bets") ?: JSONArray()
                val hitBets = r.optJSONArray("hit_bets")  // 的中重視の買い目（記録していなければ null）
                val ownBets = r.optJSONArray("own_bets")  // 自分で買った馬券（入れていなければ null）
                val mode = r.optString("mode", "ev")      // "none" は AI の回答を記録していないレース
                // 答え合わせは scraper.js の settleBets（PC版と同じ計算）で行う
                val judged = JSONObject(scraper.evalKs(
                    "(function(){const res=$res;if(!KS.resultFinished(res))return {finished:false};" +
                        "const rec={'結果':res,'AI':{'買い目':$bets,'的中買い目':${hitBets ?: "[]"}},'購入':${ownBets ?: "[]"}};" +
                        "const rows=KS.settleBets(rec,'買い目');const hit=KS.settleBets(rec,'的中買い目');const own=KS.settleBets(rec,'購入');" +
                        "const top=Object.entries(res['着順']).filter(([,x])=>/^[123]$/.test(x)).sort((a,b)=>a[1]-b[1]).map(([n,x])=>x+'着 '+n+'番').join('・');" +
                        "return {finished:true,rows:rows,hit:hit,own:own,top:top};})()"))
                if (!judged.optBoolean("finished")) return@withScraper null
                RaceResults.add(this, raceId, JSONObject(res), Jst.stamp())
                val top = judged.optString("top")
                // 自分の馬券を先に、AI の買い目（期待値重視・的中重視）を後ろに並べる
                val parts = mutableListOf<String>()
                if (ownBets != null) parts += "自分 ${summarize(judged.optJSONArray("own"))}"
                if (mode != "none") {
                    val evText = summarize(judged.optJSONArray("rows"))
                    val hitText = if (hitBets != null) summarize(judged.optJSONArray("hit")) else null
                    val ai = if (ownBets != null) "AI " else ""
                    when {
                        hitText == null -> parts += "$ai$evText".trim()
                        bets.length() == 0 && mode == "hit" -> parts += if (ownBets != null) "AI的中重視 $hitText" else "$hitText"
                        else -> { parts += "${ai}期待値重視 $evText"; parts += "${ai}的中重視 $hitText" }
                    }
                }
                parts.joinToString("／") + "。結果：$top"
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
            if (!silent) Notifier.post(this, "$key|result".hashCode(), "答え合わせ：$title", "$message。タップで予想の記録を開きます",
                Notifier.openIntent(this, "records", r))
        } else if (ResultChecks.has(this, key) && !ResultChecks.retry(this, key) && !silent) {
            // 3回読んでも確定しなかった（途中で記録が消された・画面で結果を取ったときは何も出さない）
            Notifier.post(this, "$key|result".hashCode(), "答え合わせ：$title",
                "結果を自動で取得できませんでした。タップすると取得します", Notifier.openIntent(this, "fetch", r))
        }
    }

    /**
     * 発走5分前：収集し直して（取った結果は画面にも反映）、記録した買い目を今のオッズで点検し、通知する。
     * 期待値が下限を割った買い目があれば先に書く
     */
    private suspend fun preCheck(r: JSONObject, title: String) {
        val key = r.optString("key")
        if (!lockOrNull(CollectLock.mutex, 90_000L)) return
        var text: String? = null
        var drops = 0
        try {
            text = withScraper { scraper ->
                val out = withTimeoutOrNull(3 * 60_000L) {
                    scraper.collectRace(r.optString("venue"), r.optString("date"), r.optInt("no"), 0)
                } ?: return@withScraper null
                val json = out.json ?: return@withScraper null
                val obj = JSONObject(json)
                BackgroundResults.add(this, key, obj)
                val rows = JSONArray(scraper.evalKs("KS.recheckBets(${obj.getJSONObject("info")}, ${r.optJSONArray("bets") ?: JSONArray()}, " +
                    "${r.optJSONArray("hit_bets") ?: JSONArray()}, ${r.optJSONObject("pred") ?: JSONObject()}, ${r.optDouble("ev_min", 1.2)}, ${r.optDouble("hit_ev_min", 0.9)})"))
                val bad = mutableListOf<String>(); val good = mutableListOf<String>()
                for (i in 0 until rows.length()) {
                    val x = rows.getJSONObject(i)
                    val name = "${x.optString("券種")} ${x.optString("組み合わせ")}"
                    if (x.isNull("ev")) continue
                    val ev = "%.2f".format(x.getDouble("ev"))
                    if (x.optBoolean("ok")) good += "$name $ev" else bad += "$name 期待値$ev"
                }
                drops = bad.size
                when {
                    rows.length() == 0 -> "AI の買い目は見送りです。オッズは ${obj.optString("at").takeLast(5)} 時点"
                    bad.isNotEmpty() -> "期待値が下限を割った買い目 ${bad.size}点：${bad.joinToString("・")}" +
                        (if (good.isNotEmpty()) "／条件どおり：${good.joinToString("・")}" else "")
                    good.isNotEmpty() -> "買い目はすべて条件どおりです：${good.joinToString("・")}"
                    else -> "今のオッズが読めない買い目があります。タップで確認してください"
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // 取れなかったときは何も出さない（時刻を過ぎてからでは役に立たないので）
        } finally {
            CollectLock.mutex.unlock()
        }
        PreChecks.remove(this, key)
        val msg = text ?: return
        Notifier.post(this, "$key|precheck".hashCode(), (if (drops > 0) "見送り推奨あり：" else "締切前のオッズ：") + title,
            "$msg。${r.optString("time")} 発走", Notifier.openIntent(this, "open", r), listOf("即PAT を開く" to Notifier.patIntent(this)))
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
            when {
                hit > 0 -> "的中 $sign${"%,d".format(kotlin.math.abs(d))}円"
                d == 0 -> "返還 ±0円"
                else -> "不的中 $sign${"%,d".format(kotlin.math.abs(d))}円"  // 返還があれば、その分を差し引いた額
            }
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
