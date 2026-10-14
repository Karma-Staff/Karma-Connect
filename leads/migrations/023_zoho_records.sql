-- 023: a local index of what is in Zoho CRM, by phone and email.
--
-- The scan (leads/server/zoho-scan.js) reads Zoho every 10 minutes, but only
-- what CHANGED since the last read (If-Modified-Since), and keeps the numbers
-- here. Matching a Karma Connect lead to Zoho is then a join against this
-- table — new imports, uploaded campaign sheets and the campaign builder can
-- all ask "is this number in Zoho?" without spending Zoho API credits, which a
-- full re-read of every module every 10 minutes would burn through in hours.
--
-- module is the Zoho module the record came from:
--   Leads, Contacts  → the number is a Zoho Lead            (label "Zoho Lead")
--   Accounts, Calls  → the number is in Zoho's call history (label "In Zoho")
-- A Call carries the number it dialled when Zoho's telephony recorded one, and
-- otherwise the number of the record it is linked to (linked_id), resolved
-- after that record has been read.
CREATE TABLE IF NOT EXISTS zoho_records (
  module       text NOT NULL,
  zoho_id      text NOT NULL,
  phone_key    text,                 -- dedupe.pk() of Phone (or a Call's dialled number)
  phone2_key   text,                 -- dedupe.pk() of Mobile
  email        text,                 -- lower-cased
  linked_id    text,                 -- a Call's Who_Id / What_Id
  modified_at  timestamptz,          -- Zoho's Modified_Time
  seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (module, zoho_id)
);
CREATE INDEX IF NOT EXISTS zoho_records_phone_idx  ON zoho_records (phone_key)  WHERE phone_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS zoho_records_phone2_idx ON zoho_records (phone2_key) WHERE phone2_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS zoho_records_email_idx  ON zoho_records (email)      WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS zoho_records_linked_idx ON zoho_records (linked_id)  WHERE linked_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS zoho_records_id_idx     ON zoho_records (zoho_id);
