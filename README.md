# Street Light Monitoring System

Three pieces, matching the architecture you outlined:

```
ESP32 (BH1750 + ACS712 + SSR)  --serial-->  Flask backend  --WebSocket-->  Dashboard
```

## 1. Flash the ESP32

- Open `arduino/streetlight_esp32/streetlight_esp32.ino` in the Arduino IDE.
- Install libraries (Library Manager): **BH1750** (by claws) and **ArduinoJson** (by Benoit Blanchon).
- Wiring (matches your existing sketch): BH1750 SDA→21, SCL→22; ACS712 output→GPIO34; add SSR control on **GPIO27** (change `SSR_PIN` if you use a different pin).
- **Before trusting the current readings**, calibrate two constants at the top of the file:
  - `ACS_ZERO_VOLTAGE` — power everything up with the SSR OFF (no load) and print the raw voltage at the ESP32 pin; that's your zero point.
  - `DIVIDER_RATIO` — if you're feeding the ACS712's 0–5V output into the ESP32 through a voltage divider, set this to `R2/(R1+R2)`. Leave at `1.0` only if the sensor board itself already outputs 0–3.3V.
- Upload, then open Serial Monitor at 115200 baud — you should see one JSON line per second, e.g. `{"device":"ESP32_01","lux":520.4,"current":0.31,"ssr":false}`.

## 2. Run the backend

```bash
cd streetlight-monitor
pip install -r requirements.txt
```

Set the serial port your ESP32 enumerated as, then run:

```bash
# Windows
set SL_SERIAL_PORT=COM3
python app.py

# Linux / macOS
SL_SERIAL_PORT=/dev/ttyUSB0 python app.py
```

The server starts on `http://localhost:5000`. It will keep retrying the serial connection every 2 seconds if the ESP32 isn't plugged in yet — the dashboard will show **ESP32 DISCONNECTED** until it connects.

## 3. Open the dashboard

Go to `http://localhost:5000` in a browser. You get:

- **Dashboard** — lux / current / estimated power / SSR cards, a live chart (switchable between lux, current, power), and a system-status + fault panel.
- **Live Data** — raw per-sensor readout.
- **Analytics** — today's averages, operating time, fault count, and an estimated energy figure, plus a combined lux/current chart.
- **History** — the CSV log in a table, with a CSV export button.
- **Alerts** — fires automatically when the backend detects `possible_lamp_failure` (SSR on, current below `min_current`) or `over_current` (above `max_current`), and again when it recovers to normal.
- **Settings** — edit the device name/ID and the three thresholds (lux, min/max current) plus the assumed mains voltage used for the power estimate. Saved to `settings.json`.

## Notes on data honesty

- **Lux, current, and SSR state are measured.** Power and energy are **calculated** (`current × assumed_voltage`) and labeled "estimated" in the UI — the system doesn't measure voltage.
- Fault logic lives in `app.py::evaluate_status()` — it's the same simple rule set from your design doc (no current while SSR is on → possible lamp failure; current above the max → over-current).
- Storage is CSV (`data/sensor_data.csv`) as planned for the prototype. If you outgrow it, swap `append_csv_row`/`api_history` in `app.py` for SQLite — the rest of the app (routes, WebSocket events, frontend) doesn't need to change.
- Only one street light (`ESP32_01`) is wired up, but every reading carries a `device` field, so adding a `devices` table and a per-device row in the dashboard later is additive, not a rewrite.

## Project layout

```
streetlight-monitor/
├── app.py                     # Flask + Socket.IO backend
├── requirements.txt
├── settings.json              # created on first run
├── data/
│   └── sensor_data.csv        # created on first run
├── templates/
│   └── index.html
├── static/
│   ├── css/style.css
│   └── js/dashboard.js
└── arduino/
    └── streetlight_esp32/
        └── streetlight_esp32.ino
```
