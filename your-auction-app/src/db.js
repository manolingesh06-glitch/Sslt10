require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');

const dbPath = process.env.SQLITE_PATH || './data/sslt10.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');
sqlite.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

const keep=new Set(['tournaments','teams','players','users','app_settings','live_state','live_auction_state','live_bids','live_passes','live_chat']);
sqlite.pragma('foreign_keys = OFF');
for(const row of sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()){
  if(!keep.has(row.name)){try{sqlite.exec(`DROP TABLE IF EXISTS "${row.name.replace(/"/g,'""')}"`);}catch(e){console.error(`Could not remove legacy table ${row.name}:`,e);}}
}
sqlite.pragma('foreign_keys = ON');

const migration=sqlite.prepare("SELECT value FROM app_settings WHERE key='sslt10_migration_version'").get();
if(!migration){
  sqlite.transaction(()=>{
    sqlite.prepare('DELETE FROM teams').run();sqlite.prepare('DELETE FROM players').run();sqlite.prepare("DELETE FROM users WHERE role <> 'host'").run();sqlite.prepare("UPDATE live_state SET data='{}' WHERE id=1").run();sqlite.prepare('DELETE FROM live_auction_state').run();sqlite.prepare('DELETE FROM live_bids').run();sqlite.prepare('DELETE FROM live_passes').run();sqlite.prepare('DELETE FROM live_chat').run();sqlite.prepare("INSERT INTO app_settings (key,value) VALUES ('sslt10_migration_version','2')").run();
  })();
}else if(String(migration.value)!=='2'){
  // v1 stored the whole live auction inside live_state.data. Convert it once.
  const row=sqlite.prepare('SELECT data FROM live_state WHERE id=1').get();let old={};
  try{old=JSON.parse(row?.data||'{}');}catch{old={};}
  sqlite.transaction(()=>{
    const now=Date.now();
    for(const [key,s] of Object.entries(old.auctionState||{}))if(s&&(s.status==='sold'||s.status==='unsold'))sqlite.prepare(`INSERT OR REPLACE INTO live_auction_state(player_key,status,team,price_cr,updated_at) VALUES(?,?,?,?,?)`).run(String(key),s.status,s.team||null,s.priceCr==null?null:Number(s.priceCr),now);
    for(const [key,list] of Object.entries(old.bidHistory||{}))if(Array.isArray(list))list.forEach((b,i)=>{if(b?.team&&Number.isFinite(Number(b.priceCr)))sqlite.prepare('INSERT OR IGNORE INTO live_bids(player_key,seq,team,price_cr,created_at) VALUES(?,?,?,?,?)').run(String(key),i+1,b.team,Number(b.priceCr),Number(b.ts)||now);});
    for(const [key,list] of Object.entries(old.passedTeams||{}))if(Array.isArray(list))list.forEach(team=>sqlite.prepare('INSERT OR IGNORE INTO live_passes(player_key,team,created_at) VALUES(?,?,?)').run(String(key),String(team),now));
    if(Array.isArray(old.chatMessages))old.chatMessages.slice(-200).forEach(m=>{if(m?.sender&&m?.text)sqlite.prepare('INSERT INTO live_chat(sender,role,text,ts) VALUES(?,?,?,?)').run(String(m.sender),String(m.role||''),String(m.text),Number(m.ts)||now);});
    const meta={};for(const k of ['currentIdx','currentBid','timerEndAt','paused','autoAdvance','auctionStarted','_clockSyncTs','lastResolvedKey','lastResolvedIdx','presence','sessionLocks'])if(old[k]!==undefined)meta[k]=old[k];
    sqlite.prepare('UPDATE live_state SET data=? WHERE id=1').run(JSON.stringify(meta));
    sqlite.prepare("UPDATE app_settings SET value='2',updated_at=datetime('now') WHERE key='sslt10_migration_version'").run();
  })();
}

const hostUsername=(process.env.SSLT10_HOST_USERNAME||'host').trim().toLowerCase();
const hostPassword=process.env.SSLT10_HOST_PASSWORD||'host@2026';
const existingHost=sqlite.prepare("SELECT id FROM users WHERE role='host' LIMIT 1").get();
if(!existingHost){const hash=bcrypt.hashSync(hostPassword,Number(process.env.BCRYPT_SALT_ROUNDS||12));sqlite.prepare("INSERT INTO users (username,password_hash,role) VALUES (?,?, 'host')").run(hostUsername,hash);}
const live=sqlite.prepare('SELECT data FROM live_state WHERE id=1').get();if(!live||!live.data)sqlite.prepare("INSERT OR REPLACE INTO live_state (id,data) VALUES (1,'{}')").run();

module.exports={query:(sql,params=[])=>sqlite.prepare(sql).all(...params),get:(sql,params=[])=>sqlite.prepare(sql).get(...params),run:(sql,params=[])=>{const info=sqlite.prepare(sql).run(...params);return{lastInsertId:info.lastInsertRowid,changes:info.changes};},transaction:(fn)=>sqlite.transaction(fn)()};
