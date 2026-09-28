# ADR-002 — The owner tier lives in an environment variable, not the database

**Status** Accepted · **Date** 2026-09 · **Owner** repo owner

## Context

`admin` had grown to mean two unrelated things: running the sales floor
(assigning, importing, reading the team's numbers) and holding the keys
(appointing other admins, deleting accounts, purging the bin). One role could
not say both, and any admin could mint admins — so one compromised manager
account could lock the real owner out.

## Options

1. A third role stored in `organization_memberships.role` like the others.
2. A third role in an environment variable (`OWNER_EMAILS`).
3. Both: stored, but the environment wins.

## Decision

Option 3. `OWNER_EMAILS` is authoritative; a stored `'owner'` row is honoured
so the team list agrees with the session, but the environment overrides it.
Defaults to `tenzinwoesel@karmastaff.com` when unset.

## Reason

The top tier must survive a database that says otherwise — a bad UPDATE, a
restored backup, someone with SQL access — and must not be grantable from
inside the app, or it is just another admin. An environment list is the
smallest thing with both properties.

Defaulted rather than left empty: an unset variable quietly meaning "nobody
owns this" is how the previous identity provider became unadministrable.

## Tradeoffs

- Handing over ownership needs a deploy, not a click. Intended.
- Demoting a listed owner in the UI changes the row and nothing else — so the
  API returns a warning saying exactly that.

## Related

Replaced `ADMIN_SIGNUP_CODE`, a single shared string that turned whoever typed
it into an admin, could not be revoked for one person, and logged nothing.
