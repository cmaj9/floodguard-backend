const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'floodguard_jwt_super_secure_secret_2026_xyz';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.warn('[Security Warning] JWT_SECRET is not set in Railway environment variables; using secure fallback default.');
}

/**
 * Generate a JWT token for an authenticated user
 */
function generateToken(user) {
  const payload = {
    id: String(user.id || user.user_id),
    name: user.name,
    email: user.email,
    role: user.role,
    stationIds: user.stationIds || user.station_ids || [],
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Verify JWT token middleware
 * Rejects requests with 401 Unauthorized if token is missing or invalid
 */
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'กรุณาเข้าสู่ระบบก่อนดำเนินการ (ไม่พบ Authorization Bearer token)',
    });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'เซสชันการเข้าสู่ระบบหมดอายุแล้ว กรุณาเข้าสู่ระบบใหม่อีกครั้ง',
        code: 'TOKEN_EXPIRED',
      });
    }
    return res.status(401).json({
      success: false,
      error: 'โทเค็นยืนยันตัวตนไม่ถูกต้องหรือถูกดัดแปลง',
      code: 'INVALID_TOKEN',
    });
  }
}

/**
 * Optional authentication middleware
 * Attaches req.user if a valid token is provided, but continues if no token
 */
function optionalAuthenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (_) {
      // Ignore token errors for optional routes
    }
  }
  next();
}

/**
 * Role-based authorization middleware
 * @param {string[]} allowedRoles - Array of authorized roles, e.g. ['admin', 'staff']
 */
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'กรุณาเข้าสู่ระบบก่อนดำเนินการ',
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `คุณไม่มีสิทธิ์เข้าถึงส่วนนี้ (ต้องการสิทธิ์: ${allowedRoles.join(' หรือ ')})`,
      });
    }

    next();
  };
}

/**
 * Get real-time station_ids for an authenticated user directly from PostgreSQL
 * If user is not staff, returns null (meaning unrestricted access for admin/others)
 * If user is staff, returns array of station_id strings (e.g. ['ST-001'] or [])
 */
async function getEffectiveUserStationIds(userId) {
  if (!userId) return [];
  try {
    const db = require('../config/database');
    const res = await db.query('SELECT station_ids, role FROM users WHERE user_id = $1 LIMIT 1', [userId]);
    if (res.rows.length === 0) return [];
    const row = res.rows[0];
    if (row.role !== 'staff') return null; // Admin or others are not restricted by assigned stations
    return Array.isArray(row.station_ids) ? row.station_ids : [];
  } catch (err) {
    console.error('[auth] Error fetching user station_ids from DB:', err.message);
    return [];
  }
}

/**
 * Middleware: Verify that staff only accesses stations they are assigned to.
 * Admins pass unconditionally.
 * @param {string} source - where stationId is located: 'params', 'query', or 'body'
 * @param {string} paramKey - key name, defaults to 'stationId'
 */
function requireStationAccess(source = 'params', paramKey = 'stationId') {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'กรุณาเข้าสู่ระบบก่อนดำเนินการ',
      });
    }

    if (req.user.role === 'admin') {
      return next();
    }

    if (req.user.role === 'staff') {
      const stationId = (req[source] && req[source][paramKey]) ? String(req[source][paramKey]).trim() : null;
      if (!stationId) {
        return res.status(400).json({
          success: false,
          error: 'ไม่พบรหัสสถานีที่ต้องการดำเนินการ',
        });
      }

      const assignedStationIds = await getEffectiveUserStationIds(req.user.id);
      const isAssigned = assignedStationIds && assignedStationIds.includes(stationId);

      if (!isAssigned) {
        return res.status(403).json({
          success: false,
          error: `คุณไม่มีสิทธิ์เข้าถึงหรือจัดการข้อมูลสถานี ${stationId} (อยู่นอกเหนือสถานีที่ได้รับมอบหมาย)`,
        });
      }

      req.userAssignedStationIds = assignedStationIds;
      return next();
    }

    return res.status(403).json({
      success: false,
      error: 'คุณไม่มีสิทธิ์เข้าถึงส่วนนี้',
    });
  };
}

module.exports = {
  generateToken,
  authenticateToken,
  optionalAuthenticate,
  requireRole,
  getEffectiveUserStationIds,
  requireStationAccess,
  JWT_SECRET,
};
