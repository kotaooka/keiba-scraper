package io.github.kotaooka.keiba

/**
 * 件数・時刻などの設定値（scraper.js の CONFIG と同じ値。tests/test_config.py で確かめる）
 */
object Config {
    const val DAY_RESULTS_MAX = 6         // 当日の傾向に使う、このレースより前のレース数
    const val PRECHECK_MINUTES = 5        // 締切前のオッズの確認（発走の何分前）
    const val RESULT_DELAY_MINUTES = 15   // 結果の自動取得（発走の何分後）。確定していなければ同じ間隔で読み直す
    const val BACKUP_KEEP = 3             // 自動バックアップを残す件数
    const val TEXT_ZOOM_MIN = 85          // 文字の大きさ（端末の設定に合わせる範囲、%）
    const val TEXT_ZOOM_MAX = 115
}
