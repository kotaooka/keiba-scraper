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

        Notifier.ensureChannels(this)
        val running = Notification.Builder(this, Notifier.CHANNEL_RUN)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle("自動収集中：$title")
            .setContentText("出馬表・オッズ・過去5走を集めています")
            .setOngoing(true)
            .build()
        startForeground(r.optString("key").hashCode(), running, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)

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

    override fun onDestroy() {
        scope.cancel()
        web?.destroy()
        super.onDestroy()
    }
}
