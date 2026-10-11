/**
 * Database initialization script
 * Run: node src/scripts/initDb.js
 *
 * This will create all tables defined in sql/init.sql
 */
require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function initDb() {
  const clientConfig = process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_URL.includes('localhost')
          ? false
          : { rejectUnauthorized: false },
      }
    : {
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME     || 'water_monitor',
        user:     process.env.DB_USER     || 'postgres',
        password: process.env.DB_PASSWORD || '',
        ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      };

  const client = new Client(clientConfig);

  try {
    await client.connect();
    console.log('[OK] Connected to PostgreSQL');

    const sqlFiles = [
      'init.sql',
      'optimize_database_schema.sql',
    ];

    for (const file of sqlFiles) {
      const sqlPath = path.join(__dirname, '../../sql', file);
      if (fs.existsSync(sqlPath)) {
        console.log(`[SQL] Executing ${file}...`);
        const sql = fs.readFileSync(sqlPath, 'utf8');
        await client.query(sql);
        console.log(`[OK] ${file} executed successfully!`);
      }
    }

    console.log('[OK] All database schemas initialized successfully!');
  } catch (err) {
    console.error('[ERROR] Failed to initialize database:', err.message);
    if (require.main === module) {
      process.exit(1);
    }
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  initDb();
}

module.exports = { initDb };
