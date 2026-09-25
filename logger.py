import serial
import csv
from datetime import datetime

print("Connecting to ESP32...")

esp32 = serial.Serial("COM3", 115200, timeout=2)

print("Connected!")
print("Waiting for data...")

with open("streetlight_data.csv", "w", newline="") as file:

    writer = csv.writer(file)

    writer.writerow(["Timestamp", "Lux"])
    file.flush()

    while True:

        data = esp32.readline().decode("utf-8", errors="ignore").strip()

        if data:
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

            writer.writerow([timestamp, data])
            file.flush()

            print(timestamp, data)