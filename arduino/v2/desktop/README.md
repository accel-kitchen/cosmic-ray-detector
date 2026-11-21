# CosmicRay Console デスクトップ版

`arduino/v2/console` のコンソールを、そのまま Electron に入れた常駐アプリです。全機種（v1・OWAN、V2・OHASHI、v2.1、OKOME）に対応します。
画面と解析はブラウザ版とまったく同じで、アプリ本体が足すのは「長時間つけっぱなしにする」ための次のことだけです。

| できること | どうやっているか |
|---|---|
| ウィンドウを閉じてもトレイ（Mac はメニューバー）で記録を続ける | 閉じるボタンでは隠すだけ。止めるのはトレイの「終了」（Mac は ⌘Q も可） |
| 隠れていても 1 秒ごとの自動保存・送信を間引かない | `backgroundThrottling: false` |
| つないでいる間は PC をスリープさせない | `powerSaveBlocker('prevent-app-suspension')` |
| 起動したとき・抜き差しのあと・スリープ明けに、前回の基板へ自動でつなぐ | 10 秒ごとに見張り、前回の基板だけを開く |
| 起動するとすぐ決まったフォルダに自動保存する | 既定は `書類\CosmicRay`（ポータブル版は exe の隣の `CosmicRay`）。トレイの「保存先を変更…」かコンソールの「フォルダを選ぶ」で変える |
| ログインしたら起動する | トレイのメニューで切り替え（インストールした版だけ） |

終わるときは必ずコンソールの `disconnect()` を通します（保存 → RTS → DTR の順に線を下げる → ポートを閉じる）。
ESP32-S3 は DTR と RTS が一度に下がるとリセットされる（またはダウンロードモードに入って数えなくなる）ためです。

## 3 つの版

| 版 | ファイル | 向いている人 |
|---|---|---|
| Windows インストール版 | `CosmicRayConsole-Setup-<版>.exe` | 自分の PC で毎日使う。ログイン時の起動が使える |
| Windows ポータブル版 | `CosmicRayConsole-Portable-<版>.exe` | インストールできない PC（学校など）、USB メモリで持ち歩く。設定は exe の隣の `CosmicRayConsole-data`、保存は `CosmicRay` に置き、PC には残さない。起動のたびに展開するので立ち上がりが数秒遅い。ログイン時の起動は使えない |
| Mac 版 | `CosmicRayConsole-<版>-mac-arm64.dmg`（Apple シリコン）/ `-x64.dmg`（Intel） | Mac。Windows の上では作れないので GitHub Actions で作る（下記） |

どれも署名していません。Windows は SmartScreen の「詳細情報 → 実行」、Mac は「システム設定 → プライバシーとセキュリティ → このまま開く」が要ります。
Mac で「壊れているため開けません」と出たときは、ターミナルで `xattr -cr "/Applications/CosmicRay Console.app"` を実行すると開けます。

## ブラウザ版との関係

- コンソールのファイルはこのフォルダに複製しません。開発中は `../console` を、作った版は `resources/console` に同梱した複製を `app://console/` で配ります。
- コンソール側の変更:
  - `assets/js/desktop.js`（新規）: `window.cosmicDesktop` が無ければ何もしない。ブラウザでは無害です。index.html と v1.html の違い（関数名・保存の状態の持ち方）はここで吸収し、アプリからは `desktopConnect()` / `desktopQuit()` / `desktopFlush()` だけを呼びます。
  - `core.js` と `v1.html` に `Hooks.pickSaveFolder` と、`selectSaveFolder` から切り出した `useSaveFolder()`。
  - `v1.html` の `disconnect()` が、閉じる前に RTS → DTR の順に線を下げるようにした（index.html と同じ）。前は閉じると ESP32-S3 の v1 基板がリセットされ、イベント番号と時刻が 0 に戻っていた。**ブラウザ版の v1 画面の「切断」にも効く修正です。**
- アプリの設定は `%APPDATA%\CosmicRay Console\desktop-settings.json`（Mac は `~/Library/Application Support/CosmicRay Console/`）、ログは同じ場所の `desktop.log` です。コンソールの設定（localStorage）はアプリの中に別に持ちます（ブラウザ版とは共有しません）。

## ポートの選び方

- **人がボタンを押したとき**（「USB で接続」・書き込みページ）は、毎回ポートの一覧を出します。前回の基板に ★、検出器らしい USB 機器（VID 303A / 2341 / 2886）を上に並べます。
- **アプリが自分でつなぐとき**（起動時・抜き差しのあと）は、前回コンソールでつないだ基板だけを選びます。見つからなければ何も開きません（同じ VID の別の ESP32 基板を勝手に開かないため）。
- 照合は USB のシリアル番号で行う作りですが、Windows の Electron 45 は ESP32-S3 にシリアル番号を渡してきませんでした。そのため Windows では **VID/PID と COM 番号** で照合しています。COM 番号が変わる（別の USB 口に差したなど）と自動では開かないので、一度「USB で接続」から選び直してください。
- 選んだ機器を覚えるのは、つないだあとに基板が名乗ってから（機種名かイベントが届いてから）です。間違えて選んだポート（Bluetooth の COM など）は覚えません。
- 書き込みページで選んだポートは覚えません。
- アプリは動いている間ずっとポートを開いています。ほかのツール（Arduino IDE、esptool）で書き込むときは、先に「切断」するかアプリを終了してください。

## 作り方

```powershell
cd arduino\v2\desktop
npm install
npm start
```

- `npm test` … ポート選択・保存ファイル名・設定の単体テスト
- `npm run icons` … `build/icon.png` と `build/tray.png` を紋章（crest-ohashi.svg）から作り直す
- `npm run pack` … `dist\win-unpacked` に展開した版を作る（インストーラなし）
- `npm run dist:win` … `dist\` にインストール版とポータブル版の exe を作る
- `npm run dist:mac` … Mac の上でだけ動く。dmg と zip（arm64 / x64）を作る
- F12 で開発者ツール

**Mac 版を作るには**、リポジトリを GitHub に push してから、Actions タブの **desktop-build** を「Run workflow」で動かします（`.github/workflows/desktop-build.yml`。`desktop-v*` のタグを push しても動きます）。Windows 版と Mac 版の両方を作り、その実行の Artifacts に置きます。

試験用のオプション（`npm start -- --demo` のように渡す）:

| オプション | 意味 |
|---|---|
| `--profile=<dir>` | 設定・localStorage・ログをこのフォルダに分ける（いつものアプリと同時に動かせる） |
| `--save-dir=<dir>` | 保存先をこのフォルダに固定する（設定には残さない） |
| `--port=COM64` | 自動接続でこのポート名だけを開く |
| `--demo` | 起動したらデモにつなぐ |
| `--hidden` | ウィンドウを出さずにトレイで始める（ログイン時の起動と同じ） |
| `--hide-after=<秒>` / `--quit-after=<秒>` | 決まった時間で隠す / ふつうの手順で終わる |
| `--capture=<png>` `--capture-delay=<秒>` | 画面を PNG に保存する |
| `--quit` | 動いているアプリ（同じ `--profile`）に、ふつうの手順で終わるよう伝える |
| `--test-js=<file>` | 最初のページの用意ができたら、このファイルの JS をページで 1 回動かす（開発中だけ） |
| `--chooser-cancel` | 人向けのポート選択画面を出さずに「キャンセル」とする（開発中だけ） |

## 確かめたこと（2026-11-21、Windows 11、Electron 45.4.1）

デモで:
- ウィンドウを一度も出さない状態でも、保存ファイルが数秒ごとに伸び続ける。
- 隠したまま 7 分動かしても、1 分ごとのイベント数は 171〜224 件で変わらない（Chrome が隠れたページのタイマーを強く間引き始める 5 分を過ぎても落ちない）。
- 同じ日に起動し直すと、同じファイルに続けて書く（見出しは 1 回だけ）。
- `--quit`（2 つ目の起動）でも `--quit-after` でも、`disconnect()` を通ってから終わる。
- 人のクリックなしでも、自動接続がポート選択まで進む（基板が無いときは何も開かず、10 秒ごとに見直す）。
- インストール版の構成（`dist\win-unpacked`）とポータブル版の exe で、同梱したコンソールが表示され、保存もできる。ポータブル版は設定と保存を exe の隣に作る。
- ブラウザ版（http://localhost:8765 の index.html と v1.html）は `desktop.js` を読んでも何もしない（エラーなし）。

実機（COM64、ESP32-S3 の v1 基板、USB 303A:1001）で:
- 起動しただけで v1 の画面が COM64 を開き、基板が名乗った（ESP32S3）ところでポートを覚えた。スリープ抑止が掛かり、終了で外れる。
- ウィンドウを隠したまま約 2 分、実際のイベント（179 件）が保存ファイルに途切れずに書かれた。
- 終了したあとも基板は数え続けた（v1.html の修正後。修正前は終了で基板がリセットされていた）。
- 「切断」を押したあとは、25 秒待っても自動でつなぎ直さない。
- 「USB で接続」を押すとポートの一覧が出て（自動では選ばない）、キャンセルしてもエラーを出さない。
- Electron のポート一覧に serialNumber が無い（VID/PID は 10 進の文字列）。

## まだ確かめていないこと

- **V2・v2.1・OKOME の実機**での保存（デモでは確かめた。同じ index.html の経路）。
- ケーブルの抜き差し、スリープと復帰、ログイン時の起動、ノート PC のふたを閉じたとき（`prevent-app-suspension` はふたを閉じたときのスリープまでは止めない）。
- Bluetooth（機器の選択画面は作ったが、Electron で動くかは未確認）。
- 書き込みページ（flash.html）を Electron の中で使うこと。
- サーバーへの送信（`app://console` から。サーバーは CORS で `*` を返すので通るはず）。
- インストーラを、まっさらな PC に入れること。
- **Mac 版はまだ一度も作っていない**（GitHub Actions の設定を書いただけ。Mac 用のメニュー、Dock、Bluetooth の利用目的の文言はコードに入れた）。

## 気づいたが直していないこと（v1 の画面、ブラウザ版も同じ）

- 保存ファイルの見出しが `# Board=ArduinoNano ADC=0-1023` になっていた。データには 1023 を超える ADC 値（2309 など）が入っている。基板の種別（ESP32-S3、12 bit）が分かる前の最初の書き込みで見出しを作るためと見られる（コードはまだ追っていない）。
- つないだ直後に、つなぐ前に溜まっていた古い行（数分前のイベント）が数件入ることがある。
