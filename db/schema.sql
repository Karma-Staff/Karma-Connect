-- Karma Connect data model for plain PostgreSQL (Render Postgres).
-- Run once: `npm run db:init` (reads DATABASE_URL and applies this file), or paste into psql.
--
-- Unlike the old Supabase schema, there is NO row-level security and NO auth.users table:
-- this is a vanilla Postgres database. Per-user isolation is enforced in the application
-- layer (server.js) — every query is scoped to the user_id taken from the verified JWT,
-- never from the client. Keep it that way.

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ─────────────────────────────────────────────────────────────────────────────
-- users: accounts created via /api/auth/signup. Passwords are bcrypt hashes.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  first_name    text not null default '',
  last_name     text not null default '',
  created_at    timestamptz not null default now()
);

-- Case-insensitive email lookups (we also store email lower-cased, but be safe).
create unique index if not exists users_email_lower_idx on users (lower(email));

-- Email verification (sent via the internal mail gateway). Added via ALTER so
-- existing tables upgrade in place.
-- When email sending isn't configured, the server creates users already-verified.
alter table users add column if not exists email_verified boolean not null default false;
alter table users add column if not exists verify_token   text;
alter table users add column if not exists verify_sent_at timestamptz;
create index if not exists users_verify_token_idx on users (verify_token);

-- Admin flag. Set at signup when the correct ADMIN_SIGNUP_CODE is supplied (a user can also
-- be made admin via the ADMIN_EMAILS config list, independent of this column).
alter table users add column if not exists is_admin boolean not null default false;

-- Password reset (sent via the internal mail gateway). Same one-time-token
-- pattern as email verification.
alter table users add column if not exists reset_token   text;
alter table users add column if not exists reset_sent_at timestamptz;
create index if not exists users_reset_token_idx on users (reset_token);

-- ─────────────────────────────────────────────────────────────────────────────
-- prospects: a saved prospect snapshot (the app's "History"). `data` holds the full
-- snapshot (prospect fields, analysis, generated messages, favorites, sender, offer).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists prospects (
  -- text (not uuid): the client supplies the id, and its offline fallback id isn't a UUID.
  id          text primary key default gen_random_uuid()::text,
  user_id     uuid not null references users (id) on delete cascade,
  label       text,
  sub         text,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Pipeline status for the lead (new | connected | replied | meeting | won | lost).
alter table prospects add column if not exists status text not null default 'new';

-- Follow-up reminder: a next-action date + an optional note (drives the Reminders view).
alter table prospects add column if not exists next_action_at   timestamptz;
alter table prospects add column if not exists next_action_note text;

create index if not exists prospects_user_idx on prospects (user_id, updated_at desc);
create index if not exists prospects_status_idx on prospects (user_id, status);
create index if not exists prospects_next_action_idx on prospects (user_id, next_action_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- usage: per-user token/cost accounting. Rows are INSERTED server-side by the proxy.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists usage (
  id                 bigint generated always as identity primary key,
  user_id            uuid not null references users (id) on delete cascade,
  ts                 timestamptz not null default now(),
  kind               text,                       -- analysis | connection | meeting | research | ...
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cost_usd           numeric(12,5) not null default 0
);

create index if not exists usage_user_idx on usage (user_id, ts desc);
create index if not exists usage_user_kind_idx on usage (user_id, kind);

-- usage_daily: pre-aggregated rollup (per user/day/kind) maintained incrementally by the
-- server. The dashboard + admin usage reads hit this small table, never the raw `usage`
-- table, so those queries stay fast no matter how many AI calls accumulate.
create table if not exists usage_daily (
  user_id           uuid not null references users (id) on delete cascade,
  day               date not null,
  kind              text not null default 'ai',
  input_tokens      bigint not null default 0,
  output_tokens     bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  cost_usd          numeric(14,5) not null default 0,
  calls             integer not null default 0,
  primary key (user_id, day, kind)
);
create index if not exists usage_daily_user_idx on usage_daily (user_id, day);

-- ─────────────────────────────────────────────────────────────────────────────
-- lead_approvals: an admin gate. Members work a lead through connection freely; to unlock
-- the Relationship / Meeting / Follow-up engines for THAT lead, an admin must approve it.
-- One row per (member, lead). Status: pending | approved | denied.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists lead_approvals (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,  -- the member who owns the lead
  prospect_id   text not null,           -- matches the client lead id (prospects.id)
  label         text,                    -- lead name, for the admin list
  sub           text,
  status        text not null default 'pending',
  requested_at  timestamptz not null default now(),
  decided_by    text,                    -- admin email
  decided_at    timestamptz,
  unique (user_id, prospect_id)
);
create index if not exists lead_approvals_status_idx on lead_approvals (status, requested_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- lead_notes: per-lead notes and activity timeline. kind = 'note' (typed by the
-- user, deletable) or 'activity' (auto-logged, e.g. a stage change; immutable).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists lead_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  prospect_id text not null,
  kind        text not null default 'note',
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists lead_notes_idx on lead_notes (user_id, prospect_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- Drip campaigns: a named, ordered sequence of outreach steps that leads are enrolled
-- into and advanced through. Execution is human-in-the-loop (a "send queue"); these
-- tables hold the orchestration and per-lead position. No LinkedIn is automated.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists campaigns (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  name       text not null,
  sender_id  text not null default '',      -- which Karma Staff sender voice (see senders.js)
  status     text not null default 'active', -- active | archived
  created_at timestamptz not null default now()
);
create index if not exists campaigns_user_idx on campaigns (user_id, created_at desc);

-- One ordered step of a campaign. message_type maps to an existing AI generator
-- (connection | relationship | inmail | meeting | followup); channel is linkedin | email.
create table if not exists campaign_steps (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references campaigns (id) on delete cascade,
  step_order   int  not null,                 -- 0-based position
  channel      text not null default 'linkedin',
  message_type text not null default 'connection',
  delay_days   int  not null default 0,       -- days to wait before this step
  unique (campaign_id, step_order)
);
create index if not exists campaign_steps_idx on campaign_steps (campaign_id, step_order);

-- One lead enrolled in one campaign. current_step points at the step due next;
-- next_step_at is when it's due. status: active | completed | stopped.
create table if not exists campaign_enrollments (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references campaigns (id) on delete cascade,
  prospect_id  text not null references prospects (id) on delete cascade,
  user_id      uuid not null references users (id) on delete cascade,
  current_step int  not null default 0,
  status       text not null default 'active',
  next_step_at timestamptz,
  enrolled_at  timestamptz not null default now(),
  last_step_at timestamptz,
  unique (campaign_id, prospect_id)
);
create index if not exists campaign_enroll_camp_idx on campaign_enrollments (campaign_id, status);
create index if not exists campaign_enroll_due_idx on campaign_enrollments (user_id, status, next_step_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- message_sends: A/B testing. One row each time a user marks a generated message as
-- sent. Joined back to the prospect's pipeline status to compute reply/meeting rates
-- per message angle and per sender — so the winning angles surface over time.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists message_sends (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  prospect_id text references prospects (id) on delete set null,
  kind        text not null,                    -- connection | relationship | inmail | meeting | followup
  angle       text not null default '',         -- the message's angle label (the A/B variant)
  sender_id   text not null default '',         -- which sender voice was used
  message     text not null default '',         -- the actual sent text (so the coach can learn wording)
  personalization int,                          -- the message's self-scores at send time
  acceptance  int,
  created_at  timestamptz not null default now()
);
create index if not exists message_sends_user_idx on message_sends (user_id, created_at desc);
create index if not exists message_sends_prospect_idx on message_sends (prospect_id);

-- coach_playbook: distilled "what works" guidance per message kind, learned from the account's
-- own results (winners vs the rest) and injected into future generation. One row per (user, kind).
create table if not exists coach_playbook (
  user_id     uuid not null references users (id) on delete cascade,
  kind        text not null,
  playbook    text not null default '',
  sample_size int  not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (user_id, kind)
);

-- coach_changes: append-only log of every playbook update (automatic or manual), with the
-- before/after text, so the user can see exactly what the coach changed to their messaging.
create table if not exists coach_changes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,
  kind          text not null,
  source        text not null default 'auto',   -- auto | manual
  prev_playbook text not null default '',
  playbook      text not null default '',
  sample_size   int  not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists coach_changes_idx on coach_changes (user_id, created_at desc);

-- Keep updated_at fresh on prospects.
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists prospects_touch on prospects;
create trigger prospects_touch
  before update on prospects
  for each row execute function touch_updated_at();
