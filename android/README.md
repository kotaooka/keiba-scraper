# 地方競馬 収集（Android版）

PC版（`keiba_scraper.py`）と同じデータを集めて、AI に貼り付けるテキストを作る Android アプリです。PC なしで動きます。

## 必要環境

- Android 10 以上

## インストール

1. スマホで次のリンクを開き、`keiba-collector.apk` をダウンロードする（ログイン不要）
   https://github.com/kotaooka/keiba-scraper/releases/download/android-latest/keiba-collector.apk
2. ダウンロードした APK を開いてインストールする（初回は「提供元不明のアプリ」の許可を求められる）

更新するときも同じリンクから取り直して上書きインストールできます。リリース `android-latest` は `android/` を変更して push するたびに最新版へ差し替わります（署名鍵を固定しているので上書きできる）。

## 使い方

1. 日付ボタンでレース日を選ぶ（起動時は当日）。選ぶと開催一覧を読み込む
2. 競馬場を選ぶ
3. レースをタップすると収集が始まる（当日は次に発走するレースに「← 次」が付く）
4. 終わるとテキストがコピーされる。「共有（AIアプリへ）」から Claude などのアプリへ直接送れる

1レースの収集には、アクセス間隔（2秒）の待機を含めて1〜2分かかります。収集中は画面が消えないようにしています。

## 取得できなかったとき

画面下の「読み込み中のページを表示（不具合調査用）」をオンにすると、アプリが開いているページがそのまま見えます。ページが表示されているのに取れない場合は、サイトの構造が変わっています。PC版の `debug_scraper.py` で構造レポートを作って直してください。

## PC版との対応

| PC版 | Android版 |
|---|---|
| `keiba_scraper.py` の解析・整形 | `app/src/main/assets/scraper.js`（同じ処理を JavaScript に移植） |
| `fetch_page`・`collect_race`（Playwright） | `Scraper.kt`（WebView） |
| 対話（`run.bat`） | `MainActivity.kt` |

- 解析を直したときは、`keiba_scraper.py` と `scraper.js` の両方を同じように直してください。指示文（`PROMPT_TEXT`）・期待値の下限（`EV_MIN`）・競馬場コードも両方にあります。
- 予想の記録と検証（`record`・`verify`）は Android版にはまだありません。PC版を使ってください。

## ビルド

`android/` 以下を push すると GitHub Actions が自動でビルドします（`.github/workflows/android.yml`）。手元でビルドする場合は Android Studio で `android/` を開きます。

`debug.keystore` はデバッグ版の署名を固定するための鍵で、パスワードは Android 標準のデバッグ鍵と同じ `android` です。秘密の鍵ではありません。

## 注意事項

ルートの README の注意事項がそのまま当てはまります。特に、連続実行・大量取得はしないでください。
