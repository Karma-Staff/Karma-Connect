-- 015: 'sales_rep', a member who is on the phones.
--
-- 'member' covered everybody who is not a manager — reps, but also the people
-- who research, enrich and import. The morning call report listed all of them
-- side by side, so a researcher who is not meant to call showed up every day
-- as "no calls", and the reps the report is actually about were harder to
-- find among them.
--
-- Same rank as member: a sales rep sees exactly what a member sees. The role
-- only says whose calling the reports are about. RANK in leads/server/auth.js
-- and in leads/public/app.js carries it at 0.
ALTER TABLE organization_memberships DROP CONSTRAINT organization_memberships_role_check;
ALTER TABLE organization_memberships ADD CONSTRAINT organization_memberships_role_check
  CHECK (role IN ('owner', 'admin', 'member', 'sales_rep'));
