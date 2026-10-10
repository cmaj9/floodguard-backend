const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { getSettings, saveSettings, resetStationSettings } = require('../services/notificationSettingService');
const { saveOrUpdateSubscriber } = require('../services/userService');
const { getLineQuotaInfo } = require('../services/lineService');
const { authenticateToken, requireRole } = require('../middleware/auth');

// ── GET /api/notifications/line-quota ─────────────────────────────
// Get LINE Messaging API monthly quota and current usage status (Admin & Staff)
router.get('/line-quota', authenticateToken, requireRole(['admin', 'staff']), async (req, res) => {
  try {
    const quotaInfo = await getLineQuotaInfo();
    res.json({ success: true, data: quotaInfo });
  } catch (err) {
    console.error('[API /notifications/line-quota] Error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch LINE quota info' });
  }
});

// ── GET /api/notifications/settings ───────────────────────────────
// Get global notification settings
router.get('/settings', async (req, res) => {
  try {
    const settings = await getSettings(null);
    res.json({ success: true, data: settings });
  } catch (err) {
    console.error('[API /notifications/settings] Error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch global notification settings' });
  }
});

// ── PUT /api/notifications/settings ───────────────────────────────
// Update global notification settings (Admin only)
router.put('/settings', authenticateToken, requireRole(['admin']), async (req, res) => {
  try {
    const updated = await saveSettings(req.body, null);
    res.json({ success: true, data: updated, message: 'บันทึกการตั้งค่าการแจ้งเตือนส่วนกลางสำเร็จ' });
  } catch (err) {
    console.error('[API /notifications/settings] Error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to save global notification settings' });
  }
});

// ── GET /api/notifications/settings/:stationId ────────────────────
// Get notification settings for a specific station (falls back to global)
router.get('/settings/:stationId', async (req, res) => {
  const { stationId } = req.params;
  try {
    const settings = await getSettings(stationId);
    res.json({ success: true, data: settings });
  } catch (err) {
    console.error(`[API /notifications/settings/${stationId}] Error:`, err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch station notification settings' });
  }
});

// ── PUT /api/notifications/settings/:stationId ────────────────────
// Update notification settings for a specific station (Admin & Staff)
router.put('/settings/:stationId', authenticateToken, requireRole(['admin', 'staff']), async (req, res) => {
  const { stationId } = req.params;
  try {
    const updated = await saveSettings(req.body, stationId);
    res.json({ success: true, data: updated, message: `บันทึกการตั้งค่าแจ้งเตือนเฉพาะสถานี ${stationId} สำเร็จ` });
  } catch (err) {
    console.error(`[API /notifications/settings/${stationId}] Error:`, err.message);
    res.status(500).json({ success: false, error: 'Failed to save station notification settings' });
  }
});

// ── DELETE /api/notifications/settings/:stationId ─────────────────
// Reset station settings back to global defaults (Admin & Staff)
router.delete('/settings/:stationId', authenticateToken, requireRole(['admin', 'staff']), async (req, res) => {
  const { stationId } = req.params;
  try {
    const globalSettings = await resetStationSettings(stationId);
    res.json({ success: true, data: globalSettings, message: `รีเซ็ตการตั้งค่าสถานี ${stationId} เป็นค่าเริ่มต้นส่วนกลางแล้ว` });
  } catch (err) {
    console.error(`[API /notifications/settings/${stationId}] Reset error:`, err.message);
    res.status(500).json({ success: false, error: 'Failed to reset station notification settings' });
  }
});

// ── GET /api/notifications/subscribers/:lineUserId ────────────────
// Get subscriber's followed stations and preferences
router.get('/subscribers/:lineUserId', async (req, res) => {
  const { lineUserId } = req.params;
  try {
    const subRes = await db.query(
      `SELECT line_user_id, display_name, picture_url, station_ids, is_active, created_at
       FROM line_subscribers WHERE line_user_id = $1 LIMIT 1`,
      [lineUserId]
    );

    if (subRes.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          line_user_id: lineUserId,
          display_name: 'ผู้ใช้ LINE',
          station_ids: [],
          is_active: true,
          is_new: true,
        },
      });
    }

    res.json({ success: true, data: subRes.rows[0] });
  } catch (err) {
    console.error('[API /notifications/subscribers] Error:', err.message);
    res.status(500).json({ success: false, error: 'Failed to get subscriber preferences' });
  }
});

// ── POST /api/notifications/subscribers ───────────────────────────
// Save or update subscriber preferences from public subscribe page
router.post('/subscribers', async (req, res) => {
  const { line_user_id, display_name, station_ids, alert_types } = req.body;

  if (!line_user_id) {
    return res.status(400).json({ success: false, error: 'กรุณาระบุ LINE User ID' });
  }

  try {
    // 1. Update line_subscribers
    const targetStationIds = Array.isArray(station_ids) ? station_ids : [];
    const query = `
      INSERT INTO line_subscribers (line_user_id, display_name, station_ids, is_active, updated_at)
      VALUES ($1, $2, $3, true, NOW())
      ON CONFLICT (line_user_id) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, line_subscribers.display_name),
        station_ids = EXCLUDED.station_ids,
        is_active = true,
        updated_at = NOW()
      RETURNING *
    `;

    const result = await db.query(query, [line_user_id, display_name || 'ผู้ใช้ LINE', targetStationIds]);

    res.json({
      success: true,
      data: result.rows[0],
      message: 'บันทึกการตั้งค่ารับการแจ้งเตือนสำเร็จเรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('[API /notifications/subscribers] Save error:', err.message);
    res.status(500).json({ success: false, error: 'ไม่สามารถบันทึกการตั้งค่ารับการแจ้งเตือนได้' });
  }
});

module.exports = router;
