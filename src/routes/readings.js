const express = require('express');
const router = express.Router();
const {
  processUplinkMessage,
  getLatestReadingsPerStation,
  getReadingsByStation,
  getReadingsInRange,
  exportReadingsToCSV,
} = require('../services/readingService');

// ── POST /api/readings/webhook or /api/readings/chirpstack ────────
// ChirpStack HTTP Integration endpoint (allows ChirpStack to push uplinks directly to Cloud Backend)
router.post(['/webhook', '/chirpstack'], async (req, res) => {
  try {
    const event = req.query.event || req.headers['x-chirpstack-event'] || 'up';
    if (event !== 'up') {
      return res.status(200).json({ success: true, message: `Ignored non-up event: ${event}` });
    }
    const topic = `application/webhook/device/webhook/event/${event}`;
    const payloadBuffer = Buffer.from(JSON.stringify(req.body));
    await processUplinkMessage(topic, payloadBuffer);
    res.status(200).json({ success: true, message: 'ChirpStack uplink processed successfully' });
  } catch (err) {
    console.error('[API POST /readings/webhook] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/readings ─────────────────────────────────────────────
// Returns latest reading for each active station (dashboard overview)
router.get('/', async (req, res) => {
  try {
    const readings = await getLatestReadingsPerStation();
    res.json({ success: true, data: readings, count: readings.length });
  } catch (err) {
    console.error('[API /readings] Error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch readings' });
  }
});

// ── GET /api/readings/history ─────────────────────────────────────
// Returns all readings from all stations (newest first) for admin view
// Query params: stationId, start (ISO), end (ISO), limit (default 50), offset (default 0)
router.get('/history', async (req, res) => {
  const { stationId, start, end } = req.query;
  const limit  = Math.min(parseInt(req.query.limit  ?? '50'), 500);
  const offset = parseInt(req.query.offset ?? '0');

  // Build dynamic WHERE clauses
  const conditions = [];
  const values = [];
  let idx = 1;

  if (stationId) {
    conditions.push(`r.station_id = $${idx++}`);
    values.push(stationId);
  }
  if (start) {
    const startTime = new Date(start);
    if (!isNaN(startTime)) {
      conditions.push(`r.timestamp >= $${idx++}`);
      values.push(startTime);
    }
  }
  if (end) {
    const endTime = new Date(end);
    if (!isNaN(endTime)) {
      conditions.push(`r.timestamp <= $${idx++}`);
      values.push(endTime);
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT
      r.reading_id,
      r.station_id,
      s.station_name,
      s.location_name,
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
      s.tilt_offset_x::float AS tilt_offset_x,
      s.tilt_offset_y::float AS tilt_offset_y,
      ROUND((COALESCE(r.tilt_x, 0) - COALESCE(s.tilt_offset_x, 0))::numeric, 1)::float AS rel_tilt_x,
      ROUND((COALESCE(r.tilt_y, 0) - COALESCE(s.tilt_offset_y, 0))::numeric, 1)::float AS rel_tilt_y,
      ROUND(SQRT(
        (COALESCE(r.tilt_x, 0) - COALESCE(s.tilt_offset_x, 0))^2 +
        (COALESCE(r.tilt_y, 0) - COALESCE(s.tilt_offset_y, 0))^2
      )::numeric, 1)::float AS relative_total_tilt,
      (SQRT(
        (COALESCE(r.tilt_x, 0) - COALESCE(s.tilt_offset_x, 0))^2 +
        (COALESCE(r.tilt_y, 0) - COALESCE(s.tilt_offset_y, 0))^2
      ) > 15) AS is_pole_tilted,
      r.latitude,
      r.longitude
    FROM readings r
    JOIN station s ON s.station_id = r.station_id
    ${whereClause}
    ORDER BY r.timestamp DESC
    LIMIT $${idx++} OFFSET $${idx++}
  `;
  values.push(limit, offset);

  // Count query for pagination
  const countSql = `
    SELECT COUNT(*) AS total
    FROM readings r
    JOIN station s ON s.station_id = r.station_id
    ${whereClause}
  `;

  try {
    const [dataRes, countRes] = await Promise.all([
      require('../config/database').query(sql, values),
      require('../config/database').query(countSql, values.slice(0, -2)),
    ]);
    const total = parseInt(countRes.rows[0].total);
    res.json({
      success: true,
      data: dataRes.rows,
      count: dataRes.rows.length,
      total,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[API /readings/history] Error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch reading history' });
  }
});

// ── GET /api/readings/export/csv ──────────────────────────────────
// Export readings to CSV format with all telemetry and sensor values
// Query params: stationId, start (ISO), end (ISO), timeRange ('hourly'|'daily'|'weekly')
router.get('/export/csv', async (req, res) => {
  const { stationId, start, end, timeRange, range } = req.query;
  const selectedRange = timeRange || range;

  try {
    const csvData = await exportReadingsToCSV({
      stationId,
      startTime: start,
      endTime: end,
      timeRange: selectedRange,
    });

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '') + '_' +
      String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
    const rangeSuffix = selectedRange ? `_${selectedRange}` : '';
    const filename = `readings_${stationId || 'all'}${rangeSuffix}_${dateStr}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvData);
  } catch (err) {
    console.error('[API /readings/export/csv] Error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to export readings to CSV' });
  }
});

// ── GET /api/readings/:stationId ──────────────────────────────────
// Returns recent readings for a specific station (paginated)
// Query params: limit (default 100), offset (default 0)
router.get('/:stationId', async (req, res) => {
  const { stationId } = req.params;
  const limit  = Math.min(parseInt(req.query.limit  ?? '100'), 1000);
  const offset = parseInt(req.query.offset ?? '0');

  try {
    const readings = await getReadingsByStation(stationId, limit, offset);
    res.json({ success: true, data: readings, count: readings.length });
  } catch (err) {
    console.error(`[API /readings/${stationId}] Error:`, err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch readings' });
  }
});

// ── GET /api/readings/:stationId/range ────────────────────────────
// Returns readings in a time range (for charts)
// Query params: start (ISO), end (ISO)
router.get('/:stationId/range', async (req, res) => {
  const { stationId } = req.params;
  const { start, end } = req.query;

  if (!start || !end) {
    return res.status(400).json({
      success: false,
      error: 'Query params "start" and "end" are required (ISO 8601 format)',
    });
  }

  const startTime = new Date(start);
  const endTime   = new Date(end);

  if (isNaN(startTime) || isNaN(endTime)) {
    return res.status(400).json({ success: false, error: 'Invalid date format' });
  }

  try {
    const readings = await getReadingsInRange(stationId, startTime, endTime);
    res.json({ success: true, data: readings, count: readings.length });
  } catch (err) {
    console.error(`[API /readings/${stationId}/range] Error:`, err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch readings' });
  }
});

module.exports = router;
