/*
  Accel Kitchen Cosmic Detector - V2 board peak-hold probe (ESP32-S3-Nano)
  - https://accel-kitchen.com/
  - info@accel-kitchen.com

  ============================================================================
  これは何のためのスケッチか
  ============================================================================
  V2 基板の A0 に出ている「ピークホールドの出力」を実測するための診断専用ファーム。
  計数はしない。

  V1 との違い（ここが本質）:
    V1 は A0 にアンプの生パルスが直結していたので、tau=199us で逃げていく波形を
    MCU が追いかける必要があった（結論: 追いつけない。トリガ点がすでにピーク）。
    V2 は回路にピークホールドが入っている:

      U2 LT1807(アンプ) -> D3 BAT54S(ピーク検出) -+-> U5 LT1806(バッファ) -> A0
                                                  |
                                          Q1 2N7002 (TriggerReset で放電)

      コンパレータ出力 -> D0 (Trigger)、しきい値は D2 の PWM

    したがって V2 で効くのは「パルスの速さ」ではなく、ホールド自身の 3 つの時定数:

      1. 整定時間     : トリガから、ホールドが真の波高に達するまで
                        -> ADC を読みに行く遅延の【下限】を決める
      2. ドループ率   : 保持中にどれだけ垂れるか
                        -> 遅延の【上限】を決める
      3. リセット復帰 : TriggerReset を叩いてからベースラインに戻るまで
                        -> デッドタイムと再アームの下限を決める

    この 3 つは A0 の波形を 1 本取れば全部見える。それがこのスケッチの目的。

  ============================================================================
  なぜ本番ファームの定数が怪しいのか（測る動機）
  ============================================================================
  COSMICRAY_DETECTOR_ESP32-S3-Nano-v2.ino の handleTriggerEvent() は
  ADC_SAMPLE_DELAY_US = 5 と書いてあるが、実際の順序は

      digitalWrite(COIN_OUT_PIN, HIGH);
      delayMicroseconds(COIN_SYNC_DELAY_US);   // 50us  <- これが先にある
      for (i<3) digitalRead(DIG_IN_PINS[i]);
      delayMicroseconds(ADC_SAMPLE_DELAY_US);  // 5us
      adc = analogRead(SELF_SIG_IN);           // 変換に約30us

  で、extEnabled が既定 true なので【実際のサンプル点はトリガから約 55〜60us 後】。
  さらに triggerMode の既定は TRIGGER_MODE_ANALOG_ONLY で、コンパレータ経路は
  既定では使われず loop が A0 をポーリングしているため、検出の遅れが上乗せされる。
  この 55〜90us が「整定後・ドループ許容内」に入っているかは誰も測っていない。

  ============================================================================
  重要: このスケッチは TRIG_RESET を自分で叩く
  ============================================================================
  ピークホールドはラッチするので、放電させないと 2 発目以降が永久に取れない。
  1 波形の中に

      整定 -> ドループ -> リセット -> 復帰

  が全部入るよう、トリガから SET_HOLDRESET:<us> 後に TRIG_RESET をパルスする。
  リセットが実際にいつ起きたかは波形上の段差を読めば分かるので、
  スケジュールの精度自体は問題にならない（loop 周期程度の粗さで十分）。

  ============================================================================
  ビルド設定
  ============================================================================
    ESP32 Arduino Core 3.x 必須（esp_adc/adc_continuous.h を使うため）。
    ボード      : ESP32S3 Dev Module + USB CDC On Boot=Enabled（実機はこの構成）
                  Arduino Nano ESP32 (nano_nora) でも可
    USB CDC On Boot : ★ Enabled 必須 ★

  必要ライブラリ:
    1. Adafruit SSD1306
    2. Adafruit GFX Library
*/

#include <Arduino.h>

#if !defined(ESP_ARDUINO_VERSION_MAJOR) || (ESP_ARDUINO_VERSION_MAJOR < 3)
#error "ESP32 Arduino Core 3.x が必要（esp_adc/adc_continuous.h と esp_cpu.h）。"
#endif

#include <Adafruit_SSD1306.h>
#include <Adafruit_GFX.h>
#include <Wire.h>
#include <math.h>
#include "esp_adc/adc_continuous.h"
#include "esp_random.h"
#include "esp_cpu.h"
#include "esp_err.h"
#include "esp32-hal-periman.h"  // ADC1 の所有権を oneshot から DMA へ渡すため

// ==========================================
//   ピン割り当て（V2 基板）
// ==========================================
// 本番スケッチ COSMICRAY_DETECTOR_ESP32-S3-Nano-v2.ino は生の GPIO 番号を
// 直接書いている（SELF_SIG_IN=1 等）。それは「ピン番号 = GPIO 番号」になる
// ビルド（ESP32S3 Dev Module、または Nano ESP32 の byGPIONumber）専用の書き方。
// こちらは公式 Nano ESP32 の既定（リマップ）でも正しく動くようシンボルで書き、
// 生 GPIO 番号側は本番スケッチと同じ値を使う（実機の ESP32S3 Dev Module では
// 両者は一致するので、測定結果が食い違うことはない）。
#if defined(ARDUINO_NANO_ESP32)
#define SIG_IN_PIN_DEF     A0  // GPIO1   ピークホールド出力
#define TRIGGER_IN_PIN_DEF D0  // GPIO44  コンパレータ出力
#define PWM_THRESH_PIN_DEF D2  // GPIO5   コンパレータしきい値
#define TRIG_RESET_PIN_DEF D8  // GPIO17  ホールド放電
#define LED_PIN_DEF        D3  // GPIO6
#define I2C_SDA_DEF        A4  // GPIO11
#define I2C_SCL_DEF        A5  // GPIO12
#else
#define SIG_IN_PIN_DEF     1
#define TRIGGER_IN_PIN_DEF 44
#define PWM_THRESH_PIN_DEF 5
#define TRIG_RESET_PIN_DEF 17
#define LED_PIN_DEF        6
#define I2C_SDA_DEF        11
#define I2C_SCL_DEF        12
#endif

const int SIG_IN_PIN     = SIG_IN_PIN_DEF;
const int TRIGGER_IN_PIN = TRIGGER_IN_PIN_DEF;
const int PWM_THRESH_PIN = PWM_THRESH_PIN_DEF;
const int TRIG_RESET_PIN = TRIG_RESET_PIN_DEF;
const int LED_PIN        = LED_PIN_DEF;
const int I2C_SDA        = I2C_SDA_DEF;
const int I2C_SCL        = I2C_SCL_DEF;

// ADC1 に属する他のピン。DMA へ渡すときに所有権を剥がす必要がある。
// A1=GPIO2(ADC1_CH1) / A2=GPIO3(ADC1_CH2)。A6=GPIO13 は ADC2 なので無関係。
#if defined(ARDUINO_NANO_ESP32)
const int ADC1_OTHER_PINS[2] = { A1, A2 };
#else
const int ADC1_OTHER_PINS[2] = { 2, 3 };
#endif

#if !defined(BOARD_HAS_PIN_REMAP) || defined(BOARD_USES_HW_GPIO_NUMBERS)
static_assert(SIG_IN_PIN     == 1,  "SIG must be GPIO1   (Nano header A0)");
static_assert(TRIGGER_IN_PIN == 44, "TRIG must be GPIO44 (Nano header D0)");
static_assert(PWM_THRESH_PIN == 5,  "PWM must be GPIO5   (Nano header D2)");
static_assert(TRIG_RESET_PIN == 17, "RST must be GPIO17  (Nano header D8)");
static_assert(LED_PIN        == 6,  "LED must be GPIO6   (Nano header D3)");
static_assert(I2C_SDA        == 11, "SDA must be GPIO11  (Nano header A4)");
static_assert(I2C_SCL        == 12, "SCL must be GPIO12  (Nano header A5)");
#endif

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

// ホールド出力は GPIO1 = ADC1_CH0（soc/adc_channel.h の ADC1_GPIO1_CHANNEL）。
static constexpr adc_channel_t SIG_ADC_CHANNEL = ADC_CHANNEL_0;

// ==========================================
//   OLED
// ==========================================
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
const int OLED_RESET_PIN = -1;
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET_PIN);
bool oledReady   = false;
bool oledEnabled = true;
// 画面の向き 0..3（Adafruit_GFX の setRotation）。実機の取り付け向きに合わせ、
// 横(0)から 180 度回した 2 を既定にする。
// SET_OLED_ROT:<0-3> で再フラッシュ無しに合わせられる。
uint8_t oledRotation = 2;
void updateDisplay();  // executeCommand から前方参照するため

// ==========================================
//   ADC / 取得パラメータ
// ==========================================
static constexpr int ADC_BITS = 12;
static constexpr int ADC_MAX  = (1 << ADC_BITS) - 1;

// ESP32-S3 の連続モード上限（soc_caps.h の SOC_ADC_SAMPLE_FREQ_THRES_HIGH/LOW）
static constexpr uint32_t FS_MAX = 83333;
static constexpr uint32_t FS_MIN = 611;

static constexpr int WF_MAX_SAMPLES = 512;
static constexpr int PRE_MAX  = 128;
static constexpr int POST_MAX = 384;

// 既定は「整定を見る」設定。83.3kHz なら post=192 で +2.3ms 見える。
// ドループを見るときは SET_FS:8333 (120us/点) + SET_HOLDRESET を大きく。
int  preSamples  = 32;
int  postSamples = 192;
uint32_t sampleFreqHz = FS_MAX;

// A0（ホールド出力）のしきい値。LEVEL トリガと再アームに使う。
static constexpr int SIGNAL_THRESHOLD_DEFAULT = 200;
static constexpr int RESET_GAP_DEFAULT        = 40;
static constexpr int AUTO_MARGIN_DEFAULT      = 60;
int SIGNAL_THRESHOLD = SIGNAL_THRESHOLD_DEFAULT;
int RESET_THRESHOLD  = SIGNAL_THRESHOLD_DEFAULT - RESET_GAP_DEFAULT;
int resetGap    = RESET_GAP_DEFAULT;
int autoMargin  = AUTO_MARGIN_DEFAULT;
int baselineAdc = 0;

uint32_t maxRate = 20;   // 波形の出力レート上限[/s]。0 = 無制限
uint32_t adcReadNs = 0;  // BENCH の実測値
uint32_t cpuMhz = 240;

// ==========================================
//   V2 固有: コンパレータとピークホールド
// ==========================================
// PWM しきい値。本番スケッチの applyThresholdPwm() は
//   pwmDuty = SIGNAL_THRESHOLD * PWM_MAX * 2 / ADC_MAX
// という換算だが *2 の意図が不明で SIGNAL_THRESHOLD>2047 で飽和する。
// ここでは生 duty 指定を主とし、換算は使わない。
static constexpr int PWM_BITS = 8;
static constexpr int PWM_MAX  = (1 << PWM_BITS) - 1;
static constexpr uint32_t PWM_FREQ_HZ = 40000;
// 起動時のフォールバック値。duty=20 だとコンパレータのしきい値が低すぎて
// ベースラインノイズで ~8kHz 自走する（実測）ので、ノイズ床より上に置く。
// 実際の値は setup() の autoPwm() が基板ごとに測って上書きする。
int pwmDuty = 96;

// コンパレータしきい値(PWM)の自動設定パラメータ
//   duty を上げていくと、ノイズ床を越えた所で comp_rate が急落する（ニー）。
//   最初に comp_rate <= target になった duty を採用し、マージンを足す。
//   低いほど感度が高いので「ノイズを消せる最小 duty」を選ぶのが狙い。
static constexpr uint32_t AUTO_PWM_TARGET_DEFAULT = 50;   // [edges/s] これ以下なら「静か」
static constexpr int      AUTO_PWM_STEP           = 8;    // duty 掃引の刻み
static constexpr uint32_t AUTO_PWM_SETTLE_MS      = 80;   // PWM の RC 平滑が落ち着くまで
static constexpr uint32_t AUTO_PWM_WINDOW_MS      = 120;  // エッジを数える窓
static constexpr int      AUTO_PWM_MARGIN_STEPS   = 2;    // ニーからの安全マージン

// トリガ後この時間でホールドを放電する。0 なら放電しない（ラッチしたままになる）。
// 実際にいつ落ちたかは波形の段差を読めば分かるので、精度は要らない。
uint32_t holdResetUs = 1500;
static constexpr uint32_t TRIG_RESET_PULSE_US = 20;  // 本番スケッチと同値

// t=0 をどこに置くか
//   TRIG_COMP  : D0 のコンパレータ立ち上がり。整定時間はこれでしか測れない
//   TRIG_LEVEL : A0 がしきい値を超えた点。本番の ANALOG_ONLY の見え方を再現する
enum TrigMode : uint8_t { TRIG_COMP = 0, TRIG_LEVEL = 1 };
TrigMode trigMode = TRIG_COMP;

// コンパレータ ISR。時刻を記録するだけ。
// 32bit micros() を積み、loop 側で micros64() と突き合わせて 64bit へ復元する。
static constexpr uint32_t COMP_EDGE_SLOTS = 16;  // 2 のべき乗
volatile uint32_t compEdgeUs[COMP_EDGE_SLOTS];
volatile uint32_t compEdgeHead = 0;
uint32_t compEdgeTail = 0;
volatile uint32_t compEdgeTotal = 0;

void IRAM_ATTR compIsr() {
  compEdgeUs[compEdgeHead & (COMP_EDGE_SLOTS - 1)] = (uint32_t)micros();
  compEdgeHead = compEdgeHead + 1;
  compEdgeTotal = compEdgeTotal + 1;
}

// ホールド放電の予約
bool     holdResetPending = false;
uint64_t holdResetAtUs    = 0;

// 診断: コンパレータ立ち上がり -> ホールドが立ち上がった点 の遅れ [0.1us]
// これが整定時間そのもの。時刻換算が壊れていれば測定中にドリフトするので気付ける。
int32_t  lastSettleTenths = 0;
double   settleSum = 0.0;
uint32_t settleN = 0;

// ==========================================
//   状態
// ==========================================
bool running = false;
uint32_t evtCount   = 0;
uint32_t ovfCount   = 0;
uint32_t dropCount  = 0;
uint32_t noiseCount = 0;  // COMP: 波高ゲートで捨てた回数
uint32_t startMs    = 0;
uint32_t lastStatCompEdges = 0;

int     lastPeakAdc = 0;
int32_t lastPeakDt  = 0;

unsigned long lastOledMs = 0;
unsigned long lastStatMs = 0;
uint32_t      lastStatEvt = 0;
unsigned long lastEmitMs = 0;

// ==========================================
//   出力行の組み立て
// ==========================================
// 512 点 x "4095," で最大 3kB。snprintf を点ごとに呼ぶと ms かかるので手書きで詰める。
static char   lineBuf[4096];
static size_t lineLen = 0;

static inline void lbChar(char c) {
  if (lineLen < sizeof(lineBuf) - 1) lineBuf[lineLen++] = c;
}
static void lbStr(const char* s) {
  while (*s) lbChar(*s++);
}
static void lbUInt(uint32_t v) {
  char t[12];
  int n = 0;
  do { t[n++] = (char)('0' + (v % 10)); v /= 10; } while (v);
  while (n) lbChar(t[--n]);
}
static void lbFlush() {
  lbChar('\n');
  Serial.write((const uint8_t*)lineBuf, lineLen);
  lineLen = 0;
}

// ==========================================
//   DMA（ADC 連続モード）
// ==========================================
adc_continuous_handle_t adcHandle = nullptr;
volatile bool dmaOverflowFlag = false;

static constexpr size_t DMA_RING_SIZE = 8192;
static constexpr size_t DMA_RING_MASK = DMA_RING_SIZE - 1;
static uint16_t dmaRing[DMA_RING_SIZE];
static uint64_t dmaWritten = 0;

static constexpr size_t DMA_READ_BYTES = 512;  // 4 byte/sample なので 128 点
static uint8_t dmaReadBuf[DMA_READ_BYTES];

// サンプル通番と時刻の対応。dmaStart() で打ち、以後は線形。
// ADC クロックと micros() はどちらも APB 由来なので長時間でもずれない。
uint64_t dmaT0Us = 0;

bool dmaArmed = false;
bool pendValid = false;
uint64_t pendTrigG = 0;

void dmaFail(const char* what, esp_err_t err) {
  char buf[128];
  snprintf(buf, sizeof(buf), "### ERROR: %s failed: %s (0x%x)",
           what, esp_err_to_name(err), (unsigned)err);
  Serial.println(buf);
}

static bool IRAM_ATTR dmaPoolOvfCb(adc_continuous_handle_t h,
                                   const adc_continuous_evt_data_t* edata,
                                   void* user_data) {
  (void)h; (void)edata; (void)user_data;
  dmaOverflowFlag = true;
  return false;
}

uint64_t micros64() {
  static uint64_t extended = 0;
  uint32_t now = micros();
  uint32_t last_lo = (uint32_t)extended;
  if (now < last_lo) extended += (uint64_t)1 << 32;
  extended = (extended & 0xFFFFFFFF00000000ULL) | now;
  return extended;
}

// 32bit の記録時刻を 64bit へ復元する（71 分以内のイベントであること）
static inline uint64_t widen32(uint32_t ev32) {
  uint64_t now64 = micros64();
  uint32_t now32 = (uint32_t)now64;
  return now64 - (uint64_t)(uint32_t)(now32 - ev32);
}

// 実効サンプルレート（公称 sampleFreqHz と実 ADC クロックの数 ppm ずれを補正）。
// dmaT0Us からの経過と dmaWritten から推定する。実測で公称 83333Hz に対し約 4ppm
// (0.335 サンプル/秒) ずれ、COMP の時刻→通番換算が長時間で狂って settle が偽増加
// していた。起動直後は「ドライバの取り出し遅延」で過小評価になるので、十分な経過(3s)と
// サンプル数が溜まるまでは公称値を使う（再アンカー直後は公称でも正確）。返り値は fs*1000。
static inline uint64_t effFreqHzX1000() {
  const uint64_t nominal = (uint64_t)sampleFreqHz * 1000ULL;
  const uint64_t now = micros64();
  if (now <= dmaT0Us) return nominal;
  const uint64_t elapsedUs = now - dmaT0Us;
  if (elapsedUs < 3000000ULL || dmaWritten < (uint64_t)sampleFreqHz * 3ULL) return nominal;
  // fs_actual*1000 = dmaWritten / elapsed[s] * 1000 = dmaWritten * 1e9 / elapsedUs
  return (dmaWritten * 1000000000ULL) / elapsedUs;
}

// 時刻 -> サンプル通番（実効レートでドリフト補正）
static inline uint64_t indexFromUs(uint64_t us) {
  if (us <= dmaT0Us) return 0;
  // index = (us - dmaT0Us) * fs / 1e6 = (us - dmaT0Us) * (fs*1000) / 1e9
  return ((us - dmaT0Us) * effFreqHzX1000()) / 1000000000ULL;
}

bool dmaStart() {
  if (adcHandle) return true;

  // --- ADC1 の所有権を oneshot から取り上げる ---
  // analogRead() が初回に作る oneshot ユニットは ADC1 を握りっぱなしにするので、
  // 剥がさないと adc_continuous_new_handle が必ず失敗する。
  // adcDetachBus は「ADC1 上の ADC_ONESHOT なピンが残り1本」になって初めて
  // ユニットを削除するため、ADC1 のピンを全部剥がす必要がある。
  // V2 では A0(GPIO1) に加えて A1(GPIO2) / A2(GPIO3) も ADC1。
  // A6(GPIO13) は ADC2 なので無関係。
  for (int i = 0; i < 2; i++) perimanClearPinBus(ADC1_OTHER_PINS[i]);
  perimanClearPinBus(SIG_IN_PIN);

  adc_continuous_handle_cfg_t hcfg = {};
  hcfg.max_store_buf_size = 32768;
  hcfg.conv_frame_size    = DMA_READ_BYTES;
  hcfg.flags.flush_pool   = 0;
  esp_err_t err = adc_continuous_new_handle(&hcfg, &adcHandle);
  if (err != ESP_OK) {
    dmaFail("adc_continuous_new_handle", err);
    adcHandle = nullptr;
    return false;
  }

  adc_digi_pattern_config_t pat = {};
  pat.atten     = ADC_ATTEN_DB_12;  // 旧 ADC_ATTEN_DB_11
  pat.channel   = (uint8_t)SIG_ADC_CHANNEL;
  pat.unit      = ADC_UNIT_1;
  pat.bit_width = ADC_BITS;

  adc_continuous_config_t ccfg = {};
  ccfg.pattern_num    = 1;
  ccfg.adc_pattern    = &pat;
  ccfg.sample_freq_hz = sampleFreqHz;
  ccfg.conv_mode      = ADC_CONV_SINGLE_UNIT_1;
  ccfg.format         = ADC_DIGI_OUTPUT_FORMAT_TYPE2;  // S3 は type2（data 12bit）
  err = adc_continuous_config(adcHandle, &ccfg);
  if (err != ESP_OK) {
    dmaFail("adc_continuous_config", err);
    adc_continuous_deinit(adcHandle);
    adcHandle = nullptr;
    return false;
  }

  adc_continuous_evt_cbs_t cbs = {};
  cbs.on_pool_ovf = dmaPoolOvfCb;
  adc_continuous_register_event_callbacks(adcHandle, &cbs, nullptr);

  err = adc_continuous_start(adcHandle);
  if (err != ESP_OK) {
    dmaFail("adc_continuous_start", err);
    adc_continuous_deinit(adcHandle);
    adcHandle = nullptr;
    return false;
  }

  dmaWritten = 0;
  dmaT0Us    = micros64();
  dmaArmed   = false;
  pendValid  = false;
  dmaOverflowFlag = false;
  compEdgeTail = compEdgeHead;  // 溜まっていた古いエッジは捨てる
  return true;
}

void dmaStop() {
  if (!adcHandle) return;
  adc_continuous_stop(adcHandle);
  adc_continuous_deinit(adcHandle);
  adcHandle = nullptr;
}

// ==========================================
//   ホールドの放電
// ==========================================
void holdResetNow() {
  digitalWrite(TRIG_RESET_PIN, HIGH);
  delayMicroseconds(TRIG_RESET_PULSE_US);
  digitalWrite(TRIG_RESET_PIN, LOW);
}

void holdResetSchedule(uint64_t trigUs) {
  if (holdResetUs == 0) return;
  holdResetAtUs = trigUs + (uint64_t)holdResetUs;
  holdResetPending = true;
}

void holdResetService() {
  if (!holdResetPending) return;
  if ((int64_t)(micros64() - holdResetAtUs) < 0) return;
  holdResetPending = false;
  holdResetNow();
}

// ==========================================
//   波形の切り出しと出力
// ==========================================
void emitWindow(uint64_t gTrig) {
  int npre = preSamples;
  if (gTrig < (uint64_t)npre) npre = (int)gTrig;
  const uint64_t gFirst = gTrig - (uint64_t)npre;
  const int ntot = npre + 1 + postSamples;

  if (dmaWritten - gFirst > DMA_RING_SIZE) { dropCount++; return; }

  const uint32_t periodNs = (uint32_t)((1000000000ULL + sampleFreqHz / 2) / sampleFreqHz);

  lineLen = 0;
  lbStr("WF,");  lbUInt(evtCount);
  lbChar(',');   lbUInt(millis() - startMs);
  lbStr(",U,");  lbUInt((uint32_t)npre);
  lbChar(',');   lbUInt((uint32_t)ntot);
  lbChar(',');   lbUInt(periodNs);

  int peak = -1, peakIdx = 0;
  for (int i = 0; i < ntot; i++) {
    uint16_t v = dmaRing[(size_t)(gFirst + (uint64_t)i) & DMA_RING_MASK];
    lbChar(',');
    lbUInt(v);
    if ((int)v > peak) { peak = v; peakIdx = i; }
  }
  lbFlush();

  lastPeakAdc = peak;
  lastPeakDt  = (int32_t)((int64_t)(peakIdx - npre) * (int64_t)periodNs / 100);
  evtCount++;
}

// 整定時間の推定。窓の中で「ベースライン + 半分」を最初に超えた点を探す。
// t=0 はコンパレータのエッジなので、その差がそのまま整定時間になる。
void measureSettle(uint64_t gTrig, int npre) {
  const uint64_t gFirst = gTrig - (uint64_t)npre;
  if (dmaWritten - gFirst > DMA_RING_SIZE) return;

  int base = 0;
  if (npre > 0) {
    int s = 0;
    for (int i = 0; i < npre; i++) s += dmaRing[(size_t)(gFirst + i) & DMA_RING_MASK];
    base = s / npre;
  }
  int hi = 0;
  const int scan = 1 + postSamples;
  for (int i = 0; i < scan; i++) {
    int v = dmaRing[(size_t)(gTrig + i) & DMA_RING_MASK];
    if (v > hi) hi = v;
  }
  const int half = base + (hi - base) / 2;
  if (hi - base < 20) return;  // 立ち上がりが小さすぎて意味が無い

  for (int i = 0; i < scan; i++) {
    int v = dmaRing[(size_t)(gTrig + i) & DMA_RING_MASK];
    if (v >= half) {
      const uint32_t periodNs = (uint32_t)((1000000000ULL + sampleFreqHz / 2) / sampleFreqHz);
      lastSettleTenths = (int32_t)((int64_t)i * (int64_t)periodNs / 100);
      settleSum += lastSettleTenths;
      settleN++;
      return;
    }
  }
}

// ==========================================
//   取得サービス
// ==========================================
void acqService() {
  if (!adcHandle) return;

  if (dmaOverflowFlag) {
    ovfCount++;
    // 取りこぼしが起きると dmaWritten と実時刻(dmaT0Us 基準)の対応が崩れ、COMP の
    // indexFromUs() がずれて emit しなくなる。DMA を張り直して dmaT0Us/dmaWritten を
    // 今の時刻へ再アンカーする（dmaStart が dmaWritten=0, dmaT0Us=now, 古いエッジ破棄,
    // フラグクリアを行う）。settle 計測の単一アンカー前提も保たれる。
    dmaStop();
    dmaStart();
    return;  // このターンはここまで。次ループから新しい通番で取得する
  }

  // --- ドライバから吸い出してリングへ積む ---
  for (int iter = 0; iter < 8; iter++) {
    uint32_t outLen = 0;
    esp_err_t err = adc_continuous_read(adcHandle, dmaReadBuf, DMA_READ_BYTES, &outLen, 0);
    if (err != ESP_OK || outLen == 0) break;

    for (uint32_t off = 0; off + SOC_ADC_DIGI_RESULT_BYTES <= outLen;
         off += SOC_ADC_DIGI_RESULT_BYTES) {
      adc_digi_output_data_t* p = (adc_digi_output_data_t*)&dmaReadBuf[off];
      if (p->type2.channel != (uint32_t)SIG_ADC_CHANNEL) continue;

      const uint16_t v = (uint16_t)p->type2.data;
      const uint64_t g = dmaWritten;
      dmaRing[g & DMA_RING_MASK] = v;
      dmaWritten = g + 1;

      // LEVEL トリガのときだけ、ストリーム上でしきい値超えを探す
      if (trigMode == TRIG_LEVEL && !pendValid) {
        if (!dmaArmed) {
          if ((int)v <= RESET_THRESHOLD) dmaArmed = true;
        } else if ((int)v > SIGNAL_THRESHOLD) {
          dmaArmed = false;
          pendTrigG = g;
          pendValid = true;
          holdResetSchedule(dmaT0Us + (g * 1000000ULL) / sampleFreqHz);
        }
      }
    }
  }

  // --- COMP トリガ: ISR が積んだエッジ時刻をサンプル通番へ換算する ---
  if (trigMode == TRIG_COMP && !pendValid) {
    while (compEdgeTail != compEdgeHead) {
      // リングを追い越されていたら古い側を捨てる
      if ((uint32_t)(compEdgeHead - compEdgeTail) > COMP_EDGE_SLOTS) {
        compEdgeTail = compEdgeHead - COMP_EDGE_SLOTS;
      }
      const uint32_t ev32 = compEdgeUs[compEdgeTail & (COMP_EDGE_SLOTS - 1)];
      compEdgeTail++;
      const uint64_t evUs = widen32(ev32);
      if (evUs < dmaT0Us) continue;  // DMA 開始より前のエッジ
      pendTrigG = indexFromUs(evUs);
      pendValid = true;
      holdResetSchedule(evUs);
      break;
    }
  }

  // --- 後続サンプルが揃ったら出す ---
  if (pendValid && dmaWritten >= pendTrigG + (uint64_t)postSamples + 1) {
    unsigned long now = millis();
    unsigned long minMs = (maxRate > 0) ? (1000UL / maxRate) : 0UL;

    // --- COMP モードの波高ゲート ---
    // コンパレータのしきい値は PWM(D2) で決まり、SIGNAL_THRESHOLD とは無関係。
    // コンパレータが低すぎてノイズで鳴っていると、そのままでは中身の無い窓を
    // 延々と出してしまうので、窓の最大値で足切りする。
    // SIGNAL_THRESHOLD=0 にすればゲート無し（ノイズもそのまま見たいとき用）。
    bool gated = false;
    if (trigMode == TRIG_COMP && SIGNAL_THRESHOLD > 0) {
      int hi = 0;
      const int scan = 1 + postSamples;
      for (int i = 0; i < scan; i++) {
        int v = dmaRing[(size_t)(pendTrigG + i) & DMA_RING_MASK];
        if (v > hi) hi = v;
      }
      if (hi < SIGNAL_THRESHOLD) { gated = true; noiseCount++; }
    }

    if (!gated) {
      if (minMs == 0 || (now - lastEmitMs) >= minMs) {
        int npre = preSamples;
        if (pendTrigG < (uint64_t)npre) npre = (int)pendTrigG;
        if (trigMode == TRIG_COMP) measureSettle(pendTrigG, npre);
        emitWindow(pendTrigG);
        lastEmitMs = now;
      } else {
        dropCount++;
      }
    }
    pendValid = false;
    if (trigMode == TRIG_LEVEL) dmaArmed = false;
  }
}

// ==========================================
//   BENCH
// ==========================================
void benchOne(const char* name, int kind, uint32_t n) {
  uint32_t mn = 0xFFFFFFFFu, mx = 0;
  double sum = 0.0, sumSq = 0.0;

  for (uint32_t i = 0; i < n; i++) {
    uint32_t c0 = esp_cpu_get_cycle_count();
    switch (kind) {
      case 0: (void)analogRead(SIG_IN_PIN); break;
      case 1: (void)analogReadMilliVolts(SIG_IN_PIN); break;
      default: break;
    }
    uint32_t d = esp_cpu_get_cycle_count() - c0;
    if (d < mn) mn = d;
    if (d > mx) mx = d;
    sum   += d;
    sumSq += (double)d * (double)d;
  }

  const double meanCyc = sum / n;
  const double varCyc  = sumSq / n - meanCyc * meanCyc;
  const double sdCyc   = (varCyc > 0.0) ? sqrt(varCyc) : 0.0;
  const double toNs    = 1000.0 / (double)cpuMhz;

  char buf[128];
  snprintf(buf, sizeof(buf), "BENCH:%s,%lu,%lu,%lu,%lu,%lu",
           name, (unsigned long)n,
           (unsigned long)(mn * toNs), (unsigned long)(meanCyc * toNs),
           (unsigned long)(mx * toNs), (unsigned long)(sdCyc * toNs));
  Serial.println(buf);

  if (kind == 0) adcReadNs = (uint32_t)(meanCyc * toNs);
}

void runBench() {
  const bool wasRunning = running;
  const bool wasDma = (adcHandle != nullptr);
  running = false;
  if (wasDma) dmaStop();

  Serial.println("### BENCH n,min_ns,mean_ns,max_ns,sd_ns");
  benchOne("loop", 2, 2000);
  benchOne("analogRead", 0, 2000);
  benchOne("analogReadMilliVolts", 1, 2000);

  if (wasDma) dmaStart();
  running = wasRunning;
}

// ==========================================
//   しきい値の自動校正
// ==========================================
// V1 のやり方（放電1回 -> 連続サンプリング）は V2 では通用しない。
// ピークホールドはラッチするので、放電せずに 400ms も回すと途中で来た本物の
// 宇宙線がホールドに残り、max がベースラインではなくその波高になってしまう。
// （実測でそれが起き、base=25 なのに thr=705 が設定された）
//
// 対策は 2 つ:
//   1. サンプルごとに放電し、復帰を待ってから読む
//      復帰は実測で約 1ms（リセット直後 200us は ADC 下端で 0 に潰れる）なので
//      3ms 待つ
//   2. それでも「放電〜読み取り」の 3ms 窓に入った事象は拾ってしまうので、
//      max ではなく上位 2% を切り捨てた p98 をしきい値の基準にする
static constexpr int CALIB_MAX_SAMPLES = 256;
static uint16_t calibBuf[CALIB_MAX_SAMPLES];

void calibrateThreshold(int samples, int margin) {
  const bool wasDma = (adcHandle != nullptr);
  if (wasDma) dmaStop();

  if (samples > CALIB_MAX_SAMPLES) samples = CALIB_MAX_SAMPLES;
  if (samples < 8) samples = 8;

  double sum = 0.0, sumSq = 0.0;
  for (int i = 0; i < samples; i++) {
    holdResetNow();
    delay(3);  // ホールドの復帰待ち（実測 約1ms）
    int v = analogRead(SIG_IN_PIN);
    calibBuf[i] = (uint16_t)v;
    sum   += v;
    sumSq += (double)v * v;
  }

  // 昇順に並べて分位点を取る（挿入ソート。256 点なので十分速い）
  for (int i = 1; i < samples; i++) {
    uint16_t k = calibBuf[i];
    int j = i - 1;
    while (j >= 0 && calibBuf[j] > k) { calibBuf[j + 1] = calibBuf[j]; j--; }
    calibBuf[j + 1] = k;
  }
  const int minValue = calibBuf[0];
  const int maxValue = calibBuf[samples - 1];
  const int median   = calibBuf[samples / 2];
  const int p98      = calibBuf[(samples * 98) / 100];

  const float mean = (float)(sum / samples);
  const float var  = (float)(sumSq / samples) - mean * mean;
  const float sd   = (var > 0.0f) ? sqrtf(var) : 0.0f;

  baselineAdc = median;
  SIGNAL_THRESHOLD = constrain(p98 + margin, 0, ADC_MAX);
  RESET_THRESHOLD  = constrain(SIGNAL_THRESHOLD - resetGap, 0, ADC_MAX);

  char buf[176];
  snprintf(buf, sizeof(buf),
           "### Calib: n=%d min=%d med=%d p98=%d max=%d mean=%.1f sd=%.1f "
           "margin=%d -> sig=%d rst=%d",
           samples, minValue, median, p98, maxValue, mean, sd,
           margin, SIGNAL_THRESHOLD, RESET_THRESHOLD);
  Serial.println(buf);
  if (maxValue > p98 + 50) {
    Serial.println("### NOTE: max >> p98 - 校正中に実事象がホールドに乗った形跡。"
                   "p98 基準なので影響は排除済み。");
  }

  if (wasDma) dmaStart();
}

// ==========================================
//   応答出力
// ==========================================
void printHeader() {
  const uint32_t periodNs = (uint32_t)((1000000000ULL + sampleFreqHz / 2) / sampleFreqHz);
  char buf[288];
  snprintf(buf, sizeof(buf),
           "#WF ver=1 mode=DMA board_rev=v2 trig=%s period_ns=%lu fs_hz=%lu "
           "pre=%d post=%d thr=%d rst=%d base=%d bits=%d atten=12db "
           "pwm_duty=%d hold_reset_us=%lu adc_read_ns=%lu maxrate=%lu cpu_mhz=%lu board=%s",
           trigMode == TRIG_COMP ? "COMP" : "LEVEL",
           (unsigned long)periodNs, (unsigned long)sampleFreqHz,
           preSamples, postSamples, SIGNAL_THRESHOLD, RESET_THRESHOLD,
           baselineAdc, ADC_BITS, pwmDuty, (unsigned long)holdResetUs,
           (unsigned long)adcReadNs, (unsigned long)maxRate,
           (unsigned long)cpuMhz, BOARD_NAME_STR);
  Serial.println(buf);
}

void printStat() {
  const uint32_t up = (millis() - startMs) / 1000;
  const uint32_t dtMs = millis() - lastStatMs;
  const float rate = (dtMs > 0) ? ((evtCount - lastStatEvt) * 1000.0f / dtMs) : 0.0f;
  lastStatMs = millis();
  lastStatEvt = evtCount;

  const float settleMean = settleN ? (float)(settleSum / settleN / 10.0) : 0.0f;

  // コンパレータの発火レート。SET_PWM を振ってこれを見ながら合わせる。
  // 物理イベント（宇宙線なら約1/s、線源なら数十/s）より桁違いに大きければ
  // しきい値が低すぎてノイズで鳴っている。
  const uint32_t edgesNow = compEdgeTotal;
  const float compRate = (dtMs > 0) ? ((edgesNow - lastStatCompEdges) * 1000.0f / dtMs) : 0.0f;
  lastStatCompEdges = edgesNow;

  // fs_act = ドリフト補正後の実効サンプルレート[Hz]。公称(fs_hz)からの差でクロック誤差が見える。
  char buf[256];
  snprintf(buf, sizeof(buf),
           "#WFSTAT evt=%lu rate=%.1f ovf=%lu drop=%lu noise=%lu up_s=%lu run=%d "
           "comp_edges=%lu comp_rate=%.1f settle_us=%.1f settle_mean_us=%.1f settle_n=%lu "
           "fs_act=%lu",
           (unsigned long)evtCount, rate, (unsigned long)ovfCount,
           (unsigned long)dropCount, (unsigned long)noiseCount,
           (unsigned long)up, running ? 1 : 0,
           (unsigned long)edgesNow, compRate, lastSettleTenths / 10.0f,
           settleMean, (unsigned long)settleN,
           (unsigned long)(effFreqHzX1000() / 1000ULL));
  Serial.println(buf);
}

void printTrig()      { Serial.println(trigMode == TRIG_COMP ? "TRIG:COMP" : "TRIG:LEVEL"); }
void printPwm()       { char b[32]; snprintf(b, sizeof(b), "PWM:%d", pwmDuty); Serial.println(b); }
void printHoldReset() { char b[40]; snprintf(b, sizeof(b), "HOLDRESET:%lu", (unsigned long)holdResetUs); Serial.println(b); }

void applyPwm() {
  analogWriteResolution(PWM_THRESH_PIN, PWM_BITS);
  analogWriteFrequency(PWM_THRESH_PIN, PWM_FREQ_HZ);
  analogWrite(PWM_THRESH_PIN, pwmDuty);
}

// ==========================================
//   コンパレータしきい値(PWM)の自動設定
// ==========================================
// コンパレータのしきい値は D2 の PWM を RC で平滑した DC で決まる。
// duty が低いとコンパレータがベースラインノイズで自走し、comp_rate が
// 物理イベント（背景 ~1/s、線源 数十/s）より桁違いに大きくなる。
// duty を上げて comp_rate が target 以下に落ちる最初の点を探し、マージンを
// 足して pwmDuty に設定する。エッジ計数は ISR (compEdgeTotal) なので DMA を
// 止めていても数えられる。
uint32_t measureCompRate(uint32_t windowMs) {
  const uint32_t e0 = compEdgeTotal;
  delay(windowMs);
  const uint32_t e1 = compEdgeTotal;
  return (uint32_t)(((uint64_t)(e1 - e0) * 1000ULL) / windowMs);
}

// comp_rate(duty) は単調ではないので、単純な「下から見て最初に静かになった点」は
// 使えない。実測の形は:
//   duty=0 付近 : しきい値が baseline 以下 -> コンパレータ出力が張り付き、立ち上がり
//                 エッジが出ない -> rate=0（「静か」に見えるが誤り。ここを掴むと最悪）
//   中域        : しきい値がノイズ帯を横切りチャタリングで rate 最大（ノイズ山）
//   高域        : しきい値がノイズ帯を越え、実イベントだけになり rate が physical に落ちる
// なので「ノイズ山を検出し、そこから上へ向かって最初に target を下回る点」を採る。
static constexpr uint32_t AUTO_PWM_NOISE_FLOOR = 500;  // [/s] これ未満ならノイズ山が見えていない
int autoPwm(uint32_t targetRate) {
  const bool wasDma = (adcHandle != nullptr);
  if (wasDma) dmaStop();   // 掃引中は取得を止める（エッジ計数は ISR なので影響なし）

  int      dutyArr[40];
  uint32_t rateArr[40];
  int      n = 0;
  uint32_t peakRate = 0;
  int      peakIdx  = 0;

  Serial.println("### AUTO_PWM sweep: duty,comp_rate[/s]");
  for (int d = 0; d <= PWM_MAX && n < 40; d += AUTO_PWM_STEP) {
    pwmDuty = d;
    applyPwm();
    delay(AUTO_PWM_SETTLE_MS);
    const uint32_t rate = measureCompRate(AUTO_PWM_WINDOW_MS);
    dutyArr[n] = d;
    rateArr[n] = rate;
    if (rate > peakRate) { peakRate = rate; peakIdx = n; }
    char line[48];
    snprintf(line, sizeof(line), "### %3d,%lu", d, (unsigned long)rate);
    Serial.println(line);
    n++;
  }

  int chosen = -1;
  if (peakRate < AUTO_PWM_NOISE_FLOOR) {
    // ノイズ山が立たない = コンパレータが一度もチャタらなかった。
    // 入力未接続 or D2->コンパレータのしきい値経路の断線を疑う。既定値のまま。
    Serial.println("### AUTO_PWM: no noise ridge seen (comparator never chattered). "
                   "入力未接続か D2->comp のしきい値経路を疑う。duty は既定へ戻す。");
    chosen = constrain(96, 0, PWM_MAX);
  } else {
    // ノイズ山の duty から上へ向かって、最初に target 以下へ落ちる点（ニー）を探す
    for (int i = peakIdx; i < n; i++) {
      if (rateArr[i] <= targetRate) { chosen = dutyArr[i]; break; }
    }
    if (chosen < 0) {
      // 掃引上限まで target を割らなかった。target を上げるかノイズ源を疑う。
      chosen = PWM_MAX;
      Serial.println("### AUTO_PWM: never dropped below target up to sweep end. "
                     "target を上げるかノイズ源を疑う。PWM_MAX で止める。");
    } else {
      chosen = constrain(chosen + AUTO_PWM_MARGIN_STEPS * AUTO_PWM_STEP, 0, PWM_MAX);
    }
  }

  pwmDuty = chosen;
  applyPwm();
  delay(AUTO_PWM_SETTLE_MS);
  const uint32_t finalRate = measureCompRate(AUTO_PWM_WINDOW_MS);

  char buf[120];
  snprintf(buf, sizeof(buf),
           "### AUTO_PWM done: duty=%d comp_rate=%lu/s "
           "(noise peak=%lu/s @duty%d, target<=%lu/s)",
           chosen, (unsigned long)finalRate, (unsigned long)peakRate,
           dutyArr[peakIdx], (unsigned long)targetRate);
  Serial.println(buf);

  if (wasDma) dmaStart();
  return chosen;
}

void applyTrigMode() {
  // 初回は ISR 未アタッチなので detach しない。未インストール状態で
  // detachInterrupt を呼ぶと "GPIO isr service is not installed" が出る（実害は
  // 無いがログが汚れる）。アタッチ状態を自前で覚えて回避する。
  static bool trigIsrAttached = false;
  if (trigIsrAttached) detachInterrupt(digitalPinToInterrupt(TRIGGER_IN_PIN));
  // COMP でなくてもエッジは数える（コンパレータが動いているかの確認に使える）
  attachInterrupt(digitalPinToInterrupt(TRIGGER_IN_PIN), compIsr, RISING);
  trigIsrAttached = true;
  compEdgeTail = compEdgeHead;
  pendValid = false;
  dmaArmed = false;
}

void resetCounters() {
  evtCount = 0; ovfCount = 0; dropCount = 0; noiseCount = 0;
  startMs = millis();
  lastStatMs = millis(); lastStatEvt = 0;
  lastStatCompEdges = compEdgeTotal;
  lastPeakAdc = 0; lastPeakDt = 0;
  settleSum = 0.0; settleN = 0; lastSettleTenths = 0;
  pendValid = false; dmaArmed = false;
  compEdgeTail = compEdgeHead;
  holdResetPending = false;
}

// ==========================================
//   コマンド
// ==========================================
void executeCommand(const char* cmd) {
  if (strcmp(cmd, "START") == 0) {
    // DMA を張り直して dmaT0Us(時刻基準) と dmaWritten(サンプル通番) を今の時刻へ
    // 再アンカーする。STOP 中は acqService が回らず dmaWritten が進まないので、
    // 張りっぱなしのまま START すると COMP の indexFromUs() が遠い未来を指し、
    // いつまでも emit しない（STOPPED を長く置いてから START するとこれが起きた）。
    if (adcHandle) dmaStop();
    if (!dmaStart()) Serial.println("### ERROR: DMA (re)start failed. Nothing will be captured.");
    resetCounters();
    running = true;
    printHeader();
    Serial.println("RUN:1");
    if ((uint64_t)holdResetUs * sampleFreqHz / 1000000ULL > (uint64_t)postSamples) {
      Serial.println("### WARN: hold reset happens after the capture window.");
      Serial.println("###       Lower SET_HOLDRESET or raise SET_POST / lower SET_FS.");
    }

  } else if (strcmp(cmd, "STOP") == 0) {
    running = false;
    Serial.println("RUN:0");

  } else if (strcmp(cmd, "RESET") == 0) {
    resetCounters();
    Serial.println("RESET:OK");

  } else if (strcmp(cmd, "GET_CFG") == 0) {
    printHeader();
    printStat();

  } else if (strcmp(cmd, "BENCH") == 0) {
    runBench();

  } else if (strcmp(cmd, "HOLDRESET_NOW") == 0) {
    holdResetNow();
    Serial.println("HOLDRESET:PULSED");

  } else if (strncmp(cmd, "SET_TRIG:", 9) == 0) {
    if (strcmp(cmd + 9, "COMP") == 0)       { trigMode = TRIG_COMP;  applyTrigMode(); }
    else if (strcmp(cmd + 9, "LEVEL") == 0) { trigMode = TRIG_LEVEL; applyTrigMode(); }
    printTrig();

  } else if (strcmp(cmd, "GET_TRIG") == 0) {
    printTrig();

  } else if (strncmp(cmd, "SET_PWM:", 8) == 0) {
    int d = atoi(cmd + 8);
    pwmDuty = constrain(d, 0, PWM_MAX);
    applyPwm();
    printPwm();

  } else if (strncmp(cmd, "AUTO_PWM", 8) == 0) {
    uint32_t target = AUTO_PWM_TARGET_DEFAULT;
    if (cmd[8] == ':') { long t = atol(cmd + 9); if (t >= 0) target = (uint32_t)t; }
    autoPwm(target);
    printPwm();

  } else if (strcmp(cmd, "GET_PWM") == 0) {
    printPwm();

  } else if (strncmp(cmd, "SET_HOLDRESET:", 14) == 0) {
    long v = atol(cmd + 14);
    holdResetUs = (v < 0) ? 0 : (uint32_t)v;
    printHoldReset();

  } else if (strcmp(cmd, "GET_HOLDRESET") == 0) {
    printHoldReset();

  } else if (strncmp(cmd, "SET_THRESH:", 11) == 0) {
    int sig = 0, rst = 0;
    int n = sscanf(cmd + 11, "%d,%d", &sig, &rst);
    if (n == 2 && sig > rst && rst >= 0 && sig <= ADC_MAX) {
      SIGNAL_THRESHOLD = sig; RESET_THRESHOLD = rst; resetGap = sig - rst;
    } else if (n == 1 && sig >= 0 && sig <= ADC_MAX) {
      SIGNAL_THRESHOLD = sig;
      RESET_THRESHOLD  = constrain(sig - resetGap, 0, ADC_MAX);
    }
    char buf[40];
    snprintf(buf, sizeof(buf), "THRESH:%d,%d", SIGNAL_THRESHOLD, RESET_THRESHOLD);
    Serial.println(buf);

  } else if (strcmp(cmd, "GET_THRESH") == 0) {
    char buf[40];
    snprintf(buf, sizeof(buf), "THRESH:%d,%d", SIGNAL_THRESHOLD, RESET_THRESHOLD);
    Serial.println(buf);

  } else if (strncmp(cmd, "AUTO_THRESH", 11) == 0) {
    int m = autoMargin;
    if (cmd[11] == ':') sscanf(cmd + 12, "%d", &m);
    autoMargin = constrain(m, 0, ADC_MAX);
    calibrateThreshold(200, autoMargin);
    char buf[40];
    snprintf(buf, sizeof(buf), "THRESH:%d,%d", SIGNAL_THRESHOLD, RESET_THRESHOLD);
    Serial.println(buf);

  } else if (strncmp(cmd, "SET_PRE:", 8) == 0) {
    preSamples = constrain(atoi(cmd + 8), 0, PRE_MAX);
    if (preSamples + 1 + postSamples > WF_MAX_SAMPLES) postSamples = WF_MAX_SAMPLES - 1 - preSamples;
    printHeader();

  } else if (strncmp(cmd, "SET_POST:", 9) == 0) {
    postSamples = constrain(atoi(cmd + 9), 1, POST_MAX);
    if (preSamples + 1 + postSamples > WF_MAX_SAMPLES) preSamples = WF_MAX_SAMPLES - 1 - postSamples;
    printHeader();

  } else if (strncmp(cmd, "SET_FS:", 7) == 0) {
    uint32_t f = (uint32_t)atol(cmd + 7);
    if (f >= FS_MIN && f <= FS_MAX) {
      sampleFreqHz = f;
      if (adcHandle) { dmaStop(); dmaStart(); }
    }
    printHeader();

  } else if (strncmp(cmd, "SET_MAXRATE:", 12) == 0) {
    long r = atol(cmd + 12);
    maxRate = (r < 0) ? 0 : (uint32_t)r;
    printHeader();

  } else if (strncmp(cmd, "SET_OLED:", 9) == 0) {
    if (strcmp(cmd + 9, "ON") == 0) {
      oledEnabled = true;
    } else if (strcmp(cmd + 9, "OFF") == 0) {
      oledEnabled = false;
      if (oledReady) { display.clearDisplay(); display.display(); }
    }
    Serial.println(oledEnabled ? "OLED:ON" : "OLED:OFF");

  } else if (strncmp(cmd, "SET_OLED_ROT:", 13) == 0) {
    oledRotation = (uint8_t)(constrain(atoi(cmd + 13), 0, 3));
    if (oledReady) { display.setRotation(oledRotation); updateDisplay(); }
    char buf[24];
    snprintf(buf, sizeof(buf), "OLED_ROT:%u", oledRotation);
    Serial.println(buf);

  } else if (strcmp(cmd, "GET_BOARD") == 0) {
    char buf[48];
    snprintf(buf, sizeof(buf), "BOARD:ESP32S3-WAVE-V2,%d", ADC_BITS);
    Serial.println(buf);
  }
  // 未知コマンドは無視
}

void processSerialCommand() {
  static char buf[64];
  static int idx = 0;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (idx > 0) { buf[idx] = '\0'; executeCommand(buf); idx = 0; }
    } else if (idx < (int)sizeof(buf) - 1) {
      buf[idx++] = c;
    }
  }
}

// ==========================================
//   表示
// ==========================================
void updateDisplay() {
  if (!oledReady || !oledEnabled) return;

  const uint32_t dtMs = millis() - startMs;
  const float rate = (dtMs > 0) ? (evtCount * 1000.0f / dtMs) : 0.0f;

  display.clearDisplay();
  display.setCursor(0, 0);
  display.print(F("V2 HOLD probe "));
  display.println(trigMode == TRIG_COMP ? F("CMP") : F("LVL"));

  display.print(F("Wf:"));
  display.print(evtCount);
  display.print(F(" "));
  display.print(rate, 1);
  display.println(F("/s"));

  display.print(F("Comp:"));
  display.println(compEdgeTotal);

  // 整定時間。ここが本命の数字なので PC 無しでも見えるようにする。
  display.print(F("Settle:"));
  if (settleN) {
    display.print(settleSum / settleN / 10.0, 1);
    display.println(F("us"));
  } else {
    display.println(F("--"));
  }

  display.print(F("Pk:"));
  display.print(lastPeakAdc);
  display.print(F(" Thr:"));
  display.println(SIGNAL_THRESHOLD);

  display.print(F("ovf:"));
  display.print(ovfCount);
  display.print(F(" drp:"));
  display.println(dropCount);

  display.println(running ? F("RUNNING") : F("stopped"));
  display.display();
}

// ==========================================
//   setup
// ==========================================
void setup() {
  analogReadResolution(ADC_BITS);
  // ピン単位ではなく全体で設定する。DMA と analogRead を往復すると
  // コアが oneshot ユニットを作り直すが、そのとき使われるのはグローバル値
  // (__analogAttenuation) なので、ピン単位設定だと往復のたびに失われる。
  analogSetAttenuation(ADC_11db);

  Serial.begin(115200);
  // 1 行が長いので、途中で切れないよう有限の送信待ちを許す。
  // 検出ループは無いのでブロックしても害は無い。
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(50);
#endif

  unsigned long t0 = millis();
  while (!Serial && (millis() - t0 < 1500)) { delay(10); }
  delay(200);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  pinMode(TRIGGER_IN_PIN, INPUT);
  pinMode(TRIG_RESET_PIN, OUTPUT);
  digitalWrite(TRIG_RESET_PIN, LOW);

  cpuMhz = getCpuFrequencyMhz();
  applyPwm();

  Wire.begin(I2C_SDA, I2C_SCL);
  if (display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    oledReady = true;
    display.setRotation(oledRotation);
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println(F("Accel Kitchen"));
    display.println(F("V2 hold probe"));
    display.display();
  }

  const char* bar = "##########################################################";
  Serial.println();
  Serial.println(bar);
  Serial.println("### Accel Kitchen - V2 board peak-hold probe");
  Serial.println("### 波形取得専用。計数はしません。");
  Serial.println("### A0 はアンプの生出力ではなく【ピークホールドの出力】です。");
  char buf[176];
  snprintf(buf, sizeof(buf), "### Build: board=%s cdc_on_boot=%d cpu=%luMHz core=%d.%d.%d",
           BOARD_NAME_STR, (int)ARDUINO_USB_CDC_ON_BOOT, (unsigned long)cpuMhz,
           ESP_ARDUINO_VERSION_MAJOR, ESP_ARDUINO_VERSION_MINOR, ESP_ARDUINO_VERSION_PATCH);
  Serial.println(buf);
  snprintf(buf, sizeof(buf),
           "### Pins[%s]: SIG=%d(ADC1_CH%d) TRIG=%d PWM=%d RST=%d LED=%d SDA=%d SCL=%d",
           PIN_MODE_NAME, RESOLVED_GPIO(SIG_IN_PIN), (int)SIG_ADC_CHANNEL,
           RESOLVED_GPIO(TRIGGER_IN_PIN), RESOLVED_GPIO(PWM_THRESH_PIN),
           RESOLVED_GPIO(TRIG_RESET_PIN), RESOLVED_GPIO(LED_PIN),
           RESOLVED_GPIO(I2C_SDA), RESOLVED_GPIO(I2C_SCL));
  Serial.println(buf);
  Serial.println(oledReady ? "### OLED: init OK (0x3C)" : "### OLED: init FAILED");

  runBench();

  Serial.println("### Auto-calibrating threshold (hold is discharged first)...");
  calibrateThreshold(200, autoMargin);

  applyTrigMode();

  // コンパレータのしきい値(D2 PWM)を基板ごとに自動設定する。
  // これをやらないと duty が低いままコンパレータがノイズで自走し、COMP
  // トリガが意味を成さない（旧既定 duty=20 で ~8kHz 自走していた）。
  Serial.println("### Auto-setting comparator PWM threshold "
                 "(raising duty until it stops firing on noise)...");
  autoPwm(AUTO_PWM_TARGET_DEFAULT);

  if (!dmaStart()) {
    Serial.println("### ERROR: DMA init failed. Nothing will be captured.");
  }

  Serial.println("### Commands: START STOP RESET GET_CFG BENCH HOLDRESET_NOW");
  Serial.println("###   SET_TRIG:COMP|LEVEL  SET_PWM:<0-255>  AUTO_PWM[:<rate/s>]  SET_HOLDRESET:<us>");
  Serial.println("###   SET_THRESH:<s>[,<r>] AUTO_THRESH[:<margin>]");
  Serial.println("###   SET_PRE:<n> SET_POST:<n> SET_FS:<hz> SET_MAXRATE:<ev/s> SET_OLED:ON|OFF SET_OLED_ROT:<0-3>");
  Serial.println("### 測り方:");
  Serial.println("###   整定   : SET_TRIG:COMP  SET_FS:83333 SET_HOLDRESET:1500");
  Serial.println("###   ドループ: SET_TRIG:COMP  SET_FS:8333  SET_HOLDRESET:15000 SET_POST:256");
  Serial.println("### Line: WF,<evt>,<t_ms>,U,<npre>,<ntot>,<period_ns>,<samples...>");
  Serial.println(bar);

  resetCounters();
  printHeader();
  Serial.println("### STOPPED. START で取得開始。");
}

// ==========================================
//   loop
// ==========================================
void loop() {
  processSerialCommand();

  if (running) acqService();
  holdResetService();

  static int ledState = -1;
  const int want = running ? HIGH : LOW;
  if (ledState != want) { digitalWrite(LED_PIN, want); ledState = want; }

  const unsigned long now = millis();
  if (now - lastOledMs >= 1000) {
    lastOledMs = now;
    updateDisplay();
    printStat();
  }
}
