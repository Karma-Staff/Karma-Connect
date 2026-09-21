-- 007: the prospect briefing — what the "Research" button produces.
--
-- Its own table, not columns on `leads`, for three reasons. The shape is a
-- document (nested arrays of hooks, education, interests) that nothing will
-- ever filter or sort on, so it earns no columns. It is expensive — every
-- briefing is a paid web-search call — so it must be kept and re-read rather
-- than regenerated, and keeping it beside the lead row would mean loading it
-- on every list query that does SELECT *. And a lead can be researched again
-- later, at which point what the model said the first time is worth having.
--
-- One CURRENT row per lead, enforced by the partial unique index below;
-- superseded briefings keep their row with superseded_at set, so a rep can
-- see that the picture changed and when.
CREATE TABLE IF NOT EXISTS lead_research (
  id            bigserial PRIMARY KEY,
  lead_id       bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- the briefing itself: the JSON shape written by leads/server/research.js
  brief         jsonb NOT NULL,
  -- what produced it, so a briefing can be read in the light of the model
  -- that wrote it after the prompt or the model changes
  model         text NOT NULL DEFAULT '',
  -- who pressed the button; free text email like leads.owner, same reason
  actor         text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);

-- The reading pane asks "the current briefing for this lead" on every open,
-- and that must not scan. Partial, because superseded rows are history and
-- nothing looks them up by lead.
CREATE UNIQUE INDEX IF NOT EXISTS lead_research_current_idx
  ON lead_research (lead_id) WHERE superseded_at IS NULL;

-- "How much research did we buy this month, and who by" — the only other
-- question this table is asked, and the one that keeps the bill visible.
CREATE INDEX IF NOT EXISTS lead_research_actor_at_idx
  ON lead_research (actor, created_at DESC);
