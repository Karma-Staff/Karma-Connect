-- 020: a sales rep's designated manager — who covers their calls.
--
-- The need: inbound calls ring the rep, but a rep often does not pick up, so
-- the manager is meant to take it. RingCentral is what actually rings a
-- phone (a call queue, or simultaneous ring on the rep's extension, delivers
-- the call to the manager too); this column does not route anything on its
-- own. What it records is the designation — who covers whom — so Karma
-- Connect can show a manager which ringing calls are theirs to pick up on the
-- Live board, and so reports can be read per manager rather than per rep.
--
-- Nullable: most people have no manager set (owners, admins, researchers),
-- and a rep with none simply has nobody flagged to cover them. ON DELETE SET
-- NULL is the backstop for a hard delete; the app's own account-deletion
-- (migration 019) is a soft delete, so users.js clears this column by hand in
-- the same transaction.

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS manager_id bigint REFERENCES app_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS app_users_manager_id_idx ON app_users(manager_id);
