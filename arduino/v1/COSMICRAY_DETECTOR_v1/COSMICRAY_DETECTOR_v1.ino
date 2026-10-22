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

// オシロスコープモード（測定を止めて A0 の波形そのものを見る）の状態。実装は下の
// 「オシロスコープモード」の節。SET_SCOPE:ON を受けたときだけ有効になる。
#define SCOPE_PRE   16                    // トリガ前の点数
#define SCOPE_POST  128                   // トリガ後の点数
#define SCOPE_RING  (SCOPE_PRE + 1)       // トリガ点を含むリングの長さ
const byte SCOPE_RATE_MAX = 20;           // 波形の出力レート上限[/s]の最大値

bool          scopeOn = false;            // オシロ中は計数を止めている
byte          scopeRate = 3;              // 波形の出力レート上限[/s]
unsigned long scopeEnterMs = 0;           // オシロに入った時刻（滞在時間のデッドタイム計上用）
unsigned long scopeLastEmitMs = 0;
unsigned long scopeEmitted = 0;           // 出力した波形の数
uint16_t      scopeRing[SCOPE_RING];      // トリガ前＋トリガ点（循環）
uint16_t      scopePost[SCOPE_POST];      // トリガ後

// オシロ中にコマンドがこの時間まったく来なければ、自分で OFF に戻して計数を再開する。
// コンソールが SET_SCOPE:OFF を送れずに閉じても（タブを閉じた、PC が寝た、ケーブルを抜いた）
// 夜通し計数が止まったままにならないための安全装置。
// コンソールはオシロタブを開いている間 15 秒ごとに GET_SCOPE を送る（これが keepalive）。
const unsigned long SCOPE_IDLE_TIMEOUT_MS = 60000UL;
unsigned long       lastCommandMs = 0;

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

  // オシロの安全装置: 無操作が続いたら OFF に戻して計数を再開する（そのまま下の検出に進む）。
  if (scopeOn && (millis() - lastCommandMs) >= SCOPE_IDLE_TIMEOUT_MS) {
    Serial.println(F("### SCOPE: no command for 60 s, turning the scope OFF to resume counting."));
    scopeSetOn(false);
    printScope();   // コンソールは SCOPE: の行で状態を追う
  }

  // オシロ中は計数しない。ADC をフリーランニングで占有しているので、
  // 下の analogRead を含む検出ループにも OLED 更新（get_time の analogRead）にも入らない。
  if (scopeOn) {
    scopeService();
    return;
  }

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
//  - 互換性維持: 応答行(MODE:/THRESH:/SCOPE:/SCOPE_RATE:)と波形行(WF,)はコマンド受信時のみ出力する。
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
  // どのコマンドもオシロの無操作タイマーを延長する（GET_SCOPE はその keepalive）。
  lastCommandMs = millis();

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
  } else if (strncmp(cmd, "SET_SCOPE:", 10) == 0) {
    // オシロは永続化しない。電源投入・リセット後は必ず OFF。
    if (strcmp(cmd + 10, "ON") == 0)       scopeSetOn(true);
    else if (strcmp(cmd + 10, "OFF") == 0) scopeSetOn(false);
    printScope();     // 既にその状態でも必ず返す（コンソールは SCOPE: の応答で対応ファームと判断する）
  } else if (strcmp(cmd, "GET_SCOPE") == 0) {
    printScope();
  } else if (strncmp(cmd, "SET_SCOPE_RATE:", 15) == 0) {
    int r = atoi(cmd + 15);
    if (r >= 1 && r <= SCOPE_RATE_MAX) scopeRate = (byte)r;
    printScopeRate();
  } else if (strcmp(cmd, "GET_SCOPE_RATE") == 0) {
    printScopeRate();
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

// ============================================================================
//  オシロスコープモード
// ============================================================================
// 「測定を止めて A0 の波形そのものを見る」ための独立モード。計数経路とは排他。
// コンソール（v1.html）のオシロタブが SET_SCOPE:ON を送ると始まる。
//
//   SET_SCOPE:ON / OFF   -> SCOPE:ON / SCOPE:OFF
//   GET_SCOPE            -> SCOPE:ON / SCOPE:OFF（コンソールはこれを 15 秒ごとに送る keepalive にも使う）
//   SET_SCOPE_RATE:<n>   -> SCOPE_RATE:<n>   波形を出す間隔の下限（1〜20 /s）
//   GET_SCOPE_RATE       -> SCOPE_RATE:<n>
//   どのコマンドも来ないまま SCOPE_IDLE_TIMEOUT_MS（60 秒）が過ぎたら、自分で OFF に戻る。
//
// 波形は 1 イベント 1 行（ESP32-S3 版と同じ書式）。v[npre] がトリガ点で t=0、値は 10bit の生値:
//   WF,<n>,<t_ms>,U,<npre>,<ntot>,<period_ns>,<v0>,<v1>,...,<v(ntot-1)>
//
// サンプリング: ADC をフリーランニング（ADATE）にして、変換が終わるたびに 1 点読む。
//   間隔は「変換 13 クロック × プリスケーラ」で決まり、setup() の設定（÷8）なら 6.5us。
//   CPU の都合で揺れないので period_ns は計算値をそのまま出す。
//   フリーランニング中は ADSC が立ちっぱなしで analogRead が戻ってこない。
//   scopeOn の間に analogRead が走る経路（get_time / setThreshold）は、それぞれの側で守ってある。
//
// 割り込み: トリガ後の SCOPE_POST 点は noInterrupts() で取る（約 0.83ms）。この窓は 1ms 弱に
//   収めること。Timer0 のオーバーフロー周期は 1.024ms で、これより長いと millis() が進み損ねる。
//   9600bps の UART も 1 バイト 1.04ms なので、窓の中で届くのは高々 1 バイト（受信 FIFO は 2 段）で
//   取りこぼさない。SCOPE_POST を増やすなら約 150 点（0.98ms）が上限。
//   トリガ前は割り込みを許すので、Timer0 や受信の ISR と重なると前の点が 1 点抜けることがある
//   （変換 13 クロック = 104 サイクルに対し、1 点あたりの処理は約 62 サイクル、8 点に 1 回の
//   Serial.available() を含む周では約 95 サイクル。逆アセンブルで確認した値で、コンパイラや
//   最適化が変わると動く）。抜けても間隔は 6.5us と表示される。
//   そこは平坦なベースラインなので判読に影響しない。トリガ後のパルスの形そのものは正確。
//
// 出力: 9600bps では 1 行（約 500 バイト）に約 0.5 秒かかり、その間のイベントは取らない。
//   レート上限を 20 にしても、実際に出るのは毎秒 2 本程度。
//
// 滞在時間はデッドタイムに計上するので、オシロを見たあとも計数率は正しいままになる。

// setup() で設定した ADC プリスケーラ（ADPS2:0）を保ったまま ADCSRA を書き直すためのマスク
#define SCOPE_ADPS_MASK (_BV(ADPS2) | _BV(ADPS1) | _BV(ADPS0))

// ADC をフリーランニングで走らせる。ADMUX は analogRead(A0) と同じ（外部基準・A0）。
void scopeAdcStart() {
  ADMUX = (EXTERNAL << 6);                             // REFS=外部 AREF, 右詰め, MUX=A0
  ADCSRB &= ~(_BV(ADTS2) | _BV(ADTS1) | _BV(ADTS0));   // 自動トリガ要因 = フリーランニング
  ADCSRA = _BV(ADEN) | _BV(ADATE) | _BV(ADSC) | _BV(ADIF) | (ADCSRA & SCOPE_ADPS_MASK);
}

// フリーランニングを止めて analogRead が使える状態に戻す。
void scopeAdcStop() {
  ADCSRA = _BV(ADEN) | _BV(ADIF) | (ADCSRA & SCOPE_ADPS_MASK);  // ADATE を落とす（ADSC に 0 を書いても影響なし）
  while (ADCSRA & _BV(ADSC)) {}                                  // 走っている変換が終わるまで待つ
}

// 変換が 1 つ終わるのを待って、その値を返す。ADIF は 1 を書いて落とす。
static inline uint16_t scopeNext() {
  while (!(ADCSRA & _BV(ADIF))) {}
  const uint16_t v = ADC;
  ADCSRA = _BV(ADEN) | _BV(ADATE) | _BV(ADIF) | (ADCSRA & SCOPE_ADPS_MASK);
  return v;
}

void printScope() {
  if (scopeOn) Serial.println(F("SCOPE:ON"));
  else         Serial.println(F("SCOPE:OFF"));
}

// コンソールの解析に合わせて空白を入れない
void printScopeRate() {
  Serial.print(F("SCOPE_RATE:"));
  Serial.println(scopeRate);
}

// 溜めた窓を 1 行で出す。oldest はリングの中で最も古い点の位置（その次がトリガ前の続き、
// 最後がトリガ点）。ここでは millis() の取りこぼしを気にしなくてよい（計数は止めている）。
void scopeEmit(uint8_t oldest) {
  const byte ps = ADCSRA & SCOPE_ADPS_MASK;
  const unsigned long div = ps ? (1UL << ps) : 2UL;                            // ADPS2:0 = 0 のときだけ ÷2
  const unsigned long periodNs = 13UL * div * 1000UL / (F_CPU / 1000000UL);    // 1 変換 = 13 ADC クロック

  Serial.print(F("WF,"));
  Serial.print(scopeEmitted);
  Serial.print(',');
  Serial.print(millis() - scopeEnterMs);
  Serial.print(F(",U,"));
  Serial.print(SCOPE_PRE);
  Serial.print(',');
  Serial.print(SCOPE_RING + SCOPE_POST);
  Serial.print(',');
  Serial.print(periodNs);
  for (uint8_t i = 0; i < SCOPE_RING; i++) {
    Serial.print(',');
    Serial.print(scopeRing[(oldest + i) % SCOPE_RING]);
  }
  for (uint8_t i = 0; i < SCOPE_POST; i++) {
    Serial.print(',');
    Serial.print(scopePost[i]);
  }
  Serial.println();
}

// オシロの 1 周ぶん: トリガを待って 1 本出す。受信データがあれば途中でも戻る。
// loop() が processSerialCommand() を挟んで繰り返し呼ぶ。
void scopeService() {
  // 出力間隔の下限。待っている間も受信（SET_SCOPE:OFF など）は受け付ける。
  const unsigned long minMs = 1000UL / scopeRate;
  while ((millis() - scopeLastEmitMs) < minMs) {
    if (Serial.available()) return;
  }

  // 戻るたびにリングは取り直す（コマンド処理や出力で時間が飛ぶと前の点とつながらない）。
  // ここから先のループは 1 点あたり 6.5us の枠に収まるよう、millis() や割り算を置かないこと。
  uint8_t head = 0;       // 次に書く位置 = リングの中で最も古い点
  uint8_t filled = 0;     // リングに積んだ点数（SCOPE_RING で頭打ち）
  uint8_t n = 0;
  uint16_t laps = 0;      // 受信を見た回数（一周したら loop() に戻る）
  bool armed = false;     // 直前に RESET_THRESHOLD 以下まで下がったか

  for (;;) {
    const uint16_t v = scopeNext();
    scopeRing[head] = v;
    if (++head == SCOPE_RING) head = 0;
    if (filled < SCOPE_RING) filled++;

    if (!armed) {
      if ((int)v <= RESET_THRESHOLD) armed = true;
    } else if ((int)v > SIGNAL_THRESHOLD) {
      if (filled < SCOPE_RING) {
        armed = false;    // トリガ前の点が揃う前のパルスは途中からになる。捨てて RESET まで下がるのを待つ
      } else {
        noInterrupts();
        for (uint8_t i = 0; i < SCOPE_POST; i++) scopePost[i] = scopeNext();
        interrupts();
        scopeEmit(head);
        scopeEmitted++;
        scopeLastEmitMs = millis();
        return;
      }
    }

    // 8 点に 1 回だけ受信を見る（Serial.available は約 1us）。その 65536 回に 1 回（約 3.4 秒）は、
    // 受信がなくても戻って loop() に無操作タイマーを見てもらう（millis() をここに置くと 1 点の枠を超える）。
    if ((++n & 7) == 0 && (Serial.available() || ++laps == 0)) return;
  }
}

// オシロの出入り。
void scopeSetOn(bool on) {
  if (on == scopeOn) return;

  if (on) {
    scopeEnterMs = millis();                  // OLED を描き直す時間も滞在に含める
    scopeLastEmitMs = scopeEnterMs - 1000UL;  // 最初の 1 本は待たずに出せる
    scopeEmitted = 0;
    if (OLED == 1) {
      // 計数を止めている間に統計が固まって見えると紛らわしいので、画面を切り替える
      display.clearDisplay();
      display.setCursor(0, 0);
      display.println(F("== SCOPE MODE =="));
      display.println(F("Counting PAUSED"));
      display.display();
    }
    scopeOn = true;
    scopeAdcStart();
    Serial.println(F("### SCOPE: ON - counting is PAUSED while the scope is open (coincidence is not evaluated)."));
    return;
  }

  scopeAdcStop();
  scopeOn = false;
  // 見ていた時間は測定していない時間なので、正直にデッドタイムへ計上する。
  // これをやらないとオシロを開いた回数だけ計数率が下がって見える。
  total_deadtime += millis() - scopeEnterMs;
  // Timer1 の ISR が最後に更新した時刻は最大 2 秒古く、それを使うと get_time() の測定時間が
  // 滞在時間ぶん足りなくなる。戻った直後の表示が崩れないよう、いま時刻を入れておく。
  noInterrupts();
  interrupt_timer = millis();
  interrupts();
  update_display = true;                      // OLED を計数の表示に戻す
  Serial.println(F("### SCOPE: OFF - counting resumed."));
}

void get_time() {
  if (scopeOn) return;               // オシロ中は ADC がフリーランニングで analogRead(A3) が戻らない
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
  // オシロ中は ADC がフリーランニングで analogRead が戻らない。いったん降ろして測り、終わったら戻す。
  const bool resumeScope = scopeOn;
  if (resumeScope) scopeAdcStop();

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

  if (resumeScope) scopeAdcStart();
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
