-- 018: caller reputation — what is known about each outbound number, and
-- every attempt to get a wrong spam label removed.
--
-- TWO DIFFERENT QUESTIONS, KEPT APART ON PURPOSE.
--   "Is this number flagged?" — only a carrier or caller-ID analytics
--   provider can answer, and only when we have an authorised feed from one.
--   Without one the answer is UNKNOWN, never "not flagged".
--   "How risky does our own calling look?" — Karma Connect's own score from
--   the call log. It is labelled as ours and is never presented as a carrier
--   spam score.
-- Each provider's answer is its own row (provider column), so the two can
-- never be blended into one number by accident.
--
-- One row per provider per check per number: the latest row is the current
-- status, the rest are the history the trend chart is drawn from.

CREATE TABLE IF NOT EXISTS number_reputation (
  id              bigserial PRIMARY KEY,
  phone_number    text NOT NULL,            -- E.164
  rc_number_id    text,                     -- RingCentral's id for it, when known
  provider        text NOT NULL,            -- ringcentral | carrier | caller_identity | internal
  -- verified providers: good | at_risk | potentially_flagged | flagged | unknown
  -- internal: low | moderate | high | critical
  provider_status text NOT NULL,
  spam_flag       boolean,                  -- NULL = not known; never defaulted to false
  risk_score      int CHECK (risk_score BETWEEN 0 AND 100),   -- internal only
  confidence      numeric(4, 3),
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  error           text,
  requested_by    text NOT NULL DEFAULT 'system'   -- who pressed Check now, or "system"
);
CREATE INDEX IF NOT EXISTS number_reputation_latest_idx
  ON number_reputation (phone_number, provider, checked_at DESC);
CREATE INDEX IF NOT EXISTS number_reputation_checked_idx
  ON number_reputation (checked_at DESC);

-- A request to have a wrong spam label reviewed. The providers take these
-- through their own forms (none has an API for it), so this tracks what was
-- sent where and what came back.
CREATE TABLE IF NOT EXISTS reputation_reviews (
  id            bigserial PRIMARY KEY,
  phone_number  text NOT NULL,
  provider      text NOT NULL,
  reason        text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'submitted'
                CHECK (status IN ('submitted', 'under_review', 'resolved', 'rejected')),
  notes         text NOT NULL DEFAULT '',
  submitted_by  text NOT NULL,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);
CREATE INDEX IF NOT EXISTS reputation_reviews_number_idx
  ON reputation_reviews (phone_number, submitted_at DESC);
