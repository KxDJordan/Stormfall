-- Ranked and battalions (see README -> Cloudflare backend -> Ranked & battalions).
-- Every query is a primary-key or index seek; the matchmaker itself lives in the Signal Durable Object's memory.

-- Ranked ratings: one row per account, season and mode. Written once per finished ranked match (relative update: r = r + d).
CREATE TABLE IF NOT EXISTS ratings (
  acct   TEXT    NOT NULL,
  season INTEGER NOT NULL,
  mode   TEXT    NOT NULL,              -- 'solo' | 'duos'
  r      REAL    NOT NULL,              -- Glicko-lite rating
  rd     REAL    NOT NULL,              -- rating deviation (uncertainty)
  n      INTEGER NOT NULL DEFAULT 0,    -- ranked matches this season
  w      INTEGER NOT NULL DEFAULT 0,    -- wins
  peak   REAL    NOT NULL DEFAULT 0,    -- best rating after the placement matches (0 = none yet)
  at     INTEGER NOT NULL,              -- last match (ms)
  name   TEXT    NOT NULL,              -- callsign at the last match (leaderboard)
  tag    TEXT    NOT NULL DEFAULT '',   -- battalion tag at the last match
  PRIMARY KEY (acct, season, mode)
) WITHOUT ROWID;
-- top 100 and "your position" walk this index
CREATE INDEX IF NOT EXISTS ratings_top ON ratings (season, mode, r DESC);

-- Ranked matches. Created by the matchmaker ('p'), registered by the host when the match starts ('r'), then 'd' (rated)
-- or 'v' (void: reports disagreed, ruleset broken, nobody reported). seats is the matchmaker's snapshot per seat id:
-- {sid: {a: account, r, rd, n: name, t: tag, b: battalion}}; reps collects one report per seat id (json_set).
CREATE TABLE IF NOT EXISTS rmatch (
  id      TEXT    PRIMARY KEY,
  mode    TEXT    NOT NULL,
  season  INTEGER NOT NULL,
  host    TEXT    NOT NULL,             -- seat id of the host
  created INTEGER NOT NULL,
  st      TEXT    NOT NULL,
  seats   TEXT    NOT NULL,
  parts   TEXT,                         -- JSON [sid] registered by the host, in roster order
  teams   INTEGER NOT NULL DEFAULT 0,   -- teams in the match (battalion points)
  reps    TEXT    NOT NULL DEFAULT '{}',
  rep0    INTEGER,                      -- first report (ms): the grace period runs from here
  res     TEXT                          -- JSON {sid: {p, d, r}} once rated
);
CREATE INDEX IF NOT EXISTS rmatch_created ON rmatch (created);

-- Battalions (clans). name_k is the lower-case name (unique, case-insensitive).
CREATE TABLE IF NOT EXISTS bat (
  id      TEXT    PRIMARY KEY,          -- 8 chars Crockford base32
  name    TEXT    NOT NULL,
  name_k  TEXT    NOT NULL UNIQUE,
  tag     TEXT    NOT NULL UNIQUE,      -- 3-4 upper-case letters/digits
  bn      TEXT    NOT NULL,             -- emblem background: a name plate banner id
  em      TEXT    NOT NULL,             -- emblem glyph
  descr   TEXT    NOT NULL DEFAULT '',
  open    INTEGER NOT NULL DEFAULT 1,   -- 1 = anyone may join, 0 = invite only
  n       INTEGER NOT NULL DEFAULT 1,   -- members (cap enforced by a guarded UPDATE)
  created INTEGER NOT NULL
);

-- Membership: one battalion per account. role: 'l' leader, 'o' officer, 'm' member. pts: this week's points (wk).
CREATE TABLE IF NOT EXISTS bat_mem (
  acct   TEXT    PRIMARY KEY,
  bat    TEXT    NOT NULL,
  role   TEXT    NOT NULL,
  joined INTEGER NOT NULL,
  wk     TEXT    NOT NULL DEFAULT '',
  pts    INTEGER NOT NULL DEFAULT 0,
  tot    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bat_mem_bat ON bat_mem (bat);

-- Pending invites into a battalion (7 days).
CREATE TABLE IF NOT EXISTS bat_inv (
  acct    TEXT    NOT NULL,
  bat     TEXT    NOT NULL,
  by_name TEXT    NOT NULL,
  exp     INTEGER NOT NULL,
  PRIMARY KEY (acct, bat)
) WITHOUT ROWID;

-- Weekly battalion points (week = the Monday's day key).
CREATE TABLE IF NOT EXISTS bat_wk (
  wk  TEXT    NOT NULL,
  bat TEXT    NOT NULL,
  pts INTEGER NOT NULL,
  PRIMARY KEY (wk, bat)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS bat_wk_top ON bat_wk (wk, pts DESC);

-- Battalion chat: short lines, kept 7 days (daily cron). code is the sender's friend code (reports, mute lists).
CREATE TABLE IF NOT EXISTS bat_chat (
  bat  TEXT    NOT NULL,
  at   INTEGER NOT NULL,
  code TEXT    NOT NULL,
  name TEXT    NOT NULL,
  msg  TEXT    NOT NULL,
  PRIMARY KEY (bat, at)
) WITHOUT ROWID;

-- Moderation reports (read by hand with `wrangler d1 execute`).
CREATE TABLE IF NOT EXISTS reports (
  id     INTEGER PRIMARY KEY,
  at     INTEGER NOT NULL,
  by_acct TEXT   NOT NULL,
  kind   TEXT    NOT NULL,             -- 'player' | 'bat' | 'chat'
  target TEXT    NOT NULL,             -- friend code or battalion id
  why    TEXT    NOT NULL DEFAULT '',
  ctx    TEXT    NOT NULL DEFAULT ''   -- e.g. the reported chat line
);
