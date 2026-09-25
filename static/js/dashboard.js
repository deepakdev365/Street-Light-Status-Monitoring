const socket = io();

// ---------- Navigation ----------
const views = document.querySelectorAll('.view');
const navItems = document.querySelectorAll('.nav-item');
const titles = {
  dashboard: ['Dashboard', 'Real-time intelligent street light monitoring'],
  live: ['Live Data', 'Raw readings straight from each sensor'],
  analytics: ["Analytics", "Today's performance summary"],
  history: ['History', 'Logged readings from the CSV data store'],
  alerts: ['Alerts', 'Fault and recovery events'],
  settings: ['Settings', 'Thresholds and device configuration'],
};

const mobileMenuToggle = document.getElementById('mobileMenuToggle');
const mainNav = document.getElementById('mainNav');

if (mobileMenuToggle && mainNav) {
  mobileMenuToggle.addEventListener('click', () => {
    mainNav.classList.toggle('mobile-expanded');
  });
}

navItems.forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    navItems.forEach(b => b.classList.toggle('active', b === btn));
    views.forEach(v => v.classList.toggle('hidden', v.id !== `view-${view}`));
    document.getElementById('pageTitle').textContent = titles[view][0];
    document.getElementById('pageSubtitle').textContent = titles[view][1];
    if (mainNav) mainNav.classList.remove('mobile-expanded');
    if (view === 'history') loadHistory();
    if (view === 'analytics') loadAnalytics();
    if (view === 'settings') loadSettings();
  });
});

// ---------- Connection status ----------
function setConnection(online) {
  const dotClass = online ? 'dot-online' : 'dot-offline';
  document.getElementById('topDot').className = `dot ${dotClass}`;
  document.getElementById('sidebarDot').className = `dot ${dotClass}`;
  document.getElementById('topStatusText').textContent = online ? 'ESP32 CONNECTED' : 'ESP32 DISCONNECTED';
  document.getElementById('sidebarStatusText').textContent = online ? 'Online' : 'Offline';

  const statusDots = document.querySelectorAll('#systemStatusList .dot');
  ['ESP32', 'BH1750', 'ACS712', 'SSR'].forEach((_, i) => {
    statusDots[i].className = `dot ${online ? 'dot-online' : 'dot-offline'}`;
  });
}

socket.on('connect', () => fetchInitialStatus());
socket.on('connection_status', (msg) => setConnection(msg.esp32 === 'online'));

// ---------- Live chart ----------
const ctx = document.getElementById('liveChart').getContext('2d');
let currentMetric = 'lux';
const metricMeta = {
  lux: { label: 'Lux', color: '#4C8DFF' },
  current: { label: 'Current (A)', color: '#3ECF8E' },
  power: { label: 'Power (W)', color: '#F5A623' },
};

const liveChart = new Chart(ctx, {
  type: 'line',
  data: {
    labels: [],
    datasets: [{
      label: metricMeta.lux.label,
      data: [],
      borderColor: metricMeta.lux.color,
      backgroundColor: 'transparent',
      tension: 0.3,
      pointRadius: 0,
      borderWidth: 2,
    }],
  },
  options: {
    animation: false,
    responsive: true,
    scales: {
      x: { ticks: { color: '#7C8798', maxTicksLimit: 8 }, grid: { color: '#232B3D' } },
      y: { ticks: { color: '#7C8798' }, grid: { color: '#232B3D' }, beginAtZero: true },
    },
    plugins: { legend: { display: false } },
  },
});

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentMetric = tab.dataset.metric;
    const meta = metricMeta[currentMetric];
    liveChart.data.datasets[0].label = meta.label;
    liveChart.data.datasets[0].borderColor = meta.color;
    rebuildChartFromBuffer();
  });
});

const readingBuffer = [];
const MAX_POINTS = 60;

function pushReading(reading) {
  readingBuffer.push(reading);
  if (readingBuffer.length > MAX_POINTS) readingBuffer.shift();
  rebuildChartFromBuffer();
}

function rebuildChartFromBuffer() {
  liveChart.data.labels = readingBuffer.map(r => r.timestamp.split(' ')[1] || r.timestamp);
  liveChart.data.datasets[0].data = readingBuffer.map(r => r[currentMetric]);
  liveChart.update('none');
}

// ---------- Dashboard cards ----------
function applyReading(r) {
  document.getElementById('cardLux').textContent = r.lux ?? '--';
  document.getElementById('cardCurrent').textContent = r.current ?? '--';
  document.getElementById('cardPower').textContent = r.power ?? '--';
  document.getElementById('cardVoltageAssumed').textContent = window.__assumedVoltage || 230;

  const ssrEl = document.getElementById('cardSsr');
  ssrEl.textContent = r.ssr ? 'ON' : 'OFF';
  ssrEl.classList.toggle('on', !!r.ssr);

  const toggleBtn = document.getElementById('ssrToggleBtn');
  toggleBtn.textContent = r.ssr ? 'Turn Off' : 'Turn On';
  toggleBtn.dataset.nextState = (!r.ssr).toString();

  document.getElementById('lastUpdate').textContent = r.timestamp ? r.timestamp.split(' ')[1] : '--:--:--';

  setFlag('fLuxFlag', r.lux < 100 ? ['warning', 'Low ambient'] : ['normal', 'Normal']);
  setFlag('fCurrentFlag', statusToFlag(r.status));
  setFlag('fSsrFlag', r.ssr ? ['normal', 'Active'] : ['idle', 'Inactive']);

  updateFaultBanner(r);
  pushReading(r);

  // Live Data view
  document.getElementById('liveLux').innerHTML = `${r.lux ?? '--'} <small>lux</small>`;
  document.getElementById('liveCurrent').innerHTML = `${r.current ?? '--'} <small>A</small>`;
  document.getElementById('liveSsr').textContent = r.ssr ? 'ON' : 'OFF';
  document.getElementById('liveLuxStatus').textContent = 'Sensor: Connected';
  document.getElementById('liveCurrentStatus').textContent = 'Sensor: Connected';
  document.getElementById('liveSsrStatus').textContent = r.ssr ? 'Output: Active' : 'Output: Idle';
  document.getElementById('liveLastUpdate').textContent = r.timestamp ? r.timestamp.split(' ')[1] : '--:--:--';

  setConnection(true);
}

function statusToFlag(status) {
  switch (status) {
    case 'normal': return ['normal', 'Normal'];
    case 'possible_lamp_failure': return ['warning', 'Possible failure'];
    case 'over_current': return ['danger', 'Over-current'];
    case 'off': return ['idle', 'Off'];
    default: return ['idle', 'Unknown'];
  }
}

function setFlag(elId, [kind, text]) {
  const el = document.getElementById(elId);
  const dotClass = { normal: 'dot-online', warning: 'dot-warning', danger: 'dot-offline', idle: 'dot-idle' }[kind] || 'dot-idle';
  el.innerHTML = `<span class="dot ${dotClass}"></span>${text}`;
}

function updateFaultBanner(r) {
  const banner = document.getElementById('faultBanner');
  const title = document.getElementById('faultTitle');
  const detail = document.getElementById('faultDetail');
  banner.className = 'fault-banner';

  if (r.status === 'normal') {
    banner.classList.add('normal');
    title.textContent = 'Street light normal';
    detail.textContent = `Lamp ON · Current ${r.current} A · Lux ${r.lux}`;
  } else if (r.status === 'possible_lamp_failure') {
    banner.classList.add('warning');
    title.textContent = 'Possible lamp failure';
    detail.textContent = `SSR ON but current is only ${r.current} A (expected ≥ threshold)`;
  } else if (r.status === 'over_current') {
    banner.classList.add('danger');
    title.textContent = 'Over-current detected';
    detail.textContent = `Current ${r.current} A exceeds the configured maximum`;
  } else if (r.status === 'off') {
    title.textContent = 'Street light off';
    detail.textContent = 'SSR is off, no current expected.';
  }
}

socket.on('sensor_update', applyReading);

// ---------- SSR control ----------
document.getElementById('ssrToggleBtn').addEventListener('click', async (e) => {
  const btn = e.target;
  const nextState = btn.dataset.nextState === 'true';
  btn.disabled = true;
  try {
    await fetch('/api/ssr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: nextState }),
    });
  } finally {
    btn.disabled = false;
  }
});

// ---------- Alerts System ----------
function playAlertSound(severity) {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = severity === 'danger' ? 'sawtooth' : 'sine';
    const freq = severity === 'danger' ? 880 : 587.33;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);

    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) {}
}

function showToastNotification(a) {
  let toastContainer = document.getElementById('toastContainer');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toastContainer';
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement('div');
  toast.className = `toast-item ${a.severity}`;
  toast.innerHTML = `
    <div class="toast-title">
      <span>${a.severity === 'success' ? '✓' : '⚠'} ${a.type.replace(/_/g, ' ')}</span>
      <span class="toast-close">&times;</span>
    </div>
    <div class="toast-body">${a.message}</div>
  `;

  toast.querySelector('.toast-close').onclick = () => toast.remove();
  toastContainer.appendChild(toast);

  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 6000);
}

function renderAlert(a, prepend = true) {
  const list = document.getElementById('alertsList');
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();

  const icon = a.severity === 'success' ? '✓' : '⚠';
  const div = document.createElement('div');
  div.className = `alert-item ${a.severity}`;
  div.innerHTML = `
    <div class="alert-item-top">
      <span>${icon} ${a.type.replace(/_/g, ' ')}</span>
      <span class="alert-item-time">${a.timestamp}</span>
    </div>
    <div class="alert-item-msg">${a.message}</div>`;
  prepend ? list.prepend(div) : list.appendChild(div);

  const badge = document.getElementById('alertBadge');
  const count = (parseInt(badge.textContent) || 0) + (prepend ? 1 : 0);
  if (prepend) {
    badge.hidden = false;
    badge.textContent = count;
    playAlertSound(a.severity);
    showToastNotification(a);
  }
}

socket.on('alert', (a) => renderAlert(a, true));

async function loadAlerts() {
  const res = await fetch('/api/alerts');
  const items = await res.json();
  const list = document.getElementById('alertsList');
  const empty = list.querySelector('.empty-state');
  if (items.length && empty) empty.remove();
  items.forEach(a => renderAlert(a, false));
}

async function triggerTestFault(type) {
  try {
    await fetch(`/api/test/trigger_fault?type=${type}`, { method: 'POST' });
  } catch (e) {
    console.error('Failed to trigger test fault:', e);
  }
}



// ---------- History ----------
async function loadHistory() {
  const res = await fetch('/api/history?limit=200');
  const rows = await res.json();
  const body = document.getElementById('historyBody');
  body.innerHTML = rows.slice().reverse().map(r => `
    <tr>
      <td>${r.timestamp}</td>
      <td>${r.lux}</td>
      <td>${r.current}</td>
      <td>${r.power}</td>
      <td>${r.ssr}</td>
      <td>${r.status}</td>
    </tr>`).join('');
}

// ---------- Analytics ----------
let analyticsChart = null;
async function loadAnalytics() {
  const res = await fetch('/api/analytics/summary');
  const s = await res.json();
  document.getElementById('sumAvgLux').textContent = `${s.avg_lux ?? 0} lx`;
  document.getElementById('sumAvgCurrent').textContent = `${s.avg_current ?? 0} A`;
  const hrs = Math.floor((s.operating_seconds ?? 0) / 3600);
  const mins = Math.floor(((s.operating_seconds ?? 0) % 3600) / 60);
  document.getElementById('sumOperating').textContent = `${hrs}h ${mins}m`;
  document.getElementById('sumFaults').textContent = s.fault_count ?? 0;
  document.getElementById('sumEnergy').textContent = `${s.energy_kwh ?? 0} kWh`;

  const histRes = await fetch('/api/history?limit=200');
  const rows = await histRes.json();
  const labels = rows.map(r => r.timestamp.split(' ')[1] || r.timestamp);
  const luxData = rows.map(r => parseFloat(r.lux));
  const currentData = rows.map(r => parseFloat(r.current));

  const ctx2 = document.getElementById('analyticsChart').getContext('2d');
  if (analyticsChart) analyticsChart.destroy();
  analyticsChart = new Chart(ctx2, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Lux', data: luxData, borderColor: '#4C8DFF', backgroundColor: 'transparent', pointRadius: 0, tension: 0.3, yAxisID: 'y' },
        { label: 'Current (A)', data: currentData, borderColor: '#3ECF8E', backgroundColor: 'transparent', pointRadius: 0, tension: 0.3, yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true,
      scales: {
        x: { ticks: { color: '#7C8798', maxTicksLimit: 8 }, grid: { color: '#232B3D' } },
        y: { position: 'left', ticks: { color: '#7C8798' }, grid: { color: '#232B3D' } },
        y1: { position: 'right', ticks: { color: '#7C8798' }, grid: { display: false } },
      },
      plugins: { legend: { labels: { color: '#E8EBF0' } } },
    },
  });
}

// ---------- Settings ----------
async function loadSettings() {
  const res = await fetch('/api/settings');
  const s = await res.json();
  document.getElementById('setDeviceName').value = s.device_name;
  document.getElementById('setDeviceId').value = s.device_id;
  document.getElementById('setLuxThreshold').value = s.lux_threshold;
  document.getElementById('setMinCurrent').value = s.min_current;
  document.getElementById('setMaxCurrent').value = s.max_current;
  document.getElementById('setVoltage').value = s.assumed_voltage;
  document.getElementById('setSampling').value = s.sampling_interval;
  window.__assumedVoltage = s.assumed_voltage;
  document.getElementById('sidebarDeviceId').textContent = s.device_id;
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    device_name: document.getElementById('setDeviceName').value,
    device_id: document.getElementById('setDeviceId').value,
    lux_threshold: parseFloat(document.getElementById('setLuxThreshold').value),
    min_current: parseFloat(document.getElementById('setMinCurrent').value),
    max_current: parseFloat(document.getElementById('setMaxCurrent').value),
    assumed_voltage: parseFloat(document.getElementById('setVoltage').value),
    sampling_interval: parseFloat(document.getElementById('setSampling').value),
  };
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  window.__assumedVoltage = body.assumed_voltage;
  const confirm = document.getElementById('saveConfirm');
  confirm.hidden = false;
  setTimeout(() => (confirm.hidden = true), 2000);
});

// ---------- Initial load ----------
async function fetchInitialStatus() {
  try {
    const res = await fetch('/api/status');
    const s = await res.json();
    setConnection(!!s.esp32_connected);
    if (s.timestamp) applyReading(s);

    const liveRes = await fetch('/api/live');
    const liveRows = await liveRes.json();
    liveRows.forEach(r => readingBuffer.push(r));
    rebuildChartFromBuffer();
  } catch (e) {
    // backend not reachable yet; Socket.IO will retry the connection
  }
  loadAlerts();
  loadSettings();
}

fetchInitialStatus();
