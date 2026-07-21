/*
 Accel Kitchen Cosmic Detector Arduino Code
  - https://accel-kitchen.com/
  - info@accel-kitchen.com

  Requirements: Sketch->Include->Manage Libraries:
  SPI, EEPROM, SD, and Wire are probably already installed.
  1. Adafruit SSD1306     -- by Adafruit Version 1.0.1
  2. Adafruit GFX Library -- by Adafruit Version 1.0.2
  3. TimerOne             -- by Jesse Tane et al. Version 1.1.0
*/

#include <Adafruit_SSD1306.h>  // OLEDディスプレイ用ライブラリ

#include <Adafruit_GFX.h>      // グラフィックスライブラリ
#include <TimerOne.h>          // Timer1を使用するためのライブラリ
#include <Wire.h>              // I2C通信ライブラリ
#include <SPI.h>               // SPI通信ライブラリ
#include <EEPROM.h>            // EEPROM操作ライブラリ
#include <avr/sleep.h>         // AVRマイコンのスリープモード制御
#include <math.h>              // 数学関数ライブラリ
#include <string.h>            // 文字列操作（コマンド解析用 strncmp/strcmp/strchr）
#include <stdlib.h>            // atoi（コマンド解析用）

const byte OLED = 1;  // OLEDディスプレイのON/OFF制御（1:ON, 0:OFF）

int SIGNAL_THRESHOLD = 30;  // 信号検出のしきい値（ADC値）
int RESET_THRESHOLD = 20;   // 信号リセットのしきい値（ADC値）

const int LED_BRIGHTNESS = 255;  // LEDの明るさ（0〜255）

// SiPM電圧を計算するためのキャリブレーション係数（多項式の係数）
const double cal[] = {
  -9.085681659276021e-27, 4.6790804314609205e-23, -1.0317125207013292e-19,
  1.2741066484319192e-16, -9.684460759517656e-14, 4.6937937442284284e-11,
  -1.4553498837275352e-08, 2.8216624998078298e-06, -0.000323032620672037,
  0.019538631135788468, -0.3774384056850066, 12.324891083404246
};

const int cal_max = 1023;  // ADCの最大値（10ビットADCの場合1023）

// 割り込み設定
#define TIMER_INTERVAL 2000000UL  // タイマーの間隔（マイクロ秒）。2,000,000us = 2秒

// OLED設定
#define OLED_RESET 10  // OLEDのリセットピン
Adafruit_SSD1306 display(OLED_RESET);  // OLEDディスプレイのオブジェクト

// 変数の初期化
volatile unsigned long interrupt_timer = 0UL;  // 割り込みタイマーのタイムスタンプ
volatile float temperatureC = 0.0;             // 温度（摂氏）
volatile bool update_display = false;          // ディスプレイ更新フラグ

unsigned long time_stamp = 0UL;                // イベントのタイムスタンプ
unsigned long total_deadtime = 0UL;            // 累積デッドタイム
unsigned long start_time = 0UL;                // 測定開始時間

float sipm_voltage = 0.0;                      // SiPMの電圧
unsigned long count = 0UL;                     // 検出されたイベントの数
int adc = 0;                                   // 現在のADC読み取り値
bool SLAVE = false;                            // SLAVEモードのフラグ
bool MASTER = false;                           // MASTERモードのフラグ

void setup() {
  analogReference(EXTERNAL);  // ADCの基準電圧を外部に設定
  // ADCプリスケーラを適切な値に設定（ここでは8を使用）
  ADCSRA &= ~(bit(ADPS0) | bit(ADPS1) | bit(ADPS2));  // clear prescaler bits
  ADCSRA |= bit(ADPS0) | bit(ADPS1);                  // Set prescaler to 8
  Serial.begin(9600);  // シリアル通信の初期化

  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);  // OLEDディスプレイの初期化（I2Cアドレス0x3C）
  pinMode(3, OUTPUT);     // ピン3を出力に設定（LED制御用）
  pinMode(6, INPUT_PULLUP);  // ピン6をプルアップ入力に設定（MASTER/SLAVE判定用）

  // ピン6の状態に基づいてMASTER/SLAVEを判定
  if (digitalRead(6) == HIGH) {
    SLAVE = true;            // SLAVEモードに設定
    MASTER = false;
    digitalWrite(3, HIGH);   // LEDを点灯
    delay(1000);             // 1秒待機
  } else {
    delay(10);
    MASTER = true;           // MASTERモードに設定
    SLAVE = false;
    pinMode(6, OUTPUT);      // ピン6を出力に設定
    digitalWrite(6, HIGH);   // ピン6をHIGHに設定
  }

  if (OLED == 1) {
    display.setRotation(2);  // ディスプレイを180度回転
    OpeningScreen();         // オープニング画面の表示
    delay(2000);             // ロゴ表示のために2秒待機
    display.setTextSize(1);  // テキストサイズを1に設定
  } else {
    delay(2000);             // 2秒待機
  }

  digitalWrite(3, LOW);      // LEDを消灯
  if (MASTER) {
    digitalWrite(6, LOW);    // MASTERの場合、ピン6をLOWに設定
  }

  // シリアルモニタに初期メッセージを表示
  Serial.println(F("##########################################################################################"));
  Serial.println(F("### Accel Kitchen"));
  Serial.println(F("### https://accel-kitchen.com/"));
  Serial.println(F("### info@accel-kitchen.com"));
  Serial.print(F("### Signal threshold: "));
  Serial.println(SIGNAL_THRESHOLD);
  Serial.print(F("### Reset threshold: "));
  Serial.println(RESET_THRESHOLD);
  Serial.println(F("### Event Time[ms] ADC[0-1023] SiPM[mV] Deadtime[ms] Temp[C]"));
  Serial.println(F("##########################################################################################"));

  get_time();           // 初期時間の取得とディスプレイ更新
  delay(900);           // 0.9秒待機
  start_time = millis();  // 測定開始時間を記録

  Timer1.initialize(TIMER_INTERVAL);  // Timer1の初期化
  Timer1.attachInterrupt(timerIsr);   // 割り込みサービスルーチンを設定
}

void loop() {

  processSerialCommand();  // index.html等からのシリアルコマンドを処理（非ブロッキング）

  if (analogRead(A0) > SIGNAL_THRESHOLD) {  // しきい値を超えた場合
    adc = analogRead(A0);  // A0ピンからADC値を読み取る（SiPM信号）
    unsigned long measurement_t1 = micros();  // 測定開始時間を記録
    // MASTERの場合、SLAVEに信号を送信
    if (MASTER) {
      digitalWrite(6, HIGH);  // ピン6をHIGHに設定（SLAVEへの信号）
    }

      // Wait for ~10us
      delayMicroseconds(10);

    // SLAVEの場合、MASTERからの信号をチェック
    bool coincidence = true;
    if (SLAVE) {
      if (digitalRead(6) == HIGH) {
        coincidence = true;
      }
      else{
        coincidence = false;
      }
    }
      // Wait for ~10us
      delayMicroseconds(10);

    // MASTERの場合、SLAVEへの信号を停止
    if (MASTER) {
      digitalWrite(6, LOW);   // ピン6をLOWに設定
    }

    if (coincidence) {
      count++;  // イベントカウントを増加
      digitalWrite(3, HIGH);  // LEDを点灯
      sipm_voltage = get_sipm_voltage(adc);  // SiPM電圧を計算
      // イベントデータをシリアルモニタに出力
      Serial.print(count);
      Serial.print(" ");
      Serial.print(millis() - start_time);  // 時間を計算
      Serial.print(" ");
      Serial.print(adc);
      Serial.print(" ");
      Serial.print(sipm_voltage);
      Serial.print(" ");
      Serial.print(total_deadtime);
      Serial.print(" ");
      Serial.println(temperatureC);
    }

    // 信号がRESET_THRESHOLDを下回るまで待機
    while (analogRead(A0) > RESET_THRESHOLD) {
      // 非ブロッキング処理を行う場合は、ここで追加のコードを実行できます
    }

    digitalWrite(3, LOW);    // LEDを消灯
    total_deadtime += (micros() - measurement_t1) / 1000UL;  // デッドタイムを更新
  }

  // ディスプレイ更新フラグが設定されている場合、ディスプレイを更新
  if (update_display) {
    get_time();
    update_display = false;
  }
}

void timerIsr() {
  // 割り込み内では簡潔な処理のみを行う
  interrupt_timer = millis();  // 割り込みタイマーを更新
  update_display = true;  // ディスプレイ更新フラグを設定
}

// ============================================================================
//  シリアルコマンド処理（index.html等のホストからの制御）
//  - 互換性維持: 応答行(MODE:/THRESH:)はコマンド受信時のみ出力する。
//    旧ツールはコマンドを送らないため、これらの行は一切出力されず、
//    従来どおりヘッダ＋6項目データ行のみのストリームとなる。
//  - データ行のフォーマットや起動時の挙動は一切変更しない。
// ============================================================================

// ランタイムでMASTER/SLAVEを切り替える（pin6の入出力方向も合わせて設定）
void applyMode(bool slaveMode) {
  if (slaveMode) {
    SLAVE = true;
    MASTER = false;
    pinMode(6, INPUT_PULLUP);   // MASTERからのコインシデンス信号を待ち受ける
  } else {
    MASTER = true;
    SLAVE = false;
    pinMode(6, OUTPUT);
    digitalWrite(6, LOW);       // アイドルLOW、検出時にHIGHパルス（loop内の論理と整合）
  }
}

// 現在のモードを "MODE:0"(Master) / "MODE:1"(Slave) として出力
// index.html の MODE: 応答パースに一致させる
void printMode() {
  Serial.print(F("MODE:"));
  Serial.println(SLAVE ? 1 : 0);
}

// 現在のしきい値を "THRESH:<sig>,<rst>" として出力（カンマ区切り・空白なし）
// index.html は substring(7).split(',') かつ length===2 を要求するため空白を入れない
void printThresh() {
  Serial.print(F("THRESH:"));
  Serial.print(SIGNAL_THRESHOLD);
  Serial.print(',');
  Serial.println(RESET_THRESHOLD);
}

// 1行ぶんのコマンド文字列を解釈する
void handleCommand(const char* cmd) {
  if (strncmp(cmd, "SET_MODE:", 9) == 0) {
    int m = atoi(cmd + 9);
    if (m == 0 || m == 1) {
      applyMode(m == 1);
    }
    printMode();  // 変更結果をエコー（index.htmlがバッジ等を更新）
  } else if (strcmp(cmd, "GET_MODE") == 0) {
    printMode();
  } else if (strncmp(cmd, "SET_THRESH:", 11) == 0) {
    const char* comma = strchr(cmd + 11, ',');
    if (comma != NULL) {
      int sig = atoi(cmd + 11);
      int rst = atoi(comma + 1);
      // 妥当性チェック（10bit ADC: 0..1023, かつ Signal > Reset）
      if (rst >= 0 && sig <= 1023 && sig > rst) {
        SIGNAL_THRESHOLD = sig;
        RESET_THRESHOLD = rst;
      }
    }
    printThresh();  // 現在値をエコー
  } else if (strcmp(cmd, "GET_THRESH") == 0) {
    printThresh();
  } else if (strcmp(cmd, "AUTO_THRESH") == 0) {
    setThreshold();   // 既存のバックグラウンド最小値測定で自動キャリブレーション
    printThresh();
  }
  // 未知コマンドは無視（旧挙動を壊さない）
}

// シリアル受信を非ブロッキングで処理し、改行までを1コマンドとして解釈
void processSerialCommand() {
  static char buf[32];
  static byte idx = 0;
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (idx > 0) {
        buf[idx] = '\0';
        handleCommand(buf);
        idx = 0;
      }
    } else if (idx < sizeof(buf) - 1) {
      buf[idx++] = c;  // 溢れた分は捨て、改行で確定（長すぎる行は未知コマンド扱いになる）
    }
  }
}

void get_time() {
  unsigned long OLED_t1 = micros();  // ディスプレイ更新開始時間を記録
  float count_average = 0.0;         // 平均カウント率
  float count_std = 0.0;             // カウント率の標準偏差

  int temp_adc = analogRead(A3);
  temperatureC = ((temp_adc * (3300.0 / 1024.0) - 500.0) / 10.0);  // 温度に変換

  unsigned long total_time_ms = interrupt_timer - start_time - total_deadtime;  // 実際の測定時間（ms）

  if (count > 0) {
    float total_time_s = total_time_ms / 1000.0;  // 測定時間を秒に変換
    count_average = count / total_time_s;         // 平均カウント率を計算
    count_std = sqrt((float)count) / total_time_s;  // 標準偏差を計算
  }

  // OLEDディスプレイに情報を表示
  display.setCursor(0, 0);
  display.clearDisplay();
  display.print(F("Accel Kitchen "));
  if (MASTER) { display.println(F(":Master")); }
  if (SLAVE) { display.println(F(":Slave")); }
  display.print(F("Cnt:"));
  display.print(count);
  display.print(F(" T:"));

  // 時間をHH:MM:SS形式で表示
  unsigned long elapsed_time = interrupt_timer - start_time;
  int hours = (elapsed_time) / 1000UL / 3600UL;
  int minutes = ((elapsed_time) / 1000UL / 60UL) % 60UL;
  int seconds = ((elapsed_time) / 1000UL) % 60UL;

  char time_str[9];
  snprintf(time_str, sizeof(time_str), "%02d:%02d:%02d", hours, minutes, seconds);
  display.println(time_str);

  // カウント率と標準偏差を表示
  display.print(F("Rate: "));
  display.print(count_average, 2);
  display.print(F("+/-"));
  display.println(count_std, 2);

  // しきい値を表示
  display.print(F("Sig"));
  display.print(SIGNAL_THRESHOLD);
  display.print(F(" Res:"));
  display.print(RESET_THRESHOLD);
  display.display();  // ディスプレイを更新

  total_deadtime += (micros() - OLED_t1 + 73UL) / 1000UL;  // デッドタイムを更新
}

void OpeningScreen() {
  setThreshold();        // しきい値を設定
  display.setTextSize(1);  // テキストサイズを設定
  display.setTextColor(WHITE);  // テキストカラーを設定
  display.setCursor(8, 0);
  display.clearDisplay();
  display.println(F("Accel Kitchen"));
  display.print(F("Signal threshold: "));
  display.println(SIGNAL_THRESHOLD);
  display.print(F("Reset threshold: "));
  display.println(RESET_THRESHOLD);
  display.display();       // ディスプレイを更新
  display.clearDisplay();  // ディスプレイをクリア
}

void setThreshold() {
  int minValue = 1023; // ADCの最大値で初期化
  for (int i = 0; i < 10; i++) {
    int currentValue = analogRead(A0); // A0ピンから読み取る（SiPM信号）
    if (currentValue < minValue) {
      minValue = currentValue; // 最小値を更新
    }
    delay(10); // 10ms待機
  }
  SIGNAL_THRESHOLD = minValue + 20; // 信号のしきい値を設定5
  RESET_THRESHOLD = minValue + 15;  // リセットのしきい値を設定
}

// ADC値からSiPM電圧を計算する関数
float get_sipm_voltage(float adc_value) {
  float voltage = cal[0];  // 電圧をキャリブレーション係数の最初の値で初期化
  int n = sizeof(cal) / sizeof(cal[0]);  // 係数の数を計算
  for (int i = 1; i < n; i++) {
    voltage = voltage * adc_value + cal[i];  // ホーナー法で多項式を計算
  }
  return voltage;
}
