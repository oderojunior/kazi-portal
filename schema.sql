-- ============================================================
-- KAZI PORTAL — PostgreSQL Schema
-- Run: psql -U kazi_admin -d kazi_portal -f schema.sql
-- ============================================================

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "postgis";       -- geospatial queries
CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- column-level encryption

-- ============================================================
-- ENUM TYPES
-- ============================================================
CREATE TYPE user_role AS ENUM ('labourer', 'client', 'admin');
CREATE TYPE verification_status AS ENUM ('pending', 'under_review', 'approved', 'rejected');
CREATE TYPE job_status AS ENUM ('open', 'accepted', 'in_progress', 'completed', 'cancelled', 'disputed');
CREATE TYPE dispute_status AS ENUM ('open', 'under_review', 'resolved_client', 'resolved_labourer', 'closed');
CREATE TYPE skill_category AS ENUM (
  'construction', 'cleaning', 'moving', 'gardening', 'painting',
  'plumbing', 'electrical', 'security', 'delivery', 'domestic',
  'catering', 'events', 'driving', 'other'
);

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  role              user_role NOT NULL,
  name              VARCHAR(120) NOT NULL,
  phone             VARCHAR(20) NOT NULL UNIQUE,          -- M-Pesa primary key
  email             VARCHAR(254) UNIQUE,
  phone_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  email_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash     TEXT NOT NULL,
  photo_url         TEXT,                                  -- public S3 URL
  -- Encrypted PII stored in S3; only audit hash kept here
  id_scan_s3_key    TEXT,                                  -- private S3 key (encrypted)
  id_scan_hash      TEXT,                                  -- SHA-256 of original scan for audit
  verified          verification_status NOT NULL DEFAULT 'pending',
  verification_reviewed_by UUID,                          -- admin user id
  verification_reviewed_at TIMESTAMPTZ,
  rating            NUMERIC(3,2) DEFAULT 0.00,
  rating_count      INTEGER NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  is_available      BOOLEAN NOT NULL DEFAULT FALSE,       -- labourer online/offline toggle
  last_seen_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_verified ON users(verified);
CREATE INDEX idx_users_available ON users(is_available) WHERE is_available = TRUE;

-- ============================================================
-- LABOURER SKILLS
-- ============================================================
CREATE TABLE labourer_skills (
  labourer_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill        skill_category NOT NULL,
  years_exp    SMALLINT DEFAULT 0,
  PRIMARY KEY (labourer_id, skill)
);

-- ============================================================
-- 2FA / OTP
-- ============================================================
CREATE TABLE otp_codes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone       VARCHAR(20) NOT NULL,
  code_hash   TEXT NOT NULL,                              -- bcrypt hash of OTP
  purpose     VARCHAR(30) NOT NULL,                       -- 'login'|'verify'|'reset'|'critical'
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_otp_user_purpose ON otp_codes(user_id, purpose);

-- ============================================================
-- REFRESH TOKENS
-- ============================================================
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,                       -- SHA-256 of token
  device_info TEXT,
  ip_address  INET,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);

-- ============================================================
-- JOBS
-- ============================================================
CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID NOT NULL REFERENCES users(id),
  labourer_id     UUID REFERENCES users(id),
  status          job_status NOT NULL DEFAULT 'open',
  category        skill_category NOT NULL,
  title           VARCHAR(120) NOT NULL,
  description     TEXT,
  location        GEOGRAPHY(POINT, 4326) NOT NULL,        -- PostGIS point
  location_label  VARCHAR(200),                           -- human-readable area e.g. "Westlands, Nairobi"
  price           NUMERIC(10,2) NOT NULL,
  currency        CHAR(3) NOT NULL DEFAULT 'KES',
  payment_method  VARCHAR(20) DEFAULT 'mpesa',            -- 'mpesa'|'cash'|'bank'
  start_time      TIMESTAMPTZ,
  end_time        TIMESTAMPTZ,
  accepted_at     TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  cancel_reason   TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobs_client ON jobs(client_id);
CREATE INDEX idx_jobs_labourer ON jobs(labourer_id);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_location ON jobs USING GIST(location);
CREATE INDEX idx_jobs_open_location ON jobs USING GIST(location) WHERE status = 'open';

-- ============================================================
-- LOCATION PINGS (hot table — high insert rate)
-- ============================================================
CREATE TABLE location_pings (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location     GEOGRAPHY(POINT, 4326) NOT NULL,
  accuracy_m   SMALLINT,
  speed_kmh    SMALLINT,
  heading      SMALLINT,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (recorded_at);

-- Create rolling weekly partitions (automate via pg_partman in prod)
CREATE TABLE location_pings_current PARTITION OF location_pings
  FOR VALUES FROM (NOW() - INTERVAL '1 day') TO (NOW() + INTERVAL '7 days');

CREATE INDEX idx_pings_user_time ON location_pings(user_id, recorded_at DESC);
CREATE INDEX idx_pings_location ON location_pings USING GIST(location);

-- ============================================================
-- RATINGS
-- ============================================================
CREATE TABLE ratings (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id       UUID NOT NULL REFERENCES jobs(id),
  reviewer_id  UUID NOT NULL REFERENCES users(id),
  reviewee_id  UUID NOT NULL REFERENCES users(id),
  score        SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, reviewer_id)
);

CREATE INDEX idx_ratings_reviewee ON ratings(reviewee_id);

-- ============================================================
-- DISPUTES
-- ============================================================
CREATE TABLE disputes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id          UUID NOT NULL REFERENCES jobs(id),
  raised_by       UUID NOT NULL REFERENCES users(id),
  status          dispute_status NOT NULL DEFAULT 'open',
  reason          TEXT NOT NULL,
  evidence_urls   TEXT[],                                 -- S3 URLs of screenshots/photos
  resolution_note TEXT,
  resolved_by     UUID REFERENCES users(id),
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- VERIFICATION AUDIT LOG (immutable append-only)
-- ============================================================
CREATE TABLE verification_audit (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id),
  action         VARCHAR(50) NOT NULL,                    -- 'upload'|'ocr_pass'|'face_match'|'human_approve'|'reject'
  actor_id       UUID,                                    -- admin or system
  metadata       JSONB,                                   -- non-PII context
  ip_address     INET,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- IMMUTABLE: no UPDATE or DELETE on this table
-- Enforce via row-level security in production

CREATE INDEX idx_audit_user ON verification_audit(user_id);

-- ============================================================
-- NOTIFICATIONS
-- ============================================================
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        VARCHAR(50) NOT NULL,
  title       VARCHAR(120),
  body        TEXT,
  data        JSONB,
  read        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notif_user_unread ON notifications(user_id, read) WHERE read = FALSE;

-- ============================================================
-- TRIGGERS: auto-update updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated    BEFORE UPDATE ON users    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_jobs_updated     BEFORE UPDATE ON jobs     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_disputes_updated BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- TRIGGER: recompute user rating after insert into ratings
-- ============================================================
CREATE OR REPLACE FUNCTION update_user_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE users
  SET
    rating = (
      SELECT ROUND(
        -- Recent jobs (last 20) weighted 2x, older weighted 1x
        SUM(score * CASE WHEN rn <= 20 THEN 2 ELSE 1 END)::NUMERIC /
        NULLIF(SUM(CASE WHEN rn <= 20 THEN 2 ELSE 1 END), 0), 2
      )
      FROM (
        SELECT score, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
        FROM ratings WHERE reviewee_id = NEW.reviewee_id
      ) sub
    ),
    rating_count = (SELECT COUNT(*) FROM ratings WHERE reviewee_id = NEW.reviewee_id)
  WHERE id = NEW.reviewee_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_rating_update
  AFTER INSERT ON ratings
  FOR EACH ROW EXECUTE FUNCTION update_user_rating();
