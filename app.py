"""
Street Light Monitoring System - backend
-----------------------------------------
Reads structured JSON lines from the ESP32 over serial, evaluates the
lamp's status against configurable thresholds, logs every reading to
CSV, and pushes live updates to the browser over WebSocket (Socket.IO).

Run:
    python app.py

Configure the serial port either by editing SERIAL_PORT below or by
setting the SL_SERIAL_PORT environment variable, e.g.:
    SL_SERIAL_PORT=/dev/ttyUSB0 python app.py   (Linux/Mac)
    set SL_SERIAL_PORT=COM3 && python app.py    (Windows)
"""

import csv
import json
import math
import os
import random
import re
import threading
import time
from collections import deque
from datetime import datetime

import serial
import serial.tools.list_ports
from flask import Flask, jsonify, render_template, request, send_from_directory
from flask_socketio import SocketIO

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
CSV_PATH = os.path.join(DATA_DIR, "sensor_data.csv")
SETTINGS_PATH = os.path.join(BASE_DIR, "settings.json")


def find_serial_port():
    if "SL_SERIAL_PORT" in os.environ:
        return os.environ["SL_SERIAL_PORT"]
    ports = list(serial.tools.list_ports.comports())
    for p in ports:
        dev_lower = p.device.lower()
        desc_lower = (p.description or "").lower()
        if any(k in dev_lower or k in desc_lower for k in ["usb", "usbmodem", "usbserial", "cp210", "ch340", "ftdi"]):
            return p.device
    return "COM3"

SERIAL_PORT = find_serial_port()
SERIAL_BAUD = 115200
DEMO_MODE = os.environ.get("SL_DEMO_MODE", "1").lower() in ("1", "true", "yes")

DEFAULT_SETTINGS = {
    "device_name": "Street Light 01",
    "device_id": "ESP32_01",
    "lux_threshold": 100,      # below this, it's considered "dark enough to need light"
    "min_current": 0.10,       # A - below this while SSR is ON => possible lamp failure
    "max_current": 0.50,       # A - above this => over-current fault
    "assumed_voltage": 230,    # V - used only to estimate power, not measured
    "sampling_interval": 1,    # seconds
}

MAX_LIVE_POINTS = 300      # how many recent readings are kept in memory for the graph
MAX_ALERTS = 100

os.makedirs(DATA_DIR, exist_ok=True)

app = Flask(__name__, static_folder="static", template_folder="templates")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# ---------------------------------------------------------------------------
# In-memory state (shared between the serial thread and Flask routes)
# ---------------------------------------------------------------------------
state_lock = threading.Lock()

latest_reading = {
    "device": None,
    "lux": None,
    "current": None,
    "ssr": False,
    "status": "unknown",
    "power": None,
    "timestamp": None,
}

esp32_connected = False
recent_readings = deque(maxlen=MAX_LIVE_POINTS)
alerts = deque(maxlen=MAX_ALERTS)
settings = dict(DEFAULT_SETTINGS)

serial_conn = None
serial_write_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Settings persistence
# ---------------------------------------------------------------------------
def load_settings():
    global settings
    if os.path.exists(SETTINGS_PATH):
        try:
            with open(SETTINGS_PATH, "r") as f:
                loaded = json.load(f)
            settings = {**DEFAULT_SETTINGS, **loaded}
        except (json.JSONDecodeError, OSError):
            settings = dict(DEFAULT_SETTINGS)
    else:
        save_settings()


def save_settings():
    with open(SETTINGS_PATH, "w") as f:
        json.dump(settings, f, indent=2)


# ---------------------------------------------------------------------------
# CSV logging
# ---------------------------------------------------------------------------
def ensure_csv_header():
    if not os.path.exists(CSV_PATH) or os.path.getsize(CSV_PATH) == 0:
        with open(CSV_PATH, "w", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["timestamp", "lux", "current", "power", "ssr", "status"])


def append_csv_row(reading):
    with open(CSV_PATH, "a", newline="") as f:
        writer = csv.writer(f)
        writer.writerow([
            reading["timestamp"],
            reading["lux"],
            reading["current"],
            reading["power"],
            reading["ssr"],
            reading["status"],
        ])


# ---------------------------------------------------------------------------
# Fault Evaluation & Alert Engine
# ---------------------------------------------------------------------------
def evaluate_status(lux, current, ssr_on):
    # 1. Check Sensor validity
    if lux is None or lux < 0 or lux > 100000:
        return "sensor_fault"

    # 2. Daytime Light Stuck ON / Daytime Energy Waste
    lux_threshold = settings.get("lux_threshold", 100)
    if lux > (lux_threshold + 50) and (ssr_on or current > 0.05):
        return "daytime_energy_waste"

    # 3. Relay is OFF state
    if not ssr_on:
        if current > settings.get("min_current", 0.10):
            return "relay_short_fault"
        return "off"

    # 4. Relay is ON state
    # Over-current check
    if current > settings.get("max_current", 0.50):
        return "over_current"

    # Lamp failure check (No current while SSR is ON)
    if current < settings.get("min_current", 0.10):
        return "possible_lamp_failure"

    return "normal"


def auto_cutoff_ssr():
    command = json.dumps({"cmd": "ssr", "state": False}) + "\n"
    with serial_write_lock:
        if serial_conn is not None and serial_conn.is_open:
            try:
                serial_conn.write(command.encode("utf-8"))
            except serial.SerialException:
                pass


def push_alert(alert_type, message, severity):
    alert = {
        "type": alert_type,
        "message": message,
        "severity": severity,
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    alerts.appendleft(alert)
    socketio.emit("alert", alert)


# ---------------------------------------------------------------------------
# Serial reader thread
# ---------------------------------------------------------------------------

def process_line(line, previous_status):
    payload = {}
    if line.startswith("{") and line.endswith("}"):
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            payload = {}

    if not payload:
        # Fallback parser for plain text sketch output like "Lux: 150.0 Lx | Voltage: 1.65 V"
        lux_match = re.search(r"Lux:\s*([\d.]+)", line, re.IGNORECASE)
        curr_match = re.search(r"Current:\s*([\d.]+)", line, re.IGNORECASE)
        volt_match = re.search(r"Voltage:\s*([\d.]+)", line, re.IGNORECASE)

        if lux_match:
            payload["lux"] = float(lux_match.group(1))
        if curr_match:
            payload["current"] = float(curr_match.group(1))
        elif volt_match:
            v = float(volt_match.group(1))
            payload["current"] = round(max(0.0, (v - 1.65) / 0.185), 3)

    lux = payload.get("lux")
    current = payload.get("current", 0.0)
    ssr_on = bool(payload.get("ssr", False))
    device = payload.get("device", settings.get("device_id", "ESP32_01"))

    if lux is None:
        return previous_status

    status = evaluate_status(lux, current, ssr_on)
    power = round(current * settings["assumed_voltage"], 1) if (ssr_on or current > 0.05) else 0.0
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    reading = {
        "device": device,
        "lux": round(float(lux), 1),
        "current": round(float(current), 3),
        "power": power,
        "ssr": ssr_on,
        "status": status,
        "timestamp": timestamp,
    }

    with state_lock:
        latest_reading.update(reading)
        recent_readings.append(reading)

    append_csv_row(reading)
    socketio.emit("sensor_update", reading)

    if status != previous_status:
        if status == "possible_lamp_failure":
            push_alert("LAMP_FAILURE", f"{settings['device_name']}: Lamp failure detected! SSR is ON but current is {reading['current']} A (below min threshold {settings['min_current']} A). Bulb may be burnt or disconnected.", "danger")
        elif status == "over_current":
            push_alert("OVER_CURRENT", f"{settings['device_name']}: Over-current fault! Current is {reading['current']} A (exceeds max threshold {settings['max_current']} A). Initiating emergency auto-cutoff.", "danger")
            auto_cutoff_ssr()
        elif status == "daytime_energy_waste":
            push_alert("DAYTIME_ENERGY_WASTE", f"{settings['device_name']}: Daytime energy waste detected! Lamp is drawing current during bright daylight ({reading['lux']} Lux).", "warning")
        elif status == "relay_short_fault":
            push_alert("RELAY_FAULT", f"{settings['device_name']}: Relay short-circuit detected! Current ({reading['current']} A) flowing while SSR is reported OFF.", "danger")
        elif status == "sensor_fault":
            push_alert("SENSOR_FAULT", f"{settings['device_name']}: BH1750 Lux sensor output error or hardware wire disconnect.", "warning")
        elif status in ("normal", "off") and previous_status in ("possible_lamp_failure", "over_current", "daytime_energy_waste", "relay_short_fault", "sensor_fault"):
            push_alert("SYSTEM_RECOVERED", f"{settings['device_name']}: Malfunction resolved. System state restored to {status.upper()}.", "success")

    return status



def serial_reader_loop():
    global serial_conn, esp32_connected
    previous_status = "unknown"

    sim_angle = 0.0

    while True:
        try:
            target_port = find_serial_port()
            if serial_conn is None or not serial_conn.is_open:
                serial_conn = serial.Serial(target_port, SERIAL_BAUD, timeout=2)
                esp32_connected = True
                socketio.emit("connection_status", {"esp32": "online"})
                time.sleep(1)

            raw = serial_conn.readline().decode("utf-8", errors="ignore").strip()
            if raw:
                previous_status = process_line(raw, previous_status)

        except (serial.SerialException, OSError):
            if esp32_connected:
                esp32_connected = False
                socketio.emit("connection_status", {"esp32": "offline"})
            serial_conn = None

            if DEMO_MODE:
                sim_angle += 0.05
                sim_lux = max(0, round(120 + 100 * math.sin(sim_angle) + random.uniform(-5, 5), 1))
                ssr_state = sim_lux < settings.get("lux_threshold", 100)
                sim_current = round(0.22 + random.uniform(-0.02, 0.02), 3) if ssr_state else 0.0
                mock_payload = json.dumps({
                    "device": settings.get("device_id", "ESP32_01"),
                    "lux": sim_lux,
                    "current": sim_current,
                    "ssr": ssr_state
                })
                previous_status = process_line(mock_payload, previous_status)
                time.sleep(1)
            else:
                time.sleep(2)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    with state_lock:
        data = dict(latest_reading)
    data["esp32_connected"] = esp32_connected
    return jsonify(data)


@app.route("/api/live")
def api_live():
    with state_lock:
        return jsonify(list(recent_readings))


@app.route("/api/history")
def api_history():
    limit = int(request.args.get("limit", 200))
    rows = []
    if os.path.exists(CSV_PATH):
        with open(CSV_PATH, "r", newline="") as f:
            reader = csv.DictReader(f)
            rows = list(reader)
    return jsonify(rows[-limit:])


@app.route("/api/history/export")
def api_history_export():
    return send_from_directory(DATA_DIR, "sensor_data.csv", as_attachment=True)


@app.route("/api/alerts")
def api_alerts():
    return jsonify(list(alerts))


@app.route("/api/ssr", methods=["POST"])
def api_ssr():
    body = request.get_json(silent=True) or {}
    state = bool(body.get("state", False))

    command = json.dumps({"cmd": "ssr", "state": state}) + "\n"
    sent = False
    with serial_write_lock:
        if serial_conn is not None and serial_conn.is_open:
            try:
                serial_conn.write(command.encode("utf-8"))
                sent = True
            except serial.SerialException:
                sent = False

    return jsonify({"sent": sent, "requested_state": state})


@app.route("/api/settings", methods=["GET", "POST"])
def api_settings():
    if request.method == "POST":
        body = request.get_json(silent=True) or {}
        settings.update({k: body[k] for k in DEFAULT_SETTINGS if k in body})
        save_settings()
        return jsonify(settings)
    return jsonify(settings)


@app.route("/api/test/trigger_fault", methods=["GET", "POST"])
def api_test_trigger_fault():
    fault_type = request.args.get("type") or (request.get_json(silent=True) or {}).get("type", "lamp_failure")

    if fault_type == "over_current":
        payload = {"device": settings.get("device_id", "ESP32_01"), "lux": 15.0, "current": 0.88, "ssr": True}
    elif fault_type == "daytime_waste":
        payload = {"device": settings.get("device_id", "ESP32_01"), "lux": 420.0, "current": 0.25, "ssr": True}
    elif fault_type == "relay_fault":
        payload = {"device": settings.get("device_id", "ESP32_01"), "lux": 180.0, "current": 0.32, "ssr": False}
    elif fault_type == "normal":
        payload = {"device": settings.get("device_id", "ESP32_01"), "lux": 20.0, "current": 0.22, "ssr": True}
    else:  # default: lamp_failure
        payload = {"device": settings.get("device_id", "ESP32_01"), "lux": 12.0, "current": 0.00, "ssr": True}

    with state_lock:
        prev_status = latest_reading.get("status", "unknown")

    new_status = process_line(json.dumps(payload), prev_status)
    return jsonify({"triggered_fault": fault_type, "payload": payload, "new_status": new_status})


@app.route("/api/health")
def api_health():
    return jsonify({
        "esp32": "online" if esp32_connected else "offline",
        "database": "online",  # CSV storage is always "available" once the folder exists
    })



@app.route("/api/analytics/summary")
def api_analytics_summary():
    if not os.path.exists(CSV_PATH):
        return jsonify({})

    with open(CSV_PATH, "r", newline="") as f:
        rows = list(csv.DictReader(f))

    today = datetime.now().strftime("%Y-%m-%d")
    todays_rows = [r for r in rows if r["timestamp"].startswith(today)]
    if not todays_rows:
        return jsonify({
            "avg_lux": 0, "avg_current": 0, "operating_seconds": 0,
            "fault_count": 0, "energy_kwh": 0,
        })

    lux_vals = [float(r["lux"]) for r in todays_rows if r["lux"]]
    current_vals = [float(r["current"]) for r in todays_rows if r["current"]]
    on_rows = [r for r in todays_rows if r["ssr"] in ("True", "true", "1")]
    fault_rows = [r for r in todays_rows if r["status"] in ("possible_lamp_failure", "over_current")]

    interval = settings["sampling_interval"]
    operating_seconds = len(on_rows) * interval
    energy_kwh = sum(float(r["power"]) for r in on_rows if r["power"]) * interval / 3600 / 1000

    return jsonify({
        "avg_lux": round(sum(lux_vals) / len(lux_vals), 1) if lux_vals else 0,
        "avg_current": round(sum(current_vals) / len(current_vals), 3) if current_vals else 0,
        "operating_seconds": operating_seconds,
        "fault_count": len(fault_rows),
        "energy_kwh": round(energy_kwh, 3),
    })


if __name__ == "__main__":
    load_settings()
    ensure_csv_header()

    reader_thread = threading.Thread(target=serial_reader_loop, daemon=True)
    reader_thread.start()

    port = int(os.environ.get("PORT", 5050))
    print("\n=======================================================")
    print(" Street Light Monitoring Dashboard running at:")
    print(f" http://localhost:{port}")
    print("=======================================================\n")
    socketio.run(app, host="0.0.0.0", port=port, debug=False)
