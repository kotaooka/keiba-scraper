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
| — | `Reservations.kt`・`Receivers.kt`・`CollectService.kt`（通知・自動収集・結果の自動取得）、`Updater.kt`（更新） |

- 解析を直すときは、`keiba_scraper.py` と `scraper.js` の両方を同じように直す。指示文（`PROMPT_TEXT`・買い方ごとの文 `MODE_TEXT`）・予想の条件の既定値（`BUDGET`・`MAX_BETS`・`EV_MIN`・`BET_MODE`・`HIT_MIN`・`HIT_EV_MIN` ↔ `DEFAULT_SETTINGS`）・競馬場コード・アクセス間隔（`REQUEST_INTERVAL`）も両方にある
- 予想の記録と答え合わせも両方にある（PC版の `parse_ai_block`・`parse_result`・`settle_bets`・`horse_rows`・`compute_summary` ↔ `scraper.js` の `parseAiBlock`・`parseResult`・`settleBets`・`horseRows`・`computeSummary`）。95%区間のブートストラップは、`scraper.js` に Python の `random.Random` と同じ乱数（MT19937）を移植しているので、同じ記録なら同じ値になる。記録の形式も同じなので、Android版の書き出しを PC版の `import` で取り込める
- オッズの注記（`odds_notes` ↔ `oddsNotes`）も両方にある
- 小数の結果を両方で同じにするための約束
  - 足し算は先頭から順に足す（PC版は `_sum`。Python 3.12 以降の `sum` は誤差を補正するので使わない）。馬は馬番の順に並べてから足す
  - 小数の表示は Python の `f"{x:.1f}"` と同じ丸め（ちょうど半分は偶数へ）。`scraper.js` では `toFixed` ではなく `pyFixed` を使う
  - 集計（`compute_summary` ↔ `computeSummary`）は、渡された順ではなく race_id の順に並べ直してから計算する
- 時刻はすべて日本時間で扱う（Android版は端末の時間帯によらない。`ui.html` の `jstNow`、Kotlin の `Jst`）
- 即PAT・A-PAT の発売カレンダーの解析（`parsePatCalendar`）と、取り直したときのオッズの変化（`diffRaces`・`formatDiff`）は Android版だけにある

## 取れなくなったとき

サイトのページの作りが変わると取れなくなります。

- **Android版**：収集中の画面の「取得中のサイトをプレビュー」で、アプリが裏で開いているページを画面の下半分に出せる。ページは出ているのに取れなければ、作りが変わっている
- **PC版**：次のコマンドで、出馬表・オッズ・上位人気一覧・結果のページの HTML と構造レポートが `debug_output/` に保存される。race_id は「年4桁 + 競馬場コード2桁 + 月日4桁 + レース番号2桁」

```powershell
venv\Scripts\python.exe debug_scraper.py 202635102505
```

## Android版のビルドと配布

- main ブランチで `android/` 以下か `.github/workflows/android.yml` を変えて push すると（または Actions から手動で実行すると）、GitHub Actions がデバッグ版をビルドし、リリース `android-latest` の APK と `version.json`（版番号・コミット・ビルド日時・最近の変更）を差し替える。アプリの更新確認はこの `version.json` を読む
- ビルドに失敗したときは、コンパイルエラーを Actions の注釈に出す
- バージョンは `0.4.<ビルド番号>`。ビルド番号は Actions の実行番号で、push のたびに増える
- 手元でビルドするときは Android Studio で `android/` を開く（手元のビルドは版番号が 0.4.0 になるので、更新確認では常に新しい版があると出る）
- `debug.keystore` はデバッグ版の署名を固定するための鍵で、パスワードは Android 標準のデバッグ鍵と同じ `android`。秘密の鍵ではない。鍵を固定しているので、どのビルドも上書きインストールできる
