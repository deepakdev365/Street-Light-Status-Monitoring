/*
  Street Light Monitoring System - ESP32 firmware
  --------------------------------------------------
  Sensors : BH1750 (I2C lux meter), ACS712 5A (analog current sensor)
  Actuator: SSR (solid state relay) controlling the street light supply

  DATA OUT (Serial, 115200 baud, once per second):
    {"device":"ESP32_01","lux":520.4,"current":0.31,"ssr":true}

  COMMANDS IN (Serial, one JSON object per line):
    {"cmd":"ssr","state":true}     -> turn street light ON
    {"cmd":"ssr","state":false}    -> turn street light OFF

  Library required: ArduinoJson (by Benoit Blanchon) - install via
  Arduino IDE Library Manager or PlatformIO.
*/

#include <Wire.h>
#include <BH1750.h>
#include <ArduinoJson.h>

// ---------- Pin configuration ----------
const int ACS_PIN = 34;      // ACS712 analog output (ADC1 channel, input-only pin)
const int SSR_PIN = 27;      // Digital pin driving the SSR gate/opto input
const int SDA_PIN = 21;
const int SCL_PIN = 22;

// ---------- Device identity ----------
const char *DEVICE_ID = "ESP32_01";

// ---------- ACS712 calibration ----------
// 5A module sensitivity is ~185 mV per amp.
// ACS_ZERO_VOLTAGE is the sensor's OUTPUT voltage, AT THE ESP32 PIN, with
// NO current flowing. Measure this yourself with the lamp off (SSR off)
// right after power-up and update the constant below - do not assume 1.65V.
// If you use a voltage divider to bring the ACS712's 0-5V swing into the
// ESP32's 0-3.3V ADC range, DIVIDER_RATIO = R2 / (R1 + R2) of that divider.
// With no divider (only safe if your ACS712 board itself outputs 0-3.3V),
// leave DIVIDER_RATIO at 1.0.
const float ACS_SENSITIVITY_V_PER_A = 0.185;
const float ACS_ZERO_VOLTAGE        = 1.28;   // TODO: calibrate with no load
const float DIVIDER_RATIO           = 0.66;   // TODO: set to your divider's ratio
const int   ADC_SAMPLES             = 100;    // averaged per reading, matches original sketch

BH1750 lightmeter;
bool ssrState = false;
unsigned long lastSend = 0;
const unsigned long SEND_INTERVAL_MS = 1000;

StaticJsonDocument<128> outDoc;
StaticJsonDocument<128> inDoc;

void applySsr(bool state) {
  ssrState = state;
  digitalWrite(SSR_PIN, ssrState ? HIGH : LOW);
}

void handleIncomingCommands() {
  while (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;

    DeserializationError err = deserializeJson(inDoc, line);
    if (err) continue; // ignore malformed lines

    const char *cmd = inDoc["cmd"] | "";
    if (strcmp(cmd, "ssr") == 0) {
      bool state = inDoc["state"] | false;
      applySsr(state);
    }
  }
}

float readCurrentAmps() {
  long sum = 0;
  for (int i = 0; i < ADC_SAMPLES; i++) {
    sum += analogRead(ACS_PIN);
    delayMicroseconds(500);
  }
  float adc = sum / (float)ADC_SAMPLES;
  float voltageAtPin = (adc / 4095.0) * 3.3;
  float voltageAtSensor = voltageAtPin / DIVIDER_RATIO;
  float current = (voltageAtSensor - ACS_ZERO_VOLTAGE) / ACS_SENSITIVITY_V_PER_A;
  if (current < 0.02 && current > -0.02) current = 0.0; // clamp sensor noise near zero
  return current;
}

void setup() {
  Serial.begin(115200);
  pinMode(SSR_PIN, OUTPUT);
  applySsr(false); // start with the lamp OFF for safety

  Wire.begin(SDA_PIN, SCL_PIN);
  lightmeter.begin();

  analogReadResolution(12); // 0-4095 on ESP32

  delay(500);
}

void loop() {
  handleIncomingCommands();

  unsigned long now = millis();
  if (now - lastSend >= SEND_INTERVAL_MS) {
    lastSend = now;

    float lux = lightmeter.readLightLevel();
    float current = readCurrentAmps();

    outDoc.clear();
    outDoc["device"] = DEVICE_ID;
    outDoc["lux"] = lux;
    outDoc["current"] = current;
    outDoc["ssr"] = ssrState;

    serializeJson(outDoc, Serial);
    Serial.println();
  }
}
