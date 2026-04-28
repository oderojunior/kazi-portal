// src/services/websocket.js
// WebSocket server — handles real-time location broadcasts and job event push.
const WebSocket = require('ws');
const { sub }   = require('../config/redis');
const { verifyAccess } = require('../utils/jwt');
const logger    = require('../utils/logger');

// Map: userId → Set<ws> (user can have multiple tabs/devices)
const connections = new Map();

/**
 * Attach WebSocket server to an existing HTTP server.
 * Clients authenticate via ?token=<JWT> on upgrade.
 */
const attachWebSocket = (httpServer) => {
  const wss = new WebSocket.Server({ server: httpServer, path: '/realtime' });

  wss.on('connection', (ws, req) => {
    // --- Auth on upgrade ---
    const url    = new URL(req.url, `http://${req.headers.host}`);
    const token  = url.searchParams.get('token');

    let userId, userRole;
    try {
      const payload = verifyAccess(token);
      userId   = payload.sub;
      userRole = payload.role;
    } catch {
      ws.close(4001, 'Unauthorized');
      return;
    }

    ws.userId   = userId;
    ws.userRole = userRole;
    ws.isAlive  = true;

    if (!connections.has(userId)) connections.set(userId, new Set());
    connections.get(userId).add(ws);

    logger.debug('WS connected', { userId, role: userRole });

    // --- Inbound messages ---
    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'ping':          // WebSocket keep-alive (distinct from location ping)
          ws.isAlive = true;
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        case 'location':      // Labourer sends location update
          if (userRole !== 'labourer') break;
          try {
            const { recordPing } = require('./location');
            await recordPing(userId, msg.lat, msg.lng, {
              accuracy_m: msg.accuracy,
              speed_kmh:  msg.speed,
              heading:    msg.heading,
            });
          } catch (err) {
            logger.error('WS location record failed', { error: err.message });
          }
          break;

        case 'subscribe_job': // Client subscribes to updates for a specific job
          ws.subscribedJobId = msg.jobId;
          break;
      }
    });

    ws.on('close', () => {
      connections.get(userId)?.delete(ws);
      if (connections.get(userId)?.size === 0) connections.delete(userId);
      logger.debug('WS disconnected', { userId });
    });

    ws.on('error', (err) => logger.error('WS error', { userId, error: err.message }));
  });

  // --- Keep-alive heartbeat every 30s ---
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);

  // --- Redis subscription fan-out ---
  // Channel: location:updates — push labourer coordinates to subscribed clients
  sub.subscribe('location:updates', (message) => {
    let data;
    try { data = JSON.parse(message); } catch { return; }

    // Push to all clients subscribed to a job that involves this labourer
    wss.clients.forEach((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (ws.subscribedJobId && ws.userRole === 'client') {
        // We'll let the route handler resolve the job's labourer and notify
        send(ws, { type: 'location_update', ...data });
      }
    });
  });

  // Channel: job:events — status changes, new job offers
  sub.subscribe('job:events', (message) => {
    let event;
    try { event = JSON.parse(message); } catch { return; }

    // Notify target user
    if (event.targetUserId) {
      notify(event.targetUserId, event);
    }
  });

  logger.info('WebSocket server attached at /realtime');
  return wss;
};

/**
 * Send a message to a specific user (all their active connections).
 */
const notify = (userId, payload) => {
  const userConns = connections.get(userId);
  if (!userConns) return;
  const msg = JSON.stringify(payload);
  userConns.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
};

const send = (ws, payload) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
};

module.exports = { attachWebSocket, notify };
