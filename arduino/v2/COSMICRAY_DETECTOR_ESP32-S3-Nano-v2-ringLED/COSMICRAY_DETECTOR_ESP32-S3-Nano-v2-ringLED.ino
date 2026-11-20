/*
  Accel Kitchen Cosmic Detector - NeoPixel ring version (v2 board)

  Target board : Arduino Nano ESP32 (ESP32-S3)   ※ ESP32S3 Dev Module + USB CDC On Boot でも可
  Target circuit: cosmic-ray-detector-v2 (cosmic-ray-detector.kicad_sch)
  Extra part    : WS2812 5050 16 連 LED リング (16x WS2812 RGB ring)

  宇宙線が 1 個来るたびにリング全体が約 0.16 秒かけてふわっと最大の明るさまで立ち上がり、
  波高 (= ADC 値) で色が変わる。光は約 1.8 秒かけて、ふわーっと消えていく。
  待機中は暗い白点が 1 つ周回して「動いている」ことを示す。

    小さい波高  青 → 水色 → 緑 → 黄 → 橙 → 赤  大きい波高   (対数マッピング)

  ==== 配線 (基板の J4 = JST XH 6 ピンを使う) ====
    J4-1  GND   ─ リングの GND
    J4-2  5V    ─ リングの 5V (PWR / VCC)
    J4-4  CS1   ─ 330Ω ─ リングの DIN (GPIO21 / D10)
    J4-3,5,6 (SCLK / MOSI / MISO) は microSD と共有なので何も繋がない
    リングの 5V-GND 間に 100µF 以上の電解コンデンサをリングのすぐ近くへ。
    本体の GPS 用に GPIO21 を使っているファームでは同時に使えない (どちらか一方)。

  ==== OHASHI Console (ブラウザのコンソール) との接続 ====
    USB シリアルで、本体ファーム (COSMICRAY_DETECTOR_ESP32-S3-Nano-v2) と同じ行・同じコマンドを話す。
      イベント 1 行 = 13 項目:
        count time_us adc deadtime_us temp hum press dig1 dig2 dig3 ana1 ana2 ana3
      この基板にはセンサ類が無いので temp/hum/press は nan、dig/ana は 0。
      time_us は起動 (較正完了) / RESET からの時間、deadtime_us は累積 (減らない)。
      deadtime には、イベントの処理時間・リングの書き出し時間・コマンドの実行時間をすべて含める。
      (これを入れないと、リングが光っている間にコンソールの計数率が低く出る。)
    応えるコマンド:
      GET_THRESH / SET_THRESH:n / GET_PWM / SET_PWM:n / AUTO_PWM[:n]
      AUTO_THRESH[:margin] / GET_AUTO_MARGIN / SET_AUTO_MARGIN:n / RESET
      GET_MODE (常に DIGITAL) / GET_BLENAME / SET_BLENAME:name / GET_BTADDR
      GET_SD / EXT / OLED / BUZZER / VIB / GPS  → いずれも OFF (この版には無い)
      GET_SCOPE → OFF。SET_SCOPE:ON は断る (オシロは本体ファームだけ)。
    本体ファームと違う点 (できないこと):
      Bluetooth / microSD / OLED / BME280 / ブザー / 振動 / GPS / オシロ は無い。
      トリガは DIGITAL (コンパレータ割込) 固定。SET_MODE は無視して MODE:DIGITAL を返す。
      Preferences の名前空間 "cosmic" の pwm_duty / auto_margin / ble_name だけを読み書きする
      (本体ファームと同じ値を共有。それ以外の項目は触らない)。

  ==== 動作 ====
    起動時にしきい値を較正する。保存済みのコンパレータ duty (pwm_duty) があればそれを使い、
    無ければ自動較正 (約 8 秒、較正中はリングに進捗が出る)。波高しきい値は毎回測る。
    検出ロジックは本体ファームの DIGITAL トリガと同じ:
      D0 の立ち上がりで割込 → A0 (ピークホールド) を読む → しきい値未満ならノイズとして捨てる
      → D8 でピークホールドを放電。

  Library requirements:
    1. Adafruit NeoPixel
    2. ESP32 Arduino Core 3.x
*/

#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <Preferences.h>
#include <math.h>
#include "esp_timer.h"
#include "esp_mac.h"

// ==========================================
//   設定
// ==========================================
// --- v2 基板のピン (本体ファームと同じ) ---
const int SELF_SIG_IN  = 1;    // A0  ピークホールド出力 (ADC)
const int TRIGGER_IN   = 44;   // D0  コンパレータ出力 (割込)
const int PWM_THRESH   = 5;    // D2  コンパレータしきい値 (PWM)
const int TRIG_RESET   = 17;   // D8  ピークホールド放電パルス
const int LED_PIN      = 6;    // D3  基板の検出表示 LED
const int BUZZER_PIN   = 43;   // D1  (使わないが LOW に固定)
const int COIN_OUT_PIN = 10;   // D7  (使わないが LOW に固定)

// --- リング ---
const int RING_PIN     = 21;   // D10 / GPIO21 / J4-4 (CS1)
const int RING_COUNT   = 16;
// 全体の明るさ 0-255 (= 発生の瞬間の「最大」)。16 個を一斉に光らせるので、白でも
// 約 60mA×16×(48/255) ≈ 180mA 程度。上げるほど電流変化の電源ノイズが SiPM アンプに乗りやすい。
const uint8_t RING_BRIGHTNESS = 48;
const bool    RING_HEARTBEAT  = true;     // 待機中の周回点
// 立ち上がり: 発生した瞬間にいきなり最大にせず、ATTACK_S 秒かけて滑らかに (smoothstep) 明るくする。
// 0 にすると即最大。0.10〜0.25 くらいが「ふわっ」。
const float   ATTACK_S        = 0.16f;
// 減衰: 指数減衰 (時定数)。明るさは level^2 で描くので、見た目の時定数は約 FADE_TAU_S / 2。
// 消えるまでは約 2 × FADE_TAU_S 秒 (0.9 で約 1.8 秒)。長くすると余韻が増える。
const float   FADE_TAU_S      = 0.9f;
const uint32_t FRAME_MS       = 20;       // アニメーション更新間隔 (滑らかさ。短いほど滑らか)
// これ以下の level は消す。brightness を絞ると 8bit の段差が見えるので、段差が目立つ前に切る。
const float   LEVEL_CUTOFF    = 0.12f;

// --- 検出 ---
static constexpr int      ADC_BITS = 12;
static constexpr int      ADC_MAX  = (1 << ADC_BITS) - 1;
static constexpr int      PWM_BITS = 8;
static constexpr int      PWM_MAX  = (1 << PWM_BITS) - 1;
static constexpr uint32_t PWM_FREQ_HZ = 40000;
static constexpr int      PWM_DUTY_DEFAULT = 96;       // 較正が使えなかったときの値
static constexpr unsigned TRIG_RESET_PULSE_US = 20;
static constexpr unsigned ADC_SAMPLE_DELAY_US = 5;
static constexpr unsigned long LED_BLINK_MS = 20;
static constexpr int      AUTO_MARGIN_DEFAULT = 50;    // ベースライン最大値 + これ = 波高しきい値

// 自動較正 (本体ファームの autoPwm と同じ)
static constexpr uint32_t AUTO_PWM_TARGET_DEFAULT = 50;  // [edges/s] これ以下なら「静か」
static constexpr int      AUTO_PWM_STEP       = 8;
static constexpr uint32_t AUTO_PWM_SETTLE_MS  = 80;
static constexpr uint32_t AUTO_PWM_WINDOW_MS  = 120;
static constexpr int      AUTO_PWM_MARGIN_STEPS = 2;
static constexpr uint32_t AUTO_PWM_NOISE_FLOOR = 500;  // [/s] 未満ならノイズ山が見えていない

// コンソールに見せる値 (この版に無い機能の、本体ファームの既定値)
static constexpr size_t   BLE_NAME_MAX = 24;
static constexpr size_t   CMD_BUF_SIZE = 48;           // 本体ファームと同じ (47 文字 + NUL)

// コマンド行の組み立て用。Arduino が自動で作る関数宣言より前に型が要るので、ここに置く。
struct CmdLine {
  char   buf[CMD_BUF_SIZE];
  size_t len;
  bool   overflow;
};
enum CmdFeedResult : uint8_t { CMD_NONE, CMD_READY, CMD_TOO_LONG };

// ==========================================
//   状態
// ==========================================
Adafruit_NeoPixel ring(RING_COUNT, RING_PIN, NEO_GRB + NEO_KHZ800);
Preferences prefs;

volatile bool     triggerFlag   = false;
volatile uint32_t compEdgeCount = 0;

int           pwmDuty         = PWM_DUTY_DEFAULT;
int           signalThreshold = 120;
int           autoMargin      = AUTO_MARGIN_DEFAULT;
char          bleName[BLE_NAME_MAX + 1] = "CosmicRay";
unsigned long eventCount      = 0;
unsigned long ledOffMs        = 0;

// コンソールが見る時計。time_us = nowUs() - startTimeUs。deadtime は累積で減らない。
uint64_t startTimeUs   = 0;
uint64_t totalDeadUs   = 0;

// リングの残像: level = 明るさ (立ち上がりで 1 へ、その後指数的に減衰)、hue = 発生時の色相
// attackT = 立ち上がり経過秒 (ATTACK_S に達したら減衰へ)、level0 = 立ち上がり開始時の明るさ
float    level[RING_COUNT];
float    level0[RING_COUNT];
float    attackT[RING_COUNT];
uint16_t hue[RING_COUNT];
bool     animActive = false;
int      lastHeartbeatPos = -1;
unsigned long lastFrameMs = 0;

void IRAM_ATTR onTriggerISR() {
  triggerFlag = true;
  compEdgeCount++;
}

static inline uint64_t nowUs() { return (uint64_t)esp_timer_get_time(); }

// ==========================================
//   ピークホールド / リング
// ==========================================
inline void holdReset() {
  digitalWrite(TRIG_RESET, HIGH);
  delayMicroseconds(TRIG_RESET_PULSE_US);
  digitalWrite(TRIG_RESET, LOW);
}

// リングを書き出す。書き出し中 (約 0.5 ms) と LED の電流変化はアンプ側へノイズとして
// 乗りうるので、終わったら (イベント待ちでなければ) ピークホールドを放電して捨てる。
// その間は計数できないので、かかった時間は全部デッドタイムに入れる。
void ringShow() {
  const uint64_t t0 = nowUs();
  ring.show();
  if (!triggerFlag) holdReset();
  totalDeadUs += nowUs() - t0;
}

// 波高 → 色相。x = 0 (しきい値) が青 (43690)、x = 1 (ADC 最大) が赤 (0)。
uint16_t hueFromX(float x) {
  if (x < 0.0f) x = 0.0f;
  if (x > 1.0f) x = 1.0f;
  return (uint16_t)((1.0f - x) * 43690.0f);
}

void ringHit(int adc) {
  const int thr = (signalThreshold > 1) ? signalThreshold : 1;
  float x = 0.0f;
  if (adc > thr && ADC_MAX > thr) {
    x = (logf((float)adc) - logf((float)thr)) / (logf((float)ADC_MAX) - logf((float)thr));
  }
  const uint16_t h = hueFromX(x);

  // 全 LED を一斉に点灯。ringService() が ATTACK_S かけて最大まで滑らかに上げ、そこから減衰させる。
  // 連発したら今の明るさから新しい色で立ち上げ直す (いきなり暗転・飛びはしない)。
  for (int i = 0; i < RING_COUNT; i++) {
    level0[i]  = level[i];
    attackT[i] = 0.0f;
    if (ATTACK_S <= 0.0f) { level[i] = 1.0f; attackT[i] = 1e9f; }
    hue[i]     = h;
  }
  animActive = true;
  lastFrameMs = 0;   // すぐ描く
}

void ringRender(bool withHeartbeat) {
  const int hb = (RING_HEARTBEAT && withHeartbeat) ? (int)((millis() / 250UL) % RING_COUNT) : -1;
  for (int i = 0; i < RING_COUNT; i++) {
    if (level[i] > 0.0f) {
      // 明るさは 2 乗で知覚に合わせる。gamma32 は暗い側を早く切って余韻が消えるので使わない。
      const uint8_t v = (uint8_t)(level[i] * level[i] * 255.0f + 0.5f);
      ring.setPixelColor(i, ring.ColorHSV(hue[i], 255, v));
    } else if (i == hb) {
      ring.setPixelColor(i, ring.Color(5, 5, 5));
    } else {
      ring.setPixelColor(i, 0);
    }
  }
  ringShow();
}

// アニメーションを 1 コマ進める。変化がないコマは書き出さない (ノイズと不感時間を減らす)。
void ringService(unsigned long now) {
  if (lastFrameMs != 0 && now - lastFrameMs < FRAME_MS) return;
  const float dt = (lastFrameMs == 0) ? (FRAME_MS / 1000.0f) : (now - lastFrameMs) / 1000.0f;
  lastFrameMs = now ? now : 1;

  bool any = false;
  const float k = expf(-dt / FADE_TAU_S);
  for (int i = 0; i < RING_COUNT; i++) {
    if (attackT[i] < ATTACK_S) {
      // 立ち上がり: smoothstep (最初と最後が緩やか) で level0 → 1
      attackT[i] += dt;
      float t = attackT[i] / ATTACK_S;
      if (t > 1.0f) t = 1.0f;
      const float s = t * t * (3.0f - 2.0f * t);
      level[i] = level0[i] + (1.0f - level0[i]) * s;
      any = true;
    } else if (level[i] > 0.0f) {
      level[i] *= k;
      if (level[i] > LEVEL_CUTOFF) any = true; else level[i] = 0.0f;
    }
  }

  const int hb = (RING_HEARTBEAT && !any) ? (int)((now / 250UL) % RING_COUNT) : -1;
  if (any || animActive || hb != lastHeartbeatPos) {
    ringRender(!any);
    lastHeartbeatPos = hb;
    animActive = any;
  }
}

// 較正中の進捗表示 (n / total 個点灯)。測定窓の外 (settle の前) でだけ呼ぶ。
void ringProgress(int n, int total) {
  const int lit = (int)((long)n * RING_COUNT / total);
  for (int i = 0; i < RING_COUNT; i++) {
    ring.setPixelColor(i, i < lit ? ring.Color(0, 0, 255) : ring.Color(0, 0, 3));
  }
  ring.show();
}

void ringFill(uint32_t c) {
  for (int i = 0; i < RING_COUNT; i++) ring.setPixelColor(i, c);
  ring.show();
}

// コマンドで較正したあと、リングを待機表示に戻す (進捗表示が残らないように)。
void ringResume() {
  for (int i = 0; i < RING_COUNT; i++) { level[i] = 0.0f; level0[i] = 0.0f; attackT[i] = 1e9f; }
  animActive = true;
  lastHeartbeatPos = -1;
  lastFrameMs = 0;
}

// ==========================================
//   出力 (本体ファームの dualPrintln に当たる。USB だけ)
// ==========================================
static void say(const char* s) { Serial.println(s); }

void printThresholds() {
  char b[48];
  snprintf(b, sizeof(b), "THRESH:%d DUTY:%d", signalThreshold, pwmDuty);
  say(b);
}
void printPwm() {
  char b[24];
  snprintf(b, sizeof(b), "PWM:%d", pwmDuty);
  say(b);
}
void printAutoMargin() {
  char b[32];
  snprintf(b, sizeof(b), "AUTO_MARGIN:%d", autoMargin);
  say(b);
}
void printBleName() {
  char b[48];
  snprintf(b, sizeof(b), "BLENAME:%s", bleName);
  say(b);
}
// 基板固有の Bluetooth アドレス。本体ファームの BLEDevice::getAddress() と同じ値になるはず
// (どちらもチップの BT 用 MAC)。コンソールが「どの基板か」を見分けるのに使う。
void printBtAddr() {
  uint8_t mac[6] = {0};
  esp_read_mac(mac, ESP_MAC_BT);
  char b[40];
  snprintf(b, sizeof(b), "BTADDR:%02x:%02x:%02x:%02x:%02x:%02x",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  say(b);
}

// ==========================================
//   Preferences (本体ファームと同じ名前空間。必要な 3 項目だけ)
// ==========================================
void loadSettings(bool* hasPwm) {
  prefs.begin("cosmic", true);
  *hasPwm = prefs.isKey("pwm_duty");
  pwmDuty = prefs.getInt("pwm_duty", PWM_DUTY_DEFAULT);
  if (pwmDuty < 0) pwmDuty = 0;
  if (pwmDuty > PWM_MAX) pwmDuty = PWM_MAX;
  autoMargin = prefs.getInt("auto_margin", AUTO_MARGIN_DEFAULT);
  if (autoMargin < 0) autoMargin = 0;
  if (autoMargin > ADC_MAX) autoMargin = ADC_MAX;
  String n = prefs.getString("ble_name", "CosmicRay");
  strncpy(bleName, n.c_str(), BLE_NAME_MAX);
  bleName[BLE_NAME_MAX] = '\0';
  if (bleName[0] == '\0') strncpy(bleName, "CosmicRay", BLE_NAME_MAX);
  prefs.end();
}
void savePwm()        { prefs.begin("cosmic", false); prefs.putInt("pwm_duty", pwmDuty);        prefs.end(); }
void saveAutoMargin() { prefs.begin("cosmic", false); prefs.putInt("auto_margin", autoMargin);  prefs.end(); }
void saveBleName()    { prefs.begin("cosmic", false); prefs.putString("ble_name", bleName);     prefs.end(); }

// ==========================================
//   しきい値の較正 (本体ファームと同じ手順・同じ出力)
// ==========================================
uint32_t measureCompRate(uint32_t windowMs) {
  const uint32_t e0 = compEdgeCount;
  delay(windowMs);
  const uint32_t e1 = compEdgeCount;
  return (uint32_t)(((uint64_t)(e1 - e0) * 1000ULL) / windowMs);
}

void autoPwm(uint32_t targetRate) {
  int      dutyArr[40];
  uint32_t rateArr[40];
  int      n = 0;
  uint32_t peakRate = 0;
  int      peakIdx  = 0;
  const int totalSteps = PWM_MAX / AUTO_PWM_STEP + 1;

  say("### AUTO_PWM sweep: duty,comp_rate[/s]");
  for (int d = 0; d <= PWM_MAX && n < 40; d += AUTO_PWM_STEP) {
    ringProgress(n, totalSteps);                 // 表示は測定窓の外で
    pwmDuty = d;
    analogWrite(PWM_THRESH, d);
    delay(AUTO_PWM_SETTLE_MS);
    const uint32_t rate = measureCompRate(AUTO_PWM_WINDOW_MS);
    dutyArr[n] = d;
    rateArr[n] = rate;
    if (rate > peakRate) { peakRate = rate; peakIdx = n; }
    char b[48];
    snprintf(b, sizeof(b), "### %3d,%lu", d, (unsigned long)rate);
    say(b);
    n++;
  }

  int chosen = -1;
  if (peakRate < AUTO_PWM_NOISE_FLOOR) {
    say("### AUTO_PWM: no noise ridge (comparator never chattered). "
        "check D2->comparator path or input; using default duty.");
    chosen = (PWM_DUTY_DEFAULT <= PWM_MAX) ? PWM_DUTY_DEFAULT : PWM_MAX;
  } else {
    for (int i = peakIdx; i < n; i++) {
      if (rateArr[i] <= targetRate) { chosen = dutyArr[i]; break; }
    }
    if (chosen < 0) {
      chosen = PWM_MAX;
      say("### AUTO_PWM: never dropped below target; using PWM_MAX.");
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
  say(b);
  triggerFlag = false;   // 掃引で溜まった割込フラグは捨てる
}

// A0 のベースラインを測って波高しきい値にする。
void calibrateSignalThreshold(int samples, int margin) {
  holdReset();
  delay(5);
  int minValue = ADC_MAX;
  int maxValue = 0;
  for (int i = 0; i < samples; i++) {
    const int v = analogRead(SELF_SIG_IN);
    if (v < minValue) minValue = v;
    if (v > maxValue) maxValue = v;
    delay(10);
  }
  signalThreshold = maxValue + margin;
  if (signalThreshold < 0) signalThreshold = 0;
  if (signalThreshold > ADC_MAX) signalThreshold = ADC_MAX;
  char b[96];
  snprintf(b, sizeof(b), "### Auto-threshold calib: min=%d max=%d margin=%d -> thr=%d",
           minValue, maxValue, margin, signalThreshold);
  say(b);
}

// ==========================================
//   コマンド (OHASHI Console / 本体ファームと同じ綴り・同じ応答)
// ==========================================
// 1 文字ずつ渡し、改行で行が確定したら CMD_READY。長すぎた行は丸ごと捨てる。
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

// この版には無い機能。GET / SET どちらにも OFF を返す (コンソールの表示が OFF になる)。
struct Absent { const char* name; const char* why; };
static const Absent ABSENT[] = {
  { "SD",     "no microSD logging on the ring firmware" },
  { "EXT",    "no external-board inputs on the ring firmware" },
  { "OLED",   "no OLED on the ring firmware" },
  { "BUZZER", "no buzzer on the ring firmware" },
  { "VIB",    "no vibration motor on the ring firmware" },
  { "GPS",    "GPIO21 drives the LED ring, so GPS is not available" },
};

static bool handleAbsent(const char* cmd) {
  for (const Absent& a : ABSENT) {
    const size_t n = strlen(a.name);
    const bool isGet = strncmp(cmd, "GET_", 4) == 0 && strncmp(cmd + 4, a.name, n) == 0 && cmd[4 + n] == '\0';
    const bool isSet = strncmp(cmd, "SET_", 4) == 0 && strncmp(cmd + 4, a.name, n) == 0 && cmd[4 + n] == ':';
    if (!isGet && !isSet) continue;
    if (isSet && strcmp(cmd + 4 + n + 1, "ON") == 0) {
      char b[96];
      snprintf(b, sizeof(b), "### %s: %s.", a.name, a.why);
      say(b);
    }
    char b[24];
    snprintf(b, sizeof(b), "%s:OFF", a.name);
    say(b);
    return true;
  }
  return false;
}

void executeCommand(const char* cmd) {
  if (strncmp(cmd, "SET_THRESH:", 11) == 0) {
    int sig;
    if (sscanf(cmd + 11, "%d", &sig) == 1 && sig >= 0 && sig <= ADC_MAX) signalThreshold = sig;
    printThresholds();
  } else if (strcmp(cmd, "GET_THRESH") == 0) {
    printThresholds();
  } else if (strncmp(cmd, "SET_PWM:", 8) == 0) {
    int d;
    if (sscanf(cmd + 8, "%d", &d) == 1) {
      if (d < 0) d = 0;
      if (d > PWM_MAX) d = PWM_MAX;
      pwmDuty = d;
      analogWrite(PWM_THRESH, pwmDuty);
      savePwm();
    }
    printPwm();
  } else if (strcmp(cmd, "GET_PWM") == 0) {
    printPwm();
  } else if (strncmp(cmd, "AUTO_PWM", 8) == 0 && (cmd[8] == '\0' || cmd[8] == ':')) {
    uint32_t target = AUTO_PWM_TARGET_DEFAULT;
    if (cmd[8] == ':') { long t = atol(cmd + 9); if (t >= 0) target = (uint32_t)t; }
    autoPwm(target);
    savePwm();
    ringResume();
    printPwm();
  } else if (strcmp(cmd, "AUTO_THRESH") == 0 || strncmp(cmd, "AUTO_THRESH:", 12) == 0) {
    const bool withMargin = (cmd[11] == ':');
    if (withMargin) {
      int m;
      if (sscanf(cmd + 12, "%d", &m) == 1) {
        if (m < 0) m = 0;
        if (m > ADC_MAX) m = ADC_MAX;
        autoMargin = m;
        saveAutoMargin();
      }
    }
    say("### Auto-calibrating threshold...");
    calibrateSignalThreshold(100, autoMargin);
    printThresholds();
    if (withMargin) printAutoMargin();
  } else if (strcmp(cmd, "RESET") == 0) {
    eventCount = 0;
    startTimeUs = nowUs();
    totalDeadUs = 0;
    say("RESET:OK");
  } else if (strcmp(cmd, "GET_AUTO_MARGIN") == 0) {
    printAutoMargin();
  } else if (strncmp(cmd, "SET_AUTO_MARGIN:", 16) == 0) {
    int m;
    if (sscanf(cmd + 16, "%d", &m) == 1) {
      if (m < 0) m = 0;
      if (m > ADC_MAX) m = ADC_MAX;
      autoMargin = m;
      saveAutoMargin();
    }
    printAutoMargin();
  } else if (strcmp(cmd, "GET_MODE") == 0 || strncmp(cmd, "SET_MODE:", 9) == 0) {
    // トリガはコンパレータ割込 (DIGITAL) 固定。ANALOG / DUAL を頼まれても切り替えない。
    say("MODE:DIGITAL");
  } else if (strcmp(cmd, "GET_SCOPE") == 0 || strncmp(cmd, "SET_SCOPE:", 10) == 0) {
    if (strcmp(cmd, "SET_SCOPE:ON") == 0) {
      say("### SCOPE: not available on the ring firmware (use the main firmware). Counting continues.");
    }
    say("SCOPE:OFF");
  } else if (strcmp(cmd, "GET_BEEP") == 0 || strncmp(cmd, "SET_BEEP:", 9) == 0) {
    say("BEEP:500,4000,25");
  } else if (strcmp(cmd, "GET_VIB_MS") == 0 || strncmp(cmd, "SET_VIB_MS:", 11) == 0) {
    say("VIBMS:20,120");
  } else if (strcmp(cmd, "GET_BLENAME") == 0) {
    printBleName();
  } else if (strcmp(cmd, "GET_BTADDR") == 0) {
    printBtAddr();
  } else if (strncmp(cmd, "SET_BLENAME:", 12) == 0) {
    const char* newName = cmd + 12;
    const size_t len = strlen(newName);
    bool valid = (len > 0 && len <= BLE_NAME_MAX);
    for (size_t i = 0; valid && i < len; i++) {
      const char c = newName[i];
      if (c < 0x20 || c > 0x7E) valid = false;
    }
    if (valid) {
      strncpy(bleName, newName, BLE_NAME_MAX);
      bleName[BLE_NAME_MAX] = '\0';
      saveBleName();
      printBleName();
      // 本体ファームは BLE の広告名に反映するため再起動するが、この版に BLE は無いので再起動しない。
      say("### BLE name saved (this firmware has no BLE; the name only labels the board).");
    } else {
      say("### BLE name invalid (1-24 printable ASCII chars).");
      printBleName();
    }
  } else {
    handleAbsent(cmd);   // 本体ファームと同じく、知らないコマンドには何も返さない
  }
}

// コマンドの実行中は検出ループが止まる (AUTO_PWM は約 8 秒)。その時間をデッドタイムに計上する。
// RESET は計上の起点そのものを作り直すので足さない。
void runCommand(const char* cmd) {
  const uint64_t t0 = nowUs();
  executeCommand(cmd);
  if (strcmp(cmd, "RESET") != 0) totalDeadUs += nowUs() - t0;
}

void processSerialCommand() {
  static CmdLine line = {};
  while (Serial.available()) {
    switch (cmdFeed(line, (char)Serial.read())) {
      case CMD_READY: runCommand(line.buf); break;
      case CMD_TOO_LONG: {
        char b[64];
        snprintf(b, sizeof(b), "### ERROR: command too long (max %u chars), ignored.",
                 (unsigned)(CMD_BUF_SIZE - 1));
        say(b);
        break;
      }
      default: break;
    }
  }
}

// ==========================================
//   起動時の見出し (本体ファームの printBootHeader と同じ並び)
// ==========================================
void printBootHeader() {
  const char* hdr1 = "##########################################################################################";
  say(hdr1);
  say("### Accel Kitchen");
  say("### https://accel-kitchen.com/");
  say("### info@accel-kitchen.com");
  say("### LED ring firmware (USB only: no BLE / SD / OLED / BME280 / GPS / scope)");
  char b[64];
  snprintf(b, sizeof(b), "### Signal threshold: %d (Duty %d)", signalThreshold, pwmDuty);
  say(b);
  say("MODE:DIGITAL");
  say("SD:OFF");
  say("EXT:OFF");
  say("OLED:OFF");
  say("VIB:OFF");
  say("GPS:OFF");
  say("### Event Time[us] ADC[0-4095] Deadtime[us] Temp[C] Hum[%] Press[hPa] Dig1 Dig2 Dig3 Ana1 Ana2 Ana3");
  say(hdr1);
}

// ==========================================
//   イベント処理 (本体ファームの handleTriggerEvent と同じ形式・同じ計上)
// ==========================================
void handleTriggerEvent() {
  const uint64_t t1 = nowUs();
  delayMicroseconds(ADC_SAMPLE_DELAY_US);
  const int adc = analogRead(SELF_SIG_IN);
  if (adc < signalThreshold) {          // コンパレータのチャタリング / 電源ノイズ
    holdReset();
    totalDeadUs += nowUs() - t1;
    return;
  }

  ringHit(adc);                          // 状態を立てるだけ。書き出しは ringService()
  holdReset();
  eventCount++;
  digitalWrite(LED_PIN, HIGH);
  ledOffMs = millis() + LED_BLINK_MS;

  // 13 項目。センサ類は無いので nan / 0。deadtime は「このイベントの処理を除いた」累積
  // (本体ファームも出力してから加える)。
  char eventBuf[200];
  snprintf(eventBuf, sizeof(eventBuf),
           "%lu %llu %d %llu %.1f %.1f %.1f %d %d %d %d %d %d",
           eventCount,
           (unsigned long long)(nowUs() - startTimeUs), adc,
           (unsigned long long)totalDeadUs,
           NAN, NAN, NAN,
           0, 0, 0, 0, 0, 0);
  say(eventBuf);

  totalDeadUs += nowUs() - t1;
}

// ==========================================
//   Setup / loop
// ==========================================
void setup() {
  analogReadResolution(ADC_BITS);
  analogWriteResolution(PWM_THRESH, PWM_BITS);
  analogWriteFrequency(PWM_THRESH, PWM_FREQ_HZ);

  Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT
  // ポートを誰も読んでいなくても print が止まらないように (本体ファームと同じ)。
  Serial.setTxTimeoutMs(0);
#endif
  unsigned long t0 = millis();
  while (!Serial && (millis() - t0 < 1500)) delay(10);
  // コンソールは "Booting" で始まる行を見て、基板の状態をもう一度問い合わせる。
  Serial.println(F("\nBooting ring..."));

  pinMode(TRIGGER_IN, INPUT);
  pinMode(TRIG_RESET, OUTPUT);   digitalWrite(TRIG_RESET, LOW);
  pinMode(COIN_OUT_PIN, OUTPUT); digitalWrite(COIN_OUT_PIN, LOW);
  pinMode(BUZZER_PIN, OUTPUT);   digitalWrite(BUZZER_PIN, LOW);
  pinMode(LED_PIN, OUTPUT);      digitalWrite(LED_PIN, LOW);

  bool hasPwm = false;
  loadSettings(&hasPwm);

  ring.begin();
  ring.setBrightness(RING_BRIGHTNESS);
  ringFill(ring.Color(0, 0, 40));        // 起動表示
  delay(300);

  attachInterrupt(digitalPinToInterrupt(TRIGGER_IN), onTriggerISR, RISING);
  if (hasPwm) {
    analogWrite(PWM_THRESH, pwmDuty);    // 保存済みの duty (本体ファームと共有)。再較正は AUTO_PWM で
    delay(AUTO_PWM_SETTLE_MS);
  } else {
    autoPwm(AUTO_PWM_TARGET_DEFAULT);    // 初回だけ自動較正して保存
    savePwm();
  }
  calibrateSignalThreshold(100, autoMargin);

  ringFill(ring.Color(0, 60, 0));        // 較正完了 (緑)
  delay(400);
  for (int i = 0; i < RING_COUNT; i++) { level[i] = 0.0f; level0[i] = 0.0f; attackT[i] = 1e9f; hue[i] = 0; }
  triggerFlag = false;
  holdReset();
  printBootHeader();
  startTimeUs = nowUs();                 // 時計の起点は較正が終わった時点
  totalDeadUs = 0;
  ringRender(true);
}

void loop() {
  const unsigned long now = millis();

  if (ledOffMs && (long)(now - ledOffMs) >= 0) {
    digitalWrite(LED_PIN, LOW);
    ledOffMs = 0;
  }

  processSerialCommand();

  if (triggerFlag) {
    triggerFlag = false;
    handleTriggerEvent();
  }

  ringService(now);
}
