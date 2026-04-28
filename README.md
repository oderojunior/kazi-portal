# Kazi Portal — Nairobi Casual Labour Platform

A production-ready backend for connecting clients and on-demand labourers in Nairobi, Kenya.

## Quick Start

```bash
cd backend
cp .env.example .env          # fill in your secrets
npm install
psql -U postgres -c "CREATE DATABASE kazi_portal;"
psql -U kazi_admin -d kazi_portal -f src/schema.sql
npm run dev
```

## File Structure

```
backend/
├── src/
│   ├── server.js              # Express + HTTP + WebSocket entry point
│   ├── schema.sql             # Full PostgreSQL schema (PostGIS, triggers, partitions)
│   ├── config/
│   │   ├── db.js              # pg Pool — query() and transaction() helpers
│   │   └── redis.js           # Redis clients: cache, pub, sub
│   ├── middleware/
│   │   ├── auth.js            # requireAuth, requireRole, requireVerified
│   │   └── limits.js          # Rate limiting + multer file upload
│   ├── routes/
│   │   ├── auth.js            # Register, login (2FA), refresh, logout
│   │   ├── verify.js          # ID scan upload, OCR stub, admin review queue
│   │   ├── jobs.js            # Full job lifecycle (create → complete)
│   │   ├── location.js        # Location pings, availability, trail
│   │   ├── disputes.js        # Raise and resolve disputes
│   │   └── users.js           # Profile, skills, ratings
│   ├── services/
│   │   ├── websocket.js       # WS server — auth, fan-out, Redis sub
│   │   ├── location.js        # Redis GEO, proximity queries, DB pings
│   │   ├── sms.js             # Twilio OTP — send and verify
│   │   └── storage.js         # S3 uploads — encrypted ID scans + public photos
│   └── utils/
│       ├── jwt.js             # Access + refresh token lifecycle
│       ├── encryption.js      # AES-256-GCM for PII at rest
│       └── logger.js          # Winston structured logger
└── .env.example
```

## Key Design Decisions

### Authentication
- **JWT access tokens** (15 min) + **refresh tokens** (7 days, rotated on use)
- **All logins require 2FA** via SMS OTP (Twilio)
- Refresh tokens stored as SHA-256 hashes; revocable per-user

### Identity Verification
- Client/labourer uploads **ID scan + selfie**
- EXIF metadata stripped from images before storage
- Files stored in **private S3 bucket with SSE-KMS**
- Only the encrypted S3 key and a SHA-256 hash are stored in the DB
- OCR + face match stubs (replace with AWS Rekognition / Smile Identity)
- Human review queue for failures; admin approve/reject API
- Append-only `verification_audit` table — immutable paper trail

### Real-time Location (taxi-style)
- Labourers send pings every ~10s via WebSocket or REST
- **Redis GEO sets** hold live positions (30s TTL per user)
- `ST_DWithin` PostGIS queries for job matching
- `SELECT FOR UPDATE` row lock prevents double-accept race conditions
- Location trail stored in Postgres (partitioned by week) for dispute evidence

### Privacy
- AES-256-GCM encrypts S3 keys before storing in DB
- Location data TTL — Redis purges stale pings automatically
- Data minimisation — no raw PII in main DB columns
- Rate limiting: 10 auth attempts / 15 min; 100 general requests / 15 min

### Kenyan Localisation
- Phone validation: `+254[17]\d{8}` (Safaricom/Airtel)
- Currency: KES
- Default payment: M-Pesa
- Nairobi bounding box validation on job coordinates
- S3 region: `af-south-1` (Cape Town — lowest latency)

## API Summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/register | — | Create user |
| POST | /api/login | — | Step 1: password check |
| POST | /api/login/verify | — | Step 2: OTP → tokens |
| POST | /api/refresh | — | Rotate tokens |
| POST | /api/logout | JWT | Revoke all refresh tokens |
| POST | /api/verify/upload | JWT | Upload ID scan + selfie |
| GET  | /api/verify/queue | admin | Human review queue |
| POST | /api/verify/review/:id | admin | Approve / reject |
| POST | /api/jobs | client+verified | Create job |
| GET  | /api/jobs/nearby | labourer | Geo proximity search |
| GET  | /api/jobs/:id | party | Job detail |
| POST | /api/jobs/:id/accept | labourer+verified | Accept (row lock) |
| POST | /api/jobs/:id/start | labourer | Mark in_progress |
| POST | /api/jobs/:id/complete | party | Complete + rate |
| POST | /api/jobs/:id/cancel | party | Cancel |
| POST | /api/location/ping | labourer | Send location |
| POST | /api/location/available | labourer | Go online |
| POST | /api/location/offline | labourer | Go offline |
| GET  | /api/location/trail/:jobId | party | Job GPS trail |
| POST | /api/disputes | party | Raise dispute |
| GET  | /api/disputes | admin | All open disputes |
| WS   | /realtime?token= | JWT | Bidirectional stream |

## Production Checklist

- [ ] Replace OCR stub with Smile Identity / AWS Rekognition
- [ ] Add pg_partman for automatic location_pings partition rotation
- [ ] Configure Nginx reverse proxy with SSL termination
- [ ] Set `DB_SSL=true` and use RDS/managed Postgres
- [ ] Enable Redis AUTH and TLS
- [ ] Tighten CORS origins to your production domain
- [ ] Set up CloudWatch / Grafana alerting on error rate
- [ ] Implement M-Pesa Daraja API for payment confirmation
- [ ] Add Firebase/APNs for mobile push notifications
- [ ] Schedule cron to purge old location pings (>30 days)
