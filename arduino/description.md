# Cosmic Ray Detector v2 — ファームと Web アプリの通信仕様

v2 本番ファーム（`v2/COSMICRAY_DETECTOR_ESP32-S3-Nano-v2/COSMICRAY_DETECTOR_ESP32-S3-Nano-v2.ino`）と
ダッシュボード（`v2/index.html`）のあいだの取り決めをまとめた文書。
`v2/index.html` はこの文書に合わせて書かれているので、ファームの出力形式を変えたら
ここも同時に直すこと。

- 対象ハードウェア: Arduino Nano ESP32 + cosmic-ray-detector v2 基板
- 通信: USB シリアル（9600 bps。USB CDC なので実際の速度には影響しない）／ BLE Nordic UART Service（NUS）
- デバイス名（BLE 広告名）: 既定 `CosmicRay`（`SET_BLENAME` で変更可）

> ⚠️ 食い違いがあったときは `.ino` 実装 > `description.md` > `MANUAL.html` の順で正とする。
>
> ⚠️ **v2 基板には必ず `v2/index.html` を使う。** `v1/index.html` は 4 列目を SiPM 電圧、
> 5 列目を ms 単位のデッドタイムとして読むため、v2 の行を読むと 1 列ずつずれる。
>
> ⚠️ **波形ファーム**（`v2/COSMICRAY_WAVEFORM_ESP32-S3-Nano-v2`）は別物。`SET_SCOPE` を知らず、
> しきい値応答も `THRESH:s,r` 形式で、BLE もない。波形ファームには `wave_plotter.html` を使う。

---

## 1. 接続プロトコル

### 1.1 BLE（Nordic UART Service）

| 項目 | 値 |
|---|---|
| Service UUID | `6E400001-B5A3-F393-E0A9-E50E24DCCA9E` |
| RX Characteristic（アプリ→デバイス, Write / Write-No-Response）| `6E400002-B5A3-F393-E0A9-E50E24DCCA9E` |
| TX Characteristic（デバイス→アプリ, Notify）| `6E400003-B5A3-F393-E0A9-E50E24DCCA9E` |

- デバイス側の TX は **20 バイト単位に分割して Notify** し、チャンクの間に 3 ms 空ける。
  1 回の Notify が 1 行とは限らないので、アプリ側は **改行（`\n`）まで連結して行にする**。
- ファームの出力は ASCII のみ。通知ごとに `TextDecoder` で復号しても文字が割れることはない。
- RX（コマンド）は **改行（`\n` または `\r`）で確定**。20 バイトを超えるコマンドは
  分割して書き込んでよい（ファームが改行まで連結する）。
- **1 コマンドは 47 文字以内**（2026-10 以前のファームは 31 文字）。長すぎる行は丸ごと捨てられ、
  `### ERROR: command too long (max 47 chars), ignored.` が返る（以前のファームは黙って切り詰めていた）。
- BLE で受けたコマンドは、受信コールバックではキューに積むだけで、`loop()` の中で実行される。
- GATT の書き込みは同時に 1 件しかできない。アプリは前の書き込みの完了を待ってから次を送ること
  （Chrome は重なった書き込みを `GATT operation already in progress` で拒否する）。

### 1.2 Web Serial API（USB 直結）

- `navigator.serial.requestPort()` → `open({ baudRate: 9600 })`。
- 行区切り（`\n` / `\r\n`）は自前で分割する（ESP32 側は `Serial.println` = `\r\n`）。
- 出力・コマンド応答は BLE とまったく同じ。伝送層だけ差し替えればよい。
- ESP32-S3 のネイティブ USB は、ポートを開いたときの DTR/RTS の状態でブートローダーに入ることがある。
  `ESP-ROM:` や `waiting for download` が見えたら RTS をパルスして通常起動させる（`v2/index.html` 参照）。

---

## 2. デバイスからの受信ストリーム

行単位のテキスト。起動直後に起動メッセージとヘッダ、以後は「イベント行」「コマンド応答行」
「`###` で始まる情報行」「オシロの `WF,` 行」が混ざって届く。

### 2.1 起動時の出力

```
Booting v2...
### Auto-calibrating threshold on boot...                ← USB のみ
### Auto-threshold calib: min=12 max=44 margin=50 -> thr=94
BLE: Advertising as 'CosmicRay'                          ← USB のみ
SD: init OK at 4000000 Hz        (失敗時は "SD: init failed (CS=.. MOSI=.. MISO=.. SCK=..)" など)
SD: ready
SD: logging to /LOG0001.TXT
BME280: OK                       (無いときは "BME280: not found")   ← USB のみ
##########################################################################################
### Accel Kitchen
### https://accel-kitchen.com/
### info@accel-kitchen.com
### SD log file: /LOG0001.TXT                            ← SD が使えないときは出ない
### Signal threshold: 94 (Duty 96)
MODE:ANALOG                                              ← `###` が付かない
SD:ON
EXT:ON
OLED:ON
VIB:ON
### Event Time[us] ADC[0-4095] Deadtime[us] Temp[C] Hum[%] Press[hPa] Dig1 Dig2 Dig3 Ana1 Ana2 Ana3
##########################################################################################
```

- **しきい値（`SIGNAL_THRESHOLD`）は起動のたびに自動校正される**（A0 を 100 点 × 10 ms 見て、
  最大値 + `AUTO_MARGIN`）。保存値はそのたびに上書きされる。
- **トリガーモードは常に ANALOG で起動する**（`SET_MODE` は保存されるが、起動時には読まない）。
- アプリは `Booting` を見たら基板が再起動したと判断し、状態を問い合わせ直す（`GET_*`）。
  オシロも必ず OFF で起動する。

### 2.2 イベント行（1 イベント 1 行）

```
<count> <time_us> <adc> <deadtime_us> <temp_c> <hum_pct> <press_hPa> <d1> <d2> <d3> <a1> <a2> <a3>
```

ファームの書式は `"%lu %llu %d %llu %.1f %.1f %.1f %d %d %d %d %d %d"`。区切りは半角スペース 1 つ、13 列。

| 列 | 型 | 意味 |
|---|---|---|
| `count` | uint32 | 起動または `RESET` からのイベント番号（1 始まり）|
| `time_us` | uint64 | 起動または `RESET` からの経過時間 **[µs]** |
| `adc` | int 0–4095 | 自検出器のピークホールド出力（A0, 12 bit）|
| `deadtime_us` | uint64 | 起動または `RESET` からの **累積** デッドタイム **[µs]** |
| `temp_c` | float 1 桁 | BME280 温度 [°C]。センサが無いと `nan` |
| `hum_pct` | float 1 桁 | BME280 相対湿度 [%]。センサが無いと `nan` |
| `press_hPa` | float 1 桁 | BME280 気圧 [hPa]。センサが無いと `nan` |
| `d1`〜`d3` | 0 / 1 | 外部検出器 1〜3 のデジタル入力（`EXT:OFF` のときは 0）|
| `a1`〜`a3` | int 0–4095 | 外部検出器 1〜3 のアナログ入力（`EXT:OFF` のときは 0）|

デッドタイムに入るもの:

- 1 イベントの処理時間
- OLED の書き換え（2 秒ごと）
- **オシロを開いていた時間**（その間の OLED 書き換えやコマンドは二重に足さない）
- **コマンドを実行していた時間**。BLE の応答は 20 バイトごとに 3 ms 待つので数 ms、
  `AUTO_THRESH` は約 1 秒、`AUTO_PWM` は約 7 秒、`VIB_TEST` は約 1 秒。`RESET` は除く

オシロ中に `RESET` した場合、閉じたときに足す滞在時間は `RESET` の時点からになる
（`deadtime_us` が `time_us` を超えることはない）。

**計数率は `Δcount / (Δtime_us − Δdeadtime_us)` で求める**（OLED と同じ式）。
ブラウザが受け取った行数を経過時間で割ってはいけない。接続前から動いていた基板では
受信数と経過時間の基準がずれ、デッドタイムも引かれないため。
`count` / `time_us` / `deadtime_us` が減ったら `RESET` か再起動なので、そこで区間を切り替えて足し合わせる。

### 2.3 コマンド応答行

コマンドの結果は **応答行として後から push される**。アプリは送信直後に表示を書き換えず、
応答行が届いてから更新する。

| 応答 | 形式 | 返すコマンド |
|---|---|---|
| しきい値 | `THRESH:<sig> DUTY:<duty>` | `GET_THRESH` `SET_THRESH` `AUTO_THRESH[:m]` |
| コンパレータ PWM | `PWM:<duty>`（0–255）| `GET_PWM` `SET_PWM` `AUTO_PWM[:target]` |
| 自動校正マージン | `AUTO_MARGIN:<m>` | `GET_AUTO_MARGIN` `SET_AUTO_MARGIN` `AUTO_THRESH:m` |
| トリガーモード | `MODE:<DIGITAL\|DUAL\|ANALOG>` | `GET_MODE` `SET_MODE` |
| 機能スイッチ | `SD:ON` `EXT:OFF` `OLED:ON` `BUZZER:ON` `VIB:OFF` など | `GET_*` `SET_*` |
| ブザー | `BEEP:<min_hz>,<max_hz>,<ms>` | `GET_BEEP` `SET_BEEP` `BEEP_TEST` |
| 振動 | `VIBMS:<min_ms>,<max_ms>` | `GET_VIB_MS` `SET_VIB_MS` `VIB_TEST` |
| オシロ | `SCOPE:ON` / `SCOPE:OFF` | `GET_SCOPE` `SET_SCOPE`（すでにその状態なら `SET_SCOPE` は何も返さない）|
| オシロのレート上限 | `SCOPE_RATE:<n>` | `GET_SCOPE_RATE` `SET_SCOPE_RATE` |
| オシロの再アーム（しきい値からの差）| `SCOPE_REARM:<offset>` | `GET_SCOPE_REARM` `SET_SCOPE_REARM` |
| オシロの撮り方 | `SCOPE_TRIG:NORMAL` / `SCOPE_TRIG:FREE` | `GET_SCOPE_TRIG` `SET_SCOPE_TRIG` |
| BLE 名 | `BLENAME:<name>` | `GET_BLENAME` `SET_BLENAME` |
| BLE アドレス | `BTADDR:<aa:bb:cc:dd:ee:ff>` | `GET_BTADDR`（USB でも返る）|
| リセット | `RESET:OK` | `RESET` |

`VIBMS:` は `VIB:` で前方一致しないので取り違えない。`PWM:` を処理し忘れると、
13 列のイベント行の判定で黙って捨てられるので注意。

情報行（`###` で始まる。表示用）の主なもの:

```
### Auto-calibrating threshold...
### Auto-threshold calib: min=<min> max=<max> margin=<m> -> thr=<thr>
### AUTO_PWM sweep: duty,comp_rate[/s]
### <duty>,<rate>                     ← 掃引の 1 段ごと
### AUTO_PWM done: duty=<d> comp_rate=<r>/s (noise peak=<p>/s, target<=<t>/s)
### Tip: run AUTO_PWM to calibrate the comparator threshold for digital triggering.
### SCOPE: ON - counting is PAUSED while the scope is open.
### SCOPE: OFF - counting resumed.
### SCOPE: no command for 60 s, turning the scope OFF to resume counting.
### BLE name saved. Restarting in 1s...
### ERROR: command too long (max 47 chars), ignored.
SD: write failed
```

### 2.4 オシロの波形行

`SET_SCOPE:ON` のあいだだけ、イベント行の代わりに次の行が流れる（計数は止まる）。

```
WF,<n>,<t_ms>,U,<npre>,<ntot>,<period_ns>,<v0>,<v1>,...,<v(ntot-1)>
```

| 項目 | 意味 |
|---|---|
| `n` | オシロ ON からの波形番号（0 始まり）|
| `t_ms` | オシロ ON からの経過時間 [ms] |
| `U` | 種別（現状 `U` のみ）|
| `npre` | トリガ前の点数（通常 32）|
| `ntot` | 総点数 = `npre + 1 + 128` |
| `period_ns` | サンプル周期 [ns]（12000 = 12 µs/点）|
| `v*` | A0 の ADC 値。**ピークホールドの出力**で、アンプの生波形ではない |

カンマ区切りで空白を含まないので、イベント行の判定より前に `WF,` で拾うこと。
項目数が `7 + ntot` と合わない行は、USB の送信が詰まって途中で切れたものなので捨てる。

### 2.5 行の見分け方（`v2/index.html` の判定順）

1. `ESP-ROM:` / `waiting for download` → ブートローダー（通常起動させる）
2. `Booting` → 再起動。状態を問い合わせ直す
3. `THRESH:` `PWM:` `MODE:` `AUTO_MARGIN:` `BEEP:` `VIBMS:` `BLENAME:` `BTADDR:` `SD:` `EXT:` `OLED:` `BUZZER:` `VIB:` → 応答
4. `#` で始まる → 情報行（`### Signal threshold: <sig> (Duty <duty>)` だけは値を読む）
5. `BLE:` `SD:` `BME280:` `OLED` で始まる → システムメッセージ
6. `WF,` → 波形、`SCOPE:` `SCOPE_RATE:` `SCOPE_REARM:` `SCOPE_TRIG:` → オシロの応答
7. 空白区切りでちょうど 13 列 → イベント行。列数が違う行（行が連結した・途中で切れた）、ADC・フラグ・アナログ値が範囲外の行は捨てる（count ≥ 1、ADC とアナログは 0〜4095、Dig は 0 か 1）。温度 −40〜125、湿度 0〜100、気圧 300〜1100 の外の値は nan として扱う

---

## 3. アプリ → デバイスのコマンド

すべて ASCII、大文字小文字を区別、末尾に `\n`。47 文字以内。

### 3.1 しきい値（2 種類ある）

v2 には **2 つの独立したしきい値** がある。

- **信号しきい値 `SIGNAL_THRESHOLD`**（0–4095）: A0（ピークホールド）の ADC 値と比べる。
  ANALOG モードのトリガ、DUAL モードの再確認、オシロのトリガに使う。
- **コンパレータしきい値 = PWM duty**（0–255, D2）: 外部コンパレータの基準電圧。
  DIGITAL / DUAL モードのトリガはこちらで決まる。

以前は duty を `SIGNAL_THRESHOLD` から換算していたが、コンパレータ（アンプ出力を見る）と
A0（ピークホールド）はスケールが違い、換算するとしきい値がノイズ帯に落ちていた。
現在は **`SET_THRESH` は duty を変えない**。duty は `SET_PWM` / `AUTO_PWM` で決める。

| コマンド | 説明 | 応答 |
|---|---|---|
| `GET_THRESH` | 信号しきい値と現在の duty | `THRESH:<sig> DUTY:<duty>` |
| `SET_THRESH:<n>` | 信号しきい値を設定（0–4095）・保存 | `THRESH:...` |
| `AUTO_THRESH` | A0 を 100 点 × 10 ms 測り、最大値 + マージンにする | 校正ログ → `THRESH:...` |
| `AUTO_THRESH:<m>` | マージンを `m` に変えて（保存）から自動校正 | 校正ログ → `THRESH:...` → `AUTO_MARGIN:<m>` |
| `GET_AUTO_MARGIN` / `SET_AUTO_MARGIN:<m>` | 自動校正のマージン（0–4095）| `AUTO_MARGIN:<m>` |
| `GET_PWM` | コンパレータの duty | `PWM:<duty>` |
| `SET_PWM:<d>` | duty を設定（0–255 に丸める）・保存 | `PWM:<duty>` |
| `AUTO_PWM` / `AUTO_PWM:<target>` | duty を 0→255 まで 8 刻みで掃引し、ノイズ山を越えてコンパレータの反応が `target`/s（既定 50）以下に落ちた点 + 2 刻みを採用・保存。約 7 秒ブロックし、その時間はデッドタイムに入る | 掃引ログ → `PWM:<duty>` |

> v1 の `SET_THRESH:sig,rst`（2 引数）は廃止。

### 3.2 トリガーモード

| コマンド | 説明 | 応答 |
|---|---|---|
| `GET_MODE` | 現在のモード | `MODE:<..>` |
| `SET_MODE:DIGITAL` | コンパレータの立ち上がり（D0）で割り込み | `MODE:DIGITAL` + Tip 行 |
| `SET_MODE:DUAL` | 割り込み後に A0 を読み、`SIGNAL_THRESHOLD` 未満なら捨てる | `MODE:DUAL` + Tip 行 |
| `SET_MODE:ANALOG` | 割り込みを使わず、`loop()` で A0 をポーリング | `MODE:ANALOG` |

**モードは保存されるが、起動時は常に ANALOG。** DIGITAL / DUAL に切り替えたら、一度 `AUTO_PWM` を実行する。

### 3.3 計数・機能スイッチ・出力

| コマンド | 説明 | 応答 |
|---|---|---|
| `RESET` | `count`・`time_us`・`deadtime_us` を 0 に戻す。オシロ中なら滞在時間の起点も今にする | `RESET:OK` |
| `GET_SD` / `SET_SD:ON\|OFF` | microSD へのログ | `SD:..` |
| `GET_EXT` / `SET_EXT:ON\|OFF` | 外部検出器（Dig/Ana 読み取りと COIN_OUT）| `EXT:..` |
| `GET_OLED` / `SET_OLED:ON\|OFF` | OLED 表示 | `OLED:..` |
| `GET_BUZZER` / `SET_BUZZER:ON\|OFF` | ブザー | `BUZZER:..` |
| `GET_VIB` / `SET_VIB:ON\|OFF` | 振動モーター | `VIB:..` |
| `GET_BEEP` / `SET_BEEP:<min>,<max>[,<ms>]` | 波高→音程の対数マッピング（50 ≤ min < max ≤ 20000 Hz、1–500 ms）| `BEEP:<min>,<max>,<ms>` |
| `BEEP_TEST` | 最低・中間・最高の 3 音を鳴らす | `BEEP:...` |
| `GET_VIB_MS` / `SET_VIB_MS:<min>,<max>` | 波高→振動時間（1 ≤ min < max ≤ 500 ms）| `VIBMS:<min>,<max>` |
| `VIB_TEST` | 短・中・長の 3 回振動（約 1 秒ブロック。コマンドの実行時間としてデッドタイムに入る）| `VIBMS:...` |

### 3.4 オシロ

| コマンド | 説明 | 応答 |
|---|---|---|
| `SET_SCOPE:ON` | 計数を止め、ADC1 を DMA に渡して `WF,` 行を流す | 情報行 → `SCOPE:ON`。すでに ON なら**何も返さない** |
| `SET_SCOPE:OFF` | 計数を再開。ON だった時間をデッドタイムに足す | 情報行 → `SCOPE:OFF`。すでに OFF なら**何も返さない** |
| `GET_SCOPE` | 現在の状態 | `SCOPE:ON\|OFF` |
| `SET_SCOPE_RATE:<n>` / `GET_SCOPE_RATE` | 波形の送出上限 [/s]（1–20）| `SCOPE_RATE:<n>` |
| `SET_SCOPE_REARM:<offset>` / `GET_SCOPE_REARM` | 再アームの水準を「しきい値 − `offset`」にする（`offset` は 0–4095、既定 5）。範囲外・読めない値は無視して、いまの値を返す | `SCOPE_REARM:<offset>` |
| `SET_SCOPE_TRIG:NORMAL\|FREE` / `GET_SCOPE_TRIG` | 撮り方。`NORMAL` = しきい値を超えたときだけ、`FREE` = トリガーなしで最新の窓を `SCOPE_RATE` の間隔で出し続ける | `SCOPE_TRIG:NORMAL` または `SCOPE_TRIG:FREE` |

- オシロは保存されない。起動時は必ず OFF。再アームのオフセット（既定 5）と撮り方（既定 `NORMAL`）も保存されず、起動時にこの既定へ戻る。
  アプリは、オシロを開くたびに `SET_SCOPE_RATE` → `SET_SCOPE_TRIG` → `SET_SCOPE_REARM` → `SET_SCOPE:ON` の順で送る。
- **トリガーと再アーム**（`NORMAL`）: A0 が `SIGNAL_THRESHOLD` を超えたときに窓を 1 本取る。取ったら A0 を放電し、
  A0 が再アーム水準**以下**に戻るまで次を受け付けない。再アーム水準は **`SIGNAL_THRESHOLD − offset`**（0 未満にはしない。`offset` の既定は 5）。
  しきい値からの差で持つので、`SET_THRESH` やアプリでしきい値の線を動かすと、再アーム水準も一緒に動く。
  ベースラインがこの水準より下まで来ないと、**波形は 1 本も出ない**。
  以前は水準が「しきい値の半分」に固定されていた。実機の A0 のベースラインは約 86 なので、しきい値が約 170 より低いと半分がベースラインを下回り、開いても波形が出なかった。
- **連続撮影**（`FREE`）: トリガーを使わず、`SCOPE_RATE` の間隔で、いちばん新しい窓（`npre` = 32、`ntot` = 161）を `WF,` 行で出す。
  A0 はピークホールドなので、1 本出すたびに放電する。窓のどこが「トリガー点」かは決まっていない（`npre` は窓の形のために同じ値を使うだけ）。
- `SET_SCOPE:ON` のとき、取り方を残すために `### trigger above <thr>, re-arm at or below <n> (threshold - <offset>).`（または `### FREE-RUN: …`）の情報行を出す。波形が出ないときの手がかり。
- **安全装置**: オシロ ON のまま **60 秒間どんなコマンドも来なければ、ファームが自分で OFF に戻す**。
  アプリはオシロを表示している間、15 秒ごとに `GET_SCOPE` を送って延長する。
  ページを閉じて `SET_SCOPE:OFF` が届かなくても、計数が止まったままにならない。
- アプリは接続時に `GET_SCOPE` を送り、オシロを開いていないのに `SCOPE:ON` が返ったら `SET_SCOPE:OFF` を送る。
- `SET_SCOPE` の応答を待つ実装にしないこと（すでにその状態だと応答がない）。状態は `GET_SCOPE` で確かめる。
- `v2/index.html` は、オシロのタブが **10 分間操作されなければ解析タブに戻して計数を再開**し、画面上部でそれを知らせる。
  オシロ中はヘッダに「計数停止中」と停止してからの時間を出す。

### 3.5 BLE 名・アドレス

| コマンド | 説明 | 応答 |
|---|---|---|
| `GET_BLENAME` | 現在の広告名 | `BLENAME:<name>` |
| `SET_BLENAME:<name>` | 印字可能 ASCII 1–24 文字。保存して 1 秒後に再起動 | `BLENAME:<name>` → 情報行 → 再起動 |
| `GET_BTADDR` | 基板の BLE アドレス（USB 接続でも返る）。古いファームは応答しない | `BTADDR:<addr>` |

`v2/index.html` は名前を **19 文字まで** に制限している。古いファーム（コマンド 31 文字）でも
`SET_BLENAME:`（12 文字）+ 19 文字なら切り詰められないため。名前は `BLENAME:` が返ってから保存する。

---

## 4. `v2/index.html` 側の取り決め

- **接続直後と `Booting` 受信時の問い合わせ**: `GET_BLENAME` `GET_THRESH` `GET_PWM` `GET_MODE` `GET_SCOPE`
  `GET_SD` `GET_EXT` `GET_OLED` `GET_BUZZER` `GET_VIB` `GET_AUTO_MARGIN` `GET_BEEP` `GET_VIB_MS` `GET_BTADDR` を、
  800 ms 待ってから 1 件ずつ（80 ms 間隔）送る。すべてのコマンドは 1 本の待ち行列を通り、前の送信の完了を待つ。
- **計数率**: 2.2 節の式。経過時間・デッドタイムの表示も同じ区間の合計で、**「データを消去」からの累計**
  （総イベント数・ヒストグラムと同じ範囲）。切断・再接続をまたいで続く。
  別の基板（`BTADDR:` が前と違う）につながったときにデータが残っていれば、画面上部で消去を勧める。
- **BLE の自動再接続**: 利用者が切断していないのに BLE が切れたら、1, 2, 4, … 最大 30 秒の間隔で再接続を続ける。
  自動保存のファイル、計数率の区間、「記録を停止」の状態はそのまま引き継ぐ。
- **保存ファイル**（自動保存・ダウンロード共通の部分）
  - 自動保存のファイル名: `<BLE 名>_<PC のローカル日付>.dat` / `.csv`。
    ダウンロードのファイル名: `<BLE 名>_<YYYY-MM-DD_HH-MM-SS>.dat` / `.csv`（接続した時刻。未接続なら保存した時刻）。
  - 合成データ（デモ）のイベントは、デモを止めたあとに書く分も含めて必ず先頭に `DEMO_` が付いたファイルに入り、
    ヘッダに注記が入る。デモかどうかは書く時点ではなくイベントごとに記録している。
  - 自動保存のファイル名の接頭辞は、接続後の最初の書き込みで決まり、切断まで変わらない。
  - 自動保存のファイルは 64 MB を超えたら `<BLE 名>_<日付>_02.dat`、`_03` … に続ける（それぞれにヘッダが入る）。
    書き込み間隔は 1 回の書き込み時間から 1〜15 秒で自動調整し、タブを切り替えた・閉じるときはすぐ書く。
    未保存のイベントが残っているときにタブを閉じようとすると、ブラウザが確認を出す。
  - 先頭は `#` で始まるメタデータ行（コメント、デバイス名、モード、しきい値、PWM duty、注記）。
    CSV にも入るので、pandas では `read_csv(path, comment='#')` で読む。
    ヘッダはファイルが空のときだけ書く（再接続しても途中にヘッダが混ざらない）。
  - 列: `Event, PC_Timestamp, Time_us, ADC, Deadtime_us, Temp_C, Hum_pct, Press_hPa, Dig1, Dig2, Dig3, Ana1, Ana2, Ana3`。
    **2 列目にページが PC 時刻を挿入しているので、3 列目以降はファーム / SD ログより 1 列右にずれる。**
  - `PC_Timestamp` は UTC（末尾 `Z`）。画面の表はローカル時刻で表示する。
  - 気圧はファームと同じ小数 1 桁。
- **サーバー送信の互換モード**: deadtime は ms に換算、time は µs のまま送る（`server-plan.html` の仕様どおり）。

---

## 5. 検証用フィクスチャ

### 5.1 イベント行（RESET 直後から 10 件）

```
1 523000 2104 12000 24.3 47.9 1013.2 0 0 0 128 512 304
2 1189000 1872 18000 24.3 47.9 1013.2 1 0 0 141 498 312
3 2044000 3901 25000 24.4 48.0 1013.1 0 1 0 132 602 295
4 3712000 2255 33000 24.4 48.0 1013.1 0 0 0 119 487 308
5 5120000 2088 40000 24.4 48.1 1013.1 1 1 0 144 533 317
6 7305000 4005 48000 24.5 48.1 1013.0 0 0 1 125 521 301
7 9021000 2341 55000 24.5 48.2 1013.0 0 0 0 137 505 296
8 10832000 1966 62000 24.5 48.2 1013.0 1 0 0 140 488 310
9 12544000 3488 70000 24.6 48.3 1012.9 0 0 0 122 517 308
10 14801000 2109 77000 24.6 48.3 1012.9 0 1 0 138 524 313
```

この 10 件の計数率は `10 / ((14801000 − 0) − (77000 − 0)) × 1e6 ≈ 0.679 cps`
（`count` が 1 から始まっているので、区間の起点は 0）。

BME280 が無い基板の行:

```
11 16020000 1990 84000 nan nan nan 0 0 0 0 0 0
```

### 5.2 コマンド応答の例

```
→ GET_THRESH
← THRESH:94 DUTY:96

→ SET_MODE:DUAL
← MODE:DUAL
← ### Tip: run AUTO_PWM to calibrate the comparator threshold for digital triggering.

→ AUTO_THRESH:50
← ### Auto-calibrating threshold...
← ### Auto-threshold calib: min=12 max=44 margin=50 -> thr=94
← THRESH:94 DUTY:96
← AUTO_MARGIN:50

→ AUTO_PWM
← ### AUTO_PWM sweep: duty,comp_rate[/s]
← ###   0,61234
← ###   8,60990
←   …
← ### AUTO_PWM done: duty=88 comp_rate=3/s (noise peak=61234/s, target<=50/s)
← PWM:88

→ SET_SCOPE:ON
← ### SCOPE: ON - counting is PAUSED while the scope is open.
← ###        A0 is the PEAK-HOLD output, not the raw amplifier pulse.
← SCOPE:ON
← WF,0,412,U,32,161,12000,86,85,87,…
```

---

## 6. 参考ファイル

- ファーム: `v2/COSMICRAY_DETECTOR_ESP32-S3-Nano-v2/COSMICRAY_DETECTOR_ESP32-S3-Nano-v2.ino`
- ダッシュボード: `v2/index.html`
- 波形ファームと専用ビューア: `v2/COSMICRAY_WAVEFORM_ESP32-S3-Nano-v2/`、`wave_plotter.html`
- 回路図: `cosmic-ray-detector.kicad_sch`（ピン配置の確認用）
- 既存マニュアル（一部旧仕様が残る）: `MANUAL.html`
