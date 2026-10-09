-- 021: leads uploaded straight into a campaign from a spreadsheet.
--
-- A manager drops an Excel/CSV of people to call into a campaign. These are a
-- quick, self-contained call list — not CRM records — so they live here rather
-- than in `leads`, deliberately separate from the main base (the owner asked
-- for that). A campaign is still a `call_sessions` row; an UPLOADED campaign is
-- marked filters.source = 'upload' and draws its call list from this table
-- instead of from `call_sessions.lead_ids`.
--
-- Two things ride along from the sheet to the rep's dialer: whatever free-text
-- note the sheet carried (`note`), and a one-line AI summary of it
-- (`note_summary`, filled in the background after upload). The outcome of each
-- call is written back here, and the whole list — notes, summaries, outcomes —
-- exports back out to CSV.
CREATE TABLE IF NOT EXISTS campaign_leads (
  id           bigserial PRIMARY KEY,
  session_id   bigint NOT NULL REFERENCES call_sessions (id) ON DELETE CASCADE,
  pos          integer NOT NULL DEFAULT 0,       -- order within the sheet
  name         text,
  company      text,
  phone        text NOT NULL,
  phone_key    text,                             -- normalised, for dedupe/search
  email        text,
  city         text,
  state        text,
  note         text,                             -- the sheet's free-text note
  note_summary text,                             -- AI one-liner (filled async)
  raw          jsonb,                            -- the original row, for export
  status       text NOT NULL DEFAULT 'pending',  -- pending | done
  outcome      text,                             -- connected | no-answer | busy | voicemail | skip
  outcome_note text,                             -- what the rep typed on the call
  called_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- the queue read on every serve: the next pending row for a session, in order
CREATE INDEX IF NOT EXISTS campaign_leads_queue_idx
  ON campaign_leads (session_id, status, pos, id);
