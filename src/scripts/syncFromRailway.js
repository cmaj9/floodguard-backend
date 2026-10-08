/**
 * Mirror Sync: Railway Cloud PostgreSQL -> Local PostgreSQL
 * Pulls production data down from Railway to Local database for local testing and inspection.
 *
 * Usage: node src/scripts/syncFromRailway.js [RAILWAY_DATABASE_URL]
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const railwayUrl =
  process.argv[2] ||
  process.env.RAILWAY_DATABASE_URL ||
  process.env.TARGET_DATABASE_URL ||
  'postgresql://postgres:HXgZMiYgqNjImgbmLOoteoGjsfupvTAT@altaria.proxy.rlwy.net:26131/railway';

const railwayPool = new Pool({
  connectionString: railwayUrl,
  ssl: { rejectUnauthorized: false },
});

const localPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'water_monitor',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '1234',
});

async function mirrorTable(tableName) {
  const railwayRes = await railwayPool.query(`SELECT * FROM "${tableName}"`);
  if (railwayRes.rows.length === 0) {
    console.log(`[Mirror] "${tableName}": 0 rows on Railway.`);
    return 0;
  }

  const columns = Object.keys(railwayRes.rows[0]);
  const quotedCols = columns.map(c => `"${c}"`).join(', ');

  const batchSize = 100;
  for (let i = 0; i < railwayRes.rows.length; i += batchSize) {
    const batch = railwayRes.rows.slice(i, i + batchSize);
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
    await localPool.query(sql, flatValues);
  }

  console.log(`[Mirror] [OK] "${tableName}": ${railwayRes.rows.length} rows pulled to Local.`);
  return railwayRes.rows.length;
}

async function runPullSync() {
  console.log('============================================================');
  console.log('[Pull Sync] Mirroring: Railway Cloud PostgreSQL -> Local');
  console.log('============================================================');
  const startTime = Date.now();

  try {
    // 1. Test connections
    await railwayPool.query('SELECT 1');
    console.log('[Pull] [OK] Railway Cloud database connected.');

    await localPool.query('SELECT 1');
    console.log('[Pull] [OK] Local database connected.');

    // 2. Ensure Types & Schema migrations on Local
    console.log('[Pull] Ensuring schema migrations on Local...');
    const enumQueries = [
      `ALTER TYPE "StationStatus" ADD VALUE IF NOT EXISTS 'offline'`,
      `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'rate_of_rise'`,
      `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'geofence'`,
      `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'offline'`,
      `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'online'`,
    ];
    for (const eq of enumQueries) {
      try { await localPool.query(eq); } catch (_) {}
    }

    const migrationSqlPath = path.join(__dirname, '../../sql/migrate_relative_level.sql');
    if (fs.existsSync(migrationSqlPath)) {
      const migrationSql = fs.readFileSync(migrationSqlPath, 'utf8');
      await localPool.query(migrationSql);
      console.log('[Pull] [OK] Schema migrations verified on Local.');
    }

    // 3. Truncate local tables clean
    console.log('[Pull] Cleaning existing Local data (TRUNCATE CASCADE)...');
    await localPool.query(`
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
    console.log('[Pull] [OK] Local tables truncated clean.');

    // 4. Mirror all tables in dependency order
    await mirrorTable('gateway');
    await mirrorTable('gateway_mapping');
    await mirrorTable('station');
    await mirrorTable('mcu');
    await mirrorTable('station_mapping');
    await mirrorTable('users');
    await mirrorTable('notification_settings');
    await mirrorTable('alerts');
    await mirrorTable('readings');

    // 5. Update Sequences on Local
    console.log('[Pull] Updating Local sequences...');
    try {
      await localPool.query(`SELECT setval('readings_reading_id_seq', (SELECT COALESCE(MAX(reading_id), 1) FROM readings), true)`);
      await localPool.query(`SELECT setval('users_user_id_seq', (SELECT COALESCE(MAX(user_id), 1) FROM users), true)`);
      await localPool.query(`SELECT setval('notification_settings_setting_id_seq', (SELECT COALESCE(MAX(setting_id), 1) FROM notification_settings), true)`);
      console.log('[Pull] [OK] Sequences updated to max IDs.');
    } catch (seqErr) {
      console.warn('[Pull] Sequence notice:', seqErr.message);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n============================================================`);
    console.log(`[SUCCESS] Local database is now an EXACT replica of Railway!`);
    console.log(`Time taken: ${elapsed}s`);
    console.log(`============================================================\n`);

  } catch (err) {
    console.error('[Pull Error]:', err.message);
    process.exit(1);
  } finally {
    await railwayPool.end();
    await localPool.end();
  }
}

runPullSync();
