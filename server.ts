import express from "express";
import { createServer as createViteServer } from "vite";
import crypto from "crypto";
import dotenv from "dotenv";
import path from "path";

dotenv.config();

// ─── Growatt Config ───────────────────────────────────────────────────────────
const GROWATT_BASE = 'https://openapi.growatt.com';
// Use a real browser User-Agent — Growatt CDN blacklists the Dalvik/PyPi_GrowattServer string
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// ─── Logger ──────────────────────────────────────────────────────────────────
const LOG_LEVELS: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'DEBUG'] ?? LOG_LEVELS.DEBUG;
let requestCounter = 0;

function log(level: string, tag: string, message: string, data?: any) {
  if (LOG_LEVELS[level] < LOG_LEVEL) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level}] [${tag}]`;
  if (data !== undefined) {
    const serialized = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    console.log(`${prefix} ${message}\n${serialized}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

function logRequest(tag: string, method: string, url: string, headers: any, body?: any) {
  const reqId = ++requestCounter;
  log('DEBUG', tag, `>>> HTTP ${method} ${url} [req#${reqId}]`);
  log('DEBUG', tag, `    Headers: ${JSON.stringify(headers)}`);
  if (body) log('DEBUG', tag, `    Body: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return reqId;
}

function logResponse(tag: string, reqId: number, status: number, headers: any, bodyPreview?: string) {
  log('DEBUG', tag, `<<< [req#${reqId}] Status: ${status}`);
  const hdrs: any = {};
  if (headers?.forEach) headers.forEach((v: any, k: any) => { hdrs[k] = v; });
  log('DEBUG', tag, `    Response Headers:`, hdrs);
  if (bodyPreview) log('DEBUG', tag, `    Body (first 500): ${bodyPreview.substring(0, 500)}`);
}

// ─── Session Cache ────────────────────────────────────────────────────────────
let session: any = {
  cookies: null,
  userId: null,
  plantId: null,
  plantName: null,
  deviceSn: null,
  lastLogin: null,
  lastData: null,
  lastFetch: 0
};

// Session expires after 30 minutes
const SESSION_TTL = 30 * 60 * 1000;
// Cache data for 60 seconds to avoid hammering API
const DATA_CACHE_TTL = 60 * 1000;

// ─── Growatt Modified MD5 Hash ────────────────────────────────────────────────
// Growatt uses MD5 but replaces '0' with 'c' at every even index position
function growattHash(password: string) {
  const rawMd5 = crypto.createHash('md5').update(password, 'utf8').digest('hex');
  let hash = rawMd5;
  for (let i = 0; i < hash.length; i += 2) {
    if (hash[i] === '0') {
      hash = hash.substring(0, i) + 'c' + hash.substring(i + 1);
    }
  }
  log('DEBUG', 'HASH', `Password hashed: raw_md5=${rawMd5.substring(0,8)}... modified=${hash.substring(0,8)}... (len=${hash.length})`);
  return hash;
}

// ─── Cookie Jar (Map-based, deduplicates by name) ────────────────────────────
const cookieJar = new Map();

function captureCookies(res: Response) {
  const setCookies = (res.headers as any).getSetCookie
    ? (res.headers as any).getSetCookie()
    : (res.headers.get('set-cookie') || '').split(/,(?=\s*\w+=)/).filter(Boolean);

  log('DEBUG', 'COOKIES', `Raw Set-Cookie headers (${setCookies.length}):`, setCookies);

  for (const raw of setCookies) {
    const pair = raw.split(';')[0].trim();
    if (!pair || !pair.includes('=')) continue;
    const eqIdx = pair.indexOf('=');
    const name = pair.substring(0, eqIdx).trim();
    const value = pair.substring(eqIdx + 1).trim();
    if (name) {
      cookieJar.set(name, value);
      log('DEBUG', 'COOKIES', `  Set: ${name}=${value.substring(0, 30)}${value.length > 30 ? '...' : ''}`);
    }
  }

  // Rebuild session.cookies from jar
  session.cookies = Array.from(cookieJar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ') || null;

  log('DEBUG', 'COOKIES', `Cookie jar now has ${cookieJar.size} entries`);
}

// ─── Safe JSON Parse ──────────────────────────────────────────────────────────
async function safeJson(res: Response, label = 'API') {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`[${label}] Non-JSON response (status ${res.status}):`, text.substring(0, 300));
    
    if (text.trim().startsWith('<')) {
      throw new Error(`session_expired: ${label} returned HTML`);
    }

    // Try to salvage truncated JSON
    let current = text;
    for (let i = 0; i < 10; i++) {
      const commaIdx = current.lastIndexOf(',');
      if (commaIdx === -1) break;
      current = current.substring(0, commaIdx);
      
      const endings = ['}', '}}', '}}}', '}}}}', ']}', ']}}'];
      for (const ending of endings) {
        try {
          const parsed = JSON.parse(current + ending);
          console.log(`[${label}] Successfully salvaged truncated JSON!`);
          return parsed;
        } catch (err) {}
      }
    }

    console.error(`[${label}] Could not salvage JSON. Returning empty object.`);
    return {}; // Return empty object so we don't crash the whole fetch process
  }
}

// ─── HTTP Helper ──────────────────────────────────────────────────────────────
async function growattFetch(endpoint: string, options: any = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${GROWATT_BASE}/${endpoint}`;
  const method = options.method || 'GET';
  const headers: any = {
    'User-Agent': USER_AGENT,
    ...options.headers || {}
  };

  if (session.cookies) {
    headers['Cookie'] = session.cookies;
  }

  const reqId = logRequest('FETCH', method, url, headers, options.body);

  let res;
  try {
    res = await fetch(url, { ...options, headers });
  } catch (err: any) {
    log('ERROR', 'FETCH', `[req#${reqId}] Network error: ${err.message}`, err.stack);
    throw err;
  }

  logResponse('FETCH', reqId, res.status, res.headers);
  captureCookies(res);
  return res;
}

// ─── Login ────────────────────────────────────────────────────────────────────
async function login() {
  const TAG = 'LOGIN';
  const username = process.env.GROWATT_USERNAME;
  const password = process.env.GROWATT_PASSWORD;

  if (!username || !password) {
    log('ERROR', TAG, 'GROWATT_USERNAME and/or GROWATT_PASSWORD not set in .env');
    throw new Error('GROWATT_USERNAME and GROWATT_PASSWORD must be set in .env');
  }

  log('INFO', TAG, `=== Login attempt for user: ${username} ===`);
  log('INFO', TAG, `Using User-Agent: ${USER_AGENT}`);
  log('INFO', TAG, `Target: ${GROWATT_BASE}/newTwoLoginAPI.do`);

  session.cookies = null;
  cookieJar.clear();
  log('DEBUG', TAG, 'Cleared session cookies and cookie jar');

  const hashedPw = growattHash(password);

  const loginUrl = `${GROWATT_BASE}/newTwoLoginAPI.do`;
  const loginBody = new URLSearchParams({
    userName: username,
    password: hashedPw
  }).toString();
  const loginHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': USER_AGENT
  };

  const reqId = logRequest(TAG, 'POST', loginUrl, loginHeaders, loginBody);

  let res;
  try {
    // Let fetch follow redirects automatically (like Python requests.Session)
    res = await fetch(loginUrl, {
      method: 'POST',
      headers: loginHeaders,
      body: loginBody
    });
  } catch (err: any) {
    log('ERROR', TAG, `[req#${reqId}] Network error during login fetch`, err.stack);
    throw err;
  }

  logResponse(TAG, reqId, res.status, res.headers);
  log('INFO', TAG, `Final URL after redirects: ${res.url}`);
  log('INFO', TAG, `Redirected: ${res.redirected}`);
  captureCookies(res);

  // Read response body
  const responseText = await res.text();
  log('INFO', TAG, `Response body length: ${responseText.length} chars`);
  log('DEBUG', TAG, `Response body (first 500 chars):\n${responseText.substring(0, 500)}`);

  // Parse JSON
  let data;
  try {
    data = JSON.parse(responseText);
    log('DEBUG', TAG, 'Parsed JSON successfully, top-level keys:', Object.keys(data));
  } catch (e) {
    log('ERROR', TAG, `JSON parse failed. Raw body: "${responseText.substring(0, 200)}"`);
    log('ERROR', TAG, `Content-Type was: ${res.headers.get('content-type')}`);
    log('ERROR', TAG, `Status was: ${res.status}`);
    throw new Error(`Login returned non-JSON (status ${res.status}): "${responseText.substring(0, 120)}"`);
  }

  // Validate response
  if (!data.back) {
    log('ERROR', TAG, 'Response has no "back" field. Full response:', data);
    throw new Error(`Login failed: no "back" in response — ${JSON.stringify(data).substring(0, 200)}`);
  }

  if (!data.back.success) {
    log('ERROR', TAG, 'Login not successful:', data.back);
    const msg = data.back?.msg || data.msg || JSON.stringify(data);
    throw new Error(`Login failed: ${msg}`);
  }

  const user = data.back.user;
  const plants = data.back.data;

  log('INFO', TAG, `Login successful! User ID: ${user?.id}, Country: ${user?.country}`);
  log('DEBUG', TAG, `User object keys:`, user ? Object.keys(user) : 'null');
  log('DEBUG', TAG, `Plants received: ${plants?.length || 0}`, plants?.map((p: any) => ({ id: p.plantId, name: p.plantName })));

  if (!plants || plants.length === 0) {
    log('ERROR', TAG, 'No plants found in login response');
    throw new Error('Login succeeded but no plants found');
  }

  session.userId = user.id;
  session.plantId = plants[0].plantId;
  session.plantName = plants[0].plantName;
  session.lastLogin = Date.now();

  log('INFO', TAG, `Session set: plant="${session.plantName}" (${session.plantId}), userId=${session.userId}`);

  // Discover devices
  await discoverDevices();

  log('INFO', TAG, `=== Login complete. Device: ${session.deviceSn || 'NONE'} ===`);

  return {
    plantName: session.plantName,
    plantId: session.plantId,
    userId: session.userId,
    country: user.country || 'Unknown',
    deviceSn: session.deviceSn
  };
}

// ─── Ensure Session ───────────────────────────────────────────────────────────
async function ensureSession() {
  if (!session.cookies || !session.lastLogin || (Date.now() - session.lastLogin > SESSION_TTL)) {
    await login();
  }
}

// Re-login and retry once if a data call returns "error" text
async function withSessionRetry(fn: () => Promise<any>) {
  try {
    return await fn();
  } catch (err: any) {
    if (err.message && (err.message.includes('non-JSON') || err.message.includes('session_expired'))) {
      console.log('Session may have expired, re-logging in...');
      session.lastLogin = null;
      await ensureSession();
      return await fn();
    }
    throw err;
  }
}

// ─── Discover Devices ─────────────────────────────────────────────────────────
async function discoverDevices() {
  const TAG = 'DEVICES';
  log('INFO', TAG, `=== Discovering devices for plant ${session.plantId} ===`);

  // Method 1: getAllDeviceListTwo
  log('INFO', TAG, 'Trying Method 1: getAllDeviceListTwo');
  let res = await growattFetch(
    `newTwoPlantAPI.do?op=getAllDeviceListTwo&plantId=${session.plantId}&pageNum=1&pageSize=20`
  );
  let data = await safeJson(res, 'DeviceListTwo');
  log('DEBUG', TAG, 'Method 1 response keys:', Object.keys(data));
  log('DEBUG', TAG, 'Method 1 full response:', JSON.stringify(data).substring(0, 1000));
  let devices = data.deviceList || [];

  // Method 2: getAllDeviceList (fallback)
  if (devices.length === 0) {
    log('INFO', TAG, 'Method 1 returned 0 devices. Trying Method 2: getAllDeviceList');
    res = await growattFetch(
      `newTwoPlantAPI.do?op=getAllDeviceList&plantId=${session.plantId}&language=1`
    );
    data = await safeJson(res, 'DeviceListAll');
    log('DEBUG', TAG, 'Method 2 response keys:', Object.keys(data));
    log('DEBUG', TAG, 'Method 2 full response:', JSON.stringify(data).substring(0, 1000));
    devices = data.deviceList || [];
  }

  if (devices.length > 0) {
    session.deviceSn = devices[0].deviceSn || devices[0].alias || devices[0].sn;
    log('INFO', TAG, `Found ${devices.length} device(s). Using: ${session.deviceSn}`);
    log('DEBUG', TAG, 'All devices:', devices.map((d: any) => ({
      sn: d.deviceSn || d.sn,
      type: d.deviceType,
      status: d.status,
      lost: d.lost,
      allKeys: Object.keys(d)
    })));
  } else {
    log('WARN', TAG, 'No devices found from either method!');
    log('WARN', TAG, 'Last raw response:', JSON.stringify(data).substring(0, 500));
  }

  return devices;
}

// ─── Get Storage/Inverter Data ────────────────────────────────────────────────
async function getStorageData() {
  const TAG = 'STORAGE';
  log('INFO', TAG, `=== Fetching storage data for device ${session.deviceSn} ===`);

  if (!session.deviceSn) {
    log('ERROR', TAG, 'No device SN in session!');
    throw new Error('No device discovered. Try reconnecting.');
  }

  let detailData: any = {};
  let energyData: any = {};
  let paramsData: any = {};

  // 1) Storage detail
  try {
    log('INFO', TAG, 'Fetching StorageInfo_sacolar...');
    const detailRes = await growattFetch(`newStorageAPI.do?op=getStorageInfo_sacolar&storageId=${session.deviceSn}`);
    detailData = await safeJson(detailRes, 'StorageDetail');
    log('DEBUG', TAG, 'StorageDetail keys:', Object.keys(detailData));
  } catch (e: any) {
    log('ERROR', TAG, `StorageDetail failed: ${e.message}`);
    if (e.message.includes('session_expired')) throw e;
  }

  // 2) Energy overview
  try {
    log('INFO', TAG, 'Fetching EnergyOverviewData_sacolar...');
    const energyRes = await growattFetch(`newStorageAPI.do?op=getEnergyOverviewData_sacolar&plantId=${session.plantId}&storageSn=${session.deviceSn}`, { method: 'POST' });
    energyData = await safeJson(energyRes, 'EnergyOverview');
    log('DEBUG', TAG, 'EnergyOverview keys:', Object.keys(energyData));
  } catch (e: any) {
    log('ERROR', TAG, `EnergyOverview failed: ${e.message}`);
    if (e.message.includes('session_expired')) throw e;
  }

  // 3) Storage params
  try {
    log('INFO', TAG, 'Fetching StorageParams_sacolar...');
    const paramsRes = await growattFetch(`newStorageAPI.do?op=getStorageParams_sacolar&storageId=${session.deviceSn}`);
    paramsData = await safeJson(paramsRes, 'StorageParams');
    log('DEBUG', TAG, 'StorageParams keys:', Object.keys(paramsData));
  } catch (e: any) {
    log('ERROR', TAG, `StorageParams failed: ${e.message}`);
    if (e.message.includes('session_expired')) throw e;
  }

  log('INFO', TAG, '=== Storage data fetch complete ===');
  return {
    detail: detailData,
    energy: energyData.obj || energyData,
    params: paramsData
  };
}

// ─── Plant Detail ─────────────────────────────────────────────────────────────
async function getPlantDetail() {
  const TAG = 'PLANT';
  const today = new Date().toISOString().split('T')[0];
  log('INFO', TAG, `Fetching PlantDetail for plant ${session.plantId}, date=${today}`);
  const res = await growattFetch(
    `PlantDetailAPI.do?plantId=${session.plantId}&type=1&date=${today}`
  );
  const raw = await safeJson(res, 'PlantDetail');
  log('DEBUG', TAG, 'PlantDetail keys:', Object.keys(raw));
  log('DEBUG', TAG, 'PlantDetail.back keys:', raw.back ? Object.keys(raw.back) : 'no back');
  log('DEBUG', TAG, 'PlantDetail full:', JSON.stringify(raw).substring(0, 2000));
  return raw.back || {};
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // ─── API Endpoints ────────────────────────────────────────────────────────────

  // Connect and return plant info
  app.get('/api/connect', async (req, res) => {
    const TAG = 'API/connect';
    log('INFO', TAG, '>>> /api/connect called');
    try {
      const info = await login();
      log('INFO', TAG, 'Connect success:', info);
      res.json({ success: true, method: 'classic', ...info });
    } catch (err: any) {
      log('ERROR', TAG, `Connect failed: ${err.message}`, err.stack);
      res.json({ success: false, error: err.message });
    }
  });

  // Get dashboard data (with caching)
  app.get('/api/data', async (req, res) => {
    const TAG = 'API/data';
    log('INFO', TAG, '>>> /api/data called');
    try {
      // Return cache if fresh
      if (session.lastData && (Date.now() - session.lastFetch < DATA_CACHE_TTL)) {
        log('INFO', TAG, `Returning cached data (age: ${Date.now() - session.lastFetch}ms)`);
        return res.json({ success: true, cached: true, ...session.lastData });
      }

      await ensureSession();

      // Fetch each data source independently — don't let one failure kill everything
      let storageRaw: any = { detail: {}, energy: {}, params: {} };
      let plantDetail: any = {};

      try {
        storageRaw = await withSessionRetry(() => getStorageData());
      } catch (e: any) {
        console.error('StorageData error (continuing):', e.message);
        storageRaw = { detail: {}, energy: {}, params: {}, error: e.message };
      }

      try {
        plantDetail = await withSessionRetry(() => getPlantDetail());
      } catch (e: any) {
        console.error('PlantDetail error (continuing):', e.message);
        plantDetail = { error: e.message };
      }

      // Extract and normalize the data
      // sd = storageDetail (top-level from getStorageInfo_sacolar)
      // bean = storageDetailBean (detailed data from getStorageParams_sacolar)
      // energy = energyOverview (from getEnergyOverviewData_sacolar)
      const sd = storageRaw.detail?.obj || storageRaw.detail || {};
      const energy = storageRaw.energy || {};
      const paramsRoot = storageRaw.params?.obj || storageRaw.params || {};
      const bean = paramsRoot.storageDetailBean || {};
      const storageBean = paramsRoot.storageBean || {};
      const plantData = plantDetail.plantData || {};

      // Helper: first non-zero parsed float from multiple candidates
      const pf = (...vals: any[]) => {
        for (const v of vals) {
          const n = parseFloat(v);
          if (!isNaN(n) && n !== 0) return n;
        }
        return 0;
      };

      // Determine grid status from device info or voltage
      const isOffGrid = parseFloat(bean.vac) < 50 && parseFloat(sd.vGrid) > 0;

      const dashData = {
        timestamp: new Date().toISOString(),
        plant: {
          name: session.plantName,
          id: session.plantId,
          currentPower: pf(sd.activePower, sd.outPutPower, bean.outPutPower),
          todayEnergy: pf(sd.epvToday, energy.epvToday),
          monthEnergy: 0,
          totalEnergy: pf(sd.epvTotal, energy.epvTotal)
        },
        pv: {
          power: pf(sd.pCharge1, bean.ppv),
          powerStr2: pf(sd.pCharge2, bean.ppv2),
          voltage: pf(sd.vpv1, bean.vpv),
          current: pf(sd.iChargePV1, bean.iChargePV1),
          todayEnergy: pf(sd.epvToday, energy.epvToday),
          totalEnergy: pf(sd.epvTotal, energy.epvTotal)
        },
        battery: {
          soc: pf(sd.capacity, bean.capacity),
          voltage: pf(sd.vbat, bean.vBat),
          chargePower: pf(sd.pCharge1, bean.pCharge),
          dischargePower: pf(bean.pDischarge, bean.pBat),
          dischargeCurrent: pf(bean.dischgCurr),
          chargeToday: pf(sd.eBatChargeToday, energy.eChargeToday),
          dischargeToday: pf(sd.eBatDisChargeToday, energy.eDischargeToday),
          temperature: pf(bean.batTemp, bean.bmsTemperature)
        },
        load: {
          power: pf(sd.outPutPower, bean.outPutPower, bean.sysOut),
          current: pf(bean.outPutCurrent),
          voltage: pf(sd.outPutVolt, bean.outPutVolt),
          frequency: pf(sd.freqOutPut, bean.freqOutPut),
          todayEnergy: pf(energy.useEnergyToday, energy.eToUserToday),
          loadPercent: pf(sd.loadPercent, bean.loadPercent)
        },
        grid: {
          power: pf(bean.pAcInPut, sd.pacToGrid),
          voltage: pf(sd.vGrid, bean.vGrid),
          frequency: pf(sd.freqGrid, bean.freqGrid),
          importToday: pf(energy.eToUserToday),
          exportToday: pf(energy.eToGridToday),
          status: isOffGrid ? 'off-grid' : 'connected'
        },
        inverter: {
          status: bean.SPF5000StatusText || bean.statusText || String(bean.status || sd.status || ''),
          statusCode: parseInt(bean.status) || parseInt(sd.status) || 0,
          temperature: pf(bean.invTemperature),
          dcDcTemperature: pf(bean.dcDcTemperature),
          model: paramsRoot.storageType || storageBean.modelText || 'SPF 5000ES',
          serial: session.deviceSn,
          alias: storageBean.alias || storageBean.treeName || '',
          firmware: storageBean.fwVersion || ''
        },
        energy: {
          pvToday: pf(sd.epvToday, energy.epvToday),
          pvTotal: pf(sd.epvTotal, energy.epvTotal),
          consumptionToday: pf(energy.useEnergyToday),
          consumptionTotal: pf(energy.useEnergyTotal),
          gridImportToday: pf(energy.eToUserToday),
          gridImportTotal: pf(energy.eToUserTotal),
          gridExportToday: pf(energy.eToGridToday),
          gridExportTotal: pf(energy.eToGridTotal),
          batteryChargeToday: pf(energy.eChargeToday),
          batteryDischargeToday: pf(energy.eDischargeToday),
          acChargeToday: pf(bean.eacChargeToday),
          acDischargeToday: pf(bean.eacDisChargeToday)
        },
        // Include raw data for debugging
        _raw: {
          storageDetail: sd,
          energyOverview: energy,
          storageDetailBean: bean,
          storageBean: storageBean,
          plantDetail: plantDetail
        }
      };

      session.lastData = dashData;
      session.lastFetch = Date.now();

      res.json({ success: true, cached: false, ...dashData });

    } catch (err: any) {
      log('ERROR', TAG, `Data fetch error: ${err.message}`, err.stack);
      if (err.message.includes('Login') || err.message.includes('session')) {
        log('WARN', TAG, 'Clearing session due to login/session error');
        session.lastLogin = null;
      }
      res.json({ success: false, error: err.message });
    }
  });

  // Debug endpoint — raw API responses
  app.get('/api/debug', async (req, res) => {
    try {
      await ensureSession();

      let storageRaw: any, plantDetail: any, devices: any;

      try { storageRaw = await getStorageData(); } catch (e: any) { storageRaw = { error: e.message }; }
      try { plantDetail = await getPlantDetail(); } catch (e: any) { plantDetail = { error: e.message }; }
      try { devices = await discoverDevices(); } catch (e: any) { devices = { error: e.message }; }

      res.json({
        success: true,
        session: {
          plantId: session.plantId,
          plantName: session.plantName,
          deviceSn: session.deviceSn,
          userId: session.userId
        },
        storageDetail: storageRaw.detail || storageRaw,
        energyOverview: storageRaw.energy || {},
        storageParams: storageRaw.params || {},
        plantDetail: plantDetail,
        devices: devices
      });
    } catch (err: any) {
      res.json({ success: false, error: err.message });
    }
  });

  // Field diagnostic — shows all raw API fields sorted by category
  app.get('/api/fields', async (req, res) => {
    try {
      await ensureSession();
      const storageRaw = await getStorageData();
      const plantDetail = await getPlantDetail();
      const sd = storageRaw.detail?.obj || storageRaw.detail || {};
      const energy = storageRaw.energy || {};
      const params = storageRaw.params?.obj || storageRaw.params || {};

      function categorize(obj: any, label: string) {
        const hasValue: any = {};
        const empty: any = {};
        for (const [k, v] of Object.entries(obj).sort((a, b) => a[0].localeCompare(b[0]))) {
          if (v === '' || v === '0' || v === 0 || v === null || v === undefined || v === '0.0') {
            empty[k] = v;
          } else {
            hasValue[k] = v;
          }
        }
        return { label, hasValue, empty };
      }

      res.json({
        storageDetail: categorize(sd, 'Storage Detail (getStorageInfo_sacolar)'),
        energyOverview: categorize(energy, 'Energy Overview (getEnergyOverviewData_sacolar)'),
        storageParams: categorize(params, 'Storage Params (getStorageParams_sacolar)'),
        plantDetail: categorize(plantDetail, 'Plant Detail (PlantDetailAPI)')
      });
    } catch (err: any) {
      res.json({ error: err.message, stack: err.stack });
    }
  });

  // Status endpoint
  app.get('/api/status', (req, res) => {
    res.json({
      connected: !!session.cookies,
      plantName: session.plantName,
      deviceSn: session.deviceSn,
      lastLogin: session.lastLogin ? new Date(session.lastLogin).toISOString() : null,
      lastFetch: session.lastFetch ? new Date(session.lastFetch).toISOString() : null
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

