-- 008: "Follow back" — a reminder on a lead that emails the rep when it falls due.
--
-- Its own table rather than a next_action_at column on `leads`, because a
-- reminder has a lifecycle the lead does not: it comes due, an email goes,
-- the rep marks it done or lets it lapse, and each of those is a separate
-- moment somebody will ask about. A column can hold a date; it cannot say
-- whether the email was sent, which is the question that matters when a rep
-- says they never got one.
--
-- sent_at is the whole reason this is a table. The sweeper claims rows by
-- setting it, so a restart, a second instance, or a slow mail gateway can
-- never send the same reminder twice.
CREATE TABLE IF NOT EXISTS lead_followups (
  id           bigserial PRIMARY KEY,
  lead_id      bigint NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- who gets the email. Free-text email like leads.owner, matched the same
  -- way, because a reminder belongs to a person and not to an account row
  -- that may not exist yet.
  owner        text NOT NULL,
  due_at       timestamptz NOT NULL,
  note         text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text NOT NULL DEFAULT '',
  -- set the instant the sweeper claims the row, before the send is attempted
  sent_at      timestamptz,
  -- the rep ticked it off; distinct from cancelled, which means "never mind"
  done_at      timestamptz,
  cancelled_at timestamptz
);

-- One open reminder per lead. A "follow back" button that silently stacked
-- three reminders would send three emails on three mornings, and nobody
-- asked for that — setting a new one replaces the old.
CREATE UNIQUE INDEX IF NOT EXISTS lead_followups_open_idx
  ON lead_followups (lead_id)
  WHERE sent_at IS NULL AND done_at IS NULL AND cancelled_at IS NULL;

-- The sweeper's query, once a minute, forever: "what is due and unsent".
-- Partial so it stays the size of the outstanding queue rather than growing
-- with every reminder ever set.
CREATE INDEX IF NOT EXISTS lead_followups_due_idx
  ON lead_followups (due_at)
  WHERE sent_at IS NULL AND cancelled_at IS NULL;

-- "What have I got coming up", per rep — the My tasks card and the list.
CREATE INDEX IF NOT EXISTS lead_followups_owner_due_idx
  ON lead_followups (owner, due_at DESC);
