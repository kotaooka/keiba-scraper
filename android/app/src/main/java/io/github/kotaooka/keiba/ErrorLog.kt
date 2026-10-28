package io.github.kotaooka.keiba

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 裏の処理（自動収集・答え合わせ・締切前の確認・バックアップなど）で起きたエラーを、端末の中に新しい順で MAX 件まで残す。
 * 画面の 設定 →「エラーの記録」で、画面側（JS）の記録と合わせて見られる
 */
object ErrorLog {
    private const val MAX = 100
    private fun file(ctx: Context) = File(ctx.filesDir, "errors.json")

    @Synchronized
    fun add(ctx: Context, where: String, e: Throwable?) {
        runCatching {
            val arr = runCatching { JSONArray(file(ctx).readText()) }.getOrDefault(JSONArray())
            val out = JSONArray().put(JSONObject().put("at", Jst.stamp()).put("where", where)
                .put("msg", (e?.let { "${it.javaClass.simpleName}: ${it.message}" } ?: "").take(400)))
            for (i in 0 until minOf(arr.length(), MAX - 1)) out.put(arr.get(i))
            writeAtomic(file(ctx), out.toString())
        }
    }

    @Synchronized
    fun read(ctx: Context): String = runCatching { file(ctx).readText() }.getOrDefault("[]")

    @Synchronized
    fun clear(ctx: Context) { file(ctx).delete() }
}
