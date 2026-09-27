const db = require('../config/database');

let isTableInitialized = false;

/**
 * Ensure notification_settings table exists and default global row is present
 */
async function ensureTable() {
  if (isTableInitialized) return;

  const createTableSql = `
    CREATE TABLE IF NOT EXISTS notification_settings (
      setting_id SERIAL PRIMARY KEY,
      station_id VARCHAR(50) UNIQUE,
      water_level_enabled BOOLEAN DEFAULT true,
      safety_offset FLOAT DEFAULT 0.0,
      rate_of_rise_enabled BOOLEAN DEFAULT true,
      rate_of_rise_threshold FLOAT DEFAULT 0.30,
      offline_timeout_enabled BOOLEAN DEFAULT true,
      offline_timeout_minutes INTEGER DEFAULT 30,
      battery_low_enabled BOOLEAN DEFAULT true,
      battery_low_threshold FLOAT DEFAULT 20.0,
      geofence_enabled BOOLEAN DEFAULT true,
      geofence_radius_meters FLOAT DEFAULT 100.0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `;

  try {
    await db.query(createTableSql);

    // Ensure StationStatus enum supports 'offline'
    try {
      await db.query(`ALTER TYPE "StationStatus" ADD VALUE IF NOT EXISTS 'offline'`);
    } catch (_) {}

    // Ensure notification cooldown / repeat frequency columns exist
    const addColumns = [
      `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS water_level_cooldown_minutes INTEGER DEFAULT 30`,
      `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS rate_of_rise_cooldown_minutes INTEGER DEFAULT 30`,
      `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS offline_cooldown_minutes INTEGER DEFAULT 60`,
      `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS battery_low_cooldown_minutes INTEGER DEFAULT 120`,
      `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS geofence_cooldown_minutes INTEGER DEFAULT 60`,
    ];
    for (const sql of addColumns) {
      try { await db.query(sql); } catch (_) {}
    }

    // Ensure default global settings row (station_id IS NULL)
    const checkGlobal = await db.query(
      `SELECT setting_id FROM notification_settings WHERE station_id IS NULL LIMIT 1`
    );
    if (checkGlobal.rows.length === 0) {
      await db.query(`
        INSERT INTO notification_settings (
          station_id,
          water_level_enabled,
          safety_offset,
          water_level_cooldown_minutes,
          rate_of_rise_enabled,
          rate_of_rise_threshold,
          rate_of_rise_cooldown_minutes,
          offline_timeout_enabled,
          offline_timeout_minutes,
          offline_cooldown_minutes,
          battery_low_enabled,
          battery_low_threshold,
          battery_low_cooldown_minutes,
          geofence_enabled,
          geofence_radius_meters,
          geofence_cooldown_minutes
        ) VALUES (NULL, true, 0.0, 30, true, 0.30, 30, true, 30, 60, true, 20.0, 120, true, 100.0, 60)
      `);
      console.log('[NotificationSettings] Seeded default global notification settings');
    }

    isTableInitialized = true;
  } catch (err) {
    console.error('[NotificationSettings] Failed to ensure table:', err.message);
  }
}

/**
 * Format DB row into clean JavaScript settings object
 */
function formatSettings(row, fallbackGlobal = null) {
  if (!row) {
    return fallbackGlobal || {
      station_id: null,
      water_level_enabled: true,
      safety_offset: 0.0,
      water_level_cooldown_minutes: 30,
      rate_of_rise_enabled: true,
      rate_of_rise_threshold: 0.30,
      rate_of_rise_cooldown_minutes: 30,
      offline_timeout_enabled: true,
      offline_timeout_minutes: 30,
      offline_cooldown_minutes: 60,
      battery_low_enabled: true,
      battery_low_threshold: 20.0,
      battery_low_cooldown_minutes: 120,
      geofence_enabled: true,
      geofence_radius_meters: 100.0,
      geofence_cooldown_minutes: 60,
      is_custom: false,
    };
  }

  return {
    setting_id: row.setting_id,
    station_id: row.station_id || null,
    water_level_enabled: row.water_level_enabled !== false,
    safety_offset: row.safety_offset != null ? Number(row.safety_offset) : 0.0,
    water_level_cooldown_minutes: row.water_level_cooldown_minutes != null ? Number(row.water_level_cooldown_minutes) : 30,
    rate_of_rise_enabled: row.rate_of_rise_enabled !== false,
    rate_of_rise_threshold: row.rate_of_rise_threshold != null ? Number(row.rate_of_rise_threshold) : 0.30,
    rate_of_rise_cooldown_minutes: row.rate_of_rise_cooldown_minutes != null ? Number(row.rate_of_rise_cooldown_minutes) : 30,
    offline_timeout_enabled: row.offline_timeout_enabled !== false,
    offline_timeout_minutes: row.offline_timeout_minutes != null ? Number(row.offline_timeout_minutes) : 30,
    offline_cooldown_minutes: row.offline_cooldown_minutes != null ? Number(row.offline_cooldown_minutes) : 60,
    battery_low_enabled: row.battery_low_enabled !== false,
    battery_low_threshold: row.battery_low_threshold != null ? Number(row.battery_low_threshold) : 20.0,
    battery_low_cooldown_minutes: row.battery_low_cooldown_minutes != null ? Number(row.battery_low_cooldown_minutes) : 120,
    geofence_enabled: row.geofence_enabled !== false,
    geofence_radius_meters: row.geofence_radius_meters != null ? Number(row.geofence_radius_meters) : 100.0,
    geofence_cooldown_minutes: row.geofence_cooldown_minutes != null ? Number(row.geofence_cooldown_minutes) : 60,
    is_custom: row.station_id != null,
    updated_at: row.updated_at,
  };
}

/**
 * Get notification settings for a station (or global if stationId is null)
 */
async function getSettings(stationId = null) {
  await ensureTable();

  try {
    // 1. If stationId requested, check for station-specific override
    if (stationId) {
      const stationRes = await db.query(
        `SELECT * FROM notification_settings WHERE station_id = $1 LIMIT 1`,
        [stationId]
      );
      if (stationRes.rows.length > 0) {
        return formatSettings(stationRes.rows[0]);
      }
    }

    // 2. Fallback to global settings
    const globalRes = await db.query(
      `SELECT * FROM notification_settings WHERE station_id IS NULL LIMIT 1`
    );
    if (globalRes.rows.length > 0) {
      const globalFormatted = formatSettings(globalRes.rows[0]);
      if (stationId) {
        return { ...globalFormatted, station_id: stationId, is_custom: false };
      }
      return globalFormatted;
    }

    return formatSettings(null);
  } catch (err) {
    console.error('[NotificationSettings] getSettings error:', err.message);
    return formatSettings(null);
  }
}

/**
 * Save notification settings (Global when stationId is null, or per-station)
 */
async function saveSettings(data, stationId = null) {
  await ensureTable();

  const targetStationId = stationId || data.station_id || null;

  const values = [
    targetStationId,
    data.water_level_enabled !== false,
    data.safety_offset != null ? Number(data.safety_offset) : 0.0,
    data.water_level_cooldown_minutes != null ? Number(data.water_level_cooldown_minutes) : 30,
    data.rate_of_rise_enabled !== false,
    data.rate_of_rise_threshold != null ? Number(data.rate_of_rise_threshold) : 0.30,
    data.rate_of_rise_cooldown_minutes != null ? Number(data.rate_of_rise_cooldown_minutes) : 30,
    data.offline_timeout_enabled !== false,
    data.offline_timeout_minutes != null ? Number(data.offline_timeout_minutes) : 30,
    data.offline_cooldown_minutes != null ? Number(data.offline_cooldown_minutes) : 60,
    data.battery_low_enabled !== false,
    data.battery_low_threshold != null ? Number(data.battery_low_threshold) : 20.0,
    data.battery_low_cooldown_minutes != null ? Number(data.battery_low_cooldown_minutes) : 120,
    data.geofence_enabled !== false,
    data.geofence_radius_meters != null ? Number(data.geofence_radius_meters) : 100.0,
    data.geofence_cooldown_minutes != null ? Number(data.geofence_cooldown_minutes) : 60,
  ];

  try {
    let result;
    if (targetStationId === null) {
      // Upsert global setting (where station_id IS NULL)
      const checkGlobal = await db.query(
        `SELECT setting_id FROM notification_settings WHERE station_id IS NULL LIMIT 1`
      );

      if (checkGlobal.rows.length > 0) {
        const updateValues = values.slice(1);
        result = await db.query(
          `UPDATE notification_settings
           SET
             water_level_enabled = $1,
             safety_offset = $2,
             water_level_cooldown_minutes = $3,
             rate_of_rise_enabled = $4,
             rate_of_rise_threshold = $5,
             rate_of_rise_cooldown_minutes = $6,
             offline_timeout_enabled = $7,
             offline_timeout_minutes = $8,
             offline_cooldown_minutes = $9,
             battery_low_enabled = $10,
             battery_low_threshold = $11,
             battery_low_cooldown_minutes = $12,
             geofence_enabled = $13,
             geofence_radius_meters = $14,
             geofence_cooldown_minutes = $15,
             updated_at = NOW()
           WHERE station_id IS NULL
           RETURNING *`,
          updateValues
        );
      } else {
        result = await db.query(
          `INSERT INTO notification_settings (
             station_id,
             water_level_enabled, safety_offset, water_level_cooldown_minutes,
             rate_of_rise_enabled, rate_of_rise_threshold, rate_of_rise_cooldown_minutes,
             offline_timeout_enabled, offline_timeout_minutes, offline_cooldown_minutes,
             battery_low_enabled, battery_low_threshold, battery_low_cooldown_minutes,
             geofence_enabled, geofence_radius_meters, geofence_cooldown_minutes,
             updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
           RETURNING *`,
          values
        );
      }
    } else {
      // Upsert per-station setting
      result = await db.query(
        `INSERT INTO notification_settings (
           station_id,
           water_level_enabled, safety_offset, water_level_cooldown_minutes,
           rate_of_rise_enabled, rate_of_rise_threshold, rate_of_rise_cooldown_minutes,
           offline_timeout_enabled, offline_timeout_minutes, offline_cooldown_minutes,
           battery_low_enabled, battery_low_threshold, battery_low_cooldown_minutes,
           geofence_enabled, geofence_radius_meters, geofence_cooldown_minutes,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
         ON CONFLICT (station_id) DO UPDATE SET
           water_level_enabled = EXCLUDED.water_level_enabled,
           safety_offset = EXCLUDED.safety_offset,
           water_level_cooldown_minutes = EXCLUDED.water_level_cooldown_minutes,
           rate_of_rise_enabled = EXCLUDED.rate_of_rise_enabled,
           rate_of_rise_threshold = EXCLUDED.rate_of_rise_threshold,
           rate_of_rise_cooldown_minutes = EXCLUDED.rate_of_rise_cooldown_minutes,
           offline_timeout_enabled = EXCLUDED.offline_timeout_enabled,
           offline_timeout_minutes = EXCLUDED.offline_timeout_minutes,
           offline_cooldown_minutes = EXCLUDED.offline_cooldown_minutes,
           battery_low_enabled = EXCLUDED.battery_low_enabled,
           battery_low_threshold = EXCLUDED.battery_low_threshold,
           battery_low_cooldown_minutes = EXCLUDED.battery_low_cooldown_minutes,
           geofence_enabled = EXCLUDED.geofence_enabled,
           geofence_radius_meters = EXCLUDED.geofence_radius_meters,
           geofence_cooldown_minutes = EXCLUDED.geofence_cooldown_minutes,
           updated_at = NOW()
         RETURNING *`,
        values
      );
    }

    console.log(`[NotificationSettings] Saved settings for ${targetStationId || 'GLOBAL'}`);
    return formatSettings(result.rows[0]);
  } catch (err) {
    console.error('[NotificationSettings] saveSettings error:', err.message);
    throw err;
  }
}

/**
 * Reset a station's settings back to global defaults by removing its override
 */
async function resetStationSettings(stationId) {
  if (!stationId) return;
  await ensureTable();
  await db.query(`DELETE FROM notification_settings WHERE station_id = $1`, [stationId]);
  return getSettings(null);
}

module.exports = {
  getSettings,
  saveSettings,
  resetStationSettings,
  ensureTable,
};
