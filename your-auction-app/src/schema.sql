-- Admin backend schema. This does NOT store live bid state — that still
-- lives entirely in the existing Firestore document your index.html
-- already talks to. This backend only stores the CONFIGURATION an Admin
-- sets up (players, teams, purse, sounds, logins) and serves it to the
-- frontend via GET /api/config/current.

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS auctions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id        INTEGER NOT NULL,
  name            TEXT NOT NULL,
  purse_cr        REAL NOT NULL DEFAULT 120,
  squad_min       INTEGER NOT NULL DEFAULT 16,
  squad_max       INTEGER NOT NULL DEFAULT 20,
  timer_seconds   INTEGER NOT NULL DEFAULT 15,
  teams_json      TEXT NOT NULL,          -- JSON array of team code strings
  players_json    TEXT,                   -- JSON array of {Auction #, Original S.No, SET, PLAYER NAME, BASE PRICE, CAP/UNCAP} — same shape as PLAYERS_DATA
  host_password   TEXT,
  team_passwords_json TEXT,               -- JSON object { TEAMCODE: password }
  sound_bid       TEXT,                   -- filename under uploads/sounds/<id>/, or NULL
  sound_sold      TEXT,
  sound_unsold    TEXT,
  active          INTEGER NOT NULL DEFAULT 0,  -- only one auction should be active at a time
  created_at      TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (admin_id) REFERENCES admins(id)
);

CREATE INDEX IF NOT EXISTS idx_auctions_admin ON auctions(admin_id);
CREATE INDEX IF NOT EXISTS idx_auctions_active ON auctions(active);

-- Live bidding-room state (replaces the Firestore document your app used to
-- read/write). Single row: the whole app deals with exactly one live
-- auction room at a time, same as the old Firestore doc splAuction/state.
CREATE TABLE IF NOT EXISTS live_state (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL DEFAULT '{}'
);
INSERT OR IGNORE INTO live_state (id, data) VALUES (1, '{}');
