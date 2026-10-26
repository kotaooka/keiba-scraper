package io.github.kotaooka.keiba

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import kotlinx.coroutines.sync.Mutex
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 通知・自動収集の予約。
 * 1件は {key, date, venue, no, title, time, start(ミリ秒), notify:["weight","m20","m5"], auto(分前, 0=しない)}。
 * key は ui.html の cacheKey（日付|競馬場|レース番号）と同じ。
 */
object Reservations {
    private const val PREFS = "reservations"
    private const val KEY_LIST = "list"

    /** 通知の種類と、発走の何分前か（ui.html の NOTIFY_KINDS と同じ） */
    val NOTIFY_BEFORE = mapOf("weight" to 110, "m20" to 20, "m5" to 5)
    private val NOTIFY_TITLE = mapOf("weight" to "馬体重の発表ごろです", "m20" to "発走20分前です", "m5" to "発走5分前です")

    fun list(ctx: Context): List<JSONObject> {
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LIST, "[]") ?: "[]"
        val arr = runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    private fun save(ctx: Context, items: List<JSONObject>) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_LIST, JSONArray(items).toString()).apply()
    }

    fun get(ctx: Context, key: String): JSONObject? = list(ctx).firstOrNull { it.optString("key") == key }

    /** 予約を保存してアラームを登録し直す。発走から1時間以上たった予約は消す */
    fun set(ctx: Context, r: JSONObject) {
        val key = r.getString("key")
        cancelAlarms(ctx, key)
        val keep = prunedList(ctx).filter { it.optString("key") != key } + r
        save(ctx, keep)
        schedule(ctx, r)
    }

    fun remove(ctx: Context, key: String) {
        cancelAlarms(ctx, key)
        save(ctx, prunedList(ctx).filter { it.optString("key") != key })
    }

    /** 端末の再起動でアラームは消えるので、起動時に全部登録し直す */
    fun rescheduleAll(ctx: Context) {
        val items = prunedList(ctx)
        save(ctx, items)
        items.forEach { schedule(ctx, it) }
    }

    private fun prunedList(ctx: Context): List<JSONObject> {
        val limit = System.currentTimeMillis() - 3600_000L
        return list(ctx).filter { it.optLong("start") > limit }
    }

    /** 正確な時刻のアラームが使えるか（Android 12 以降は「アラームとリマインダー」の許可が要る） */
    fun exactAllowed(ctx: Context): Boolean {
        val am = ctx.getSystemService(AlarmManager::class.java)
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
    }

    private fun schedule(ctx: Context, r: JSONObject) {
        val start = r.getLong("start")
        val now = System.currentTimeMillis()
        val notify = r.optJSONArray("notify") ?: JSONArray()
        for (i in 0 until notify.length()) {
            val kind = notify.getString(i)
            val before = NOTIFY_BEFORE[kind] ?: continue
            val at = start - before * 60_000L
            if (at > now) setAlarm(ctx, r, kind, at, exact = false)
        }
        val auto = r.optInt("auto", 0)
        if (auto > 0) {
            val at = start - auto * 60_000L
            // 自動収集は、正確な時刻で起きたときだけ裏で収集を始められる（Android の制限）
            if (at > now) setAlarm(ctx, r, "collect", at, exact = exactAllowed(ctx))
        }
    }

    private fun alarmIntent(ctx: Context, key: String, kind: String, r: JSONObject?, exact: Boolean): PendingIntent {
        val intent = Intent(ctx, AlarmReceiver::class.java).apply {
            action = "io.github.kotaooka.keiba.ALARM"
            putExtra("key", key)
            putExtra("kind", kind)
            putExtra("exact", exact)
            if (r != null) putExtra("reservation", r.toString())
        }
        return PendingIntent.getBroadcast(ctx, "$key|$kind".hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun setAlarm(ctx: Context, r: JSONObject, kind: String, at: Long, exact: Boolean) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val pi = alarmIntent(ctx, r.getString("key"), kind, r, exact)
        if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)  // 数分ずれることがある
    }

    private fun cancelAlarms(ctx: Context, key: String) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        for (kind in NOTIFY_BEFORE.keys + "collect") {
            for (exact in listOf(true, false)) am.cancel(alarmIntent(ctx, key, kind, null, exact))
        }
    }

    fun titleOf(r: JSONObject): String =
        "${r.optString("venue")} ${r.optInt("no")}R ${r.optString("title")}".trim()

    fun notifyTitle(kind: String): String = NOTIFY_TITLE[kind] ?: ""
}

/** 通知を出す */
object Notifier {
    const val CHANNEL = "race"
    const val CHANNEL_RUN = "collecting"

    fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "レースの通知・自動収集の結果", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CHANNEL_RUN, "自動収集の実行中", NotificationManager.IMPORTANCE_LOW))
    }

    fun allowed(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < 33 ||
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** タップするとアプリを開く PendingIntent。type は open / collect / race（ui.html の openFromNotification） */
    fun openIntent(ctx: Context, type: String, r: JSONObject): PendingIntent {
        val intent = Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("open_type", type)
            putExtra("reservation", r.toString())
        }
        return PendingIntent.getActivity(ctx, "${r.optString("key")}|$type".hashCode(), intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun post(ctx: Context, id: Int, title: String, text: String, tap: PendingIntent) {
        if (!allowed(ctx)) return
        ensureChannels(ctx)
        val n = android.app.Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(android.app.Notification.BigTextStyle().bigText(text))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(id, n)
    }
}

/** 自動収集の結果の置き場所。アプリを開いたときに ui.html の収集済みの記録へ取り込む */
object BackgroundResults {
    private fun file(ctx: Context) = File(ctx.filesDir, "background_results.json")

    @Synchronized
    fun add(ctx: Context, key: String, outcome: JSONObject) {
        val arr = runCatching { JSONArray(file(ctx).readText()) }.getOrDefault(JSONArray())
        arr.put(JSONObject().put("key", key).put("at", outcome.getString("at"))
            .put("text", outcome.getString("text")).put("info", outcome.getJSONObject("info")))
        file(ctx).writeText(arr.toString())
    }

    @Synchronized
    fun take(ctx: Context): String {
        val f = file(ctx)
        if (!f.exists()) return "[]"
        val text = f.readText()
        f.delete()
        return text
    }
}

/** 画面からの収集と自動収集が同時に走らないようにする（サイトへのアクセスを重ねないため） */
object CollectLock {
    val mutex = Mutex()
}
