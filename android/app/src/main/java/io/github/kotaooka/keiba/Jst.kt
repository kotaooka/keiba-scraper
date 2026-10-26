package io.github.kotaooka.keiba

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** 時刻はすべて日本時間で扱う（発走時刻は日本時間。端末を海外の時間帯にしていてもずれないように） */
object Jst {
    val ZONE: TimeZone = TimeZone.getTimeZone("Asia/Tokyo")

    fun format(pattern: String, d: Date = Date()): String =
        SimpleDateFormat(pattern, Locale.JAPAN).apply { timeZone = ZONE }.format(d)

    fun stamp(d: Date = Date()): String = format("yyyy-MM-dd HH:mm:ss", d)
}
