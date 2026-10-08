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
    case 'online':
      header = '[แจ้งเตือนสถานีกลับมาออนไลน์]';
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
// DESIGN SYSTEM TOKENS & THEMING (Rules: Zero-Emoji, Bento Grid, WCAG AA, Modern 2026 Palette)
// ============================================================
const BENTO_THEME = {
  bubbleBg: '#F8FAFC',
  cardBg: '#FFFFFF',
  cardBorder: '#E2E8F0',
  textPrimary: '#0F172A',
  textSecondary: '#64748B',
  textMuted: '#94A3B8',
  buttonDark: '#0F172A',
  brandSky: '#0284C7',
  severity: {
    normal: {
      color: '#059669',
      badgeBg: '#ECFDF5',
      badgeBorder: '#A7F3D0',
      dot: '#059669',
      label: 'สถานะปกติ',
    },
    online: {
      color: '#059669',
      badgeBg: '#ECFDF5',
      badgeBorder: '#A7F3D0',
      dot: '#059669',
      label: 'กลับมาออนไลน์',
    },
    warning: {
      color: '#D97706',
      badgeBg: '#FEF3C7',
      badgeBorder: '#FDE68A',
      dot: '#D97706',
      label: 'เกณฑ์เฝ้าระวัง',
    },
    critical: {
      color: '#DC2626',
      badgeBg: '#FEE2E2',
      badgeBorder: '#FCA5A5',
      dot: '#DC2626',
      label: 'ระดับวิกฤต',
    },
    offline: {
      color: '#475569',
      badgeBg: '#F1F5F9',
      badgeBorder: '#CBD5E1',
      dot: '#64748B',
      label: 'ขาดการเชื่อมต่อ',
    },
  },
};

/**
 * Return public HTTPS URL of station photo (Master Node for ST-01 / ST-001)
 */
function getStationImageUrl(stationId) {
  const normId = String(stationId || '').toUpperCase().trim();
  if (normId === 'ST-001' || normId === 'ST-01' || normId.includes('01')) {
    if (process.env.MASTER_NODE_IMAGE_URL && process.env.MASTER_NODE_IMAGE_URL.trim() !== '') {
      return process.env.MASTER_NODE_IMAGE_URL.trim();
    }
    const webUrl = getWebUrl();
    if (webUrl.startsWith('https://')) {
      return `${webUrl}/master_node.jpeg`;
    }
    return 'https://waterwatch-frontend-mu.vercel.app/master_node.jpeg';
  }
  return null;
}

/**
 * Return Google Maps search URL for station coordinates
 */
function getGoogleMapsUrl(station) {
  const lat = station?.latitude ?? '14.035930';
  const lng = station?.longitude ?? '100.725160';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat)},${encodeURIComponent(lng)}`;
}

/**
 * Determine dynamic severity theme token
 */
/**
 * Determine dynamic severity theme token
 */
function getDynamicSeverityTheme(alertType, value, threshold, severity = null) {
  if (alertType === 'online') {
    return BENTO_THEME.severity.online;
  }
  if (alertType === 'offline') {
    return BENTO_THEME.severity.offline;
  }
  if (alertType === 'water_level') {
    if (severity === 'warning') {
      return BENTO_THEME.severity.warning;
    }
    if (severity === 'critical') {
      return BENTO_THEME.severity.critical;
    }
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
    if (statusTheme.color === '#EF4444' || statusTheme.color === '#DC2626') {
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
  if (alertType === 'online') {
    return [
      { num: '1', title: 'โหนดโทรมาตรกลับมาทำงานสมบูรณ์', desc: 'ระบบรับข้อมูลการตรวจวัดได้อย่างต่อเนื่อง' },
      { num: '2', title: 'ตรวจสอบระดับน้ำและสถานะปัจจุบัน', desc: 'ข้อมูลระดับน้ำและพารามิเตอร์อัปเดตสด' },
      { num: '3', title: 'ตรวจสอบแรงดันแบตเตอรี่และการชาร์จ', desc: 'เช็กความต่อเนื่องของพลังงานแผงโซลาร์' },
      { num: '4', title: 'ระบบบันทึกประวัติการเชื่อมต่อแล้ว', desc: 'สามารถดูข้อมูลย้อนหลังบนระบบ FloodGuard' },
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
 * Create a minimalist, high-impact LINE Flex Message adhering to Clean Whitespace Rhythm:
 * - Zero Unicode Emojis (Minimalist status capsules and clean typography)
 * - Hero metric with 5XL typography and baseline unit alignment
 * - Clear station identification: Name (Code) and Location/Role subtext
 * - Role-tailored action buttons (Disaster hotline for public emergencies; diagnostics & maps for staff/admin)
 * - 100% valid LINE Flex Message v3 schema (No empty boxes, no invalid margins)
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
  severity = null,
}) {
  const deepLinkUrl = getLiffUrl(`/nodes/${encodeURIComponent(stationId)}`);
  const googleMapsUrl = getGoogleMapsUrl(station);

  const now = new Date();
  const timeStr =
    now.toLocaleDateString('th-TH', {
      timeZone: 'Asia/Bangkok',
      day: '2-digit',
      month: 'short',
    }) +
    ' ' +
    now.toLocaleTimeString('th-TH', {
      timeZone: 'Asia/Bangkok',
      hour: '2-digit',
      minute: '2-digit',
    }) +
    ' น.';

  const isPublicAlert = ['water_level', 'rate_of_rise'].includes(alertType);
  const stationTitle = `${stationName || station?.station_name || 'สถานี'} (${stationId})`;

  let stationSubtitle = '';
  if (isPublicAlert) {
    const loc = [];
    if (station?.subdistrict) loc.push(`ต.${station.subdistrict}`);
    if (station?.district) loc.push(`อ.${station.district}`);
    if (station?.province) loc.push(`จ.${station.province}`);
    stationSubtitle = loc.length > 0 ? loc.join(' ') : (station?.location_name || 'สถานีโทรมาตรวัดระดับน้ำ');
  } else {
    stationSubtitle = 'เจ้าหน้าที่ผู้ดูแล / ช่างเทคนิค';
  }

  let categoryTitle = 'แจ้งเตือนระดับน้ำ';
  let badgeText = 'เฝ้าระวัง';
  let themeColor = '#D97706';
  let metricNumber = `${value ?? '-'}`;
  let metricUnit = 'ม.';
  let headlineText = customMessage || 'ตรวจพบค่าเกินเกณฑ์กำหนด';
  let sublineText = 'โปรดตรวจสอบรายละเอียดในระบบ';
  let buttons = [];

  if (alertType === 'water_level') {
    const numVal = Number(value || 0);
    const critLvl = Number(station?.critical_level ?? 1.5);
    const isCritical = severity
      ? severity === 'critical'
      : (station?.critical_level != null ? numVal >= Number(station.critical_level) : numVal >= 1.5);

    categoryTitle = 'แจ้งเตือนระดับน้ำ';
    badgeText = isCritical ? 'อันตราย' : 'เฝ้าระวัง';
    themeColor = isCritical ? '#DC2626' : '#D97706';
    metricNumber = `${numVal >= 0 ? '+' : ''}${numVal.toFixed(2)}`;
    metricUnit = 'ม.';

    if (!customMessage) {
      if (isCritical) {
        const diff = numVal - critLvl;
        headlineText = diff > 0 ? `น้ำล้นตลิ่งวิกฤต เกินเกณฑ์ +${diff.toFixed(2)} ม.` : 'ระดับน้ำแตะเกณฑ์วิกฤต';
      } else {
        headlineText = 'ระดับน้ำแตะเกณฑ์เฝ้าระวัง';
      }
    }
    sublineText = isCritical
      ? 'ระดับน้ำวิกฤต! โปรดเตรียมพร้อมอพยพทันที'
      : 'โปรดเฝ้าระวังภัยและติดตามสถานการณ์ใกล้ชิด';

    buttons.push({
      type: 'button',
      style: 'secondary',
      height: 'sm',
      color: '#F1F5F9',
      action: {
        type: 'uri',
        label: 'เช็คสถานี',
        uri: deepLinkUrl,
      },
    });

    if (isCritical) {
      buttons.push({
        type: 'button',
        style: 'primary',
        height: 'sm',
        color: '#DC2626',
        action: {
          type: 'uri',
          label: 'โทรสายด่วน 1784 (ปภ.)',
          uri: 'tel:1784',
        },
      });
    }
  } else if (alertType === 'rate_of_rise') {
    const numVal = Number(value || 0);
    categoryTitle = 'แจ้งเตือนระดับน้ำ';
    badgeText = 'น้ำขึ้นเร็ว';
    themeColor = '#DC2626';
    metricNumber = `+${numVal.toFixed(2)}`;
    metricUnit = 'ม./ชม.';
    headlineText = customMessage || `อัตราน้ำเพิ่มเร็ว +${numVal.toFixed(2)} ม./ชม.`;
    sublineText = 'น้ำขึ้นฉับพลัน! โปรดระวังน้ำท่วมขังและยกของขึ้นที่สูง';
    buttons = [
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        color: '#F1F5F9',
        action: { type: 'uri', label: 'เช็คสถานี', uri: deepLinkUrl },
      },
      {
        type: 'button',
        style: 'primary',
        height: 'sm',
        color: '#DC2626',
        action: { type: 'uri', label: 'โทรสายด่วน 1784 (ปภ.)', uri: 'tel:1784' },
      },
    ];
  } else if (alertType === 'battery') {
    const battVal = Math.round(Number(value || station?.battery_percent || 0));
    categoryTitle = 'แจ้งเตือนอุปกรณ์';
    badgeText = 'แบตเตอรี่ต่ำ';
    themeColor = '#D97706';
    metricNumber = `${battVal}`;
    metricUnit = '%';
    headlineText = customMessage || 'แรงดันไฟฟ้าต่ำกว่าเกณฑ์ปกติ';
    sublineText = 'โปรดตรวจสอบแผงโซลาร์เซลล์หรือเปลี่ยนแบตเตอรี่';
    buttons = [
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        color: '#F1F5F9',
        action: { type: 'uri', label: 'ตรวจสอบสถานี', uri: deepLinkUrl },
      },
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        color: '#F1F5F9',
        action: { type: 'uri', label: 'เปิดแผนที่นำทาง', uri: googleMapsUrl },
      },
    ];
  } else if (alertType === 'offline') {
    const mins = Math.round(Number(value || threshold || 30));
    categoryTitle = 'แจ้งเตือนระบบ';
    badgeText = 'ขาดการติดต่อ';
    themeColor = '#64748B';
    metricNumber = `${mins}`;
    metricUnit = 'นาที';
    headlineText = customMessage || `ไม่ได้รับสัญญาณเกินเกณฑ์ ${mins} นาที`;
    sublineText = 'โปรดตรวจสอบการจ่ายไฟหรือสัญญาณเครือข่าย';
    buttons = [
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        color: '#F1F5F9',
        action: { type: 'uri', label: 'ตรวจสอบสถานี', uri: deepLinkUrl },
      },
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        color: '#F1F5F9',
        action: { type: 'uri', label: 'เปิดแผนที่นำทาง', uri: googleMapsUrl },
      },
    ];
  } else if (alertType === 'online') {
    categoryTitle = 'แจ้งเตือนระบบ';
    badgeText = 'ออนไลน์แล้ว';
    themeColor = '#059669';
    metricNumber = 'ONLINE';
    metricUnit = null;
    headlineText = customMessage || 'สถานีกลับมาส่งข้อมูลตามปกติแล้ว';
    sublineText = 'อุปกรณ์เชื่อมต่อสัญญาณและบันทึกข้อมูลเรียบร้อย';
    buttons = [
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        color: '#F1F5F9',
        action: { type: 'uri', label: 'ตรวจสอบสถานี', uri: deepLinkUrl },
      },
    ];
  } else if (alertType === 'tilt') {
    const tiltVal = Number(value || 0).toFixed(1);
    categoryTitle = 'แจ้งเตือนอุปกรณ์';
    badgeText = 'เสาเอียงผิดปกติ';
    themeColor = '#D97706';
    metricNumber = `${tiltVal}`;
    metricUnit = '°';
    headlineText = customMessage || `ตรวจพบมุมเอียง ${tiltVal}° เกินเกณฑ์`;
    sublineText = 'โปรดตรวจสอบจุดยึดและโครงสร้างเสาหน้างาน';
    buttons = [
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        color: '#F1F5F9',
        action: { type: 'uri', label: 'ตรวจสอบสถานี', uri: deepLinkUrl },
      },
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        color: '#F1F5F9',
        action: { type: 'uri', label: 'เปิดแผนที่นำทาง', uri: googleMapsUrl },
      },
    ];
  } else if (alertType === 'geofence') {
    const distVal = Number(value || 0).toFixed(1);
    categoryTitle = 'แจ้งเตือนอุปกรณ์';
    badgeText = 'เคลื่อนที่ผิดปกติ';
    themeColor = '#DC2626';
    metricNumber = `${distVal}`;
    metricUnit = 'ม.';
    headlineText = customMessage || `ทุ่นลอยเคลื่อนที่ออกนอกพิกัด ${distVal} ม.`;
    sublineText = 'โปรดตรวจสอบสมอยึดทุ่นทันที';
    buttons = [
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        color: '#F1F5F9',
        action: { type: 'uri', label: 'ตรวจสอบสถานี', uri: deepLinkUrl },
      },
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        color: '#F1F5F9',
        action: { type: 'uri', label: 'เปิดแผนที่นำทาง', uri: googleMapsUrl },
      },
    ];
  }

  const bubble = {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: 'xl',
      backgroundColor: '#FFFFFF',
      contents: [
        // 1. Header Row
        {
          type: 'box',
          layout: 'horizontal',
          alignItems: 'center',
          contents: [
            {
              type: 'text',
              text: categoryTitle,
              size: 'sm',
              weight: 'bold',
              color: themeColor,
            },
            {
              type: 'box',
              layout: 'vertical',
              backgroundColor: themeColor,
              cornerRadius: '9999px',
              paddingTop: '3px',
              paddingBottom: '3px',
              paddingStart: '10px',
              paddingEnd: '10px',
              flex: 0,
              contents: [
                {
                  type: 'text',
                  text: badgeText,
                  color: '#FFFFFF',
                  size: 'xs',
                  weight: 'bold',
                  gravity: 'center',
                },
              ],
            },
          ],
        },
        // 2. Station Block (Clean Whitespace: margin xl)
        {
          type: 'box',
          layout: 'vertical',
          alignItems: 'center',
          margin: 'xl',
          contents: [
            {
              type: 'text',
              align: 'center',
              wrap: true,
              contents: [
                {
                  type: 'span',
                  text: `${stationName || station?.station_name || 'สถานี'} `,
                  weight: 'bold',
                  size: 'md',
                  color: '#1E293B',
                },
                ...(stationId
                  ? [
                      {
                        type: 'span',
                        text: `(${stationId})`,
                        size: 'xs',
                        color: '#64748B',
                        weight: 'regular',
                      },
                    ]
                  : []),
              ],
            },
            ...(stationSubtitle
              ? [
                  {
                    type: 'text',
                    text: stationSubtitle,
                    size: 'xs',
                    color: '#64748B',
                    align: 'center',
                    margin: 'xs',
                  },
                ]
              : []),
          ],
        },
        // 3. Hero Metric Block (Clean Whitespace: margin xxl)
        {
          type: 'box',
          layout: 'baseline',
          justifyContent: 'center',
          spacing: 'xs',
          margin: 'xxl',
          contents: [
            {
              type: 'text',
              text: metricNumber,
              size: metricNumber === 'ONLINE' ? '4xl' : '5xl',
              weight: 'bold',
              color: themeColor,
              flex: 0,
            },
            ...(metricUnit
              ? [
                  {
                    type: 'text',
                    text: metricUnit,
                    size: 'md',
                    weight: 'bold',
                    color: '#64748B',
                    flex: 0,
                  },
                ]
              : []),
          ],
        },
        // 4. Alert Message Block (Clean Whitespace: margin md)
        {
          type: 'box',
          layout: 'vertical',
          alignItems: 'center',
          margin: 'md',
          contents: [
            {
              type: 'text',
              text: headlineText,
              color: themeColor,
              weight: 'bold',
              size: 'sm',
              align: 'center',
            },
            ...(sublineText
              ? [
                  {
                    type: 'text',
                    text: sublineText,
                    color: '#64748B',
                    size: 'xs',
                    align: 'center',
                    wrap: true,
                    margin: 'xs',
                  },
                ]
              : []),
          ],
        },
        // 5. Action Buttons Block (Clean Whitespace: margin xxl)
        {
          type: 'box',
          layout: 'vertical',
          spacing: 'sm',
          margin: 'xxl',
          contents: buttons,
        },
        // 6. Footer Timestamp (Clean Whitespace: margin lg)
        {
          type: 'text',
          text: `${timeStr} • ${isPublicAlert ? 'ระบบแจ้งเตือนอัตโนมัติ' : 'ฝ่ายบำรุงรักษา'}`,
          size: 'xxs',
          color: '#94A3B8',
          align: 'center',
          margin: 'lg',
        },
      ],
    },
  };

  return {
    type: 'flex',
    altText: `[FloodGuard] ${categoryTitle} (${badgeText}): ${stationTitle} ${metricNumber}${metricUnit || ''}`,
    contents: bubble,
  };
}

/**
 * Create a rich status summary Flex Message Carousel for checking all stations (Zero Emojis, Bento Grid)
 * Supports options.period: 'morning' | 'evening' for scheduled daily reports
 */
function createStatusSummaryFlexMessage(stations = [], options = {}) {
  const { period = null } = options;
  const webUrl = getWebUrl();
  const timeStr = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });

  let periodHeader = 'สถานการณ์ระดับน้ำล่าสุด';
  let altText = 'รายงานข้อมูลระดับน้ำล่าสุด FloodGuard';
  if (period === 'morning') {
    periodHeader = 'สรุปสถานการณ์น้ำภาคเช้า';
    altText = 'รายงานสรุปสถานการณ์น้ำประจำวันช่วงเช้า (07:00 น.) — FloodGuard';
  } else if (period === 'evening') {
    periodHeader = 'สรุปสถานการณ์น้ำภาคเย็น';
    altText = 'รายงานสรุปสถานการณ์น้ำประจำวันช่วงเย็น (18:00 น.) — FloodGuard';
  }

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
          { type: 'text', text: periodHeader, color: BENTO_THEME.textPrimary, size: 'lg', weight: 'bold', margin: 'xs' },
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

    const cardHero = getStationImageUrl(st.station_id);

    return {
      type: 'bubble',
      size: 'mega',
      styles: {
        body: { backgroundColor: BENTO_THEME.bubbleBg },
        footer: { backgroundColor: BENTO_THEME.bubbleBg },
      },
      ...(cardHero ? {
        hero: {
          type: 'image',
          url: cardHero,
          size: 'full',
          aspectRatio: '16:9',
          aspectMode: 'cover',
        },
      } : {}),
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
                paddingTop: '3px',
                paddingBottom: '3px',
                paddingStart: '8px',
                paddingEnd: '8px',
                alignItems: 'center',
                spacing: 'xs',
                flex: 0,
                contents: [
                  {
                    type: 'box',
                    layout: 'vertical',
                    width: '6px',
                    height: '6px',
                    cornerRadius: '9999px',
                    backgroundColor: statusTheme.dot,
                    flex: 0,
                    contents: [],
                  },
                  {
                    type: 'text',
                    text: statusTheme.label,
                    color: statusTheme.color,
                    size: 'xxs',
                    weight: 'bold',
                    gravity: 'center',
                    flex: 0,
                  },
                ],
              },
              {
                type: 'text',
                text: period === 'morning' ? `สรุปเช้า ${timeStr} น.` : period === 'evening' ? `สรุปเย็น ${timeStr} น.` : `อัปเดต ${timeStr} น.`,
                color: BENTO_THEME.textSecondary,
                size: 'xxs',
                align: 'end',
              },
            ],
          },
          {
            type: 'text',
            margin: 'xs',
            wrap: true,
            contents: [
              {
                type: 'span',
                text: `${st.station_name || st.station_id} `,
                color: BENTO_THEME.textPrimary,
                size: 'lg',
                weight: 'bold',
              },
              ...(st.station_name && st.station_id
                ? [
                    {
                      type: 'span',
                      text: `(${st.station_id})`,
                      color: BENTO_THEME.textSecondary,
                      size: 'xs',
                      weight: 'regular',
                    },
                  ]
                : []),
            ],
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
        paddingAll: '16px',
        paddingTop: '0px',
        spacing: 'xs',
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
          {
            type: 'button',
            style: 'link',
            color: BENTO_THEME.brandSky,
            height: 'sm',
            action: {
              type: 'uri',
              label: 'เปิดแผนที่พิกัดสถานี',
              uri: getGoogleMapsUrl(st),
            },
          },
        ],
      },
    };
  });

  return {
    type: 'flex',
    altText,
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
          paddingTop: '3px',
          paddingBottom: '3px',
          paddingStart: '8px',
          paddingEnd: '8px',
          alignItems: 'center',
          spacing: 'xs',
          flex: 0,
          contents: [
            {
              type: 'box',
              layout: 'vertical',
              width: '8px',
              height: '8px',
              cornerRadius: '9999px',
              backgroundColor: badgeTheme.dot,
              flex: 0,
              contents: [],
            },
            {
              type: 'text',
              text: statusLabel,
              color: badgeTheme.color,
              size: 'xs',
              weight: 'bold',
              gravity: 'center',
              flex: 0,
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
