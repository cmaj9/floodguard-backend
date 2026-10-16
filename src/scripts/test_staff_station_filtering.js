/**
 * Test Staff Station Access Control & Filtering (Using native fetch)
 */
require('dotenv').config();
const http = require('http');
const app = require('../app');
const db = require('../config/database');
const { generateToken } = require('../middleware/auth');

async function runTests() {
  console.log('=== Starting Staff Station Access Control Tests ===');
  let failures = 0;

  // Start app on ephemeral port
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[Server] Test server listening on ${baseUrl}`);

  try {
    // 1. Get existing stations from DB
    const stationsRes = await db.query('SELECT station_id FROM station ORDER BY station_id ASC');
    const allStationIds = stationsRes.rows.map(r => r.station_id);
    console.log(`[Setup] Found ${allStationIds.length} stations in DB:`, allStationIds);

    const testStation1 = allStationIds[0];
    const testStation2 = allStationIds[1] || 'ST-TEST-NONEXIST';

    // 2. Create or verify a mock staff user with only testStation1 assigned
    const staffUserWithOneStation = {
      id: 99991,
      name: 'ทดสอบ Staff 1 สถานี',
      email: 'staff_test1@floodguard.test',
      role: 'staff',
      stationIds: [testStation1],
    };

    await db.query(`
      INSERT INTO users (user_id, name, email, password_hash, role, station_ids)
      VALUES ($1, $2, $3, 'testhash', 'staff', $4)
      ON CONFLICT (email) DO UPDATE SET station_ids = $4, role = 'staff'
    `, [staffUserWithOneStation.id, staffUserWithOneStation.name, staffUserWithOneStation.email, [testStation1]]);

    const staffToken1 = generateToken(staffUserWithOneStation);

    // 3. Create or verify a mock staff user with NO stations assigned
    const staffUserWithZeroStations = {
      id: 99992,
      name: 'ทดสอบ Staff 0 สถานี',
      email: 'staff_test0@floodguard.test',
      role: 'staff',
      stationIds: [],
    };
    await db.query(`
      INSERT INTO users (user_id, name, email, password_hash, role, station_ids)
      VALUES ($1, $2, $3, 'testhash', 'staff', '{}')
      ON CONFLICT (email) DO UPDATE SET station_ids = '{}', role = 'staff'
    `, [staffUserWithZeroStations.id, staffUserWithZeroStations.name, staffUserWithZeroStations.email]);

    const staffToken0 = generateToken(staffUserWithZeroStations);

    // 4. Admin user
    const adminUser = {
      id: 99993,
      name: 'ทดสอบ Admin',
      email: 'admin_test@floodguard.test',
      role: 'admin',
    };
    const adminToken = generateToken(adminUser);

    // --- TEST 1: GET /api/stations unauthenticated ---
    const resPublic = await fetch(`${baseUrl}/api/stations`);
    const bodyPublic = await resPublic.json();
    console.log(`Test 1: GET /api/stations (Unauthenticated) -> Status: ${resPublic.status}, Count: ${bodyPublic.count}`);
    if (resPublic.status !== 200 || bodyPublic.count !== allStationIds.length) {
      console.error('FAIL: Test 1');
      failures++;
    } else {
      console.log('PASS: Test 1');
    }

    // --- TEST 2: GET /api/stations for Admin ---
    const resAdmin = await fetch(`${baseUrl}/api/stations`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const bodyAdmin = await resAdmin.json();
    console.log(`Test 2: GET /api/stations (Admin) -> Status: ${resAdmin.status}, Count: ${bodyAdmin.count}`);
    if (resAdmin.status !== 200 || bodyAdmin.count !== allStationIds.length) {
      console.error('FAIL: Test 2');
      failures++;
    } else {
      console.log('PASS: Test 2');
    }

    // --- TEST 3: GET /api/stations for Staff with only 1 station ---
    const resStaff1 = await fetch(`${baseUrl}/api/stations`, {
      headers: { Authorization: `Bearer ${staffToken1}` }
    });
    const bodyStaff1 = await resStaff1.json();
    console.log(`Test 3: GET /api/stations (Staff 1 Station) -> Status: ${resStaff1.status}, Count: ${bodyStaff1.count}`);
    const returnedIds = bodyStaff1.data.map(s => s.station_id);
    if (resStaff1.status !== 200 || bodyStaff1.count !== 1 || returnedIds[0] !== testStation1) {
      console.error('FAIL: Test 3, expected only', testStation1, 'got', returnedIds);
      failures++;
    } else {
      console.log('PASS: Test 3');
    }

    // --- TEST 4: GET /api/stations for Staff with 0 stations ---
    const resStaff0 = await fetch(`${baseUrl}/api/stations`, {
      headers: { Authorization: `Bearer ${staffToken0}` }
    });
    const bodyStaff0 = await resStaff0.json();
    console.log(`Test 4: GET /api/stations (Staff 0 Stations) -> Status: ${resStaff0.status}, Count: ${bodyStaff0.count}`);
    if (resStaff0.status !== 200 || bodyStaff0.count !== 0) {
      console.error('FAIL: Test 4, expected 0 count, got', bodyStaff0.count);
      failures++;
    } else {
      console.log('PASS: Test 4');
    }

    // --- TEST 5: GET /api/stations/:stationId unauthorized for Staff ---
    if (testStation2) {
      const resDetailBlocked = await fetch(`${baseUrl}/api/stations/${testStation2}`, {
        headers: { Authorization: `Bearer ${staffToken1}` }
      });
      console.log(`Test 5: GET /api/stations/${testStation2} (Staff without this station) -> Status: ${resDetailBlocked.status}`);
      if (resDetailBlocked.status !== 403) {
        console.error('FAIL: Test 5, expected 403 Forbidden, got', resDetailBlocked.status);
        failures++;
      } else {
        console.log('PASS: Test 5');
      }
    }

    // --- TEST 6: POST /api/stations forbidden for Staff ---
    const resCreateStaff = await fetch(`${baseUrl}/api/stations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${staffToken1}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ station_id: 'ST-FORBIDDEN', station_name: 'Forbidden Station', gateway_id: 'GW-01' })
    });
    console.log(`Test 6: POST /api/stations (Staff attempt create) -> Status: ${resCreateStaff.status}`);
    if (resCreateStaff.status !== 403) {
      console.error('FAIL: Test 6, expected 403 Forbidden, got', resCreateStaff.status);
      failures++;
    } else {
      console.log('PASS: Test 6');
    }

    // Clean up mock test users
    await db.query(`DELETE FROM users WHERE email IN ('staff_test1@floodguard.test', 'staff_test0@floodguard.test', 'admin_test@floodguard.test')`);
    console.log('[Cleanup] Test users removed.');

  } catch (err) {
    console.error('Unexpected test error:', err);
    failures++;
  } finally {
    server.close();
    if (db.pool) await db.pool.end();
  }

  if (failures === 0) {
    console.log('\n>>> ALL 6 TESTS PASSED SUCCESSFULLY! <<<');
    process.exit(0);
  } else {
    console.error(`\n>>> ${failures} TESTS FAILED <<<`);
    process.exit(1);
  }
}

runTests();
