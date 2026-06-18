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

-- Email verification (Resend). Added via ALTER so existing tables upgrade in place.
-- When email sending isn't configured, the server creates users already-verified.
alter table users add column if not exists email_verified boolean not null default false;
alter table users add column if not exists verify_token   text;
alter table users add column if not exists verify_sent_at timestamptz;
create index if not exists users_verify_token_idx on users (verify_token);

-- Admin flag. Set at signup when the correct ADMIN_SIGNUP_CODE is supplied (a user can also
-- be made admin via the ADMIN_EMAILS config list, independent of this column).
alter table users add column if not exists is_admin boolean not null default false;

-- Password reset (Resend). Same one-time-token pattern as email verification.
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

create index if not exists prospects_user_idx on prospects (user_id, updated_at desc);

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
