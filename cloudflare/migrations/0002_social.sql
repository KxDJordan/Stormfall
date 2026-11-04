-- Socials: public profiles with friend codes, friend links (requests, friends, blocks), short-lived offline invites.
-- Every query is a primary-key or unique-index seek (see README → Cloudflare backend → Socials).

-- The small public profile an account publishes about itself (no PII). Created on the first /api/social/me.
-- fcode is the shareable friend code (8 random Crockford base32 chars, 40 bits); it is not the account code and
-- reveals nothing about the secret. UNIQUE gives it an index: code lookups are one seek.
CREATE TABLE IF NOT EXISTS profiles (
  acct    TEXT    PRIMARY KEY,           -- accounts.id
  fcode   TEXT    NOT NULL UNIQUE,
  name    TEXT    NOT NULL,              -- callsign (A-Z 0-9 space _ -, 12 chars)
  lv      INTEGER NOT NULL DEFAULT 1,
  cls     TEXT    NOT NULL DEFAULT '',
  title   TEXT    NOT NULL DEFAULT '',   -- name plate title id (cosmetic)
  banner  TEXT    NOT NULL DEFAULT '',   -- name plate banner id (cosmetic)
  seen    INTEGER NOT NULL DEFAULT 0,    -- ms: last time the presence socket closed ("last seen")
  updated INTEGER NOT NULL
);

-- Friend links, stored in both directions so "everything about me" is one primary-key range (WHERE a = ?).
--   st: 'f' friends, 'o' a sent b a request, 'i' b sent a a request, 'b' a blocked b (b keeps no row about a)
CREATE TABLE IF NOT EXISTS links (
  a  TEXT    NOT NULL,
  b  TEXT    NOT NULL,
  st TEXT    NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (a, b)
) WITHOUT ROWID;
-- the daily cron drops requests nobody answered for 60 days
CREATE INDEX IF NOT EXISTS links_pend ON links (at) WHERE st IN ('i', 'o');

-- Room invites for friends who were not connected when they were sent. Delivered (and deleted) when the friend opens
-- the game while the room is still open; expired rows are deleted by the cron. Keyed by friend codes.
CREATE TABLE IF NOT EXISTS invites (
  to_code   TEXT    NOT NULL,
  from_code TEXT    NOT NULL,
  room      TEXT    NOT NULL,
  mode      TEXT    NOT NULL,
  name      TEXT    NOT NULL,            -- the host's callsign at the time
  exp       INTEGER NOT NULL,            -- ms
  PRIMARY KEY (to_code, from_code)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS invites_exp ON invites (exp);
CREATE INDEX IF NOT EXISTS invites_from ON invites (from_code);
