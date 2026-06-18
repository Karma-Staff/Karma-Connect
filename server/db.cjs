// Data-access layer: the Postgres pool, the q() helper, the idempotent boot migration,
// and the usage-rollup write. Reads DB env at load, so require this AFTER the .env loader.
const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL || "";
// Render Postgres requires SSL; local Postgres usually doesn't (set PGSSL=off).
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSL === "off" ? false : { rejectUnauthorized: false },
      max: parseInt(process.env.PG_POOL_MAX || "10", 10), // bound per-instance connections
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      keepAlive: true,
    })
  : null;
// A dropped idle connection emits 'error' on the pool — handle it so it can't crash the process.
if (pool) pool.on("error", (e) => console.error("pg pool error:", e.message));
const dbOn = !!pool;

async function q(text, params) {
  if (!dbOn) throw new Error("Database not configured (DATABASE_URL missing).");
  return pool.query(text, params);
}

// Apply newer idempotent columns/tables at boot so the live DB stays current without a
// manual `npm run db:init` after each deploy. Safe to run every start.
async function ensureSchema() {
  if (!dbOn) return;
  try {
    await q("alter table users add column if not exists reset_token text");
    await q("alter table users add column if not exists reset_sent_at timestamptz");
    await q("create index if not exists users_reset_token_idx on users (reset_token)");
    await q("alter table prospects add column if not exists status text not null default 'new'");
    await q("alter table prospects add column if not exists next_action_at timestamptz");
    await q("alter table prospects add column if not exists next_action_note text");
    await q(`create table if not exists lead_notes (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users (id) on delete cascade,
      prospect_id text not null, kind text not null default 'note',
      body text not null, created_at timestamptz not null default now())`);
    await q("create index if not exists lead_notes_idx on lead_notes (user_id, prospect_id, created_at desc)");
    await q("create index if not exists prospects_status_idx on prospects (user_id, status)");
    await q("create index if not exists prospects_next_action_idx on prospects (user_id, next_action_at)");
    await q("create index if not exists usage_user_kind_idx on usage (user_id, kind)");
    await q(`create table if not exists usage_daily (
      user_id uuid not null references users (id) on delete cascade,
      day date not null,
      kind text not null default 'ai',
      input_tokens bigint not null default 0,
      output_tokens bigint not null default 0,
      cache_read_tokens bigint not null default 0,
      cost_usd numeric(14,5) not null default 0,
      calls integer not null default 0,
      primary key (user_id, day, kind))`);
    await q("create index if not exists usage_daily_user_idx on usage_daily (user_id, day)");
    await q(`insert into usage_daily (user_id, day, kind, input_tokens, output_tokens, cache_read_tokens, cost_usd, calls)
      select user_id, ts::date, coalesce(kind,'ai'),
             sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cost_usd), count(*)
        from usage where not exists (select 1 from usage_daily)
       group by user_id, ts::date, coalesce(kind,'ai')
      on conflict (user_id, day, kind) do nothing`);
  } catch (e) { console.error("ensureSchema:", e.message); }
}

// Persist one usage row (called by the proxy after a successful Anthropic call) and roll it
// up incrementally into usage_daily so reads never scan the raw table.
async function writeUsageRow(row) {
  if (!dbOn) return;
  const k = row.kind || "ai";
  await q(
    "insert into usage (user_id, kind, input_tokens, output_tokens, cache_read_tokens, cost_usd) values ($1,$2,$3,$4,$5,$6)",
    [row.user_id, k, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cost_usd],
  );
  await q(
    `insert into usage_daily (user_id, day, kind, input_tokens, output_tokens, cache_read_tokens, cost_usd, calls)
     values ($1, current_date, $2, $3, $4, $5, $6, 1)
     on conflict (user_id, day, kind) do update set
       input_tokens = usage_daily.input_tokens + excluded.input_tokens,
       output_tokens = usage_daily.output_tokens + excluded.output_tokens,
       cache_read_tokens = usage_daily.cache_read_tokens + excluded.cache_read_tokens,
       cost_usd = usage_daily.cost_usd + excluded.cost_usd,
       calls = usage_daily.calls + 1`,
    [row.user_id, k, row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cost_usd],
  ).catch((e) => console.error("usage_daily rollup:", e.message));
}

module.exports = { pool, dbOn, q, ensureSchema, writeUsageRow };
