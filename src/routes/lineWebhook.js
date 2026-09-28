const express = require('express');
const router = express.Router();
const db = require('../config/database');
const {
  validateSignature,
  replyMessage,
  getUserProfile,
  createWelcomeFlexMessage,
  createStatusSummaryFlexMessage,
  getWebUrl,
  getLiffUrl,
} = require('../services/lineService');
const {
  saveOrUpdateSubscriber,
  deactivateSubscriber,
  getCitizenByLineId,
  registerCitizen,
} = require('../services/userService');

/**
 * Handle incoming LINE Webhook
 * POST /api/line/webhook
 */
router.post('/webhook', async (req, res) => {
  const signature = req.headers['x-line-signature'];

  // 1. Verify signature
  const rawBody = req.rawBody || JSON.stringify(req.body);
  if (!validateSignature(rawBody, signature)) {
    console.warn('[LINE Webhook] Invalid signature');
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // Acknowledge immediately to LINE platform (must respond 200 fast)
  res.status(200).send('OK');

  const events = req.body.events || [];
  for (const event of events) {
    try {
      await handleLineEvent(event);
    } catch (err) {
      console.error('[LINE Webhook] Event handler error:', err.message);
    }
  }
});

/**
 * Process a single LINE event
 */
async function handleLineEvent(event) {
  const userId = event.source?.userId;
  const replyToken = event.replyToken;

  console.log(`[LINE Webhook] Event received: type=${event.type}, userId=${userId}`);

  // ── 1. FOLLOW EVENT (User adds or unblocks bot) ───────────────────
  if (event.type === 'follow') {
    if (!userId) return;

    // Fetch user profile from LINE
    const profile = await getUserProfile(userId);
    const displayName = profile?.displayName || 'ผู้ใช้ LINE';

    // Auto-create or ensure citizen account exists in both users and line_subscribers
    let citizen = await getCitizenByLineId(userId);
    if (!citizen) {
      try {
        citizen = await registerCitizen({
          lineUserId: userId,
          name: displayName,
        });
        console.log(`[LINE Webhook] Auto-created citizen account for: ${displayName} (${userId})`);
      } catch (err) {
        console.warn('[LINE Webhook] Auto-register citizen warning:', err.message);
      }
    } else {
      await saveOrUpdateSubscriber({
        lineUserId: userId,
        displayName,
        pictureUrl: profile?.pictureUrl,
      });
    }

    const isRegistered = !!citizen;
    console.log(`[LINE Webhook] LINE follower: ${displayName} (${userId}) | registered=${isRegistered}`);

    // Send rich Welcome Flex Message (Bento Grid) with 1-Tap registration or Dashboard link
    const welcomeFlex = createWelcomeFlexMessage(displayName, userId, isRegistered);
    const replyRes = await replyMessage(replyToken, welcomeFlex);
    if (!replyRes.success) {
      console.warn('[LINE Webhook] Welcome Flex failed, sending text fallback:', replyRes.error);
      await replyMessage(replyToken, [
        `ยินดีต้อนรับคุณ ${displayName} สู่ระบบเตือนภัยระดับน้ำ FloodGuard\n\nระบบตรวจวัดและแจ้งเตือนสถานการณ์น้ำอัจฉริยะแบบเรียลไทม์`,
        `พิมพ์ "ระดับน้ำ" เพื่อตรวจเช็กสถานะทุกสถานีทันที\n\nเข้าสู่ระบบ Web Dashboard ได้ที่:\n${getLiffUrl('/dashboard')}`,
      ]);
    }
    return;
  }

  // ── 2. MESSAGE EVENT (Text messages) ──────────────────────────────
  if (event.type === 'message' && event.message?.type === 'text') {
    const text = event.message.text.trim();
    const webUrl = getWebUrl();

    // Auto-ensure subscriber is registered in line_subscribers
    if (userId) {
      saveOrUpdateSubscriber({ lineUserId: userId }).catch((err) => {
        console.warn('[LINE Webhook] saveOrUpdateSubscriber error:', err.message);
      });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    // Case A: User sent an email address to bind staff account
    if (emailRegex.test(text)) {
      const email = text.toLowerCase();
      const userRes = await db.query(
        `SELECT user_id, name, email, role, station_ids FROM users WHERE LOWER(email) = $1 LIMIT 1`,
        [email]
      );

      if (userRes.rows.length === 0) {
        await replyMessage(replyToken, [
          `ไม่พบบัญชีอีเมล "${email}" ในระบบเจ้าหน้าที่\n\nหากท่านเป็นประชาชนทั่วไป บัญชี LINE นี้ได้รับสิทธิ์รับการแจ้งเตือนระดับน้ำเรียบร้อยแล้วโดยไม่ต้องลงทะเบียนครับ`,
          `ท่านสามารถเลือกสถานีที่ต้องการติดตามได้ที่\n${getLiffUrl(`/subscribe?uid=${encodeURIComponent(userId || '')}`)}`,
        ]);
        return;
      }

      const foundUser = userRes.rows[0];

      // Bind line_user_id to this user
      await db.query(
        `UPDATE users SET line_user_id = $1, updated_at = NOW() WHERE user_id = $2`,
        [userId, foundUser.user_id]
      );

      console.log(`[LINE Webhook] Account linked: ${foundUser.email} -> LINE ${userId}`);

      await replyMessage(replyToken, [
        `เชื่อมต่อบัญชีเจ้าหน้าที่สำเร็จเรียบร้อยแล้ว\n\nชื่อผู้ใช้ ${foundUser.name}\nสิทธิ์การใช้งาน ${foundUser.role}\nอีเมล ${foundUser.email}\n\nระบบได้ผูกบัญชีของท่านกับ LINE เรียบร้อยแล้ว และจะส่งการแจ้งเตือนสถานีที่ท่านดูแลผ่านทางนี้ครับ`,
        `เข้าสู่ระบบจัดการและแดชบอร์ดได้ที่\n${getLiffUrl('/dashboard')}`,
      ]);
      return;
    }

    // Case B: Check current water levels
    const lowerText = text.toLowerCase();
    if (['ระดับน้ำ', 'สถานะ', 'ดูน้ำ', 'น้ำ', 'status', 'check'].some((kw) => lowerText.includes(kw))) {
      // Query active stations (ignore offline / inactive stations)
      const stationsRes = await db.query(`
        SELECT
          s.station_id,
          s.station_name,
          COALESCE(NULLIF(TRIM(s.reference_point_name), ''), 'จุดอ้างอิง') AS reference_point_name,
          s.warning_level,
          s.critical_level,
          COALESCE(
            CASE
              WHEN r.raw_distance IS NOT NULL THEN
                ROUND((s.sensor_to_ref_distance - r.raw_distance)::numeric, 3)
              ELSE r.water_level
            END,
            0
          ) AS water_level,
          r.raw_distance,
          r.timestamp
        FROM station s
        LEFT JOIN LATERAL (
          SELECT raw_distance, water_level, tilt_x, tilt_y, timestamp
          FROM readings
          WHERE station_id = s.station_id
          ORDER BY timestamp DESC
          LIMIT 1
        ) r ON true
        WHERE s.status = 'active'
        ORDER BY s.station_id ASC
      `);

      if (stationsRes.rows.length === 0) {
        await replyMessage(replyToken, [
          `ขณะนี้ไม่มีสถานีที่เปิดให้บริการตรวจวัดระดับน้ำ หรือสถานีอยู่ในระหว่างปิดปรับปรุงชั่วคราว`,
          `ตรวจสอบข้อมูลเพิ่มเติมได้ที่ ${getLiffUrl('/dashboard')}`,
        ]);
        return;
      }

      // Send rich Status Summary Flex Message
      const statusFlex = createStatusSummaryFlexMessage(stationsRes.rows);
      const replyRes = await replyMessage(replyToken, statusFlex);
      if (!replyRes.success) {
        console.warn('[LINE Webhook] Status Flex reply failed, falling back to text:', replyRes.error);
        const timeNow = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
        const summaries = stationsRes.rows.map((st) => {
          const w = st.water_level != null ? `${Number(st.water_level) >= 0 ? '+' : ''}${Number(st.water_level).toFixed(2)} ม.` : 'ไม่มีข้อมูล';
          const ref = st.reference_point_name || 'จุดอ้างอิง';
          return `[${st.station_name || st.station_id}]\nระดับน้ำ: ${w} (เทียบ${ref})\nเกณฑ์เฝ้าระวัง: ${st.warning_level != null ? Number(st.warning_level).toFixed(2) + ' ม.' : '-'}\nเกณฑ์วิกฤต: ${st.critical_level != null ? Number(st.critical_level).toFixed(2) + ' ม.' : '-'}`;
        }).join('\n\n');

        await replyMessage(replyToken, [
          `รายงานข้อมูลระดับน้ำล่าสุด (${timeNow} น.):\n\n${summaries}`,
          `เข้าสู่ระบบ Web Dashboard ได้ที่:\n${getLiffUrl('/dashboard')}`,
        ]);
      }
      return;
    }

    // Case C: Check LINE ID
    if (['id', 'my id', 'line id', 'ไอดี'].includes(lowerText)) {
      await replyMessage(replyToken, [
        `LINE User ID ของคุณคือ\n${userId}`,
        `คุณสามารถนำ ID นี้ไปใช้ตั้งค่าการรับแจ้งเตือนหรือกรอกในหน้าเว็บได้ที่\n${getLiffUrl(`/subscribe?uid=${encodeURIComponent(userId || '')}`)}`,
      ]);
      return;
    }

    // Default: Welcome & Menu instructions
    const citizen = await getCitizenByLineId(userId);
    const isRegistered = !!citizen;
    const welcomeFlex = createWelcomeFlexMessage(citizen?.name || 'ผู้ใช้งาน', userId, isRegistered);
    await replyMessage(replyToken, welcomeFlex);
    return;
  }

  // ── 3. UNFOLLOW EVENT (User blocked bot) ───────────────────────────
  if (event.type === 'unfollow') {
    console.log(`[LINE Webhook] User unfollowed/blocked: ${userId}`);
    if (userId) {
      await deactivateSubscriber(userId);
      try {
        await db.query(
          `UPDATE users SET line_user_id = NULL, updated_at = NOW() WHERE line_user_id = $1`,
          [userId]
        );
      } catch (err) {
        console.error('[LINE Webhook] Unfollow error:', err.message);
      }
    }
  }
}

module.exports = router;
