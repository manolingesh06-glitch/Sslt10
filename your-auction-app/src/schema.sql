PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'SSLT10',
  purse_cr REAL NOT NULL DEFAULT 120,
  squad_min INTEGER NOT NULL DEFAULT 16,
  squad_max INTEGER NOT NULL DEFAULT 20,
  timer_seconds INTEGER NOT NULL DEFAULT 15,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO tournaments (id, name) VALUES (1, 'SSLT10');

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL UNIQUE,
  owner_name TEXT,
  logo_url TEXT,
  budget_cr REAL NOT NULL DEFAULT 120,
  max_squad_size INTEGER NOT NULL DEFAULT 20,
  min_squad_size INTEGER NOT NULL DEFAULT 16,
  max_overseas INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_teams_order ON teams(sort_order, id);

CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  role TEXT,
  base_price_cr REAL NOT NULL,
  nationality TEXT,
  local_overseas TEXT,
  batting_style TEXT,
  bowling_style TEXT,
  photo_url TEXT,
  auction_order INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_players_order ON players(auction_order, id);
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('host','owner','analyst')),
  team_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_team ON users(team_id) WHERE role='owner' AND team_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Small control/meta state only. Auction results, bids and chat are normalized below.
CREATE TABLE IF NOT EXISTS live_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data TEXT NOT NULL DEFAULT '{}'
);
INSERT OR IGNORE INTO live_state (id, data) VALUES (1, '{}');

CREATE TABLE IF NOT EXISTS live_auction_state (
  player_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('sold','unsold')),
  team TEXT,
  price_cr REAL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_auction_status ON live_auction_state(status);

CREATE TABLE IF NOT EXISTS live_bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_key TEXT NOT NULL,
  seq INTEGER NOT NULL,
  team TEXT NOT NULL,
  price_cr REAL NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(player_key, seq)
);
CREATE INDEX IF NOT EXISTS idx_live_bids_player ON live_bids(player_key, seq);

CREATE TABLE IF NOT EXISTS live_passes (
  player_key TEXT NOT NULL,
  team TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(player_key, team)
);

CREATE TABLE IF NOT EXISTS live_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_chat_ts ON live_chat(ts DESC);
