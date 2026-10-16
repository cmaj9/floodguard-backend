/**
 * Automated Test: 26-Byte LoRaWAN Payload Decoder and ChirpStack Verification
 * Run: node src/scripts/test_lorawan_decoder_and_verification.js
 */
const assert = require('assert');
const { parseChirpStackPayload } = require('../services/readingService');
const chirpstackService = require('../services/chirpstackService');

console.log('--- TEST 1: 26-Byte Binary LoRaWAN Payload Decoding ---');

// Build a 26-byte test buffer mimicking firmware buildSensorPayload()
const buf = Buffer.alloc(26);
buf.writeUInt8(1, 0);                 // station_id = 1
buf.writeUInt16BE(1640, 1);           // water_level = 164.0 cm (1.640 m)
buf.writeInt32BE(14035900, 3);        // lat = 14.035900 deg
buf.writeInt32BE(100725200, 7);       // lng = 100.725200 deg
buf.writeUInt16BE(1325, 11);          // bat_v = 13.25 V
buf.writeUInt8(95, 13);               // bat_pct = 95%
buf.writeInt16BE(285, 14);            // temp = 28.5 C
buf.writeUInt16BE(650, 16);           // hum = 65.0 %
buf.writeInt16BE(-80, 18);            // gyro_x = -0.80 deg
buf.writeInt16BE(-780, 20);           // gyro_y = -7.80 deg
buf.writeUInt32BE(1792144800, 22);    // epoch = 1792144800

const base64Data = buf.toString('base64');
console.log('Sample Base64 Payload:', base64Data);

const chirpstackMockPayload = {
  deduplicationId: 'test-uuid-1234',
  time: '2026-10-16T18:00:00Z',
  deviceInfo: {
    devEui: '65bcbb52145372b1',
    deviceName: 'ST-001-KlongLuang',
  },
  fPort: 1,
  data: base64Data,
  rxInfo: [
    {
      rssi: -85,
      snr: 7.5,
    },
  ],
};

const result = parseChirpStackPayload(chirpstackMockPayload);
console.log('Decoded Result:', JSON.stringify(result, null, 2));

assert.strictEqual(result.devEui, '65bcbb52145372b1', 'devEui should match');
assert.strictEqual(result.fields.station_id, 1, 'station_id should be 1');
assert.strictEqual(result.fields.raw_distance, 1.64, 'raw_distance should be 1.64 m');
assert.strictEqual(result.fields.latitude, 14.0359, 'latitude should be 14.0359');
assert.strictEqual(result.fields.longitude, 100.7252, 'longitude should be 100.7252');
assert.strictEqual(result.fields.battery_voltage, 13.25, 'battery_voltage should be 13.25 V');
assert.strictEqual(result.fields.battery_percent, 95, 'battery_percent should be 95%');
assert.strictEqual(result.fields.temperature, 28.5, 'temperature should be 28.5 C');
assert.strictEqual(result.fields.humidity, 65.0, 'humidity should be 65.0%');
assert.strictEqual(result.fields.tilt_x, -0.8, 'tilt_x should be -0.8 deg');
assert.strictEqual(result.fields.tilt_y, -7.8, 'tilt_y should be -7.8 deg');
assert.strictEqual(result.fields.epoch, 1792144800, 'epoch should match');
assert.strictEqual(result.rssi, -85, 'rssi should be -85');
assert.strictEqual(result.snr, 7.5, 'snr should be 7.5');

console.log('[PASSED] 26-Byte Binary LoRaWAN Payload Decoder verified successfully!\n');

console.log('--- TEST 2: ChirpStack Verification Service ---');

(async () => {
  // 1. Invalid DevEUI length
  const invalidRes = await chirpstackService.verifyDevice('short');
  assert.strictEqual(invalidRes.found, false, 'Invalid DevEUI length must fail');
  console.log('[PASSED] Invalid DevEUI length validation passed');

  // 2. Valid DevEUI with unconfigured token
  const unconfiguredRes = await chirpstackService.verifyDevice('65bcbb52145372b1');
  if (!chirpstackService.isConfigured()) {
    assert.strictEqual(unconfiguredRes.configured, false, 'Should report not configured');
    assert.strictEqual(unconfiguredRes.found, null, 'Should return null for found when unconfigured');
    console.log('[PASSED] Graceful unconfigured ChirpStack handling passed');
  }

  console.log('\n*** ALL TESTS PASSED SUCCESSFULLY! ***');
  process.exit(0);
})();
