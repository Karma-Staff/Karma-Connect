-- 027: Clients — companies Karma Staff already works for, uploaded by an admin
-- (server/clients.js), and never called. A lead that is a client — the same
-- phone, the same email, or the same company name in the same state — is left
-- out of Companies / People / Job board / Recently added and every campaign,
-- the phone finder skips it, and /api/calltime refuses to dial its number.
CREATE TABLE IF NOT EXISTS clients (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company     text,
  contact     text,
  phone       text,
  phone_key   text,             -- dedupe.pk() of phone
  email       text,             -- lower-cased
  city        text,
  state       text,
  state_ab    text,             -- "FL" — leads hold both "FL" and "Florida"
  state_name  text,             -- "florida"
  name_key    text,             -- the company name reduced to letters and digits (clients.js nameKey)
  note        text,
  batch       text,             -- which upload brought it in
  added_by    text,
  added_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS clients_phone_idx ON clients (phone_key) WHERE phone_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS clients_email_idx ON clients (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS clients_name_idx  ON clients (name_key) WHERE name_key IS NOT NULL;
