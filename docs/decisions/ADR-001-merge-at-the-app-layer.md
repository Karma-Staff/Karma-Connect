# ADR-001 — Merge the two products at the app layer, not the data layer

**Status** Accepted · **Date** 2026-09 · **Owner** repo owner

## Context

Karma Connect and Karma Leads were separate products on separate Render
services with separate databases. Two services meant two bills for one team.

## Options

1. **Full merge** — one codebase, one database, one user table.
2. **App-layer merge** — one web service mounting both, databases untouched.
3. **Leave them** — keep paying for two.

## Decision

Option 2. `leads/server/index.js` exports `mount(app, opts)`; `server.js` calls
it. Connect serves `/`, Leads serves `/leads`, one sign-in cookie covers both.
API paths are identical merged or standalone, so the Leads front end needed no
changes.

## Reason

The owner was explicit: *"i dont want to merge them fulll … i want them both in
one website"*. The saving is the second **web service**; the Leads database is
the paid one and has to stay regardless, so a data merge would have bought
nothing it did not already have.

## Tradeoffs

- Two user tables that nothing syncs — admin must be granted twice. This is the
  system's main known wart (PROJECT-MEMORY §1).
- Two design vocabularies that look like siblings rather than one product.
- Against that: no data migration, no risk to 36,619 lead rows, and it shipped.

## What would change it

The team growing past ~15 people, where granting access twice starts costing
more than the migration would.
