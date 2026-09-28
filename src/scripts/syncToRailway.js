/**
 * True Mirror Sync: Local PostgreSQL -> Railway Cloud PostgreSQL
 * Makes Railway database an EXACT 1:1 replica of the Local database.
 *
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

async function mirrorTable(tableName) {
  const localRes = await localPool.query(`SELECT * FROM "${tableName}"`);
  if (localRes.rows.length === 0) {
    console.log(`[Mirror] "${tableName}": 0 rows (empty locally).`);
    return 0;
  }

  const columns = Object.keys(localRes.rows[0]);
  const quotedCols = columns.map(c => `"${c}"`).join(', ');

  // Batch insert up to 100 rows per query for maximum performance and low latency
  const batchSize = 100;
  for (let i = 0; i < localRes.rows.length; i += batchSize) {
    const batch = localRes.rows.slice(i, i + batchSize);
    const valuePlaceholders = [];
    const flatValues = [];
    let pIdx = 1;

    for (const row of batch) {
      const rowPlaceholders = [];
      for (const col of columns) {
        rowPlaceholders.push(`$${pIdx++}`);
        flatValues.push(row[col]);
      }
      valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
    }

    const sql = `INSERT INTO "${tableName}" (${quotedCols}) VALUES ${valuePlaceholders.join(', ')}`;
    await targetPool.query(sql, flatValues);
  }

  console.log(`[Mirror] [OK] "${tableName}": ${localRes.rows.length} rows copied exactly.`);
  return localRes.rows.length;
}

async function runMirrorSync() {
  console.log('============================================================');
  console.log('[Mirror Sync] Starting 1:1 Database Replica: Local -> Railway');
  console.log('============================================================');
  const startTime = Date.now();

  try {
    // 1. Test connections
    await localPool.query('SELECT 1');
    console.log('[Mirror] [OK] Local database connected.');

    await targetPool.query('SELECT 1');
    console.log('[Mirror] [OK] Railway database connected.');

    // 2. Ensure Types & Schema migrations on Railway
    console.log('[Mirror] Applying schema migrations & enums on Railway...');
    const enumQueries = [
      `ALTER TYPE "StationStatus" ADD VALUE IF NOT EXISTS 'offline'`,
      `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'rate_of_rise'`,
      `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'geofence'`,
      `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'offline'`,
    ];
    for (const eq of enumQueries) {
      try { await targetPool.query(eq); } catch (_) {}
    }

    const migrationSqlPath = path.join(__dirname, '../../sql/migrate_relative_level.sql');
    if (fs.existsSync(migrationSqlPath)) {
      const migrationSql = fs.readFileSync(migrationSqlPath, 'utf8');
      await targetPool.query(migrationSql);
      console.log('[Mirror] [OK] Schema migrations applied on Railway.');
    }

    // Ensure notification_settings table exists
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

    // 3. Clear target database completely so it's not mixed with old junk/test data
    console.log('[Mirror] Cleaning old target data (TRUNCATE CASCADE)...');
    await targetPool.query(`
      TRUNCATE TABLE
        readings,
        alerts,
        gateway_mapping,
        station_mapping,
        mcu,
        station,
        gateway,
        notification_settings,
        users
      RESTART IDENTITY CASCADE;
    `);
    console.log('[Mirror] [OK] Old target tables truncated clean.');

    // 4. Mirror all tables in foreign-key dependency order
    await mirrorTable('gateway');
    await mirrorTable('gateway_mapping');
    await mirrorTable('station');
    await mirrorTable('mcu');
    await mirrorTable('station_mapping');
    await mirrorTable('users');
    await mirrorTable('notification_settings');
    await mirrorTable('alerts');
    await mirrorTable('readings');

    // 5. Update Sequences to match max IDs
    console.log('[Mirror] Updating sequences...');
    try {
      await targetPool.query(`SELECT setval('readings_reading_id_seq', (SELECT COALESCE(MAX(reading_id), 1) FROM readings), true)`);
      await targetPool.query(`SELECT setval('users_user_id_seq', (SELECT COALESCE(MAX(user_id), 1) FROM users), true)`);
      await targetPool.query(`SELECT setval('notification_settings_setting_id_seq', (SELECT COALESCE(MAX(setting_id), 1) FROM notification_settings), true)`);
      console.log('[Mirror] [OK] Sequences updated to latest local values.');
    } catch (seqErr) {
      console.warn('[Mirror] Sequence warning:', seqErr.message);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n============================================================`);
    console.log(`[SUCCESS] Railway database is now an EXACT 1:1 MIRROR of Local!`);
    console.log(`Time taken: ${elapsed}s`);
    console.log(`============================================================\n`);

  } catch (err) {
    console.error('[Mirror Error]:', err.message);
  } finally {
    await localPool.end();
    await targetPool.end();
  }
}

runMirrorSync();
