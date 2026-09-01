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

// SSLT10 is a fresh Host-managed platform. Remove the legacy Admin/SPL
// configuration tables so old tournament configuration cannot leak back in.
try { sqlite.exec('DROP TABLE IF EXISTS auctions; DROP TABLE IF EXISTS admins;'); }
catch (e) { console.error('Legacy table cleanup failed:', e); }

const hostUsername = (process.env.SSLT10_HOST_USERNAME || 'host').trim().toLowerCase();
const hostPassword = process.env.SSLT10_HOST_PASSWORD || 'host@2026';
const existingHost = sqlite.prepare("SELECT id FROM users WHERE role='host' LIMIT 1").get();
if (!existingHost) {
  const hash = bcrypt.hashSync(hostPassword, Number(process.env.BCRYPT_SALT_ROUNDS || 10));
  sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES (?,?, 'host')").run(hostUsername, hash);
}

const live = sqlite.prepare('SELECT data FROM live_state WHERE id = 1').get();
if (!live || !live.data) {
  sqlite.prepare("INSERT OR REPLACE INTO live_state (id, data) VALUES (1, '{}')").run();
}

module.exports = {
  query: (sql, params = []) => sqlite.prepare(sql).all(...params),
  get: (sql, params = []) => sqlite.prepare(sql).get(...params),
  run: (sql, params = []) => {
    const info = sqlite.prepare(sql).run(...params);
    return { lastInsertId: info.lastInsertRowid, changes: info.changes };
  },
  transaction: (fn) => sqlite.transaction(fn)(),
};
