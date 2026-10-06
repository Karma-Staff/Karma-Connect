-- 019: deleting an account from Manage team.
--
-- A deleted account is not a removed row. Anyone with a company-domain
-- address is enrolled again on their next sign-in (auth.js autoInvite) unless
-- a row with their email already exists — so the row stays, disabled, as the
-- thing that keeps them out, and deleted_at takes it off the team list.
-- History keeps its links for the same reason: activity_log and
-- lead_comments still point at the row. Adding the email again from Manage
-- team clears deleted_at and brings the account back.

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
