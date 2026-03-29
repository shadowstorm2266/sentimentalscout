-- ============================================================
-- Sentimental Scout — Supabase Schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  telegram_id      BIGINT UNIQUE NOT NULL,
  telegram_username TEXT,
  first_name       TEXT,
  last_name        TEXT,
  subscription     TEXT NOT NULL DEFAULT 'free'   -- 'free' | 'pro'
                   CHECK (subscription IN ('free', 'pro')),
  scans_today      INT  NOT NULL DEFAULT 0,
  scans_reset_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Scans ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scans (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticker           TEXT NOT NULL,
  sentiment_score  NUMERIC(5, 2),               -- –100 … +100
  sentiment_label  TEXT,                        -- 'Bullish' | 'Bearish' | 'Neutral'
  raw_payload      JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Star Payments ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS star_payments (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  telegram_charge_id TEXT UNIQUE NOT NULL,
  stars_amount     INT  NOT NULL,
  plan             TEXT NOT NULL DEFAULT 'pro',
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'completed', 'refunded')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_scans_user_id        ON scans(user_id);
CREATE INDEX IF NOT EXISTS idx_scans_ticker         ON scans(ticker);
CREATE INDEX IF NOT EXISTS idx_scans_created_at     ON scans(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_star_payments_user   ON star_payments(user_id);

-- ── Updated-at trigger ────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── Daily scan-reset helper ───────────────────────────────────
-- Call this function via a Supabase cron job daily at 00:00 UTC
CREATE OR REPLACE FUNCTION reset_daily_scans()
RETURNS void AS $$
BEGIN
  UPDATE users
  SET scans_today   = 0,
      scans_reset_at = NOW()
  WHERE scans_reset_at < NOW() - INTERVAL '24 hours';
END;
$$ LANGUAGE plpgsql;

-- ── Row-Level Security ────────────────────────────────────────
ALTER TABLE users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE scans          ENABLE ROW LEVEL SECURITY;
ALTER TABLE star_payments  ENABLE ROW LEVEL SECURITY;

-- Service-role key bypasses RLS; anon key is blocked by default.
-- Add policies below if you expose these tables to the frontend directly.
