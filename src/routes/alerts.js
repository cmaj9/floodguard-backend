const express = require('express');
const router = express.Router();
const alertService = require('../services/alertService');
const { authenticateToken, requireRole } = require('../middleware/auth');

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
// Staff and Admin only
router.patch('/:alertId/acknowledge', authenticateToken, requireRole(['admin', 'staff']), async (req, res) => {
  try {
    const updated = await alertService.acknowledgeAlert(req.params.alertId);
    res.json({ success: true, data: updated, message: 'รับทราบการแจ้งเตือนแล้ว' });
  } catch (err) {
    console.error('[API /alerts/:alertId/acknowledge] Error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── POST /api/alerts/broadcast-summary ─────────────────────────────
// Staff and Admin only
router.post('/broadcast-summary', authenticateToken, requireRole(['admin', 'staff']), async (req, res) => {
  try {
    const { sendDailyWaterSummary } = require('../services/schedulerService');
    const period = req.body?.period || 'manual';
    const result = await sendDailyWaterSummary(period);
    if (!result.success) {
      return res.status(400).json({ success: false, data: result, error: result.error || result.reason || 'ไม่สามารถส่งสรุปสถานการณ์น้ำผ่าน LINE OA ได้' });
    }
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('[API /alerts/broadcast-summary] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/alerts/emergency-broadcast ───────────────────────────
// Staff and Admin only: Trigger immediate critical LINE OA alerts for critical stations
router.post('/emergency-broadcast', authenticateToken, requireRole(['admin', 'staff']), async (req, res) => {
  try {
    const stationIds = Array.isArray(req.body?.stationIds) ? req.body.stationIds : [];
    const result = await alertService.broadcastEmergencyAlerts(stationIds);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        data: result,
        error: result.lineError || result.error || 'ไม่สามารถส่งแจ้งเตือนฉุกเฉินผ่าน LINE OA ได้',
      });
    }
    res.json({
      success: true,
      data: result,
      message: `ส่งสัญญาณแจ้งเตือนภัยฉุกเฉินไปยัง LINE OA สำเร็จ (${result.totalRecipients} ผู้รับ)`,
    });
  } catch (err) {
    console.error('[API /alerts/emergency-broadcast] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
