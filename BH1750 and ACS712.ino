#include <Wire.h>
#include <BH1750.h>

BH1750 lightmeter;
const int ACS_PIN = 34;


void setup() {
  // put your setup code here, to run once:
  Serial.begin(115200);
  Wire.begin(22,21);
  lightmeter.begin();
  Serial.println("lux reading starts:");
  delay(1000);

}

void loop() {
  // put your main code here, to run repeatedly:
  float lux = lightmeter.readLightLevel();

  long sum = 0;

  // Average 100 readings to reduce noise
  for (int i = 0; i < 100; i++) {
    sum += analogRead(ACS_PIN);
    delayMicroseconds(500);
  }

  float adc = sum / 100.0;

  // ESP32 ADC voltage (approximate)
  float voltage = (adc / 4095.0) * 3.3;

    Serial.print("Lux: ");
  Serial.print(lux);
  Serial.print("Lx        |  ");

  Serial.print("ADC: ");
  Serial.print(adc);
  Serial.print(" | Voltage: ");
  Serial.print(voltage, 3);
  Serial.println(" V");

  
  delay(500);
}
