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

const keep = new Set(['tournaments','teams','players','users','app_settings','live_state']);
sqlite.pragma('foreign_keys = OFF');
for (const row of sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
  if (!keep.has(row.name)) {
    try { sqlite.exec(`DROP TABLE IF EXISTS "${row.name.replace(/"/g, '""')}"`); }
    catch (e) { console.error(`Could not remove legacy table ${row.name}:`, e); }
  }
}
sqlite.pragma('foreign_keys = ON');

// One-time clean boot: old tournament state, teams and players must never mix
// with SSLT10. Later restarts preserve the live auction normally.
const migration = sqlite.prepare("SELECT value FROM app_settings WHERE key='sslt10_migration_version'").get();
if (!migration) {
  sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM teams').run();
    sqlite.prepare('DELETE FROM players').run();
    sqlite.prepare("DELETE FROM users WHERE role <> 'host'").run();
    sqlite.prepare("UPDATE live_state SET data='{}' WHERE id=1").run();
    sqlite.prepare("INSERT INTO app_settings (key,value) VALUES ('sslt10_migration_version','1')").run();
  })();
}

const hostUsername=(process.env.SSLT10_HOST_USERNAME||'host').trim().toLowerCase();
const hostPassword=process.env.SSLT10_HOST_PASSWORD||'host@2026';
const existingHost=sqlite.prepare("SELECT id FROM users WHERE role='host' LIMIT 1").get();
if(!existingHost){
  const hash=bcrypt.hashSync(hostPassword,Number(process.env.BCRYPT_SALT_ROUNDS||10));
  sqlite.prepare("INSERT INTO users (username,password_hash,role) VALUES (?,?, 'host')").run(hostUsername,hash);
}

const live=sqlite.prepare('SELECT data FROM live_state WHERE id=1').get();
if(!live||!live.data)sqlite.prepare("INSERT OR REPLACE INTO live_state (id,data) VALUES (1,'{}')").run();

module.exports={
  query:(sql,params=[])=>sqlite.prepare(sql).all(...params),
  get:(sql,params=[])=>sqlite.prepare(sql).get(...params),
  run:(sql,params=[])=>{const info=sqlite.prepare(sql).run(...params);return {lastInsertId:info.lastInsertRowid,changes:info.changes};},
  transaction:(fn)=>sqlite.transaction(fn)(),
};
