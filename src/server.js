process.env.TZ = 'Asia/Bangkok';
require('dotenv').config();
const app = require('./app');
const { testConnection } = require('./config/database');
const { connectMqtt, disconnectMqtt } = require('./config/mqtt');
const { checkOfflineStations } = require('./services/alertService');

const PORT = process.env.PORT || 3001;

async function startServer() {
  console.log('==============================================');
  console.log('  FloodGuard — Telemetry & Alert Backend Server');
  console.log('==============================================');

  // 1. Test database connection
  console.log('\n[Startup] Connecting to PostgreSQL...');
  const dbOk = await testConnection();
  if (!dbOk) {
    console.error('[Startup] [ERROR] Cannot connect to database. Check .env settings.');
    console.error('[Startup] Continuing without DB (API will return errors until DB is available)');
  } else {
    // Check if database tables exist, auto-initialize if empty
    try {
      const { query } = require('./config/database');
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
      }
    } catch (initErr) {
      console.error('[Startup] Auto-initialization error:', initErr.message);
    }
  }

  // 2. Start MQTT subscriber (only when MQTT_BROKER is explicitly configured)
  if (process.env.MQTT_BROKER && process.env.MQTT_BROKER.trim() !== '') {
    console.log('\n[Startup] Connecting to MQTT broker...');
    connectMqtt();
  } else {
    console.log('\n[Startup] MQTT_BROKER not configured — running in HTTP Webhook mode.');
    console.log('[Startup] Uplinks will be received via POST /api/readings/webhook from ChirpStack HTTP Integration.');
  }

  // 3. Start HTTP server
  const server = app.listen(PORT, () => {
    console.log(`\n[Startup] [OK] HTTP server running on http://localhost:${PORT}`);
    console.log(`[Startup] API endpoints:`);
    console.log(`   GET http://localhost:${PORT}/health`);
    console.log(`   POST http://localhost:${PORT}/api/auth/login`);
    console.log(`   GET  http://localhost:${PORT}/api/users`);
    console.log(`   GET  http://localhost:${PORT}/api/alerts`);
    console.log(`   GET  http://localhost:${PORT}/api/readings`);
    console.log(`   GET  http://localhost:${PORT}/api/readings/:stationId`);
    console.log(`   GET  http://localhost:${PORT}/api/readings/:stationId/range?start=...&end=...`);
    console.log(`   GET  http://localhost:${PORT}/api/stations`);
    console.log(`   GET  http://localhost:${PORT}/api/stations/:stationId`);
    console.log('\n Press Ctrl+C to stop\n');
  });

  // 4. Start periodic offline station check (Condition 1.3) every 5 minutes
  const OFFLINE_CHECK_INTERVAL = 5 * 60 * 1000;
  const offlineCheckTimer = setInterval(() => {
    checkOfflineStations().catch((err) => {
      console.error('[Server] Offline stations check error:', err.message);
    });
  }, OFFLINE_CHECK_INTERVAL);

  // Initial check after 10s
  setTimeout(() => checkOfflineStations().catch(() => {}), 10000);

  // 5. Graceful shutdown
  const shutdown = (signal) => {
    console.log(`\n[Shutdown] Received ${signal}. Shutting down gracefully...`);
    clearInterval(offlineCheckTimer);
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

startServer();
