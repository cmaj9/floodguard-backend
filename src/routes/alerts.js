const express = require('express');
const router = express.Router();
const alertService = require('../services/alertService');
const {
  authenticateToken,
  optionalAuthenticate,
  requireRole,
  getEffectiveUserStationIds,
} = require('../middleware/auth');

// ── GET /api/alerts ───────────────────────────────────────────────
// Staff is restricted to assigned stations only
router.get('/', optionalAuthenticate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '50', 10);
    const offset = parseInt(req.query.offset || '0', 10);
    const stationId = req.query.stationId || null;
    const status = req.query.status || null;

    let stationIds = null;
    if (req.user && req.user.role === 'staff') {
      const staffStationIds = await getEffectiveUserStationIds(req.user.id);
      if (!staffStationIds || staffStationIds.length === 0) {
        return res.json({ success: true, data: [], count: 0 });
      }
      if (stationId) {
        if (!staffStationIds.includes(stationId)) {
          return res.status(403).json({
            success: false,
            error: `คุณไม่มีสิทธิ์เข้าถึงการแจ้งเตือนของสถานี ${stationId}`,
          });
        }
      } else {
        stationIds = staffStationIds;
      }
    }

    const alerts = await alertService.getAlerts({ limit, offset, stationId, status, stationIds });
    res.json({ success: true, data: alerts, count: alerts.length });
  } catch (err) {
    console.error('[API /alerts] Error:', err.message);
    res.status(500).json({ success: false, error: 'ไม่สามารถดึงข้อมูลการแจ้งเตือนได้' });
  }
});

// ── PATCH /api/alerts/:alertId/acknowledge ────────────────────────
// Staff and Admin only (Staff restricted to assigned stations)
router.patch('/:alertId/acknowledge', authenticateToken, requireRole(['admin', 'staff']), async (req, res) => {
  try {
    let allowedStationIds = null;
    if (req.user.role === 'staff') {
      allowedStationIds = await getEffectiveUserStationIds(req.user.id);
      if (!allowedStationIds || allowedStationIds.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'คุณไม่มีสิทธิ์จัดการการแจ้งเตือนของสถานีนี้ (ยังไม่มีสถานีที่ได้รับมอบหมาย)',
        });
      }
    }
    const updated = await alertService.acknowledgeAlert(req.params.alertId, allowedStationIds);
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
    let stationIds = Array.isArray(req.body?.stationIds) ? req.body.stationIds : [];

    // If staff triggers broadcast, filter out any stations not in their assigned scope
    if (req.user.role === 'staff') {
      const staffStationIds = await getEffectiveUserStationIds(req.user.id);
      if (!staffStationIds || staffStationIds.length === 0) {
        return res.status(403).json({
          success: false,
          error: 'คุณยังไม่มีสถานีตรวจวัดที่รับผิดชอบสำหรับการส่งสัญญาณแจ้งเตือนฉุกเฉิน',
        });
      }
      stationIds = stationIds.length > 0
        ? stationIds.filter((id) => staffStationIds.includes(id))
        : staffStationIds;
    }
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
