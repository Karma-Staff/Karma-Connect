-- Karma Connect data model. Run this once in Supabase → SQL Editor → New query → Run.
-- Every table is keyed by user_id and protected by Row-Level Security so each account
-- can only ever read/write its own rows (enforced by Postgres, not the client).

-- ─────────────────────────────────────────────────────────────────────────────
-- prospects: a saved prospect snapshot (the app's "History"). `data` holds the full
-- snapshot (prospect fields, analysis, generated messages, favorites, sender, offer).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.prospects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  label       text,
  sub         text,
  data        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists prospects_user_idx on public.prospects (user_id, updated_at desc);

alter table public.prospects enable row level security;

drop policy if exists "prospects are private to their owner" on public.prospects;
create policy "prospects are private to their owner"
  on public.prospects
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- usage: per-user token/cost accounting. Rows are INSERTED server-side (Vercel proxy
-- using the service-role key, which bypasses RLS). Users may only READ their own rows.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.usage (
  id                 bigint generated always as identity primary key,
  user_id            uuid not null references auth.users (id) on delete cascade,
  ts                 timestamptz not null default now(),
  kind               text,                       -- analysis | connection | meeting | research | ...
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cost_usd           numeric(12,5) not null default 0
);

create index if not exists usage_user_idx on public.usage (user_id, ts desc);

alter table public.usage enable row level security;

drop policy if exists "users read their own usage" on public.usage;
create policy "users read their own usage"
  on public.usage
  for select
  using (auth.uid() = user_id);
-- No insert/update/delete policy for normal users: writes come from the server (service role).

-- ─────────────────────────────────────────────────────────────────────────────
-- Keep updated_at fresh on prospects.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists prospects_touch on public.prospects;
create trigger prospects_touch
  before update on public.prospects
  for each row execute function public.touch_updated_at();
