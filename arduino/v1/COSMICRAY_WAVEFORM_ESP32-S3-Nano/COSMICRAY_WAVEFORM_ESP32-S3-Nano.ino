/*
  Accel Kitchen Cosmic Detector - V1 board pulse-shape probe (ESP32-S3-Nano)
  - https://accel-kitchen.com/
  - info@accel-kitchen.com

  ============================================================================
  これは何のためのスケッチか
  ============================================================================
  V1 検出器基板のアナログ出力（A0）に出るパルスの「形」を実測するための診断専用
  ファーム。計数はしない。

  背景:
    V1(AVR) は analogRead が約 8us・ポーリング周期も約 10us と決定的だったので、
    「しきい値を超えた直後にもう一度読む」= トリガから約 10us 後の 1 点、で
    波高が定まっていた (COSMICRAY_DETECTOR_v1.ino の loop())。
    ESP32-S3 ではそれが成り立たないため COSMICRAY_DETECTOR_ESP32-S3-Nano.ino は
    SAMPLE_PEAK（PEAK_WINDOW_US=120us の窓で最大 PEAK_SAMPLES=8 回読み、その最大値）
    を既定にしてあるが、この 120us / 8 点という値には実測の裏付けが無い。

    決めるのに必要な数字が 2 つとも分かっていない:
      (a) ESP32-S3 の analogRead が実際に何 us かかるのか
      (b) V1 のパルスがトリガ時点から何 us でピークに達し、何 us で減衰するのか

    (a) は BENCH コマンドで、(b) は波形そのものを大量に取って平均することで測る。
    結論が「パルスが速すぎて V1 基板では原理的にピークを採れない
    （= V2 のピークホールド回路が要る）」になる可能性もあり、それも同じ測定で分かる。

  ============================================================================
  2 つの取得モード
  ============================================================================
    DMA  (既定) : ADC 連続モード（DMA）で 83.3kHz = 12.0us 等間隔・常時サンプリング。
                  ハードウェアクロック駆動なのでジッタが無く、リングを遡れば
                  トリガ前のサンプルも取れる。「回路が出している真の波形」を見る。
    POLL        : 本番スケッチと同じ analogRead のポーリングで取る。
                  「実機ファームが実際に見ている波形」を見る。
    両者を比べると、ピークを逃す原因が「回路のパルスが速い」のか
    「MCU が遅い」のかを切り分けられる。

  等価時間サンプリングについて:
    12us / 30us といった粗いサンプリングでも、多数のイベントを重ねれば
    それより細かい時間ビンが埋まる。パルスとサンプリング位相の関係が
    イベントごとにランダムだからである。
      - DMA  : ADC クロックとパルス到来時刻が無関係なので位相は自然にランダム
      - POLL : それだけでは位相が揃いやすいので、トリガ後に乱数ディザ待ちを入れる
    平均波形の時間分解能は 1 点あたりの間隔ではなく、統計量で決まる。

  ============================================================================
  ビルド設定
  ============================================================================
    ESP32 Arduino Core 3.x 必須（esp_adc/adc_continuous.h を使うため）。
    ボード      : Arduino Nano ESP32 (esp32:esp32:nano_nora)
                  クローン機なら ESP32S3 Dev Module + USB CDC On Boot=Enabled
    USB CDC On Boot : ★ Enabled 必須 ★（無効だと Serial が UART0 に出る）

    ピン割り当ては COSMICRAY_DETECTOR_ESP32-S3-Nano.ino と同一。

  ============================================================================
  ハードウェア上の注意（ファームでは対処できない）
  ============================================================================
    A0 に最大 5V が入りうる。アンプ U2(LT1807) は 5V 単電源で、その出力は
    分圧なしで A0 に直結している。ESP32-S3 では絶対最大定格を超えるため
    破損リスクがある。A0-GND 間の分圧か 3V3 へのクランプを推奨。
    この診断ではしきい値を下げて高レートで長時間回すことになるので、
    測定前に対策の有無を確認すること。

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
// ADC1 の所有権を oneshot(analogRead) から DMA へ受け渡すために要る。
// 詳細は dmaStart() のコメントを参照。
#include "esp32-hal-periman.h"

// ==========================================
//   ピン割り当て
// ==========================================
// COSMICRAY_DETECTOR_ESP32-S3-Nano.ino と完全に同じ。
// ボードによってピンシンボルの意味が違うので、選択ボードごとに切り替える。
#if defined(ARDUINO_NANO_ESP32)
#define SIG_IN_PIN_DEF A0  // GPIO1
#define TEMP_PIN_DEF   A3  // GPIO4
#define LED_PIN_DEF    D3  // GPIO6
#define I2C_SDA_DEF    A4  // GPIO11
#define I2C_SCL_DEF    A5  // GPIO12
#else
#define SIG_IN_PIN_DEF 1   // ヘッダ A0
#define TEMP_PIN_DEF   4   // ヘッダ A3
#define LED_PIN_DEF    6   // ヘッダ D3
#define I2C_SDA_DEF    11  // ヘッダ A4
#define I2C_SCL_DEF    12  // ヘッダ A5
#endif

const int SIG_IN_PIN = SIG_IN_PIN_DEF;
const int TEMP_PIN   = TEMP_PIN_DEF;
const int LED_PIN    = LED_PIN_DEF;
const int I2C_SDA    = I2C_SDA_DEF;
const int I2C_SCL    = I2C_SCL_DEF;

// ピン番号 = GPIO 番号になるビルドでは配線との一致をコンパイル時に検証できる。
#if !defined(BOARD_HAS_PIN_REMAP) || defined(BOARD_USES_HW_GPIO_NUMBERS)
static_assert(SIG_IN_PIN == 1,  "SIG must be GPIO1  (Nano header A0)");
static_assert(TEMP_PIN   == 4,  "TEMP must be GPIO4 (Nano header A3)");
static_assert(LED_PIN    == 6,  "LED must be GPIO6  (Nano header D3)");
static_assert(I2C_SDA    == 11, "SDA must be GPIO11 (Nano header A4)");
static_assert(I2C_SCL    == 12, "SCL must be GPIO12 (Nano header A5)");
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

// SiPM 信号は GPIO1 = ADC1_CH0（soc/adc_channel.h の ADC1_GPIO1_CHANNEL で確認）。
// DMA 連続モードはピン番号ではなくチャンネル番号で指定するため、ここは定数で持つ。
static constexpr adc_channel_t SIG_ADC_CHANNEL = ADC_CHANNEL_0;

// ==========================================
//   OLED
// ==========================================
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
const int OLED_RESET_PIN = -1;  // 基板の OLED ソケットはリセット端子を持たない
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET_PIN);
bool oledReady   = false;
bool oledEnabled = true;

// ==========================================
//   ADC / 取得パラメータ
// ==========================================
static constexpr int ADC_BITS = 12;
static constexpr int ADC_MAX  = (1 << ADC_BITS) - 1;

// ESP32-S3 の連続モード上限。soc_caps.h の SOC_ADC_SAMPLE_FREQ_THRES_HIGH/LOW。
static constexpr uint32_t FS_MAX = 83333;
static constexpr uint32_t FS_MIN = 611;

// 1 イベントに収める最大サンプル数。出力行のバッファ長がこれで決まる。
static constexpr int WF_MAX_SAMPLES = 512;
static constexpr int PRE_MAX  = 128;
static constexpr int POST_MAX = 384;

int  preSamples  = 64;
int  postSamples = 256;
uint32_t sampleFreqHz = FS_MAX;

// しきい値。本番スケッチと同じ 2 値ヒステリシス（裾での多重トリガを防ぐ）。
static constexpr int SIGNAL_THRESHOLD_DEFAULT = 480;
static constexpr int RESET_GAP_DEFAULT        = 20;
static constexpr int AUTO_MARGIN_DEFAULT      = 60;
int SIGNAL_THRESHOLD = SIGNAL_THRESHOLD_DEFAULT;
int RESET_THRESHOLD  = SIGNAL_THRESHOLD_DEFAULT - RESET_GAP_DEFAULT;
int resetGap    = RESET_GAP_DEFAULT;
int autoMargin  = AUTO_MARGIN_DEFAULT;
int baselineAdc = 0;  // 直近の校正で測ったベースライン平均

// 出力レート上限[events/s]。0 = 無制限。
// 1 行 1.6kB 程度あるので、USB CDC を溢れさせないための間引き。
// 既定 50/s ≒ 80kB/s。行が壊れるより間引くほうがよい。
uint32_t maxRate = 50;

// POLL モードのディザ幅[CPU サイクル]。0 なら BENCH の実測値から自動。
uint32_t ditherTenthsUs = 0;

// BENCH の実測値。ヘッダに載せてプロッタ側のシミュレーションに使う。
uint32_t adcReadNs = 0;

uint32_t cpuMhz = 240;

// ==========================================
//   状態
// ==========================================
enum AcqMode : uint8_t { ACQ_DMA = 0, ACQ_POLL = 1 };
AcqMode acqMode = ACQ_DMA;
bool running = false;

uint32_t evtCount   = 0;
uint32_t ovfCount   = 0;  // DMA プール溢れ
uint32_t dropCount  = 0;  // レート制限・リング追い越し・バッファ不足で捨てた数
uint32_t startMs    = 0;

// OLED 表示用。直近イベントのピーク値とその時刻[0.1us]。
int   lastPeakAdc  = 0;
int32_t lastPeakDt = 0;

unsigned long lastOledMs = 0;
unsigned long lastStatMs = 0;
uint32_t      lastStatEvt = 0;

// ==========================================
//   出力行の組み立て
// ==========================================
// 1 イベント 1 行。512 点 x "-12345,4095," で最大 6kB になるので静的に確保する。
// snprintf を 512 回呼ぶと ms オーダーかかるため、整数だけは手書きで詰める。
static char   lineBuf[8192];
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
static void lbInt(int32_t v) {
  if (v < 0) { lbChar('-'); lbUInt((uint32_t)(-(int64_t)v)); }
  else       { lbUInt((uint32_t)v); }
}
static void lbFlush() {
  lbChar('\n');
  // setTxTimeoutMs(50) にしてあるので、ホストが読んでいれば必ず全部出る。
  // 読んでいない場合は途中で切れるが、行に含まれる ntot と実際の項目数が
  // 食い違うのでプロッタ側が壊れた行として捨てる（1.4 節の取り決め）。
  Serial.write((const uint8_t*)lineBuf, lineLen);
  lineLen = 0;
}

// ==========================================
//   DMA（ADC 連続モード）
// ==========================================
// 常時サンプリングしてソフト側リングに積み、リングを走査してトリガを探す。
// 「トリガしてから取りに行く」のではなく「常に取っていて後から切り出す」ので、
// トリガ前のサンプルが手に入り、デッドタイムも無い。
adc_continuous_handle_t adcHandle = nullptr;
volatile bool dmaOverflowFlag = false;

// リングは 2 のべき乗。8192 点 = 83.3kHz で約 98ms ぶん。
static constexpr size_t DMA_RING_SIZE = 8192;
static constexpr size_t DMA_RING_MASK = DMA_RING_SIZE - 1;
static uint16_t dmaRing[DMA_RING_SIZE];
static uint64_t dmaWritten = 0;  // 通算サンプル数 = 次に書く位置の通算インデックス

// ドライバから 1 回に吸い出す量。4 バイト/サンプルなので 1024B = 256 点。
static constexpr size_t DMA_READ_BYTES = 1024;
static uint8_t dmaReadBuf[DMA_READ_BYTES];

// しきい値超えを見つけたら、後続 postSamples 点が揃うまでここで待たせる。
static constexpr int PEND_SLOTS = 8;
static uint64_t pendTrigG[PEND_SLOTS];
static int pendHead = 0, pendTail = 0;

bool dmaArmed = false;          // 直前に RESET を下回ったか（再アーム条件）
uint64_t dmaLastTrigG = 0;
bool dmaHasLastTrig = false;

// 失敗したときは黙って POLL に落ちるのではなく、どの API が何で落ちたかを出す。
// ESP_ERR_NOT_FOUND(0x105) が出たら ADC1 がまだ oneshot に握られている、
// ESP_ERR_INVALID_ARG(0x102) なら sample_freq_hz が範囲外、が典型。
void dmaFail(const char* what, esp_err_t err) {
  char buf[128];
  snprintf(buf, sizeof(buf), "### ERROR: %s failed: %s (0x%x)",
           what, esp_err_to_name(err), (unsigned)err);
  Serial.println(buf);
}

// プール溢れコールバック。ISR 文脈なのでフラグを立てるだけ。
// 溢れるとサンプルの連続性が切れて時間軸が信用できなくなるため、
// 未確定イベントは捨てる。
static bool IRAM_ATTR dmaPoolOvfCb(adc_continuous_handle_t h,
                                   const adc_continuous_evt_data_t* edata,
                                   void* user_data) {
  (void)h; (void)edata; (void)user_data;
  dmaOverflowFlag = true;
  return false;  // 高優先度タスクを起こす必要は無い
}

bool dmaStart() {
  if (adcHandle) return true;

  // --- ADC1 の所有権を oneshot から取り上げる ---
  // IDF 5.x では ADC ユニットは oneshot と continuous のどちらか一方しか持てない
  // （adc_oneshot_new_unit のエラーが ESP_ERR_NOT_FOUND "already in use"）。
  // Arduino の analogRead() は初回呼び出しで ADC1 に oneshot ユニットを作り、
  // それを握りっぱなしにする。したがって BENCH や AUTO_THRESH を一度でも通すと
  // そのままでは adc_continuous_new_handle が失敗する。
  // コア自身の analogContinuous() も同じ問題を perimanClearPinBus() で解いており
  // （esp32-hal-adc.c: 「ADC%d is running in oneshot mode. Aborting.」の直前）、
  // これがピンを INIT 状態へ戻して adc_oneshot_del_unit を呼ぶ唯一の公開経路。
  // ADC1 上のピンを全部剥がさないとユニットは解放されない（used_channels==1 の判定）。
  // 逆向き（DMA -> analogRead）は __analogRead が自動で作り直すので何も要らない。
  perimanClearPinBus(TEMP_PIN);
  perimanClearPinBus(SIG_IN_PIN);

  adc_continuous_handle_cfg_t hcfg = {};
  // conv_frame_size の倍数であること。65536B = 16384 点 ≒ 197ms ぶん溜められる。
  // OLED 更新（20-30ms）や長い行の送信で loop が止まっても溢れない余裕を取る。
  hcfg.max_store_buf_size = 65536;
  hcfg.conv_frame_size    = DMA_READ_BYTES;
  hcfg.flags.flush_pool   = 0;
  esp_err_t err = adc_continuous_new_handle(&hcfg, &adcHandle);
  if (err != ESP_OK) {
    dmaFail("adc_continuous_new_handle", err);
    adcHandle = nullptr;
    return false;
  }

  adc_digi_pattern_config_t pat = {};
  pat.atten     = ADC_ATTEN_DB_12;  // 旧 ADC_ATTEN_DB_11。本番スケッチの ADC_11db と同じ設定
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
  pendHead = pendTail = 0;
  dmaArmed = false;
  dmaHasLastTrig = false;
  dmaOverflowFlag = false;
  return true;
}

void dmaStop() {
  if (!adcHandle) return;
  // stop で ADC1 のロックが解放され、analogRead（oneshot）が再び使えるようになる。
  // deinit まで通しておかないと、次の start で設定を変えられない。
  adc_continuous_stop(adcHandle);
  adc_continuous_deinit(adcHandle);
  adcHandle = nullptr;
}

// リング上のイベント窓を 1 行にして出す。
// gTrig = しきい値を超えたサンプルの通算インデックス（この点が t=0）。
void dmaEmit(uint64_t gTrig) {
  int npre = preSamples;
  if (gTrig < (uint64_t)npre) npre = (int)gTrig;  // 起動直後は前が足りない
  const uint64_t gFirst = gTrig - (uint64_t)npre;
  const int ntot = npre + 1 + postSamples;

  // 窓の先頭がまだリングに残っているか。溢れていたら諦める（古い側から潰される）。
  if (dmaWritten - gFirst > DMA_RING_SIZE) { dropCount++; return; }

  // period_ns は要求値ではなく実際の分周後の値に近い整数で出す。
  // 83333Hz なら 12000ns。プロッタはこの値で時間軸を作る。
  const uint32_t periodNs = (uint32_t)((1000000000ULL + sampleFreqHz / 2) / sampleFreqHz);

  lineLen = 0;
  lbStr("WF,");   lbUInt(evtCount);
  lbChar(',');    lbUInt(millis() - startMs);
  lbStr(",U,");   lbUInt((uint32_t)npre);
  lbChar(',');    lbUInt((uint32_t)ntot);
  lbChar(',');    lbUInt(periodNs);

  int peak = -1, peakIdx = 0;
  for (int i = 0; i < ntot; i++) {
    uint16_t v = dmaRing[(size_t)(gFirst + (uint64_t)i) & DMA_RING_MASK];
    lbChar(',');
    lbUInt(v);
    if ((int)v > peak) { peak = v; peakIdx = i; }
  }
  lbFlush();

  lastPeakAdc = peak;
  lastPeakDt  = (int32_t)((int64_t)(peakIdx - npre) * (int64_t)periodNs / 100);  // 0.1us 単位
  evtCount++;
}

// ドライバから吸い出してリングへ積み、同時にトリガを探す。
void dmaService() {
  if (!adcHandle) return;

  if (dmaOverflowFlag) {
    dmaOverflowFlag = false;
    ovfCount++;
    // 連続性が切れたので、未確定イベントと再アーム状態を捨てる
    pendHead = pendTail = 0;
    dmaArmed = false;
  }

  // レート制限はサンプル間隔で見る。窓が重ならない最小間隔も同時に効かせる。
  uint64_t minGap = (uint64_t)postSamples + (uint64_t)preSamples + 8;
  if (maxRate > 0) {
    uint64_t rateGap = sampleFreqHz / maxRate;
    if (rateGap > minGap) minGap = rateGap;
  }

  // 1 回の loop で吸い出す上限。無制限にするとシリアル処理が飢える。
  for (int iter = 0; iter < 8; iter++) {
    uint32_t outLen = 0;
    esp_err_t err = adc_continuous_read(adcHandle, dmaReadBuf, DMA_READ_BYTES, &outLen, 0);
    if (err != ESP_OK || outLen == 0) break;

    for (uint32_t off = 0; off + SOC_ADC_DIGI_RESULT_BYTES <= outLen;
         off += SOC_ADC_DIGI_RESULT_BYTES) {
      adc_digi_output_data_t* p = (adc_digi_output_data_t*)&dmaReadBuf[off];
      // 1 チャンネルしか流していないが、ドライバが無効データを混ぜることがある
      if (p->type2.channel != (uint32_t)SIG_ADC_CHANNEL) continue;

      const uint16_t v = (uint16_t)p->type2.data;
      const uint64_t g = dmaWritten;
      dmaRing[g & DMA_RING_MASK] = v;
      dmaWritten = g + 1;

      if (!dmaArmed) {
        if ((int)v <= RESET_THRESHOLD) dmaArmed = true;
        continue;
      }
      if ((int)v <= SIGNAL_THRESHOLD) continue;

      dmaArmed = false;
      if (dmaHasLastTrig && (g - dmaLastTrigG) < minGap) { dropCount++; continue; }

      int next = (pendHead + 1) % PEND_SLOTS;
      if (next == pendTail) { dropCount++; continue; }
      pendTrigG[pendHead] = g;
      pendHead = next;
      dmaLastTrigG = g;
      dmaHasLastTrig = true;
    }
  }

  // 後続サンプルが揃ったものから確定して出す
  while (pendTail != pendHead) {
    uint64_t gTrig = pendTrigG[pendTail];
    if (dmaWritten < gTrig + (uint64_t)postSamples + 1) break;  // まだ届いていない
    pendTail = (pendTail + 1) % PEND_SLOTS;
    dmaEmit(gTrig);
  }
}

// ==========================================
//   POLL（analogRead ポーリング）
// ==========================================
// 本番スケッチの検出パスと同じ経路。DMA 波形と比べることで、
// ピークを逃す原因が回路側か MCU 側かを切り分ける。
//
// 時刻は CPU サイクルカウンタで取る。micros() の 1us 量子化より細かく
// （240MHz = 4.17ns）、かつサンプルごとの実測値なので、FreeRTOS の
// プリエンプトが入っても「その点だけ間隔が空く」だけで波形は壊れない。
// loopTask は core1 に固定されているのでコア間で CCOUNT が食い違うことは無い。
//
// 注意 2 点:
//  - トリガ前サンプルは下のリング長で頭打ちになる。SET_PRE:64 としても
//    POLL の行では npre は最大 15 になる（ヘッダの pre= とは食い違う）。
//    プロッタは行ごとの npre を見るので解析結果は正しい。
//  - トリガ検出のポーリング周期には loop() 側の処理も乗る。これは本番スケッチも
//    同じ条件なので「実機の見え方」としてはむしろ正しい。
//    analogRead 単体の純粋な所要時間が欲しいときは BENCH を見ること。
static constexpr int POLL_PRE_RING = 16;  // 2 のべき乗
struct PollSample { uint32_t cyc; uint16_t v; };
static PollSample pollPre[POLL_PRE_RING];
static int  pollPreIdx = 0;
static int  pollPreFilled = 0;
static PollSample pollPost[POST_MAX];
bool pollArmed = false;
uint32_t pollLastEmitMs = 0;

static inline int32_t cyclesToTenthsUs(uint32_t cyc) {
  // 0.1us 単位へ。3ms ぶん（240MHz で 72 万サイクル）でも int32 に収まる。
  return (int32_t)(((int64_t)(int32_t)cyc * 10) / (int64_t)cpuMhz);
}

void pollEmit(uint32_t cTrig, uint16_t vTrig, int npre, int npost) {
  const int ntot = npre + 1 + npost;

  lineLen = 0;
  lbStr("WF,");   lbUInt(evtCount);
  lbChar(',');    lbUInt(millis() - startMs);
  lbStr(",T,");   lbUInt((uint32_t)npre);
  lbChar(',');    lbUInt((uint32_t)ntot);
  lbStr(",0");

  int peak = -1;
  int32_t peakDt = 0;

  // トリガ前（リングの古い順）。dt は負になる。
  for (int k = npre; k >= 1; k--) {
    int idx = (pollPreIdx - 1 - k + 2 * POLL_PRE_RING) % POLL_PRE_RING;
    int32_t dt = cyclesToTenthsUs(pollPre[idx].cyc - cTrig);
    lbChar(','); lbInt(dt);
    lbChar(','); lbUInt(pollPre[idx].v);
  }
  // トリガ点（t=0）
  lbStr(",0,"); lbUInt(vTrig);
  if ((int)vTrig > peak) { peak = vTrig; peakDt = 0; }
  // トリガ後
  for (int i = 0; i < npost; i++) {
    int32_t dt = cyclesToTenthsUs(pollPost[i].cyc - cTrig);
    lbChar(','); lbInt(dt);
    lbChar(','); lbUInt(pollPost[i].v);
    if ((int)pollPost[i].v > peak) { peak = pollPost[i].v; peakDt = dt; }
  }
  lbFlush();

  lastPeakAdc = peak;
  lastPeakDt  = peakDt;
  evtCount++;
}

void pollService() {
  // 読みとリングへの push はレート制限中も必ず続ける。
  // ここで読むのをやめるとリングの中身が間引き期間ぶん古いままになり、
  // 再開直後のイベントに「20ms 前のトリガ前サンプル」が付いて時間軸が壊れる。
  const uint32_t c0 = esp_cpu_get_cycle_count();
  const uint16_t v  = (uint16_t)analogRead(SIG_IN_PIN);

  pollPre[pollPreIdx].cyc = c0;
  pollPre[pollPreIdx].v   = v;
  pollPreIdx = (pollPreIdx + 1) & (POLL_PRE_RING - 1);
  if (pollPreFilled < POLL_PRE_RING) pollPreFilled++;

  if (!pollArmed) {
    if ((int)v <= RESET_THRESHOLD) pollArmed = true;
    return;
  }
  if ((int)v <= SIGNAL_THRESHOLD) return;

  // ここまで来たら本物のトリガ。間引き対象なら、記録はしないが
  // 同じパルスの裾で多重トリガしないよう再アーム待ちには入る。
  if (maxRate > 0) {
    const uint32_t minMs = 1000 / maxRate;
    if (minMs > 0 && (millis() - pollLastEmitMs) < minMs) {
      pollArmed = false;
      dropCount++;
      return;
    }
  }
  pollArmed = false;

  // --- ディザ待ち ---
  // これが無いと毎イベント同じ位相でサンプルしてしまい、
  // サンプル間隔より細かい時間ビンが永久に埋まらない。
  uint32_t ditherCyc = 0;
  if (ditherTenthsUs > 0) {
    ditherCyc = (uint32_t)(((uint64_t)ditherTenthsUs * cpuMhz) / 10);
  } else if (adcReadNs > 0) {
    ditherCyc = (uint32_t)(((uint64_t)adcReadNs * cpuMhz) / 1000);
  }
  if (ditherCyc > 0) {
    const uint32_t wait = esp_random() % ditherCyc;
    const uint32_t t0 = esp_cpu_get_cycle_count();
    while ((uint32_t)(esp_cpu_get_cycle_count() - t0) < wait) { /* busy */ }
  }

  // --- 連射 ---
  const int npost = (postSamples > POST_MAX) ? POST_MAX : postSamples;
  for (int i = 0; i < npost; i++) {
    pollPost[i].cyc = esp_cpu_get_cycle_count();
    pollPost[i].v   = (uint16_t)analogRead(SIG_IN_PIN);
  }

  int npre = preSamples;
  if (npre > POLL_PRE_RING - 1) npre = POLL_PRE_RING - 1;
  if (npre > pollPreFilled - 1) npre = pollPreFilled - 1;
  if (npre < 0) npre = 0;

  pollEmit(c0, v, npre, npost);
  pollLastEmitMs = millis();

  // 再アーム: 信号が RESET を下回るまで待つ。飽和で戻らない場合に備えて上限つき。
  const uint32_t tw = micros();
  while (analogRead(SIG_IN_PIN) > RESET_THRESHOLD) {
    if (micros() - tw > 5000) break;
  }
  pollArmed = true;
}

// ==========================================
//   BENCH
// ==========================================
// analogRead が実際に何 ns かかるのかを測る。
// 本番スケッチの PEAK_WINDOW_US(120us) / PEAK_SAMPLES(8) が妥当かどうかは
// この数字が無いと判断できない。プロッタ側の POLL シミュレーションの入力にもなる。
void benchOne(const char* name, int kind, uint32_t n) {
  uint32_t mn = 0xFFFFFFFFu, mx = 0;
  double sum = 0.0, sumSq = 0.0;

  for (uint32_t i = 0; i < n; i++) {
    uint32_t c0 = esp_cpu_get_cycle_count();
    switch (kind) {
      case 0: (void)analogRead(SIG_IN_PIN); break;
      case 1: (void)analogReadMilliVolts(SIG_IN_PIN); break;
      default: break;  // ループ自体の overhead
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
           (unsigned long)(mn * toNs),
           (unsigned long)(meanCyc * toNs),
           (unsigned long)(mx * toNs),
           (unsigned long)(sdCyc * toNs));
  Serial.println(buf);

  if (kind == 0) adcReadNs = (uint32_t)(meanCyc * toNs);
}

void runBench() {
  const bool wasRunning = running;
  const bool wasDma = (adcHandle != nullptr);
  running = false;
  // 連続モードが ADC1 のロックを握っている間は analogRead が通らない
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
// 本番スケッチと同じ「最大値 + マージン」方式。
// 12bit ではベースライン変動も 4 倍のカウントで見えるため、最小値基準だと自走する。
void calibrateThreshold(int samples, int margin) {
  const bool wasDma = (adcHandle != nullptr);
  if (wasDma) dmaStop();

  int minValue = ADC_MAX, maxValue = 0;
  double sum = 0.0, sumSq = 0.0;
  for (int i = 0; i < samples; i++) {
    int v = analogRead(SIG_IN_PIN);
    if (v < minValue) minValue = v;
    if (v > maxValue) maxValue = v;
    sum   += v;
    sumSq += (double)v * v;
    delay(2);
  }
  const float mean = (float)(sum / samples);
  const float var  = (float)(sumSq / samples) - mean * mean;
  const float sd   = (var > 0.0f) ? sqrtf(var) : 0.0f;

  baselineAdc = (int)(mean + 0.5f);
  SIGNAL_THRESHOLD = constrain(maxValue + margin, 0, ADC_MAX);
  RESET_THRESHOLD  = constrain(SIGNAL_THRESHOLD - resetGap, 0, ADC_MAX);

  char buf[144];
  snprintf(buf, sizeof(buf),
           "### Calib: min=%d max=%d mean=%.1f sd=%.1f margin=%d -> sig=%d rst=%d",
           minValue, maxValue, mean, sd, margin, SIGNAL_THRESHOLD, RESET_THRESHOLD);
  Serial.println(buf);

  if (wasDma) dmaStart();
}

// ==========================================
//   応答出力
// ==========================================
void printHeader() {
  const uint32_t periodNs = (acqMode == ACQ_DMA)
                              ? (uint32_t)((1000000000ULL + sampleFreqHz / 2) / sampleFreqHz)
                              : 0;
  char buf[256];
  snprintf(buf, sizeof(buf),
           "#WF ver=1 mode=%s period_ns=%lu fs_hz=%lu pre=%d post=%d "
           "thr=%d rst=%d base=%d bits=%d atten=12db adc_read_ns=%lu "
           "maxrate=%lu cpu_mhz=%lu board=%s",
           acqMode == ACQ_DMA ? "DMA" : "POLL",
           (unsigned long)periodNs, (unsigned long)sampleFreqHz,
           preSamples, postSamples,
           SIGNAL_THRESHOLD, RESET_THRESHOLD, baselineAdc, ADC_BITS,
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

  char buf[128];
  snprintf(buf, sizeof(buf), "#WFSTAT evt=%lu rate=%.1f ovf=%lu drop=%lu up_s=%lu run=%d",
           (unsigned long)evtCount, rate, (unsigned long)ovfCount,
           (unsigned long)dropCount, (unsigned long)up, running ? 1 : 0);
  Serial.println(buf);
}

// ==========================================
//   モード切替
// ==========================================
// DMA 連続モードは ADC1 を占有するので、POLL へ行く前に必ず止める。
// 逆に DMA へ入るときは analogRead を使っている最中でないことを保証する。
void applyMode(AcqMode m) {
  acqMode = m;
  if (m == ACQ_DMA) {
    if (!dmaStart()) {
      Serial.println("### ERROR: adc_continuous init failed, falling back to POLL");
      acqMode = ACQ_POLL;
    }
  } else {
    dmaStop();
    pollArmed = false;
    pollPreFilled = 0;
    pollPreIdx = 0;
  }
  Serial.println(acqMode == ACQ_DMA ? "MODE:DMA" : "MODE:POLL");
}

void resetCounters() {
  evtCount = 0;
  ovfCount = 0;
  dropCount = 0;
  startMs = millis();
  lastStatMs = millis();
  lastStatEvt = 0;
  lastPeakAdc = 0;
  lastPeakDt = 0;
  pendHead = pendTail = 0;
  dmaArmed = false;
  dmaHasLastTrig = false;
  pollArmed = false;
}

// ==========================================
//   コマンド
// ==========================================
void executeCommand(const char* cmd) {
  if (strcmp(cmd, "START") == 0) {
    resetCounters();
    running = true;
    printHeader();
    Serial.println("RUN:1");

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

  } else if (strncmp(cmd, "SET_MODE:", 9) == 0) {
    if (strcmp(cmd + 9, "DMA") == 0)       applyMode(ACQ_DMA);
    else if (strcmp(cmd + 9, "POLL") == 0) applyMode(ACQ_POLL);
    else Serial.println(acqMode == ACQ_DMA ? "MODE:DMA" : "MODE:POLL");

  } else if (strcmp(cmd, "GET_MODE") == 0) {
    Serial.println(acqMode == ACQ_DMA ? "MODE:DMA" : "MODE:POLL");

  } else if (strncmp(cmd, "SET_THRESH:", 11) == 0) {
    int sig = 0, rst = 0;
    int n = sscanf(cmd + 11, "%d,%d", &sig, &rst);
    if (n == 2 && sig > rst && rst >= 0 && sig <= ADC_MAX) {
      SIGNAL_THRESHOLD = sig;
      RESET_THRESHOLD  = rst;
      resetGap = sig - rst;
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
    if (preSamples + 1 + postSamples > WF_MAX_SAMPLES) {
      postSamples = WF_MAX_SAMPLES - 1 - preSamples;
    }
    printHeader();

  } else if (strncmp(cmd, "SET_POST:", 9) == 0) {
    postSamples = constrain(atoi(cmd + 9), 1, POST_MAX);
    if (preSamples + 1 + postSamples > WF_MAX_SAMPLES) {
      preSamples = WF_MAX_SAMPLES - 1 - postSamples;
    }
    printHeader();

  } else if (strncmp(cmd, "SET_FS:", 7) == 0) {
    uint32_t f = (uint32_t)atol(cmd + 7);
    if (f >= FS_MIN && f <= FS_MAX) {
      sampleFreqHz = f;
      if (acqMode == ACQ_DMA) { dmaStop(); dmaStart(); }
    }
    printHeader();

  } else if (strncmp(cmd, "SET_MAXRATE:", 12) == 0) {
    long r = atol(cmd + 12);
    maxRate = (r < 0) ? 0 : (uint32_t)r;
    printHeader();

  } else if (strncmp(cmd, "SET_DITHER:", 11) == 0) {
    long d = atol(cmd + 11);
    ditherTenthsUs = (d < 0) ? 0 : (uint32_t)d;
    printHeader();

  } else if (strncmp(cmd, "SET_OLED:", 9) == 0) {
    if (strcmp(cmd + 9, "ON") == 0) {
      oledEnabled = true;
    } else if (strcmp(cmd + 9, "OFF") == 0) {
      oledEnabled = false;
      if (oledReady) { display.clearDisplay(); display.display(); }
    }
    Serial.println(oledEnabled ? "OLED:ON" : "OLED:OFF");

  } else if (strcmp(cmd, "GET_BOARD") == 0) {
    char buf[48];
    snprintf(buf, sizeof(buf), "BOARD:ESP32S3-WAVE,%d", ADC_BITS);
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
  display.print(F("WAVE probe  "));
  display.println(acqMode == ACQ_DMA ? F("DMA") : F("POLL"));

  display.print(F("Evt:"));
  display.print(evtCount);
  display.print(F(" "));
  display.print(rate, 1);
  display.println(F("/s"));

  display.print(F("Thr:"));
  display.print(SIGNAL_THRESHOLD);
  display.print(F(" Bs:"));
  display.println(baselineAdc);

  // 直近イベントのピーク値とその時刻。PC を繋がなくても
  // 「ピークがトリガから何 us 後に来ているか」がここで即分かる。
  display.print(F("Pk:"));
  display.print(lastPeakAdc);
  display.print(F(" @"));
  display.print(lastPeakDt / 10);
  display.println(F("us"));

  display.print(F("ovf:"));
  display.print(ovfCount);
  display.print(F(" drp:"));
  display.print(dropCount);
  display.println();

  display.println(running ? F("RUNNING") : F("stopped"));
  display.display();
}

// ==========================================
//   setup
// ==========================================
void setup() {
  analogReadResolution(ADC_BITS);
  // ピン単位ではなく全体の減衰を設定する。DMA へ渡してから analogRead に戻ると
  // コアが oneshot ユニットを作り直すが、そのとき使われるのはグローバル値
  // (__analogAttenuation) であってピン単位の設定ではないため、
  // analogSetPinAttenuation だと往復のたびに設定が失われる。
  // ADC_11db は連続モードの ADC_ATTEN_DB_12 と同じ設定（IDF 5.x で改名されただけ）。
  analogSetAttenuation(ADC_11db);

  Serial.begin(115200);
  // 本番スケッチは 0（非ブロッキング）にしているが、こちらは 1 行が長く
  // 途中で切れると行が壊れるため、有限の待ちを許す。
  // ホストが読んでいないときは 50ms でタイムアウトして先へ進む。
#if ARDUINO_USB_CDC_ON_BOOT
  Serial.setTxTimeoutMs(50);
#endif

  unsigned long t0 = millis();
  while (!Serial && (millis() - t0 < 1500)) { delay(10); }
  delay(200);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  cpuMhz = getCpuFrequencyMhz();

  Wire.begin(I2C_SDA, I2C_SCL);
  if (display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    oledReady = true;
    display.setRotation(2);
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.clearDisplay();
    display.setCursor(0, 0);
    display.println(F("Accel Kitchen"));
    display.println(F("V1 pulse probe"));
    display.display();
  }

  const char* bar = "##########################################################";
  Serial.println();
  Serial.println(bar);
  Serial.println("### Accel Kitchen - V1 board pulse-shape probe");
  Serial.println("### 波形取得専用。計数はしません。");
  char buf[160];
  snprintf(buf, sizeof(buf), "### Build: board=%s cdc_on_boot=%d cpu=%luMHz core=%d.%d.%d",
           BOARD_NAME_STR, (int)ARDUINO_USB_CDC_ON_BOOT, (unsigned long)cpuMhz,
           ESP_ARDUINO_VERSION_MAJOR, ESP_ARDUINO_VERSION_MINOR, ESP_ARDUINO_VERSION_PATCH);
  Serial.println(buf);
  snprintf(buf, sizeof(buf), "### Pins[%s]: SIG=%d(ADC1_CH%d) TEMP=%d LED=%d SDA=%d SCL=%d",
           PIN_MODE_NAME, RESOLVED_GPIO(SIG_IN_PIN), (int)SIG_ADC_CHANNEL,
           RESOLVED_GPIO(TEMP_PIN), RESOLVED_GPIO(LED_PIN),
           RESOLVED_GPIO(I2C_SDA), RESOLVED_GPIO(I2C_SCL));
  Serial.println(buf);
  Serial.println(oledReady ? "### OLED: init OK (0x3C)" : "### OLED: init FAILED");

  // BENCH を先に通しておくと adc_read_ns が埋まり、
  // POLL のディザ幅とヘッダの値が最初から正しくなる。
  runBench();

  Serial.println("### Auto-calibrating threshold...");
  calibrateThreshold(200, autoMargin);

  applyMode(ACQ_DMA);

  Serial.println("### Commands: START STOP RESET GET_CFG BENCH");
  Serial.println("###   SET_MODE:DMA|POLL  SET_THRESH:<s>[,<r>]  AUTO_THRESH[:<margin>]");
  Serial.println("###   SET_PRE:<n> SET_POST:<n> SET_FS:<hz> SET_MAXRATE:<ev/s>");
  Serial.println("###   SET_DITHER:<0.1us> SET_OLED:ON|OFF");
  Serial.println("### Line: WF,<evt>,<t_ms>,U|T,<npre>,<ntot>,<period_ns>,<samples...>");
  Serial.println("###   U: 等間隔。値のみ並ぶ。t_i=(i-npre)*period_ns");
  Serial.println("###   T: 各点 <dt[0.1us]>,<adc> の対。dt はトリガ点基準の符号付き");
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

  if (running) {
    if (acqMode == ACQ_DMA) {
      dmaService();
    } else {
      pollService();
    }
  }

  // LED は RUNNING の常時点灯のみ。しかも状態が変わったときだけ書く。
  // 毎周回 digitalWrite すると POLL のポーリング周期にその時間が乗ってしまい、
  // 「analogRead が何 us か」というまさに測りたい量が歪む。
  static int ledState = -1;
  const int want = running ? HIGH : LOW;
  if (ledState != want) {
    digitalWrite(LED_PIN, want);
    ledState = want;
  }

  const unsigned long now = millis();
  if (now - lastOledMs >= 1000) {
    lastOledMs = now;
    updateDisplay();
    printStat();
  }
}
