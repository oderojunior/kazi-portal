// src/server.js — Kazi Portal API Server
require('dotenv').config();
const http    = require('http');
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const logger  = require('./utils/logger');

// ── App setup ─────────────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1);   // Nginx / load balancer in production

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", 'data:', `https://${process.env.S3_BUCKET_PUBLIC}.s3.amazonaws.com`],
    },
  },
}));

// CORS — tighten origins in production
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? ['https://kaziportal.co.ke', 'https://app.kaziportal.co.ke']
    : '*',
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined', { stream: { write: (msg) => logger.http(msg.trim()) } }));

// ── Rate limiting ─────────────────────────────────────────────────
const { apiLimiter } = require('./middleware/limits');
app.use('/api/', apiLimiter);

// ── Routes ────────────────────────────────────────────────────────
app.use('/api',          require('./routes/auth'));
app.use('/api/verify',   require('./routes/verify'));
app.use('/api/jobs',     require('./routes/jobs'));
app.use('/api/location', require('./routes/location'));
app.use('/api/disputes', require('./routes/disputes'));
app.use('/api/users',    require('./routes/users'));

// Health check (no auth)
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', env: process.env.NODE_ENV, ts: new Date().toISOString() })
);

// 404
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// Global error handler
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ── HTTP + WebSocket server ───────────────────────────────────────
const server = http.createServer(app);
const { attachWebSocket } = require('./services/websocket');
attachWebSocket(server);

// ── Startup ───────────────────────────────────────────────────────
const boot = async () => {
  const { connect: connectRedis } = require('./config/redis');
  await connectRedis();

  // Verify DB connection
  const { pool } = require('./config/db');
  await pool.query('SELECT 1');
  logger.info('PostgreSQL connected');

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    logger.info(`Kazi Portal API running on port ${PORT} [${process.env.NODE_ENV}]`);
    logger.info(`WebSocket endpoint: ws://localhost:${PORT}/realtime`);
  });
};

boot().catch((err) => {
  logger.error('Fatal startup error', { error: err.message });
  process.exit(1);
});

module.exports = app; // for testing
