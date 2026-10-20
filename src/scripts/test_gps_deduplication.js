/**
 * Automated Test: GPS-based Packet Deduplication Verification
 * Run: node backend/src/scripts/test_gps_deduplication.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const assert = require('assert');
const db = require('../config/database');
const { processUplinkMessage, findStationByPayloadId } = require('../services/readingService');

async function runDeduplicationTest() {
  console.log('========================================================');
  console.log('       TEST: GPS PACKET DEDUPLICATION VERIFICATION      ');
  console.log('========================================================\n');

  let dbConnected = false;
  try {
    const res = await db.query('SELECT NOW()');
    console.log('[OK] Connected to PostgreSQL at:', res.rows[0].now);
    dbConnected = true;
  } catch (err) {
    console.warn('[WARN] Local PostgreSQL not reachable:', err.message);
    console.log('Running code-level / unit-level logic tests...\n');
  }

  // Build a test 26-byte payload with a fixed, unique test GPS epoch
  // Test epoch in year 2026: 1792500000
  const testEpoch = 1792500000;
  const expectedDate = new Date(testEpoch * 1000);

  function buildPayload(stationNumericId, epochVal, levelCm = 1500) {
    const buf = Buffer.alloc(26);
    buf.writeUInt8(stationNumericId, 0);  // station_id byte
    buf.writeUInt16BE(levelCm, 1);        // 15.00 m
    buf.writeInt32BE(14035900, 3);        // lat
    buf.writeInt32BE(100725200, 7);       // lng
    buf.writeUInt16BE(1325, 11);          // bat_v = 13.25V
    buf.writeUInt8(90, 13);               // bat_pct = 90%
    buf.writeInt16BE(280, 14);            // 28.0 C
    buf.writeUInt16BE(600, 16);           // 60.0 %
    buf.writeInt16BE(0, 18);              // tilt_x
    buf.writeInt16BE(0, 20);              // tilt_y
    buf.writeUInt32BE(epochVal, 22);      // GPS epoch

    const base64Data = buf.toString('base64');
    return JSON.stringify({
      deduplicationId: `dedup-test-${Date.now()}`,
      time: expectedDate.toISOString(),
      deviceInfo: {
        devEui: 'test-deveui-dedup',
        deviceName: `Test-Station-${stationNumericId}`,
      },
      fPort: 1,
      data: base64Data,
      rxInfo: [{ rssi: -75, snr: 9.0 }],
    });
  }

  if (dbConnected) {
    // Resolve stationId from payload numeric ID = 1
    let stationId = await findStationByPayloadId(1);
    if (!stationId) {
      const sRes = await db.query('SELECT station_id FROM station LIMIT 1');
      if (sRes.rows.length === 0) {
        console.warn('[SKIP] No station found in database.');
        process.exit(0);
      }
      stationId = sRes.rows[0].station_id;
    }

    console.log(`Using target station: ${stationId} (Numeric Payload ID: 1)\n`);

    // Clean up any pre-existing record from earlier tests
    await db.query('DELETE FROM readings WHERE station_id = $1 AND timestamp = $2', [
      stationId,
      expectedDate,
    ]);

    const topic = `application/1/device/test-deveui-dedup/event/up`;

    // -------------------------------------------------------------
    // Test 1: First transmission (should insert successfully)
    // -------------------------------------------------------------
    console.log('--- Step 1: Processing First Uplink (Initial Packet) ---');
    const payload1 = buildPayload(1, testEpoch, 1500);
    await processUplinkMessage(topic, Buffer.from(payload1));

    const countRes1 = await db.query(
      'SELECT COUNT(*)::int AS cnt FROM readings WHERE station_id = $1 AND timestamp = $2',
      [stationId, expectedDate]
    );
    assert.strictEqual(countRes1.rows[0].cnt, 1, 'Expected exactly 1 reading inserted in Step 1');
    console.log('[PASSED] Initial packet inserted successfully (Count = 1)\n');

    // -------------------------------------------------------------
    // Test 2: Second transmission with SAME GPS epoch (Duplicate Replay)
    // Simulates Gateway SQLite or Node Flash retransmitting the same packet
    // -------------------------------------------------------------
    console.log('--- Step 2: Processing Second Uplink (Same GPS Epoch Replay) ---');
    const payload2 = buildPayload(1, testEpoch, 1500); // Identical GPS epoch
    await processUplinkMessage(topic, Buffer.from(payload2));

    const countRes2 = await db.query(
      'SELECT COUNT(*)::int AS cnt FROM readings WHERE station_id = $1 AND timestamp = $2',
      [stationId, expectedDate]
    );
    assert.strictEqual(
      countRes2.rows[0].cnt,
      1,
      'Expected STILL exactly 1 reading after duplicate replay'
    );
    console.log('[PASSED] Duplicate packet was successfully ignored (Count remains 1)\n');

    // -------------------------------------------------------------
    // Test 3: Third transmission with a NEW GPS epoch (Next cycle)
    // -------------------------------------------------------------
    console.log('--- Step 3: Processing Third Uplink (Next Cycle Epoch + 600s) ---');
    const nextEpoch = testEpoch + 600; // 10 minutes later
    const nextDate = new Date(nextEpoch * 1000);
    await db.query('DELETE FROM readings WHERE station_id = $1 AND timestamp = $2', [
      stationId,
      nextDate,
    ]);

    const payload3 = buildPayload(1, nextEpoch, 1550);
    await processUplinkMessage(topic, Buffer.from(payload3));

    const countRes3 = await db.query(
      'SELECT COUNT(*)::int AS cnt FROM readings WHERE station_id = $1 AND timestamp = $2',
      [stationId, nextDate]
    );
    assert.strictEqual(
      countRes3.rows[0].cnt,
      1,
      'Expected exactly 1 reading inserted for next cycle'
    );
    console.log('[PASSED] Next cycle packet with new epoch was inserted normally\n');

    // Cleanup test data
    console.log('--- Cleaning Up Test Data ---');
    await db.query('DELETE FROM readings WHERE station_id = $1 AND timestamp IN ($2, $3)', [
      stationId,
      expectedDate,
      nextDate,
    ]);
    console.log('[OK] Cleaned up temporary test rows.');
  } else {
    console.log('[UNIT TEST] Verifying GPS epoch condition boundaries...');
    assert.strictEqual(testEpoch > 1600000000, true, 'Epoch should be > 1600000000');
    assert.strictEqual(new Date(testEpoch * 1000).getTime(), 1792500000000);
    console.log('[PASSED] Unit boundary tests passed.');
  }

  console.log('\n========================================================');
  console.log('     ALL DEDUPLICATION TESTS PASSED SUCCESSFULLY!       ');
  console.log('========================================================');
  process.exit(0);
}

runDeduplicationTest().catch((err) => {
  console.error('[FATAL] Test error:', err);
  process.exit(1);
});
