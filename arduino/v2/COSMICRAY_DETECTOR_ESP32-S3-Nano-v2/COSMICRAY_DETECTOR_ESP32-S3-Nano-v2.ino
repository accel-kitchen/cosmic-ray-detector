/*
  Accel Kitchen Cosmic Detector - ESP32-S3-Nano Version (v2 board)
  - https://accel-kitchen.com/
  - info@accel-kitchen.com

  Target board : Arduino Nano ESP32 (ESP32-S3)
  Target circuit: cosmic-ray-detector-v2 (cosmic-ray-detector.kicad_sch)

  Main changes vs. the original ESP32-S3-Nano sketch:
    - Trigger is now a digital edge from an external comparator (D0).
      The comparator threshold is set by PWM duty on D2.
      Peak-hold is cleared by a short pulse on D8.
    - Buzzer on D1, Coincidence Out on D7 to the audio jack.
    - 3 external detectors on DIG_IN1..3 (D6,D5,D4) and ANA_IN1..3 (A1,A2,A6).
    - Temperature read from a BME280 on the shared I2C bus (U4), not an NTC.
    - Master/Slave pair mode removed.

  Library requirements:
    1. Adafruit SSD1306
    2. Adafruit GFX Library
    3. Adafruit BME280 Library  (+ Adafruit Unified Sensor)
    4. ESP32 Arduino Core (BLE, Preferences)
*/

#include <Arduino.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_GFX.h>
#include <Adafruit_BME280.h>
#include <Wire.h>
#include <SPI.h>
#include <SD.h>
#include <Preferences.h>
#include <math.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "esp_adc/adc_continuous.h"  // オシロスコープモードの DMA 連続サンプリング
#include "esp_err.h"
#include "esp32-hal-periman.h"       // ADC1 の所有権を oneshot から DMA へ渡すため

// オシロスコープモードで esp_adc/adc_continuous.h を使うため 3.x を要求する。
// これが無いと 2.x では意味の分かりにくいエラーになる。
#if !defined(ESP_ARDUINO_VERSION_MAJOR) || (ESP_ARDUINO_VERSION_MAJOR < 3)
#error "ESP32 Arduino Core 3.x が必要です。"
#endif

// ==========================================
//   設定
// ==========================================
const byte OLED = 1;

// Pin assignments for the v2 board.
const int SELF_SIG_IN  = 1;   // A0
const int TRIGGER_IN   = 44;  // D0
const int PWM_THRESH   = 5;   // D2
const int TRIG_RESET   = 17;  // D8
const int BUZZER_PIN   = 43;  // D1
const int COIN_OUT_PIN = 10;  // D7
const int DIG_IN_PINS[3] = { 9, 8, 7 };    // D6, D5, D4
const int ANA_IN_PINS[3] = { 2, 3, 13 };   // A1, A2, A6
const int LED_PIN      = 6;   // D3 (検出表示LED)
// 振動モーター (A7)。D13 は microSD の SCK なので使えない ── モーターを載せると
// SPI 波形が潰れて SD ログが壊れ、逆に SD アクセスのたびにモーターが唸る。
// v2 基板で未接続なヘッダピンは A3(GPIO4) と A7(GPIO14) の 2 本だけで、
// A7 は ADC2 側なのでオシロモードが占有する ADC1 と一切干渉しない。
// 注意: 1027 コイン型の定格電流(~75-90mA)は GPIO の絶対最大定格 40mA を超える。
// トランジスタ/MOSFET + 還流ダイオードで駆動すること (MANUAL.html 参照)。
const int VIB_PIN      = 14;  // A7 (振動モーター)
static constexpr int SD_SPI_CS_PIN = 18;         // D9  / CS  -> microSD (J8, CS2)
static constexpr int SD_SPI_UNUSED_CS_PIN = 21;  // D10 / CS1 (keep deasserted)
static constexpr int SD_SPI_MOSI_PIN = 38;       // D11 / COPI
static constexpr int SD_SPI_MISO_PIN = 47;       // D12 / CIPO
static constexpr int SD_SPI_SCK_PIN = 48;        // D13 / SCK
static constexpr uint32_t SD_SPI_FREQ_HZ = 4000000;

// OLED設定
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
const int OLED_RESET = -1;
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// BME280
Adafruit_BME280 bme;
bool bmeReady = false;

// しきい値 (0-4095 スケール, 12bit ADC / 8bit PWM Duty へ変換)
int SIGNAL_THRESHOLD = 120;

// ADC / PWM 分解能
static constexpr int ADC_BITS = 12;
static constexpr int ADC_MAX  = (1 << ADC_BITS) - 1;   // 4095
static constexpr int PWM_BITS = 8;
static constexpr int PWM_MAX  = (1 << PWM_BITS) - 1;   // 255
static constexpr uint32_t PWM_FREQ_HZ = 40000;
// コンパレータしきい値(D2 PWM)の自動較正パラメータ（AUTO_PWM）。
// duty を上げるとノイズ山を越えた所で comp_rate が急落する。最初に target 以下へ
// 落ちる点（ニー）にマージンを足して採用する。DIGITAL/DUAL トリガで使う。
static constexpr uint32_t AUTO_PWM_TARGET_DEFAULT = 50;   // [edges/s] これ以下なら「静か」
static constexpr int      AUTO_PWM_STEP           = 8;    // duty 掃引の刻み
static constexpr uint32_t AUTO_PWM_SETTLE_MS      = 80;   // PWM の RC 平滑待ち
static constexpr uint32_t AUTO_PWM_WINDOW_MS      = 120;  // エッジ計数窓
static constexpr int      AUTO_PWM_MARGIN_STEPS   = 2;    // ニーからの安全マージン
static constexpr uint32_t AUTO_PWM_NOISE_FLOOR    = 500;  // [/s] 未満ならノイズ山が見えていない
static constexpr int      PWM_DUTY_DEFAULT        = 96;   // 較正前フォールバック
static constexpr int LEGACY_ADC_BITS = 10;
static constexpr int LEGACY_ADC_MAX  = (1 << LEGACY_ADC_BITS) - 1;  // 1023
// Display refresh interval.
static constexpr unsigned long DISPLAY_INTERVAL_MS = 2000;


// センサ読み出し間隔 (ms) とトリガーリセットパルス幅 (us)
static constexpr unsigned long TEMP_READ_INTERVAL_MS = 2000;
static constexpr unsigned int TRIG_RESET_PULSE_US = 20;
static constexpr unsigned int ADC_SAMPLE_DELAY_US = 5;
// 注意: この 5us は「トリガから ADC を読むまで」ではない。
// handleTriggerEvent() は extEnabled(既定 true) のとき先に
// COIN_SYNC_DELAY_US(50us) + digitalRead x3 を通るので、
// 実際のサンプル点はトリガから約 55〜60us 後になる。
// ピークホールドの整定・ドループに対して妥当かは未測定。
// 測定用: v2/COSMICRAY_WAVEFORM_ESP32-S3-Nano-v2
// COIN_OUT パルス幅 (us, 非ブロッキング / micros() で管理)
static constexpr unsigned int COIN_OUT_PULSE_US = 100;
// 自ボードが COIN_OUT HIGH を出してから DIG_IN を読むまでの同期待ち時間 (us)
// 相手ボードが自身の ISR を処理して COIN_OUT HIGH を立てるまでのマージン。
static constexpr unsigned int COIN_SYNC_DELAY_US = 50;
// ブザートーン (Hz) と鳴動時間 (ms)
// ブザー: 宇宙線イベント毎に波高(ADC=エネルギー)で音程を変える ("ピっ")
// 音の高さ ∝ log(エネルギー) の対数マッピング（後述 handleTriggerEvent 内）。
// 人の音感は対数（オクターブ=2倍）で、線源スペクトルも急峻に落ちるため、線形だと
// 大多数の低エネルギー事象が狭い低音域に潰れて聞き分けられない。対数なら
// 「エネルギー2倍 = 一定の音程差」になり波高差が耳で分かる。
// SET_BEEP:<min>,<max>,<ms> で実行時に調整でき、Preferences に保存される。
// 既定: 500Hz(しきい値/低エネ)〜4000Hz(ADC最大/高エネ)。高域はブザー共振・
// 人の可聴感度のピーク(2〜5kHz)寄りなので、稀な高エネ事象が目立って鳴る。
unsigned int  beepFreqMinHz = 500;    // 波高=しきい値時の周波数
unsigned int  beepFreqMaxHz = 4000;   // 波高=ADC最大時
// 鳴動時間。tone() はノンブロッキング(別タスク)なので測定デッドタイムには効かない。
// ただし単一チャンネル・キュー処理なので、~1000/beepMs [ev/s] を超えると音が詰まる。
// 25ms なら〜40/s まで。線源で高レートなら 12〜15ms、音程を聞き分けたいなら 30〜40ms。
unsigned long beepMs = 25;             // 鳴動時間
static constexpr unsigned int BEEP_FREQ_LIMIT_HZ = 20000;  // 設定上限
static constexpr unsigned long LED_BLINK_MS = 20;

// 振動モーター: 波高(エネルギー)に応じて「振動時間」を変える。
// ブザーが音程を log(エネルギー) にマップしているのと同じ考え方で、
// 触覚も刺激の対数に比例して感じる(Weber-Fechner)ため、線形マップだと
// 大多数の低エネ事象が同じ長さに潰れて区別が付かない。幾何補間なら
// 「エネルギー2倍 = 常に一定倍の振動時間」になり、大きい事象が手に伝わる。
// SET_VIB_MS:<min>,<max> で調整でき Preferences に保存される。
unsigned int vibMinMs = 20;    // 波高=しきい値時 ("こつっ")
unsigned int vibMaxMs = 120;   // 波高=ADC最大時 ("ぶるっ")
static constexpr unsigned int VIB_MS_LIMIT = 500;  // 設定上限

enum TriggerMode : uint8_t {
  TRIGGER_MODE_DIGITAL_ONLY = 0,
  TRIGGER_MODE_DUAL = 1,
  TRIGGER_MODE_ANALOG_ONLY = 2,
};

// ==========================================
//   BLE UART Service (Nordic UART Service)
// ==========================================
#define SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_RX "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define CHARACTERISTIC_UUID_TX "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

BLEServer* pServer = nullptr;
BLECharacteristic* pTxCharacteristic = nullptr;
bool bleDeviceConnected = false;
bool bleOldDeviceConnected = false;

// BLE advertising name (editable at runtime via SET_BLENAME).
// Max 24 printable ASCII chars + null. Applied on next boot.
static constexpr size_t BLE_NAME_MAX = 24;
char bleName[BLE_NAME_MAX + 1] = "CosmicRay";

// Auto-calibration margin (counts above the sampled ADC max).
static constexpr int AUTO_MARGIN_DEFAULT = 50;
int autoMargin = AUTO_MARGIN_DEFAULT;

// ==========================================
//   Preferences (EEPROM代替)
// ==========================================
Preferences prefs;
File sdLogFile;
bool sdReady = false;
bool sdWriteFailed = false;
char sdLogPath[16] = {0};

// ==========================================
//   グローバル変数
// ==========================================
uint64_t start_time_us = 0ULL;
uint64_t total_deadtime_us = 0ULL;
unsigned long count = 0UL;
unsigned long lastDisplayMs = 0;

float temperatureC = NAN;
float humidityPct = NAN;
float pressureHPa = NAN;
int adc = 0;
int pwmDuty = 0;
TriggerMode triggerMode = TRIGGER_MODE_ANALOG_ONLY;
bool analogArmed = true;
bool sdEnabled   = true;
bool extEnabled  = true;
bool oledEnabled = true;
bool buzzerEnabled = true;
bool vibEnabled = true;
unsigned long lastTempReadMs = 0;
unsigned long ledOffMs = 0;
unsigned long vibOffMs = 0;
unsigned long coinOffUs = 0;

// ==========================================
//   オシロスコープモード（DMA 専用・計数停止）の状態
// ==========================================
// 「測定を止めて信号そのものを見る」ための独立モード。計数経路とは排他。
//
// なぜ計数を止めるのか:
//   ESP32-S3 の ADC1 は oneshot(analogRead) と continuous(DMA) のどちらか一方しか
//   持てない（adc_oneshot_new_unit のエラーに ESP_ERR_NOT_FOUND "already in use" がある）。
//   A0 を 12us 間隔で見るには DMA が要るが、そうすると analogRead が使えず
//   handleTriggerEvent() が動かせない。「見ている間は測っていない」と割り切ることで、
//   計数経路にもコインシデンスにも一切手を入れずに済む。
//
// 滞在時間はデッドタイムに計上するので、オシロを見たあとも計数率は正しいままになる。
//
// V2 固有の注意: A0 はアンプの生出力ではなく【ピークホールドの出力】。
// ホールドはラッチするので、窓を切り出したら必ず TRIG_RESET を叩いて放電すること。
// 叩かないと 2 発目以降が永久に来ない。
bool     scopeOn   = false;
uint32_t scopeRate = 3;
static constexpr uint32_t SCOPE_RATE_MAX = 20;
// オシロ中にコマンドがこの時間まったく来なければ、自分で OFF に戻して計数を再開する。
// ダッシュボードが SET_SCOPE:OFF を送れずに閉じても（タブを閉じた、PC が寝た、
// ケーブルを抜いた）夜通し計数が止まったままにならないための安全装置。
// ダッシュボードはオシロタブを開いている間 15 秒ごとに GET_SCOPE を送る。
static constexpr unsigned long SCOPE_IDLE_TIMEOUT_MS = 60000;
unsigned long lastCommandMs = 0;

static constexpr int SCOPE_PRE  = 32;
static constexpr int SCOPE_POST = 128;
static constexpr uint32_t SCOPE_FS_HZ = 83333;  // ESP32-S3 の連続モード上限 = 12.0us/点
static constexpr adc_channel_t SCOPE_ADC_CHANNEL = ADC_CHANNEL_0;  // GPIO1 = A0

adc_continuous_handle_t scopeAdc = nullptr;
volatile bool scopeOvfFlag = false;

static constexpr size_t SCOPE_RING      = 4096;
static constexpr size_t SCOPE_RING_MASK = SCOPE_RING - 1;
static uint16_t scopeRing[SCOPE_RING];
static uint64_t scopeWritten = 0;

static constexpr size_t SCOPE_READ_BYTES = 512;  // 4 byte/sample なので 128 点
static uint8_t scopeReadBuf[SCOPE_READ_BYTES];

bool     scopeArmed     = false;
bool     scopePendValid = false;
uint64_t scopePendTrigG = 0;
uint32_t scopeEmitted   = 0;
uint32_t scopeOvfCount  = 0;
unsigned long scopeEnterMs    = 0;
uint64_t      scopeEnterUs    = 0;
unsigned long scopeLastEmitMs = 0;

// ISR フラグ
volatile bool triggerFlag = false;
volatile uint32_t compEdgeCount = 0;  // コンパレータ端の総数（onTriggerISR で加算、AUTO_PWM で使用）
static bool triggerIsrAttached = false;  // tracks whether the TRIGGER_IN ISR is currently attached

// ==========================================
//   コマンド行の組み立て (Serial / BLE 共通)
// ==========================================
// 47 文字 + NUL。以前は 31 文字で、"SET_BLENAME:" (12) を引くと名前は 19 文字までしか
// 入らず、それより長い名前は黙って切り詰めて保存されていた。
static constexpr size_t CMD_BUF_SIZE = 48;

enum CmdFeedResult : uint8_t { CMD_NONE, CMD_READY, CMD_TOO_LONG };

struct CmdLine {
  char   buf[CMD_BUF_SIZE];
  size_t len;
  bool   overflow;
};

// 1 文字ずつ渡し、改行で行が確定したら CMD_READY（buf に NUL 終端のコマンド）。
// 長すぎた行は CMD_TOO_LONG で丸ごと捨てる。途中で切ったコマンドを実行すると、
// 切り詰めた BLE 名を保存して再起動する、といった事故になるため。
CmdFeedResult cmdFeed(CmdLine& l, char c) {
  if (c == '\n' || c == '\r') {
    const CmdFeedResult r = l.overflow ? CMD_TOO_LONG : (l.len > 0 ? CMD_READY : CMD_NONE);
    l.buf[l.len] = '\0';
    l.len = 0;
    l.overflow = false;
    return r;
  }
  if (l.len < CMD_BUF_SIZE - 1) l.buf[l.len++] = c;
  else l.overflow = true;
  return CMD_NONE;
}

// BLE の受信コールバックは BLE スタックのタスクで走る。そこから executeCommand() を
// 直接呼ぶと、SET_SCOPE:ON（ADC1 を DMA に渡す）や AUTO_PWM が loop() 側の
// analogRead / 計数処理と同時に走ってしまう。コールバックでは確定した行を
// キューに積むだけにし、実行は loop() の processBleCommands() で行う。
static constexpr UBaseType_t BLE_CMD_QUEUE_LEN = 8;
static QueueHandle_t bleCmdQueue = nullptr;
static CmdLine bleCmdLine = {};   // BLE タスクだけが触る

// ==========================================
//   プロトタイプ / Function prototypes
// ==========================================
void runCommand(const char* cmd);
void executeCommand(const char* cmd);
void processBleCommands();
void printCmdTooLong();
void dualPrint(const char* str);
void dualPrintln(const char* str);
void bleSend(const char* data, size_t len);
void writeSdLine(const char* str);
bool openNextSdLogFile();
void initSdLogging();
void printBootHeader();
void processSerialCommand();
void loadThresholds();
void saveThresholds();
void printThresholds();
void printTriggerMode();
void printSdStatus();
void printExtStatus();
void printOledStatus();
void printVibStatus();
void printVibMs();
void printBleName();
void printBtAddr();
void printAutoMargin();
void applySdEnable();
void applyOledEnable();
void calibrateThreshold(int samples, int sigOffset);
void applyThresholdPwm();
void applyTriggerMode();
uint32_t measureCompRate(uint32_t windowMs);
int autoPwm(uint32_t targetRate);
void printPwm();
void updateBme();
void updateDisplay();
void OpeningScreen();
void initBLE();
void IRAM_ATTR onTriggerISR();
void handleTriggerEvent(bool fromDigitalTrigger);
int scaleAdcValue(int value, int fromBits, int toBits);
bool scopeSetOn(bool on);
void scopeService();
void scopeHoldReset();
bool scopeAdcStart();
void scopeAdcStop();
void printScope();
void printScopeRate();
uint64_t micros64();

// ==========================================
//   BLE Callbacks
// ==========================================
// 接続の切り替わりで、組み立て途中のコマンド行を捨てる。残しておくと、20 バイトの
// 区切りで切れた前の接続の行に次の接続の最初のコマンドがつながり、
// "SET_BLENAME:LabStatiGET_BLENAME" のような有効な行になってしまう。
// どちらのコールバックも onWrite と同じ BLE タスクで走るので競合しない。
static void resetBleCmdLine() {
  bleCmdLine.len = 0;
  bleCmdLine.overflow = false;
}

class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) override {
    resetBleCmdLine();
    bleDeviceConnected = true;
  }
  void onDisconnect(BLEServer* pServer) override {
    bleDeviceConnected = false;
    resetBleCmdLine();
  }
};

class MyRXCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) override {
    // コア 3.x の getValue() は String を値で返す。getValue().c_str() と書くと
    // 一時オブジェクトが文の終わりで解放され、解放済みの領域を読むことになる。
    // 必ず変数に受けてから使う。長さも strlen ではなく length() で取る。
    String rx = pCharacteristic->getValue();
    const size_t rxLen = rx.length();
    for (size_t i = 0; i < rxLen; i++) {
      const CmdFeedResult r = cmdFeed(bleCmdLine, rx[i]);
      if (r == CMD_NONE) continue;
      char item[CMD_BUF_SIZE];
      if (r == CMD_READY) {
        memcpy(item, bleCmdLine.buf, CMD_BUF_SIZE);
      } else {
        item[0] = '\0';  // 空文字列 = 長すぎて捨てた行（loop 側でエラーを返す）
      }
      // 満杯なら捨てる。loop() が AUTO_PWM などで長く止まっているときだけ起きる。
      if (bleCmdQueue) xQueueSend(bleCmdQueue, item, 0);
    }
  }
};

// ==========================================
//   BLE送信ヘルパー
// ==========================================
void bleSend(const char* data, size_t len) {
  if (!bleDeviceConnected || !pTxCharacteristic) return;
  size_t offset = 0;
  while (offset < len) {
    size_t chunkSize = min((size_t)20, len - offset);
    pTxCharacteristic->setValue((uint8_t*)(data + offset), chunkSize);
    pTxCharacteristic->notify();
    offset += chunkSize;
    if (offset < len) delay(3);
  }
}

void dualPrint(const char* str) {
  Serial.print(str);
  bleSend(str, strlen(str));
}

void dualPrintln(const char* str) {
  Serial.println(str);
  size_t len = strlen(str);
  char buf[160];
  if (len + 1 < sizeof(buf)) {
    memcpy(buf, str, len);
    buf[len] = '\n';
    bleSend(buf, len + 1);
  } else {
    bleSend(str, len);
    bleSend("\n", 1);
  }
  writeSdLine(str);
}

void writeSdLine(const char* str) {
  if (!sdReady || !sdLogFile) return;

  if (!sdLogFile.println(str)) {
    if (!sdWriteFailed) {
      sdWriteFailed = true;
      Serial.println(F("SD: write failed"));
      bleSend("SD: write failed\n", 17);
    }
    sdLogFile.close();
    sdReady = false;
    return;
  }

  if (sdWriteFailed) {
    sdWriteFailed = false;
  }

  sdLogFile.flush();
}

bool openNextSdLogFile() {
  for (unsigned int index = 1; index <= 9999; index++) {
    snprintf(sdLogPath, sizeof(sdLogPath), "/LOG%04u.TXT", index);
    if (!SD.exists(sdLogPath)) {
      sdLogFile = SD.open(sdLogPath, FILE_WRITE);
      return (bool)sdLogFile;
    }
  }

  sdLogPath[0] = '\0';
  return false;
}

void initSdLogging() {
  pinMode(SD_SPI_UNUSED_CS_PIN, OUTPUT);
  digitalWrite(SD_SPI_UNUSED_CS_PIN, HIGH);
  pinMode(SD_SPI_CS_PIN, OUTPUT);
  digitalWrite(SD_SPI_CS_PIN, HIGH);

  pinMode(SD_SPI_MISO_PIN, INPUT_PULLUP);
  delay(20);

  const uint32_t sdFrequencies[] = {
    SD_SPI_FREQ_HZ,
    1000000,
    400000
  };

  bool sdInitOk = false;
  for (size_t i = 0; i < (sizeof(sdFrequencies) / sizeof(sdFrequencies[0])); i++) {
    SPI.end();
    delay(5);
    SPI.begin(SD_SPI_SCK_PIN, SD_SPI_MISO_PIN, SD_SPI_MOSI_PIN, SD_SPI_CS_PIN);
    delay(5);

    if (SD.begin(SD_SPI_CS_PIN, SPI, sdFrequencies[i])) {
      sdInitOk = true;
      char freqBuf[40];
      snprintf(freqBuf, sizeof(freqBuf), "SD: init OK at %lu Hz", (unsigned long)sdFrequencies[i]);
      dualPrintln(freqBuf);
      break;
    }
  }

  if (!sdInitOk) {
    char pinBuf[64];
    snprintf(pinBuf, sizeof(pinBuf),
             "SD: init failed (CS=%d MOSI=%d MISO=%d SCK=%d)",
             SD_SPI_CS_PIN, SD_SPI_MOSI_PIN, SD_SPI_MISO_PIN, SD_SPI_SCK_PIN);
    dualPrintln(pinBuf);
    dualPrintln("SD: check card insert, FAT32 format, and SPI wiring");
    return;
  }

  if (!openNextSdLogFile()) {
    dualPrintln("SD: log file create failed");
    return;
  }

  sdReady = true;
  dualPrintln("SD: ready");
  char pathBuf[40];
  snprintf(pathBuf, sizeof(pathBuf), "SD: logging to %s", sdLogPath);
  dualPrintln(pathBuf);
}

void printBootHeader() {
  const char* hdr1 = "##########################################################################################";
  dualPrintln(hdr1);
  dualPrintln("### Accel Kitchen");
  dualPrintln("### https://accel-kitchen.com/");
  dualPrintln("### info@accel-kitchen.com");

  if (sdReady) {
    char sdBuf[48];
    snprintf(sdBuf, sizeof(sdBuf), "### SD log file: %s", sdLogPath);
    dualPrintln(sdBuf);
  }

  char buf[64];
  snprintf(buf, sizeof(buf), "### Signal threshold: %d (Duty %d)", SIGNAL_THRESHOLD, pwmDuty);
  dualPrintln(buf);
  printTriggerMode();
  printSdStatus();
  printExtStatus();
  printOledStatus();
  printVibStatus();

  // printf を通らないので % は 1 つで書く（"%%" だとそのまま "%%" と出る）。
  dualPrintln("### Event Time[us] ADC[0-4095] Deadtime[us] Temp[C] Hum[%] Press[hPa] Dig1 Dig2 Dig3 Ana1 Ana2 Ana3");
  dualPrintln(hdr1);
}

// ==========================================
// Command handling (Serial / BLE)
// ==========================================
// Serial / BLE のコマンドはすべてここを通す。
// コマンドを実行している間は検出ループが回らない（BLE の応答は 20 バイトごとに
// 3 ms 待つので数 ms、AUTO_THRESH は約 1 秒、AUTO_PWM は約 7 秒）。その時間を
// まとめてデッドタイムに計上する。個々のコマンドの中では計上しない。
// 例外: オシロ中（前後どちらか）は滞在時間ごと scopeSetOn() が計上するので足さない。
//       RESET は計上の起点そのものを作り直すので足さない。
void runCommand(const char* cmd) {
  // どのコマンドもオシロの無操作タイマーを延長する（GET_SCOPE はその keepalive）。
  lastCommandMs = millis();
  const bool scopeBefore = scopeOn;
  const uint64_t t0 = micros64();
  executeCommand(cmd);
  if (!scopeBefore && !scopeOn && strcmp(cmd, "RESET") != 0) {
    total_deadtime_us += micros64() - t0;
  }
}

void executeCommand(const char* cmd) {
  if (strncmp(cmd, "SET_THRESH:", 11) == 0) {
    int sig;
    if (sscanf(cmd + 11, "%d", &sig) == 1) {
      if (sig >= 0 && sig <= ADC_MAX) {
        SIGNAL_THRESHOLD = sig;
        saveThresholds();
        applyThresholdPwm();
      }
    }
    printThresholds();
  } else if (strcmp(cmd, "GET_THRESH") == 0) {
    printThresholds();
  } else if (strncmp(cmd, "SET_PWM:", 8) == 0) {
    // コンパレータしきい値の duty を直接設定（0..255）
    int d;
    if (sscanf(cmd + 8, "%d", &d) == 1) {
      if (d < 0) d = 0;
      if (d > PWM_MAX) d = PWM_MAX;
      pwmDuty = d;
      applyThresholdPwm();
      saveThresholds();
    }
    printPwm();
  } else if (strcmp(cmd, "GET_PWM") == 0) {
    printPwm();
  } else if (strncmp(cmd, "AUTO_PWM", 8) == 0) {
    // コンパレータしきい値の自動較正。AUTO_PWM または AUTO_PWM:<target/s>
    uint32_t target = AUTO_PWM_TARGET_DEFAULT;
    if (cmd[8] == ':') { long t = atol(cmd + 9); if (t >= 0) target = (uint32_t)t; }
    autoPwm(target);
    saveThresholds();
    printPwm();
  } else if (strcmp(cmd, "AUTO_THRESH") == 0) {
    dualPrintln("### Auto-calibrating threshold...");
    calibrateThreshold(100, autoMargin);
    saveThresholds();
    applyThresholdPwm();
    printThresholds();
  } else if (strncmp(cmd, "AUTO_THRESH:", 12) == 0) {
    int m;
    if (sscanf(cmd + 12, "%d", &m) == 1) {
      if (m < 0) m = 0;
      if (m > ADC_MAX) m = ADC_MAX;
      autoMargin = m;
      saveThresholds();
    }
    dualPrintln("### Auto-calibrating threshold...");
    calibrateThreshold(100, autoMargin);
    saveThresholds();
    applyThresholdPwm();
    printThresholds();
    printAutoMargin();
  } else if (strcmp(cmd, "RESET") == 0) {
    count = 0;
    start_time_us = micros64();
    total_deadtime_us = 0ULL;
    // オシロ中の RESET: 閉じたときに計上する滞在時間を RESET 以降の分にする。
    // そのままだと RESET 前の滞在まで足され、デッドタイムが経過時間を超える。
    if (scopeOn) scopeEnterUs = start_time_us;
    dualPrintln("RESET:OK");
  } else if (strcmp(cmd, "GET_AUTO_MARGIN") == 0) {
    printAutoMargin();
  } else if (strncmp(cmd, "SET_AUTO_MARGIN:", 16) == 0) {
    int m;
    if (sscanf(cmd + 16, "%d", &m) == 1) {
      if (m < 0) m = 0;
      if (m > ADC_MAX) m = ADC_MAX;
      autoMargin = m;
      saveThresholds();
    }
    printAutoMargin();
  } else if (strncmp(cmd, "SET_MODE:", 9) == 0) {
    if (strcmp(cmd + 9, "DIGITAL") == 0) {
      triggerMode = TRIGGER_MODE_DIGITAL_ONLY;
    } else if (strcmp(cmd + 9, "DUAL") == 0) {
      triggerMode = TRIGGER_MODE_DUAL;
    } else if (strcmp(cmd + 9, "ANALOG") == 0) {
      triggerMode = TRIGGER_MODE_ANALOG_ONLY;
    }
    analogArmed = true;
    saveThresholds();
    applyTriggerMode();
    printTriggerMode();
    if (triggerMode != TRIGGER_MODE_ANALOG_ONLY) {
      dualPrintln("### Tip: run AUTO_PWM to calibrate the comparator threshold for digital triggering.");
    }
  } else if (strcmp(cmd, "GET_MODE") == 0) {
    printTriggerMode();
  } else if (strncmp(cmd, "SET_SD:", 7) == 0) {
    if (strcmp(cmd + 7, "ON") == 0) {
      sdEnabled = true;
    } else if (strcmp(cmd + 7, "OFF") == 0) {
      sdEnabled = false;
    }
    saveThresholds();
    applySdEnable();
    printSdStatus();
  } else if (strcmp(cmd, "GET_SD") == 0) {
    printSdStatus();
  } else if (strncmp(cmd, "SET_EXT:", 8) == 0) {
    if (strcmp(cmd + 8, "ON") == 0) {
      extEnabled = true;
    } else if (strcmp(cmd + 8, "OFF") == 0) {
      extEnabled = false;
    }
    saveThresholds();
    printExtStatus();
  } else if (strcmp(cmd, "GET_EXT") == 0) {
    printExtStatus();
  } else if (strncmp(cmd, "SET_OLED:", 9) == 0) {
    if (strcmp(cmd + 9, "ON") == 0) {
      oledEnabled = true;
    } else if (strcmp(cmd + 9, "OFF") == 0) {
      oledEnabled = false;
    }
    saveThresholds();
    applyOledEnable();
    printOledStatus();
  } else if (strcmp(cmd, "GET_OLED") == 0) {
    printOledStatus();
  } else if (strncmp(cmd, "SET_BUZZER:", 11) == 0) {
    if (strcmp(cmd + 11, "ON") == 0) {
      buzzerEnabled = true;
    } else if (strcmp(cmd + 11, "OFF") == 0) {
      buzzerEnabled = false;
    }
    saveThresholds();
    printBuzzerStatus();
  } else if (strcmp(cmd, "GET_BUZZER") == 0) {
    printBuzzerStatus();
  } else if (strncmp(cmd, "SET_VIB:", 8) == 0) {
    // "SET_VIB:" と "SET_VIB_MS:" は 8 文字目が ':' と '_' で分かれるので
    // strncmp の判定順に依存しない。
    if (strcmp(cmd + 8, "ON") == 0) {
      vibEnabled = true;
    } else if (strcmp(cmd + 8, "OFF") == 0) {
      vibEnabled = false;
      digitalWrite(VIB_PIN, LOW);  // 鳴動中に切られたら即止める
      vibOffMs = 0;
    }
    saveThresholds();
    printVibStatus();
  } else if (strcmp(cmd, "GET_VIB") == 0) {
    printVibStatus();
  } else if (strncmp(cmd, "SET_VIB_MS:", 11) == 0) {
    // SET_VIB_MS:<min_ms>,<max_ms>  波高→振動時間の対数レンジ
    int vmin = 0, vmax = 0;
    if (sscanf(cmd + 11, "%d,%d", &vmin, &vmax) == 2 &&
        vmin >= 1 && vmax > vmin && vmax <= (int)VIB_MS_LIMIT) {
      vibMinMs = (unsigned int)vmin;
      vibMaxMs = (unsigned int)vmax;
      saveThresholds();
    }
    printVibMs();
  } else if (strcmp(cmd, "GET_VIB_MS") == 0) {
    printVibMs();
  } else if (strcmp(cmd, "VIB_TEST") == 0) {
    // 短(min)→中(幾何中点)→長(max) を順に振動させて強弱を手で確認する。
    // BEEP_TEST と違い tone() のようなキューが無いので delay() で待つ。
    // 待った分のデッドタイムは runCommand() が計上する。
    unsigned int mid = (unsigned int)(sqrtf((float)vibMinMs * (float)vibMaxMs) + 0.5f);
    const unsigned int durs[3] = { vibMinMs, mid, vibMaxMs };
    for (int i = 0; i < 3; i++) {
      digitalWrite(VIB_PIN, HIGH);
      delay(durs[i]);
      digitalWrite(VIB_PIN, LOW);
      delay(200);  // 区切りが分かるよう間を空ける
    }
    vibOffMs = 0;
    printVibMs();
  } else if (strncmp(cmd, "SET_BEEP:", 9) == 0) {
    // SET_BEEP:<min_hz>,<max_hz>[,<ms>]  波高→音程の対数レンジと鳴動時間
    int fmin = 0, fmax = 0, ms = -1;
    int n = sscanf(cmd + 9, "%d,%d,%d", &fmin, &fmax, &ms);
    if (n >= 2 && fmin >= 50 && fmax > fmin && fmax <= (int)BEEP_FREQ_LIMIT_HZ) {
      beepFreqMinHz = (unsigned int)fmin;
      beepFreqMaxHz = (unsigned int)fmax;
      if (n == 3 && ms >= 1 && ms <= 500) beepMs = (unsigned long)ms;
      saveThresholds();
    }
    printBeep();
  } else if (strcmp(cmd, "GET_BEEP") == 0) {
    printBeep();
  } else if (strcmp(cmd, "BEEP_TEST") == 0) {
    // 低(min)→中(幾何中点)→高(max) を順に鳴らして音域を耳で確認する
    unsigned int mid = (unsigned int)(sqrtf((float)beepFreqMinHz * (float)beepFreqMaxHz) + 0.5f);
    tone(BUZZER_PIN, beepFreqMinHz, 200);
    tone(BUZZER_PIN, mid,           200);
    tone(BUZZER_PIN, beepFreqMaxHz, 200);
    printBeep();
  } else if (strncmp(cmd, "SET_SCOPE:", 10) == 0) {
    // オシロは永続化しない。次回起動時は必ず OFF。
    if (strcmp(cmd + 10, "ON") == 0)       scopeSetOn(true);
    else if (strcmp(cmd + 10, "OFF") == 0) scopeSetOn(false);
    else                                   printScope();
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
      saveThresholds();
      printBleName();
      dualPrintln("### BLE name saved. Restarting in 1s...");
      delay(1000);
      ESP.restart();
    } else {
      dualPrintln("### BLE name invalid (1-24 printable ASCII chars).");
      printBleName();
    }
  }
}

void printCmdTooLong() {
  char buf[64];
  snprintf(buf, sizeof(buf), "### ERROR: command too long (max %u chars), ignored.",
           (unsigned)(CMD_BUF_SIZE - 1));
  dualPrintln(buf);
}

// Serial command processing
void processSerialCommand() {
  static CmdLine line = {};

  while (Serial.available()) {
    switch (cmdFeed(line, (char)Serial.read())) {
      case CMD_READY:    runCommand(line.buf);     break;
      case CMD_TOO_LONG: printCmdTooLong();        break;
      default: break;
    }
  }
}

// BLE で届いたコマンドを loop() の文脈で実行する（MyRXCallbacks の説明を参照）。
void processBleCommands() {
  if (!bleCmdQueue) return;
  char item[CMD_BUF_SIZE];
  while (xQueueReceive(bleCmdQueue, item, 0) == pdTRUE) {
    if (item[0] == '\0') printCmdTooLong();
    else runCommand(item);
  }
}

// ==========================================
// Preferences
// ==========================================
void loadThresholds() {
  prefs.begin("cosmic", true);
  bool hasStoredThreshold = prefs.isKey("sig_thresh");
  SIGNAL_THRESHOLD = prefs.getInt("sig_thresh", 120);
  int storedAdcBits = prefs.getInt("sig_bits", hasStoredThreshold ? LEGACY_ADC_BITS : ADC_BITS);
  triggerMode = TRIGGER_MODE_ANALOG_ONLY;  // always boot in Analog mode (ignore saved mode)
  sdEnabled   = prefs.getUChar("sd_en",   1) != 0;
  extEnabled  = prefs.getUChar("ext_en",  1) != 0;
  oledEnabled = prefs.getUChar("oled_en", 1) != 0;
  buzzerEnabled = prefs.getUChar("buzz_en", 1) != 0;
  vibEnabled  = prefs.getUChar("vib_en",  1) != 0;
  pwmDuty = prefs.getInt("pwm_duty", PWM_DUTY_DEFAULT);
  if (pwmDuty < 0) pwmDuty = 0;
  if (pwmDuty > PWM_MAX) pwmDuty = PWM_MAX;
  beepFreqMinHz = prefs.getUInt("beep_fmin", beepFreqMinHz);
  beepFreqMaxHz = prefs.getUInt("beep_fmax", beepFreqMaxHz);
  beepMs        = prefs.getULong("beep_ms",  beepMs);
  // 壊れた値が保存されていた場合の健全化（min<max、範囲内、ms 1..500）
  if (beepFreqMinHz < 50 || beepFreqMinHz > BEEP_FREQ_LIMIT_HZ) beepFreqMinHz = 500;
  if (beepFreqMaxHz <= beepFreqMinHz || beepFreqMaxHz > BEEP_FREQ_LIMIT_HZ) beepFreqMaxHz = 4000;
  if (beepMs < 1 || beepMs > 500) beepMs = 25;
  vibMinMs = prefs.getUInt("vib_min", vibMinMs);
  vibMaxMs = prefs.getUInt("vib_max", vibMaxMs);
  if (vibMinMs < 1 || vibMinMs > VIB_MS_LIMIT) vibMinMs = 20;
  if (vibMaxMs <= vibMinMs || vibMaxMs > VIB_MS_LIMIT) vibMaxMs = 120;
  String storedBleName = prefs.getString("ble_name", "CosmicRay");
  strncpy(bleName, storedBleName.c_str(), BLE_NAME_MAX);
  bleName[BLE_NAME_MAX] = '\0';
  if (bleName[0] == '\0') {
    strncpy(bleName, "CosmicRay", BLE_NAME_MAX);
  }
  autoMargin = prefs.getInt("auto_margin", AUTO_MARGIN_DEFAULT);
  if (autoMargin < 0) autoMargin = 0;
  if (autoMargin > ADC_MAX) autoMargin = ADC_MAX;
  prefs.end();

  if (hasStoredThreshold && storedAdcBits > 0 && storedAdcBits != ADC_BITS) {
    SIGNAL_THRESHOLD = scaleAdcValue(SIGNAL_THRESHOLD, storedAdcBits, ADC_BITS);
  }
}

void saveThresholds() {
  prefs.begin("cosmic", false);
  prefs.putInt("sig_thresh", SIGNAL_THRESHOLD);
  prefs.putInt("sig_bits", ADC_BITS);
  prefs.putUChar("trig_mode", (uint8_t)triggerMode);
  prefs.putUChar("sd_en",   sdEnabled   ? 1 : 0);
  prefs.putUChar("ext_en",  extEnabled  ? 1 : 0);
  prefs.putUChar("oled_en", oledEnabled ? 1 : 0);
  prefs.putUChar("buzz_en", buzzerEnabled ? 1 : 0);
  prefs.putUChar("vib_en",  vibEnabled  ? 1 : 0);
  prefs.putInt("pwm_duty", pwmDuty);
  prefs.putUInt("beep_fmin", beepFreqMinHz);
  prefs.putUInt("beep_fmax", beepFreqMaxHz);
  prefs.putULong("beep_ms",  beepMs);
  prefs.putUInt("vib_min", vibMinMs);
  prefs.putUInt("vib_max", vibMaxMs);
  prefs.putString("ble_name", bleName);
  prefs.putInt("auto_margin", autoMargin);
  prefs.end();
}

void printThresholds() {
  char buf[48];
  snprintf(buf, sizeof(buf), "THRESH:%d DUTY:%d", SIGNAL_THRESHOLD, pwmDuty);
  dualPrintln(buf);
}

void printTriggerMode() {
  if (triggerMode == TRIGGER_MODE_ANALOG_ONLY) {
    dualPrintln("MODE:ANALOG");
  } else if (triggerMode == TRIGGER_MODE_DUAL) {
    dualPrintln("MODE:DUAL");
  } else {
    dualPrintln("MODE:DIGITAL");
  }
}

void printSdStatus() {
  dualPrintln(sdEnabled ? "SD:ON" : "SD:OFF");
}

void printExtStatus() {
  dualPrintln(extEnabled ? "EXT:ON" : "EXT:OFF");
}

void printOledStatus() {
  dualPrintln(oledEnabled ? "OLED:ON" : "OLED:OFF");
}

void printBuzzerStatus() {
  dualPrintln(buzzerEnabled ? "BUZZER:ON" : "BUZZER:OFF");
}

void printVibStatus() {
  dualPrintln(vibEnabled ? "VIB:ON" : "VIB:OFF");
}

void printVibMs() {
  char buf[32];
  snprintf(buf, sizeof(buf), "VIBMS:%u,%u", vibMinMs, vibMaxMs);
  dualPrintln(buf);
}

void printBeep() {
  char buf[48];
  snprintf(buf, sizeof(buf), "BEEP:%u,%u,%lu",
           beepFreqMinHz, beepFreqMaxHz, beepMs);
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

void applySdEnable() {
  if (!sdEnabled) {
    if (sdLogFile) {
      sdLogFile.close();
    }
    sdReady = false;
  } else if (!sdReady) {
    initSdLogging();
  }
}

void applyOledEnable() {
  if (OLED != 1) return;
  if (!oledEnabled) {
    display.clearDisplay();
    display.display();
  }
}

// ==========================================
// Threshold calibration and sensor helpers
// ==========================================
void calibrateThreshold(int samples, int margin) {
  // オシロ中は ADC1 が DMA に取られていて analogRead が通らない。
  // 一時的に DMA を降ろして校正し、終わったら戻す。
  const bool resumeScope = scopeOn;
  if (resumeScope) {
    scopeAdcStop();
#if ARDUINO_USB_CDC_ON_BOOT
    Serial.setTxTimeoutMs(0);
#endif
  }

  // A0 はピークホールド出力。ラッチしたままだとベースラインではなく
  // 前回の波高を測ってしまうので、必ず放電してから校正する。
  scopeHoldReset();
  delay(5);

  int minValue = ADC_MAX;
  int maxValue = 0;
  for (int i = 0; i < samples; i++) {
    int currentValue = analogRead(SELF_SIG_IN);
    if (currentValue < minValue) {
      minValue = currentValue;
    }
    if (currentValue > maxValue) {
      maxValue = currentValue;
    }
    delay(10);
  }

  SIGNAL_THRESHOLD = maxValue + margin;
  if (SIGNAL_THRESHOLD < 0) SIGNAL_THRESHOLD = 0;
  if (SIGNAL_THRESHOLD > ADC_MAX) SIGNAL_THRESHOLD = ADC_MAX;

  char buf[96];
  snprintf(buf, sizeof(buf),
           "### Auto-threshold calib: min=%d max=%d margin=%d -> thr=%d",
           minValue, maxValue, margin, SIGNAL_THRESHOLD);
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

void applyThresholdPwm() {
  // コンパレータしきい値(D2 PWM)を現在の pwmDuty で出力する。
  // 以前は pwmDuty = SIGNAL_THRESHOLD*PWM_MAX*2/ADC_MAX と SIGNAL_THRESHOLD から
  // 導いていたが、コンパレータ(アンプ出力を見る)と A0(ピークホールド)はスケールが
  // 異なり、この換算はしきい値をノイズ帯へ落としていた（実測: ノイズ知は duty ~40、
  // 換算だと threshold 90 -> duty 11 でノイズの中）。duty は AUTO_PWM / SET_PWM で
  // SIGNAL_THRESHOLD とは独立に決める。
  if (pwmDuty < 0) pwmDuty = 0;
  if (pwmDuty > PWM_MAX) pwmDuty = PWM_MAX;
  analogWrite(PWM_THRESH, pwmDuty);
}

void applyTriggerMode() {
  triggerFlag = false;
  if (triggerMode == TRIGGER_MODE_ANALOG_ONLY) {
    if (triggerIsrAttached) {
      detachInterrupt(digitalPinToInterrupt(TRIGGER_IN));
      triggerIsrAttached = false;
    }
  } else {
    attachInterrupt(digitalPinToInterrupt(TRIGGER_IN), onTriggerISR, RISING);
    triggerIsrAttached = true;
  }
}

// ==========================================
// コンパレータしきい値(D2 PWM)の自動較正
// ==========================================
uint32_t measureCompRate(uint32_t windowMs) {
  const uint32_t e0 = compEdgeCount;
  delay(windowMs);
  const uint32_t e1 = compEdgeCount;
  return (uint32_t)(((uint64_t)(e1 - e0) * 1000ULL) / windowMs);
}

// duty を掃引してノイズ山を検出し、その上側で最初に comp_rate<=target になる点に
// マージンを足して採用する。DIGITAL/DUAL トリガを使う前に一度実行する
// （ANALOG_ONLY はコンパレータを使わないので影響なし）。
int autoPwm(uint32_t targetRate) {
  // 掃引中はトリガモードに関わらずエッジを数えたいので一時的に ISR を張る。
  const bool wasAttached = triggerIsrAttached;
  if (!wasAttached) {
    attachInterrupt(digitalPinToInterrupt(TRIGGER_IN), onTriggerISR, RISING);
    triggerIsrAttached = true;
  }

  int      dutyArr[40];
  uint32_t rateArr[40];
  int      n = 0;
  uint32_t peakRate = 0;
  int      peakIdx  = 0;

  dualPrintln("### AUTO_PWM sweep: duty,comp_rate[/s]");
  for (int d = 0; d <= PWM_MAX && n < 40; d += AUTO_PWM_STEP) {
    pwmDuty = d;
    analogWrite(PWM_THRESH, pwmDuty);
    delay(AUTO_PWM_SETTLE_MS);
    const uint32_t rate = measureCompRate(AUTO_PWM_WINDOW_MS);
    dutyArr[n] = d;
    rateArr[n] = rate;
    if (rate > peakRate) { peakRate = rate; peakIdx = n; }
    char b[48];
    snprintf(b, sizeof(b), "### %3d,%lu", d, (unsigned long)rate);
    dualPrintln(b);
    n++;
  }

  int chosen = -1;
  if (peakRate < AUTO_PWM_NOISE_FLOOR) {
    // ノイズ山が立たない = コンパレータが一度もチャタらなかった。
    // 入力未接続 or D2->コンパレータのしきい値経路を疑う。既定値へ。
    dualPrintln("### AUTO_PWM: no noise ridge (comparator never chattered). "
                "check D2->comparator path or input; using default duty.");
    chosen = (PWM_DUTY_DEFAULT <= PWM_MAX) ? PWM_DUTY_DEFAULT : PWM_MAX;
  } else {
    for (int i = peakIdx; i < n; i++) {
      if (rateArr[i] <= targetRate) { chosen = dutyArr[i]; break; }
    }
    if (chosen < 0) {
      chosen = PWM_MAX;
      dualPrintln("### AUTO_PWM: never dropped below target; using PWM_MAX.");
    } else {
      chosen += AUTO_PWM_MARGIN_STEPS * AUTO_PWM_STEP;
      if (chosen > PWM_MAX) chosen = PWM_MAX;
    }
  }

  pwmDuty = chosen;
  analogWrite(PWM_THRESH, pwmDuty);
  delay(AUTO_PWM_SETTLE_MS);
  const uint32_t finalRate = measureCompRate(AUTO_PWM_WINDOW_MS);

  char b[128];
  snprintf(b, sizeof(b),
           "### AUTO_PWM done: duty=%d comp_rate=%lu/s (noise peak=%lu/s, target<=%lu/s)",
           chosen, (unsigned long)finalRate, (unsigned long)peakRate, (unsigned long)targetRate);
  dualPrintln(b);

  // トリガモードに応じた ISR 状態へ戻す（掃引で溜まった triggerFlag も落とす）
  applyTriggerMode();
  triggerFlag = false;
  // 較正の所要時間（約 7 秒）のデッドタイムは runCommand() が計上する。
  // オシロ中に実行された場合は滞在時間に含まれるので二重には足さない。
  return chosen;
}

void printPwm() {
  char buf[24];
  snprintf(buf, sizeof(buf), "PWM:%d", pwmDuty);
  dualPrintln(buf);
}

void updateBme() {
  if (!bmeReady) return;

  float nextTemperature = bme.readTemperature();
  if (!isnan(nextTemperature)) {
    temperatureC = nextTemperature;
  }
  float nextHumidity = bme.readHumidity();
  if (!isnan(nextHumidity)) {
    humidityPct = nextHumidity;
  }
  pressureHPa = bme.readPressure() / 100.0f;
}

int scaleAdcValue(int value, int fromBits, int toBits) {
  if (fromBits == toBits) return value;
  if (fromBits < toBits) return value << (toBits - fromBits);
  return value >> (fromBits - toBits);
}

// ==========================================
// Trigger ISR
// ==========================================
void IRAM_ATTR onTriggerISR() {
  triggerFlag = true;
  compEdgeCount++;
}

// ==========================================
// BLE initialization
// ==========================================
void initBLE() {
  // 受信コールバックが登録される前に作っておく。
  bleCmdQueue = xQueueCreate(BLE_CMD_QUEUE_LEN, CMD_BUF_SIZE);

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
// 64-bit microsecond counter (Arduino micros() + software wrap tracking).
// Must be called at least once per ~71 minutes to catch the 32-bit wrap.
// In this sketch it is called from handleTriggerEvent() and updateDisplay().
// ==========================================
uint64_t micros64() {
  static uint64_t extended = 0;
  uint32_t now = micros();
  uint32_t last_lo = (uint32_t)extended;
  if (now < last_lo) extended += (uint64_t)1 << 32;
  extended = (extended & 0xFFFFFFFF00000000ULL) | now;
  return extended;
}

// ==========================================
// Setup
// ==========================================
void setup() {
  analogReadResolution(ADC_BITS);
  analogWriteResolution(PWM_THRESH, PWM_BITS);
  analogWriteFrequency(PWM_THRESH, PWM_FREQ_HZ);

  Serial.begin(9600);
  // USB CDC の既定 TX タイムアウトは 250ms。ポートを開いたままダッシュボードを
  // 閉じると Serial.print() が 1 回あたり最大 250ms ブロックし、
  // 検出器が壊れたように見える巨大なデッドタイムになる。0 にして非ブロッキングにする。
  // オシロ中だけは行が途中で切れないよう scopeSetOn() が 50ms に戻す。
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(0);
#endif
  unsigned long t0 = millis();
  while (!Serial && (millis() - t0 < 1500)) { delay(10); }

  delay(200);
  Serial.println(F("\nBooting v2..."));

  pinMode(TRIGGER_IN, INPUT);
  pinMode(TRIG_RESET, OUTPUT);
  digitalWrite(TRIG_RESET, LOW);
  pinMode(COIN_OUT_PIN, OUTPUT);
  digitalWrite(COIN_OUT_PIN, LOW);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(VIB_PIN, OUTPUT);
  digitalWrite(VIB_PIN, LOW);

  for (int i = 0; i < 3; i++) {
    pinMode(DIG_IN_PINS[i], INPUT);
  }

  loadThresholds();
  Serial.println(F("### Auto-calibrating threshold on boot..."));
  calibrateThreshold(100, autoMargin);
  saveThresholds();
  applyThresholdPwm();

  initBLE();
  initSdLogging();
  Wire.begin(11, 12);

  if (OLED == 1) {
    if (display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
      display.setRotation(2);  // 実機の取り付け向きに合わせる（旧 1 は 90 度回っていた）
      OpeningScreen();
      delay(2000);
      display.setTextSize(1);
    } else {
      Serial.println(F("OLED Error: display.begin failed."));
    }
  }

  if (bme.begin(0x76, &Wire) || bme.begin(0x77, &Wire)) {
    bmeReady = true;
    Serial.println(F("BME280: OK"));
    updateBme();
  } else {
    bmeReady = false;
    Serial.println(F("BME280: not found"));
  }

  applyTriggerMode();
  printBootHeader();

  if (OLED == 1) updateDisplay();
  delay(900);
  start_time_us = micros64();
  lastDisplayMs = millis();
}

// ==========================================
// Main loop
// ==========================================
void loop() {
  unsigned long now = millis();
  // micros() の 32 ビットの桁上がり（約 71.6 分ごと）を取りこぼさないよう、毎周呼ぶ。
  // イベントも OLED 更新も無い状態（オシロ中で OLED OFF など）が続いても時刻が巻き戻らない。
  micros64();

  if (ledOffMs && now >= ledOffMs) {
    digitalWrite(LED_PIN, LOW);
    ledOffMs = 0;
  }

  if (vibOffMs && (long)(now - vibOffMs) >= 0) {
    digitalWrite(VIB_PIN, LOW);
    vibOffMs = 0;
  }

  if (coinOffUs && (int32_t)(micros() - coinOffUs) >= 0) {
    digitalWrite(COIN_OUT_PIN, LOW);
    coinOffUs = 0;
  }

  processSerialCommand();
  processBleCommands();

  // オシロの安全装置: 無操作が続いたら OFF に戻して計数を再開する。
  if (scopeOn && (millis() - lastCommandMs) >= SCOPE_IDLE_TIMEOUT_MS) {
    dualPrintln("### SCOPE: no command for 60 s, turning the scope OFF to resume counting.");
    scopeSetOn(false);
  }

  if (bmeReady && (lastTempReadMs == 0 || now - lastTempReadMs >= TEMP_READ_INTERVAL_MS)) {
    lastTempReadMs = now;
    updateBme();
  }

  // 切断から 500 ms 置いて広告を再開する。以前は delay(500) で待っていたが、その間は
  // 検出ループが止まるのにデッドタイムに入っていなかった。待たずに時刻だけ覚えておく。
  static unsigned long bleAdvRestartAtMs = 0;
  if (!bleDeviceConnected && bleOldDeviceConnected) {
    bleAdvRestartAtMs = now + 500;
    if (bleAdvRestartAtMs == 0) bleAdvRestartAtMs = 1;  // 0 は「予定なし」の印
    bleOldDeviceConnected = false;
  }
  if (bleAdvRestartAtMs && (long)(now - bleAdvRestartAtMs) >= 0) {
    bleAdvRestartAtMs = 0;
    if (!bleDeviceConnected) BLEDevice::startAdvertising();
  }
  if (bleDeviceConnected && !bleOldDeviceConnected) {
    bleOldDeviceConnected = true;
  }

  // 検出 / オシロは排他。ADC1 は oneshot と DMA のどちらか一方しか持てない。
  if (scopeOn) {
    scopeService();
  } else if (triggerMode == TRIGGER_MODE_ANALOG_ONLY) {
    int analogNow = analogRead(SELF_SIG_IN);
    if (analogNow >= SIGNAL_THRESHOLD) {
      if (analogArmed) {
        handleTriggerEvent(false);
        analogArmed = false;
      }
    } else {
      analogArmed = true;
    }
  } else if (triggerFlag) {
    handleTriggerEvent(triggerMode == TRIGGER_MODE_DUAL);
    triggerFlag = false;
  }

  if (OLED == 1 && oledEnabled) {
    if (now - lastDisplayMs >= DISPLAY_INTERVAL_MS) {
      lastDisplayMs = now;
      updateDisplay();
    }
  }
}

// ==========================================
// Oscilloscope mode (DMA 専用・計数停止)
// ==========================================
// 状態変数の宣言はグローバル変数の節にある（loop() より前で使うため）。
// ここは実装のみ。

// --- 出力行の組み立て ---
// 161 点 x "4095," で約 800 バイト。snprintf を点ごとに呼ぶと ms かかるので手書きで詰める。
static char   scopeLine[1400];
static size_t scopeLineLen = 0;

static inline void slChar(char c) {
  if (scopeLineLen < sizeof(scopeLine) - 1) scopeLine[scopeLineLen++] = c;
}
static void slStr(const char* s) { while (*s) slChar(*s++); }
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

void scopeFail(const char* what, esp_err_t err) {
  char buf[128];
  snprintf(buf, sizeof(buf), "### ERROR: %s failed: %s (0x%x)",
           what, esp_err_to_name(err), (unsigned)err);
  dualPrintln(buf);
}

static bool IRAM_ATTR scopeOvfCb(adc_continuous_handle_t h,
                                 const adc_continuous_evt_data_t* edata,
                                 void* user_data) {
  (void)h; (void)edata; (void)user_data;
  scopeOvfFlag = true;
  return false;
}

// ピークホールドの放電。handleTriggerEvent() と同じ叩き方。
void scopeHoldReset() {
  digitalWrite(TRIG_RESET, HIGH);
  delayMicroseconds(TRIG_RESET_PULSE_US);
  digitalWrite(TRIG_RESET, LOW);
}

bool scopeAdcStart() {
  if (scopeAdc) return true;

  // --- ADC1 の所有権を oneshot から取り上げる ---
  // analogRead() が初回に作る oneshot ユニットは ADC1 を握りっぱなしにするので、
  // 剥がさないと adc_continuous_new_handle が必ず失敗する。
  // adcDetachBus は「ADC1 上の ADC_ONESHOT なピンが残り1本」になって初めて
  // ユニットを削除するため、ADC1 のピンを全部剥がす必要がある。
  // V2 では A0(GPIO1) に加えて A1(GPIO2)/A2(GPIO3) も ADC1（外部検出器入力）。
  // A6(GPIO13) は ADC2 なので無関係。
  perimanClearPinBus(ANA_IN_PINS[0]);
  perimanClearPinBus(ANA_IN_PINS[1]);
  perimanClearPinBus(SELF_SIG_IN);

  adc_continuous_handle_cfg_t hcfg = {};
  hcfg.max_store_buf_size = 16384;
  hcfg.conv_frame_size    = SCOPE_READ_BYTES;
  hcfg.flags.flush_pool   = 0;
  esp_err_t err = adc_continuous_new_handle(&hcfg, &scopeAdc);
  if (err != ESP_OK) { scopeFail("adc_continuous_new_handle", err); scopeAdc = nullptr; return false; }

  adc_digi_pattern_config_t pat = {};
  pat.atten     = ADC_ATTEN_DB_12;  // 旧 ADC_ATTEN_DB_11
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
    adc_continuous_deinit(scopeAdc); scopeAdc = nullptr; return false;
  }

  adc_continuous_evt_cbs_t cbs = {};
  cbs.on_pool_ovf = scopeOvfCb;
  adc_continuous_register_event_callbacks(scopeAdc, &cbs, nullptr);

  err = adc_continuous_start(scopeAdc);
  if (err != ESP_OK) {
    scopeFail("adc_continuous_start", err);
    adc_continuous_deinit(scopeAdc); scopeAdc = nullptr; return false;
  }

  scopeWritten = 0;
  scopeArmed = false;
  scopePendValid = false;
  scopeOvfFlag = false;
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

void scopeEmit(uint64_t gTrig) {
  int npre = SCOPE_PRE;
  if (gTrig < (uint64_t)npre) npre = (int)gTrig;
  const uint64_t gFirst = gTrig - (uint64_t)npre;
  const int ntot = npre + 1 + SCOPE_POST;
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

void scopeService() {
  if (!scopeAdc) return;

  if (scopeOvfFlag) {
    scopeOvfFlag = false;
    scopeOvfCount++;
    scopePendValid = false;
    scopeArmed = false;
  }

  // ホールド出力なので、放電されて十分下がったところで再アームする
  const int rearm = SIGNAL_THRESHOLD / 2;

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

      if (scopePendValid) continue;
      if (!scopeArmed) {
        if ((int)v <= rearm) scopeArmed = true;
        continue;
      }
      if ((int)v <= SIGNAL_THRESHOLD) continue;
      scopeArmed = false;
      scopePendTrigG = g;
      scopePendValid = true;
    }
  }

  if (scopePendValid && scopeWritten >= scopePendTrigG + (uint64_t)SCOPE_POST + 1) {
    const unsigned long now = millis();
    const unsigned long minMs = (scopeRate > 0) ? (1000UL / scopeRate) : 0UL;
    if (minMs == 0 || (now - scopeLastEmitMs) >= minMs) {
      scopeEmit(scopePendTrigG);
      scopeLastEmitMs = now;
    }
    scopePendValid = false;
    // 窓を取り終えたら必ず放電する。しないとホールドが張り付いて次が来ない。
    scopeHoldReset();
  }
}

void printScope()     { dualPrintln(scopeOn ? "SCOPE:ON" : "SCOPE:OFF"); }
void printScopeRate() {
  char buf[32];
  snprintf(buf, sizeof(buf), "SCOPE_RATE:%lu", (unsigned long)scopeRate);
  dualPrintln(buf);
}

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
    scopeHoldReset();  // ラッチしていた値を捨ててから始める
#if ARDUINO_USB_CDC_ON_BOOT
    // 検出ループが止まっている間だけ、行が途中で切れないよう送信待ちを許す。
    Serial.setTxTimeoutMs(50);
#endif
    dualPrintln("### SCOPE: ON - counting is PAUSED while the scope is open.");
    dualPrintln("###        A0 is the PEAK-HOLD output, not the raw amplifier pulse.");
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
  scopeHoldReset();
  // 見ていた時間は測定していない時間なので、正直にデッドタイムへ計上する。
  // これをやらないとオシロを開いた回数だけ計数率が下がって見える。
  total_deadtime_us += micros64() - scopeEnterUs;
  // DIGITAL / DUAL ではオシロ中もコンパレータの割り込みが triggerFlag を立てている。
  // 残したままだと、次の loop() がホールドを放電した直後のベースラインを
  // 1 件のイベントとして数えてしまう（DIGITAL はしきい値の再確認をしない）。
  triggerFlag = false;
  dualPrintln("### SCOPE: OFF - counting resumed.");
  printScope();
  return true;
}

// ==========================================
// Trigger event handling
// ==========================================
void handleTriggerEvent(bool fromDigitalTrigger) {
  unsigned long measurement_t1 = micros();

  int dig[3] = {0, 0, 0};
  int ana[3] = {0, 0, 0};

  if (extEnabled) {
    // まず COIN_OUT を HIGH に立てる (相手ボードに自トリガを通知)。
    // 相手も対称に動作するので、両者が「相手の COIN_OUT HIGH」を観測できる。
    // LOW に戻すのは loop() 内で非同期に行う (micros() ベース)。
    digitalWrite(COIN_OUT_PIN, HIGH);
    coinOffUs = micros() + COIN_OUT_PULSE_US;

    // 相手側が ISR → COIN_OUT HIGH に到達するのを待つ。
    delayMicroseconds(COIN_SYNC_DELAY_US);

    // 相手の COIN_OUT (= 自ボードの DIG_IN) を読む。
    for (int i = 0; i < 3; i++) {
      dig[i] = digitalRead(DIG_IN_PINS[i]);
    }
  }

  delayMicroseconds(ADC_SAMPLE_DELAY_US);
  adc = analogRead(SELF_SIG_IN);
  if (fromDigitalTrigger && adc < SIGNAL_THRESHOLD) {
    digitalWrite(TRIG_RESET, HIGH);
    delayMicroseconds(TRIG_RESET_PULSE_US);
    digitalWrite(TRIG_RESET, LOW);
    total_deadtime_us += micros() - measurement_t1;
    return;
  }

  if (extEnabled) {
    for (int i = 0; i < 3; i++) {
      ana[i] = analogRead(ANA_IN_PINS[i]);
    }
  }

  // 宇宙線イベント毎に、波高(ADC=エネルギー)に応じた音程で短くビープ。
  // 音の高さ ∝ log(エネルギー) の対数マッピング:
  //   x = (ln adc - ln thr) / (ln ADC_MAX - ln thr)   … 0(しきい値)〜1(最大)
  //   f = fmin * (fmax/fmin)^x                          … 幾何補間
  // これで「エネルギーが r 倍 = 常に同じ音程差」になり、線形マップのように
  // 大多数の低エネ事象が最低音域へ潰れることがない。
  // 正規化した対数エネルギー x はブザー(音程)と振動モーター(時間)で共用する。
  // logf() はイベント経路上にいるので二度計算しない。
  int thr = (SIGNAL_THRESHOLD > 1) ? SIGNAL_THRESHOLD : 1;
  float x = 0.0f;                                     // 0=しきい値, 1=ADC最大
  if (adc > thr && ADC_MAX > thr) {
    x = (logf((float)adc) - logf((float)thr)) /
        (logf((float)ADC_MAX) - logf((float)thr));
    if (x < 0.0f) x = 0.0f; else if (x > 1.0f) x = 1.0f;
  }

  unsigned int beepFreq = beepFreqMinHz;              // 退避値(しきい値時)
  if (beepFreqMaxHz > beepFreqMinHz) {
    beepFreq = (unsigned int)(beepFreqMinHz *
               expf(x * logf((float)beepFreqMaxHz / (float)beepFreqMinHz)) + 0.5f);
  }
  if (buzzerEnabled) {
    tone(BUZZER_PIN, beepFreq, beepMs);
  }

  // 振動モーター: 同じ x を振動「時間」へ幾何補間する。ON にするだけで
  // 停止は loop() に任せるノンブロッキング方式(LED 点滅と同型)なので、
  // ブザーと同様に測定デッドタイムを増やさない。
  if (vibEnabled) {
    unsigned int vibDur = vibMinMs;
    if (vibMaxMs > vibMinMs) {
      vibDur = (unsigned int)(vibMinMs *
               expf(x * logf((float)vibMaxMs / (float)vibMinMs)) + 0.5f);
    }
    digitalWrite(VIB_PIN, HIGH);
    // 連発時は先に入っている停止予定を「縮めない」。短い事象が直前の
    // 長い振動を途中で切ってしまうのを防ぐ。
    unsigned long vibOff = millis() + vibDur;
    if (!vibOffMs || (long)(vibOff - vibOffMs) > 0) vibOffMs = vibOff;
  }

  digitalWrite(TRIG_RESET, HIGH);
  delayMicroseconds(TRIG_RESET_PULSE_US);
  digitalWrite(TRIG_RESET, LOW);

  count++;

  digitalWrite(LED_PIN, HIGH);
  ledOffMs = millis() + LED_BLINK_MS;

  char eventBuf[200];
  snprintf(eventBuf, sizeof(eventBuf),
           "%lu %llu %d %llu %.1f %.1f %.1f %d %d %d %d %d %d",
           count,
           (unsigned long long)(micros64() - start_time_us), adc,
           (unsigned long long)total_deadtime_us,
           temperatureC, humidityPct, pressureHPa,
           dig[0], dig[1], dig[2], ana[0], ana[1], ana[2]);
  dualPrintln(eventBuf);

  total_deadtime_us += micros() - measurement_t1;
}

// ==========================================
// Display update
// ==========================================
void updateDisplay() {
  unsigned long OLED_t1 = micros();

  if (bmeReady) {
    updateBme();
  }

  uint64_t total_time_us = (micros64() - start_time_us) - total_deadtime_us;

  float count_average = 0.0f;
  float count_std = 0.0f;
  if (count > 0 && total_time_us > 0) {
    float total_time_s = (float)(total_time_us / 1000ULL) / 1000.0f;
    count_average = count / total_time_s;
    count_std = sqrt((float)count) / total_time_s;
  }

  display.setCursor(0, 0);
  display.clearDisplay();
  display.println(F("Accel Kitchen v2"));

  display.print(F("Cnt:"));
  display.print(count);
  display.print(F(" T:"));

  uint64_t elapsed_us = micros64() - start_time_us;
  uint32_t hours = (uint32_t)(elapsed_us / 3600000000ULL);
  int minutes = (int)((elapsed_us / 60000000ULL) % 60ULL);
  int seconds = (int)((elapsed_us / 1000000ULL) % 60ULL);

  char time_str[16];
  snprintf(time_str, sizeof(time_str), "%lu:%02d:%02d",
           (unsigned long)hours, minutes, seconds);
  display.println(time_str);

  display.print(F("Rate: "));
  display.print(count_average, 2);
  display.print(F("+/-"));
  display.println(count_std, 2);

  display.print(F("Thr:"));
  display.print(SIGNAL_THRESHOLD);
  display.print(F(" Duty:"));
  display.println(pwmDuty);

  if (!isnan(temperatureC)) {
    display.print(F("T:"));
    display.print(temperatureC, 1);
    display.print(F("C "));
    display.print(humidityPct, 0);
    display.println(F("%"));
    display.print(pressureHPa, 1);
    display.print(F("hPa"));
  }
  display.display();

  // オシロ中は滞在時間ごとデッドタイムに入るので、ここで足すと二重になる。
  if (!scopeOn) total_deadtime_us += micros() - OLED_t1 + 73UL;
}

// ==========================================
// Opening screen
// ==========================================
void OpeningScreen() {
  display.setTextSize(2);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(8, 0);
  display.clearDisplay();
  display.println(F("Accel Kitchen v2"));
  display.print(F("Signal threshold: "));
  display.println(SIGNAL_THRESHOLD);
  display.print(F("PWM Duty: "));
  display.println(pwmDuty);
  display.print(F("BLE: "));
  display.println(bleName);
  display.display();
  display.clearDisplay();
}
