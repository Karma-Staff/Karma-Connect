-- 006: a third role above admin.
--
-- 'admin' had grown to mean two different things: running the sales floor
-- (assigning work, importing, reading the team's numbers) and holding the
-- keys (appointing other admins, deleting accounts, purging the bin). The
-- first is a manager's job and should be handed out freely; the second is
-- the owner's and should not. One role could not say both.
--
-- Ranked, not a set of flags: owner > admin > member. Every admin gate is a
-- "rank at least admin" test, so an owner keeps every manager screen without
-- a second membership row, and nothing has to enumerate which roles pass.
--
-- The ladder is duplicated in leads/server/auth.js (RANK) and, for Karma
-- Connect's own users table, in server/auth.cjs. Change one, change all
-- three. There is no shared table to put it in: the two products keep
-- separate user rows on purpose, and merging them is a different job.
ALTER TABLE organization_memberships DROP CONSTRAINT organization_memberships_role_check;
ALTER TABLE organization_memberships ADD CONSTRAINT organization_memberships_role_check
  CHECK (role IN ('owner', 'admin', 'member'));

-- No row is promoted here. The owner tier is bootstrapped from OWNER_EMAILS
-- (defaulting to tenzinwoesel@karmastaff.com) so it survives a database that
-- says otherwise and cannot be granted from inside the app — see auth.js.
-- Storing it as well only keeps the team list honest about who holds it.
