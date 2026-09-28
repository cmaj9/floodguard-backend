/**
 * Sync Local PostgreSQL Database to Railway Cloud PostgreSQL
 * Usage: node src/scripts/syncToRailway.js <RAILWAY_DATABASE_URL>
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const targetUrl = process.argv[2] || process.env.TARGET_DATABASE_URL;

if (!targetUrl) {
  console.error('Error: Please provide the Railway DATABASE_URL as an argument.');
  process.exit(1);
}

const localPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'water_monitor',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

const targetPool = new Pool({
  connectionString: targetUrl,
  ssl: { rejectUnauthorized: false },
});

async function syncTableGeneric(tableName, primaryKey, conflictUpdate = true) {
  const localRes = await localPool.query(`SELECT * FROM ${tableName}`);
  if (localRes.rows.length === 0) {
    console.log(`[Sync] Table "${tableName}" is empty locally. Skipped.`);
    return 0;
  }

  const columns = Object.keys(localRes.rows[0]);
  const quotedCols = columns.map(c => `"${c}"`).join(', ');
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');

  let conflictClause = '';
  if (primaryKey) {
    if (conflictUpdate) {
      const updateCols = columns
        .filter(c => c !== primaryKey)
        .map(c => `"${c}" = EXCLUDED."${c}"`)
        .join(', ');
      conflictClause = updateCols ? `ON CONFLICT ("${primaryKey}") DO UPDATE SET ${updateCols}` : `ON CONFLICT ("${primaryKey}") DO NOTHING`;
    } else {
      conflictClause = `ON CONFLICT ("${primaryKey}") DO NOTHING`;
    }
  }

  const insertSql = `INSERT INTO "${tableName}" (${quotedCols}) VALUES (${placeholders}) ${conflictClause}`;

  let count = 0;
  for (const row of localRes.rows) {
    const values = columns.map(c => row[c]);
    await targetPool.query(insertSql, values);
    count++;
  }

  console.log(`[Sync] [OK] "${tableName}": ${count} rows synced.`);
  return count;
}

async function runSync() {
  console.log('[Sync] Connecting to Local and Railway databases...');
  const startTime = Date.now();

  try {
    await localPool.query('SELECT 1');
    console.log('[Sync] [OK] Local database connected.');

    await targetPool.query('SELECT 1');
    console.log('[Sync] [OK] Railway database connected.');

    // 1. Ensure Enums are updated
    console.log('[Sync] Ensuring Enums exist on Railway...');
    const enumQueries = [
      `ALTER TYPE "StationStatus" ADD VALUE IF NOT EXISTS 'offline'`,
      `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'rate_of_rise'`,
      `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'geofence'`,
      `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'offline'`,
    ];
    for (const eq of enumQueries) {
      try { await targetPool.query(eq); } catch (_) {}
    }

    // 2. Ensure schema migrations
    console.log('[Sync] Applying schema migrations on Railway...');
    const migrationSqlPath = path.join(__dirname, '../../sql/migrate_relative_level.sql');
    if (fs.existsSync(migrationSqlPath)) {
      const migrationSql = fs.readFileSync(migrationSqlPath, 'utf8');
      await targetPool.query(migrationSql);
      console.log('[Sync] [OK] Schema migrations applied on Railway.');
    }

    // 3. Ensure notification_settings table exists on Railway
    await targetPool.query(`
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
    `);

    // 4. Sync Tables in Dependency Order
    await syncTableGeneric('gateway', 'gateway_id');
    await syncTableGeneric('station', 'station_id');
    await syncTableGeneric('mcu', 'mcu_id');
    await syncTableGeneric('station_mapping', 'payload_station_id');

    // Sync Users (by email to prevent duplicate email constraint violation)
    console.log('[Sync] Syncing users table...');
    const localUsers = await localPool.query('SELECT * FROM users');
    for (const u of localUsers.rows) {
      await targetPool.query(`
        INSERT INTO users (name, email, password_hash, phone, role, district, line_user_id, station_ids, is_active)
        VALUES ($1, $2, $3, $4, $5::"UserRole", $6, $7, $8, $9)
        ON CONFLICT (email) DO UPDATE SET
          name          = EXCLUDED.name,
          password_hash = EXCLUDED.password_hash,
          phone         = EXCLUDED.phone,
          role          = EXCLUDED.role,
          district      = EXCLUDED.district,
          line_user_id  = EXCLUDED.line_user_id,
          station_ids   = EXCLUDED.station_ids,
          is_active     = EXCLUDED.is_active
      `, [u.name, u.email, u.password_hash, u.phone, u.role, u.district, u.line_user_id, u.station_ids, u.is_active]);
    }
    console.log(`[Sync] [OK] "users": ${localUsers.rows.length} rows synced.`);

    // Sync Notification Settings
    console.log('[Sync] Syncing notification_settings table...');
    const notifs = await localPool.query('SELECT * FROM notification_settings');
    for (const n of notifs.rows) {
      if (n.station_id) {
        await targetPool.query(`
          INSERT INTO notification_settings (
            station_id, water_level_enabled, safety_offset, rate_of_rise_enabled,
            rate_of_rise_threshold, offline_timeout_enabled, offline_timeout_minutes,
            battery_low_enabled, battery_low_threshold, geofence_enabled, geofence_radius_meters
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
          ON CONFLICT (station_id) DO UPDATE SET
            water_level_enabled = EXCLUDED.water_level_enabled,
            safety_offset = EXCLUDED.safety_offset,
            rate_of_rise_enabled = EXCLUDED.rate_of_rise_enabled,
            rate_of_rise_threshold = EXCLUDED.rate_of_rise_threshold,
            offline_timeout_enabled = EXCLUDED.offline_timeout_enabled,
            offline_timeout_minutes = EXCLUDED.offline_timeout_minutes,
            battery_low_enabled = EXCLUDED.battery_low_enabled,
            battery_low_threshold = EXCLUDED.battery_low_threshold,
            geofence_enabled = EXCLUDED.geofence_enabled,
            geofence_radius_meters = EXCLUDED.geofence_radius_meters
        `, [
          n.station_id, n.water_level_enabled, n.safety_offset, n.rate_of_rise_enabled,
          n.rate_of_rise_threshold, n.offline_timeout_enabled, n.offline_timeout_minutes,
          n.battery_low_enabled, n.battery_low_threshold, n.geofence_enabled, n.geofence_radius_meters
        ]);
      } else {
        const gRes = await targetPool.query('SELECT setting_id FROM notification_settings WHERE station_id IS NULL LIMIT 1');
        if (gRes.rows.length > 0) {
          await targetPool.query(`
            UPDATE notification_settings SET
              water_level_enabled = $1, safety_offset = $2, rate_of_rise_enabled = $3,
              rate_of_rise_threshold = $4, offline_timeout_enabled = $5, offline_timeout_minutes = $6,
              battery_low_enabled = $7, battery_low_threshold = $8, geofence_enabled = $9, geofence_radius_meters = $10
            WHERE setting_id = $11
          `, [
            n.water_level_enabled, n.safety_offset, n.rate_of_rise_enabled,
            n.rate_of_rise_threshold, n.offline_timeout_enabled, n.offline_timeout_minutes,
            n.battery_low_enabled, n.battery_low_threshold, n.geofence_enabled, n.geofence_radius_meters,
            gRes.rows[0].setting_id
          ]);
        } else {
          await targetPool.query(`
            INSERT INTO notification_settings (
              station_id, water_level_enabled, safety_offset, rate_of_rise_enabled,
              rate_of_rise_threshold, offline_timeout_enabled, offline_timeout_minutes,
              battery_low_enabled, battery_low_threshold, geofence_enabled, geofence_radius_meters
            ) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            n.water_level_enabled, n.safety_offset, n.rate_of_rise_enabled,
            n.rate_of_rise_threshold, n.offline_timeout_enabled, n.offline_timeout_minutes,
            n.battery_low_enabled, n.battery_low_threshold, n.geofence_enabled, n.geofence_radius_meters
          ]);
        }
      }
    }
    console.log(`[Sync] [OK] "notification_settings": ${notifs.rows.length} rows synced.`);

    await syncTableGeneric('alerts', 'alert_id');

    // 5. Sync Readings (with batching for high speed)
    console.log('[Sync] Syncing readings table...');
    const readings = await localPool.query('SELECT * FROM readings ORDER BY reading_id ASC');
    if (readings.rows.length > 0) {
      const rCols = Object.keys(readings.rows[0]);
      const quotedRCols = rCols.map(c => `"${c}"`).join(', ');
      const rPlaceholders = rCols.map((_, i) => `$${i + 1}`).join(', ');
      const rUpdate = rCols.filter(c => c !== 'reading_id').map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
      const readingSql = `INSERT INTO "readings" (${quotedRCols}) VALUES (${rPlaceholders}) ON CONFLICT ("reading_id") DO UPDATE SET ${rUpdate}`;

      for (const r of readings.rows) {
        await targetPool.query(readingSql, rCols.map(c => r[c]));
      }
      console.log(`[Sync] [OK] "readings": ${readings.rows.length} rows synced.`);
    }

    // 6. Sync Sequences
    try {
      await targetPool.query(`SELECT setval('readings_reading_id_seq', COALESCE((SELECT MAX(reading_id) FROM readings), 1), true)`);
      await targetPool.query(`SELECT setval('users_user_id_seq', COALESCE((SELECT MAX(user_id) FROM users), 1), true)`);
      console.log('[Sync] [OK] Sequences updated.');
    } catch (_) {}

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n============================================================`);
    console.log(`[SUCCESS] All data and schema synced to Railway in ${elapsed}s!`);
    console.log(`============================================================\n`);

  } catch (err) {
    console.error('[Sync Error]:', err.message);
  } finally {
    await localPool.end();
    await targetPool.end();
  }
}

runSync();
