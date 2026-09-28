const db = require('../config/database');
const alertService = require('./alertService');

/**
 * Parse ChirpStack uplink payload into a readings record
 * Supports two formats:
 *   1. ChirpStack v4 with codec: payload.object contains decoded fields
 *   2. Raw Base64 bytes in payload.data (custom binary protocol)
 */
function parseChirpStackPayload(payload) {
  let fields = {};

  // ── Format 1: Decoded object from ChirpStack codec ──────────────
  if (payload.object && typeof payload.object === 'object') {
    const obj = payload.object;

    // Sensor sends distance to water in centimeters (cm), convert to meters (m)
    const rawSensorValue = obj.distance_cm ?? obj.distanceCm ?? obj.water_level ?? obj.waterLevel ?? obj.distance ?? obj.level ?? obj.water ?? obj.raw_distance ?? obj.rawDistance ?? null;
    const rawDistanceInMeters = rawSensorValue != null
      ? parseFloat((Number(rawSensorValue) / 100).toFixed(3))
      : null;

    fields = {
      raw_distance:    rawDistanceInMeters,
      water_level:     null, // Will be computed relative to station reference point
      is_blind_zone:   false,
      temperature:     obj.temperature     ?? obj.temp                       ?? null,
      humidity:        obj.humidity        ?? obj.hum                        ?? null,
      battery_voltage: obj.battery_voltage ?? obj.bat_v     ?? obj.batV     ?? null,
      battery_percent: obj.battery_percentage ?? obj.battery_percent ?? obj.bat_pct ?? obj.batPct ?? null,
      tilt_x:          obj.gyro_x ?? obj.tilt_x ?? obj.tiltX                 ?? null,
      tilt_y:          obj.gyro_y ?? obj.tilt_y ?? obj.tiltY                 ?? null,
      latitude:        obj.latitude        ?? obj.lat                        ?? (Array.isArray(payload.rxInfo) ? payload.rxInfo[0]?.location?.latitude : null) ?? null,
      longitude:       obj.longitude       ?? obj.longitude ?? obj.lon ?? obj.lng ?? (Array.isArray(payload.rxInfo) ? payload.rxInfo[0]?.location?.longitude : null) ?? null,
    };
  }

  // ── Format 2: Raw Base64 bytes ────────────────────────────────────
  else if (payload.data && typeof payload.data === 'string') {
    try {
      const buf = Buffer.from(payload.data, 'base64');
      // Expected byte layout (example - adjust to your firmware):
      // [0-1]   distance to water : int16 / 100  → meters
      // [2-3]   temperature       : int16 / 100  → °C
      // [4-5]   humidity          : uint16 / 100 → %
      // [6-7]   battery_volt      : uint16 / 1000 → V
      // [8]     battery_pct       : uint8         → %
      // [9-10]  tilt_x            : int16 / 100
      // [11-12] tilt_y            : int16 / 100
      if (buf.length >= 9) {
        fields = {
          raw_distance:    buf.length >= 2  ? buf.readInt16BE(0) / 100   : null,
          water_level:     null,
          is_blind_zone:   false,
          temperature:     buf.length >= 4  ? buf.readInt16BE(2) / 100   : null,
          humidity:        buf.length >= 6  ? buf.readUInt16BE(4) / 100  : null,
          battery_voltage: buf.length >= 8  ? buf.readUInt16BE(6) / 1000 : null,
          battery_percent: buf.length >= 9  ? buf.readUInt8(8)           : null,
          tilt_x:          buf.length >= 11 ? buf.readInt16BE(9) / 100   : null,
          tilt_y:          buf.length >= 13 ? buf.readInt16BE(11) / 100  : null,
          latitude:        null,
          longitude:       null,
        };
      }
    } catch (err) {
      console.warn('[Parser] Failed to decode Base64 payload:', err.message);
    }
  }

  // ── Extract RSSI and SNR from rxInfo ─────────────────────────────
  let rssi = null;
  let snr = null;
  if (Array.isArray(payload.rxInfo) && payload.rxInfo.length > 0) {
    rssi = payload.rxInfo[0].rssi  ?? null;
    snr  = payload.rxInfo[0].snr   ?? null;
  }

  // ── Extract device EUI (used to find station_id) ─────────────────
  const devEui = payload.deviceInfo?.devEui ?? payload.devEUI ?? null;

  return { devEui, fields, rssi, snr };
}

/**
 * Find station_id by matching mcu records with the device EUI
 * Falls back to checking station directly if no mcu record found
 */
async function findStationByDevEui(devEui) {
  if (!devEui) return null;
  try {
    // Check mcu table first (mcu_id = devEUI format or similar)
    const res = await db.query(
      `SELECT station_id FROM mcu WHERE mcu_id = $1 LIMIT 1`,
      [devEui]
    );
    if (res.rows.length > 0) {
      return res.rows[0].station_id;
    }

    // Fallback: check station directly by device_id pattern
    const res2 = await db.query(
      `SELECT station_id FROM station WHERE station_id = $1 LIMIT 1`,
      [devEui]
    );
    if (res2.rows.length > 0) {
      return res2.rows[0].station_id;
    }

    return null;
  } catch (err) {
    console.error('[ReadingService] findStationByDevEui error:', err.message);
    return null;
  }
}

/**
 * Find station_id by matching payload station_id via station_mapping table
 * Supports both number (1, 2) and string ("1", "ST-001")
 */
async function findStationByPayloadId(payloadStationId) {
  if (payloadStationId == null) return null;
  try {
    // If it's already in format 'ST-001', verify and return directly
    if (typeof payloadStationId === 'string' && payloadStationId.startsWith('ST-')) {
      const sRes = await db.query(
        `SELECT station_id FROM station WHERE station_id = $1 LIMIT 1`,
        [payloadStationId]
      );
      if (sRes.rows.length > 0) return sRes.rows[0].station_id;
    }

    const numId = parseInt(payloadStationId, 10);
    if (!isNaN(numId)) {
      const res = await db.query(
        `SELECT station_id FROM station_mapping WHERE payload_station_id = $1 LIMIT 1`,
        [numId]
      );
      if (res.rows.length > 0) {
        return res.rows[0].station_id;
      }
    }
    return null;
  } catch (err) {
    console.error('[ReadingService] findStationByPayloadId error:', err.message);
    return null;
  }
}

/**
 * Update gateway status to 'online' when we receive data through it.
 * Uses gateway_mapping table to translate ChirpStack hex ID → DB gateway_id.
 */
async function updateGatewayStatus(payload) {
  if (!Array.isArray(payload.rxInfo) || payload.rxInfo.length === 0) return;
  const gw = payload.rxInfo[0];
  const chirpstackGatewayId = gw.gatewayId;
  if (!chirpstackGatewayId) return;
  try {
    // 1. Lookup from gateway_mapping table
    const mapRes = await db.query(
      `SELECT gateway_id FROM gateway_mapping WHERE chirpstack_gateway_id = $1 LIMIT 1`,
      [chirpstackGatewayId]
    );

    let targetGatewayId = null;
    if (mapRes.rows.length > 0) {
      targetGatewayId = mapRes.rows[0].gateway_id;
    } else {
      // 2. Fallback: check if the hex ID exists directly as gateway_id in gateway table
      const directRes = await db.query(
        `SELECT gateway_id FROM gateway WHERE gateway_id = $1 LIMIT 1`,
        [chirpstackGatewayId]
      );
      if (directRes.rows.length > 0) {
        targetGatewayId = directRes.rows[0].gateway_id;
      }
    }

    if (!targetGatewayId) {
      console.warn(`[ReadingService] No gateway mapping found for ChirpStack ID: ${chirpstackGatewayId}`);
      return;
    }

    await db.query(
      `UPDATE gateway SET last_update = NOW(), status = 'online' WHERE gateway_id = $1`,
      [targetGatewayId]
    );
  } catch (err) {
    console.warn('[ReadingService] updateGatewayStatus warning:', err.message);
  }
}

/**
 * Insert a reading record into the database
 */
async function insertReading(stationId, fields, rssi, snr, timestamp) {
  const sql = `
    INSERT INTO readings (
      station_id, timestamp,
      raw_distance, water_level, is_blind_zone,
      temperature, humidity,
      battery_voltage, battery_percent,
      rssi, snr,
      tilt_x, tilt_y,
      latitude, longitude
    ) VALUES (
      $1, $2,
      $3, $4, $5,
      $6, $7,
      $8, $9,
      $10, $11,
      $12, $13,
      $14, $15
    )
    RETURNING reading_id, timestamp
  `;

  const values = [
    stationId,
    timestamp || new Date(),
    fields.raw_distance,
    fields.water_level,
    fields.is_blind_zone || false,
    fields.temperature,
    fields.humidity,
    fields.battery_voltage,
    fields.battery_percent,
    rssi,
    snr,
    fields.tilt_x,
    fields.tilt_y,
    fields.latitude,
    fields.longitude,
  ];

  const res = await db.query(sql, values);
  return res.rows[0];
}

/**
 * Update mcu's last_update, signal_strength, battery_level
 */
async function updateMcuStatus(stationId, { rssi, battery_percent }) {
  try {
    await db.query(
      `UPDATE mcu SET
        signal_strength = COALESCE($1, signal_strength),
        battery_level   = COALESCE($2, battery_level),
        last_update     = NOW()
       WHERE station_id = $3`,
      [rssi, battery_percent, stationId]
    );
  } catch (err) {
    // Non-critical: log but don't throw
    console.warn('[ReadingService] updateMcuStatus warning:', err.message);
  }
}

/**
 * Main function: process a ChirpStack uplink message
 * Called from MQTT subscriber on each received message
 */
async function processUplinkMessage(topic, payloadBuffer) {
  // Ignore raw gateway bridge topics (binary protobuf) to avoid JSON parse errors
  if (topic.includes('gateway') && !topic.includes('application')) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(payloadBuffer.toString());
  } catch (err) {
    console.warn(`[ReadingService] Skipped non-JSON payload on topic: ${topic}`);
    return;
  }

  const { devEui, fields, rssi, snr } = parseChirpStackPayload(payload);

  // Extract timestamp from payload: measured_at (from sensor), payload.time (from ChirpStack), or now
  const rawTime = payload.object?.measured_at || payload.time;
  const timestamp = rawTime ? new Date(rawTime) : new Date();

  // Extract payload station_id from decoded object or root
  const payloadStationId = payload.object?.station_id ?? payload.station_id ?? null;

  // Try mapping from payload station_id first, then fallback to devEui
  let stationId = await findStationByPayloadId(payloadStationId);
  if (!stationId) {
    stationId = await findStationByDevEui(devEui);
  }
  if (!stationId) {
    console.warn(`[ReadingService] No station found | payload_station_id: ${payloadStationId} | devEUI: ${devEui} | Topic: ${topic}`);
    return;
  }

  // Fetch station calibration settings
  let sensorToRef = 2.0;
  let blindZoneOffset = 0.28;
  let tiltCompensationEnabled = true;

  try {
    const sRes = await db.query(
      `SELECT sensor_to_ref_distance, reference_point_name, blind_zone_offset, tilt_compensation_enabled
       FROM station WHERE station_id = $1 LIMIT 1`,
      [stationId]
    );
    if (sRes.rows.length > 0) {
      const sRow = sRes.rows[0];
      if (sRow.sensor_to_ref_distance != null) sensorToRef = Number(sRow.sensor_to_ref_distance);
      if (sRow.blind_zone_offset != null) blindZoneOffset = Number(sRow.blind_zone_offset);
      if (sRow.tilt_compensation_enabled != null) tiltCompensationEnabled = sRow.tilt_compensation_enabled;
    }
  } catch (err) {
    console.warn('[ReadingService] Failed to fetch station calibration:', err.message);
  }

  // Calculate relative water level: ΔL = D_ref - D_sensor (pure vertical distance)
  if (fields.raw_distance != null) {
    fields.water_level = parseFloat((sensorToRef - fields.raw_distance).toFixed(3));
    fields.is_blind_zone = fields.raw_distance <= blindZoneOffset;
  }

  // Insert reading
  try {
    const inserted = await insertReading(stationId, fields, rssi, snr, timestamp);
    console.log(
      `[ReadingService] [OK] Reading saved | station: ${stationId} | reading_id: ${inserted.reading_id} | raw: ${fields.raw_distance}m | level: ${fields.water_level}m | time: ${inserted.timestamp}`
    );

    // Update MCU status
    await updateMcuStatus(stationId, { rssi, battery_percent: fields.battery_percent });

    // Update gateway status
    await updateGatewayStatus(payload);

    // Check alert conditions and send LINE notification if thresholds met (non-blocking)
    alertService.checkReadingAlerts(stationId, fields, timestamp).catch((err) => {
      console.error('[ReadingService] Alert check error:', err.message);
    });

  } catch (err) {
    console.error('[ReadingService] Failed to insert reading:', err.message);
  }
}

/**
 * Get the latest reading for each station (for dashboard overview)
 */
async function getLatestReadingsPerStation() {
  const sql = `
    SELECT DISTINCT ON (r.station_id)
      r.reading_id,
      r.station_id,
      s.station_name,
      s.location_name,
      s.warning_level,
      s.critical_level,
      s.sensor_to_ref_distance,
      s.reference_point_name,
      r.timestamp,
      r.raw_distance,
      COALESCE(
        r.water_level,
        CASE WHEN r.raw_distance IS NOT NULL THEN ROUND((s.sensor_to_ref_distance - r.raw_distance)::numeric, 3) ELSE 0 END
      ) AS water_level,
      CASE
        WHEN s.critical_level IS NOT NULL AND (
          COALESCE(
            r.water_level,
            CASE WHEN r.raw_distance IS NOT NULL THEN ROUND((s.sensor_to_ref_distance - r.raw_distance)::numeric, 3) ELSE 0 END
          ) >= s.critical_level
        ) THEN 'critical'
        WHEN s.warning_level IS NOT NULL AND (
          COALESCE(
            r.water_level,
            CASE WHEN r.raw_distance IS NOT NULL THEN ROUND((s.sensor_to_ref_distance - r.raw_distance)::numeric, 3) ELSE 0 END
          ) >= s.warning_level
        ) THEN 'warning'
        ELSE 'normal'
      END AS water_status,
      r.is_blind_zone,
      r.temperature,
      r.humidity,
      r.battery_voltage,
      r.battery_percent,
      r.rssi,
      r.snr,
      r.tilt_x,
      r.tilt_y,
      r.latitude,
      r.longitude
    FROM readings r
    JOIN station s ON s.station_id = r.station_id
    WHERE s.status = 'active'
    ORDER BY r.station_id, r.timestamp DESC
  `;
  const res = await db.query(sql);
  return res.rows;
}

/**
 * Get recent readings for a specific station (paginated)
 */
async function getReadingsByStation(stationId, limit = 100, offset = 0) {
  const sql = `
    SELECT
      r.reading_id,
      r.station_id,
      s.station_name,
      s.sensor_to_ref_distance,
      s.reference_point_name,
      s.warning_level,
      s.critical_level,
      r.timestamp,
      r.raw_distance,
      COALESCE(
        r.water_level,
        CASE WHEN r.raw_distance IS NOT NULL THEN ROUND((s.sensor_to_ref_distance - r.raw_distance)::numeric, 3) ELSE 0 END
      ) AS water_level,
      CASE
        WHEN s.critical_level IS NOT NULL AND (
          COALESCE(
            r.water_level,
            CASE WHEN r.raw_distance IS NOT NULL THEN ROUND((s.sensor_to_ref_distance - r.raw_distance)::numeric, 3) ELSE 0 END
          ) >= s.critical_level
        ) THEN 'critical'
        WHEN s.warning_level IS NOT NULL AND (
          COALESCE(
            r.water_level,
            CASE WHEN r.raw_distance IS NOT NULL THEN ROUND((s.sensor_to_ref_distance - r.raw_distance)::numeric, 3) ELSE 0 END
          ) >= s.warning_level
        ) THEN 'warning'
        ELSE 'normal'
      END AS water_status,
      r.is_blind_zone,
      r.temperature,
      r.humidity,
      r.battery_voltage,
      r.battery_percent,
      r.rssi,
      r.snr,
      r.tilt_x,
      r.tilt_y,
      r.latitude,
      r.longitude
    FROM readings r
    JOIN station s ON s.station_id = r.station_id
    WHERE r.station_id = $1
    ORDER BY r.timestamp DESC
    LIMIT $2 OFFSET $3
  `;
  const res = await db.query(sql, [stationId, limit, offset]);
  return res.rows;
}

/**
 * Get readings in a time range for a specific station (for charts)
 */
async function getReadingsInRange(stationId, startTime, endTime) {
  const sql = `
    SELECT
      r.reading_id, r.station_id, r.timestamp,
      s.warning_level, s.critical_level,
      r.raw_distance,
      COALESCE(
        r.water_level,
        CASE WHEN r.raw_distance IS NOT NULL THEN ROUND((s.sensor_to_ref_distance - r.raw_distance)::numeric, 3) ELSE 0 END
      ) AS water_level,
      CASE
        WHEN s.critical_level IS NOT NULL AND (
          COALESCE(
            r.water_level,
            CASE WHEN r.raw_distance IS NOT NULL THEN ROUND((s.sensor_to_ref_distance - r.raw_distance)::numeric, 3) ELSE 0 END
          ) >= s.critical_level
        ) THEN 'critical'
        WHEN s.warning_level IS NOT NULL AND (
          COALESCE(
            r.water_level,
            CASE WHEN r.raw_distance IS NOT NULL THEN ROUND((s.sensor_to_ref_distance - r.raw_distance)::numeric, 3) ELSE 0 END
          ) >= s.warning_level
        ) THEN 'warning'
        ELSE 'normal'
      END AS water_status,
      r.is_blind_zone,
      r.temperature, r.humidity,
      r.battery_voltage, r.battery_percent,
      r.rssi, r.snr, r.tilt_x, r.tilt_y,
      r.latitude, r.longitude
    FROM readings r
    JOIN station s ON s.station_id = r.station_id
    WHERE r.station_id = $1
      AND r.timestamp BETWEEN $2 AND $3
    ORDER BY r.timestamp ASC
  `;
  const res = await db.query(sql, [stationId, startTime, endTime]);
  return res.rows;
}

/**
 * Recalculate historical water_level and is_blind_zone for all readings of a station
 * when calibration parameters (sensor_to_ref_distance, tilt compensation, blind zone) change.
 */
async function recalculateStationReadings(stationId, sensorToRef, _tiltEnabled = false, blindZoneOffset = 0.28) {
  const sql = `
    UPDATE readings
    SET
      water_level = ROUND(($1 - raw_distance)::numeric, 3),
      is_blind_zone = (raw_distance <= $2)
    WHERE station_id = $3 AND raw_distance IS NOT NULL
  `;
  const res = await db.query(sql, [Number(sensorToRef), Number(blindZoneOffset), stationId]);
  console.log(`[ReadingService] Recalculated ${res.rowCount} readings for station ${stationId} with D_ref=${sensorToRef}m`);
  return res.rowCount;
}

/**
 * Export readings to CSV format with all measured telemetry values and metadata
 * Supports timeRange: 'hourly' | 'daily' | 'weekly' for statistical aggregation
 * or raw export if timeRange is not specified.
 */
async function exportReadingsToCSV({ stationId, startTime, endTime, timeRange }) {
  const conditions = [];
  const values = [];
  let idx = 1;

  if (stationId) {
    conditions.push(`r.station_id = $${idx++}`);
    values.push(stationId);
  }

  // Set default start/end times if not provided when timeRange is given
  const now = new Date();
  let effectiveStart = startTime;
  let effectiveEnd = endTime;

  if (!effectiveStart && timeRange) {
    if (timeRange === 'hourly') {
      effectiveStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    } else if (timeRange === 'daily') {
      effectiveStart = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    } else if (timeRange === 'weekly') {
      effectiveStart = new Date(now.getTime() - 14 * 7 * 24 * 60 * 60 * 1000);
    }
  }

  if (effectiveStart) {
    const sDate = new Date(effectiveStart);
    if (!isNaN(sDate.getTime())) {
      conditions.push(`r.timestamp >= $${idx++}`);
      values.push(sDate);
    }
  }
  if (effectiveEnd) {
    const eDate = new Date(effectiveEnd);
    if (!isNaN(eDate.getTime())) {
      conditions.push(`r.timestamp <= $${idx++}`);
      values.push(eDate);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const escapeCSV = (val) => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const formatD = (d) => {
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  };

  const formatDT = (d) => {
    const dateStr = formatD(d);
    const hours = String(d.getHours()).padStart(2, '0');
    const mins = String(d.getMinutes()).padStart(2, '0');
    return `${dateStr} ${hours}:${mins}`;
  };

  // ── Case A: Aggregated export (hourly, daily, weekly) ─────────────────────
  if (timeRange === 'hourly' || timeRange === 'daily' || timeRange === 'weekly') {
    const truncUnit = timeRange === 'hourly' ? 'hour' : timeRange === 'daily' ? 'day' : 'week';
    const sql = `
      SELECT
        date_trunc('${truncUnit}', r.timestamp) AS time_bucket,
        r.station_id,
        s.station_name,
        s.location_name,
        s.reference_point_name,
        s.sensor_to_ref_distance,
        s.warning_level,
        s.critical_level,
        ROUND(AVG(COALESCE(
          r.water_level,
          CASE WHEN r.raw_distance IS NOT NULL THEN (s.sensor_to_ref_distance - r.raw_distance) ELSE 0 END
        ))::numeric, 2) AS avg_water_level,
        ROUND(MIN(COALESCE(
          r.water_level,
          CASE WHEN r.raw_distance IS NOT NULL THEN (s.sensor_to_ref_distance - r.raw_distance) ELSE 0 END
        ))::numeric, 2) AS min_water_level,
        ROUND(MAX(COALESCE(
          r.water_level,
          CASE WHEN r.raw_distance IS NOT NULL THEN (s.sensor_to_ref_distance - r.raw_distance) ELSE 0 END
        ))::numeric, 2) AS max_water_level,
        ROUND(AVG(r.raw_distance)::numeric, 2) AS avg_raw_distance,
        BOOL_OR(r.is_blind_zone) AS is_blind_zone,
        ROUND(AVG(r.temperature)::numeric, 1) AS avg_temperature,
        ROUND(AVG(r.humidity)::numeric, 1) AS avg_humidity,
        ROUND(AVG(r.battery_voltage)::numeric, 2) AS avg_battery_voltage,
        ROUND(AVG(r.battery_percent)::numeric, 0) AS avg_battery_percent,
        ROUND(AVG(r.rssi)::numeric, 0) AS avg_rssi,
        ROUND(AVG(r.snr)::numeric, 1) AS avg_snr,
        ROUND(AVG(r.tilt_x)::numeric, 2) AS avg_tilt_x,
        ROUND(AVG(r.tilt_y)::numeric, 2) AS avg_tilt_y,
        ROUND(AVG(r.latitude)::numeric, 6) AS latitude,
        ROUND(AVG(r.longitude)::numeric, 6) AS longitude,
        COUNT(*) AS sample_count
      FROM readings r
      JOIN station s ON s.station_id = r.station_id
      ${whereClause}
      GROUP BY
        date_trunc('${truncUnit}', r.timestamp),
        r.station_id,
        s.station_name,
        s.location_name,
        s.reference_point_name,
        s.sensor_to_ref_distance,
        s.warning_level,
        s.critical_level
      ORDER BY time_bucket ASC
    `;

    const res = await db.query(sql, values);
    const rows = res.rows;

    let timeHeader = 'วันที่และเวลา (ชั่วโมง)';
    let levelHeader = 'ระดับน้ำเฉลี่ย (ม.)';
    let countHeader = 'จำนวนครั้งที่ตรวจวัดในชั่วโมง';

    if (timeRange === 'daily') {
      timeHeader = 'วันที่';
      levelHeader = 'ระดับน้ำเฉลี่ยรายวัน (ม.)';
      countHeader = 'จำนวนครั้งที่ตรวจวัดในวัน';
    } else if (timeRange === 'weekly') {
      timeHeader = 'สัปดาห์และช่วงวันที่';
      levelHeader = 'ระดับน้ำเฉลี่ยรายสัปดาห์ (ม.)';
      countHeader = 'จำนวนครั้งที่ตรวจวัดในสัปดาห์';
    }

    const headers = [
      timeHeader,
      'รหัสสถานี',
      'ชื่อสถานี',
      'ตำแหน่ง/สถานที่',
      'จุดอ้างอิง',
      'ระยะเซนเซอร์ถึงจุดอ้างอิง (ม.)',
      levelHeader,
      'ระดับน้ำต่ำสุด (ม.)',
      'ระดับน้ำสูงสุด (ม.)',
      'ระยะห่างเซนเซอร์ถึงผิวน้ำเฉลี่ย (ม.)',
      'สถานะจุดบอดเซนเซอร์',
      'อุณหภูมิเฉลี่ย (°C)',
      'ความชื้นสัมพัทธ์เฉลี่ย (%)',
      'แรงดันแบตเตอรี่เฉลี่ย (V)',
      'ระดับแบตเตอรี่เฉลี่ย (%)',
      'ความแรงสัญญาณ LoRa RSSI เฉลี่ย (dBm)',
      'อัตราสัญญาณต่อสัญญาณรบกวน SNR เฉลี่ย (dB)',
      'มุมเอียงแกน X เฉลี่ย (องศา)',
      'มุมเอียงแกน Y เฉลี่ย (องศา)',
      'ละติจูด',
      'ลองจิจูด',
      countHeader,
      'สถานะระดับน้ำ'
    ];

    const csvRows = [headers.join(',')];

    for (const row of rows) {
      let timeValue = '';
      if (row.time_bucket) {
        const d = new Date(row.time_bucket);
        if (timeRange === 'hourly') {
          timeValue = `${formatD(d)} ${String(d.getHours()).padStart(2, '0')}:00`;
        } else if (timeRange === 'daily') {
          timeValue = formatD(d);
        } else {
          // weekly: start Monday to Sunday
          const endWeek = new Date(d);
          endWeek.setDate(d.getDate() + 6);
          timeValue = `${formatD(d)} - ${formatD(endWeek)}`;
        }
      }

      const avgLvl = row.avg_water_level != null ? Number(row.avg_water_level) : null;
      const minLvl = row.min_water_level != null ? Number(row.min_water_level) : null;
      const maxLvl = row.max_water_level != null ? Number(row.max_water_level) : null;

      let statusText = 'ปกติ';
      if (row.critical_level != null && avgLvl != null && avgLvl >= Number(row.critical_level)) {
        statusText = 'วิกฤต';
      } else if (row.warning_level != null && avgLvl != null && avgLvl >= Number(row.warning_level)) {
        statusText = 'เฝ้าระวัง';
      }

      const valuesArr = [
        timeValue,
        row.station_id || '',
        row.station_name || '',
        row.location_name || '',
        row.reference_point_name || 'จุดอ้างอิง',
        row.sensor_to_ref_distance != null ? Number(row.sensor_to_ref_distance).toFixed(2) : '-',
        avgLvl != null ? (avgLvl > 0 ? '+' : '') + avgLvl.toFixed(2) : '-',
        minLvl != null ? (minLvl > 0 ? '+' : '') + minLvl.toFixed(2) : '-',
        maxLvl != null ? (maxLvl > 0 ? '+' : '') + maxLvl.toFixed(2) : '-',
        row.avg_raw_distance != null ? Number(row.avg_raw_distance).toFixed(2) : '-',
        row.is_blind_zone ? 'อยู่ในระยะจุดบอด (Blind Zone)' : 'ปกติ',
        row.avg_temperature != null ? Number(row.avg_temperature).toFixed(1) : '-',
        row.avg_humidity != null ? Number(row.avg_humidity).toFixed(1) : '-',
        row.avg_battery_voltage != null ? Number(row.avg_battery_voltage).toFixed(2) : '-',
        row.avg_battery_percent != null ? Number(row.avg_battery_percent).toFixed(0) : '-',
        row.avg_rssi != null ? Number(row.avg_rssi).toFixed(0) : '-',
        row.avg_snr != null ? Number(row.avg_snr).toFixed(1) : '-',
        row.avg_tilt_x != null ? Number(row.avg_tilt_x).toFixed(2) : '-',
        row.avg_tilt_y != null ? Number(row.avg_tilt_y).toFixed(2) : '-',
        row.latitude != null ? Number(row.latitude).toFixed(6) : '-',
        row.longitude != null ? Number(row.longitude).toFixed(6) : '-',
        row.sample_count || 1,
        statusText,
      ];

      csvRows.push(valuesArr.map(escapeCSV).join(','));
    }

    return '\uFEFF' + csvRows.join('\r\n');
  }

  // ── Case B: Raw readings export ──────────────────────────────────────────
  const sql = `
    SELECT
      r.reading_id,
      r.station_id,
      s.station_name,
      s.location_name,
      s.reference_point_name,
      s.sensor_to_ref_distance,
      s.warning_level,
      s.critical_level,
      r.timestamp,
      r.raw_distance,
      COALESCE(
        r.water_level,
        CASE WHEN r.raw_distance IS NOT NULL THEN ROUND((s.sensor_to_ref_distance - r.raw_distance)::numeric, 3) ELSE 0 END
      ) AS water_level,
      r.is_blind_zone,
      r.temperature,
      r.humidity,
      r.battery_voltage,
      r.battery_percent,
      r.rssi,
      r.snr,
      r.tilt_x,
      r.tilt_y,
      r.latitude,
      r.longitude
    FROM readings r
    JOIN station s ON s.station_id = r.station_id
    ${whereClause}
    ORDER BY r.timestamp ASC
  `;

  const res = await db.query(sql, values);
  const rows = res.rows;

  const headers = [
    'วันที่และเวลาที่วัด',
    'รหัสสถานี',
    'ชื่อสถานี',
    'ตำแหน่ง/สถานที่',
    'จุดอ้างอิง',
    'ระยะเซนเซอร์ถึงจุดอ้างอิง (ม.)',
    'ระดับน้ำเทียบจุดอ้างอิง (ม.)',
    'ระยะห่างเซนเซอร์ถึงผิวน้ำ (ม.)',
    'สถานะจุดบอดเซนเซอร์',
    'อุณหภูมิ (°C)',
    'ความชื้นสัมพัทธ์ (%)',
    'แรงดันแบตเตอรี่ (V)',
    'ระดับแบตเตอรี่ (%)',
    'ความแรงสัญญาณ LoRa RSSI (dBm)',
    'อัตราสัญญาณต่อสัญญาณรบกวน SNR (dB)',
    'มุมเอียงแกน X (องศา)',
    'มุมเอียงแกน Y (องศา)',
    'ละติจูด',
    'ลองจิจูด',
    'สถานะระดับน้ำ'
  ];

  const csvRows = [headers.join(',')];

  for (const row of rows) {
    let formattedDate = '';
    if (row.timestamp) {
      const d = new Date(row.timestamp);
      if (!isNaN(d.getTime())) {
        const day = String(d.getDate()).padStart(2, '0');
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const year = d.getFullYear();
        const hours = String(d.getHours()).padStart(2, '0');
        const mins = String(d.getMinutes()).padStart(2, '0');
        const secs = String(d.getSeconds()).padStart(2, '0');
        formattedDate = `${day}/${month}/${year} ${hours}:${mins}:${secs}`;
      } else {
        formattedDate = String(row.timestamp);
      }
    }

    const waterLevelNum = row.water_level !== null && row.water_level !== undefined ? Number(row.water_level) : null;
    let waterLevelStr = '-';
    if (waterLevelNum !== null) {
      waterLevelStr = (waterLevelNum > 0 ? '+' : '') + waterLevelNum.toFixed(2);
    }

    let statusText = 'ปกติ';
    if (row.critical_level !== null && row.critical_level !== undefined && waterLevelNum !== null && waterLevelNum >= Number(row.critical_level)) {
      statusText = 'วิกฤต';
    } else if (row.warning_level !== null && row.warning_level !== undefined && waterLevelNum !== null && waterLevelNum >= Number(row.warning_level)) {
      statusText = 'เฝ้าระวัง';
    }

    const blindZoneText = row.is_blind_zone ? 'อยู่ในระยะจุดบอด (Blind Zone)' : 'ปกติ';

    const valuesArr = [
      formattedDate,
      row.station_id || '',
      row.station_name || '',
      row.location_name || '',
      row.reference_point_name || 'จุดอ้างอิง',
      row.sensor_to_ref_distance != null ? Number(row.sensor_to_ref_distance).toFixed(2) : '-',
      waterLevelStr,
      row.raw_distance != null ? Number(row.raw_distance).toFixed(2) : '-',
      blindZoneText,
      row.temperature != null ? Number(row.temperature).toFixed(1) : '-',
      row.humidity != null ? Number(row.humidity).toFixed(1) : '-',
      row.battery_voltage != null ? Number(row.battery_voltage).toFixed(2) : '-',
      row.battery_percent != null ? Number(row.battery_percent).toFixed(0) : '-',
      row.rssi != null ? Number(row.rssi).toFixed(0) : '-',
      row.snr != null ? Number(row.snr).toFixed(1) : '-',
      row.tilt_x != null ? Number(row.tilt_x).toFixed(2) : '-',
      row.tilt_y != null ? Number(row.tilt_y).toFixed(2) : '-',
      row.latitude != null ? Number(row.latitude).toFixed(6) : '-',
      row.longitude != null ? Number(row.longitude).toFixed(6) : '-',
      statusText,
    ];

    csvRows.push(valuesArr.map(escapeCSV).join(','));
  }

  // Prepend UTF-8 BOM (\uFEFF) for seamless Thai display in Excel
  return '\uFEFF' + csvRows.join('\r\n');
}


module.exports = {
  processUplinkMessage,
  getLatestReadingsPerStation,
  getReadingsByStation,
  getReadingsInRange,
  recalculateStationReadings,
  exportReadingsToCSV,
};

