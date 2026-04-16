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

// ==========================================
//   險ｭ螳・// ==========================================
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
static constexpr int SD_SPI_CS_PIN = 18;         // D9  / CS  -> microSD (J8, CS2)
static constexpr int SD_SPI_UNUSED_CS_PIN = 21;  // D10 / CS1 (keep deasserted)
static constexpr int SD_SPI_MOSI_PIN = 38;       // D11 / COPI
static constexpr int SD_SPI_MISO_PIN = 47;       // D12 / CIPO
static constexpr int SD_SPI_SCK_PIN = 48;        // D13 / SCK
static constexpr uint32_t SD_SPI_FREQ_HZ = 4000000;

// OLED險ｭ螳・#define SCREEN_WIDTH 128
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
const int OLED_RESET = -1;
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

// BME280
Adafruit_BME280 bme;
bool bmeReady = false;

// 縺励″縺・､ (0-4095 繧ｹ繧ｱ繝ｼ繝ｫ, 12bit ADC / 10bit PWM Duty 縺ｸ螟画鋤)
int SIGNAL_THRESHOLD = 120;

// ADC / PWM 蛻・ｧ｣閭ｽ
static constexpr int ADC_BITS = 12;
static constexpr int ADC_MAX  = (1 << ADC_BITS) - 1;   // 4095
static constexpr int PWM_BITS = 10;
static constexpr int PWM_MAX  = (1 << PWM_BITS) - 1;   // 1023
static constexpr uint32_t PWM_FREQ_HZ = 40000;
static constexpr int LEGACY_ADC_BITS = 10;
static constexpr int LEGACY_ADC_MAX  = (1 << LEGACY_ADC_BITS) - 1;  // 1023
static constexpr int DEFAULT_SIG_OFFSET_10BIT = 160;
static constexpr int CAL_NOISE_MARGIN_10BIT = 16;
// Display refresh interval.
static constexpr unsigned long DISPLAY_INTERVAL_MS = 2000;


// 繝医Μ繧ｬ繝ｼ繝ｪ繧ｻ繝・ヨ繝代Ν繧ｹ蟷・(us)
static constexpr unsigned long TEMP_READ_INTERVAL_MS = 2000;
static constexpr unsigned int TRIG_RESET_PULSE_US = 20;
static constexpr unsigned int ADC_SAMPLE_DELAY_US = 5;
// 繧ｳ繧､繝ｳ繧ｷ繝・Φ繧ｹ蜃ｺ蜉帙ヱ繝ｫ繧ｹ蟷・(us)
static constexpr unsigned int COIN_OUT_PULSE_US = 1000;
// 繝悶じ繝ｼ繝医・繝ｳ (Hz) 縺ｨ魑ｴ蜍墓凾髢・(ms)
static constexpr unsigned int BUZZER_FREQ_HZ = 2000;
static constexpr unsigned long BUZZER_MS = 10;

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

// ==========================================
//   Preferences (EEPROM莉｣譖ｿ)
// ==========================================
Preferences prefs;
File sdLogFile;
bool sdReady = false;
bool sdWriteFailed = false;
char sdLogPath[16] = {0};

// ==========================================
//   繧ｰ繝ｭ繝ｼ繝舌Ν螟画焚
// ==========================================
unsigned long start_time = 0UL;
unsigned long total_deadtime = 0UL;
unsigned long count = 0UL;
unsigned long lastDisplayMs = 0;

float temperatureC = NAN;
float humidityPct = NAN;
float pressureHPa = NAN;
int adc = 0;
int pwmDuty = 0;
TriggerMode triggerMode = TRIGGER_MODE_DIGITAL_ONLY;
bool analogArmed = true;
unsigned long lastTempReadMs = 0;

// ISR 繝輔Λ繧ｰ
volatile bool triggerFlag = false;

// BLE繧ｳ繝槭Φ繝峨ヰ繝・ヵ繧｡
static char bleCmdBuffer[32];
static int bleCmdIndex = 0;

// ==========================================
//   繝励Ο繝医ち繧､繝・// ==========================================
// ==========================================
// Function prototypes
// ==========================================
void executeCommand(const char* cmd);
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
void calibrateThreshold(int samples, int sigOffset);
void applyThresholdPwm();
void applyTriggerMode();
void updateBme();
void updateDisplay();
void OpeningScreen();
void initBLE();
void IRAM_ATTR onTriggerISR();
void handleTriggerEvent(bool fromDigitalTrigger);
int scaleAdcValue(int value, int fromBits, int toBits);

// ==========================================
//   BLE Callbacks
// ==========================================
class MyServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) override {
    bleDeviceConnected = true;
  }
  void onDisconnect(BLEServer* pServer) override {
    bleDeviceConnected = false;
  }
};

class MyRXCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) override {
    const char* rxData = pCharacteristic->getValue().c_str();
    size_t rxLen = strlen(rxData);
    for (size_t i = 0; i < rxLen; i++) {
      char c = rxData[i];
      if (c == '\n' || c == '\r') {
        if (bleCmdIndex > 0) {
          bleCmdBuffer[bleCmdIndex] = '\0';
          executeCommand(bleCmdBuffer);
          bleCmdIndex = 0;
        }
      } else if (bleCmdIndex < 31) {
        bleCmdBuffer[bleCmdIndex++] = c;
      }
    }
  }
};

// ==========================================
//   BLE騾∽ｿ｡繝倥Ν繝代・
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

  dualPrintln("### Event Time[ms] ADC[0-4095] Deadtime[ms] Temp[C] Hum[%%] Press[hPa] Dig1 Dig2 Dig3 Ana1 Ana2 Ana3");
  dualPrintln(hdr1);
}

// ==========================================
// Command handling (Serial / BLE)
// ==========================================
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
  } else if (strcmp(cmd, "AUTO_THRESH") == 0) {
    dualPrintln("### Auto-calibrating threshold...");
    calibrateThreshold(100, scaleAdcValue(DEFAULT_SIG_OFFSET_10BIT, LEGACY_ADC_BITS, ADC_BITS));
    saveThresholds();
    applyThresholdPwm();
    printThresholds();
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
  } else if (strcmp(cmd, "GET_MODE") == 0) {
    printTriggerMode();
  }
}

// Serial command processing
void processSerialCommand() {
  static char cmdBuffer[32];
  static int cmdIndex = 0;

  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (cmdIndex > 0) {
        cmdBuffer[cmdIndex] = '\0';
        executeCommand(cmdBuffer);
        cmdIndex = 0;
      }
    } else if (cmdIndex < 31) {
      cmdBuffer[cmdIndex++] = c;
    }
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
  triggerMode = (TriggerMode)prefs.getUChar("trig_mode", (uint8_t)TRIGGER_MODE_DIGITAL_ONLY);
  prefs.end();

  if (hasStoredThreshold && storedAdcBits > 0 && storedAdcBits != ADC_BITS) {
    SIGNAL_THRESHOLD = scaleAdcValue(SIGNAL_THRESHOLD, storedAdcBits, ADC_BITS);
  }

  if (SIGNAL_THRESHOLD == 120) {
    calibrateThreshold(10, scaleAdcValue(DEFAULT_SIG_OFFSET_10BIT, LEGACY_ADC_BITS, ADC_BITS));
    saveThresholds();
  }
}

void saveThresholds() {
  prefs.begin("cosmic", false);
  prefs.putInt("sig_thresh", SIGNAL_THRESHOLD);
  prefs.putInt("sig_bits", ADC_BITS);
  prefs.putUChar("trig_mode", (uint8_t)triggerMode);
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

// ==========================================
// Threshold calibration and sensor helpers
// ==========================================
void calibrateThreshold(int samples, int sigOffset) {
  long sumValue = 0;
  int minValue = ADC_MAX;
  int maxValue = 0;
  for (int i = 0; i < samples; i++) {
    int currentValue = analogRead(SELF_SIG_IN);
    sumValue += currentValue;
    if (currentValue < minValue) {
      minValue = currentValue;
    }
    if (currentValue > maxValue) {
      maxValue = currentValue;
    }
    delay(10);
  }
  const int averageValue = (samples > 0) ? (int)(sumValue / samples) : 0;
  const int noiseMargin = scaleAdcValue(CAL_NOISE_MARGIN_10BIT, LEGACY_ADC_BITS, ADC_BITS);

  SIGNAL_THRESHOLD = max(averageValue + sigOffset, maxValue + noiseMargin);
  if (SIGNAL_THRESHOLD < 0) SIGNAL_THRESHOLD = 0;
  if (SIGNAL_THRESHOLD > ADC_MAX) SIGNAL_THRESHOLD = ADC_MAX;

  char buf[96];
  snprintf(buf, sizeof(buf),
           "### Auto-threshold calib: min=%d avg=%d max=%d -> thr=%d",
           minValue, averageValue, maxValue, SIGNAL_THRESHOLD);
  dualPrintln(buf);
}

void applyThresholdPwm() {
  pwmDuty = (SIGNAL_THRESHOLD * PWM_MAX) / ADC_MAX;
  if (pwmDuty < 0) pwmDuty = 0;
  if (pwmDuty > PWM_MAX) pwmDuty = PWM_MAX;
  analogWrite(PWM_THRESH, pwmDuty);
}

void applyTriggerMode() {
  triggerFlag = false;
  if (triggerMode == TRIGGER_MODE_ANALOG_ONLY) {
    detachInterrupt(digitalPinToInterrupt(TRIGGER_IN));
  } else {
    attachInterrupt(digitalPinToInterrupt(TRIGGER_IN), onTriggerISR, RISING);
  }
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
}

// ==========================================
// BLE initialization
// ==========================================
void initBLE() {
  BLEDevice::init("CosmicRay");
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

  Serial.println(F("BLE: Advertising as 'CosmicRay'"));
}

// ==========================================
// Setup
// ==========================================
void setup() {
  analogReadResolution(ADC_BITS);
  analogWriteResolution(PWM_THRESH, PWM_BITS);
  analogWriteFrequency(PWM_THRESH, PWM_FREQ_HZ);

  Serial.begin(9600);
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

  for (int i = 0; i < 3; i++) {
    pinMode(DIG_IN_PINS[i], INPUT);
  }

  loadThresholds();
  applyThresholdPwm();

  initBLE();
  initSdLogging();
  Wire.begin(11, 12);

  if (OLED == 1) {
    if (display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
      display.setRotation(2);
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
  start_time = millis();
  lastDisplayMs = millis();
}

// ==========================================
// Main loop
// ==========================================
void loop() {
  unsigned long now = millis();
  processSerialCommand();

  if (bmeReady && (lastTempReadMs == 0 || now - lastTempReadMs >= TEMP_READ_INTERVAL_MS)) {
    lastTempReadMs = now;
    updateBme();
  }

  if (!bleDeviceConnected && bleOldDeviceConnected) {
    delay(500);
    BLEDevice::startAdvertising();
    bleOldDeviceConnected = false;
  }
  if (bleDeviceConnected && !bleOldDeviceConnected) {
    bleOldDeviceConnected = true;
  }

  if (triggerMode == TRIGGER_MODE_ANALOG_ONLY) {
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

  if (OLED == 1) {
    if (now - lastDisplayMs >= DISPLAY_INTERVAL_MS) {
      lastDisplayMs = now;
      updateDisplay();
    }
  }
}

// ==========================================
// Trigger event handling
// ==========================================
void handleTriggerEvent(bool fromDigitalTrigger) {
  unsigned long measurement_t1 = micros();

  delayMicroseconds(ADC_SAMPLE_DELAY_US);
  adc = analogRead(SELF_SIG_IN);
  if (fromDigitalTrigger && adc < SIGNAL_THRESHOLD) {
    digitalWrite(TRIG_RESET, HIGH);
    delayMicroseconds(TRIG_RESET_PULSE_US);
    digitalWrite(TRIG_RESET, LOW);
    total_deadtime += (micros() - measurement_t1) / 1000UL;
    return;
  }

  int dig[3];
  int ana[3];
  for (int i = 0; i < 3; i++) {
    dig[i] = digitalRead(DIG_IN_PINS[i]);
  }
  for (int i = 0; i < 3; i++) {
    ana[i] = analogRead(ANA_IN_PINS[i]);
  }

  bool coincidence = (dig[0] == HIGH) || (dig[1] == HIGH) || (dig[2] == HIGH);
  if (coincidence) {
    digitalWrite(COIN_OUT_PIN, HIGH);
    tone(BUZZER_PIN, BUZZER_FREQ_HZ, BUZZER_MS);
    delayMicroseconds(COIN_OUT_PULSE_US);
    digitalWrite(COIN_OUT_PIN, LOW);
  }

  digitalWrite(TRIG_RESET, HIGH);
  delayMicroseconds(TRIG_RESET_PULSE_US);
  digitalWrite(TRIG_RESET, LOW);

  count++;

  char eventBuf[160];
  snprintf(eventBuf, sizeof(eventBuf),
           "%lu %lu %d %lu %.1f %.1f %.1f %d %d %d %d %d %d",
           count, millis() - start_time, adc,
           total_deadtime, temperatureC, humidityPct, pressureHPa,
           dig[0], dig[1], dig[2], ana[0], ana[1], ana[2]);
  dualPrintln(eventBuf);

  total_deadtime += (micros() - measurement_t1) / 1000UL;
}

// ==========================================
// Display update
// ==========================================
void updateDisplay() {
  unsigned long OLED_t1 = micros();

  if (bmeReady) {
    updateBme();
  }

  unsigned long total_time_ms = (millis() - start_time) - total_deadtime;

  float count_average = 0.0f;
  float count_std = 0.0f;
  if (count > 0 && total_time_ms > 0) {
    float total_time_s = total_time_ms / 1000.0f;
    count_average = count / total_time_s;
    count_std = sqrt((float)count) / total_time_s;
  }

  display.setCursor(0, 0);
  display.clearDisplay();
  display.println(F("Accel Kitchen v2"));

  display.print(F("Cnt:"));
  display.print(count);
  display.print(F(" T:"));

  unsigned long elapsed_time = millis() - start_time;
  int hours = elapsed_time / 3600000UL;
  int minutes = (elapsed_time / 60000UL) % 60;
  int seconds = (elapsed_time / 1000UL) % 60;

  char time_str[9];
  snprintf(time_str, sizeof(time_str), "%02d:%02d:%02d", hours, minutes, seconds);
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

  total_deadtime += (micros() - OLED_t1 + 73UL) / 1000UL;
}

// ==========================================
// Opening screen
// ==========================================
void OpeningScreen() {
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(8, 0);
  display.clearDisplay();
  display.println(F("Accel Kitchen v2"));
  display.print(F("Signal threshold: "));
  display.println(SIGNAL_THRESHOLD);
  display.print(F("PWM Duty: "));
  display.println(pwmDuty);
  display.println(F("BLE: CosmicRay"));
  display.display();
  display.clearDisplay();
}
