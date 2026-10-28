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
  app/src/main/assets/ui.html      画面の骨組み（下の CSS と JS を読み込む）
  app/src/main/assets/ui.css       画面の見た目
  app/src/main/assets/js/          画面の動き（ui-core → ui-result → ui-records → ui-settings の順に読む）
    ui-core.js       表示テーマ・Kotlin とのやり取り・日付・発売カレンダー・開催一覧・収集の進み具合
    ui-result.js     結果画面・見出しのナビ・Kotlin から呼ばれる App・AI の回答の読み込み・更新
    ui-records.js    AI の予想欄・買った馬券・AI なしの目安・記録の画面・収支の推移・CLV
    ui-settings.js   予想の条件・ケリー基準・通知と自動収集の予約・設定の画面・起動時の処理
  app/src/main/java/.../           Kotlin（下表）
tests/                    テスト（下の「テスト」）
tools/sync_prompt.py      指示文を keiba_scraper.py から scraper.js へ写す（下の「指示文と設定値」）
docs/                     説明書と画面例（記録の形式は record-format.md、実機での確認は device-test.md）
.github/workflows/android.yml      Android版のビルドと配布（tests.yml を通ってから）
.github/workflows/tests.yml        テスト
```

## PC版と Android版の対応

| PC版 | Android版 |
|---|---|
| `keiba_scraper.py` の解析・整形 | `scraper.js`（同じ処理を JavaScript に移植） |
| `fetch_page`・`collect_race`（Playwright） | `Scraper.kt`（WebView） |
| 対話（`run.bat`） | `ui.html`・`ui.css`・`js/`（画面）と `MainActivity.kt`（画面との受け渡し） |
| — | `Reservations.kt`・`Receivers.kt`・`CollectService.kt`（通知・自動収集・締切前の確認・結果の自動取得）、`Backup.kt`（自動バックアップ）、`Updater.kt`（更新）、`Config.kt`（設定値）、`ErrorLog.kt`（エラーの記録） |

- 解析を直すときは、`keiba_scraper.py` と `scraper.js` の両方を同じように直す。予想の条件の既定値（`BUDGET`・`MAX_BETS`・`EV_MIN`・`BET_MODE`・`HIT_MIN`・`HIT_EV_MIN` ↔ `DEFAULT_SETTINGS`）・競馬場コード・アクセス間隔（`REQUEST_INTERVAL`）も両方にある
- 予想の記録と答え合わせも両方にある（PC版の `parse_ai_block`・`parse_result`・`settle_bets`・`horse_rows`・`compute_summary` ↔ `scraper.js` の `parseAiBlock`・`parseResult`・`settleBets`・`horseRows`・`computeSummary`）。95%区間のブートストラップは、`scraper.js` に Python の `random.Random` と同じ乱数（MT19937）を移植しているので、同じ記録なら同じ値になる。記録の形式も同じなので、Android版の書き出しを PC版の `import` で取り込める
- オッズの注記（`odds_notes` ↔ `oddsNotes`）も両方にある
- AI なしの目安（`marketPicks`・補正した Harville 法 `harvilleDiscounted`）は Android版だけにある。記録の `市場買い目` の答え合わせと集計（`settle_bets`・`compute_summary` の `market_bets`）は両方にある
- 結果ページは HTML の時点で着順と払戻の表が入っているので、描画せずに HTML だけを取って解析する（PC版 `fetch_html`・`decode_html` ↔ `Scraper.kt` の `fetchHtml`・`decodeHtml`。取れないときだけブラウザで開く）。出馬表・オッズのページはスクリプトで表を描くので、これまでどおりブラウザで開く。どちらもアクセス間隔（`REQUEST_INTERVAL`）は守る
- 小数の結果を両方で同じにするための約束
  - 足し算は先頭から順に足す（PC版は `_sum`。Python 3.12 以降の `sum` は誤差を補正するので使わない）。馬は馬番の順に並べてから足す
  - 小数の表示は Python の `f"{x:.1f}"` と同じ丸め（ちょうど半分は偶数へ）。`scraper.js` では `toFixed` ではなく `pyFixed` を使う
  - 集計（`compute_summary` ↔ `computeSummary`）は、渡された順ではなく race_id の順に並べ直してから計算する
- 時刻はすべて日本時間で扱う（Android版は端末の時間帯によらない。`js/ui-core.js` の `jstNow`、Kotlin の `Jst`）
- 即PAT・A-PAT の発売カレンダーの解析（`parsePatCalendar`）と、取り直したときのオッズの変化（`diffRaces`・`formatDiff`）は Android版だけにある
- 画面の JS はふつうの `<script>` なので、上のファイルの `const` や `function` はあとのファイルからそのまま使える。読み込む順番に意味があり、起動時の処理は `ui-settings.js` の最後にある

## 指示文と設定値

- 指示文（`PROMPT_TEXT`・買い方ごとの文 `MODE_TEXT`）は `keiba_scraper.py` だけを直し、`python tools/sync_prompt.py` で `scraper.js` の「自動生成ここから」〜「ここまで」に写す（手で直さない）。写し忘れはテストで止まる
- しきい値などの設定値は1か所にまとめてある：PC版は `keiba_scraper.py` の先頭近くの定数、アプリは `scraper.js` の `CONFIG`（画面からは `KS.CONFIG`）、Kotlin は `Config.kt`。同じ名前の値は `tests/test_config.py` で一致を確かめる
- 記録の形式を変えるときは [record-format.md](record-format.md) の手順に従う（`RECORD_SCHEMA` を上げ、`migrate_record`・`migrateRecord` に直し方を足す）
- アプリのエラーは、画面側（`js/ui-core.js` の `logError`）と Kotlin 側（`ErrorLog`）の両方に残り、設定 →「エラーの記録」で見てコピーできる。`catch` で握りつぶさず `logError` を呼ぶ
- 裏で動く処理（通知・アラーム・締切前の確認・バックアップ・小窓）はテストで確かめられないので、版を出したら [device-test.md](device-test.md) の手順で実機で確かめる

## テスト

`tests/` にあり、GitHub Actions で PC版・画面・テストを変えたときと、Android版をビルドする前に動きます（失敗すると APK を出しません）。

| ファイル | 中身 |
|---|---|
| `test_parity.py` | PC版（`keiba_scraper.py`）とアプリ版（`scraper.js`）に同じ入力（`fixtures/` のページ・記録・AI の回答）を渡し、解析・AI へ送るテキスト・指示文・Harville 法・集計（回収率・精度・CLV）・記録用ブロックの読み取りが一致するか比べる |
| `test_config.py` | PC版・アプリ・Kotlin の同じ名前の設定値が一致するか確かめる |
| `ui_smoke.js` | アプリの画面を Chromium（幅360px、ライトとダーク）で開き、一覧 → 収集 → 結果 → AI の回答の読み込み → 買った馬券 → 記録の画面 → 設定 → エラーの記録 → 動作確認と操作して、画面のエラー・横へのはみ出し・主な要素を確かめる |

手元で動かすときは次のとおり（Python の beautifulsoup4・playwright と Node.js が要る）。

```
cd tests
npm install
npx playwright install chromium
python test_parity.py
python test_config.py
node ui_smoke.js
python ../tools/sync_prompt.py --check
```

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
