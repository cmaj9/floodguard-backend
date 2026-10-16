const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../config/database');
const { getSettings, saveSettings, resetStationSettings } = require('../services/notificationSettingService');
const { saveOrUpdateSubscriber } = require('../services/userService');
const { getLineQuotaInfo } = require('../services/lineService');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { evaluateStationAlertsNow } = require('../services/alertService');

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
    let triggeredAlerts = [];
    try {
      // Evaluate all active stations
      const activeStationsRes = await db.query(`SELECT station_id FROM station WHERE status = 'active'`);
      for (const st of activeStationsRes.rows) {
        const alerts = await evaluateStationAlertsNow(st.station_id, { bypassCooldown: true });
        if (alerts && alerts.length > 0) triggeredAlerts.push(...alerts);
      }
    } catch (evalErr) {
      console.error('[NotificationSettings] Immediate global alert eval error:', evalErr.message);
    }

    const message = triggeredAlerts.length > 0
      ? `บันทึกการตั้งค่าส่วนกลางสำเร็จ และพบเงื่อนไขตรงตามเกณฑ์ใหม่ (${triggeredAlerts.length} รายการ) จึงส่งการแจ้งเตือนทันที`
      : 'บันทึกการตั้งค่าการแจ้งเตือนส่วนกลางสำเร็จ';

    res.json({ success: true, data: updated, triggeredAlerts, message });
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
    let triggeredAlerts = [];
    try {
      triggeredAlerts = await evaluateStationAlertsNow(stationId, { bypassCooldown: true });
      if (triggeredAlerts && triggeredAlerts.length > 0) {
        console.log(`[NotificationSettings] Triggered ${triggeredAlerts.length} immediate alert(s) for station ${stationId} upon settings update`);
      }
    } catch (evalErr) {
      console.error(`[NotificationSettings] Immediate alert eval error for ${stationId}:`, evalErr.message);
    }

    const message = triggeredAlerts.length > 0
      ? `บันทึกการตั้งค่าสำเร็จ และพบเงื่อนไขตรงตามเกณฑ์ใหม่ (${triggeredAlerts.length} รายการ) จึงส่งการแจ้งเตือนทันที`
      : `บันทึกการตั้งค่าแจ้งเตือนเฉพาะสถานี ${stationId} สำเร็จ`;

    res.json({ success: true, data: updated, triggeredAlerts, message });
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
      `SELECT line_user_id, name AS display_name, picture_url, station_ids, is_active, created_at
       FROM users WHERE line_user_id = $1 LIMIT 1`,
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
  const { line_user_id, display_name, station_ids } = req.body;

  if (!line_user_id) {
    return res.status(400).json({ success: false, error: 'กรุณาระบุ LINE User ID' });
  }

  try {
    const targetStationIds = Array.isArray(station_ids) ? station_ids : [];

    // Check if user exists
    const existing = await db.query(
      `SELECT user_id, name FROM users WHERE line_user_id = $1 LIMIT 1`,
      [line_user_id]
    );

    let resultRow;
    if (existing.rows.length > 0) {
      const updateRes = await db.query(
        `UPDATE users
         SET station_ids = $1,
             name = COALESCE(NULLIF($2, ''), name),
             is_active = true,
             updated_at = NOW()
         WHERE line_user_id = $3
         RETURNING line_user_id, name AS display_name, picture_url, station_ids, is_active, updated_at`,
        [targetStationIds, display_name || null, line_user_id]
      );
      resultRow = updateRes.rows[0];
    } else {
      const cleanId = line_user_id.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toLowerCase();
      const syntheticEmail = `line_${cleanId}@floodguard.local`;
      const defaultHash = await bcrypt.hash('citizen1234', 10);

      const insertRes = await db.query(
        `INSERT INTO users (
          name, email, password_hash, phone, role, district, line_user_id, station_ids, is_active, is_credentials_set, created_at, updated_at
        ) VALUES (
          $1, $2, $3, '', 'citizen', '', $4, $5, true, false, NOW(), NOW()
        )
        ON CONFLICT (email) DO UPDATE SET
          line_user_id = EXCLUDED.line_user_id,
          name = COALESCE(NULLIF(EXCLUDED.name, ''), users.name),
          station_ids = EXCLUDED.station_ids,
          is_active = true,
          updated_at = NOW()
        RETURNING line_user_id, name AS display_name, picture_url, station_ids, is_active, updated_at`,
        [display_name || 'ผู้ใช้ LINE', syntheticEmail, defaultHash, line_user_id, targetStationIds]
      );
      resultRow = insertRes.rows[0];
    }

    res.json({
      success: true,
      data: resultRow,
      message: 'บันทึกการตั้งค่ารับการแจ้งเตือนสำเร็จเรียบร้อยแล้ว',
    });
  } catch (err) {
    console.error('[API /notifications/subscribers] Save error:', err.message);
    res.status(500).json({ success: false, error: 'ไม่สามารถบันทึกการตั้งค่ารับการแจ้งเตือนได้' });
  }
});

module.exports = router;
