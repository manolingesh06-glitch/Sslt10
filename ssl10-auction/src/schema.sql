-- Auction setup backend schema. This does NOT store live bid state — that
-- still lives entirely in live_state below (the real-time bidding room).
-- This backend only stores the CONFIGURATION the Host sets up (players,
-- teams, purse, sounds, logins) and serves it to the frontend via
-- GET /api/config/current.
--
-- Single-tenant by design: there is exactly one auction config (id = 1),
-- edited in place by whoever holds the Host Setup key. There is no
-- separate admin-account system — see src/auth.js.

CREATE TABLE IF NOT EXISTS auctions (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  name            TEXT NOT NULL DEFAULT 'SSL10',
  purse_cr        REAL NOT NULL DEFAULT 120,
  squad_min       INTEGER NOT NULL DEFAULT 16,
  squad_max       INTEGER NOT NULL DEFAULT 20,
  timer_seconds   INTEGER NOT NULL DEFAULT 15,
  teams_json      TEXT NOT NULL DEFAULT '[]',   -- JSON array of team code strings
  players_json    TEXT,                   -- JSON array of {Auction #, Original S.No, SET, PLAYER NAME, BASE PRICE, CAP/UNCAP} — same shape as PLAYERS_DATA
  host_password   TEXT,
  team_passwords_json TEXT,               -- JSON object { TEAMCODE: password }
  sound_bid       TEXT,                   -- filename under uploads/sounds/, or NULL
  sound_sold      TEXT,
  sound_unsold    TEXT,
  active          INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now'))
);

-- Live bidding-room state (the real-time bidding room). Single row: the
-- whole app deals with exactly one live auction room at a time.
CREATE TABLE IF NOT EXISTS live_state (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL DEFAULT '{}'
);
INSERT OR IGNORE INTO live_state (id, data) VALUES (1, '{}');
