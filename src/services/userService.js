const bcrypt = require('bcrypt');
const db = require('../config/database');

const SALT_ROUNDS = 10;
const DEFAULT_PASSWORD = 'demo1234';

/**
 * Format DB row to user object for frontend consumption
 */
function formatUser(row) {
  if (!row) return null;
  const isSynthetic = Boolean(
    row.email && (row.email.endsWith('@waterwatch.local') || row.email.endsWith('@floodguard.local'))
  );
  // User credentials are confirmed set if is_credentials_set is true, OR if role is staff/admin, AND email is not synthetic
  const isCredentialsSet = (Boolean(row.is_credentials_set) || row.role === 'staff' || row.role === 'admin') && !isSynthetic;

  return {
    id: String(row.user_id),
    name: row.name,
    email: row.email,
    phone: row.phone || '',
    role: row.role,
    district: row.district || '',
    line_user_id: row.line_user_id || null,
    lineUserId: row.line_user_id || null,
    station_ids: row.station_ids || [],
    stationIds: row.station_ids || [],
    is_active: row.is_active !== false,
    isActive: row.is_active !== false,
    is_credentials_set: isCredentialsSet,
    isCredentialsSet: isCredentialsSet,
    created_at: row.created_at,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    updated_at: row.updated_at,
  };
}

/**
 * Login user with email and password
 */
async function loginUser(email, password) {
  if (!email || !password) {
    throw new Error('กรุณากรอกอีเมลและรหัสผ่าน');
  }

  const res = await db.query(
    `SELECT user_id, name, email, password_hash, phone, role, district, line_user_id, station_ids, is_active, created_at, updated_at
     FROM users
     WHERE LOWER(email) = LOWER($1)
     LIMIT 1`,
    [email.trim()]
  );

  if (res.rows.length === 0) {
    throw new Error('ไม่พบบัญชีผู้ใช้นี้ในระบบ');
  }

  const user = res.rows[0];

  if (user.is_active === false) {
    throw new Error('บัญชีนี้ถูกระงับการใช้งาน');
  }

  const isMatch = await bcrypt.compare(password, user.password_hash);
  if (!isMatch) {
    throw new Error('รหัสผ่านไม่ถูกต้อง');
  }

  return formatUser(user);
}

/**
 * Get all users
 */
async function getAllUsers(roleFilter = null) {
  let queryText = `
    SELECT user_id, name, email, phone, role, district, line_user_id, station_ids, is_active, created_at, updated_at
    FROM users
  `;
  const params = [];

  if (roleFilter && roleFilter !== 'all') {
    queryText += ` WHERE role = $1`;
    params.push(roleFilter);
  }

  queryText += ` ORDER BY user_id ASC`;

  const res = await db.query(queryText, params);
  return res.rows.map(formatUser);
}

/**
 * Get user by ID
 */
async function getUserById(userId) {
  const res = await db.query(
    `SELECT user_id, name, email, phone, role, district, line_user_id, station_ids, is_active, created_at, updated_at
     FROM users
     WHERE user_id = $1
     LIMIT 1`,
    [userId]
  );

  if (res.rows.length === 0) return null;
  return formatUser(res.rows[0]);
}

/**
 * Create a new user
 */
async function createUser(data) {
  const {
    name,
    email,
    password,
    phone = '',
    role = 'citizen',
    district = '',
    line_user_id,
    lineUserId,
    station_ids,
    stationIds,
    is_active = true,
    isActive = true,
  } = data;

  if (!name || !name.trim()) {
    throw new Error('กรุณากรอกชื่อ-นามสกุล');
  }
  if (!email || !email.trim()) {
    throw new Error('กรุณากรอกอีเมล');
  }

  // Check duplicate email
  const existing = await db.query(
    `SELECT user_id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email.trim()]
  );
  if (existing.rows.length > 0) {
    throw new Error('อีเมลนี้ถูกใช้งานแล้วในระบบ');
  }

  if (password && password.trim()) {
    if (password.trim().length < 6) {
      throw new Error('รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร');
    }
  }
  const rawPassword = (password && password.trim()) ? password.trim() : DEFAULT_PASSWORD;
  const passwordHash = await bcrypt.hash(rawPassword, SALT_ROUNDS);

  const finalLineUserId = (line_user_id ?? lineUserId) || null;
  const finalStationIds = (station_ids ?? stationIds) || [];
  const finalIsActive = (is_active !== undefined) ? !!is_active : (isActive !== undefined ? !!isActive : true);

  const res = await db.query(
    `INSERT INTO users (
      name, email, password_hash, phone, role, district, line_user_id, station_ids, is_active, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
    RETURNING user_id, name, email, phone, role, district, line_user_id, station_ids, is_active, created_at, updated_at`,
    [
      name.trim(),
      email.trim().toLowerCase(),
      passwordHash,
      phone.trim(),
      role,
      district.trim(),
      finalLineUserId,
      finalStationIds,
      finalIsActive,
    ]
  );

  return formatUser(res.rows[0]);
}

/**
 * Update an existing user
 */
async function updateUser(userId, data) {
  const current = await getUserById(userId);
  if (!current) {
    throw new Error('ไม่พบผู้ใช้ที่ต้องการแก้ไข');
  }

  const {
    name,
    email,
    password,
    phone,
    role,
    district,
    line_user_id,
    lineUserId,
    station_ids,
    stationIds,
    is_active,
    isActive,
  } = data;

  // Check email uniqueness if email changed
  if (email && email.trim().toLowerCase() !== current.email.toLowerCase()) {
    const existing = await db.query(
      `SELECT user_id FROM users WHERE LOWER(email) = LOWER($1) AND user_id != $2 LIMIT 1`,
      [email.trim(), userId]
    );
    if (existing.rows.length > 0) {
      throw new Error('อีเมลนี้ถูกใช้งานแล้วในระบบ');
    }
  }

  const newName = name !== undefined ? name.trim() : current.name;
  const newEmail = email !== undefined ? email.trim().toLowerCase() : current.email;
  const newPhone = phone !== undefined ? phone.trim() : current.phone;
  const newRole = role !== undefined ? role : current.role;
  const newDistrict = district !== undefined ? district.trim() : current.district;
  const newLineUserId = (line_user_id !== undefined || lineUserId !== undefined)
    ? ((line_user_id ?? lineUserId) || null)
    : current.line_user_id;
  const newStationIds = (station_ids !== undefined || stationIds !== undefined)
    ? ((station_ids ?? stationIds) || [])
    : current.station_ids;
  const newIsActive = (is_active !== undefined || isActive !== undefined)
    ? (is_active !== undefined ? !!is_active : !!isActive)
    : current.is_active;

  // Handle password update if provided
  let passwordHashClause = '';
  const params = [
    newName,
    newEmail,
    newPhone,
    newRole,
    newDistrict,
    newLineUserId,
    newStationIds,
    newIsActive,
    userId,
  ];

  if (password !== undefined && password !== null) {
    const trimmed = String(password).trim();
    if (trimmed.length > 0) {
      if (trimmed.length < 6) {
        throw new Error('รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร');
      }
      const newHash = await bcrypt.hash(trimmed, SALT_ROUNDS);
      params.push(newHash);
      passwordHashClause = `, password_hash = $${params.length}`;
    }
  }

  const res = await db.query(
    `UPDATE users
     SET name = $1,
         email = $2,
         phone = $3,
         role = $4,
         district = $5,
         line_user_id = $6,
         station_ids = $7,
         is_active = $8
         ${passwordHashClause},
         updated_at = NOW()
     WHERE user_id = $9
     RETURNING user_id, name, email, phone, role, district, line_user_id, station_ids, is_active, created_at, updated_at`,
    params
  );

  return formatUser(res.rows[0]);
}

/**
 * Delete a user by ID
 */
async function deleteUser(userId) {
  const res = await db.query(
    `DELETE FROM users WHERE user_id = $1 RETURNING user_id, name, email`,
    [userId]
  );
  if (res.rows.length === 0) {
    throw new Error('ไม่พบผู้ใช้ที่ต้องการลบ');
  }
  return res.rows[0];
}

/**
 * Save or update a LINE subscriber in line_subscribers table
 * Automatically subscribes to all active stations by default
 */
async function saveOrUpdateSubscriber({ lineUserId, displayName, pictureUrl }) {
  if (!lineUserId) return null;

  try {
    // Get all active stations as default subscription
    const stationsRes = await db.query(`SELECT station_id FROM station WHERE status = 'active'`);
    const defaultStationIds = stationsRes.rows.map((r) => r.station_id);

    const res = await db.query(
      `INSERT INTO line_subscribers (
        line_user_id, display_name, picture_url, station_ids, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, true, NOW(), NOW())
      ON CONFLICT (line_user_id) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, line_subscribers.display_name),
        picture_url = COALESCE(EXCLUDED.picture_url, line_subscribers.picture_url),
        is_active = true,
        updated_at = NOW()
      RETURNING *`,
      [lineUserId, displayName || null, pictureUrl || null, defaultStationIds]
    );

    return res.rows[0];
  } catch (err) {
    console.error('[UserService] Error saving LINE subscriber:', err.message);
    return null;
  }
}

/**
 * Deactivate a LINE subscriber (e.g. when user blocks/unfollows bot)
 */
async function deactivateSubscriber(lineUserId) {
  if (!lineUserId) return;
  try {
    await db.query(
      `UPDATE line_subscribers SET is_active = false, updated_at = NOW() WHERE line_user_id = $1`,
      [lineUserId]
    );
  } catch (err) {
    console.error('[UserService] Error deactivating LINE subscriber:', err.message);
  }
}

/**
 * Get line_user_ids filtered by alert type and role:
 * 1. Public alerts ('water_level', 'rate_of_rise'):
 *    - Admin: all stations
 *    - Staff: assigned stations
 *    - Citizens (users table & line_subscribers table): assigned stations or subscribed to all
 * 2. Technical / hardware alerts ('battery', 'offline', 'online', 'tilt', 'geofence', 'sensor_drift'):
 *    - Admin: ALWAYS receives all alerts across all stations without exception
 *    - Staff: assigned stations
 *    - Citizens: EXCLUDED (do not disturb general public)
 * Returns deduplicated array of line_user_ids
 */
async function getLineRecipientsForAlert(stationId, alertType = 'water_level') {
  try {
    const isPublicAlert = ['water_level', 'rate_of_rise'].includes(alertType);

    // 1. Fetch from `users` table
    let userQuery = '';
    const userParams = [stationId];

    if (isPublicAlert) {
      userQuery = `
        SELECT line_user_id
        FROM users
        WHERE line_user_id IS NOT NULL
          AND line_user_id != ''
          AND is_active = true
          AND (
            role = 'admin'
            OR $1 = ANY(station_ids)
            OR (role = 'citizen' AND (cardinality(station_ids) = 0 OR station_ids IS NULL))
          )
      `;
    } else {
      // Technical alerts: Admin unconditionally, Staff for their assigned stations. Citizens excluded.
      userQuery = `
        SELECT line_user_id
        FROM users
        WHERE line_user_id IS NOT NULL
          AND line_user_id != ''
          AND is_active = true
          AND (
            role = 'admin'
            OR (role = 'staff' AND $1 = ANY(station_ids))
          )
      `;
    }

    const usersRes = await db.query(userQuery, userParams);

    // 2. Fetch from `line_subscribers` table (Public subscribers)
    let subsRes = { rows: [] };
    if (isPublicAlert) {
      subsRes = await db.query(
        `SELECT line_user_id
         FROM line_subscribers
         WHERE line_user_id IS NOT NULL
           AND line_user_id != ''
           AND is_active = true
           AND ($1 = ANY(station_ids) OR cardinality(station_ids) = 0 OR station_ids IS NULL)`,
        [stationId]
      );
    }

    const allIds = [
      ...usersRes.rows.map((r) => r.line_user_id),
      ...subsRes.rows.map((r) => r.line_user_id),
    ].filter(Boolean);

    // Deduplicate
    return [...new Set(allIds)];
  } catch (err) {
    console.error('[UserService] Error getting LINE recipients for alert:', err.message);
    return [];
  }
}

/**
 * Backward-compatible helper for station-level alerts
 */
async function getLineUserIdsForStation(stationId) {
  return getLineRecipientsForAlert(stationId, 'water_level');
}

/**
 * Get all active LINE recipients for daily status summary (citizens, staff, admin)
 * Deduplicated array of line_user_ids
 */
async function getAllLineRecipientsForSummary() {
  try {
    const usersRes = await db.query(
      `SELECT line_user_id
       FROM users
       WHERE line_user_id IS NOT NULL
         AND line_user_id != ''
         AND is_active = true`
    );

    const subsRes = await db.query(
      `SELECT line_user_id
       FROM line_subscribers
       WHERE line_user_id IS NOT NULL
         AND line_user_id != ''
         AND is_active = true`
    );

    const allIds = [
      ...usersRes.rows.map((r) => r.line_user_id),
      ...subsRes.rows.map((r) => r.line_user_id),
    ].filter(Boolean);

    return [...new Set(allIds)];
  } catch (err) {
    console.error('[UserService] Error getting all LINE recipients for summary:', err.message);
    return [];
  }
}


/**
 * Look up citizen user by line_user_id
 */
async function getCitizenByLineId(lineUserId) {
  if (!lineUserId) return null;
  const res = await db.query(
    `SELECT user_id, name, email, phone, role, district, line_user_id, station_ids, is_active, created_at, updated_at
     FROM users
     WHERE line_user_id = $1
     LIMIT 1`,
    [lineUserId]
  );
  if (res.rows.length === 0) return null;
  return formatUser(res.rows[0]);
}

/**
 * Register or update citizen through 1-Tap LIFF micro-form
 */
async function registerCitizen({ lineUserId, name, phone = '', district = '', stationIds = [] }) {
  if (!lineUserId) throw new Error('Missing lineUserId');

  // Find active stations if stationIds is empty
  let finalStationIds = stationIds;
  if (!Array.isArray(finalStationIds) || finalStationIds.length === 0) {
    const activeStations = await db.query(`SELECT station_id FROM station WHERE status = 'active'`);
    finalStationIds = activeStations.rows.map((s) => s.station_id);
  }

  // Check existing user with this LINE UID
  const existing = await db.query(
    `SELECT user_id, email FROM users WHERE line_user_id = $1 LIMIT 1`,
    [lineUserId]
  );

  let userRow;
  if (existing.rows.length > 0) {
    const uRes = await db.query(
      `UPDATE users
       SET name = COALESCE(NULLIF($1, ''), name),
           phone = COALESCE(NULLIF($2, ''), phone),
           district = COALESCE(NULLIF($3, ''), district),
           station_ids = CASE WHEN role = 'staff' AND array_length(station_ids, 1) > 0 THEN station_ids ELSE $4 END,
           is_active = true,
           updated_at = NOW()
       WHERE line_user_id = $5
       RETURNING user_id, name, email, phone, role, district, line_user_id, station_ids, is_active, is_credentials_set, created_at, updated_at`,
      [name || 'ประชาชนผู้ใช้งาน', phone, district, finalStationIds, lineUserId]
    );
    userRow = uRes.rows[0];
  } else {
    const cleanId = lineUserId.replace(/[^a-zA-Z0-9]/g, '').slice(-8).toLowerCase();
    const syntheticEmail = `citizen_${cleanId}@waterwatch.local`;
    const defaultHash = await bcrypt.hash('citizen1234', SALT_ROUNDS);

    const iRes = await db.query(
      `INSERT INTO users (
        name, email, password_hash, phone, role, district, line_user_id, station_ids, is_active, is_credentials_set, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'citizen', $5, $6, $7, true, false, NOW(), NOW())
      ON CONFLICT (email) DO UPDATE SET
        line_user_id = EXCLUDED.line_user_id,
        name = EXCLUDED.name,
        phone = EXCLUDED.phone,
        district = EXCLUDED.district,
        station_ids = EXCLUDED.station_ids,
        is_active = true,
        updated_at = NOW()
      RETURNING user_id, name, email, phone, role, district, line_user_id, station_ids, is_active, is_credentials_set, created_at, updated_at`,
      [name || 'ประชาชนผู้ใช้งาน', syntheticEmail, defaultHash, phone, district, lineUserId, finalStationIds]
    );
    userRow = iRes.rows[0];
  }

  // Also activate in line_subscribers
  await db.query(
    `INSERT INTO line_subscribers (
      line_user_id, display_name, station_ids, is_active, created_at, updated_at
    ) VALUES ($1, $2, $3, true, NOW(), NOW())
    ON CONFLICT (line_user_id) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, line_subscribers.display_name),
      station_ids = EXCLUDED.station_ids,
      is_active = true,
      updated_at = NOW()`,
    [lineUserId, name || 'ประชาชนผู้ใช้งาน', finalStationIds]
  );

  return formatUser(userRow);
}

/**
 * Register a citizen user with Email and Password
 */
async function registerCitizenEmail({ name, email, password, phone = '', district = '', stationIds = [] }) {
  if (!name || !name.trim()) {
    throw new Error('กรุณากรอกชื่อ-นามสกุล');
  }
  if (!email || !email.trim()) {
    throw new Error('กรุณากรอกอีเมล');
  }
  if (!password || password.length < 6) {
    throw new Error('รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร');
  }

  // Check duplicate email
  const existing = await db.query(
    `SELECT user_id FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email.trim()]
  );
  if (existing.rows.length > 0) {
    throw new Error('อีเมลนี้ถูกใช้งานแล้วในระบบ');
  }

  const passwordHash = await bcrypt.hash(password.trim(), SALT_ROUNDS);

  // If no stationIds provided, select active stations as default notification targets
  let finalStationIds = stationIds;
  if (!Array.isArray(finalStationIds) || finalStationIds.length === 0) {
    try {
      const activeStations = await db.query(`SELECT station_id FROM station WHERE status = 'active'`);
      finalStationIds = activeStations.rows.map((s) => s.station_id);
    } catch {
      finalStationIds = [];
    }
  }

  const res = await db.query(
    `INSERT INTO users (
      name, email, password_hash, phone, role, district, station_ids, is_active, is_credentials_set, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, 'citizen', $5, $6, true, true, NOW(), NOW())
    RETURNING user_id, name, email, phone, role, district, line_user_id, station_ids, is_active, is_credentials_set, created_at, updated_at`,
    [
      name.trim(),
      email.trim().toLowerCase(),
      passwordHash,
      phone.trim(),
      district.trim(),
      finalStationIds,
    ]
  );

  return formatUser(res.rows[0]);
}

/**
 * Set up real email and password for a citizen user
 */
async function setupCitizenCredentials({ userId, lineUserId, email, password }) {
  if (!email || !email.trim()) {
    throw new Error('กรุณากรอกอีเมล');
  }
  const cleanEmail = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    throw new Error('รูปแบบอีเมลไม่ถูกต้อง');
  }

  if (!password || password.length < 6) {
    throw new Error('รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร');
  }

  // Find user by userId or lineUserId
  let targetUser = null;
  if (userId) {
    const res = await db.query(
      `SELECT * FROM users WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    if (res.rows.length > 0) targetUser = res.rows[0];
  }
  if (!targetUser && lineUserId) {
    const res = await db.query(
      `SELECT * FROM users WHERE line_user_id = $1 LIMIT 1`,
      [lineUserId]
    );
    if (res.rows.length > 0) targetUser = res.rows[0];
  }

  if (!targetUser) {
    throw new Error('ไม่พบข้อมูลผู้ใช้งานในระบบ');
  }

  // Check if email is already taken by another user
  const emailCheck = await db.query(
    `SELECT user_id FROM users WHERE LOWER(email) = LOWER($1) AND user_id != $2 LIMIT 1`,
    [cleanEmail, targetUser.user_id]
  );
  if (emailCheck.rows.length > 0) {
    throw new Error('อีเมลนี้มีผู้ใช้งานแล้ว กรุณาใช้อีเมลอื่น');
  }

  // Hash new password
  const passwordHash = await bcrypt.hash(password.trim(), SALT_ROUNDS);

  // Update user
  const updateRes = await db.query(
    `UPDATE users
     SET email = $1,
         password_hash = $2,
         is_credentials_set = true,
         updated_at = NOW()
     WHERE user_id = $3
     RETURNING user_id, name, email, phone, role, district, line_user_id, station_ids, is_active, is_credentials_set, created_at, updated_at`,
    [cleanEmail, passwordHash, targetUser.user_id]
  );

  return formatUser(updateRes.rows[0]);
}

/**
 * Change password for authenticated user (verifies current password)
 */
async function changePassword(userId, currentPassword, newPassword) {
  if (!currentPassword || !currentPassword.trim()) {
    throw new Error('กรุณากรอกรหัสผ่านปัจจุบัน');
  }
  if (!newPassword || newPassword.trim().length < 6) {
    throw new Error('รหัสผ่านใหม่ต้องมีความยาวอย่างน้อย 6 ตัวอักษร');
  }

  const res = await db.query(
    `SELECT user_id, password_hash FROM users WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  if (res.rows.length === 0) {
    throw new Error('ไม่พบข้อมูลผู้ใช้ในระบบ');
  }

  const user = res.rows[0];
  const isMatch = await bcrypt.compare(currentPassword.trim(), user.password_hash);
  if (!isMatch) {
    throw new Error('รหัสผ่านปัจจุบันไม่ถูกต้อง');
  }

  const newHash = await bcrypt.hash(newPassword.trim(), SALT_ROUNDS);
  await db.query(
    `UPDATE users SET password_hash = $1, is_credentials_set = TRUE, updated_at = NOW() WHERE user_id = $2`,
    [newHash, userId]
  );

  return { success: true, message: 'เปลี่ยนรหัสผ่านสำเร็จเรียบร้อยแล้ว' };
}

/**
 * Link LINE account to an existing user
 */
async function linkLineToUser(userId, lineUserId, displayName = null, pictureUrl = null) {
  if (!userId) {
    throw new Error('ไม่พบรหัสผู้ใช้');
  }
  if (!lineUserId || !lineUserId.trim()) {
    throw new Error('ไม่พบรหัสผู้ใช้ LINE (lineUserId)');
  }

  const cleanLineId = lineUserId.trim();

  // 1. Check if lineUserId is already linked to another active account
  const checkConflict = await db.query(
    `SELECT user_id, name, email FROM users WHERE line_user_id = $1 AND user_id != $2 LIMIT 1`,
    [cleanLineId, userId]
  );
  if (checkConflict.rows.length > 0) {
    const conflictUser = checkConflict.rows[0];
    throw new Error(`บัญชี LINE นี้ถูกเชื่อมต่อกับผู้ใช้อื่นแล้ว (${conflictUser.name || conflictUser.email})`);
  }

  // 2. Fetch current user
  const userRes = await db.query(`SELECT * FROM users WHERE user_id = $1 LIMIT 1`, [userId]);
  if (userRes.rows.length === 0) {
    throw new Error('ไม่พบข้อมูลผู้ใช้ในระบบ');
  }
  const currentUser = userRes.rows[0];

  // 3. Update user with line_user_id
  const updateRes = await db.query(
    `UPDATE users
     SET line_user_id = $1,
         updated_at = NOW()
     WHERE user_id = $2
     RETURNING user_id, name, email, phone, role, district, line_user_id, station_ids, is_active, is_credentials_set, created_at, updated_at`,
    [cleanLineId, userId]
  );

  // 4. Ensure line_subscribers has this user with their station subscriptions
  try {
    const finalStations = currentUser.station_ids || [];
    await db.query(
      `INSERT INTO line_subscribers (
        line_user_id, display_name, station_ids, is_active, created_at, updated_at
      ) VALUES ($1, $2, $3, true, NOW(), NOW())
      ON CONFLICT (line_user_id) DO UPDATE SET
        display_name = COALESCE(EXCLUDED.display_name, line_subscribers.display_name),
        station_ids = EXCLUDED.station_ids,
        is_active = true,
        updated_at = NOW()`,
      [cleanLineId, displayName || currentUser.name || 'ประชาชนผู้ใช้งาน', finalStations]
    );
  } catch (subErr) {
    console.warn('[userService.linkLineToUser] Subscriber upsert warning:', subErr.message);
  }

  return formatUser(updateRes.rows[0]);
}

module.exports = {
  loginUser,
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  changePassword,
  saveOrUpdateSubscriber,
  deactivateSubscriber,
  getLineRecipientsForAlert,
  getLineUserIdsForStation,
  getAllLineRecipientsForSummary,
  getCitizenByLineId,
  registerCitizen,
  registerCitizenEmail,
  setupCitizenCredentials,
  linkLineToUser,
};

