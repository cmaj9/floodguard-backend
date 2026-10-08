const cron = require('node-cron');
const db = require('../config/database');
const { createStatusSummaryFlexMessage, sendLineAlert } = require('./lineService');
const { getAllLineRecipientsForSummary } = require('./userService');

/**
 * Dispatch twice-daily water summary to all active LINE users
 * @param {'morning'|'evening'|'manual'} period
 */
async function sendDailyWaterSummary(period = 'morning') {
  console.log(`[Scheduler] Starting daily water summary dispatch (${period})...`);
  try {
    // 1. Fetch active stations with their latest readings
    const stationsRes = await db.query(`
      SELECT
        s.station_id,
        s.station_name,
        s.location_name,
        COALESCE(NULLIF(TRIM(s.reference_point_name), ''), 'จุดอ้างอิง') AS reference_point_name,
        s.warning_level,
        s.critical_level,
        s.latitude,
        s.longitude,
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
      console.log('[Scheduler] No active stations found. Skipping summary dispatch.');
      return { success: false, reason: 'No active stations' };
    }

    // 2. Build Status Summary Flex Message
    const summaryFlex = createStatusSummaryFlexMessage(stationsRes.rows, { period });

    // 3. Retrieve all active LINE recipients (citizens, staff, admin)
    const lineRecipients = await getAllLineRecipientsForSummary();
    if (lineRecipients.length === 0) {
      console.log('[Scheduler] No active LINE recipients found.');
      return { success: false, reason: 'No active LINE recipients' };
    }

    console.log(`[Scheduler] Sending ${period} summary to ${lineRecipients.length} LINE recipients...`);
    const sendResult = await sendLineAlert(lineRecipients, summaryFlex);

    console.log(`[Scheduler] Daily water summary (${period}) dispatch completed:`, sendResult);
    return { success: true, count: lineRecipients.length, result: sendResult };
  } catch (err) {
    console.error(`[Scheduler] Error in sendDailyWaterSummary (${period}):`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Initialize daily scheduled cron jobs (07:00 and 18:00 Asia/Bangkok)
 */
function initScheduler() {
  console.log('[Scheduler] Initializing automated daily cron jobs (Asia/Bangkok timezone)...');

  // Morning schedule: 07:00 AM Bangkok time every day
  const morningTask = cron.schedule(
    '0 7 * * *',
    () => {
      console.log('[Scheduler] Triggering scheduled morning water summary (07:00)...');
      sendDailyWaterSummary('morning').catch((err) =>
        console.error('[Scheduler] Morning summary cron error:', err.message)
      );
    },
    {
      scheduled: true,
      timezone: 'Asia/Bangkok',
    }
  );

  // Evening schedule: 18:00 PM (6:00 PM) Bangkok time every day
  const eveningTask = cron.schedule(
    '0 18 * * *',
    () => {
      console.log('[Scheduler] Triggering scheduled evening water summary (18:00)...');
      sendDailyWaterSummary('evening').catch((err) =>
        console.error('[Scheduler] Evening summary cron error:', err.message)
      );
    },
    {
      scheduled: true,
      timezone: 'Asia/Bangkok',
    }
  );

  console.log('[Scheduler] [OK] Registered: Morning (07:00) & Evening (18:00) Asia/Bangkok daily summaries');

  return {
    morningTask,
    eveningTask,
  };
}

module.exports = {
  initScheduler,
  sendDailyWaterSummary,
};
