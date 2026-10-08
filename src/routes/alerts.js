const express = require('express');
const router = express.Router();
const alertService = require('../services/alertService');

// ── GET /api/alerts ───────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const stationId = req.query.stationId || null;
    const status = req.query.status || null;

    const alerts = await alertService.getAlerts({ limit, offset, stationId, status });
    res.json({ success: true, data: alerts, count: alerts.length });
  } catch (err) {
    console.error('[API /alerts] Error:', err.message);
    res.status(500).json({ success: false, error: 'ไม่สามารถดึงข้อมูลการแจ้งเตือนได้' });
  }
});

// ── PATCH /api/alerts/:alertId/acknowledge ────────────────────────
router.patch('/:alertId/acknowledge', async (req, res) => {
  try {
    const updated = await alertService.acknowledgeAlert(req.params.alertId);
    res.json({ success: true, data: updated, message: 'รับทราบการแจ้งเตือนแล้ว' });
  } catch (err) {
    console.error('[API /alerts/:alertId/acknowledge] Error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── POST /api/alerts/broadcast-summary ─────────────────────────────
router.post('/broadcast-summary', async (req, res) => {
  try {
    const { sendDailyWaterSummary } = require('../services/schedulerService');
    const period = req.body?.period || 'manual';
    const result = await sendDailyWaterSummary(period);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[API /alerts/broadcast-summary] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
