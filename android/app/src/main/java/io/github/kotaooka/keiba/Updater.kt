package io.github.kotaooka.keiba

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 更新の確認とインストール。
 * リリース android-latest に置いた version.json を読み、手元の versionCode と比べる。
 * 更新版の APK は DownloadManager で落とし、端末のインストール画面を開く。
 */
class Updater(private val context: Context) {

    companion object {
        private const val BASE = "https://github.com/kotaooka/keiba-scraper/releases/download/android-latest/"
        const val VERSION_URL = BASE + "version.json"
        const val APK_URL = BASE + "keiba-collector.apk"
        const val RELEASE_PAGE = "https://github.com/kotaooka/keiba-scraper/releases/tag/android-latest"
    }

    /** このアプリの版情報（UI に渡す JSON） */
    fun currentInfo(): JSONObject = JSONObject()
        .put("versionCode", BuildConfig.VERSION_CODE)
        .put("versionName", BuildConfig.VERSION_NAME)
        .put("commit", BuildConfig.COMMIT)
        .put("builtAt", BuildConfig.BUILT_AT)

    /** 最新版の version.json を読む。読めなければ例外 */
    suspend fun fetchLatest(): JSONObject = withContext(Dispatchers.IO) {
        // GitHub の配布ファイルはキャッシュされることがあるので、毎回違う URL にする
        val conn = URL(VERSION_URL + "?t=" + System.currentTimeMillis()).openConnection() as HttpURLConnection
        conn.connectTimeout = 10_000
        conn.readTimeout = 10_000
        conn.instanceFollowRedirects = true
        try {
            if (conn.responseCode != 200) throw IllegalStateException("HTTP ${conn.responseCode}")
            JSONObject(conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() })
        } finally {
            conn.disconnect()
        }
    }

    /** 提供元不明のアプリのインストールが、このアプリに許可されているか */
    fun canInstall(): Boolean = context.packageManager.canRequestPackageInstalls()

    /** 「この提供元のアプリを許可」の設定画面を開く */
    fun openInstallPermissionSettings() {
        context.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /**
     * 更新版の APK を落としてインストール画面を開く。進み具合は progress(0〜100) で返す。
     * 失敗したら例外。
     */
    suspend fun downloadAndInstall(versionName: String, progress: (Int) -> Unit) {
        val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        // 前に落とした APK は消す（アプリ専用の場所なので他のファイルには触れない）
        context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)?.listFiles()
            ?.filter { it.name.endsWith(".apk") }?.forEach { it.delete() }

        val req = DownloadManager.Request(Uri.parse(APK_URL + "?t=" + System.currentTimeMillis()))
            .setTitle("地方競馬データ収集 v$versionName")
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, "keiba-collector-$versionName.apk")
        val id = dm.enqueue(req)

        try {
            while (true) {
                delay(400)
                dm.query(DownloadManager.Query().setFilterById(id)).use { c ->
                    if (!c.moveToFirst()) throw IllegalStateException("ダウンロードが見つかりません")
                    val status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                    val done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                    val total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                    if (total > 0) progress((done * 100 / total).toInt())
                    when (status) {
                        DownloadManager.STATUS_SUCCESSFUL -> {
                            progress(100)
                            val uri = dm.getUriForDownloadedFile(id) ?: throw IllegalStateException("ファイルを開けません")
                            context.startActivity(Intent(Intent.ACTION_VIEW)
                                .setDataAndType(uri, "application/vnd.android.package-archive")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
                            return
                        }
                        DownloadManager.STATUS_FAILED -> {
                            val reason = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                            throw IllegalStateException("ダウンロードに失敗しました（理由コード $reason）")
                        }
                    }
                }
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            dm.remove(id)
            throw e
        }
    }
}
