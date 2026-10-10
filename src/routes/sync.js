const express = require('express');
const router = express.Router();
const db = require('../config/database');

const SYNC_SECRET = process.env.SYNC_SECRET;

router.post('/sync-backup', async (req, res) => {
  if (!SYNC_SECRET) {
    return res.status(503).json({
      success: false,
      error: 'Database synchronization is disabled (SYNC_SECRET is not configured on the server)',
    });
  }

  const authHeader = req.headers['x-sync-secret'];
  if (!authHeader || authHeader !== SYNC_SECRET) {
    return res.status(403).json({ success: false, error: 'Unauthorized' });
  }

  const { stations = [], readings = [], alerts = [], users = [] } = req.body;
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    // 1. Sync stations
    for (const s of stations) {
      await client.query(
        `INSERT INTO station (
          station_id, gateway_id, station_name, station_type, location_name,
          latitude, longitude, status, sensor_to_ref_distance, reference_point_name,
          blind_zone_offset, tilt_compensation_enabled, warning_level, critical_level,
          max_level, normal_max
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (station_id) DO UPDATE SET
          station_name = EXCLUDED.station_name,
          latitude = EXCLUDED.latitude,
          longitude = EXCLUDED.longitude,
          sensor_to_ref_distance = EXCLUDED.sensor_to_ref_distance,
          reference_point_name = EXCLUDED.reference_point_name,
          warning_level = EXCLUDED.warning_level,
          critical_level = EXCLUDED.critical_level`,
        [
          s.station_id, s.gateway_id || 'GW-001', s.station_name, s.station_type || 'river',
          s.location_name, s.latitude, s.longitude, s.status || 'active',
          s.sensor_to_ref_distance || 2.0, s.reference_point_name || 'จุดอ้างอิง',
          s.blind_zone_offset || 0.28, s.tilt_compensation_enabled !== false,
          s.warning_level, s.critical_level, s.max_level, s.normal_max
        ]
      );
    }

    // 2. Sync readings
    let readingCount = 0;
    for (const r of readings) {
      await client.query(
        `INSERT INTO readings (
          station_id, timestamp, water_level, temperature, humidity,
          battery_voltage, battery_percent, rssi, snr, tilt_x, tilt_y,
          latitude, longitude, raw_distance, is_blind_zone
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT DO NOTHING`,
        [
          r.station_id, r.timestamp, r.water_level, r.temperature, r.humidity,
          r.battery_voltage, r.battery_percent, r.rssi, r.snr, r.tilt_x, r.tilt_y,
          r.latitude, r.longitude, r.raw_distance, r.is_blind_zone
        ]
      );
      readingCount++;
    }

    // 3. Sync alerts
    let alertCount = 0;
    for (const a of alerts) {
      await client.query(
        `INSERT INTO alerts (
          station_id, timestamp, alert_type, value, threshold, message, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT DO NOTHING`,
        [
          a.station_id, a.timestamp, a.alert_type, a.value, a.threshold, a.message, a.status
        ]
      );
      alertCount++;
    }

    // 4. Sync users
    let userCount = 0;
    for (const u of users) {
      await client.query(
        `INSERT INTO users (
          name, email, password_hash, phone, role, district, line_user_id,
          station_ids, is_active, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (email) DO NOTHING`,
        [
          u.name, u.email, u.password_hash, u.phone, u.role, u.district,
          u.line_user_id, u.station_ids || [], u.is_active !== false,
          u.created_at || new Date(), u.updated_at || new Date()
        ]
      );
      userCount++;
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      message: 'Data synced successfully',
      stats: {
        stations: stations.length,
        readings: readingCount,
        alerts: alertCount,
        users: userCount
      }
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Sync Error]', err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
