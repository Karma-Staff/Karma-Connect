-- 026: automatic phone lookup for Job board leads (server/phone-finder.js).
--
-- Job boards hand over a company's name, town and often its website, never a
-- phone. A sweeper now looks for one by itself: a company we already hold,
-- the company's own website, and (capped per day) a web search whose answer
-- must appear in the page it cites. These two columns are its memory:
--   phone_enrich_at      when this lead was last looked up — a lead with
--                        nothing to find is not paid for again for a while
--   phone_enrich_source  where the phone it found came from
--                        (company | donor | website | web), for the lead's
--                        own history and the Job board's progress line
-- A phone it finds only ever lands in a blank phone (the import invariant).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_enrich_at     timestamptz;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone_enrich_source text;

-- the sweeper's queue: phone-less job board leads, least recently tried first
CREATE INDEX IF NOT EXISTS leads_phone_enrich_idx ON leads (phone_enrich_at NULLS FIRST, id)
  WHERE deleted_at IS NULL AND NOT removed AND nullif(btrim(phone), '') IS NULL;
