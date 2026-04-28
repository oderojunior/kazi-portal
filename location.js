// src/services/location.js
// Handles real-time location pings, proximity queries, and Redis geo cache.
const { query }   = require('../config/db');
const { cache, pub } = require('../config/redis');
const logger      = require('../utils/logger');

const PING_TTL_SEC  = parseInt(process.env.MAX_PING_AGE_SECONDS, 10) || 30;
const GEO_KEY       = 'labourer:locations';              // Redis GEO set

/**
 * Record a labourer location ping.
 * 1. Write to Postgres (audit / history)
 * 2. Update Redis GEO for real-time proximity queries
 * 3. Publish to pub/sub channel for WebSocket broadcast
 */
const recordPing = async (userId, lat, lng, meta = {}) => {
  // Postgres (non-blocking — don't await in hot path)
  query(
    `INSERT INTO location_pings (user_id, location, accuracy_m, speed_kmh, heading)
     VALUES ($1, ST_SetSRID(ST_MakePoint($3, $2), 4326), $4, $5, $6)`,
    [userId, lat, lng, meta.accuracy_m || null, meta.speed_kmh || null, meta.heading || null]
  ).catch((err) => logger.error('Ping DB write failed', { error: err.message, userId }));

  // Redis GEO (primary for real-time matching)
  await cache.geoAdd(GEO_KEY, { longitude: lng, latitude: lat, member: userId });
  await cache.expire(GEO_KEY, PING_TTL_SEC * 10);        // rolling TTL on the set

  // Publish for WebSocket fan-out
  await pub.publish('location:updates', JSON.stringify({
    userId, lat, lng, ts: new Date().toISOString(), ...meta
  }));

  // Mark user as recently active
  await cache.setEx(`user:active:${userId}`, PING_TTL_SEC, '1');
};

/**
 * Find available labourers within radiusKm of (lat, lng).
 * Returns array of { userId, distanceKm }.
 */
const findNearby = async (lat, lng, radiusKm) => {
  const results = await cache.geoSearchWith(GEO_KEY,
    { longitude: lng, latitude: lat },
    { radius: radiusKm, unit: 'km' },
    ['WITHCOORD', 'WITHDIST', 'ASC'],
    { COUNT: 50 }
  );

  if (!results || !results.length) return [];

  // Filter to only currently-active (pinged within TTL) available labourers
  const pipeline = cache.multi();
  results.forEach((r) => pipeline.exists(`user:active:${r.member}`));
  const activeFlags = await pipeline.exec();

  return results
    .filter((_, i) => activeFlags[i] === 1)
    .map((r) => ({
      userId:     r.member,
      distanceKm: parseFloat(parseFloat(r.distance).toFixed(2)),
      lat:        parseFloat(r.coordinates.latitude),
      lng:        parseFloat(r.coordinates.longitude),
    }));
};

/**
 * Get the last known location of a specific user from Redis.
 */
const getLastLocation = async (userId) => {
  const pos = await cache.geoPos(GEO_KEY, userId);
  if (!pos || !pos[0]) return null;
  return { lng: parseFloat(pos[0].longitude), lat: parseFloat(pos[0].latitude) };
};

/**
 * Remove a user from the live location set (when they go offline).
 */
const removeUser = (userId) => cache.zRem(GEO_KEY, userId);

/**
 * Query Postgres for location history of a job (for dispute evidence).
 * Returns pings between job.accepted_at and job.completed_at.
 */
const getJobTrail = async (userId, from, to) => {
  const { rows } = await query(
    `SELECT ST_Y(location::geometry) AS lat,
            ST_X(location::geometry) AS lng,
            accuracy_m, recorded_at
     FROM location_pings
     WHERE user_id = $1 AND recorded_at BETWEEN $2 AND $3
     ORDER BY recorded_at ASC`,
    [userId, from, to]
  );
  return rows;
};

module.exports = { recordPing, findNearby, getLastLocation, removeUser, getJobTrail };
