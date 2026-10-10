const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'floodguard_jwt_dev_secret_2026_xyz';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

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

module.exports = {
  generateToken,
  authenticateToken,
  optionalAuthenticate,
  requireRole,
  JWT_SECRET,
};
