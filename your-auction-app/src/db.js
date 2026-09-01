require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');

const dbPath = process.env.SQLITE_PATH || './data/sslt10.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Structural migration: keep only the clean SSLT10 tables. This removes any
// legacy SPL/Admin tables and their old data instead of carrying it forward.
const keep = new Set(['tournaments', 'teams', 'players', 'users', 'live_state']);
sqlite.pragma('foreign_keys = OFF');
for (const row of sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
  if (!keep.has(row.name)) {
    try { sqlite.exec(`DROP TABLE IF EXISTS "${row.name.replace(/"/g, '""')}"`); }
    catch (e) { console.error(`Could not remove legacy table ${row.name}:`, e); }
  }
}
sqlite.pragma('foreign_keys = ON');

const hostUsername = (process.env.SSLT10_HOST_USERNAME || 'host').trim().toLowerCase();
const hostPassword = process.env.SSLT10_HOST_PASSWORD || 'host@2026';
const existingHost = sqlite.prepare("SELECT id FROM users WHERE role='host' LIMIT 1").get();
if (!existingHost) {
  const hash = bcrypt.hashSync(hostPassword, Number(process.env.BCRYPT_SALT_ROUNDS || 10));
  sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES (?,?, 'host')").run(hostUsername, hash);
}

const live = sqlite.prepare('SELECT data FROM live_state WHERE id = 1').get();
if (!live || !live.data) sqlite.prepare("INSERT OR REPLACE INTO live_state (id, data) VALUES (1, '{}')").run();

module.exports = {
  query: (sql, params = []) => sqlite.prepare(sql).all(...params),
  get: (sql, params = []) => sqlite.prepare(sql).get(...params),
  run: (sql, params = []) => {
    const info = sqlite.prepare(sql).run(...params);
    return { lastInsertId: info.lastInsertRowid, changes: info.changes };
  },
  transaction: (fn) => sqlite.transaction(fn)(),
};
