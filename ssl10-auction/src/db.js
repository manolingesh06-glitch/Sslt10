require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.SQLITE_PATH || './data/admin.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

module.exports = {
  query: (sql, params = []) => sqlite.prepare(sql).all(...params),
  get: (sql, params = []) => sqlite.prepare(sql).get(...params),
  run: (sql, params = []) => {
    const info = sqlite.prepare(sql).run(...params);
    return { lastInsertId: info.lastInsertRowid, changes: info.changes };
  },
};
