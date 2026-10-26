# 直す人向け

[README に戻る](../README.md)

## ファイル構成

```
keiba_scraper.py          PC版の本体（収集・テキスト作成・記録・答え合わせ）
debug_scraper.py          ページの作りを調べるための保存ツール
setup.bat / run.bat       PC版の初回準備と起動
record.bat / verify.bat   PC版の記録と答え合わせ
android/                  Android版
  app/src/main/assets/scraper.js   解析とテキスト作成（keiba_scraper.py から移植）
  app/src/main/assets/ui.html      画面
  app/src/main/java/.../           Kotlin（下表）
docs/                     説明書と画面例
.github/workflows/android.yml      Android版のビルドと配布
```

## PC版と Android版の対応

| PC版 | Android版 |
|---|---|
| `keiba_scraper.py` の解析・整形 | `scraper.js`（同じ処理を JavaScript に移植） |
| `fetch_page`・`collect_race`（Playwright） | `Scraper.kt`（WebView） |
| 対話（`run.bat`） | `ui.html`（画面）と `MainActivity.kt`（画面との受け渡し） |
| — | `Reservations.kt`・`Receivers.kt`・`CollectService.kt`（通知・自動収集）、`Updater.kt`（更新） |

- 解析を直すときは、`keiba_scraper.py` と `scraper.js` の両方を同じように直す。指示文（`PROMPT_TEXT`）・予想の条件の既定値（`BUDGET`・`MAX_BETS`・`EV_MIN`）・競馬場コード・アクセス間隔（`REQUEST_INTERVAL`）も両方にある
- 即PAT・A-PAT の発売カレンダーの解析（`parsePatCalendar`）は Android版だけ、予想の記録と答え合わせ（`record`・`verify`）は PC版だけにある

## 取れなくなったとき

サイトのページの作りが変わると取れなくなります。

- **Android版**：収集中の画面の「取得中のサイトをプレビュー」で、アプリが裏で開いているページを画面の下半分に出せる。ページは出ているのに取れなければ、作りが変わっている
- **PC版**：次のコマンドで、出馬表・オッズ・上位人気一覧・結果のページの HTML と構造レポートが `debug_output/` に保存される。race_id は「年4桁 + 競馬場コード2桁 + 月日4桁 + レース番号2桁」

```powershell
venv\Scripts\python.exe debug_scraper.py 202635102505
```

## Android版のビルドと配布

- `android/` 以下を push すると、GitHub Actions がデバッグ版をビルドし、リリース `android-latest` の APK と `version.json`（版番号・コミット・ビルド日時・最近の変更）を差し替える。アプリの更新確認はこの `version.json` を読む
- ビルドに失敗したときは、コンパイルエラーを Actions の注釈に出す
- バージョンは `0.4.<ビルド番号>`。ビルド番号は Actions の実行番号で、push のたびに増える
- 手元でビルドするときは Android Studio で `android/` を開く
- `debug.keystore` はデバッグ版の署名を固定するための鍵で、パスワードは Android 標準のデバッグ鍵と同じ `android`。秘密の鍵ではない。鍵を固定しているので、どのビルドも上書きインストールできる
