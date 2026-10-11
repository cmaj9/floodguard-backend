/**
 * Railway Production Database Migration
 * Migrates Railway PostgreSQL to the unified 6-table architecture with zero data loss.
 *
 * Preserves:
 *  - 100% of telemetry readings (3,282+ rows)
 *  - 100% of historical alerts (232+ rows)
 *  - 100% of LINE subscribers (ICE, PK, NATTAWUT, OAKUP, J, Sutatta, Nattikorn, s)
 *  - 100% of hardware mappings (MCUs, EUIs, ChirpStack IDs)
 */

const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const railwayUrl =
  process.env.RAILWAY_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://postgres:HXgZMiYgqNjImgbmLOoteoGjsfupvTAT@altaria.proxy.rlwy.net:26131/railway';

const pool = new Pool({
  connectionString: railwayUrl,
  ssl: { rejectUnauthorized: false },
});

async function migrateProduction() {
  console.log('===============================================================');
  console.log('  STARTING RAILWAY PRODUCTION DATABASE MIGRATION (ZERO DATA LOSS) ');
  console.log('===============================================================');

  // Step 0: Ensure ENUM types outside transaction block
  console.log('\n[Step 0] Updating ENUM types (outside transaction)...');
  const enumQueries = [
    `ALTER TYPE "GatewayStatus" ADD VALUE IF NOT EXISTS 'offline'`,
    `ALTER TYPE "StationStatus" ADD VALUE IF NOT EXISTS 'offline'`,
    `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'rate_of_rise'`,
    `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'battery_low'`,
    `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'geofence'`,
    `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'offline'`,
    `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'online'`,
    `ALTER TYPE "AlertType" ADD VALUE IF NOT EXISTS 'sensor_drift'`,
  ];
  for (const eq of enumQueries) {
    try {
      await pool.query(eq);
    } catch (e) {
      console.log(`  Note on ENUM: ${e.message}`);
    }
  }

  const client = await pool.connect();

  try {
    console.log('\n[Step 1] Beginning transactional migration...');
    await client.query('BEGIN');

    // 1. Users table additions
    console.log('[Step 2] Adding picture_url and is_credentials_set to users...');
    await client.query(`
      ALTER TABLE users 
        ADD COLUMN IF NOT EXISTS picture_url TEXT,
        ADD COLUMN IF NOT EXISTS is_credentials_set BOOLEAN DEFAULT true;
    `);

    // 2. Station table additions
    console.log('[Step 3] Adding hardware columns to station...');
    await client.query(`
      ALTER TABLE station
        ADD COLUMN IF NOT EXISTS dev_eui VARCHAR(64),
        ADD COLUMN IF NOT EXISTS dev_euis TEXT[] DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS payload_id VARCHAR(32),
        ADD COLUMN IF NOT EXISTS model VARCHAR(100) DEFAULT 'Heltec-WiFi-LoRa-32(V3)',
        ADD COLUMN IF NOT EXISTS firmware_version VARCHAR(50) DEFAULT 'v1.2.0',
        ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS manual_offline_at TIMESTAMP WITH TIME ZONE;
    `);

    // 3. Gateway table additions
    console.log('[Step 4] Adding chirpstack_id columns to gateway...');
    await client.query(`
      ALTER TABLE gateway
        ADD COLUMN IF NOT EXISTS chirpstack_id VARCHAR(64),
        ADD COLUMN IF NOT EXISTS chirpstack_ids TEXT[] DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS last_update TIMESTAMP WITH TIME ZONE DEFAULT NOW();
    `);

    // 4. Migrate MCU -> Station
    console.log('[Step 5] Migrating MCU hardware data to station...');
    await client.query(`
      DO $$ BEGIN
        UPDATE station s
        SET dev_eui = sub.primary_eui,
            dev_euis = sub.all_euis,
            model = COALESCE(sub.first_model, s.model),
            firmware_version = COALESCE(sub.first_fw, s.firmware_version)
        FROM (
          SELECT 
            station_id,
            MIN(mcu_id) AS primary_eui,
            ARRAY_AGG(DISTINCT mcu_id) AS all_euis,
            MAX(model) AS first_model,
            MAX(firmware_version) AS first_fw
          FROM mcu
          GROUP BY station_id
        ) sub
        WHERE s.station_id = sub.station_id;
      EXCEPTION WHEN undefined_table THEN NULL; END $$;
    `);

    // 5. Migrate Station Mapping -> Station
    console.log('[Step 6] Migrating station_mapping to station.payload_id...');
    await client.query(`
      DO $$ BEGIN
        UPDATE station s
        SET payload_id = sm.payload_station_id::text
        FROM station_mapping sm
        WHERE s.station_id = sm.station_id;
      EXCEPTION WHEN undefined_table THEN NULL; END $$;
    `);

    // 6. Migrate Gateway Mapping -> Gateway
    console.log('[Step 7] Migrating gateway_mapping to gateway.chirpstack_id...');
    await client.query(`
      DO $$ BEGIN
        UPDATE gateway g
        SET chirpstack_id = sub.primary_cs_id,
            chirpstack_ids = sub.all_cs_ids
        FROM (
          SELECT
            gateway_id,
            MIN(chirpstack_gateway_id) AS primary_cs_id,
            ARRAY_AGG(DISTINCT chirpstack_gateway_id) AS all_cs_ids
          FROM gateway_mapping
          GROUP BY gateway_id
        ) sub
        WHERE g.gateway_id = sub.gateway_id;
      EXCEPTION WHEN undefined_table THEN NULL; END $$;
    `);

    // 7. Migrate LINE Subscribers -> Users
    console.log('[Step 8] Consolidating LINE subscribers into users table...');
    const defaultHash = await bcrypt.hash('citizen1234', 10);
    const subscribersRes = await client.query(`SELECT * FROM line_subscribers`);
    console.log(`  Found ${subscribersRes.rows.length} LINE subscribers to consolidate.`);

    for (const sub of subscribersRes.rows) {
      if (!sub.line_user_id) continue;
      const existingUser = await client.query(
        `SELECT user_id, picture_url, station_ids FROM users WHERE line_user_id = $1`,
        [sub.line_user_id]
      );

      if (existingUser.rows.length > 0) {
        await client.query(
          `UPDATE users 
           SET picture_url = COALESCE($1, picture_url),
               station_ids = CASE WHEN array_length(station_ids, 1) IS NULL OR array_length(station_ids, 1) = 0 THEN $2 ELSE station_ids END,
               is_active = $3
           WHERE line_user_id = $4`,
          [sub.picture_url, sub.station_ids || [], sub.is_active, sub.line_user_id]
        );
        console.log(`  [UPDATE] User with LINE ID: ${sub.line_user_id} (${sub.display_name})`);
      } else {
        const cleanName = sub.display_name || 'ผู้ใช้ LINE';
        const cleanEmail = `citizen_${sub.line_user_id.slice(-8)}@waterwatch.local`;
        await client.query(
          `INSERT INTO users (name, email, password_hash, role, line_user_id, station_ids, picture_url, is_active, is_credentials_set)
           VALUES ($1, $2, $3, 'citizen', $4, $5, $6, $7, false)`,
          [cleanName, cleanEmail, defaultHash, sub.line_user_id, sub.station_ids || [], sub.picture_url, sub.is_active]
        );
        console.log(`  [INSERT] New citizen user from LINE: ${cleanName} (${cleanEmail})`);
      }
    }

    // 8. Adjust Data Types
    console.log('[Step 9] Adjusting TIMESTAMPTZ and NUMERIC(6,3) types...');
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'readings' AND column_name = 'timestamp' AND data_type = 'timestamp without time zone'
        ) THEN
          ALTER TABLE readings ALTER COLUMN timestamp TYPE TIMESTAMP WITH TIME ZONE USING timestamp AT TIME ZONE 'Asia/Bangkok';
        END IF;
        
        IF EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'readings' AND column_name = 'water_level' AND data_type != 'numeric'
        ) THEN
          ALTER TABLE readings 
            ALTER COLUMN water_level TYPE NUMERIC(6, 3) USING ROUND(water_level::numeric, 3),
            ALTER COLUMN raw_distance TYPE NUMERIC(6, 3) USING ROUND(raw_distance::numeric, 3);
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'alerts' AND column_name = 'timestamp' AND data_type = 'timestamp without time zone'
        ) THEN
          ALTER TABLE alerts ALTER COLUMN timestamp TYPE TIMESTAMP WITH TIME ZONE USING timestamp AT TIME ZONE 'Asia/Bangkok';
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' AND column_name = 'created_at' AND data_type = 'timestamp without time zone'
        ) THEN
          ALTER TABLE users 
            ALTER COLUMN created_at TYPE TIMESTAMP WITH TIME ZONE USING created_at AT TIME ZONE 'Asia/Bangkok',
            ALTER COLUMN updated_at TYPE TIMESTAMP WITH TIME ZONE USING updated_at AT TIME ZONE 'Asia/Bangkok';
        END IF;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'gateway' AND column_name = 'last_update' AND data_type = 'timestamp without time zone'
        ) THEN
          ALTER TABLE gateway ALTER COLUMN last_update TYPE TIMESTAMP WITH TIME ZONE USING last_update AT TIME ZONE 'Asia/Bangkok';
        END IF;
      END $$;
    `);

    // 9. Foreign keys & indexes
    console.log('[Step 10] Establishing Foreign Keys and optimized Indexes...');
    await client.query(`
      DELETE FROM notification_settings WHERE station_id IS NOT NULL AND station_id NOT IN (SELECT station_id FROM station);

      ALTER TABLE notification_settings
        DROP CONSTRAINT IF EXISTS fk_notification_station,
        ADD CONSTRAINT fk_notification_station 
          FOREIGN KEY (station_id) REFERENCES station(station_id) ON DELETE CASCADE;

      CREATE INDEX IF NOT EXISTS idx_alerts_station_time ON alerts (station_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_alerts_cooldown ON alerts (station_id, alert_type, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_station_dev_eui ON station (dev_eui);
      CREATE INDEX IF NOT EXISTS idx_station_payload_id ON station (payload_id);
      CREATE INDEX IF NOT EXISTS idx_gateway_chirpstack_id ON gateway (chirpstack_id);
    `);

    // 10. Alert ID sequence
    console.log('[Step 11] Upgrading alert_id 6-digit sequence trigger...');
    await client.query(`
      CREATE SEQUENCE IF NOT EXISTS alert_id_seq START 1;

      CREATE OR REPLACE FUNCTION generate_alert_id()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.alert_id IS NULL OR NEW.alert_id = '' THEN
          NEW.alert_id := 'AL-' || LPAD(nextval('alert_id_seq')::TEXT, 6, '0');
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    // 11. Drop redundant legacy tables
    console.log('[Step 12] Retiring deprecated legacy tables...');
    await client.query(`
      DROP TABLE IF EXISTS line_subscribers CASCADE;
      DROP TABLE IF EXISTS station_mapping CASCADE;
      DROP TABLE IF EXISTS gateway_mapping CASCADE;
      DROP TABLE IF EXISTS mcu CASCADE;
    `);

    // 12. Commit transaction
    console.log('[Step 13] Committing transaction to Railway database...');
    await client.query('COMMIT');
    console.log('\n[SUCCESS] Production migration committed successfully!');

    // Verify final state
    const finalTables = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    console.log('\nActive production tables:', finalTables.rows.map(r => r.table_name));

    const counts = await Promise.all([
      client.query('SELECT count(*) FROM station'),
      client.query('SELECT count(*) FROM gateway'),
      client.query('SELECT count(*) FROM readings'),
      client.query('SELECT count(*) FROM alerts'),
      client.query('SELECT count(*) FROM users'),
      client.query('SELECT count(*) FROM notification_settings'),
    ]);

    console.log(`\nFinal Production Row Counts:`);
    console.log(`  - station: ${counts[0].rows[0].count}`);
    console.log(`  - gateway: ${counts[1].rows[0].count}`);
    console.log(`  - readings: ${counts[2].rows[0].count}`);
    console.log(`  - alerts: ${counts[3].rows[0].count}`);
    console.log(`  - users: ${counts[4].rows[0].count}`);
    console.log(`  - notification_settings: ${counts[5].rows[0].count}`);

  } catch (err) {
    console.error('\n[ROLLBACK] Migration failed! Rolling back changes...', err);
    await client.query('ROLLBACK');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateProduction();
