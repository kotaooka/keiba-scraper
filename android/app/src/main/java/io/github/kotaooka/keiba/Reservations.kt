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
    @Synchronized
    fun set(ctx: Context, r: JSONObject) {
        val key = r.getString("key")
        cancelAlarms(ctx, key)
        val keep = prunedList(ctx).filter { it.optString("key") != key } + r
        save(ctx, keep)
        schedule(ctx, r)
    }

    @Synchronized
    fun remove(ctx: Context, key: String) {
        cancelAlarms(ctx, key)
        save(ctx, prunedList(ctx).filter { it.optString("key") != key })
    }

    /** 端末の再起動でアラームは消えるので、起動時に全部登録し直す */
    @Synchronized
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
            // 「発走5分前」が発走後に届かないよう、許可があれば正確な時刻で起こす
            if (at > now) setAlarm(ctx, r, kind, at, exact = exactAllowed(ctx))
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

    /** actions は通知の下に並べるボタン（文字と、押したときの PendingIntent） */
    fun post(ctx: Context, id: Int, title: String, text: String, tap: PendingIntent,
             actions: List<Pair<String, PendingIntent>> = emptyList()) {
        if (!allowed(ctx)) return
        ensureChannels(ctx)
        val b = android.app.Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_notify)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(android.app.Notification.BigTextStyle().bigText(text))
            .setContentIntent(tap)
            .setAutoCancel(true)
        for ((label, pi) in actions) {
            @Suppress("DEPRECATION")
            b.addAction(android.app.Notification.Action.Builder(null, label, pi).build())
        }
        ctx.getSystemService(NotificationManager::class.java).notify(id, b.build())
    }

    /** 即PAT（地方競馬ネット投票のスマホ版）をブラウザで開く PendingIntent */
    fun patIntent(ctx: Context): PendingIntent = PendingIntent.getActivity(ctx, "pat".hashCode(),
        Intent(Intent.ACTION_VIEW, android.net.Uri.parse("https://n.ipat.jra.go.jp/sp/index.cgi")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
}

/** 一時ファイルに書いてから置き換える（書き込みの途中で落ちても前の中身が残る） */
fun writeAtomic(f: File, text: String) {
    val tmp = File(f.parentFile, f.name + ".tmp")
    tmp.writeText(text)
    if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
}

/** 自動収集の結果の置き場所。アプリを開いたときに ui.html の収集済みの記録へ取り込む */
object BackgroundResults {
    private fun file(ctx: Context) = File(ctx.filesDir, "background_results.json")

    @Synchronized
    fun add(ctx: Context, key: String, outcome: JSONObject) {
        val arr = runCatching { JSONArray(file(ctx).readText()) }.getOrDefault(JSONArray())
        arr.put(JSONObject().put("key", key).put("at", outcome.getString("at"))
            .put("text", outcome.getString("text")).put("info", outcome.getJSONObject("info")))
        writeAtomic(file(ctx), arr.toString())
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

/**
 * 結果の自動取得の予約。AI の回答を記録したレースについて、発走の15分後に結果ページを1回読み、
 * 的中・不的中を通知する。未確定なら15分おきに読み直す（最初の1回を含めて最大3回読む）。
 * 1件は {key, race_id, date, venue, no, title, time, start(ミリ秒), bets:[{券種,組み合わせ,金額}], tries}
 */
object ResultChecks {
    private const val PREFS = "result_checks"
    private const val KEY_LIST = "list"
    const val FIRST_DELAY = 15 * 60_000L   // 発走から最初に読むまで
    const val RETRY_DELAY = 15 * 60_000L   // 未確定のとき次に読むまで
    const val MAX_TRIES = 3

    fun list(ctx: Context): List<JSONObject> {
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LIST, "[]") ?: "[]"
        val arr = runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    private fun save(ctx: Context, items: List<JSONObject>) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_LIST, JSONArray(items).toString()).apply()
    }

    /** 予約する（同じ key は置き換え）。発走から1日たったもの（古いレースの記録）は予約しない */
    @Synchronized
    fun set(ctx: Context, r: JSONObject) {
        val key = r.getString("key")
        val others = pruned(ctx).filter { it.optString("key") != key }
        if (r.getLong("start") <= System.currentTimeMillis() - 24 * 3600_000L) { save(ctx, others); return }
        val at = maxOf(r.getLong("start") + FIRST_DELAY, System.currentTimeMillis() + 60_000L)
        r.put("tries", 0).put("next_at", at)
        save(ctx, others + r)
        schedule(ctx, r, at)
    }

    /** まだ予約が残っているか */
    @Synchronized
    fun has(ctx: Context, key: String): Boolean = pruned(ctx).any { it.optString("key") == key }

    @Synchronized
    fun remove(ctx: Context, key: String) {
        ctx.getSystemService(AlarmManager::class.java).cancel(intent(ctx, key, null, Reservations.exactAllowed(ctx)))
        ctx.getSystemService(AlarmManager::class.java).cancel(intent(ctx, key, null, !Reservations.exactAllowed(ctx)))
        save(ctx, pruned(ctx).filter { it.optString("key") != key })
    }

    /**
     * もう一度読む予約をする。countTry=false は、画面からの収集と重なって読めなかったとき（回数に数えない）。
     * 回数を超えたら予約を消して false
     */
    @Synchronized
    fun retry(ctx: Context, key: String, countTry: Boolean = true): Boolean {
        val items = pruned(ctx)
        val r = items.firstOrNull { it.optString("key") == key } ?: return false
        val tries = r.optInt("tries", 0) + (if (countTry) 1 else 0)
        if (tries >= MAX_TRIES) { remove(ctx, key); return false }
        val at = System.currentTimeMillis() + (if (countTry) RETRY_DELAY else 5 * 60_000L)
        r.put("tries", tries).put("next_at", at)
        save(ctx, items)
        schedule(ctx, r, at)
        return true
    }

    /** 端末の再起動後などに登録し直す。予定の時刻は変えない（過ぎていたら1分後） */
    @Synchronized
    fun rescheduleAll(ctx: Context) {
        val items = pruned(ctx)
        save(ctx, items)
        val now = System.currentTimeMillis()
        for (r in items) schedule(ctx, r, maxOf(r.optLong("next_at", r.getLong("start") + FIRST_DELAY), now + 60_000L))
    }

    private fun pruned(ctx: Context): List<JSONObject> {
        val limit = System.currentTimeMillis() - 24 * 3600_000L
        return list(ctx).filter { it.optLong("start") > limit }
    }

    private fun intent(ctx: Context, key: String, r: JSONObject?, exact: Boolean): PendingIntent {
        val i = Intent(ctx, AlarmReceiver::class.java).apply {
            action = "io.github.kotaooka.keiba.RESULT"
            putExtra("key", key)
            putExtra("kind", "result")
            putExtra("exact", exact)
            if (r != null) putExtra("reservation", r.toString())
        }
        return PendingIntent.getBroadcast(ctx, "$key|result".hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun schedule(ctx: Context, r: JSONObject, at: Long) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val exact = Reservations.exactAllowed(ctx)
        val pi = intent(ctx, r.getString("key"), r, exact)
        if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
    }
}

/**
 * 発走5分前のオッズの取り直しの予約。AI の回答を記録したレースについて、発走の BEFORE 前に裏で収集し直し、
 * 記録した買い目を今のオッズで点検して通知する（期待値が下限を割った買い目を知らせる）。
 * 1件は {key, race_id, date, venue, no, title, time, start(ミリ秒), bets, hit_bets, pred, ev_min, hit_ev_min}
 */
object PreChecks {
    private const val PREFS = "pre_checks"
    private const val KEY_LIST = "list"
    const val BEFORE = 5 * 60_000L

    private fun list(ctx: Context): List<JSONObject> {
        val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LIST, "[]") ?: "[]"
        val arr = runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
        return (0 until arr.length()).map { arr.getJSONObject(it) }.filter { it.optLong("start") > System.currentTimeMillis() }
    }

    private fun save(ctx: Context, items: List<JSONObject>) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_LIST, JSONArray(items).toString()).apply()
    }

    /** 予約する（同じ key は置き換え）。取り直す時刻まで1分を切っていれば予約しない */
    @Synchronized
    fun set(ctx: Context, r: JSONObject): Boolean {
        val key = r.getString("key")
        val others = list(ctx).filter { it.optString("key") != key }
        val at = r.getLong("start") - BEFORE
        cancelAlarm(ctx, key)
        if (at < System.currentTimeMillis() + 60_000L) { save(ctx, others); return false }
        save(ctx, others + r)
        schedule(ctx, r, at)
        return true
    }

    @Synchronized
    fun remove(ctx: Context, key: String) {
        cancelAlarm(ctx, key)
        save(ctx, list(ctx).filter { it.optString("key") != key })
    }

    @Synchronized
    fun rescheduleAll(ctx: Context) {
        val now = System.currentTimeMillis()
        val items = list(ctx).filter { it.getLong("start") - BEFORE > now }
        save(ctx, items)
        for (r in items) schedule(ctx, r, r.getLong("start") - BEFORE)
    }

    private fun intent(ctx: Context, key: String, r: JSONObject?): PendingIntent {
        val i = Intent(ctx, AlarmReceiver::class.java).apply {
            action = "io.github.kotaooka.keiba.PRECHECK"
            putExtra("key", key)
            putExtra("kind", "precheck")
            putExtra("exact", true)
            if (r != null) putExtra("reservation", r.toString())
        }
        return PendingIntent.getBroadcast(ctx, "$key|precheck".hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun cancelAlarm(ctx: Context, key: String) {
        ctx.getSystemService(AlarmManager::class.java).cancel(intent(ctx, key, null))
    }

    // 時刻どおりでないと意味がないので、正確なアラームを使えるときだけ予約する
    private fun schedule(ctx: Context, r: JSONObject, at: Long) {
        if (!Reservations.exactAllowed(ctx)) return
        ctx.getSystemService(AlarmManager::class.java)
            .setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent(ctx, r.getString("key"), r))
    }
}

/** 自動で取った結果の置き場所。アプリを開いたときに ui.html の予想の記録へ入れる */
object RaceResults {
    private fun file(ctx: Context) = File(ctx.filesDir, "race_results.json")

    @Synchronized
    fun add(ctx: Context, raceId: String, result: JSONObject, at: String) {
        val arr = runCatching { JSONArray(file(ctx).readText()) }.getOrDefault(JSONArray())
        arr.put(JSONObject().put("race_id", raceId).put("result", result).put("at", at))
        writeAtomic(file(ctx), arr.toString())
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
