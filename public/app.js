// ─── State ────────────────────────────────────────────────
let refreshInterval = null;
const REFRESH_MS = 5 * 60 * 1000; // 5 minutes

// ─── Connect ──────────────────────────────────────────────
async function connect() {
  const btn = document.getElementById('connectBtn');
  const errDiv = document.getElementById('connectError');

  btn.disabled = true;
  btn.textContent = 'Connecting...';
  errDiv.classList.remove('show');

  try {
    const res = await fetch('/api/connect');
    const data = await res.json();

    if (!data.success) {
      throw new Error(data.error || 'Connection failed');
    }

    // Show dashboard
    document.getElementById('connectScreen').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    document.getElementById('plantName').textContent = data.plantName || 'Solar Dashboard';
    document.getElementById('deviceInfo').textContent = `${data.deviceSn || 'Unknown'} · Plant ID: ${data.plantId}`;

    setStatus('online');
    fetchData();
    startAutoRefresh();

  } catch (err) {
    errDiv.textContent = err.message;
    errDiv.classList.add('show');
    btn.disabled = false;
    btn.textContent = 'Retry Connection';
  }
}

// ─── Fetch Dashboard Data ─────────────────────────────────
async function fetchData() {
  try {
    const res = await fetch('/api/data');
    const data = await res.json();

    if (!data.success) {
      console.error('Data fetch failed:', data.error);
      setStatus('error');
      return;
    }

    updateDashboard(data);
    setStatus('online');

  } catch (err) {
    console.error('Fetch error:', err);
    setStatus('error');
  }
}

// ─── Update Dashboard ─────────────────────────────────────
function updateDashboard(d) {
  // Helpers
  const fmt = (v, unit, dec = 0) => {
    const n = parseFloat(v) || 0;
    return n.toFixed(dec) + ' ' + unit;
  };
  const fmtW = (v) => {
    const n = parseFloat(v) || 0;
    return n >= 1000 ? (n / 1000).toFixed(1) + ' kW' : n.toFixed(0) + ' W';
  };

  // ─── Energy Flow ──────────────────────────────
  const pvW = parseFloat(d.pv?.power) || 0;
  const loadW = parseFloat(d.load?.power) || 0;
  const battChargeW = parseFloat(d.battery?.chargePower) || 0;
  const battDischargeW = parseFloat(d.battery?.dischargePower) || 0;
  const gridW = parseFloat(d.grid?.power) || 0;
  const soc = parseFloat(d.battery?.soc) || 0;

  setText('pvPower', fmtW(pvW));
  setText('loadPower', fmtW(loadW));
  setText('gridPower', fmtW(gridW));
  setText('battSoc', soc.toFixed(0) + '%');

  // Inverter status (SPF 5000ES returns a text string, not a code)
  const invStatusText = d.inverter?.status || 'Online';
  setText('invStatus', invStatusText.length > 20 ? invStatusText.split('+')[0].trim() : invStatusText);

  // Animate flow arrows
  setFlowActive('arrowPvInv', pvW > 10);
  setFlowActive('arrowInvLoad', loadW > 10);
  setFlowActive('arrowInvBatt', battChargeW > 10 || battDischargeW > 10);
  setFlowActive('arrowInvGrid', gridW > 10);

  // ─── PV Card ──────────────────────────────────
  setText('pvPowerCard', fmtW(pvW));
  setText('pvVoltage', fmt(d.pv?.voltage, 'V', 1));
  setText('pvToday', fmt(d.pv?.todayEnergy, 'kWh', 1));
  setText('pvTotal', fmt(d.pv?.totalEnergy, 'kWh', 0));
  setText('pvBadge', pvW > 0 ? 'GENERATING' : 'IDLE');

  // ─── Battery Card ─────────────────────────────
  setText('battVoltage', fmt(d.battery?.voltage, 'V', 1));
  setText('battCharge', fmtW(battChargeW));
  setText('battDischarge', fmtW(battDischargeW));
  setText('battTemp', fmt(d.battery?.temperature, '°C', 1));
  setText('battChargeToday', fmt(d.battery?.chargeToday, 'kWh', 1));
  setText('battDischargeToday', fmt(d.battery?.dischargeToday, 'kWh', 1));

  // SOC bar
  const socFill = document.getElementById('socFill');
  socFill.style.width = Math.min(soc, 100) + '%';
  socFill.className = 'soc-fill' + (soc < 20 ? ' low' : soc < 50 ? ' mid' : '');
  setText('socText', soc.toFixed(0) + '%');

  const battState = battChargeW > 10 ? 'CHARGING' : battDischargeW > 10 ? 'DISCHARGING' : 'IDLE';
  setText('battBadge', battState);

  // ─── Load Card ────────────────────────────────
  setText('loadPowerCard', fmtW(loadW));
  setText('loadVoltage', fmt(d.load?.voltage, 'V', 1));
  setText('loadFreq', fmt(d.load?.frequency, 'Hz', 1));
  setText('loadToday', fmt(d.load?.todayEnergy, 'kWh', 1));
  setText('loadBadge', loadW > 0 ? 'ACTIVE' : 'NO LOAD');

  // ─── Grid Card ────────────────────────────────
  setText('gridPowerCard', fmtW(gridW));
  setText('gridVoltage', fmt(d.grid?.voltage, 'V', 1));
  setText('gridImport', fmt(d.grid?.importToday, 'kWh', 1));
  setText('gridExport', fmt(d.grid?.exportToday, 'kWh', 1));

  const gridStatus = d.grid?.status;
  const isOffGrid = gridStatus === 'off-grid';
  setText('gridBadge', isOffGrid ? 'OFF-GRID' : 'CONNECTED');

  // ─── Inverter Card ────────────────────────────
  setText('invModel', d.inverter?.model || 'SPF 5000ES');
  setText('invSerial', d.inverter?.serial || '—');
  setText('invTemp', fmt(d.inverter?.temperature, '°C', 1));
  const invCardStatus = d.inverter?.status || '—';
  setText('invStatusCard', invCardStatus);
  setText('invBadge', invCardStatus.length > 15 ? invCardStatus.split('+')[0].trim() : invCardStatus);

  // ─── Energy Summary ───────────────────────────
  setText('energyToday', fmt(d.energy?.pvToday || d.pv?.todayEnergy, 'kWh', 1));
  setText('energyMonth', fmt(d.energy?.consumptionToday, 'kWh', 1));
  setText('energyTotal', fmt(d.energy?.pvTotal || d.pv?.totalEnergy, 'kWh', 0));

  const currentW = parseFloat(d.plant?.currentPower) || 0;
  setText('currentOutput', fmtW(currentW));

  // ─── Update timestamp ─────────────────────────
  const ts = d.timestamp ? new Date(d.timestamp) : new Date();
  document.getElementById('lastUpdate').textContent =
    'Updated: ' + ts.toLocaleTimeString() + (d.cached ? ' (cached)' : '');
}

// ─── Helpers ──────────────────────────────────────────────
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setStatus(status) {
  const badge = document.getElementById('statusBadge');
  const text = document.getElementById('statusText');

  badge.className = 'status-badge ' + (status === 'online' ? 'online' : '');
  text.textContent = status === 'online' ? 'Online' : status === 'error' ? 'Error' : 'Offline';
}

function setFlowActive(id, active) {
  const el = document.getElementById(id);
  if (!el) return;
  if (active) {
    el.classList.add('active', 'flowing');
  } else {
    el.classList.remove('active', 'flowing');
  }
}

// ─── Auto Refresh ─────────────────────────────────────────
function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(fetchData, REFRESH_MS);
}

// ─── Auto-connect on load if already connected ────────────
window.addEventListener('load', async () => {
  try {
    const res = await fetch('/api/status');
    const status = await res.json();

    if (status.connected && status.plantName) {
      document.getElementById('connectScreen').classList.add('hidden');
      document.getElementById('dashboard').classList.remove('hidden');
      document.getElementById('plantName').textContent = status.plantName;
      document.getElementById('deviceInfo').textContent = `${status.deviceSn || 'Unknown'}`;
      setStatus('online');
      fetchData();
      startAutoRefresh();
    }
  } catch (e) {
    // Not connected yet, show connect screen
  }
});
