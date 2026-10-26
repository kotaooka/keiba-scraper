package io.github.kotaooka.keiba

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONObject

/** 予約した時刻に起きて、通知を出すか自動収集を始める */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val r = runCatching { JSONObject(intent.getStringExtra("reservation") ?: "") }.getOrNull() ?: return
        val kind = intent.getStringExtra("kind") ?: return
        val key = r.optString("key")
        val title = Reservations.titleOf(r)
        val time = r.optString("time")

        if (kind == "result") {
            // 結果の自動取得：正確な時刻で起きたときだけ裏で読める。だめなら「タップで答え合わせ」の通知にする
            val fallback = {
                ResultChecks.remove(ctx, key)
                Notifier.post(ctx, "$key|result".hashCode(), "答え合わせ：$title",
                    "結果が出たころです。タップすると結果を取得します", Notifier.openIntent(ctx, "fetch", r))
            }
            if (!intent.getBooleanExtra("exact", false)) { fallback(); return }
            try {
                ctx.startForegroundService(Intent(ctx, CollectService::class.java)
                    .putExtra("mode", "result").putExtra("reservation", r.toString()))
            } catch (e: Exception) {
                fallback()
            }
            return
        }

        if (kind != "collect") {
            Notifier.post(ctx, "$key|$kind".hashCode(), "$title — ${Reservations.notifyTitle(kind)}",
                "$time 発走。タップで開きます", Notifier.openIntent(ctx, "open", r))
            return
        }

        // 自動収集：正確な時刻で起きたときだけ裏で収集を始められる。だめなら「タップで収集」の通知にする
        val fallback = {
            Notifier.post(ctx, "$key|collect".hashCode(), "$title — 収集の時間です",
                "$time 発走。タップすると収集します", Notifier.openIntent(ctx, "collect", r))
        }
        if (!intent.getBooleanExtra("exact", false)) { fallback(); return }
        try {
            ctx.startForegroundService(Intent(ctx, CollectService::class.java).putExtra("reservation", r.toString()))
        } catch (e: Exception) {
            // Android の制限で裏から始められなかったとき
            fallback()
        }
    }
}

/** 端末の再起動後に予約のアラームを登録し直す */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == "android.intent.action.MY_PACKAGE_REPLACED") {
            Reservations.rescheduleAll(ctx)
            ResultChecks.rescheduleAll(ctx)
        }
    }
}

/** 共有メニューで選ばれたアプリを覚える（次からはそのアプリへ直接送る） */
class ShareChosenReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val cn: ComponentName? = if (Build.VERSION.SDK_INT >= 33)
            intent.getParcelableExtra(Intent.EXTRA_CHOSEN_COMPONENT, ComponentName::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_CHOSEN_COMPONENT)
        if (cn != null) ShareTarget.save(ctx, cn)
    }
}

/** 送り先のアプリ */
object ShareTarget {
    private const val PREFS = "share"

    fun save(ctx: Context, cn: ComponentName) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("component", cn.flattenToString()).apply()
    }

    fun get(ctx: Context): ComponentName? =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("component", null)?.let { ComponentName.unflattenFromString(it) }

    /** 送り先のアプリ名（覚えていない・アンインストール済みなら空） */
    fun label(ctx: Context): String {
        val cn = get(ctx) ?: return ""
        return runCatching { ctx.packageManager.getApplicationInfo(cn.packageName, 0).loadLabel(ctx.packageManager).toString() }.getOrDefault("")
    }
}
