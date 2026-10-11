process.env.TZ = 'Asia/Bangkok';
require('dotenv').config(); // Reload environment variables
const app = require('./app');
const { testConnection } = require('./config/database');
const { connectMqtt, disconnectMqtt } = require('./config/mqtt');
const { checkOfflineStations } = require('./services/alertService');

const PORT = parseInt(process.env.PORT || '3001', 10);

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
});

async function startServer() {
  console.log('==============================================');
  console.log('  FloodGuard — Telemetry & Alert Backend Server');
  console.log('==============================================');

  // 1. Start HTTP server immediately on 0.0.0.0 so Railway / Cloud healthchecks pass instantly
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n[Startup] [OK] HTTP server running on http://0.0.0.0:${PORT}`);
    console.log(`[Startup] Healthcheck: http://0.0.0.0:${PORT}/health`);
    console.log(`[Startup] Root endpoint: http://0.0.0.0:${PORT}/`);
  });

  server.on('error', (err) => {
    console.error('[Startup] HTTP Server error:', err.message);
  });

  // 2. Test database connection & verify / migrate schema
  console.log('\n[Startup] Connecting to PostgreSQL...');
  try {
    const dbOk = await testConnection();
    if (!dbOk) {
      console.error('[Startup] [ERROR] Cannot connect to database. Check DATABASE_URL or .env settings.');
      console.error('[Startup] Continuing without DB (API will return errors until DB is available)');
    } else {
      const { query } = require('./config/database');

      // Check if station table exists
      const checkRes = await query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'station'
        );
      `);
      const hasTables = checkRes.rows[0]?.exists;

      if (!hasTables) {
        console.log('[Startup] Database tables not found. Auto-initializing schemas...');
        const { initDb } = require('./scripts/initDb');
        await initDb();
        const { seedUsers } = require('./scripts/seedUsers');
        await seedUsers().catch((err) => console.warn('[Startup] Seed users note:', err.message));
        console.log('[Startup] [OK] Database auto-initialization complete!');
      } else {
        // Ensure ENUM types contain latest values (must run OUTSIDE transaction blocks)
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
            await query(eq);
          } catch (_) {}
        }

        // Ensure database is migrated to the clean 6-table unified architecture
        try {
          const checkLegacy = await query(`
            SELECT 
              EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'mcu') AS mcu_exists,
              EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'station' AND column_name = 'dev_eui') AS dev_eui_exists,
              EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'line_subscribers') AS subs_exists,
              EXISTS (SELECT FROM information_schema.columns WHERE table_name = 'station' AND column_name = 'status_updated_at') AS status_updated_at_exists;
          `);
          const row = checkLegacy.rows[0];
          const needsMigration = Boolean(
            row?.mcu_exists ||
            !row?.dev_eui_exists ||
            row?.subs_exists ||
            !row?.status_updated_at_exists
          );

          if (needsMigration) {
            console.log('[Startup] Legacy database schema detected on server. Running zero-loss auto-migration...');
            const fs = require('fs');
            const path = require('path');
            const sqlPath = path.join(__dirname, '../sql/optimize_database_schema.sql');
            if (fs.existsSync(sqlPath)) {
              const migrationSql = fs.readFileSync(sqlPath, 'utf8');
              await query(migrationSql);
              console.log('[Startup] [OK] Database schema successfully migrated to unified 6-table architecture without data loss!');
            }
          } else {
            console.log('[Startup] Database schema verified: Unified 6-table architecture is up to date.');
          }
        } catch (migErr) {
          console.error('[Startup] Auto-migration warning:', migErr.message);
        }

        // Ensure is_credentials_set column exists in users table
        await query(`
          ALTER TABLE users 
          ADD COLUMN IF NOT EXISTS is_credentials_set BOOLEAN NOT NULL DEFAULT FALSE;
        `).catch((err) => console.warn('[Startup] Column check note:', err.message));
      }
    }
  } catch (initErr) {
    console.error('[Startup] Database initialization error:', initErr.message);
  }

  // 3. Start MQTT subscriber (only when MQTT_BROKER is explicitly configured)
  if (process.env.MQTT_BROKER && process.env.MQTT_BROKER.trim() !== '') {
    console.log('\n[Startup] Connecting to MQTT broker...');
    try {
      connectMqtt();
    } catch (mqttErr) {
      console.warn('[Startup] MQTT connection error:', mqttErr.message);
    }
  } else {
    console.log('\n[Startup] MQTT_BROKER not configured — running in HTTP Webhook mode.');
    console.log('[Startup] Uplinks will be received via POST /api/readings/webhook from ChirpStack HTTP Integration.');
  }

  // 4. Start periodic offline station & gateway check every 1 minute
  const OFFLINE_CHECK_INTERVAL = 1 * 60 * 1000;
  const offlineCheckTimer = setInterval(() => {
    checkOfflineStations().catch((err) => {
      console.error('[Server] Offline stations check error:', err.message);
    });
  }, OFFLINE_CHECK_INTERVAL);

  // Initial check after 10s
  setTimeout(() => checkOfflineStations().catch(() => {}), 10000);

  // 5. Initialize daily morning (07:00) & evening (18:00) automated water summary scheduler
  let schedulerTasks = null;
  try {
    const { initScheduler } = require('./services/schedulerService');
    schedulerTasks = initScheduler();
  } catch (schedErr) {
    console.warn('[Startup] Scheduler initialization warning:', schedErr.message);
  }

  // 6. Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\n[Shutdown] Received ${signal}. Shutting down gracefully...`);
    clearInterval(offlineCheckTimer);
    try {
      schedulerTasks?.morningTask?.stop();
      schedulerTasks?.eveningTask?.stop();
    } catch (_) {}
    disconnectMqtt();
    server.close(() => {
      console.log('[Shutdown] HTTP server closed');
      process.exit(0);
    });
    // Force exit after 5s
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

startServer().catch((err) => {
  console.error('[Fatal] startServer error:', err);
});
