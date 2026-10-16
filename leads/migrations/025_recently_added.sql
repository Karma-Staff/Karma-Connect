-- 025: "Recently added" — leads a file import has just brought in.
--
-- A lead inserted by an uploaded file is held under the Recently added tab
-- (recent_at set, recent_batch = which import) instead of going straight into
-- Companies / People / Job board. An admin moves them into their places with
-- one button (recent_at back to NULL), all at once or one import at a time.
-- Campaigns can pick them with the "Recently added" filter either way.
-- Leads that already existed before this migration are untouched (NULL).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS recent_at    timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS recent_batch text;

CREATE INDEX IF NOT EXISTS leads_recent_idx ON leads (recent_at DESC, id)
  WHERE recent_at IS NOT NULL AND deleted_at IS NULL;
