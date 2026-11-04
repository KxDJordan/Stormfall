-- Stormfall cloud backend schema (D1 / SQLite).
-- Every query the Worker runs is answered from a primary key or the daily_rank index (no table scans).

-- Anonymous accounts. The secret never reaches the database: only its SHA-256 (hex) is stored.
-- The cloud save lives in the same row, so a pull or a push touches exactly one row.
CREATE TABLE IF NOT EXISTS accounts (
  id      TEXT    PRIMARY KEY,          -- 10 chars, Crockford base32 (public half of the account code)
  sh      TEXT    NOT NULL,             -- sha256(secret), hex
  created INTEGER NOT NULL,             -- ms since epoch
  rev     INTEGER NOT NULL DEFAULT 0,   -- save revision, +1 on every accepted push (0 = no save yet)
  save    TEXT,                         -- the save code (bkPack format: 'SFS1.' + base64(deflate(json)))
  save_at INTEGER                       -- ms since epoch of the last accepted push
);

-- Daily challenge scores: one row per account per UTC day (the first submission wins).
CREATE TABLE IF NOT EXISTS daily (
  day    TEXT    NOT NULL,              -- 'YYYY-MM-DD' (UTC)
  acct   TEXT    NOT NULL,
  score  INTEGER NOT NULL,              -- recomputed by the server from the parts below
  at     INTEGER NOT NULL,              -- submit time (ms); tie-break: earlier is better
  name   TEXT    NOT NULL,
  cls    TEXT    NOT NULL,
  place  INTEGER NOT NULL,
  kills  INTEGER NOT NULL,
  dmg    INTEGER NOT NULL,
  rounds INTEGER NOT NULL,
  win    INTEGER NOT NULL,
  PRIMARY KEY (day, acct)
);
-- top-N and rank queries for a day walk this index in order
CREATE INDEX IF NOT EXISTS daily_rank ON daily (day, score DESC, at);

-- players per day, kept as a counter so the leaderboard never has to COUNT(*) a whole day
CREATE TABLE IF NOT EXISTS daily_count (
  day TEXT    PRIMARY KEY,
  n   INTEGER NOT NULL
);
