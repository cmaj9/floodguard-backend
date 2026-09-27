/**
 * LINE Messaging API Service
 * Handles sending alert notifications, replying messages, and profile lookups via LINE OA
 * Features rich, premium LINE Flex Messages with direct web app deep-linking
 */
const crypto = require('crypto');

const LINE_API_MULTICAST = 'https://api.line.me/v2/bot/message/multicast';
const LINE_API_REPLY = 'https://api.line.me/v2/bot/message/reply';
const LINE_API_PROFILE = 'https://api.line.me/v2/bot/profile';

function getWebUrl() {
  return (process.env.FRONTEND_URL || 'https://waterwatch-frontend-mu.vercel.app').replace(/\/+$/, '');
}

function getLiffUrl(path = '') {
  const liffId = (process.env.LINE_LIFF_ID || '').trim();
  if (liffId) {
    return `https://liff.line.me/${liffId}${path}`;
  }
  return `${getWebUrl()}${path}`;
}

/**
 * Validate LINE Webhook signature
 */
function validateSignature(body, signature) {
  const channelSecret = (process.env.LINE_CHANNEL_SECRET || '').trim();
  if (!channelSecret || !signature) {
    console.warn('[LINE Service] Missing LINE_CHANNEL_SECRET or x-line-signature header');
    return false;
  }

  try {
    const hash = crypto
      .createHmac('SHA256', channelSecret)
      .update(body, 'utf8')
      .digest('base64');
    return hash === signature;
  } catch (err) {
    console.error('[LINE Service] Signature verification failed:', err.message);
    return false;
  }
}

/**
 * Get user profile from LINE API
 */
async function getUserProfile(userId) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  if (!token || !userId) return null;

  try {
    const res = await fetch(`${LINE_API_PROFILE}/${userId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!res.ok) {
      console.warn(`[LINE Service] Failed to fetch profile for ${userId}: status ${res.status}`);
      return null;
    }

    return await res.json();
  } catch (err) {
    console.error('[LINE Service] getUserProfile error:', err.message);
    return null;
  }
}

/**
 * Reply message to a user or group
 */
async function replyMessage(replyToken, messages) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  if (!token || !replyToken) {
    return { success: false, reason: 'Missing token or replyToken' };
  }

  const formattedMessages = Array.isArray(messages)
    ? messages.map((m) => (typeof m === 'string' ? { type: 'text', text: m } : m))
    : [typeof messages === 'string' ? { type: 'text', text: messages } : messages];

  try {
    const res = await fetch(LINE_API_REPLY, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        replyToken,
        messages: formattedMessages,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error('[LINE Service] Reply failed:', errBody);
      return { success: false, error: errBody };
    }

    return { success: true };
  } catch (err) {
    console.error('[LINE Service] Reply error:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Send alert message via LINE to one or more user IDs (Multicast)
 * Supports string, single message object (e.g. Flex), or array of messages
 */
async function sendLineAlert(lineUserIds, messagePayload) {
  if (!lineUserIds || lineUserIds.length === 0) {
    return { success: false, reason: 'No recipient LINE user IDs' };
  }

  const validIds = lineUserIds.filter(
    (id) => id && typeof id === 'string' && id.trim().length > 0
  );
  if (validIds.length === 0) {
    return { success: false, reason: 'No valid recipient LINE user IDs' };
  }

  const formattedMessages = Array.isArray(messagePayload)
    ? messagePayload
    : [typeof messagePayload === 'string' ? { type: 'text', text: messagePayload } : messagePayload];

  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
  if (!token) {
    console.log(`[LINE Service (Dry-Run)] Would send to ${validIds.length} users:`);
    console.log(`Recipients: ${validIds.join(', ')}`);
    console.log(`Message:`, JSON.stringify(formattedMessages, null, 2));
    return { success: true, simulated: true, recipients: validIds.length };
  }

  try {
    const chunks = [];
    const CHUNK_SIZE = 500;
    for (let i = 0; i < validIds.length; i += CHUNK_SIZE) {
      chunks.push(validIds.slice(i, i + CHUNK_SIZE));
    }

    for (const chunk of chunks) {
      const response = await fetch(LINE_API_MULTICAST, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          to: chunk,
          messages: formattedMessages,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error(`[LINE Service] Multicast error (${response.status}):`, errorBody);
        return { success: false, error: errorBody };
      }
    }

    console.log(`[LINE Service] Alert sent successfully to ${validIds.length} user(s) via LINE OA`);
    return { success: true, count: validIds.length };
  } catch (err) {
    console.error('[LINE Service] Failed to send LINE message:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Format alert into friendly Thai message for text fallback
 */
function formatAlertMessage({ stationName, stationId, alertType, value, threshold, customMessage }) {
  const timeStr = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  let header = '[แจ้งเตือนระบบเฝ้าระวังน้ำ]';

  switch (alertType) {
    case 'water_level':
      header = '[แจ้งเตือนระดับน้ำวิกฤต/เฝ้าระวัง]';
      break;
    case 'rate_of_rise':
      header = '[แจ้งเตือนอัตราน้ำเพิ่มสูงผิดปกติ]';
      break;
    case 'offline':
      header = '[แจ้งเตือนสถานีขาดการติดต่อ]';
      break;
    case 'battery':
      header = '[แจ้งเตือนแบตเตอรี่สถานีต่ำ]';
      break;
    case 'geofence':
      header = '[แจ้งเตือนสถานีเคลื่อนที่ออกนอกพิกัด]';
      break;
    case 'tilt':
      header = '[แจ้งเตือนการเอียงของทุ่น/เสาสถานี]';
      break;
  }

  let text = `${header}\n`;
  text += `• สถานี ${stationName || stationId} (${stationId})\n`;
  text += `• เวลาตรวจวัด ${timeStr}\n`;
  if (value !== undefined && value !== null) {
    text += `• ค่าที่ตรวจวัดได้ ${value}\n`;
  }
  if (threshold !== undefined && threshold !== null) {
    text += `• เกณฑ์กำหนด ${threshold}\n`;
  }
  if (customMessage) {
    text += `• รายละเอียด ${customMessage}\n`;
  }
  text += `\n[ระบบ FloodGuard] ตรวจสอบข้อมูลสดได้ที่ ${getLiffUrl(`/nodes/${encodeURIComponent(stationId)}`)}`;

  return text;
}

// ============================================================
// DESIGN SYSTEM TOKENS & THEMING (Rules: Zero-Emoji, Bento Grid, WCAG AA)
// ============================================================
const BENTO_THEME = {
  bubbleBg: '#F8FAFC',
  cardBg: '#FFFFFF',
  cardBorder: '#E2E8F0',
  textPrimary: '#0F172A',
  textSecondary: '#64748B',
  textMuted: '#94A3B8',
  buttonDark: '#0F172A',
  severity: {
    normal: {
      color: '#10B981',
      badgeBg: '#ECFDF5',
      badgeBorder: '#A7F3D0',
      dot: '#10B981',
      label: 'สถานะปกติ',
    },
    warning: {
      color: '#F59E0B',
      badgeBg: '#FFFBEB',
      badgeBorder: '#FDE68A',
      dot: '#F59E0B',
      label: 'เกณฑ์เฝ้าระวัง',
    },
    critical: {
      color: '#EF4444',
      badgeBg: '#FEF2F2',
      badgeBorder: '#FECACA',
      dot: '#EF4444',
      label: 'สถานะวิกฤต',
    },
    offline: {
      color: '#64748B',
      badgeBg: '#F1F5F9',
      badgeBorder: '#CBD5E1',
      dot: '#64748B',
      label: 'ขาดการเชื่อมต่อ',
    },
  },
};

/**
 * Determine dynamic severity theme token
 */
function getDynamicSeverityTheme(alertType, value, threshold) {
  if (alertType === 'offline') {
    return BENTO_THEME.severity.offline;
  }
  if (alertType === 'water_level') {
    if (value != null && threshold != null && Number(value) < Number(threshold)) {
      return BENTO_THEME.severity.warning;
    }
    return BENTO_THEME.severity.critical;
  }
  if (alertType === 'battery' || alertType === 'tilt' || alertType === 'rate_of_rise') {
    return BENTO_THEME.severity.warning;
  }
  return BENTO_THEME.severity.critical;
}

/**
 * Emergency protocol checklist generator based on Miller's Law (4 digestible chunks)
 */
function getSafetyProtocol(alertType, statusTheme) {
  if (alertType === 'water_level') {
    if (statusTheme.color === '#EF4444') {
      return [
        { num: '1', title: 'ขนย้ายทรัพย์สินและเครื่องใช้ไฟฟ้าขึ้นที่สูงทันที', desc: 'ตัดระบบไฟฟ้าชั้นล่างเพื่อป้องกันไฟฟ้ารั่ว' },
        { num: '2', title: 'เตรียมกระเป๋าฉุกเฉิน ยา และน้ำดื่มสะอาด', desc: 'เก็บเอกสารสำคัญในถุงกันน้ำให้พร้อมเดินทาง' },
        { num: '3', title: 'เคลื่อนย้ายกลุ่มเปราะบางไปจุดปลอดภัย', desc: 'ผู้สูงอายุ เด็ก ผู้ป่วยติดเตียง และสัตว์เลี้ยง' },
        { num: '4', title: 'ติดตามประกาศเตือนภัยจากศูนย์ FloodGuard', desc: 'ปฏิบัติตามคำแนะนำของเจ้าหน้าที่อย่างเคร่งครัด' },
      ];
    }
    return [
      { num: '1', title: 'เฝ้าระวังและติดตามระดับน้ำอย่างใกล้ชิด', desc: 'ตรวจสอบความสูงของน้ำทุก 15-30 นาที' },
      { num: '2', title: 'ตรวจเช็กแนวกระสอบทรายและท่อระบายน้ำ', desc: 'กำจัดสิ่งกีดขวางทางน้ำไหลรอบที่อยู่อาศัย' },
      { num: '3', title: 'ชาร์จแบตเตอรี่โทรศัพท์และไฟฉายสำรอง', desc: 'เตรียมไฟส่องสว่างและพาวเวอร์แบงก์ให้พร้อม' },
      { num: '4', title: 'วางแผนเส้นทางอพยพกรณีน้ำเพิ่มสูงขึ้น', desc: 'ศึกษาจุดปลอดภัยประจำชุมชนล่วงหน้า' },
    ];
  }
  if (alertType === 'rate_of_rise') {
    return [
      { num: '1', title: 'ระวังน้ำหลากฉับพลันและน้ำล้นตลิ่งเร็ว', desc: 'อัตราน้ำเพิ่มสูงขึ้นผิดปกติในเวลาอันสั้น' },
      { num: '2', title: 'หลีกเลี่ยงการสัญจรผ่านเส้นทางริมน้ำ', desc: 'ห้ามขับรถฝ่ากระแสน้ำเชี่ยวเด็ดขาด' },
      { num: '3', title: 'รีบยกสิ่งของขึ้นที่สูงโดยเร็วที่สุด', desc: 'ให้ความสำคัญกับความปลอดภัยในชีวิตเป็นอันดับแรก' },
      { num: '4', title: 'ประสานงานกับผู้นำชุมชนหรือ ปภ. ทันที', desc: 'หากระดับน้ำยังคงเพิ่มขึ้นอย่างต่อเนื่อง' },
    ];
  }
  // Technical / Device alerts
  return [
    { num: '1', title: 'แจ้งเตือนทีมวิศวกรและช่างเทคนิคดูแลระบบ', desc: 'อุปกรณ์ IoT ตรวจพบสถานะผิดปกติทางเทคนิค' },
    { num: '2', title: 'ตรวจสอบระบบสื่อสารและสัญญาณ LoRaWAN', desc: 'เช็กสถานะ Gateway และสถานีข้างเคียง' },
    { num: '3', title: 'ตรวจสอบแผงโซลาร์เซลล์และชุดแบตเตอรี่', desc: 'ตรวจสอบแรงดันไฟและการชาร์จประจุ' },
    { num: '4', title: 'ตรวจสอบจุดยึดและสมอยึดทุ่นหน้างาน', desc: 'ป้องกันทุ่นลอยหลุดหรือสายสลิงชำรุด' },
  ];
}

/**
 * Create a premium LINE Flex Message (Bento Grid layout) adhering to system specification:
 * - Bubble background: #F8FAFC
 * - Sub-metrics cards: #FFFFFF, rounded 12px
 * - Dynamic severity theme (Normal #10B981, Warning #F59E0B, Critical #EF4444, Offline #64748B)
 * - Zero Unicode Emojis (Minimalist status capsules with geometric dots and clean typography)
 * - Prominent deep-link CTA button to live node dashboard
 */
function createAlertFlexMessage({
  stationName,
  stationId,
  alertType,
  value,
  threshold,
  customMessage,
  refName = 'จุดอ้างอิง',
  station = null,
}) {
  const deepLinkUrl = getLiffUrl(`/nodes/${encodeURIComponent(stationId)}`);
  const timeStr = new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: 'short',
  });

  const theme = getDynamicSeverityTheme(alertType, value, threshold);

  // Format primary metric display
  let primaryTitle = 'ระดับน้ำตรวจวัดล่าสุด';
  let primaryValue = `${value ?? '-'}`;
  let primaryUnit = 'ม. (รสม.)';
  let comparisonText = customMessage || `เทียบกับ${refName}`;

  if (alertType === 'water_level') {
    primaryTitle = 'ระดับน้ำตรวจวัดล่าสุด';
    const numVal = Number(value || 0);
    primaryValue = `${numVal >= 0 ? '+' : ''}${numVal.toFixed(2)}`;
    primaryUnit = 'ม. (รสม.)';
    if (threshold != null) {
      const diff = numVal - Number(threshold);
      comparisonText = diff >= 0
        ? `สูงกว่าเกณฑ์ที่กำหนด +${diff.toFixed(2)} ม.`
        : `ต่ำกว่าเกณฑ์ที่กำหนด ${Math.abs(diff).toFixed(2)} ม.`;
    }
  } else if (alertType === 'rate_of_rise') {
    primaryTitle = 'อัตราน้ำเพิ่มสูงขึ้น';
    primaryValue = `+${Number(value || 0).toFixed(2)}`;
    primaryUnit = 'ม./ชม.';
    comparisonText = `เกณฑ์กำหนด ${threshold ?? 0.3} ม./ชม.`;
  } else if (alertType === 'offline') {
    primaryTitle = 'ระยะเวลาไม่พบการติดต่อ';
    primaryValue = `${value ?? threshold ?? 60}`;
    primaryUnit = 'นาที';
    comparisonText = 'ขาดสัญญาณตรวจวัดเกินเกณฑ์กำหนด';
  } else if (alertType === 'battery') {
    primaryTitle = 'ระดับแบตเตอรี่อุปกรณ์';
    primaryValue = `${value ?? 0}`;
    primaryUnit = '%';
    comparisonText = `เกณฑ์แจ้งเตือน <= ${threshold ?? 20}%`;
  } else if (alertType === 'geofence') {
    primaryTitle = 'ระยะห่างจากพิกัดสมอ';
    primaryValue = `${Number(value || 0).toFixed(1)}`;
    primaryUnit = 'ม.';
    comparisonText = `ระยะปลอดภัยกำหนดไม่เกิน ${threshold ?? 100} ม.`;
  } else if (alertType === 'tilt') {
    primaryTitle = 'องศาการเอียงของทุ่น';
    primaryValue = `${Number(value || 0).toFixed(1)}`;
    primaryUnit = 'องศา (°)';
    comparisonText = 'องศาการเอียงเกินเกณฑ์ปลอดภัย';
  }

  // Telemetry sub-metrics — only use real values from the station object
  const isStationOffline = alertType === 'offline';
  const batteryPercent = Math.round(Number(station?.battery_percent ?? (alertType === 'battery' ? value : null)));
  const batteryVoltage = station?.battery_voltage != null ? Number(station.battery_voltage).toFixed(2) : null;
  const hasBattery = !isNaN(batteryPercent) && station?.battery_percent != null || alertType === 'battery';
  const temperature = station?.temperature != null ? Number(station.temperature).toFixed(1) : null;
  const rssi = station?.rssi != null ? Math.round(Number(station.rssi)) : null;
  const tiltDegrees = station?.tilt_x != null ? Number(station.tilt_x).toFixed(1) : (alertType === 'tilt' ? Number(value).toFixed(1) : null);
  const tiltStatusText = tiltDegrees != null ? (Number(tiltDegrees) > 15 ? 'เอียงผิดปกติ' : 'สมดุลปกติ') : '-';
  const locationLabel = station?.location_name || 'สถานีโทรมาตรวัดระดับน้ำ';

  // Battery bar: calculate fill percentage (0-100), colour-coded
  const battFill = hasBattery ? Math.min(100, Math.max(0, batteryPercent)) : 0;
  const battColor = battFill > 50 ? '#10B981' : battFill > 20 ? '#F59E0B' : '#EF4444';
  const battLabel = hasBattery ? (battFill > 50 ? 'พร้อมใช้งาน' : battFill > 20 ? 'แบตปานกลาง' : 'แบตต่ำ') : '-';

  // Temperature colour
  const tempNum = temperature != null ? Number(temperature) : null;
  const tempColor = tempNum == null ? '#94A3B8' : tempNum > 35 ? '#EF4444' : tempNum > 28 ? '#F59E0B' : '#10B981';
  const tempLabel = tempNum == null ? '-' : tempNum > 35 ? 'ร้อนมาก' : tempNum > 28 ? 'ปกติ' : 'เย็น';

  const bubble = {
    type: 'bubble',
    size: 'mega',
    styles: {
      body: {
        backgroundColor: BENTO_THEME.bubbleBg,
      },
      footer: {
        backgroundColor: BENTO_THEME.bubbleBg,
      },
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      spacing: 'md',
      contents: [
        // 1. Header: Dynamic Severity Status Pill & Detection Timestamp
        {
          type: 'box',
          layout: 'horizontal',
          alignItems: 'center',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              backgroundColor: theme.badgeBg,
              borderColor: theme.badgeBorder,
              borderWidth: '1px',
              cornerRadius: '9999px',
              paddingTop: 'xs',
              paddingBottom: 'xs',
              paddingStart: 'sm',
              paddingEnd: 'sm',
              alignItems: 'center',
              spacing: 'xs',
              contents: [
                {
                  type: 'box',
                  layout: 'vertical',
                  width: '8px',
                  height: '8px',
                  cornerRadius: '9999px',
                  backgroundColor: theme.dot,
                  contents: [],
                },
                {
                  type: 'text',
                  text: theme.label,
                  color: theme.color,
                  size: 'xs',
                  weight: 'bold',
                },
              ],
            },
            {
              type: 'text',
              text: `${timeStr} น.`,
              color: BENTO_THEME.textSecondary,
              size: 'xxs',
              align: 'end',
              gravity: 'center',
            },
          ],
        },
        // Node Name & ID
        {
          type: 'box',
          layout: 'vertical',
          margin: 'xs',
          contents: [
            {
              type: 'text',
              text: stationName || stationId,
              weight: 'bold',
              size: 'xl',
              color: BENTO_THEME.textPrimary,
              wrap: true,
            },
            {
              type: 'text',
              text: `NODE-${stationId} · ${locationLabel}`,
              size: 'xs',
              color: BENTO_THEME.textSecondary,
              margin: 'xs',
            },
          ],
        },
        // 2. Hero Box: Primary Sensor Value (Large Typography)
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: BENTO_THEME.cardBg,
          borderColor: BENTO_THEME.cardBorder,
          borderWidth: '1px',
          cornerRadius: '12px',
          paddingAll: '16px',
          margin: 'sm',
          contents: [
            {
              type: 'box',
              layout: 'horizontal',
              contents: [
                {
                  type: 'text',
                  text: primaryTitle,
                  color: BENTO_THEME.textSecondary,
                  size: 'xs',
                  weight: 'bold',
                },
                {
                  type: 'text',
                  text: 'SENSOR METRIC',
                  color: BENTO_THEME.textMuted,
                  size: 'xxs',
                  align: 'end',
                  weight: 'bold',
                },
              ],
            },
            {
              type: 'box',
              layout: 'baseline',
              spacing: 'xs',
              margin: 'sm',
              contents: [
                {
                  type: 'text',
                  text: primaryValue,
                  size: '3xl',
                  weight: 'bold',
                  color: theme.color,
                  flex: 0,
                },
                {
                  type: 'text',
                  text: primaryUnit,
                  size: 'sm',
                  weight: 'bold',
                  color: BENTO_THEME.textSecondary,
                  margin: 'sm',
                },
              ],
            },
            {
              type: 'box',
              layout: 'horizontal',
              margin: 'sm',
              backgroundColor: BENTO_THEME.bubbleBg,
              cornerRadius: '6px',
              paddingAll: '8px',
              contents: [
                {
                  type: 'text',
                  text: comparisonText,
                  color: '#475569',
                  size: 'xs',
                  wrap: true,
                },
              ],
            },
          ],
        },
        // 3. Sub-Metrics Grid — Priority: Temperature (left) + Battery Bar (right)
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          margin: 'sm',
          contents: [
            // LEFT: Temperature
            {
              type: 'box',
              layout: 'vertical',
              flex: 1,
              backgroundColor: BENTO_THEME.cardBg,
              borderColor: BENTO_THEME.cardBorder,
              borderWidth: '1px',
              cornerRadius: '12px',
              paddingAll: '12px',
              contents: [
                {
                  type: 'text',
                  text: 'อุณหภูมิ',
                  size: 'xxs',
                  color: BENTO_THEME.textSecondary,
                  weight: 'bold',
                },
                {
                  type: 'box',
                  layout: 'horizontal',
                  alignItems: 'center',
                  spacing: 'xs',
                  margin: 'xs',
                  contents: [
                    {
                      type: 'text',
                      text: temperature != null ? `${temperature}` : '-',
                      size: 'xl',
                      weight: 'bold',
                      color: tempColor,
                      flex: 0,
                    },
                    ...(temperature != null ? [{
                      type: 'text',
                      text: '°C',
                      size: 'xs',
                      color: BENTO_THEME.textSecondary,
                    }] : []),
                  ],
                },
                {
                  type: 'text',
                  text: tempLabel || '-',
                  size: 'xxs',
                  color: tempColor,
                  weight: 'bold',
                  margin: 'xs',
                },
              ],
            },
            // RIGHT: Battery Bar Gauge
            {
              type: 'box',
              layout: 'vertical',
              flex: 1,
              backgroundColor: BENTO_THEME.cardBg,
              borderColor: BENTO_THEME.cardBorder,
              borderWidth: '1px',
              cornerRadius: '12px',
              paddingAll: '12px',
              contents: [
                {
                  type: 'box',
                  layout: 'horizontal',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  contents: [
                    {
                      type: 'text',
                      text: 'แบตเตอรี่',
                      size: 'xxs',
                      color: BENTO_THEME.textSecondary,
                      weight: 'bold',
                    },
                    {
                      type: 'text',
                      text: hasBattery ? `${batteryPercent}%` : '-',
                      size: 'xxs',
                      color: battColor,
                      weight: 'bold',
                    },
                  ],
                },
                // Battery bar track (background)
                {
                  type: 'box',
                  layout: 'vertical',
                  margin: 'sm',
                  height: '8px',
                  cornerRadius: '9999px',
                  backgroundColor: '#E2E8F0',
                  contents: [
                    // Battery bar fill
                    {
                      type: 'box',
                      layout: 'vertical',
                      width: hasBattery ? `${battFill}%` : '0%',
                      height: '8px',
                      cornerRadius: '9999px',
                      backgroundColor: battColor,
                      contents: [],
                    },
                  ],
                },
                {
                  type: 'box',
                  layout: 'horizontal',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  margin: 'xs',
                  contents: [
                    {
                      type: 'text',
                      text: battLabel || '-',
                      size: 'xxs',
                      color: battColor,
                      weight: 'bold',
                    },
                    ...(batteryVoltage != null ? [{
                      type: 'text',
                      text: `${batteryVoltage}V`,
                      size: 'xxs',
                      color: BENTO_THEME.textMuted,
                    }] : []),
                  ],
                },
              ],
            },
          ],
        },
        // 4. Secondary metrics: RSSI + Tilt (compact row)
        ...((rssi != null || tiltDegrees != null) ? [{
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          margin: 'xs',
          contents: [
            ...(rssi != null ? [{
              type: 'box',
              layout: 'horizontal',
              flex: 1,
              alignItems: 'center',
              backgroundColor: '#F1F5F9',
              cornerRadius: '8px',
              paddingAll: '8px',
              spacing: 'xs',
              contents: [
                { type: 'text', text: 'RSSI', size: 'xxs', color: BENTO_THEME.textMuted, weight: 'bold', flex: 0 },
                { type: 'text', text: `${rssi} dBm`, size: 'xxs', color: rssi > -75 ? '#10B981' : rssi > -90 ? '#F59E0B' : '#EF4444', weight: 'bold' },
              ],
            }] : []),
            ...(tiltDegrees != null ? [{
              type: 'box',
              layout: 'horizontal',
              flex: 1,
              alignItems: 'center',
              backgroundColor: '#F1F5F9',
              cornerRadius: '8px',
              paddingAll: '8px',
              spacing: 'xs',
              contents: [
                { type: 'text', text: 'เอียง', size: 'xxs', color: BENTO_THEME.textMuted, weight: 'bold', flex: 0 },
                { type: 'text', text: `${tiltDegrees}° (${tiltStatusText})`, size: 'xxs', color: Number(tiltDegrees) > 15 ? '#EF4444' : '#0284C7', weight: 'bold' },
              ],
            }] : []),
          ],
        }] : []),
      ],
    },
    // 4. Footer: Deep-link Call-to-Action
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      paddingTop: '0px',
      contents: [
        {
          type: 'button',
          action: {
            type: 'uri',
            label: 'เปิดดูสดบน Dashboard',
            uri: deepLinkUrl,
          },
          style: 'primary',
          color: BENTO_THEME.buttonDark,
          height: 'sm',
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: `[FloodGuard] ${theme.label}: ${stationName || stationId} (${primaryValue} ${primaryUnit})`,
    contents: bubble,
  };
}

/**
 * Create a rich status summary Flex Message Carousel for checking all stations (Zero Emojis, Bento Grid)
 */
function createStatusSummaryFlexMessage(stations = []) {
  const webUrl = getWebUrl();
  const timeStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

  if (stations.length === 0) {
    const emptyBubble = {
      type: 'bubble',
      size: 'mega',
      styles: {
        body: { backgroundColor: BENTO_THEME.bubbleBg },
        footer: { backgroundColor: BENTO_THEME.bubbleBg },
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        contents: [
          { type: 'text', text: 'FLOODGUARD STATUS', color: '#0284C7', size: 'xxs', weight: 'bold' },
          { type: 'text', text: 'สถานการณ์ระดับน้ำล่าสุด', color: BENTO_THEME.textPrimary, size: 'lg', weight: 'bold', margin: 'xs' },
          { type: 'text', text: 'ขณะนี้ไม่มีข้อมูลสถานีที่เปิดให้บริการในระบบ', color: BENTO_THEME.textSecondary, size: 'sm', margin: 'md' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        paddingTop: '0px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: BENTO_THEME.buttonDark,
            height: 'sm',
            action: { type: 'uri', label: 'เข้าสู่หน้าแดชบอร์ดหลัก', uri: getLiffUrl('/dashboard') },
          },
        ],
      },
    };
    return {
      type: 'flex',
      altText: 'รายงานข้อมูลระดับน้ำล่าสุด FloodGuard',
      contents: emptyBubble,
    };
  }

  // Create Carousel Cards for each station (up to 10 stations)
  const stationCards = stations.slice(0, 10).map((st) => {
    const refName = st.reference_point_name || 'จุดอ้างอิง';
    let levelText = 'ไม่มีข้อมูล';
    let statusTheme = BENTO_THEME.severity.normal;

    if (st.water_level != null) {
      const wVal = Number(st.water_level);
      levelText = `${wVal >= 0 ? '+' : ''}${wVal.toFixed(2)} ม.`;
      if (st.critical_level != null && wVal >= Number(st.critical_level)) {
        statusTheme = BENTO_THEME.severity.critical;
      } else if (st.warning_level != null && wVal >= Number(st.warning_level)) {
        statusTheme = BENTO_THEME.severity.warning;
      } else {
        statusTheme = BENTO_THEME.severity.normal;
      }
    }

    const warnDisplay = st.warning_level != null ? `${Number(st.warning_level) >= 0 ? '+' : ''}${Number(st.warning_level).toFixed(2)} ม.` : '-';
    const critDisplay = st.critical_level != null ? `${Number(st.critical_level) >= 0 ? '+' : ''}${Number(st.critical_level).toFixed(2)} ม.` : '-';

    return {
      type: 'bubble',
      size: 'mega',
      styles: {
        body: { backgroundColor: BENTO_THEME.bubbleBg },
        footer: { backgroundColor: BENTO_THEME.bubbleBg },
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '18px',
        spacing: 'sm',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            alignItems: 'center',
            contents: [
              {
                type: 'box',
                layout: 'horizontal',
                backgroundColor: statusTheme.badgeBg,
                borderColor: statusTheme.badgeBorder,
                borderWidth: '1px',
                cornerRadius: '9999px',
                paddingTop: 'xs',
                paddingBottom: 'xs',
                paddingStart: 'sm',
                paddingEnd: 'sm',
                alignItems: 'center',
                spacing: 'xs',
                contents: [
                  {
                    type: 'box',
                    layout: 'vertical',
                    width: '6px',
                    height: '6px',
                    cornerRadius: '9999px',
                    backgroundColor: statusTheme.dot,
                    contents: [],
                  },
                  {
                    type: 'text',
                    text: statusTheme.label,
                    color: statusTheme.color,
                    size: 'xxs',
                    weight: 'bold',
                  },
                ],
              },
              { type: 'text', text: `อัปเดต ${timeStr} น.`, color: BENTO_THEME.textSecondary, size: 'xxs', align: 'end' },
            ],
          },
          {
            type: 'text',
            text: st.station_name || st.station_id,
            color: BENTO_THEME.textPrimary,
            size: 'lg',
            weight: 'bold',
            margin: 'xs',
            wrap: true,
          },
          // Hero Metric Box
          {
            type: 'box',
            layout: 'vertical',
            backgroundColor: BENTO_THEME.cardBg,
            borderColor: BENTO_THEME.cardBorder,
            borderWidth: '1px',
            cornerRadius: '12px',
            paddingAll: '12px',
            margin: 'sm',
            contents: [
              { type: 'text', text: 'ระดับน้ำปัจจุบัน', color: BENTO_THEME.textSecondary, size: 'xxs', weight: 'bold' },
              { type: 'text', text: levelText, color: statusTheme.color, size: 'xxl', weight: 'bold', margin: 'xs' },
              { type: 'text', text: `เทียบ${refName}`, color: BENTO_THEME.textMuted, size: 'xs', margin: 'xs' },
            ],
          },
          // Threshold Comparison Grid
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            margin: 'xs',
            contents: [
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: BENTO_THEME.cardBg,
                borderColor: BENTO_THEME.cardBorder,
                borderWidth: '1px',
                cornerRadius: '8px',
                paddingAll: '8px',
                flex: 1,
                contents: [
                  { type: 'text', text: 'เกณฑ์เฝ้าระวัง', color: BENTO_THEME.severity.warning.color, size: 'xxs', weight: 'bold' },
                  { type: 'text', text: warnDisplay, color: BENTO_THEME.textPrimary, size: 'xs', weight: 'bold', margin: 'xs' },
                ],
              },
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: BENTO_THEME.cardBg,
                borderColor: BENTO_THEME.cardBorder,
                borderWidth: '1px',
                cornerRadius: '8px',
                paddingAll: '8px',
                flex: 1,
                contents: [
                  { type: 'text', text: 'เกณฑ์วิกฤต', color: BENTO_THEME.severity.critical.color, size: 'xxs', weight: 'bold' },
                  { type: 'text', text: critDisplay, color: BENTO_THEME.textPrimary, size: 'xs', weight: 'bold', margin: 'xs' },
                ],
              },
            ],
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '18px',
        paddingTop: '0px',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: BENTO_THEME.buttonDark,
            height: 'sm',
            action: {
              type: 'uri',
              label: 'เปิดดูสดบน Dashboard',
              uri: getLiffUrl(`/nodes/${encodeURIComponent(st.station_id)}`),
            },
          },
        ],
      },
    };
  });

  return {
    type: 'flex',
    altText: 'รายงานข้อมูลระดับน้ำล่าสุด FloodGuard',
    contents: {
      type: 'carousel',
      contents: stationCards,
    },
  };
}

/**
 * Create a welcoming Flex Message in Bento Grid theme (Zero Emojis)
 * Differentiates registered vs unregistered citizens
 */
function createWelcomeFlexMessage(displayName = 'ผู้ใช้ LINE', userId = '', isRegistered = false) {
  const registerUrl = getLiffUrl(`/register${userId ? `?uid=${encodeURIComponent(userId)}` : ''}`);
  const dashboardUrl = getLiffUrl('/dashboard');

  const badgeTheme = isRegistered ? BENTO_THEME.severity.normal : BENTO_THEME.severity.warning;
  const statusLabel = isRegistered ? 'สมาชิกประชาชนพร้อมใช้งาน' : 'รอการลงทะเบียนประชาชน';
  const actionButtonLabel = isRegistered ? 'เปิด Web Dashboard ภาพรวม' : 'ลงทะเบียนประชาชน (1-Tap)';
  const actionButtonUri = isRegistered ? dashboardUrl : registerUrl;

  const bubble = {
    type: 'bubble',
    size: 'mega',
    styles: {
      body: { backgroundColor: BENTO_THEME.bubbleBg },
      footer: { backgroundColor: BENTO_THEME.bubbleBg },
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      spacing: 'md',
      contents: [
        // Status Badge
        {
          type: 'box',
          layout: 'horizontal',
          backgroundColor: badgeTheme.badgeBg,
          borderColor: badgeTheme.badgeBorder,
          borderWidth: '1px',
          cornerRadius: '9999px',
          paddingTop: 'xs',
          paddingBottom: 'xs',
          paddingStart: 'sm',
          paddingEnd: 'sm',
          alignItems: 'center',
          spacing: 'xs',
          contents: [
            {
              type: 'box',
              layout: 'vertical',
              width: '8px',
              height: '8px',
              cornerRadius: '9999px',
              backgroundColor: badgeTheme.dot,
              contents: [],
            },
            {
              type: 'text',
              text: statusLabel,
              color: badgeTheme.color,
              size: 'xs',
              weight: 'bold',
            },
          ],
        },
        // Title
        {
          type: 'box',
          layout: 'vertical',
          margin: 'xs',
          contents: [
            {
              type: 'text',
              text: 'FloodGuard System',
              color: '#0284C7',
              size: 'xs',
              weight: 'bold',
            },
            {
              type: 'text',
              text: 'ยินดีต้อนรับสู่ระบบเฝ้าระวังน้ำ',
              weight: 'bold',
              size: 'xl',
              color: BENTO_THEME.textPrimary,
              margin: 'xs',
            },
            {
              type: 'text',
              text: 'ระบบโทรมาตรเตือนภัยระดับน้ำและตรวจวัดเซนเซอร์อัจฉริยะ',
              size: 'xs',
              color: BENTO_THEME.textSecondary,
              margin: 'xs',
            },
          ],
        },
        // Info Card
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: BENTO_THEME.cardBg,
          borderColor: BENTO_THEME.cardBorder,
          borderWidth: '1px',
          cornerRadius: '12px',
          paddingAll: '16px',
          margin: 'sm',
          contents: [
            {
              type: 'text',
              text: `สวัสดีคุณ ${displayName}`,
              size: 'md',
              weight: 'bold',
              color: BENTO_THEME.textPrimary,
            },
            {
              type: 'text',
              text: isRegistered
                ? 'บัญชีของท่านได้รับการยืนยันสิทธิ์ประชาชนเรียบร้อยแล้ว ท่านสามารถเข้าดูสถานะระดับน้ำสดของทุกสถานี และรับการแจ้งเตือนภัยอัตโนมัติ'
                : 'กรุณาลงทะเบียนประชาชนผ่านฟอร์ม 1-Tap สั้นๆ เพื่อเปิดสิทธิ์การเข้าใช้งาน Web Dashboard และรับการแจ้งเตือนระดับน้ำวิกฤต (ใช้เวลาไม่เกิน 15 วินาที)',
              size: 'xs',
              color: BENTO_THEME.textSecondary,
              wrap: true,
              margin: 'sm',
            },
          ],
        },
        // Quick Action Tips Box
        {
          type: 'box',
          layout: 'vertical',
          backgroundColor: BENTO_THEME.cardBg,
          borderColor: BENTO_THEME.cardBorder,
          borderWidth: '1px',
          cornerRadius: '12px',
          paddingAll: '14px',
          contents: [
            { type: 'text', text: 'คำสั่งด่วนในห้องแชท', size: 'xs', weight: 'bold', color: '#0F172A' },
            { type: 'text', text: '• พิมพ์ "ระดับน้ำ" หรือ "สถานะ" เพื่อตรวจดูทุกโหนดทันที', size: 'xs', color: BENTO_THEME.textSecondary, margin: 'xs' },
            { type: 'text', text: '• พิมพ์ "id" เพื่อตรวจสอบ LINE User ID ของคุณ', size: 'xs', color: BENTO_THEME.textSecondary, margin: 'xs' },
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      paddingTop: '0px',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'primary',
          color: BENTO_THEME.buttonDark,
          height: 'sm',
          action: {
            type: 'uri',
            label: actionButtonLabel,
            uri: actionButtonUri,
          },
        },
        ...(isRegistered
          ? [
              {
                type: 'button',
                style: 'secondary',
                color: BENTO_THEME.cardBorder,
                height: 'sm',
                action: {
                  type: 'uri',
                  label: 'ตั้งค่าการแจ้งเตือน & พื้นที่',
                  uri: registerUrl,
                },
              },
            ]
          : []),
      ],
    },
  };

  return {
    type: 'flex',
    altText: 'ยินดีต้อนรับสู่ระบบเตือนภัยระดับน้ำ FloodGuard',
    contents: bubble,
  };
}

module.exports = {
  validateSignature,
  getUserProfile,
  replyMessage,
  sendLineAlert,
  formatAlertMessage,
  createAlertFlexMessage,
  createStatusSummaryFlexMessage,
  createWelcomeFlexMessage,
  getWebUrl,
  getLiffUrl,
  BENTO_THEME,
  THEME: BENTO_THEME,
};
