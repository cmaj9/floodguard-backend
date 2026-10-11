const express = require('express');
const cors = require('cors');
require('dotenv').config();

const path = require('path');
const readingsRouter  = require('./routes/readings');
const stationsRouter  = require('./routes/stations');
const usersRouter      = require('./routes/users');
const alertsRouter     = require('./routes/alerts');
const lineWebhookRouter = require('./routes/lineWebhook');
const notificationSettingsRouter = require('./routes/notificationSettings');
const syncRouter = require('./routes/sync');
const { getMqttStatus } = require('./config/mqtt');

const app = express();

// Trust reverse proxy (Railway, Vercel, Nginx)
app.set('trust proxy', 1);

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://waterwatch-frontend-mu.vercel.app',
  'https://waterwatch-frontend.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow server-to-server, curl, mobile, and non-browser requests without origin header
    if (!origin) return callback(null, true);

    const isAllowed =
      allowedOrigins.includes(origin) ||
      origin.endsWith('.vercel.app') ||
      origin.startsWith('http://localhost:') ||
      origin.startsWith('http://127.0.0.1:');

    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));
// Preserve raw body buffer for LINE Webhook signature verification
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static assets (images, public assets for LINE Flex Messages)
app.use('/public', express.static(path.join(__dirname, '../public')));

// Request logger (development)
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`[HTTP] ${req.method} ${req.path}`);
    next();
  });
}

const rateLimit = require('express-rate-limit');

// Basic security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Rate limiter for authentication endpoints: max 5 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: {
    success: false,
    error: 'มีการพยายามเข้าสู่ระบบมากเกินไป กรุณารอ 15 นาทีแล้วลองใหม่อีกครั้ง',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

// ── Routes ────────────────────────────────────────────────────────
app.use('/api/auth/login', authLimiter);
app.use('/api/users/login', authLimiter);

app.use('/api/auth', usersRouter);
app.use('/api/users', usersRouter);
app.use('/api/alerts', alertsRouter);
app.use('/api/line', lineWebhookRouter);
app.use('/api/notifications', notificationSettingsRouter);
app.use('/api/readings', readingsRouter);
app.use('/api/stations', stationsRouter);
app.use('/api/internal', syncRouter);

// Root health check endpoint (supports Railway, UptimeRobot, load balancers)
app.get('/', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'FloodGuard Telemetry & Alert API',
    version: '1.2.0',
    timestamp: new Date().toISOString(),
  });
});

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mqtt: getMqttStatus(),
  });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('[Express] Unhandled error:', err);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

module.exports = app;
