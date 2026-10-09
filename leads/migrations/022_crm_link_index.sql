-- 022: index to make the "Contacted (in Zoho)" tab fast.
--
-- That tab (and the double-assign guard) asks, per lead, "does this lead have a
-- Zoho CRM record linked?" — which lives only in activity_log.meta.crm_link
-- (crm-sync.js stamps it when a Zoho Lead is created/linked). activity_log is
-- indexed on `at`/`actor`/`call_at` but NOT on lead_id, so a correlated EXISTS
-- would seq-scan it. This partial index covers exactly the rows that carry the
-- link, keyed by lead, so the lookup is a cheap index probe.
CREATE INDEX IF NOT EXISTS activity_log_crm_link_lead_idx
  ON activity_log (lead_id)
  WHERE meta ? 'crm_link';
