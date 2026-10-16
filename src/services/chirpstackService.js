/**
 * ChirpStack v4 REST API Service
 * Used for verifying devices and retrieving live device status by DevEUI
 */
require('dotenv').config();

const API_URL = (process.env.CHIRPSTACK_API_URL || '').replace(/\/+$/, '');
const API_TOKEN = process.env.CHIRPSTACK_API_TOKEN || '';

/**
 * Check if ChirpStack API integration is configured
 */
function isConfigured() {
  return Boolean(API_URL && API_TOKEN);
}

/**
 * Helper to make authenticated HTTP requests to ChirpStack v4 REST API
 */
async function chirpstackFetch(endpoint, options = {}) {
  if (!isConfigured()) {
    throw new Error('ChirpStack API URL or API Token is not configured');
  }

  const url = `${API_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${API_TOKEN}`,
    ...(options.headers || {}),
  };

  const response = await fetch(url, {
    ...options,
    headers,
  });

  const contentType = response.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    data = await response.json().catch(() => null);
  } else {
    data = await response.text().catch(() => null);
  }

  if (!response.ok) {
    const errorMsg = data?.message || data?.error || (typeof data === 'string' ? data : `HTTP ${response.status}`);
    const err = new Error(`ChirpStack API error (${response.status}): ${errorMsg}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

/**
 * Verify whether a DevEUI exists on ChirpStack and retrieve basic device info
 *
 * @param {string} devEui
 * @returns {Promise<{ found: boolean|null, configured: boolean, name?: string, lastSeenAt?: string, description?: string, message?: string }>}
 */
async function verifyDevice(devEui) {
  if (!devEui || String(devEui).trim().length !== 16) {
    return {
      found: false,
      configured: isConfigured(),
      message: 'DevEUI ไม่ถูกต้อง ต้องเป็นเลขฐาน 16 จำนวน 16 หลัก',
    };
  }

  if (!isConfigured()) {
    return {
      found: null,
      configured: false,
      message: 'ระบบไม่ได้ตั้งค่าการเชื่อมต่อ ChirpStack API ในเซิร์ฟเวอร์',
    };
  }

  const cleanDevEui = String(devEui).trim().toLowerCase();

  try {
    const res = await chirpstackFetch(`/api/devices/${cleanDevEui}`);
    const device = res?.device || {};
    return {
      found: true,
      configured: true,
      name: device.name || cleanDevEui,
      description: device.description || '',
      lastSeenAt: res?.lastSeenAt || null,
      deviceProfileId: device.deviceProfileId || null,
      message: 'พบอุปกรณ์ในระบบ ChirpStack',
    };
  } catch (err) {
    if (err.status === 404) {
      return {
        found: false,
        configured: true,
        message: 'ไม่พบอุปกรณ์ DevEUI นี้ในระบบ ChirpStack',
      };
    }
    console.warn(`[ChirpStack Service] verifyDevice error for ${cleanDevEui}:`, err.message);
    return {
      found: false,
      configured: true,
      error: err.message,
      message: `ไม่สามารถตรวจสอบกับ ChirpStack ได้ (${err.message})`,
    };
  }
}

module.exports = {
  isConfigured,
  verifyDevice,
};
