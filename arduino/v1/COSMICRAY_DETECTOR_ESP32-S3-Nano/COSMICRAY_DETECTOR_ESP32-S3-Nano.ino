/*
  Accel Kitchen Cosmic Detector - V1 detector board on ESP32-S3-Nano
  - https://accel-kitchen.com/
  - info@accel-kitchen.com

  V1 検出器（Arduino Nano 用アナログ回路）はそのままに、マイコンだけを
  ESP32-S3（Nano フォームファクタ）へ置き換えたスケッチ。

  ベース:
    - 検出ロジック / しきい値 / Master-Slave  : COSMICRAY_DETECTOR_v1.ino (Arduino Nano)
    - BLE / Preferences / micros64()          : COSMICRAY_DETECTOR_ESP32-S3-Nano-v2.ino

  V1 との主な違い:
    - ADC 10bit(0-1023) -> 12bit(0-4095)
    - BLE (Nordic UART Service) 追加。Serial と同じ行を同時に流す
    - しきい値・設定を NVS(Preferences) に永続化
    - SiPM 電圧の 11 次多項式 cal[] は削除。
      あの係数は Nano の外部AREF・ADCプリスケーラ8・約10us のサンプル点に
      紐付いており、ESP32-S3 では数値として意味を持たないため。
      4 列目は ADC ピンの実電圧[mV]（線形換算）に置き換えた。
    - デッドタイムを us で累積（V1 は /1000 の切り捨てで常に 0 だった）
    - リセット待ちにタイムアウトを追加（V1 は無限ループで停止しうる）
    - コインシデンスを割り込み+タイムスタンプ方式に変更。旧実装は窓のあいだ
      ポーリング/HIGH 保持で最大 10ms ブロックしていたが、現実装はほぼ待たない
    - 対称コインシデンスモード SET_COINC:PAIR を追加（両機がゲート。詳細は
      CoincMode の解説を参照）

  V1 基板に存在しないため未実装:
    BME280 / コンパレータによるデジタルトリガ / PWM しきい値DAC /
    ピークホールド回路 / ブザー / SDカード / 外部検出器入力

  ============================================================================
  ビルド設定（間違えると OLED が無反応になる）
  ============================================================================
    Board            : ESP32S3 Dev Module   (esp32:esp32:esp32s3)
    USB CDC On Boot  : ★ Enabled 必須 ★
    ※ 公式 Arduino Nano ESP32 を選んでもよい（下の #if で自動対応）。ただし
       サードパーティ製クローン機は公式の VID/PID を持たないため、
       nano_nora では書き込みに失敗することがある。

    USB CDC On Boot が Disabled だと Serial が UART0（GPIO43/44 = D1/D0 ヘッダ）に
    なり、USB のシリアルモニタには何も出ない。
    その状態では 'class HardwareSerial' has no member named 'setTxTimeoutMs'
    というコンパイルエラーにもなる。

  ============================================================================
  ピン割り当て（V1 回路図 cosmic-ray-detector.kicad_sch / Nano シンボル U3 で確認済み）
  ============================================================================
    ヘッダ  GPIO  用途
    A0      1     SiPM 信号入力      (U3 pad19 <- LT1807 出力)
    A3      4     TMP36 温度センサ   (U3 pad22, VS+ は 3V3)
    A4      11    OLED SDA           (U3 pad23 -> OLED1 pad1)
    A5      12    OLED SCL           (U3 pad24 -> OLED1 pad2)
    D3      6     検出表示 LED       (U3 pad6 -> R8 1k -> LED アノード。アクティブ HIGH)
    D6      9     コインシデンス     (U3 pad9 -> R15 1k -> 3.5mm ジャック J3)

    OLED はリセット端子を持たない 4 ピンソケット (SDA/SCL/GND/VCC) なので
    OLED_RESET は -1 が正しい。V1 の AVR スケッチにある #define OLED_RESET 10 は
    実体のない名残（D10 は回路図上 未接続）。

    基板上に I2C プルアップ抵抗は無い。プルアップは OLED モジュール側に依存する。

  ============================================================================
  ハードウェア上の注意（ファームでは対処できない）
  ============================================================================
    A0 に最大 5V が入りうる。アンプ U2(LT1807) は 5V 単電源で動作し、その出力は
    D1 -> C14("short") -> R9("short") を経て A0 に分圧なしで直結している。
    AVR 版は VCC=5V だったのでピンは無傷で、AREF=3.3V を超えた分が単にクリップ
    するだけだった。ESP32-S3 では絶対最大定格を超えるため破損リスクがある。
    A0-GND 間の分圧か、3V3 へのクランプ（BAT54S 等）を推奨。

    コインシデンス線(D6)も同様。5V 動作の AVR 版 V1 機と繋ぐと間に R15 の 1kΩ しか
    無く、ジャックには +5V も通っている。3.3V 機同士で使うかレベルシフタを挟むこと。

  必要ライブラリ:
    1. Adafruit SSD1306
    2. Adafruit GFX Library
    3. ESP32 Arduino Core (BLE, Preferences)
*/

#include <Arduino.h>

// 以前から実質 3.x 専用だったが（BLE の getValue() が String を返す前提など）、
// オシロスコープモードで esp_adc/adc_continuous.h を使うため明示的に要求する。
// これが無いと 2.x では意味の分かりにくいエラーが出る。
#if !defined(ESP_ARDUINO_VERSION_MAJOR) || (ESP_ARDUINO_VERSION_MAJOR < 3)
#error "ESP32 Arduino Core 3.x が必要です。"
#endif

#include <Adafruit_SSD1306.h>
#include <Adafruit_GFX.h>
#include <Wire.h>
#include <Preferences.h>
#include <math.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "esp_timer.h"     // MASTER パルス立ち下げ用ワンショット（コア 2.x/3.x 共通 API）
#include "soc/gpio_reg.h"  // PAIR のピン駆動/解放をレジスタ直書きで行うため
#include "esp_adc/adc_continuous.h"  // オシロスコープモードの DMA 連続サンプリング
#include "esp_err.h"
#include "esp32-hal-periman.h"       // ADC1 の所有権を oneshot から DMA へ渡すため

// ==========================================
//   ピン割り当て
// ==========================================
// ボードによってピンシンボルの意味が違うので、選択ボードごとに切り替える。
//
//  - 公式 Arduino Nano ESP32 (nano_nora):
//      D3/D6 が定義され、SDA/SCL = A4/A5 = GPIO11/12。
//      ただし "Pin Numbering" 設定でシンボルの実体が変わるため、
//      生の GPIO 番号ではなく必ずシンボルを使う必要がある。
//  - 汎用 ESP32-S3 ボード ("ESP32S3 Dev Module" 等, 変体 esp32s3):
//      D3/D6 は存在しない。A0=GPIO1 / A3=GPIO4 は偶然一致するが、
//      A4=GPIO5 / A5=GPIO6、SDA/SCL の既定は GPIO8/9 で Nano のシルクとは一致しない。
//      したがってこちらは GPIO 番号で明示する。
#if defined(ARDUINO_NANO_ESP32)
#define SIG_IN_PIN_DEF A0  // GPIO1
#define TEMP_PIN_DEF   A3  // GPIO4
#define LED_PIN_DEF    D3  // GPIO6
#define COIN_PIN_DEF   D6  // GPIO9
#define I2C_SDA_DEF    A4  // GPIO11
#define I2C_SCL_DEF    A5  // GPIO12
#else
// 汎用ボード向け。ユーザー提供のボードピンアウト図と V1 回路図の両方で確認済み。
// Nano フォームのヘッダ位置 -> このボードの GPIO 番号。
#define SIG_IN_PIN_DEF 1   // ヘッダ A0
#define TEMP_PIN_DEF   4   // ヘッダ A3
#define LED_PIN_DEF    6   // ヘッダ D3
#define COIN_PIN_DEF   9   // ヘッダ D6
#define I2C_SDA_DEF    11  // ヘッダ A4
#define I2C_SCL_DEF    12  // ヘッダ A5
#endif

const int SIG_IN_PIN = SIG_IN_PIN_DEF;  // SiPM 信号入力
const int TEMP_PIN   = TEMP_PIN_DEF;    // TMP36 温度センサ
const int LED_PIN    = LED_PIN_DEF;     // 検出表示 LED（アクティブ HIGH）
const int COIN_PIN   = COIN_PIN_DEF;    // Master/Slave 判定 & コインシデンス
const int I2C_SDA    = I2C_SDA_DEF;     // OLED
const int I2C_SCL    = I2C_SCL_DEF;     // OLED

// ピン番号 = GPIO 番号になるビルド（汎用 ESP32-S3 ボード、および
// Nano ESP32 の "By GPIO number" 設定）では、配線と一致しているかを
// コンパイル時に検証できる。値は V1 回路図とボードのピンアウト図の両方で確認済み。
// リマップモード（Nano ESP32 の既定）ではピン番号 != GPIO 番号なので検証を飛ばす。
#if !defined(BOARD_HAS_PIN_REMAP) || defined(BOARD_USES_HW_GPIO_NUMBERS)
static_assert(SIG_IN_PIN == 1,  "SIG must be GPIO1  (Nano header A0)");
static_assert(TEMP_PIN   == 4,  "TEMP must be GPIO4 (Nano header A3)");
static_assert(LED_PIN    == 6,  "LED must be GPIO6  (Nano header D3)");
static_assert(COIN_PIN   == 9,  "COIN must be GPIO9 (Nano header D6)");
static_assert(I2C_SDA    == 11, "SDA must be GPIO11 (Nano header A4)");
static_assert(I2C_SCL    == 12, "SCL must be GPIO12 (Nano header A5)");
#endif

// 起動時に「シンボルが実際どの GPIO に解決されたか」を出すための補助。
// digitalPinToGPIONumber() はリマップモードでしか宣言されないのでガードが要る。
#if defined(BOARD_HAS_PIN_REMAP) && !defined(BOARD_USES_HW_GPIO_NUMBERS)
#define RESOLVED_GPIO(p) ((int)digitalPinToGPIONumber(p))
#define PIN_MODE_NAME "ArduinoPin"
#else
#define RESOLVED_GPIO(p) ((int)(p))
#define PIN_MODE_NAME "GPIONumber"
#endif

#if defined(ARDUINO_BOARD)
#define BOARD_NAME_STR ARDUINO_BOARD
#else
#define BOARD_NAME_STR "unknown"
#endif

// ==========================================
//   OLED
// ==========================================
const byte OLED = 1;  // 0 にするとコンパイル時に OLED 機能を落とす
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
// 基板の OLED ソケットは 4 ピン (SDA/SCL/GND/VCC) でリセット端子が無いため -1。
const int OLED_RESET_PIN = -1;
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET_PIN);

// ==========================================
//   ADC
// ==========================================
static constexpr int ADC_BITS = 12;
static constexpr int ADC_MAX  = (1 << ADC_BITS) - 1;  // 4095

// 減衰 11db 時のフルスケール電圧[mV]。イベント行の 4 列目（実電圧）に使う。
// 個体差があるので、正確さが要るなら実測して調整すること。
static constexpr float ADC_FULLSCALE_MV = 3100.0f;

// ==========================================
//   しきい値
// ==========================================
// V1 と同じく 2 値方式。SIGNAL を超えたら検出、RESET を下回るまで再トリガしない。
// この 2 値ヒステリシスはパルスの裾での多重カウントを防ぐためのもので、
// v2 の単一しきい値ラッチ方式には置き換えていない。
static constexpr int SIGNAL_THRESHOLD_DEFAULT = 480;  // 12bit 絶対値での冷起動用フォールバック
static constexpr int RESET_GAP_DEFAULT        = 20;   // SIGNAL - RESET の差
static constexpr int AUTO_MARGIN_DEFAULT      = 60;   // 自動校正: ベースライン最大値に足す量
static constexpr unsigned int COIN_WINDOW_DEFAULT = 500;  // コインシデンス窓[us]（下の解説を参照）
static constexpr unsigned int COIN_WINDOW_MIN     = 50;
static constexpr unsigned int COIN_WINDOW_MAX     = 10000;

int SIGNAL_THRESHOLD = SIGNAL_THRESHOLD_DEFAULT;
int RESET_THRESHOLD  = SIGNAL_THRESHOLD_DEFAULT - RESET_GAP_DEFAULT;
int resetGap   = RESET_GAP_DEFAULT;
int autoMargin = AUTO_MARGIN_DEFAULT;

// ==========================================
//   タイミング定数
// ==========================================
static constexpr unsigned long DISPLAY_INTERVAL_MS = 2000;
static constexpr unsigned long TEMP_INTERVAL_MS    = 2000;
static constexpr unsigned long LED_BLINK_MS        = 20;

// --- コインシデンス窓 ---
// V1(AVR) をそのまま移植した旧実装は「MASTER が約20us だけ HIGH、SLAVE は10us 後の
// 1点だけ読む」だった。AVR ではこれで成立していた。analogRead が約8us で終わるため
// ポーリング周期も約10us しかなく、両機の検出時刻のズレが窓(20us)に収まっていたからである。
// ESP32-S3 では analogRead が数十 us かかり FreeRTOS にプリエンプトもされるため、
// 検出時刻のズレは軽く 100us を超える。窓を広げる必要があるのはそのため。
//
// 一世代前の実装は「MASTER が窓のあいだ HIGH 保持、SLAVE は窓のあいだポーリング」で、
// 不成立イベントのたびに窓幅ぶん（オフセット込みで既定 700us、最大 10.2ms）
// ブロックし、その間 SiPM のサンプリングが止まっていた（= デッドタイム）。
//
// 現実装は「エッジ時刻の記録 + タイムスタンプ比較」方式:
//   - 受信側は COIN_PIN の立ち上がり時刻を割り込みでリングに記録するだけ
//   - 判定は「エッジ時刻が受理区間に入るか」の算術で、loop() 側で後から確定する
// 待ちが無いので、判定を保留している間も SiPM のサンプリングは継続する。
// 線上のプロトコル（MASTER の出すパルス）は旧実装と同一なので、未更新機とも繋がる。
//
// W の意味は従来どおり「検出時刻のズレの許容幅」。
// 偶発同時計数率は 2*W*R1*R2。W=500us・各1Hz なら 3.6回/時で無視できる。
// ただし単独計数率が 10Hz を超えると 6回/分まで増えるので、その場合は窓を詰めること。
// PAIR モードではパルス幅 COIN_PAIR_PULSE_US(160us) が実効的な窓の下限になるため
// W >= 200us で使うこと（下限未満に詰めても重なり分は受理される）。
unsigned int COINCIDENCE_WINDOW_US = COIN_WINDOW_DEFAULT;

// MASTER(COINC_SLAVE 方式) がパルスを立てるトリガからの固定オフセット。
// これが無いと SAMPLE_PEAK(波高追跡 120us) と SAMPLE_SINGLE(analogRead 1回) とで
// パルスの開始時刻がずれ、サンプル方式の異なる 2 台を繋いだとき窓が食い違う。
// 両方式の波高サンプリングが確実に終わる値にしておく。
// SLAVE 側の受理条件（エッジ ∈ トリガ+OFF±W）にも同じ値を使う。
// 未更新機（旧ファームの窓ポーリング実装）との線互換のため値を変えないこと。
static constexpr uint32_t COIN_START_OFFSET_US = 200;

// リセット待ちの上限。V1 は無限ループで、入力が飽和すると測定が無言で止まった。
static constexpr uint32_t RESET_WAIT_TIMEOUT_US = 5000;
static constexpr unsigned long RESET_WARN_INTERVAL_MS = 10000;

// ピークトラッキング（SAMPLE_PEAK 時）
//
// 2026-07-21 の波形実測にもとづき 120us/8点 から 40us/1点へ縮めた。
// 根拠（詳細は v1/PULSE_REPORT.html）:
//   - V1 のパルスは 立ち上がり約0.7us / 減衰 tau≈199us。立ち上がりが速すぎて
//     ESP32-S3 のどのサンプリング手段でも分解できない（DMA 連続の上限 12us でも足りない）
//   - その結果、**しきい値を超えた最初の1点がすでにピーク**になる。
//     実測でそうだったイベントは DMA(12us) で 94.3%、POLL(32us) で 97.5%
//   - つまり下のループが撃つ追加の analogRead は tau=199us で減衰した先を読むだけで、
//     94〜98% のイベントで一度も勝っていない。窓を広く取っても得るものが無い
//   - 一方 analogRead は 1 回約 30us かかり、そのぶん丸ごとデッドタイムになる
//
// 1点だけ残してあるのは、残り 2〜6%（トリガ点が立ち上がりの途中に落ちたイベント）の保険。
// 窓 40us は「analogRead 1回ぶん(約30us)が必ず窓内に収まる」ための値。
static constexpr uint32_t PEAK_WINDOW_US = 40;
static constexpr int      PEAK_SAMPLES   = 1;

// ==========================================
//   動作モード
// ==========================================
enum DeviceMode : uint8_t { MODE_MASTER = 0,
                            MODE_SLAVE  = 1 };
DeviceMode deviceMode = MODE_MASTER;

// 波高サンプリング方式
//   SAMPLE_SINGLE : V1 完全互換。トリガ判定の直後にもう一度 analogRead し、その 1 点を波高とする。
//   SAMPLE_PEAK   : 一定窓内で複数回サンプルして最大値を採る（既定）。
// V1 の波高は「トリガから約10us 後の 1 点」で、AVR ではこれが決定的だった
// (13 ADC クロック / 2MHz = 6.5us)。ESP32-S3 の analogRead は数十 us かかる上に
// プリエンプトされうるため、そのまま移植すると減衰波形上のランダムな点を拾い、
// スペクトルが不当に広がる。既定を PEAK にしているのはそのため。
// 実測で比較できるよう SET_SAMPLE:SINGLE で V1 互換に戻せるようにしてある。
enum SampleMode : uint8_t { SAMPLE_PEAK   = 0,
                            SAMPLE_SINGLE = 1 };
SampleMode sampleMode = SAMPLE_PEAK;

// コインシデンス判定
//   COINC_SLAVE : V1 互換。SLAVE のみがゲートし、MASTER は自トリガを全て数える。
//                 線プロトコルは「MASTER がトリガ+200us から窓幅 W のあいだ HIGH」。
//   COINC_OFF   : ゲートしない（SLAVE でも全て数える）
//   COINC_PAIR  : 対称方式。両機ともトリガ時に短パルス(COIN_PAIR_PULSE_US)を出し、
//                 相手のエッジ時刻が自トリガ±W に入れば成立。両機ともゲートする。
//                 必ず両方の機体に SET_COINC:PAIR を設定すること（片方が旧来の
//                 MASTER のままだとアイドル LOW 駆動でパルスが潰される。1k+1k の
//                 直列抵抗があるので電気的には壊れない）。
// ※ かつて「1 本線では両者がゲートするモードは実装できない」としていたが、それは
//    MASTER が窓のあいだ線を占有する旧プロトコル前提の話。アイドルを Hi-Z にして
//    短パルスを重ね合わせる（基板の R15 1k 直列 + R16 10k プルダウンによる
//    ワイヤード OR）ことで、同じ 1 本線のまま対称化できる。
enum CoincMode : uint8_t { COINC_SLAVE = 0,
                           COINC_OFF   = 1,
                           COINC_PAIR  = 2 };
CoincMode coincMode = COINC_SLAVE;

bool oledEnabled = true;

// ==========================================
//   オシロスコープモード
// ==========================================
// 「測定を止めて信号そのものを見る」ための独立モード。計数経路とは排他。
//
// なぜ計数を止めるのか:
//   ESP32-S3 の ADC1 は oneshot(analogRead) と continuous(DMA) のどちらか一方しか
//   持てない（adc_oneshot_new_unit のエラーに ESP_ERR_NOT_FOUND "already in use" がある）。
//   波形を 12us 間隔で見るには DMA が要るが、そうすると analogRead が使えず
//   従来の検出ループ pollDetector() は動かせない。
//   逆に DMA 側で計数まで面倒を見ようとすると、トリガ検出が drain 時まで遅れるため
//   コインシデンスの線プロトコル（トリガ+COIN_START_OFFSET_US でパルス）が壊れる。
//   「見ている間は測っていない」と割り切るのが一番素直で、計数経路に一切手を入れずに済む。
//
// 滞在時間はデッドタイムに計上するので、オシロを見たあとも計数率は正しいままになる。
bool     scopeOn        = false;
uint32_t scopeRate      = 3;   // 波形の出力レート上限[/s]
static constexpr uint32_t SCOPE_RATE_DEFAULT = 3;
static constexpr uint32_t SCOPE_RATE_MAX     = 20;

// 出力する窓。12us 間隔なので -0.38ms 〜 +1.54ms。1 行あたり約 800 バイト。
static constexpr int SCOPE_PRE  = 32;
static constexpr int SCOPE_POST = 128;

// DMA サンプリング周波数。ESP32-S3 の上限（soc_caps.h の
// SOC_ADC_SAMPLE_FREQ_THRES_HIGH = 83333）。12.0us/点。
static constexpr uint32_t SCOPE_FS_HZ = 83333;

// SiPM 信号は GPIO1 = ADC1_CH0（soc/adc_channel.h の ADC1_GPIO1_CHANNEL で確認済み）。
// DMA はピン番号ではなくチャンネル番号で指定する。
static constexpr adc_channel_t SCOPE_ADC_CHANNEL = ADC_CHANNEL_0;

adc_continuous_handle_t scopeAdc = nullptr;
volatile bool scopeOvfFlag = false;

// ソフト側リング。4096 点 = 約 49ms ぶん。
static constexpr size_t SCOPE_RING      = 4096;
static constexpr size_t SCOPE_RING_MASK = SCOPE_RING - 1;
static uint16_t scopeRing[SCOPE_RING];
static uint64_t scopeWritten = 0;  // 通算サンプル数

static constexpr size_t SCOPE_READ_BYTES = 512;  // 4 byte/sample なので 128 点
static uint8_t scopeReadBuf[SCOPE_READ_BYTES];

bool     scopeArmed      = false;  // 直前に RESET を下回ったか
bool     scopePendValid  = false;
uint64_t scopePendTrigG  = 0;
uint32_t scopeEmitted    = 0;
uint32_t scopeOvfCount   = 0;
unsigned long scopeEnterMs   = 0;
uint64_t      scopeEnterUs   = 0;
unsigned long scopeLastEmitMs = 0;

// ==========================================
//   BLE UART Service (Nordic UART Service)
// ==========================================
#define SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

BLEServer* pServer = nullptr;
BLECharacteristic* pTxCharacteristic = nullptr;
volatile bool bleDeviceConnected = false;
bool bleOldDeviceConnected = false;
volatile unsigned long bleConnectedAtMs = 0;
bool bleMtuReported = false;

static constexpr size_t BLE_NAME_MAX = 24;
char bleName[BLE_NAME_MAX + 1] = "CosmicRay";

// ==========================================
//   コマンドキュー
// ==========================================
// BLE の onWrite は Bluedroid のタスク（core0）で走り、loop() は core1 に固定されている
// ため、両者は「真に並列」に動く。コールバック内で executeCommand() を呼ぶと
// bleSend() が再入してイベント行が壊れ、しきい値などの共有変数も競合する。
// そこでコールバックはキューに積むだけにし、実行は loop() 側で行う。
static constexpr int CMD_QUEUE_SLOTS = 8;
static constexpr int CMD_MAX_LEN     = 48;
static char cmdQueue[CMD_QUEUE_SLOTS][CMD_MAX_LEN];
static volatile int cmdQHead = 0;
static volatile int cmdQTail = 0;
static portMUX_TYPE cmdMux = portMUX_INITIALIZER_UNLOCKED;

// ==========================================
//   Preferences (NVS)
// ==========================================
// 名前空間もキー名も v2 スケッチ("cosmic" / "sig_thresh") と重ねない。
// 同じ基板に v2 -> 本スケッチと書き込んだとき、12bit で保存された値を
// 10bit として読んでしまい検出が止まる事故を構造的に防ぐため。
static const char* NVS_NAMESPACE = "cosmic_v1e";
Preferences prefs;

// ==========================================
//   グローバル状態
// ==========================================
uint64_t start_time_us     = 0ULL;
uint64_t total_deadtime_us = 0ULL;
unsigned long count = 0UL;

float temperatureC = NAN;
int   adc = 0;

unsigned long lastDisplayMs = 0;
unsigned long lastTempMs    = 0;
unsigned long ledOffMs      = 0;

unsigned long resetTimeouts    = 0;
unsigned long lastResetWarnMs  = 0;

// 診断用。GET_COINCSTAT で読み出す。データ行の形式には影響しない。
unsigned long singlesCount = 0UL;  // コインシデンス判定より前の検出回数

bool oledReady = false;
char i2cScanResult[72] = "not scanned";

// ==========================================
//   コインシデンス・エンジン（非ブロッキング）
// ==========================================
// 受信側は COIN_PIN の立ち上がり時刻を ISR でリングに記録し、ゲート判定は
// 「エッジ時刻 vs 自トリガ時刻」の算術で行う。相手のエッジがまだ来ていない
// 可能性があるイベントはペンディングリングに積み、loop() で FIFO 順に確定する
// （受理→計数・出力 / 期限超過→棄却）。判定はタイムスタンプ基準なので、
// 確定処理が遅れても（OLED 更新等で loop が数十 ms 止まっても）結果は変わらない。

// --- エッジリング ---
// ISR が書き、loop が読む。attachInterrupt は setup/loop(core1) から呼ぶため
// GPIO ISR も core1 に載り、32bit 整列アクセスは Xtensa でアトミックなので
// volatile だけで足りる（クリティカルセクション不要）。
static constexpr uint32_t COIN_EDGE_SLOTS = 16;  // 2 のべき乗であること
volatile uint32_t coinEdgeTime[COIN_EDGE_SLOTS];
volatile uint32_t coinEdgeHead = 0;     // ISR のみ加算する通算シーケンス番号
uint32_t coinEdgeTail = 0;              // loop のみ。古いエッジの掃引で前進
volatile bool coinSelfDriving = false;  // PAIR: 自己駆動中は自分のエッジを無視

// --- ペンディングリング（loop 専用。ISR は触らない → ロック不要）---
static constexpr int COIN_PENDING_SLOTS = 16;
struct PendingEvent {
  uint32_t trigUs;        // 窓計算用（trig64Us の下位 32bit）
  uint64_t trig64Us;      // イベント行の時刻列用
  uint16_t peakAdc;       // 波高
  uint8_t  forcedAccept;  // PAIR: レベルチェックで成立確定済み
};
PendingEvent coinPending[COIN_PENDING_SLOTS];
int coinPendingHead = 0;
int coinPendingTail = 0;

// 診断カウンタ。GET_COINCDBG で読み出す。
unsigned long coinEarlyFinalize  = 0;  // ペンディング満杯による先頭の強制確定
unsigned long coinSyntheticEdges = 0;  // エッジではなくレベルチェックで成立した回数
unsigned long coinPulseRestarts  = 0;  // MASTER: パルス継続中の再トリガ

// MASTER パルスの立ち下げ用ワンショットタイマ。
// 旧実装の「窓幅 W の busy-wait 保持」を置き換える。
esp_timer_handle_t coinPulseTimer = nullptr;

// PAIR のパルス幅。両機で共通の固定値にすることで、SAMPLE_PEAK と SAMPLE_SINGLE を
// 混在させても「後からトリガした側のパルスが先にトリガした側の解放後まで必ず残る」
// ことが保証され、パルス重なり時の取りこぼし検出（解放後レベルチェック）が
// 対称に成立する。値を変えるときは両機同時に書き換えること。
static constexpr uint32_t COIN_PAIR_PULSE_US = 160;

// これより古いエッジはリングから捨てる。定期掃引（2 秒の表示 tick）と合わせて、
// 71 分の micros() ラップ後に古い時刻が受理区間へ偽マッチするのを防ぐ。
static constexpr uint32_t COIN_EDGE_STALE_US = 100000;

// COIN_PIN の GPIO ビットマスク。setup() で (1UL << RESOLVED_GPIO(COIN_PIN)) を設定。
// COIN は GPIO9（第 1 バンク, <32）なので W1TS/W1TC の非 _1 レジスタでよい。
uint32_t coinPinMask = 0;

// PAIR の駆動/解放。pinMode() は使わない:
//  - コア 3.x の pinMode は Peripheral Manager 経由でピンを再初期化しうる
//  - レジスタ直書きなら副作用がなく高速
// pinMode(INPUT) 済みのピンに対して出力ドライバだけを ON/OFF する。
// out ビットを先に立ててから出力を有効にするのでグリッチは出ない。
static inline void coinDriveHigh() {
  REG_WRITE(GPIO_OUT_W1TS_REG, coinPinMask);
  REG_WRITE(GPIO_ENABLE_W1TS_REG, coinPinMask);
}
static inline void coinRelease() {
  REG_WRITE(GPIO_ENABLE_W1TC_REG, coinPinMask);  // Hi-Z へ（入力バッファは有効のまま）
}

// COIN_PIN 立ち上がり ISR。時刻を記録するだけ。
void IRAM_ATTR coinIsr() {
  if (coinSelfDriving) return;  // 自分の駆動によるエッジは無視
  coinEdgeTime[coinEdgeHead & (COIN_EDGE_SLOTS - 1)] = (uint32_t)micros();
  coinEdgeHead = coinEdgeHead + 1;  // 時刻を書いてから公開
}

// ==========================================
//   プロトタイプ
// ==========================================
void executeCommand(const char* cmd);
void dualPrint(const char* str);
void dualPrintln(const char* str);
void bleSend(const char* data, size_t len);
void initBLE();
void loadConfig();
void saveConfig();
void applyResetThreshold();
void printThresholds();
void printMode();
void printBoard();
void printBleName();
void printBtAddr();
void printAutoMargin();
void printOledStatus();
void printCoincMode();
void printSampleMode();
void calibrateThreshold(int samples, int margin);
void updateTemperature();
void updateDisplay();
void OpeningScreen();
void printBootHeader();
void pollDetector();
void applyCoinPinConfig();
void coinRingsClear();
void coinEdgeSweep();
bool coinEdgeInRange(uint32_t lo, uint32_t hi);
void acceptEvent(uint16_t peakAdc, uint64_t trig64Us);
void coinPendingPush(uint64_t trig64Us, int peakAdc, bool forcedAccept);
void coinPendingService(bool forceHead);
void coinMasterPulse(uint32_t trigUs);
void coinPulseEndCb(void* arg);
void printCoincStat();
void printCoincDbg();
void printCoincWindow();
void testLine();
bool enqueueCommand(const char* cmd);
void drainCommandQueue();
void i2cScan();
uint64_t micros64();
bool scopeSetOn(bool on);
void scopeService();
void printScope();
void printScopeRate();

// BLE コールバック（core0）から呼ばれる。キューに積むだけで実行はしない。
bool enqueueCommand(const char* cmd) {
  bool ok = false;
  portENTER_CRITICAL(&cmdMux);
  int next = (cmdQHead + 1) % CMD_QUEUE_SLOTS;
  if (next != cmdQTail) {
    strncpy(cmdQueue[cmdQHead], cmd, CMD_MAX_LEN - 1);
    cmdQueue[cmdQHead][CMD_MAX_LEN - 1] = '\0';
    cmdQHead = next;
    ok = true;
  }
  portEXIT_CRITICAL(&cmdMux);
  return ok;
}

// loop()（core1）から呼ぶ。キューに溜まったコマンドを順に実行する。
void drainCommandQueue() {
  char local[CMD_MAX_LEN];
  while (true) {
    bool got = false;
    portENTER_CRITICAL(&cmdMux);
    if (cmdQTail != cmdQHead) {
      memcpy(local, cmdQueue[cmdQTail], CMD_MAX_LEN);
      cmdQTail = (cmdQTail + 1) % CMD_QUEUE_SLOTS;
      got = true;
    }
    portEXIT_CRITICAL(&cmdMux);
    if (!got) break;
    executeCommand(local);
  }
}

// ==========================================
//   BLE コールバック
// ==========================================
class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) override {
    bleDeviceConnected = true;
    bleConnectedAtMs = millis();
  }
  void onDisconnect(BLEServer* pServer) override {
    bleDeviceConnected = false;
  }
};

class MyRXCallbacks : public BLECharacteristicCallbacks {
  // このバッファは BLE タスクからしか触らないのでロック不要。
  // 排他が要るのはキュー本体だけ。
  char rxLine[CMD_MAX_LEN];
  int  rxIndex = 0;

  void onWrite(BLECharacteristic* pCharacteristic) override {
    String v = pCharacteristic->getValue();
    size_t rxLen = v.length();
    for (size_t i = 0; i < rxLen; i++) {
      char c = v[i];
      if (c == '\n' || c == '\r') {
        if (rxIndex > 0) {
          rxLine[rxIndex] = '\0';
          enqueueCommand(rxLine);
          rxIndex = 0;
        }
      } else if (rxIndex < CMD_MAX_LEN - 1) {
        rxLine[rxIndex++] = c;
      }
    }
  }
};

// ==========================================
//   BLE 送信
// ==========================================
// ネゴシエートされた MTU に合わせてチャンク長を決める。
// MTU 交換は onConnect の後に完了するので、接続時ではなく送信時に問い合わせる。
static size_t bleChunkSize() {
  size_t chunk = 20;  // ATT 既定 23 - 3
  if (pServer) {
    uint16_t mtu = pServer->getPeerMTU(pServer->getConnId());
    if (mtu > 23) {
      size_t payload = (size_t)mtu - 3;
      if (payload > 244) payload = 244;
      chunk = payload;
    }
  }
  return chunk;
}

void bleSend(const char* data, size_t len) {
  if (!bleDeviceConnected || !pTxCharacteristic) return;
  const size_t chunk = bleChunkSize();
  size_t offset = 0;
  while (offset < len) {
    size_t n = (len - offset < chunk) ? (len - offset) : chunk;
    pTxCharacteristic->setValue((uint8_t*)(data + offset), n);
    pTxCharacteristic->notify();
    offset += n;
    // 複数チャンクに割れたときだけ間隔を空ける。
    // 詰めすぎると ESP_GATT_CONGEST でライブラリが黙って取りこぼす。
    if (offset < len) delay(1);
  }
}

void dualPrint(const char* str) {
  Serial.print(str);
  bleSend(str, strlen(str));
}

void dualPrintln(const char* str) {
  Serial.println(str);
  size_t len = strlen(str);
  char buf[192];
  if (len + 1 < sizeof(buf)) {
    memcpy(buf, str, len);
    buf[len] = '\n';
    bleSend(buf, len + 1);
  } else {
    bleSend(str, len);
    bleSend("\n", 1);
  }
}

// ==========================================
//   I2C スキャナ
// ==========================================
// OLED が映らないときの切り分け用。
// 「ピン設定が違う」のか「配線/電源/モジュールの問題」なのかがこれで分かる。
// 結果は i2cScanResult に入れ、ブートヘッダで出力する。
void i2cScan() {
  int found = 0;
  int n = 0;
  char list[48];
  list[0] = '\0';

  for (uint8_t addr = 0x03; addr <= 0x77; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      found++;
      if (n < (int)sizeof(list) - 8) {
        n += snprintf(list + n, sizeof(list) - n, " 0x%02X", addr);
      }
    }
  }

  if (found > 0) {
    snprintf(i2cScanResult, sizeof(i2cScanResult), "found%s", list);
  } else {
    snprintf(i2cScanResult, sizeof(i2cScanResult),
             "NONE (check SDA/SCL pins, 5V, module pull-ups)");
  }
}

// ==========================================
//   コマンド処理（Serial / BLE 共通）
// ==========================================
void executeCommand(const char* cmd) {
  if (strncmp(cmd, "SET_THRESH:", 11) == 0) {
    // "SET_THRESH:<sig>,<rst>" と "SET_THRESH:<sig>" の両方を受ける。
    // 後者は現在のギャップを保ったまま SIGNAL だけ動かす。
    int sig = 0, rst = 0;
    int n = sscanf(cmd + 11, "%d,%d", &sig, &rst);
    if (n == 2) {
      if (sig > rst && rst >= 0 && sig <= ADC_MAX) {
        SIGNAL_THRESHOLD = sig;
        RESET_THRESHOLD  = rst;
        resetGap = sig - rst;
        saveConfig();
      }
    } else if (n == 1) {
      if (sig >= 0 && sig <= ADC_MAX) {
        SIGNAL_THRESHOLD = sig;
        applyResetThreshold();
        saveConfig();
      }
    }
    printThresholds();

  } else if (strcmp(cmd, "GET_THRESH") == 0) {
    printThresholds();

  } else if (strcmp(cmd, "AUTO_THRESH") == 0) {
    dualPrintln("### Auto-calibrating thresholds...");
    calibrateThreshold(100, autoMargin);
    saveConfig();
    printThresholds();

  } else if (strncmp(cmd, "AUTO_THRESH:", 12) == 0) {
    int m;
    if (sscanf(cmd + 12, "%d", &m) == 1) {
      autoMargin = constrain(m, 0, ADC_MAX);
    }
    dualPrintln("### Auto-calibrating thresholds...");
    calibrateThreshold(100, autoMargin);
    saveConfig();
    printThresholds();
    printAutoMargin();

  } else if (strcmp(cmd, "GET_AUTO_MARGIN") == 0) {
    printAutoMargin();

  } else if (strncmp(cmd, "SET_AUTO_MARGIN:", 16) == 0) {
    int m;
    if (sscanf(cmd + 16, "%d", &m) == 1) {
      autoMargin = constrain(m, 0, ADC_MAX);
      saveConfig();
    }
    printAutoMargin();

  } else if (strncmp(cmd, "SET_MODE:", 9) == 0) {
    int m = atoi(cmd + 9);
    if (m == 0 || m == 1) {
      deviceMode = (m == 1) ? MODE_SLAVE : MODE_MASTER;
      applyCoinPinConfig();  // COINC_PAIR 中はピン設定に影響しない（対称なので）
    }
    printMode();

  } else if (strcmp(cmd, "GET_MODE") == 0) {
    printMode();

  } else if (strcmp(cmd, "GET_BOARD") == 0) {
    printBoard();

  } else if (strcmp(cmd, "RESET") == 0) {
    count = 0;
    singlesCount = 0;
    start_time_us = micros64();
    total_deadtime_us = 0ULL;
    // オシロ中に RESET されたら滞在時間の起点も打ち直す。
    // そうしないと OFF のときに RESET 前のぶんまでデッドタイムに足してしまう。
    if (scopeOn) scopeEnterUs = start_time_us;
    resetTimeouts = 0;
    coinRingsClear();  // 未確定イベントは破棄（旧カウンタ基準の行を出さない）
    coinEarlyFinalize = 0;
    coinSyntheticEdges = 0;
    coinPulseRestarts = 0;
    dualPrintln("RESET:OK");

  } else if (strcmp(cmd, "I2CSCAN") == 0) {
    i2cScan();
    char buf[96];
    snprintf(buf, sizeof(buf), "### I2C scan: %s", i2cScanResult);
    dualPrintln(buf);

  } else if (strncmp(cmd, "SET_OLED:", 9) == 0) {
    if (strcmp(cmd + 9, "ON") == 0) {
      oledEnabled = true;
    } else if (strcmp(cmd + 9, "OFF") == 0) {
      oledEnabled = false;
      if (OLED == 1 && oledReady) {
        display.clearDisplay();
        display.display();
      }
    }
    saveConfig();
    printOledStatus();

  } else if (strcmp(cmd, "GET_OLED") == 0) {
    printOledStatus();

  } else if (strncmp(cmd, "SET_COINC:", 10) == 0) {
    if (strcmp(cmd + 10, "SLAVE") == 0) {
      coincMode = COINC_SLAVE;
    } else if (strcmp(cmd + 10, "OFF") == 0) {
      coincMode = COINC_OFF;
    } else if (strcmp(cmd + 10, "PAIR") == 0) {
      coincMode = COINC_PAIR;
    }
    applyCoinPinConfig();
    saveConfig();
    printCoincMode();

  } else if (strcmp(cmd, "GET_COINC") == 0) {
    printCoincMode();

  } else if (strncmp(cmd, "SET_WINDOW:", 11) == 0) {
    int w = atoi(cmd + 11);
    if (w >= (int)COIN_WINDOW_MIN && w <= (int)COIN_WINDOW_MAX) {
      COINCIDENCE_WINDOW_US = (unsigned int)w;
      saveConfig();
    }
    printCoincWindow();

  } else if (strcmp(cmd, "GET_WINDOW") == 0) {
    printCoincWindow();

  } else if (strcmp(cmd, "GET_COINCSTAT") == 0) {
    printCoincStat();

  } else if (strcmp(cmd, "GET_COINCDBG") == 0) {
    printCoincDbg();

  } else if (strcmp(cmd, "TESTLINE") == 0) {
    testLine();

  } else if (strncmp(cmd, "SET_SAMPLE:", 11) == 0) {
    if (strcmp(cmd + 11, "PEAK") == 0) {
      sampleMode = SAMPLE_PEAK;
    } else if (strcmp(cmd + 11, "SINGLE") == 0) {
      sampleMode = SAMPLE_SINGLE;
    }
    saveConfig();
    printSampleMode();

  } else if (strcmp(cmd, "GET_SAMPLE") == 0) {
    printSampleMode();

  } else if (strncmp(cmd, "SET_SCOPE:", 10) == 0) {
    // オシロは永続化しない。次回起動時は必ず OFF。
    if (strcmp(cmd + 10, "ON") == 0) {
      scopeSetOn(true);
    } else if (strcmp(cmd + 10, "OFF") == 0) {
      scopeSetOn(false);
    } else {
      printScope();
    }

  } else if (strcmp(cmd, "GET_SCOPE") == 0) {
    printScope();

  } else if (strncmp(cmd, "SET_SCOPE_RATE:", 15) == 0) {
    int r = atoi(cmd + 15);
    if (r >= 1 && r <= (int)SCOPE_RATE_MAX) scopeRate = (uint32_t)r;
    printScopeRate();

  } else if (strcmp(cmd, "GET_SCOPE_RATE") == 0) {
    printScopeRate();

  } else if (strcmp(cmd, "GET_BLENAME") == 0) {
    printBleName();

  } else if (strcmp(cmd, "GET_BTADDR") == 0) {
    printBtAddr();

  } else if (strncmp(cmd, "SET_BLENAME:", 12) == 0) {
    const char* newName = cmd + 12;
    size_t len = strlen(newName);
    bool valid = (len > 0 && len <= BLE_NAME_MAX);
    for (size_t i = 0; valid && i < len; i++) {
      char c = newName[i];
      if (c < 0x20 || c > 0x7E) valid = false;
    }
    if (valid) {
      strncpy(bleName, newName, BLE_NAME_MAX);
      bleName[BLE_NAME_MAX] = '\0';
      saveConfig();
      printBleName();
      dualPrintln("### BLE name saved. Restarting in 1s...");
      delay(1000);
      ESP.restart();
    } else {
      dualPrintln("### BLE name invalid (1-24 printable ASCII chars).");
      printBleName();
    }
  }
  // 未知コマンドは無視（V1 と同じ挙動。ホスト側のボード判別がこれに依存している）
}

void processSerialCommand() {
  static char cmdBuffer[CMD_MAX_LEN];
  static int cmdIndex = 0;

  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (cmdIndex > 0) {
        cmdBuffer[cmdIndex] = '\0';
        executeCommand(cmdBuffer);
        cmdIndex = 0;
      }
    } else if (cmdIndex < CMD_MAX_LEN - 1) {
      cmdBuffer[cmdIndex++] = c;
    }
  }
}

// ==========================================
//   設定の永続化
// ==========================================
void loadConfig() {
  prefs.begin(NVS_NAMESPACE, true);  // read-only
  SIGNAL_THRESHOLD = prefs.getInt("sig", SIGNAL_THRESHOLD_DEFAULT);
  resetGap    = prefs.getInt("rst_gap", RESET_GAP_DEFAULT);
  autoMargin  = prefs.getInt("margin", AUTO_MARGIN_DEFAULT);
  oledEnabled = prefs.getUChar("oled_en", 1) != 0;
  sampleMode  = (SampleMode)prefs.getUChar("smp_mode", (uint8_t)SAMPLE_PEAK);
  coincMode   = (CoincMode)prefs.getUChar("coinc", (uint8_t)COINC_SLAVE);
  COINCIDENCE_WINDOW_US = (unsigned int)prefs.getUInt("coin_win", COIN_WINDOW_DEFAULT);
  String storedName = prefs.getString("ble_name", "CosmicRay");
  prefs.end();

  strncpy(bleName, storedName.c_str(), BLE_NAME_MAX);
  bleName[BLE_NAME_MAX] = '\0';
  if (bleName[0] == '\0') strncpy(bleName, "CosmicRay", BLE_NAME_MAX);

  SIGNAL_THRESHOLD = constrain(SIGNAL_THRESHOLD, 0, ADC_MAX);
  resetGap   = constrain(resetGap, 0, ADC_MAX);
  autoMargin = constrain(autoMargin, 0, ADC_MAX);
  if (sampleMode > SAMPLE_SINGLE) sampleMode = SAMPLE_PEAK;
  // 旧ファームへ書き戻したときは向こうの同種ガードが PAIR(2) を SLAVE に戻す
  if (coincMode > COINC_PAIR) coincMode = COINC_SLAVE;
  if (COINCIDENCE_WINDOW_US < COIN_WINDOW_MIN || COINCIDENCE_WINDOW_US > COIN_WINDOW_MAX) {
    COINCIDENCE_WINDOW_US = COIN_WINDOW_DEFAULT;
  }
  applyResetThreshold();

  // V1 由来のスケッチにあった「保存値が既定値と一致したら再校正」は踏襲しない。
  // あれは意図的に既定値へ設定した場合に毎回勝手に再校正されるトラップだった。
}

void saveConfig() {
  // NVS は同一値の書き込みをスキップするのでフラッシュ摩耗は問題にならないが、
  // 検出パス（pollDetector）からは絶対に呼ばないこと。
  prefs.begin(NVS_NAMESPACE, false);
  prefs.putInt("sig", SIGNAL_THRESHOLD);
  prefs.putInt("rst_gap", resetGap);
  prefs.putInt("margin", autoMargin);
  prefs.putUChar("oled_en", oledEnabled ? 1 : 0);
  prefs.putUChar("smp_mode", (uint8_t)sampleMode);
  prefs.putUChar("coinc", (uint8_t)coincMode);
  prefs.putUInt("coin_win", COINCIDENCE_WINDOW_US);
  prefs.putString("ble_name", bleName);
  prefs.putInt("cfg_ver", 1);
  prefs.end();
}

void applyResetThreshold() {
  RESET_THRESHOLD = constrain(SIGNAL_THRESHOLD - resetGap, 0, ADC_MAX);
}

// ==========================================
//   応答出力
// ==========================================
// v1/index.html は substring(7).split(',') で length===2 を要求するため空白を入れない。
void printThresholds() {
  char buf[40];
  snprintf(buf, sizeof(buf), "THRESH:%d,%d", SIGNAL_THRESHOLD, RESET_THRESHOLD);
  dualPrintln(buf);
}

void printMode() {
  dualPrintln(deviceMode == MODE_SLAVE ? "MODE:1" : "MODE:0");
}

// ホスト側がボードを自動判別するための応答。
// AVR 版 V1 スケッチは未知コマンドを黙って無視するため、
// この行が返ってこなければ Arduino Nano(10bit) と判断できる。
void printBoard() {
  char buf[48];
  snprintf(buf, sizeof(buf), "BOARD:ESP32S3,%d", ADC_BITS);
  dualPrintln(buf);
}

void printBleName() {
  char buf[48];
  snprintf(buf, sizeof(buf), "BLENAME:%s", bleName);
  dualPrintln(buf);
}

// 自分の BLE アドレス（基板ごとに固有）を返す。BLE 接続時のアドレス表示に加え、
// USB 接続でも同じ値が返るので「どの基板に繋がっているか」の判別に使える。
// Web Serial は COM 番号を公開しないため、USB 側の識別子はこれが頼りになる。
void printBtAddr() {
  char buf[40];
  // BLEAddress::toString() の戻り値はコアの版で std::string / String と異なるが、
  // どちらも c_str() を持つのでこの書き方なら両対応できる。
  snprintf(buf, sizeof(buf), "BTADDR:%s", BLEDevice::getAddress().toString().c_str());
  dualPrintln(buf);
}

void printAutoMargin() {
  char buf[32];
  snprintf(buf, sizeof(buf), "AUTO_MARGIN:%d", autoMargin);
  dualPrintln(buf);
}

void printOledStatus() {
  dualPrintln(oledEnabled ? "OLED:ON" : "OLED:OFF");
}

void printCoincMode() {
  if (coincMode == COINC_PAIR) {
    dualPrintln("COINC:PAIR");
  } else {
    dualPrintln(coincMode == COINC_SLAVE ? "COINC:SLAVE" : "COINC:OFF");
  }
}

void printSampleMode() {
  dualPrintln(sampleMode == SAMPLE_PEAK ? "SAMPLE:PEAK" : "SAMPLE:SINGLE");
}

void printCoincWindow() {
  char buf[40];
  snprintf(buf, sizeof(buf), "WINDOW:%u", COINCIDENCE_WINDOW_US);
  dualPrintln(buf);
}

void printScope() {
  dualPrintln(scopeOn ? "SCOPE:ON" : "SCOPE:OFF");
}

void printScopeRate() {
  char buf[32];
  snprintf(buf, sizeof(buf), "SCOPE_RATE:%lu", (unsigned long)scopeRate);
  dualPrintln(buf);
}

// 診断: "COINCSTAT:<singles>,<accepted>,<window_us>,<reset_timeouts>"
//   singles        = 自分のしきい値を超えた回数（コインシデンス判定より前）
//   accepted       = 実際に計数した数(= count)。MASTER では singles と一致する
//   reset_timeouts = リセット待ちのタイムアウト回数。0 以外ならしきい値が低すぎる
//
// 使い方: SLAVE（または PAIR ならどちらの機体でも）にして数分放置してから叩く。
//   singles が増えて accepted が 0 のまま → 相手が線を駆動していない。TESTLINE で確認。
//   accepted も増える → リンクは生きている。あとは窓幅と測定時間の問題。
void printCoincStat() {
  char buf[80];
  snprintf(buf, sizeof(buf), "COINCSTAT:%lu,%lu,%u,%lu",
           singlesCount, count, COINCIDENCE_WINDOW_US, resetTimeouts);
  dualPrintln(buf);
}

// 診断: "COINDBG:<early_finalize>,<synthetic_edges>,<pulse_restarts>,<edge_head>"
//   early_finalize  = ペンディングリング満杯で先頭を強制確定した回数。
//                     0 以外が続くならレートに対して窓が広すぎる
//   synthetic_edges = エッジではなくレベルチェックで成立した回数。
//                     PAIR ではパルス重なり（ほぼ同時のトリガ）の分だけ増えるのが正常
//   pulse_restarts  = MASTER: 前パルス継続中の再トリガで立ち上げ直した回数
//   edge_head       = 受信した立ち上がりエッジの通算数（TESTLINE の常時版として使える）
void printCoincDbg() {
  char buf[80];
  snprintf(buf, sizeof(buf), "COINDBG:%lu,%lu,%lu,%lu",
           coinEarlyFinalize, coinSyntheticEdges, coinPulseRestarts,
           (unsigned long)coinEdgeHead);
  dualPrintln(buf);
}

// 診断: コインシデンス線を 5 秒観測し "LINE:<edges>,<high>,<samples>,<mode>" を返す。
//   edges = 立ち上がり回数 = この間に相手機が出したパルスの数
//
// 相手のパルスは窓幅(既定500us、PAIR では 160us)しかなく、数Hz なら
// デューティは 0.5% 未満。デューティを見ても判別できないので立ち上がりを数える。
//
// 読み方（COINC_SLAVE では必ず SLAVE=mode1 で実行。PAIR ではどちらの機体でもよい）:
//   edges > 0               → 線は生きている。不計数の原因は窓幅か測定時間
//   edges = 0, high = 0     → 相手が線を駆動していない。両機とも SLAVE /
//                             相手が停止 / ケーブル未接続 のいずれか
//   edges = 0, high ≒ samples → 線が HIGH に張り付き。両機とも MASTER で衝突、
//                             または 5V 機を直結している疑い
// COINC_SLAVE の MASTER(mode=0) では自分が COIN_PIN を出力駆動しているため
// 結果に意味は無い。実行中に自分がトリガすると PAIR では自パルスも数えてしまう
// 点に注意（5 秒 × 自己レートぶんの上乗せ）。
void testLine() {
  bool prev = (digitalRead(COIN_PIN) == HIGH);
  unsigned long edges = 0, highs = 0, samples = 0;
  uint32_t t0 = millis();
  while ((uint32_t)(millis() - t0) < 5000UL) {
    bool now = (digitalRead(COIN_PIN) == HIGH);
    if (now && !prev) edges++;
    if (now) highs++;
    prev = now;
    samples++;
  }
  char buf[80];
  snprintf(buf, sizeof(buf), "LINE:%lu,%lu,%lu,%d",
           edges, highs, samples, deviceMode == MODE_SLAVE ? 1 : 0);
  dualPrintln(buf);
}

// ==========================================
//   しきい値の自動校正
// ==========================================
// V1 は「10 サンプルの最小値 + 20」だったが、12bit 化で LSB が 4 倍細かくなり
// ベースライン変動も 4 倍のカウントで見えるため、最小値基準ではノイズで自走する。
// v2 と同じく「最大値 + マージン」方式にした。
// min/max/mean/sd を出力して、マージンが妥当か（sd の 5 倍程度あるか）目視できるようにする。
void calibrateThreshold(int samples, int margin) {
  // オシロ中は ADC1 が DMA に取られていて analogRead が通らない。
  // 一時的に DMA を降ろして校正し、終わったら戻す（オシロ表示は一瞬止まるだけ）。
  const bool resumeScope = scopeOn;
  if (resumeScope) {
    scopeAdcStop();
#if ARDUINO_USB_CDC_ON_BOOT
    Serial.setTxTimeoutMs(0);
#endif
  }

  int minValue = ADC_MAX;
  int maxValue = 0;
  double sum = 0.0, sumSq = 0.0;

  for (int i = 0; i < samples; i++) {
    int v = analogRead(SIG_IN_PIN);
    if (v < minValue) minValue = v;
    if (v > maxValue) maxValue = v;
    sum   += v;
    sumSq += (double)v * v;
    delay(10);
  }

  float mean = (float)(sum / samples);
  float var  = (float)(sumSq / samples) - mean * mean;
  float sd   = (var > 0.0f) ? sqrtf(var) : 0.0f;

  SIGNAL_THRESHOLD = constrain(maxValue + margin, 0, ADC_MAX);
  applyResetThreshold();

  char buf[128];
  snprintf(buf, sizeof(buf),
           "### Calib: min=%d max=%d mean=%.1f sd=%.1f margin=%d -> sig=%d rst=%d",
           minValue, maxValue, mean, sd, margin, SIGNAL_THRESHOLD, RESET_THRESHOLD);
  dualPrintln(buf);

  if (resumeScope) {
    if (scopeAdcStart()) {
#if ARDUINO_USB_CDC_ON_BOOT
      Serial.setTxTimeoutMs(50);
#endif
    } else {
      // 戻せなかったら黙ってオシロを畳む（analogRead は生きているので計数は続く）
      scopeOn = false;
      total_deadtime_us += micros64() - scopeEnterUs;
      dualPrintln("### SCOPE: could not resume after calibration, scope is OFF.");
      printScope();
    }
  }
}

// ==========================================
//   温度
// ==========================================
// 基板のセンサは TMP36GT9Z（回路図で確認。NTC サーミスタではない）。
// VS+ は Nano ヘッダの 3V3、VOUT が A3。伝達特性は 500mV オフセット / 10mV per degC。
// analogReadMilliVolts は eFuse の校正カーブを適用してくれるので、
// このような絶対電圧を読むセンサにはこちらが適切。
// V1 の 3300.0/1024.0 という定数は ESP32-S3 では成り立たない。
// 表示とは独立に呼ぶこと（V1 と v4 は updateDisplay 内でしか更新しておらず、
// OLED を切ると温度が永久に初期値のままになるバグがあった）。
void updateTemperature() {
  // オシロ中は ADC1 が DMA に取られていて analogRead 系が通らない。
  // 温度は数秒スケールでしか動かないので、その間は最終値を保持すれば足りる。
  if (scopeOn) return;
  uint32_t mv = analogReadMilliVolts(TEMP_PIN);
  temperatureC = ((float)mv - 500.0f) / 10.0f;
}

// ADC 生値 -> ADC ピンの実電圧[mV]（線形換算）
static inline float adcMilliVolts(int rawAdc) {
  return (float)rawAdc * ADC_FULLSCALE_MV / (float)ADC_MAX;
}

// ==========================================
//   64bit マイクロ秒カウンタ
// ==========================================
// 32bit の micros() が約71分でラップするのを software で拡張する。
// 71 分に 1 回以上呼ばれる必要があるが、2 秒ごとの時刻更新が必ず通るので満たされる。
uint64_t micros64() {
  static uint64_t extended = 0;
  uint32_t now = micros();
  uint32_t last_lo = (uint32_t)extended;
  if (now < last_lo) extended += (uint64_t)1 << 32;
  extended = (extended & 0xFFFFFFFF00000000ULL) | now;
  return extended;
}

// ==========================================
//   BLE 初期化
// ==========================================
void initBLE() {
  // MTU を大きめに要求しておくと、70 バイト程度のイベント行が 1 通知で送れる。
  // 20 バイト固定だと 1 行あたり 4 回の notify とその間の待ちが検出のデッドタイムになる。
  BLEDevice::setMTU(247);

  BLEDevice::init(bleName);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new MyServerCallbacks());

  BLEService* pService = pServer->createService(SERVICE_UUID);

  pTxCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID_TX,
    BLECharacteristic::PROPERTY_NOTIFY);
  pTxCharacteristic->addDescriptor(new BLE2902());

  BLECharacteristic* pRxCharacteristic = pService->createCharacteristic(
    CHARACTERISTIC_UUID_RX,
    BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  pRxCharacteristic->setCallbacks(new MyRXCallbacks());

  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  BLEDevice::startAdvertising();

  char buf[64];
  snprintf(buf, sizeof(buf), "BLE: Advertising as '%s'", bleName);
  Serial.println(buf);
}

// ==========================================
//   ブートヘッダ
// ==========================================
void printBootHeader() {
  const char* bar = "##########################################################################################";
  char buf[160];

  dualPrintln(bar);
  dualPrintln("### Accel Kitchen");
  dualPrintln("### https://accel-kitchen.com/");
  dualPrintln("### info@accel-kitchen.com");

  snprintf(buf, sizeof(buf), "### Board: ESP32-S3 (Nano) ADC:%dbit V1-detector", ADC_BITS);
  dualPrintln(buf);

  snprintf(buf, sizeof(buf), "### Build: board=%s cdc_on_boot=%d",
           BOARD_NAME_STR, (int)ARDUINO_USB_CDC_ON_BOOT);
  dualPrintln(buf);

  // 各ピンが実際どの GPIO に解決されたかを出す。配線と突き合わせて確認すること。
  // 期待値: SIG=1 TEMP=4 LED=6 COIN=9 SDA=11 SCL=12
  snprintf(buf, sizeof(buf), "### Pins[%s]: SIG=%d TEMP=%d LED=%d COIN=%d SDA=%d SCL=%d",
           PIN_MODE_NAME, RESOLVED_GPIO(SIG_IN_PIN), RESOLVED_GPIO(TEMP_PIN),
           RESOLVED_GPIO(LED_PIN), RESOLVED_GPIO(COIN_PIN),
           RESOLVED_GPIO(I2C_SDA), RESOLVED_GPIO(I2C_SCL));
  dualPrintln(buf);

  snprintf(buf, sizeof(buf), "### I2C scan: %s", i2cScanResult);
  dualPrintln(buf);
  if (OLED == 1) {
    dualPrintln(oledReady ? "### OLED: init OK (0x3C)" : "### OLED: init FAILED");
  }

  snprintf(buf, sizeof(buf), "### Signal threshold: %d", SIGNAL_THRESHOLD);
  dualPrintln(buf);
  snprintf(buf, sizeof(buf), "### Reset threshold: %d", RESET_THRESHOLD);
  dualPrintln(buf);

  printMode();
  printCoincMode();
  printSampleMode();
  printOledStatus();

  if (coincMode == COINC_PAIR) {
    dualPrintln("### NOTE: PAIR mode - both units gate on the shared line.");
    dualPrintln("###       Set SET_COINC:PAIR on BOTH units. Window = +/-W around");
    dualPrintln("###       each trigger. Singles via GET_COINCSTAT.");
  } else if (deviceMode == MODE_MASTER && coincMode == COINC_SLAVE) {
    dualPrintln("### NOTE: Master counts every self-trigger (V1 behaviour).");
    dualPrintln("###       True 2-fold rate must be taken from the Slave unit.");
  }
  printCoincWindow();
  dualPrintln("### WARN: D6 is 3.3V only. Do NOT wire directly to a 5V AVR V1 unit.");
  dualPrintln("###       ESP32 as Master drives only ~2.8V at a 5V AVR input");
  dualPrintln("###       (VIH 3.0V) - the AVR Slave will never see the pulse.");

  dualPrintln("### SCOPE: SET_SCOPE:ON streams waveforms (WF,...) via DMA at 83.3kHz.");
  dualPrintln("###        Counting is PAUSED while the scope is on; the time spent there");
  dualPrintln("###        is added to deadtime, so the rate stays correct. Boots OFF.");

  dualPrintln("### Event Time[ms] ADC[0-4095] Vadc[mV] Deadtime[ms] Temp[C] Mode[0:Master,1:Slave]");
  dualPrintln(bar);
}

// ==========================================
//   オシロスコープ: 出力行の組み立て
// ==========================================
// 1 波形 1 行。161 点 x "4095," で約 800 バイトになるので静的に確保する。
// snprintf を 161 回呼ぶと ms オーダーかかるため整数は手書きで詰める。
static char   scopeLine[1400];
static size_t scopeLineLen = 0;

static inline void slChar(char c) {
  if (scopeLineLen < sizeof(scopeLine) - 1) scopeLine[scopeLineLen++] = c;
}
static void slStr(const char* s) {
  while (*s) slChar(*s++);
}
static void slUInt(uint32_t v) {
  char t[12];
  int n = 0;
  do { t[n++] = (char)('0' + (v % 10)); v /= 10; } while (v);
  while (n) slChar(t[--n]);
}
static void slFlush() {
  slChar('\n');
  Serial.write((const uint8_t*)scopeLine, scopeLineLen);
  bleSend(scopeLine, scopeLineLen);
  scopeLineLen = 0;
}

// ==========================================
//   オシロスコープ: DMA
// ==========================================
void scopeFail(const char* what, esp_err_t err) {
  char buf[128];
  snprintf(buf, sizeof(buf), "### ERROR: %s failed: %s (0x%x)",
           what, esp_err_to_name(err), (unsigned)err);
  dualPrintln(buf);
}

// プール溢れコールバック。ISR 文脈なのでフラグを立てるだけ。
// 溢れるとサンプルの連続性が切れて時間軸が信用できなくなるため、未確定の窓は捨てる。
static bool IRAM_ATTR scopeOvfCb(adc_continuous_handle_t h,
                                 const adc_continuous_evt_data_t* edata,
                                 void* user_data) {
  (void)h; (void)edata; (void)user_data;
  scopeOvfFlag = true;
  return false;
}

bool scopeAdcStart() {
  if (scopeAdc) return true;

  // --- ADC1 の所有権を oneshot から取り上げる ---
  // Arduino の analogRead() は初回呼び出しで ADC1 に oneshot ユニットを作り、
  // それを握りっぱなしにする。この検出器は起動時から analogRead を回しているので、
  // 剥がさないと adc_continuous_new_handle が必ず失敗する。
  // コア自身の analogContinuous() も同じ問題を perimanClearPinBus() で解いている
  // （esp32-hal-adc.c の「ADC%d is running in oneshot mode. Aborting.」の直前）。
  // adcDetachBus は「ADC1 上の ADC_ONESHOT なピンが残り1本」になって初めて
  // ユニットを削除するので、A0(GPIO1) と A3(GPIO4) の両方を剥がす必要がある。
  // 逆向き（DMA -> analogRead）は __analogRead が自動で作り直すので何も要らない。
  perimanClearPinBus(TEMP_PIN);
  perimanClearPinBus(SIG_IN_PIN);

  adc_continuous_handle_cfg_t hcfg = {};
  hcfg.max_store_buf_size = 16384;  // 4096 点 ≒ 49ms。OLED 更新で loop が止まっても溢れない
  hcfg.conv_frame_size    = SCOPE_READ_BYTES;
  hcfg.flags.flush_pool   = 0;
  esp_err_t err = adc_continuous_new_handle(&hcfg, &scopeAdc);
  if (err != ESP_OK) {
    scopeFail("adc_continuous_new_handle", err);
    scopeAdc = nullptr;
    return false;
  }

  adc_digi_pattern_config_t pat = {};
  pat.atten     = ADC_ATTEN_DB_12;  // 旧 ADC_ATTEN_DB_11。setup() の ADC_11db と同じ設定
  pat.channel   = (uint8_t)SCOPE_ADC_CHANNEL;
  pat.unit      = ADC_UNIT_1;
  pat.bit_width = ADC_BITS;

  adc_continuous_config_t ccfg = {};
  ccfg.pattern_num    = 1;
  ccfg.adc_pattern    = &pat;
  ccfg.sample_freq_hz = SCOPE_FS_HZ;
  ccfg.conv_mode      = ADC_CONV_SINGLE_UNIT_1;
  ccfg.format         = ADC_DIGI_OUTPUT_FORMAT_TYPE2;  // S3 は type2（data 12bit）
  err = adc_continuous_config(scopeAdc, &ccfg);
  if (err != ESP_OK) {
    scopeFail("adc_continuous_config", err);
    adc_continuous_deinit(scopeAdc);
    scopeAdc = nullptr;
    return false;
  }

  adc_continuous_evt_cbs_t cbs = {};
  cbs.on_pool_ovf = scopeOvfCb;
  adc_continuous_register_event_callbacks(scopeAdc, &cbs, nullptr);

  err = adc_continuous_start(scopeAdc);
  if (err != ESP_OK) {
    scopeFail("adc_continuous_start", err);
    adc_continuous_deinit(scopeAdc);
    scopeAdc = nullptr;
    return false;
  }

  scopeWritten    = 0;
  scopeArmed      = false;
  scopePendValid  = false;
  scopeOvfFlag    = false;
  return true;
}

void scopeAdcStop() {
  if (!scopeAdc) return;
  // stop で ADC1 のロックが解放され、deinit でユニットが解放される。
  // この後の analogRead は __analogRead が oneshot を作り直してくれる。
  adc_continuous_stop(scopeAdc);
  adc_continuous_deinit(scopeAdc);
  scopeAdc = nullptr;
}

// リング上の窓を 1 行にして出す。gTrig = しきい値を超えたサンプル（この点が t=0）。
void scopeEmit(uint64_t gTrig) {
  int npre = SCOPE_PRE;
  if (gTrig < (uint64_t)npre) npre = (int)gTrig;
  const uint64_t gFirst = gTrig - (uint64_t)npre;
  const int ntot = npre + 1 + SCOPE_POST;

  // 窓の先頭がまだリングに残っているか
  if (scopeWritten - gFirst > SCOPE_RING) return;

  const uint32_t periodNs = (uint32_t)((1000000000ULL + SCOPE_FS_HZ / 2) / SCOPE_FS_HZ);

  scopeLineLen = 0;
  slStr("WF,");  slUInt(scopeEmitted);
  slChar(',');   slUInt((uint32_t)(millis() - scopeEnterMs));
  slStr(",U,");  slUInt((uint32_t)npre);
  slChar(',');   slUInt((uint32_t)ntot);
  slChar(',');   slUInt(periodNs);
  for (int i = 0; i < ntot; i++) {
    slChar(',');
    slUInt(scopeRing[(size_t)(gFirst + (uint64_t)i) & SCOPE_RING_MASK]);
  }
  slFlush();
  scopeEmitted++;
}

// ドライバから吸い出してリングへ積み、同時にトリガを探す。
// 計数はしない（オシロ中は測定を止めているので count には触らない）。
void scopeService() {
  if (!scopeAdc) return;

  if (scopeOvfFlag) {
    scopeOvfFlag = false;
    scopeOvfCount++;
    scopePendValid = false;
    scopeArmed = false;
  }

  // レート制限は「出力するとき」に millis() で見る（下の scopeLastEmitMs）。
  // 拾う側は scopePendValid で 1 窓ずつに制限してあるので、ここでは何もしない。
  for (int iter = 0; iter < 8; iter++) {
    uint32_t outLen = 0;
    esp_err_t err = adc_continuous_read(scopeAdc, scopeReadBuf, SCOPE_READ_BYTES, &outLen, 0);
    if (err != ESP_OK || outLen == 0) break;

    for (uint32_t off = 0; off + SOC_ADC_DIGI_RESULT_BYTES <= outLen;
         off += SOC_ADC_DIGI_RESULT_BYTES) {
      adc_digi_output_data_t* p = (adc_digi_output_data_t*)&scopeReadBuf[off];
      if (p->type2.channel != (uint32_t)SCOPE_ADC_CHANNEL) continue;

      const uint16_t v = (uint16_t)p->type2.data;
      const uint64_t g = scopeWritten;
      scopeRing[g & SCOPE_RING_MASK] = v;
      scopeWritten = g + 1;

      if (scopePendValid) continue;  // 既に確定待ちの窓がある

      if (!scopeArmed) {
        if ((int)v <= RESET_THRESHOLD) scopeArmed = true;
        continue;
      }
      if ((int)v <= SIGNAL_THRESHOLD) continue;

      scopeArmed = false;
      scopePendTrigG = g;
      scopePendValid = true;
    }
  }

  // 後続サンプルが揃ったら出す
  if (scopePendValid && scopeWritten >= scopePendTrigG + (uint64_t)SCOPE_POST + 1) {
    unsigned long now = millis();
    unsigned long minMs = (scopeRate > 0) ? (1000UL / scopeRate) : 0UL;
    if (minMs == 0 || (now - scopeLastEmitMs) >= minMs) {
      scopeEmit(scopePendTrigG);
      scopeLastEmitMs = now;
    }
    scopePendValid = false;
  }
}

// オシロモードの出入り。true が返れば要求どおりの状態になっている。
bool scopeSetOn(bool on) {
  if (on == scopeOn) return true;

  if (on) {
    if (!scopeAdcStart()) {
      dualPrintln("### SCOPE: failed to start DMA, staying in counting mode.");
      return false;
    }
    scopeOn = true;
    scopeEnterMs = millis();
    scopeEnterUs = micros64();
    scopeEmitted = 0;
    scopeOvfCount = 0;
    scopeLastEmitMs = 0;
#if ARDUINO_USB_CDC_ON_BOOT
    // 検出ループが止まっている間だけは、行が途中で切れないよう送信待ちを許す。
    // 計数中に同じことをすると 1 回あたり最大 50ms のデッドタイムになるので、
    // 必ず OFF で元に戻すこと。
    Serial.setTxTimeoutMs(50);
#endif
    dualPrintln("### SCOPE: ON - counting is PAUSED while the scope is open.");
    dualPrintln("###        Coincidence is not evaluated. Temperature holds its last value.");
    if (bleDeviceConnected) {
      dualPrintln("### WARN: scope over BLE is slow (one waveform = several notifications).");
    }
    printScope();
    return true;
  }

  scopeAdcStop();
  scopeOn = false;
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);
#endif
  // 見ていた時間は測定していない時間なので、正直にデッドタイムへ計上する。
  // これをやらないとオシロを開いた回数だけ計数率が下がって見える。
  total_deadtime_us += micros64() - scopeEnterUs;
  dualPrintln("### SCOPE: OFF - counting resumed.");
  printScope();
  return true;
}

// ==========================================
//   検出
// ==========================================
void pollDetector() {
  int trig = analogRead(SIG_IN_PIN);
  if (trig <= SIGNAL_THRESHOLD) return;

  uint64_t trig64 = micros64();
  uint32_t measurement_t1 = (uint32_t)trig64;  // = micros() 相当。窓計算とデッドタイム用
  int peak = trig;

  singlesCount++;  // ゲート前の検出回数（診断用。MASTER では count と一致する）

  // --- 時間割 ---
  // 波高はパルスが減衰する前に取る必要があるので必ず先に取る。
  // コインシデンス判定はエッジ時刻の算術になったのでもうブロックしない:
  //   COINC_SLAVE の SLAVE : ここでは push するだけ。判定は loop() の
  //                          coinPendingService() がタイムスタンプで行う
  //   COINC_SLAVE の MASTER: パルス立ち上げのオフセット待ち(≤200us)のみブロック。
  //                          立ち下げは esp_timer に任せる
  //   COINC_PAIR           : トリガ直後にパルスを立て、波高サンプリング中も
  //                          出したままにして 160us で解放。判定は push して loop() で

  bool pairForced = false;
  if (coincMode == COINC_PAIR) {
    // 相手が既に駆動中（相手が先にトリガ）なら、この場で成立を確定できる。
    // 相手のエッジは通常 ISR が記録済みなので、これはエッジ取りこぼし時の保険。
    if (digitalRead(COIN_PIN) == HIGH) pairForced = true;
    // 直ちに自分のパルスを立てる。線上のエッジ時刻 ≈ トリガ時刻となり、
    // 相手はこのエッジのタイムスタンプで |Δt| <= W を判定する。
    coinSelfDriving = true;
    coinDriveHigh();
  }

  if (sampleMode == SAMPLE_SINGLE) {
    // V1 完全互換: しきい値判定の直後にもう一度読んだ 1 点を波高とする
    peak = analogRead(SIG_IN_PIN);
  } else {
    uint32_t tp = micros();
    for (int i = 0; i < PEAK_SAMPLES; i++) {
      if (micros() - tp >= PEAK_WINDOW_US) break;
      int v = analogRead(SIG_IN_PIN);
      if (v > peak) peak = v;
    }
  }

  if (coincMode == COINC_PAIR) {
    // パルス幅を両機共通の COIN_PAIR_PULSE_US に揃えてから解放する
    while ((uint32_t)(micros() - measurement_t1) < COIN_PAIR_PULSE_US) {
    }
    coinRelease();
    delayMicroseconds(2);  // 1k + ケーブル容量の放電待ち（時定数 ~1us）
    // 解放後もまだ HIGH = 相手が自分のパルス中にトリガした。その立ち上がりは
    // 線が既に HIGH のため遷移として観測できない（エッジが出ない）ので、ここで拾う。
    if (digitalRead(COIN_PIN) == HIGH) pairForced = true;
    coinSelfDriving = false;
    coinPendingPush(trig64, peak, pairForced);
  } else if (deviceMode == MODE_MASTER) {
    coinMasterPulse(measurement_t1);
    // MASTER は自トリガを全て数える（COINC_SLAVE の非対称仕様。V1 挙動）
    acceptEvent((uint16_t)peak, trig64);
  } else if (coincMode == COINC_SLAVE) {
    // 判定は loop() の coinPendingService() が確定する。MASTER が先行していれば
    // エッジが記録済みなので、次の service 呼び出しで即座に print される。
    coinPendingPush(trig64, peak, false);
  } else {
    // SLAVE かつ COINC_OFF: ゲートせず全て数える
    acceptEvent((uint16_t)peak, trig64);
  }

  // 信号が RESET_THRESHOLD を下回るまで待つ（V1 と同じ再アーム条件）。
  // V1 と違いタイムアウトを設ける: 入力が飽和したりベースラインが上がったままだと
  // 無限ループに入り、測定が無言で停止してしまうため。
  uint32_t tw = micros();
  while (analogRead(SIG_IN_PIN) > RESET_THRESHOLD) {
    if (micros() - tw > RESET_WAIT_TIMEOUT_US) {
      resetTimeouts++;
      unsigned long now = millis();
      if (now - lastResetWarnMs >= RESET_WARN_INTERVAL_MS) {
        lastResetWarnMs = now;
        char wbuf[96];
        snprintf(wbuf, sizeof(wbuf),
                 "### WARN: reset-wait timeout x%lu (input saturated?)", resetTimeouts);
        dualPrintln(wbuf);
      }
      break;
    }
  }

  total_deadtime_us += micros() - measurement_t1;
}

// ==========================================
//   コインシデンス確定処理
// ==========================================
// リングとペンディングの破棄。モード切替・RESET 時に呼ぶ。
void coinRingsClear() {
  coinEdgeTail = coinEdgeHead;        // 記録済みエッジを全て捨てる
  coinPendingTail = coinPendingHead;  // 未確定イベントも破棄（出力しない）
}

// COIN_EDGE_STALE_US より古いエッジを捨てる。
// 2 秒ごとの表示 tick からも必ず呼ばれるため、リングに 71 分前の時刻が残って
// micros() ラップ後のトリガと偽マッチすることは起こり得ない。
void coinEdgeSweep() {
  uint32_t head = coinEdgeHead;
  if (head - coinEdgeTail > COIN_EDGE_SLOTS) coinEdgeTail = head - COIN_EDGE_SLOTS;
  uint32_t now = micros();
  while (coinEdgeTail != head) {
    uint32_t t = coinEdgeTime[coinEdgeTail & (COIN_EDGE_SLOTS - 1)];
    if ((uint32_t)(now - t) <= COIN_EDGE_STALE_US) break;
    coinEdgeTail++;
  }
}

// 記録済みエッジに [lo, hi]（micros() 値）内のものがあるか。符号付き差分で比較する。
// エッジは消費しない: MASTER の 1 パルスが SLAVE の複数トリガを満たしうるのは
// 旧レベルポーリング実装と同じ挙動。スキャン中に ISR が最古スロットを上書きしても、
// 入っているのは「本物のより新しいエッジ時刻」なので判定は壊れない。
bool coinEdgeInRange(uint32_t lo, uint32_t hi) {
  uint32_t head = coinEdgeHead;
  uint32_t tail = coinEdgeTail;
  if (head - tail > COIN_EDGE_SLOTS) tail = head - COIN_EDGE_SLOTS;
  for (uint32_t i = tail; i != head; i++) {
    uint32_t t = coinEdgeTime[i & (COIN_EDGE_SLOTS - 1)];
    if ((int32_t)(t - lo) >= 0 && (int32_t)(hi - t) >= 0) return true;
  }
  return false;
}

// 受理イベントの計数と出力。時刻列はトリガ時刻から作る（確定が遅延しても正しい）。
// デッドタイムへの加算は呼び出し側の責務: pollDetector 内から呼ばれる経路では
// 関数末尾の一括加算に含まれるため、ここで加算すると二重計上になる。
void acceptEvent(uint16_t peakAdc, uint64_t trig64Us) {
  count++;
  digitalWrite(LED_PIN, HIGH);  // 基板は R8 1k -> LED アノード なのでアクティブ HIGH
  ledOffMs = millis() + LED_BLINK_MS;
  adc = peakAdc;

  char eventBuf[128];
  snprintf(eventBuf, sizeof(eventBuf), "%lu %lu %d %.2f %lu %.1f %d",
           count,
           (unsigned long)((trig64Us - start_time_us) / 1000ULL),
           adc,
           adcMilliVolts(adc),
           (unsigned long)(total_deadtime_us / 1000ULL),
           temperatureC,
           deviceMode == MODE_SLAVE ? 1 : 0);
  dualPrintln(eventBuf);
}

// 未確定イベントをペンディングリングへ。満杯なら先頭を確定させて空ける。
void coinPendingPush(uint64_t trig64Us, int peakAdc, bool forcedAccept) {
  int next = (coinPendingHead + 1) % COIN_PENDING_SLOTS;
  if (next == coinPendingTail) {
    coinPendingService(false);      // まず通常の確定を試みる
    if (next == coinPendingTail) {  // それでも満杯: 先頭を現時点の証拠だけで確定
      coinEarlyFinalize++;
      coinPendingService(true);
    }
  }
  PendingEvent &e = coinPending[coinPendingHead];
  e.trigUs       = (uint32_t)trig64Us;
  e.trig64Us     = trig64Us;
  e.peakAdc      = (uint16_t)peakAdc;
  e.forcedAccept = forcedAccept ? 1 : 0;
  coinPendingHead = next;
}

// ペンディングを FIFO 順に確定する（イベント行の順序を守るため、先頭が未確定なら
// そこで打ち切る。期限は最長でも W+オフセット後なので次の loop 周回ですぐ再訪する）。
// forceHead=true はリング満杯時専用: 先頭を現時点の証拠だけで確定する。
void coinPendingService(bool forceHead) {
  coinEdgeSweep();
  while (coinPendingTail != coinPendingHead) {
    PendingEvent &e = coinPending[coinPendingTail];

    // 受理区間 [lo, hi] とレベルチェック区間の下限
    uint32_t lo, hi, levelLo;
    if (coincMode == COINC_PAIR) {
      // 対称窓: エッジ ∈ 自トリガ ±W。+10us は ISR レイテンシの余裕
      lo = e.trigUs - COINCIDENCE_WINDOW_US;
      hi = e.trigUs + COINCIDENCE_WINDOW_US + 10;
      levelLo = e.trigUs;
    } else {
      // COINC_SLAVE: 旧ポーリング実装と数学的に等価な受理条件。
      // MASTER の HIGH 区間 [t_e, t_e+W] と旧 SLAVE のポーリング区間
      // [T+OFF, T+OFF+W] が重なる ⇔ エッジ t_e ∈ [T+OFF-W, T+OFF+W]
      lo = e.trigUs + COIN_START_OFFSET_US - COINCIDENCE_WINDOW_US;
      hi = e.trigUs + COIN_START_OFFSET_US + COINCIDENCE_WINDOW_US;
      levelLo = e.trigUs + COIN_START_OFFSET_US;
    }

    bool accept = (e.forcedAccept != 0) || coinEdgeInRange(lo, hi);

    // セーフティネット: エッジを取りこぼしていても（ISR アタッチ前・NVS 書込中）、
    // 旧実装のポーリング区間に相当する時間帯に線が HIGH なら成立とする。
    if (!accept && !coinSelfDriving) {
      uint32_t now = micros();
      if ((int32_t)(now - levelLo) >= 0 && (int32_t)(hi - now) >= 0 &&
          digitalRead(COIN_PIN) == HIGH) {
        accept = true;
        coinSyntheticEdges++;
      }
    }

    if (accept) {
      // 出力（Serial/BLE）に実際にかかる時間は従来どおりデッドタイムに計上する
      uint32_t t0 = micros();
      acceptEvent(e.peakAdc, e.trig64Us);
      total_deadtime_us += micros() - t0;
      coinPendingTail = (coinPendingTail + 1) % COIN_PENDING_SLOTS;
      continue;
    }
    if (forceHead || (int32_t)(micros() - hi) > 0) {
      // 期限超過（または満杯時の強制確定）: 不成立。従来どおり静かに棄却
      coinPendingTail = (coinPendingTail + 1) % COIN_PENDING_SLOTS;
      forceHead = false;
      continue;
    }
    break;  // 先頭が未確定
  }
}

// MASTER(COINC_SLAVE 方式) のパルス出力。線プロトコルは旧実装と同一:
// 「トリガ+COIN_START_OFFSET_US で立ち上げ、窓幅 W のあいだ HIGH」。
// 旧実装は W のあいだ busy-wait していたが、立ち下げを esp_timer に任せることで
// オフセット待ち（最大 200us）以外はブロックしない。esp_timer のディスパッチ遅延は
// パルスを伸ばす方向にしか働かない（早く切れることはない）ので、
// 「立ち上がり後 W 以上 HIGH」という線互換の保証は保たれる。
void coinMasterPulse(uint32_t trigUs) {
  // 波高サンプリング所要時間のモード差をここで吸収し、立ち上がり時刻を揃える。
  // 既に過ぎていれば待たない。
  while ((uint32_t)(micros() - trigUs) < COIN_START_OFFSET_US) {
    // busy wait（数十 us なので yield 不要）
  }

  if (coinPulseTimer && esp_timer_is_active(coinPulseTimer)) {
    // 前イベントのパルスがまだ HIGH: 一旦落として独立した立ち上がりを作る。
    // 更新済み SLAVE はエッジ時刻で判定するため、イベントごとにエッジが要る。
    // 旧 SLAVE は「HIGH を読んだら成立」なので 5us の LOW ブリップは無害。
    digitalWrite(COIN_PIN, LOW);
    esp_timer_stop(coinPulseTimer);
    delayMicroseconds(5);  // 遠端 RC（1k + ケーブル容量 ≈ 1us）の放電待ち
    coinPulseRestarts++;
  }

  digitalWrite(COIN_PIN, HIGH);
  if (coinPulseTimer) {
    esp_timer_start_once(coinPulseTimer, COINCIDENCE_WINDOW_US);
  } else {
    // タイマ生成に失敗している場合のフォールバック: 旧実装どおりブロックして下げる
    uint32_t t0 = micros();
    while ((uint32_t)(micros() - t0) < COINCIDENCE_WINDOW_US) {
    }
    digitalWrite(COIN_PIN, LOW);
  }
}

// esp_timer コールバック。esp_timer タスク文脈（通常 core0）で走るので
// GPIO 書き込み以外のことをしないこと。digitalWrite は W1TS/W1TC の
// 単一レジスタ書き込みなので loop 側の digitalWrite と競合しても壊れない。
void coinPulseEndCb(void* arg) {
  (void)arg;
  digitalWrite(COIN_PIN, LOW);
}

// COIN_PIN のピン設定と ISR を現在の coincMode / deviceMode に合わせて適用する。
// setup / SET_MODE / SET_COINC（いずれも core1 で実行される）からのみ呼ぶこと。
void applyCoinPinConfig() {
  detachInterrupt(digitalPinToInterrupt(COIN_PIN));  // 未アタッチでも安全
  coinSelfDriving = false;
  coinRingsClear();

  if (coincMode == COINC_PAIR) {
    // アイドルは Hi-Z。基板の R16 10k プルダウン（両機接続で 10k||10k）で LOW に落ちる。
    // INPUT_PULLUP にしないこと: 内部 45k プルアップと 5k の分圧でも LOW 側だが、
    // アイドルレベルが 0.3V 程度浮いてノイズマージンを削る。
    pinMode(COIN_PIN, INPUT);
    attachInterrupt(digitalPinToInterrupt(COIN_PIN), coinIsr, RISING);
  } else if (deviceMode == MODE_MASTER) {
    pinMode(COIN_PIN, OUTPUT);
    digitalWrite(COIN_PIN, LOW);  // アイドル LOW、検出時に HIGH パルス
  } else {
    pinMode(COIN_PIN, INPUT_PULLUP);  // 従来の SLAVE と同じ電気的状態
    if (coincMode == COINC_SLAVE) {
      attachInterrupt(digitalPinToInterrupt(COIN_PIN), coinIsr, RISING);
    }
  }
}

// ==========================================
//   表示
// ==========================================
void updateDisplay() {
  uint32_t OLED_t1 = micros();

  uint64_t elapsed_us = micros64() - start_time_us;
  // アンダーフロー防止。デッドタイムが経過時間を超えると符号なし演算で
  // 巨大な値に化け、レートが 0 に見えて不具合が隠れてしまう。
  uint64_t live_us = (elapsed_us > total_deadtime_us) ? (elapsed_us - total_deadtime_us) : 0ULL;

  float count_average = 0.0f;
  float count_std = 0.0f;
  bool rateValid = false;
  if (count > 0 && live_us > 0) {
    float live_s = (float)(live_us / 1000ULL) / 1000.0f;
    if (live_s > 0.0f) {
      count_average = count / live_s;
      count_std = sqrtf((float)count) / live_s;
      rateValid = true;
    }
  }

  if (OLED != 1 || !oledEnabled || !oledReady) return;

  display.setCursor(0, 0);
  display.clearDisplay();

  // オシロ中は計数していないので、統計を出すと止まって見えて紛らわしい。
  // 「いま測っていない」ことがひと目で分かる画面にする。
  if (scopeOn) {
    display.println(F("Accel Kitchen"));
    display.println(F("== SCOPE MODE =="));
    display.println(F("Counting PAUSED"));
    display.print(F("Waveforms:"));
    display.println(scopeEmitted);
    display.print(F("Rate lim :"));
    display.print(scopeRate);
    display.println(F("/s"));
    display.print(F("Cnt kept :"));
    display.println(count);
    display.display();
    // ここで OLED 時間を足さないこと。オシロ滞在時間は scopeSetOn(false) で
    // まとめてデッドタイムに計上されるので、二重計上になる。
    (void)OLED_t1;
    return;
  }

  display.print(F("Accel Kitchen "));
  if (coincMode == COINC_PAIR) {
    display.println(F(":Pair"));
  } else {
    display.println(deviceMode == MODE_SLAVE ? F(":Slave") : F(":Master"));
  }

  display.print(F("Cnt:"));
  display.print(count);
  display.print(F(" T:"));

  uint32_t hours   = (uint32_t)(elapsed_us / 3600000000ULL);
  int minutes = (int)((elapsed_us / 60000000ULL) % 60ULL);
  int seconds = (int)((elapsed_us / 1000000ULL) % 60ULL);
  char time_str[16];
  snprintf(time_str, sizeof(time_str), "%02lu:%02d:%02d", (unsigned long)hours, minutes, seconds);
  display.println(time_str);

  display.print(F("Rate: "));
  if (rateValid) {
    display.print(count_average, 2);
    display.print(F("+/-"));
    display.println(count_std, 2);
  } else {
    display.println(F("--"));
  }

  display.print(F("Sig"));
  display.print(SIGNAL_THRESHOLD);
  display.print(F(" Res:"));
  display.println(RESET_THRESHOLD);

  if (!isnan(temperatureC)) {
    display.print(F("T:"));
    display.print(temperatureC, 1);
    display.print(F("C  "));
  }
  display.println(sampleMode == SAMPLE_PEAK ? F("PEAK") : F("SNGL"));

  // ゲートする側（SLAVE または PAIR の両機）はゲート通過数/検出数を出す。
  // PC を繋がなくても、右だけ増えて左が 0 なら「相手機から信号が来ていない」と分かる。
  if ((deviceMode == MODE_SLAVE && coincMode == COINC_SLAVE) || coincMode == COINC_PAIR) {
    display.print(F("Coin:"));
    display.print(count);
    display.print('/');
    display.print(singlesCount);
  }

  display.display();

  total_deadtime_us += micros() - OLED_t1;
}

void OpeningScreen() {
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(8, 0);
  display.clearDisplay();
  display.println(F("Accel Kitchen"));
  display.println(F("V1 det / ESP32-S3"));
  display.print(F("Signal thresh: "));
  display.println(SIGNAL_THRESHOLD);
  display.print(F("Reset thresh: "));
  display.println(RESET_THRESHOLD);
  display.print(F("BLE: "));
  display.println(bleName);
  display.display();
  display.clearDisplay();
}

// ==========================================
//   setup
// ==========================================
void setup() {
  analogReadResolution(ADC_BITS);
  // 現コアの既定と同値だが明示しておく。将来既定が変わったときに
  // スペクトルのスケールが黙って変わるのを防ぐ。
  analogSetPinAttenuation(SIG_IN_PIN, ADC_11db);
  analogSetPinAttenuation(TEMP_PIN, ADC_11db);

  Serial.begin(9600);  // USB CDC 経由ならボーレートは名目上のもの
  // USB CDC の既定 TX タイムアウトは 250ms。ポートを開いたままダッシュボードを
  // 閉じると Serial.print() が 1 回あたり最大 250ms ブロックし、
  // 検出器が壊れたように見える巨大なデッドタイムになる。0 にして非ブロッキングにする。
  // "USB CDC On Boot" が無効だと Serial は UART0 (HardwareSerial) になり
  // このメソッド自体が存在しないので、ガードで囲む。
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);
#endif

  unsigned long t0 = millis();
  while (!Serial && (millis() - t0 < 1500)) { delay(10); }
  delay(200);
  Serial.println(F("\nBooting v1-S3..."));

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  loadConfig();

  // --- コインシデンス・エンジンの初期化 ---
  // MASTER パルス立ち下げ用ワンショットタイマ。生成に失敗した場合は
  // coinMasterPulse() が旧実装どおりのブロッキング動作にフォールバックする。
  {
    esp_timer_create_args_t targs = {};
    targs.callback = coinPulseEndCb;
    targs.dispatch_method = ESP_TIMER_TASK;
    targs.name = "coinpulse";
    if (esp_timer_create(&targs, &coinPulseTimer) != ESP_OK) {
      coinPulseTimer = nullptr;
    }
  }
  // リマップモード（nano_nora 既定）ではピン番号 != GPIO 番号なので実行時に解決する
  coinPinMask = (uint32_t)1UL << RESOLVED_GPIO(COIN_PIN);

  if (coincMode == COINC_PAIR) {
    // PAIR ではストラップ判定を丸ごとスキップする。従来判定は INPUT_PULLUP で
    // 読んで LOW なら OUTPUT LOW を駆動するため、両機とも相手のパルスを
    // 1k 越しに潰してしまう。PAIR の正しいアイドルは Hi-Z。
    deviceMode = MODE_MASTER;  // 表示とイベント行 mode 列のための便宜値
    applyCoinPinConfig();
  } else {
    // --- Master/Slave のストラップ判定 ---
    // D6 をプルアップ入力で読む。HIGH なら SLAVE、LOW なら MASTER。
    // 基板側には R15 1k 直列 + ジャック側 R16 10k プルダウンがあるため、
    // 単体では内部プルアップ(約45k)との分圧で約 0.65V = LOW となり MASTER で起動する。
    // SLAVE にするには相手機が起動時にこの線を HIGH に保つか、SET_MODE:1 を送る。
    // 内部プルアップは弱くケーブル容量もあるので、整定時間を置き 3 回読んで多数決を取る。
    pinMode(COIN_PIN, INPUT_PULLUP);
    delay(5);
    int highVotes = 0;
    for (int i = 0; i < 3; i++) {
      if (digitalRead(COIN_PIN) == HIGH) highVotes++;
      delayMicroseconds(200);
    }

    if (highVotes >= 2) {
      deviceMode = MODE_SLAVE;
      digitalWrite(LED_PIN, HIGH);
      delay(1000);
      digitalWrite(LED_PIN, LOW);
    } else {
      deviceMode = MODE_MASTER;
    }
    applyCoinPinConfig();  // SLAVE の ISR アタッチ / MASTER の OUTPUT+LOW を適用
  }

  // I2C / OLED を先に、BLE を後に初期化する。
  // Bluedroid はヒープを大きく確保するため、先に BLE を上げると
  // OLED のフレームバッファ確保に失敗することがある。
  if (OLED == 1) {
    // 汎用 ESP32-S3 変体の SDA/SCL 既定は GPIO8/9 で基板の配線(GPIO11/12)とは
    // 一致しないため、引数なしの Wire.begin() には頼らず明示的に指定する。
    // ここを間違えると OLED が完全に無反応になる。
    Wire.begin(I2C_SDA, I2C_SCL);
    i2cScan();
    Serial.print(F("### I2C scan: "));
    Serial.println(i2cScanResult);

    if (display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
      oledReady = true;
      display.setRotation(2);
      OpeningScreen();
      delay(2000);
      display.setTextSize(1);
    } else {
      oledReady = false;
      Serial.println(F("OLED Error: display.begin failed."));
    }
  }

  initBLE();

  // 起動時に必ず自動校正する。
  // V1 は if(OLED==1) の中でしか校正しておらず、OLED を切ると校正されなかった。
  Serial.println(F("### Auto-calibrating threshold on boot..."));
  calibrateThreshold(100, autoMargin);
  saveConfig();

  updateTemperature();
  printBootHeader();

  if (OLED == 1) updateDisplay();
  delay(900);
  start_time_us = micros64();
  lastDisplayMs = millis();
  lastTempMs = millis();
}

// ==========================================
//   loop
// ==========================================
void loop() {
  unsigned long now = millis();

  // LED の消灯（非ブロッキング）
  if (ledOffMs && now >= ledOffMs) {
    digitalWrite(LED_PIN, LOW);
    ledOffMs = 0;
  }

  drainCommandQueue();
  processSerialCommand();

  // BLE 再接続
  if (!bleDeviceConnected && bleOldDeviceConnected) {
    delay(500);
    BLEDevice::startAdvertising();
    bleOldDeviceConnected = false;
    bleMtuReported = false;
  }
  if (bleDeviceConnected && !bleOldDeviceConnected) {
    bleOldDeviceConnected = true;
  }

  // ネゴシエート済み MTU を 1 回だけ報告する（交換は接続直後に完了するので少し待つ）
  if (bleDeviceConnected && !bleMtuReported && (now - bleConnectedAtMs) > 1000) {
    bleMtuReported = true;
    char buf[48];
    snprintf(buf, sizeof(buf), "### BLE MTU: %u (chunk %u)",
             (unsigned)(pServer ? pServer->getPeerMTU(pServer->getConnId()) : 23),
             (unsigned)bleChunkSize());
    dualPrintln(buf);
  }

  // 温度更新（表示とは独立。OLED を切っても更新される）
  if (now - lastTempMs >= TEMP_INTERVAL_MS) {
    lastTempMs = now;
    updateTemperature();
  }

  // 検出 / オシロは排他。ADC1 は oneshot と DMA のどちらか一方しか持てない。
  if (scopeOn) {
    scopeService();
  } else {
    pollDetector();
    // 保留中のコインシデンス判定を確定する（受理→計数・出力 / 期限超過→棄却）
    coinPendingService(false);
  }

  // 表示 / 時刻更新。micros64() のラップ検出のため OLED 無効でも必ず通す。
  if (now - lastDisplayMs >= DISPLAY_INTERVAL_MS) {
    lastDisplayMs = now;
    coinEdgeSweep();  // エッジリングの定期掃引（71 分ラップのエイリアス防止）
    updateDisplay();
  }
}
