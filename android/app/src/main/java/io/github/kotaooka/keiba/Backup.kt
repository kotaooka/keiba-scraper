package io.github.kotaooka.keiba

import android.content.ContentValues
import android.content.Context
import android.provider.MediaStore

/**
 * 記録の自動バックアップ。端末の「ダウンロード/keiba-backup」に JSON を書き、新しい KEEP 件だけ残す。
 * 中身は記録の画面の「書き出す」と同じなので、「読み込む」でそのまま戻せる。
 * Android 10 以降は、自分で作ったファイルなら権限なしで書け、消せる（入れ直す前に作ったファイルは消せないので残る）。
 */
object Backup {
    private const val DIR = "Download/keiba-backup/"
    private const val PREFIX = "keiba-backup-"
    const val KEEP = Config.BACKUP_KEEP

    /** 書いたファイルの場所（画面に出す文字）を返す。失敗したら例外 */
    fun write(ctx: Context, json: String, name: String): String {
        val cr = ctx.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, "application/json")
            put(MediaStore.MediaColumns.RELATIVE_PATH, DIR)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("ファイルを作れませんでした")
        try {
            cr.openOutputStream(uri)?.use { it.write(json.toByteArray(Charsets.UTF_8)) } ?: error("ファイルに書けませんでした")
            cr.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            runCatching { cr.delete(uri, null, null) }
            throw e
        }
        prune(ctx)
        return "ダウンロード/keiba-backup/$name"
    }

    /** 自分で作ったバックアップのうち、新しい KEEP 件より古いものを消す */
    private fun prune(ctx: Context) {
        val cr = ctx.contentResolver
        val ids = mutableListOf<Long>()
        cr.query(
            MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            arrayOf(MediaStore.MediaColumns._ID),
            "${MediaStore.MediaColumns.RELATIVE_PATH} = ? AND ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?",
            arrayOf(DIR, "$PREFIX%"),
            "${MediaStore.MediaColumns.DATE_ADDED} DESC",
        )?.use { c -> while (c.moveToNext()) ids += c.getLong(0) }
        for (id in ids.drop(KEEP)) {
            runCatching { cr.delete(android.content.ContentUris.withAppendedId(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id), null, null) }
        }
    }
}
