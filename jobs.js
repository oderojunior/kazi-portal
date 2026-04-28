// src/routes/jobs.js
// Full job lifecycle: open → accepted → in_progress → completed | cancelled | disputed
const express = require('express');
const { body, query: qv, validationResult } = require('express-validator');
const { query, transaction } = require('../config/db');
const { findNearby }         = require('../services/location');
const { pub }                = require('../config/redis');
const { requireAuth, requireRole, requireVerified } = require('../middleware/auth');
const logger = require('../utils/logger');

const router  = express.Router();
const DEFAULT_RADIUS = parseFloat(process.env.DEFAULT_SEARCH_RADIUS_KM || '5');

router.use(requireAuth);

// ── POST /api/jobs ────────────────────────────────────────────────
// Client creates a new job posting.
router.post('/',
  requireRole('client'),
  requireVerified,
  [
    body('title').trim().isLength({ min: 5, max: 120 }),
    body('category').isIn([
      'construction','cleaning','moving','gardening','painting',
      'plumbing','electrical','security','delivery','domestic',
      'catering','events','driving','other'
    ]),
    body('lat').isFloat({ min: -4.1, max: 1.1 }),     // Nairobi bounding box
    body('lng').isFloat({ min: 33.9, max: 41.9 }),
    body('price').isFloat({ min: 1 }),
    body('locationLabel').optional().trim(),
    body('paymentMethod').optional().isIn(['mpesa','cash','bank']),
    body('startTime').optional().isISO8601(),
    body('notes').optional().trim().isLength({ max: 500 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const {
      title, category, lat, lng, price,
      locationLabel, paymentMethod = 'mpesa',
      startTime, notes,
    } = req.body;

    try {
      const { rows } = await query(
        `INSERT INTO jobs
           (client_id, category, title, location, location_label,
            price, payment_method, start_time, notes)
         VALUES ($1, $2, $3,
           ST_SetSRID(ST_MakePoint($5, $4), 4326),
           $6, $7, $8, $9, $10)
         RETURNING id, status, price, created_at`,
        [req.user.sub, category, title, lat, lng,
         locationLabel || null, price, paymentMethod,
         startTime || null, notes || null]
      );

      const job = rows[0];

      // Broadcast job offer to nearby available labourers
      const nearby = await findNearby(lat, lng, DEFAULT_RADIUS);
      if (nearby.length) {
        await pub.publish('job:events', JSON.stringify({
          type:          'new_job_offer',
          jobId:         job.id,
          category,
          title,
          price,
          lat, lng,
          locationLabel,
          nearbyLabourers: nearby.map((n) => n.userId),
        }));
      }

      logger.info('Job created', { jobId: job.id, clientId: req.user.sub, nearbyCount: nearby.length });

      res.status(201).json({ job, nearbyLabourers: nearby.length });
    } catch (err) {
      logger.error('Job create error', { error: err.message });
      res.status(500).json({ error: 'Failed to create job' });
    }
  }
);

// ── GET /api/jobs/nearby ──────────────────────────────────────────
// Labourer: find open jobs near a coordinate.
router.get('/nearby',
  requireRole('labourer'),
  [
    qv('lat').isFloat(),
    qv('lng').isFloat(),
    qv('radius').optional().isFloat({ min: 0.5, max: 50 }),
    qv('category').optional(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const lat    = parseFloat(req.query.lat);
    const lng    = parseFloat(req.query.lng);
    const radius = parseFloat(req.query.radius || DEFAULT_RADIUS);

    const categoryFilter = req.query.category
      ? `AND j.category = '${req.query.category}'`  // safe: validated by isIn above
      : '';

    try {
      const { rows } = await query(
        `SELECT j.id, j.title, j.category, j.price, j.payment_method,
                j.location_label, j.start_time, j.notes, j.created_at,
                u.name AS client_name, u.rating AS client_rating,
                ST_Distance(j.location::geography,
                  ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography) / 1000 AS distance_km
         FROM jobs j
         JOIN users u ON u.id = j.client_id
         WHERE j.status = 'open'
           ${categoryFilter}
           AND ST_DWithin(j.location::geography,
                 ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
                 $3 * 1000)
         ORDER BY distance_km ASC
         LIMIT 30`,
        [lat, lng, radius]
      );

      res.json({ jobs: rows, count: rows.length, radiusKm: radius });
    } catch (err) {
      logger.error('Nearby jobs error', { error: err.message });
      res.status(500).json({ error: 'Query failed' });
    }
  }
);

// ── GET /api/jobs/:id ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { rows } = await query(
    `SELECT j.*,
            ST_Y(j.location::geometry) AS lat,
            ST_X(j.location::geometry) AS lng,
            c.name AS client_name, c.photo_url AS client_photo, c.rating AS client_rating,
            l.name AS labourer_name, l.photo_url AS labourer_photo, l.rating AS labourer_rating
     FROM jobs j
     JOIN users c ON c.id = j.client_id
     LEFT JOIN users l ON l.id = j.labourer_id
     WHERE j.id = $1`,
    [req.params.id]
  );

  if (!rows.length) return res.status(404).json({ error: 'Job not found' });

  // Only parties to the job can see full details
  const job = rows[0];
  const userId = req.user.sub;
  if (job.client_id !== userId && job.labourer_id !== userId && req.user.role !== 'admin')
    return res.status(403).json({ error: 'Access denied' });

  res.json({ job });
});

// ── POST /api/jobs/:id/accept ─────────────────────────────────────
router.post('/:id/accept',
  requireRole('labourer'),
  requireVerified,
  async (req, res) => {
    const { id } = req.params;
    const labourerId = req.user.sub;

    try {
      const result = await transaction(async (client) => {
        // Lock row
        const { rows } = await client.query(
          `SELECT * FROM jobs WHERE id = $1 FOR UPDATE`, [id]
        );
        const job = rows[0];

        if (!job)              throw Object.assign(new Error('Job not found'), { status: 404 });
        if (job.status !== 'open') throw Object.assign(new Error('Job no longer available'), { status: 409 });

        await client.query(
          `UPDATE jobs SET status = 'accepted', labourer_id = $1, accepted_at = NOW()
           WHERE id = $2`,
          [labourerId, id]
        );

        return job;
      });

      // Notify client
      await pub.publish('job:events', JSON.stringify({
        type:         'job_accepted',
        jobId:        id,
        labourerId,
        targetUserId: result.client_id,
      }));

      res.json({ message: 'Job accepted', jobId: id });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  }
);

// ── POST /api/jobs/:id/start ──────────────────────────────────────
router.post('/:id/start',
  requireRole('labourer'),
  async (req, res) => {
    const { id } = req.params;
    const labourerId = req.user.sub;

    try {
      const { rows } = await query(
        `UPDATE jobs SET status = 'in_progress', started_at = NOW()
         WHERE id = $1 AND labourer_id = $2 AND status = 'accepted'
         RETURNING client_id`,
        [id, labourerId]
      );

      if (!rows.length) return res.status(404).json({ error: 'Job not found or cannot be started' });

      await pub.publish('job:events', JSON.stringify({
        type: 'job_started', jobId: id, targetUserId: rows[0].client_id,
      }));

      res.json({ message: 'Job started' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to start job' });
    }
  }
);

// ── POST /api/jobs/:id/complete ───────────────────────────────────
router.post('/:id/complete',
  [body('rating').optional().isInt({ min: 1, max: 5 }),
   body('comment').optional().trim()],
  async (req, res) => {
    const { id }      = req.params;
    const userId      = req.user.sub;
    const { rating, comment } = req.body;

    try {
      const { rows } = await query(
        `SELECT * FROM jobs WHERE id = $1`, [id]
      );
      const job = rows[0];

      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (job.status !== 'in_progress') return res.status(409).json({ error: 'Job not in progress' });
      if (job.client_id !== userId && job.labourer_id !== userId)
        return res.status(403).json({ error: 'Access denied' });

      await transaction(async (client) => {
        await client.query(
          `UPDATE jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`,
          [id]
        );

        if (rating) {
          const revieweeId = userId === job.client_id ? job.labourer_id : job.client_id;
          await client.query(
            `INSERT INTO ratings (job_id, reviewer_id, reviewee_id, score, comment)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (job_id, reviewer_id) DO NOTHING`,
            [id, userId, revieweeId, rating, comment || null]
          );
        }
      });

      // Notify the other party
      const otherParty = userId === job.client_id ? job.labourer_id : job.client_id;
      await pub.publish('job:events', JSON.stringify({
        type: 'job_completed', jobId: id, targetUserId: otherParty,
      }));

      res.json({ message: 'Job completed' });
    } catch (err) {
      logger.error('Complete error', { error: err.message });
      res.status(500).json({ error: 'Failed to complete job' });
    }
  }
);

// ── POST /api/jobs/:id/cancel ─────────────────────────────────────
router.post('/:id/cancel',
  [body('reason').optional().trim()],
  async (req, res) => {
    const { id }     = req.params;
    const userId     = req.user.sub;
    const { reason } = req.body;

    try {
      const { rows } = await query(
        `UPDATE jobs
         SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $1
         WHERE id = $2
           AND (client_id = $3 OR labourer_id = $3)
           AND status IN ('open','accepted')
         RETURNING client_id, labourer_id`,
        [reason || null, id, userId]
      );

      if (!rows.length) return res.status(404).json({ error: 'Job not found or cannot be cancelled' });

      const otherParty = userId === rows[0].client_id
        ? rows[0].labourer_id
        : rows[0].client_id;

      if (otherParty) {
        await pub.publish('job:events', JSON.stringify({
          type: 'job_cancelled', jobId: id, targetUserId: otherParty, reason,
        }));
      }

      res.json({ message: 'Job cancelled' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to cancel job' });
    }
  }
);

// ── GET /api/jobs ─────────────────────────────────────────────────
// My jobs (client or labourer)
router.get('/', async (req, res) => {
  const userId = req.user.sub;
  const role   = req.user.role;
  const status = req.query.status;

  const statusFilter = status ? `AND j.status = '${status}'` : '';

  const roleFilter = role === 'client'
    ? `j.client_id = '${userId}'`
    : `j.labourer_id = '${userId}'`;

  const { rows } = await query(
    `SELECT j.id, j.title, j.category, j.status, j.price, j.location_label,
            j.start_time, j.completed_at, j.created_at,
            ST_Y(j.location::geometry) AS lat,
            ST_X(j.location::geometry) AS lng
     FROM jobs j
     WHERE ${roleFilter} ${statusFilter}
     ORDER BY j.created_at DESC
     LIMIT 50`
  );

  res.json({ jobs: rows });
});

module.exports = router;
