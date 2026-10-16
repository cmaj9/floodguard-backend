const db = require('../config/database');
const {
  sendLineAlert,
  formatAlertMessage,
  createAlertFlexMessage,
  createGatewayOfflineFlexMessage,
} = require('./lineService');
const { getLineUserIdsForStation, getLineRecipientsForAlert } = require('./userService');
const { getSettings } = require('./notificationSettingService');

const ALERT_COOLDOWN_MINUTES = parseInt(process.env.ALERT_COOLDOWN_MINUTES || '30', 10); // 30 min cooldown

/**
 * Calculate distance in meters between two lat/lon coordinates using Haversine formula
 */
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return 0;
  const R = 6371e3; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Check if a similar active alert was already triggered recently (cooldown)
 * Supports severity escalation ('warning' -> 'critical' bypasses cooldown)
 */
async function isAlertOnCooldown(stationId, alertType, cooldownMinutes = ALERT_COOLDOWN_MINUTES, severity = null) {
  try {
    // For water_level alerts, handle Warning vs Critical distinction and Escalation
    if (alertType === 'water_level' && severity) {
      const res = await db.query(
        `SELECT alert_id, timestamp, threshold, message
         FROM alerts
         WHERE station_id = $1
           AND alert_type = 'water_level'
         ORDER BY timestamp DESC
         LIMIT 1`,
        [stationId]
      );

      if (res.rows.length > 0) {
        const lastAlert = res.rows[0];
        const lastIsCritical = lastAlert.message?.includes('วิกฤต') || false;

        // ESCALATION RULE: Transition from Warning to Critical ALWAYS bypasses cooldown!
        if (severity === 'critical' && !lastIsCritical) {
          console.log(`[AlertService] Escalation from Warning to Critical for ${stationId}: bypassing cooldown`);
          return false;
        }
      }

      // Check if the same severity level was triggered within cooldownMinutes
      const resCooldown = await db.query(
        `SELECT alert_id
         FROM alerts
         WHERE station_id = $1
           AND alert_type = 'water_level'
           AND timestamp >= NOW() - ($2 || ' minutes')::INTERVAL
           AND (
             ($3 = 'critical' AND message LIKE '%วิกฤต%')
             OR ($3 = 'warning' AND message LIKE '%เฝ้าระวัง%')
           )
         LIMIT 1`,
        [stationId, cooldownMinutes, severity]
      );
      return resCooldown.rows.length > 0;
    }

    // Default cooldown check for other alert types
    const res = await db.query(
      `SELECT alert_id, timestamp
       FROM alerts
       WHERE station_id = $1
         AND alert_type = $2
         AND timestamp >= NOW() - ($3 || ' minutes')::INTERVAL
       ORDER BY timestamp DESC
       LIMIT 1`,
      [stationId, alertType, cooldownMinutes]
    );
    return res.rows.length > 0;
  } catch (err) {
    console.error('[AlertService] Cooldown check error:', err.message);
    return false;
  }
}

/**
 * Save alert to database and dispatch LINE Flex notifications to subscribed users
 */
async function saveAndNotify({ stationId, stationName, alertType, severity = null, value, threshold, message, refName, station, cooldownMinutes, isManualOffline = false, bypassCooldown = false }) {
  try {
    const effectiveCooldown = cooldownMinutes || ALERT_COOLDOWN_MINUTES;
    // 1. Check cooldown to avoid flooding users (with severity escalation support)
    const onCooldown = bypassCooldown ? false : await isAlertOnCooldown(stationId, alertType, effectiveCooldown, severity);
    if (onCooldown) {
      console.log(`[AlertService] Alert ${alertType} (${severity || 'normal'}) for ${stationId} is on cooldown (< ${effectiveCooldown}m), skipping duplicate`);
      return null;
    }

    // Fetch station details if not already provided
    let stationInfo = station;
    if (!stationInfo) {
      try {
        const sRes = await db.query('SELECT * FROM station WHERE station_id = $1', [stationId]);
        if (sRes.rows.length > 0) stationInfo = sRes.rows[0];
      } catch (_) {}
    }

    // 2. Insert into alerts table
    const res = await db.query(
      `INSERT INTO alerts (station_id, timestamp, alert_type, value, threshold, message, status)
       VALUES ($1, NOW(), $2, $3, $4, $5, 'active')
       RETURNING alert_id, station_id, timestamp, alert_type, value, threshold, message, status`,
      [stationId, alertType, value ?? null, threshold ?? null, message]
    );

    const savedAlert = res.rows[0];
    console.log(`[AlertService] Alert created: ${savedAlert.alert_id} | ${alertType} (${severity || 'default'}) | Station: ${stationId} | ${message}`);

    // 3. Find LINE user IDs to notify based on role & alert type (citizens suppressed if isManualOffline)
    const lineUserIds = await getLineRecipientsForAlert(stationId, alertType, isManualOffline);
    if (lineUserIds.length > 0) {
      // Build rich LINE Flex Message Carousel (3 Cards)
      const flexMsg = createAlertFlexMessage({
        stationName: stationName || stationInfo?.station_name || stationId,
        stationId,
        alertType,
        severity,
        value,
        threshold,
        customMessage: message,
        refName: refName || stationInfo?.reference_point_name || 'จุดอ้างอิง',
        station: stationInfo,
      });

      const lineResult = await sendLineAlert(lineUserIds, flexMsg);
      if (!lineResult.success) {
        console.warn(`[AlertService] Alert ${savedAlert.alert_id} saved to DB, but LINE delivery failed: ${lineResult.error || lineResult.reason}`);
      }
      savedAlert.line_delivery = lineResult;
    } else {
      console.log(`[AlertService] No LINE subscribers found for station ${stationId} (manual_offline=${isManualOffline})`);
      savedAlert.line_delivery = { success: false, reason: 'No recipients' };
    }

    return savedAlert;
  } catch (err) {
    console.error('[AlertService] saveAndNotify error:', err.message);
    return null;
  }
}

/**
 * Check Condition 1: Water Level Safety Thresholds
 * - Warning Level: Triggers when water_level >= warning_level (without offset reduction)
 * - Critical Level: Triggers when water_level >= critical_level - safety_offset (early warning)
 * - Escalation: Escalation from Warning to Critical bypasses cooldown immediately
 */
async function checkWaterLevel(station, fields, settings, isManualOffline = false, bypassCooldown = false) {
  if (settings.water_level_enabled === false) return;
  if (fields.water_level == null) return;

  const current = fields.water_level;
  const refName = station.reference_point_name || 'จุดอ้างอิง';
  const offset = settings.safety_offset || 0.0;
  const cooldownMin = settings.water_level_cooldown_minutes || 30;
  const formatLevel = (val) => (val >= 0 ? `+${val.toFixed(2)}` : val.toFixed(2));

  // 1. Critical check (threshold adjusted by safety offset if set)
  if (station.critical_level != null) {
    const effectiveCritical = Number(station.critical_level) - offset;
    if (current >= effectiveCritical) {
      const relativeDesc = current >= 0
        ? `สูงกว่า${refName} ${Math.abs(current).toFixed(2)} ม.`
        : `ต่ำกว่า${refName} ${Math.abs(current).toFixed(2)} ม.`;

      const isEarlyWarning = offset > 0 && current < Number(station.critical_level);
      const headline = isEarlyWarning
        ? `ระดับน้ำใกล้แตะจุดวิกฤต (เผื่อความปลอดภัย ${offset.toFixed(2)} ม.)`
        : `ระดับน้ำแตะเกณฑ์วิกฤต`;

      const manualOfflineNotice = isManualOffline ? ' [โหมดทดสอบ: เฉพาะเจ้าหน้าที่]' : '';

      return await saveAndNotify({
        stationId: station.station_id,
        stationName: station.station_name,
        alertType: 'water_level',
        severity: 'critical',
        value: current,
        threshold: station.critical_level,
        refName,
        cooldownMinutes: cooldownMin,
        isManualOffline,
        bypassCooldown,
        message: `${headline} ${formatLevel(current)} ม. (${relativeDesc}) แตะเกณฑ์ ${formatLevel(station.critical_level)} ม.${manualOfflineNotice}`,
      });
    }
  }

  // In manual offline mode, warning alerts are suppressed (only critical triggers staff notification)
  if (isManualOffline) return null;

  // 2. Warning check (Safety Offset NOT applied to warning level, per user specification)
  if (station.warning_level != null) {
    const effectiveWarning = Number(station.warning_level);
    if (current >= effectiveWarning) {
      const relativeDesc = current >= 0
        ? `สูงกว่า${refName} ${Math.abs(current).toFixed(2)} ม.`
        : `ต่ำกว่า${refName} ${Math.abs(current).toFixed(2)} ม.`;

      return await saveAndNotify({
        stationId: station.station_id,
        stationName: station.station_name,
        alertType: 'water_level',
        severity: 'warning',
        value: current,
        threshold: station.warning_level,
        refName,
        cooldownMinutes: cooldownMin,
        isManualOffline: false,
        bypassCooldown,
        message: `ระดับน้ำแตะเกณฑ์เฝ้าระวัง ${formatLevel(current)} ม. (${relativeDesc}) แตะเกณฑ์ ${formatLevel(station.warning_level)} ม.`,
      });
    }
  }
  return null;
}

/**
 * Check Sensor Blind Zone Condition
 */
async function checkBlindZone(station, fields, settings = {}, isManualOffline = false, bypassCooldown = false) {
  if (fields.is_blind_zone && fields.raw_distance != null) {
    const limit = station.blind_zone_offset || 0.28;
    return await saveAndNotify({
      stationId: station.station_id,
      stationName: station.station_name,
      alertType: 'water_level',
      severity: 'blind_zone',
      value: fields.raw_distance,
      threshold: limit,
      refName: station.reference_point_name,
      cooldownMinutes: settings.water_level_cooldown_minutes || 30,
      isManualOffline,
      bypassCooldown,
      message: `ผิวน้ำเข้าใกล้หัวเซนเซอร์ในระยะบอด (${fields.raw_distance.toFixed(2)} ม. <= ${limit.toFixed(2)} ม.) เซนเซอร์อาจจมน้ำหรืออ่านค่าคลาดเคลื่อน`,
    });
  }
  return null;
}

/**
 * Check Condition 2: Rate of Rise (ระดับน้ำเพิ่มขึ้นในอัตราที่สูงกว่าปกติ)
 */
async function checkRateOfRise(station, fields, settings, currentTimestamp = new Date(), bypassCooldown = false) {
  if (settings.rate_of_rise_enabled === false) return null;
  if (fields.water_level == null) return null;

  const threshold = settings.rate_of_rise_threshold || 0.30;

  try {
    // Find previous reading in the last 15 to 120 minutes
    const res = await db.query(
      `SELECT water_level, timestamp
       FROM readings
       WHERE station_id = $1
         AND water_level IS NOT NULL
         AND timestamp < $2
         AND timestamp >= $2 - INTERVAL '2 hours'
       ORDER BY timestamp DESC
       LIMIT 1`,
      [station.station_id, currentTimestamp]
    );

    if (res.rows.length === 0) return null;

    const prev = res.rows[0];
    const hoursDiff = (new Date(currentTimestamp) - new Date(prev.timestamp)) / (1000 * 60 * 60);

    if (hoursDiff > 0.05) { // At least 3 minutes apart
      const ratePerHour = (fields.water_level - prev.water_level) / hoursDiff;
      if (ratePerHour >= threshold) {
        return await saveAndNotify({
          stationId: station.station_id,
          stationName: station.station_name,
          alertType: 'rate_of_rise',
          value: parseFloat(ratePerHour.toFixed(2)),
          threshold,
          refName: station.reference_point_name,
          cooldownMinutes: settings.rate_of_rise_cooldown_minutes || 30,
          isManualOffline: false,
          bypassCooldown,
          message: `อัตราการเพิ่มของระดับน้ำสูงผิดปกติ +${ratePerHour.toFixed(2)} ม./ชม. (เกณฑ์ ${threshold} ม./ชม.)`,
        });
      }
    }
  } catch (err) {
    console.error('[AlertService] checkRateOfRise error:', err.message);
  }
  return null;
}

/**
 * Check Condition 4: Battery Level Low (แบตเตอรี่ของอุปกรณ์ต่ำกว่าค่าที่กำหนด)
 */
async function checkBatteryLevel(station, fields, settings, isManualOffline = false, bypassCooldown = false) {
  if (settings.battery_low_enabled === false) return null;
  if (fields.battery_percent == null) return null;

  const threshold = settings.battery_low_threshold || 20.0;

  if (fields.battery_percent <= threshold) {
    return await saveAndNotify({
      stationId: station.station_id,
      stationName: station.station_name,
      alertType: 'battery',
      value: fields.battery_percent,
      threshold,
      refName: station.reference_point_name,
      cooldownMinutes: settings.battery_low_cooldown_minutes || 120,
      isManualOffline,
      bypassCooldown,
      message: `ระดับแบตเตอรี่สถานีต่ำ ${fields.battery_percent}% (เกณฑ์ <= ${threshold}%)`,
    });
  }
  return null;
}

/**
 * Check Condition 5: Geofence (อุปกรณ์เคลื่อนออกนอกขอบเขตพื้นที่ที่กำหนดไว้)
 */
async function checkGeofence(station, fields, settings, bypassCooldown = false) {
  if (settings.geofence_enabled === false) return null;
  if (fields.latitude == null || fields.longitude == null) return null;
  if (station.latitude == null || station.longitude == null) return null;

  const threshold = settings.geofence_radius_meters || 100.0;

  const distanceMeters = getDistanceInMeters(
    station.latitude,
    station.longitude,
    fields.latitude,
    fields.longitude
  );

  if (distanceMeters > threshold) {
    return await saveAndNotify({
      stationId: station.station_id,
      stationName: station.station_name,
      alertType: 'geofence',
      value: parseFloat(distanceMeters.toFixed(1)),
      threshold,
      refName: station.reference_point_name,
      cooldownMinutes: settings.geofence_cooldown_minutes || 60,
      bypassCooldown,
      message: `สถานีเคลื่อนที่ออกนอกตำแหน่งเดิม ${distanceMeters.toFixed(1)} ม. (เกณฑ์ ${threshold} ม.)`,
    });
  }
  return null;
}

/**
 * Check Condition: Online Recovery (สถานีกลับมาออนไลน์หรือกลับมาส่งข้อมูลอีกครั้งหลังขาดการติดต่อ)
 * ตรวจสอบว่าก่อนหน้านี้มี Alert สถานะ 'offline' ที่ยังค้างอยู่ (active)
 * หรือระยะเวลาห่างจากข้อมูลก่อนหน้าเกินเกณฑ์ timeout_minutes ที่กำหนดไว้หรือไม่
 */
async function checkOnlineRecovery(station, fields, settings, currentTimestamp) {
  try {
    if (settings.offline_timeout_enabled === false) return;

    const timeoutMinutes = settings.offline_timeout_minutes || 30;

    // 1. ตรวจสอบว่ามี Alert 'offline' ที่ยัง active ค้างอยู่หรือไม่
    const activeOfflineRes = await db.query(
      `SELECT alert_id, timestamp, value, threshold
       FROM alerts
       WHERE station_id = $1 AND alert_type = 'offline' AND status = 'active'
       ORDER BY timestamp DESC
       LIMIT 1`,
      [station.station_id]
    );

    // 2. ตรวจสอบระยะเวลาห่างจากข้อมูลการตรวจวัดก่อนหน้า (ชุดข้อมูลก่อนหน้าแถวที่เพิ่งได้รับ)
    const prevReadingRes = await db.query(
      `SELECT timestamp
       FROM readings
       WHERE station_id = $1
       ORDER BY timestamp DESC, reading_id DESC
       OFFSET 1
       LIMIT 1`,
      [station.station_id]
    );

    let gapMinutes = 0;
    if (prevReadingRes.rows.length > 0) {
      gapMinutes = Math.round((new Date(currentTimestamp) - new Date(prevReadingRes.rows[0].timestamp)) / (1000 * 60));
      if (gapMinutes < 0) gapMinutes = 0;
    }

    const hadActiveOfflineAlert = activeOfflineRes.rows.length > 0;
    const exceededTimeoutGap = gapMinutes >= timeoutMinutes;

    // หากเคยเกิด Alert offline ค้างอยู่ หรือเวลาที่ขาดหายไปเกิน timeoutMinutes
    if (hadActiveOfflineAlert || exceededTimeoutGap) {
      // คำนวณระยะเวลาที่ขาดหายไปเพื่อแสดงในข้อความแจ้งเตือน
      let downtimeMinutes = gapMinutes;
      if (hadActiveOfflineAlert && activeOfflineRes.rows[0].timestamp) {
        const alertDowntime = Math.round((new Date(currentTimestamp) - new Date(activeOfflineRes.rows[0].timestamp)) / (1000 * 60));
        if (alertDowntime > 0 && (!downtimeMinutes || alertDowntime > downtimeMinutes)) {
          downtimeMinutes = alertDowntime;
        }
      }

      let downtimeText = '';
      if (downtimeMinutes >= 60) {
        const hours = Math.floor(downtimeMinutes / 60);
        const mins = downtimeMinutes % 60;
        downtimeText = mins > 0 ? `${hours} ชั่วโมง ${mins} นาที` : `${hours} ชั่วโมง`;
      } else {
        downtimeText = `${Math.max(1, downtimeMinutes)} นาที`;
      }

      const recoveryMessage = `สถานีกลับมาเชื่อมต่อและส่งข้อมูลตามปกติ (หลังจากขาดการติดต่อไป ${downtimeText})`;

      // 1. อัปเดตแจ้งเตือน Offline เดิมให้เป็น 'resolved'
      if (hadActiveOfflineAlert) {
        await db.query(
          `UPDATE alerts
           SET status = 'resolved'
           WHERE station_id = $1 AND alert_type = 'offline' AND status = 'active'`,
          [station.station_id]
        );
        console.log(`[AlertService] Resolved active offline alerts for station ${station.station_id}`);
      }

      // 2. บันทึกแจ้งเตือนใหม่ชนิด 'online' สถานะ 'resolved' ลงตาราง alerts
      await db.query(
        `INSERT INTO alerts (station_id, timestamp, alert_type, value, threshold, message, status)
         VALUES ($1, NOW(), 'online', $2, NULL, $3, 'resolved')`,
        [station.station_id, fields.water_level ?? null, recoveryMessage]
      );
      console.log(`[AlertService] Online recovery recorded for station ${station.station_id} | Downtime: ${downtimeText}`);

      // 3. ส่งข้อความแจ้งเตือนทาง LINE OA ไปยังผู้ดูแลระบบและช่างเทคนิค (Zero-Emoji Policy)
      const lineUserIds = await getLineRecipientsForAlert(station.station_id, 'online');
      if (lineUserIds.length > 0) {
        const flexMsg = createAlertFlexMessage({
          stationName: station.station_name,
          stationId: station.station_id,
          alertType: 'online',
          value: fields.water_level,
          threshold: null,
          customMessage: recoveryMessage,
          refName: station.reference_point_name || 'จุดอ้างอิง',
          station: {
            ...station,
            battery_percent: fields.battery_percent,
            battery_voltage: fields.battery_voltage,
            temperature: fields.temperature,
            rssi: fields.rssi,
            tilt_x: fields.tilt_x,
          },
        });

        await sendLineAlert(lineUserIds, flexMsg);
      }
    }
  } catch (err) {
    console.error('[AlertService] checkOnlineRecovery error:', err.message);
  }
}

/**
 * Check all reading-driven alerts (Conditions 1, 2, 4, 5, and Online Recovery)
 * Skip entirely if station is not active (offline / maintenance)
 */
async function checkReadingAlerts(stationId, fields, timestamp = new Date()) {
  try {
    const stationRes = await db.query(
      `SELECT station_id, station_name, status, reference_point_name, blind_zone_offset, warning_level, critical_level, latitude, longitude, manual_offline_at
       FROM station
       WHERE station_id = $1 LIMIT 1`,
      [stationId]
    );

    if (stationRes.rows.length === 0) return;
    const station = stationRes.rows[0];

    // If station is maintenance or decommissioned offline (without manual_offline_at), skip all alerts
    if (station.status === 'maintenance' || (station.status === 'offline' && !station.manual_offline_at)) {
      console.log(`[AlertService] Station ${stationId} is status '${station.status}', skipping all alerts`);
      return;
    }

    const isManualOffline = Boolean(station.status === 'offline' && station.manual_offline_at);

    // Retrieve active notification thresholds (custom station settings or global)
    const settings = await getSettings(stationId);

    // 0. Check Online Recovery ONLY if station is active (not during manual offline mode)
    if (!isManualOffline && station.status === 'active') {
      await checkOnlineRecovery(station, fields, settings, timestamp);
    }

    // Run checks concurrently
    await Promise.allSettled([
      checkWaterLevel(station, fields, settings, isManualOffline),
      checkBlindZone(station, fields, settings, isManualOffline),
      !isManualOffline ? checkRateOfRise(station, fields, settings, timestamp) : Promise.resolve(),
      checkBatteryLevel(station, fields, settings, isManualOffline),
      !isManualOffline ? checkGeofence(station, fields, settings) : Promise.resolve(),
    ]);
  } catch (err) {
    console.error('[AlertService] checkReadingAlerts error:', err.message);
  }
}

/**
 * Check Gateway Heartbeats
 * If gateway hasn't received any packets for > 15 minutes, mark as offline
 * and notify admin/staff users.
 */
async function checkGatewayHeartbeats() {
  try {
    const GATEWAY_TIMEOUT_MINUTES = 15;
    const res = await db.query(
      `SELECT gateway_id, gateway_name, status, last_update
       FROM gateway`
    );

    for (const gw of res.rows) {
      if (!gw.last_update) continue;
      const minutesSinceUpdate = Math.round((Date.now() - new Date(gw.last_update).getTime()) / (1000 * 60));

      if (minutesSinceUpdate >= GATEWAY_TIMEOUT_MINUTES) {
        if (gw.status !== 'offline') {
          // Update DB
          await db.query(`UPDATE gateway SET status = 'offline' WHERE gateway_id = $1`, [gw.gateway_id]);
          console.warn(`[AlertService] Gateway ${gw.gateway_name || gw.gateway_id} marked OFFLINE (inactive for ${minutesSinceUpdate}m)`);

          // Find affected stations
          const affRes = await db.query(
            `SELECT station_id, station_name FROM station WHERE gateway_id = $1`,
            [gw.gateway_id]
          );
          const affectedStations = affRes.rows.map(s => `${s.station_name} (${s.station_id})`).join(', ') || 'ไม่มี';

          // Notify admins/staff via LINE OA
          const lineUserIds = await getLineRecipientsForAlert(null, 'offline');
          if (lineUserIds && lineUserIds.length > 0) {
            const flexMsg = createGatewayOfflineFlexMessage({
              gatewayName: gw.gateway_name,
              gatewayId: gw.gateway_id,
              minutesSinceUpdate,
              affectedStations,
            });
            await sendLineAlert(lineUserIds, flexMsg).catch(err => console.error('[AlertService] Failed to send GW alert:', err.message));
          }
        }
      }
    }
  } catch (err) {
    console.error('[AlertService] checkGatewayHeartbeats error:', err.message);
  }
}

/**
 * Check Condition 3: Offline Stations (ไม่มีการส่งข้อมูลเข้าเว็บแอปพลิเคชันภายในระยะเวลาที่กำหนด)
 * Called every 1 minute from server.js
 * Automatically ignores stations deliberately marked as 'offline' or 'maintenance'
 */
async function checkOfflineStations() {
  try {
    // 1. Check Gateway heartbeats first
    await checkGatewayHeartbeats();

    const globalSettings = await getSettings(null);
    if (globalSettings.offline_timeout_enabled === false) {
      return;
    }

    const defaultTimeout = globalSettings.offline_timeout_minutes || 30;

    // Only inspect stations that are supposed to be active
    const res = await db.query(
      `SELECT s.station_id, s.station_name, s.reference_point_name, s.status_updated_at, MAX(r.timestamp) as last_seen
       FROM station s
       LEFT JOIN readings r ON r.station_id = s.station_id
       WHERE s.status = 'active'
       GROUP BY s.station_id, s.station_name, s.reference_point_name, s.status_updated_at`
    );

    for (const station of res.rows) {
      const stationSettings = await getSettings(station.station_id);
      if (stationSettings.offline_timeout_enabled === false) continue;

      const timeoutMinutes = stationSettings.offline_timeout_minutes || defaultTimeout;
      const lastSeenTime = station.last_seen ? new Date(station.last_seen).getTime() : 0;
      const statusUpdatedTime = station.status_updated_at ? new Date(station.status_updated_at).getTime() : 0;
      const lastActiveTime = Math.max(lastSeenTime, statusUpdatedTime);

      const minutesOffline = lastActiveTime > 0
        ? Math.round((Date.now() - lastActiveTime) / (1000 * 60))
        : timeoutMinutes + 1;

      if (minutesOffline >= timeoutMinutes) {
        await saveAndNotify({
          stationId: station.station_id,
          stationName: station.station_name,
          alertType: 'offline',
          value: minutesOffline,
          threshold: timeoutMinutes,
          refName: station.reference_point_name,
          cooldownMinutes: stationSettings.offline_cooldown_minutes || globalSettings.offline_cooldown_minutes || 60,
          message: `สถานีขาดการส่งข้อมูลเข้าสู่ระบบเป็นเวลา ${minutesOffline} นาที (เกณฑ์ ${timeoutMinutes} นาที)`,
        });
      }
    }
  } catch (err) {
    console.error('[AlertService] checkOfflineStations error:', err.message);
  }
}

/**
 * Get all alerts with station details
 */
async function getAlerts({ limit = 50, offset = 0, stationId = null, status = null } = {}) {
  let queryText = `
    SELECT
      a.alert_id,
      a.station_id,
      s.station_name,
      s.location_name,
      a.timestamp,
      a.alert_type,
      a.value,
      a.threshold,
      a.message,
      a.status
    FROM alerts a
    LEFT JOIN station s ON s.station_id = a.station_id
    WHERE 1=1
  `;
  const params = [];

  if (stationId) {
    params.push(stationId);
    queryText += ` AND a.station_id = $${params.length}`;
  }

  if (status) {
    params.push(status);
    queryText += ` AND a.status = $${params.length}`;
  }

  queryText += ` ORDER BY a.timestamp DESC`;

  params.push(limit);
  queryText += ` LIMIT $${params.length}`;

  params.push(offset);
  queryText += ` OFFSET $${params.length}`;

  const res = await db.query(queryText, params);
  return res.rows;
}

/**
 * Acknowledge an alert
 */
async function acknowledgeAlert(alertId) {
  const res = await db.query(
    `UPDATE alerts
     SET status = 'acknowledged'
     WHERE alert_id = $1
     RETURNING alert_id, station_id, alert_type, status, message`,
    [alertId]
  );

  if (res.rows.length === 0) {
    throw new Error('ไม่พบการแจ้งเตือนนี้');
  }
  return res.rows[0];
}

/**
 * Evaluates a station's latest telemetry immediately against its newly saved notification settings.
 * If conditions match (e.g. water level >= critical - safety_offset, battery low, rate of rise, etc.),
 * an alert is dispatched immediately to LINE OA and stored in database.
 * Returns array of alerts created.
 */
async function evaluateStationAlertsNow(stationId, { bypassCooldown = false } = {}) {
  try {
    const stationRes = await db.query(
      `SELECT station_id, station_name, status, reference_point_name, sensor_to_ref_distance, blind_zone_offset, warning_level, critical_level, latitude, longitude
       FROM station
       WHERE station_id = $1 LIMIT 1`,
      [stationId]
    );
    if (stationRes.rows.length === 0) return [];
    const station = stationRes.rows[0];

    if (station.status !== 'active') {
      console.log(`[AlertService] Station ${stationId} is status '${station.status}', skipping immediate alert evaluation`);
      return [];
    }

    const readingRes = await db.query(
      `SELECT * FROM readings WHERE station_id = $1 ORDER BY timestamp DESC LIMIT 1`,
      [stationId]
    );
    if (readingRes.rows.length === 0) return [];
    const fields = { ...readingRes.rows[0] };

    // Always recalculate water_level from sensor_to_ref_distance - raw_distance if raw_distance is present
    if (fields.raw_distance != null && station.sensor_to_ref_distance != null) {
      fields.water_level = Number(
        (Number(station.sensor_to_ref_distance) - Number(fields.raw_distance)).toFixed(4)
      );
    }

    const settings = await getSettings(stationId);

    // Check all rules concurrently
    const settledResults = await Promise.allSettled([
      checkWaterLevel(station, fields, settings, false, bypassCooldown),
      checkBlindZone(station, fields, settings, false, bypassCooldown),
      checkRateOfRise(station, fields, settings, new Date(fields.timestamp || Date.now()), bypassCooldown),
      checkBatteryLevel(station, fields, settings, false, bypassCooldown),
      checkGeofence(station, fields, settings, bypassCooldown),
    ]);

    const createdAlerts = settledResults
      .filter((r) => r.status === 'fulfilled' && r.value)
      .map((r) => r.value);

    // Also check offline timeout if enabled
    if (settings.offline_timeout_enabled !== false) {
      const timeoutMinutes = settings.offline_timeout_minutes || 30;
      const minutesOffline = fields.timestamp
        ? Math.round((Date.now() - new Date(fields.timestamp).getTime()) / (1000 * 60))
        : timeoutMinutes + 1;

      if (minutesOffline >= timeoutMinutes) {
        const offlineAlert = await saveAndNotify({
          stationId: station.station_id,
          stationName: station.station_name,
          alertType: 'offline',
          value: minutesOffline,
          threshold: timeoutMinutes,
          refName: station.reference_point_name,
          cooldownMinutes: settings.offline_cooldown_minutes || 60,
          bypassCooldown,
          message: `สถานีขาดการส่งข้อมูลเข้าสู่ระบบเป็นเวลา ${minutesOffline} นาที (เกณฑ์ ${timeoutMinutes} นาที)`,
        });
        if (offlineAlert) createdAlerts.push(offlineAlert);
      }
    }

    return createdAlerts;
  } catch (err) {
    console.error(`[AlertService] evaluateStationAlertsNow error for ${stationId}:`, err.message);
    return [];
  }
}

/**
 * Broadcast immediate emergency alerts via LINE OA for specified stations (or all critical/warning stations)
 * Bypasses cooldown so manual emergency broadcasts from Dashboard always dispatch immediately.
 */
async function broadcastEmergencyAlerts(stationIds = []) {
  try {
    let targetIds = Array.isArray(stationIds)
      ? stationIds.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : [];

    if (targetIds.length === 0) {
      const critRes = await db.query(
        `SELECT station_id FROM station WHERE status = 'active' ORDER BY station_id ASC`
      );
      targetIds = critRes.rows.map((r) => r.station_id);
    }

    const alertsCreated = [];
    let totalRecipients = 0;
    let lineError = null;

    for (const stId of targetIds) {
      const stationRes = await db.query(
        `SELECT station_id, station_name, status, reference_point_name, sensor_to_ref_distance, warning_level, critical_level, latitude, longitude
         FROM station WHERE station_id = $1 LIMIT 1`,
        [stId]
      );
      if (stationRes.rows.length === 0) continue;
      const station = stationRes.rows[0];

      const readingRes = await db.query(
        `SELECT * FROM readings WHERE station_id = $1 ORDER BY timestamp DESC LIMIT 1`,
        [stId]
      );
      const fields = readingRes.rows[0] ? { ...readingRes.rows[0] } : {};
      if (fields.raw_distance != null && station.sensor_to_ref_distance != null) {
        fields.water_level = Number(
          (Number(station.sensor_to_ref_distance) - Number(fields.raw_distance)).toFixed(4)
        );
      }

      const currentLevel = Number(fields.water_level ?? 0);
      const refName = station.reference_point_name || 'จุดอ้างอิง';
      const formatLevel = (val) => `${Number(val) >= 0 ? '+' : ''}${Number(val).toFixed(2)}`;
      const relativeDesc =
        currentLevel >= 0
          ? `สูงกว่า${refName} ${Math.abs(currentLevel).toFixed(2)} ม.`
          : `ต่ำกว่า${refName} ${Math.abs(currentLevel).toFixed(2)} ม.`;

      const saved = await saveAndNotify({
        stationId: station.station_id,
        stationName: station.station_name,
        alertType: 'water_level',
        severity: 'critical',
        value: currentLevel,
        threshold: station.critical_level ?? station.warning_level ?? currentLevel,
        refName,
        cooldownMinutes: 0,
        bypassCooldown: true,
        message: `[แจ้งเตือนฉุกเฉินด่วน] ระดับน้ำ ${formatLevel(currentLevel)} ม. (${relativeDesc}) โปรดเฝ้าระวังและเตรียมพร้อมรับมือสถานการณ์น้ำ`,
      });

      if (saved) {
        alertsCreated.push(saved);
        if (saved.line_delivery?.success) {
          totalRecipients += Number(saved.line_delivery.count || saved.line_delivery.recipients || 0);
        } else if (saved.line_delivery?.error || saved.line_delivery?.reason) {
          lineError = saved.line_delivery.error || saved.line_delivery.reason;
        }
      }
    }

    return {
      success: alertsCreated.length > 0 && (!lineError || totalRecipients > 0),
      alertsCreated,
      totalRecipients,
      lineError,
    };
  } catch (err) {
    console.error('[AlertService] broadcastEmergencyAlerts error:', err.message);
    return { success: false, error: err.message, alertsCreated: [], totalRecipients: 0 };
  }
}

module.exports = {
  checkReadingAlerts,
  checkOfflineStations,
  getAlerts,
  acknowledgeAlert,
  saveAndNotify,
  checkWaterLevel,
  evaluateStationAlertsNow,
  broadcastEmergencyAlerts,
};
