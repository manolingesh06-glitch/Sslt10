const db=require('./db');
function plain(v){return v&&typeof v==='object'&&!Array.isArray(v);}
function del(v){return plain(v)&&v.__op==='delete';}
function serverTs(v){return plain(v)&&v.__op==='serverTimestamp';}
function clone(v){if(Array.isArray(v))return v.map(clone);if(plain(v)){const o={};for(const k of Object.keys(v))o[k]=clone(v[k]);return o;}return v;}
function readMeta(){const row=db.get('SELECT data FROM live_state WHERE id=1');try{return row?JSON.parse(row.data||'{}'):{};}catch{return {};}}
function loadState(){
 const doc=readMeta();doc.auctionState={};
 for(const r of db.query('SELECT player_key,status,team,price_cr FROM live_auction_state'))doc.auctionState[String(r.player_key)]={status:r.status,team:r.team||undefined,priceCr:r.price_cr==null?undefined:Number(r.price_cr)};
 doc.bidHistory={};for(const r of db.query('SELECT player_key,seq,team,price_cr,created_at FROM live_bids ORDER BY player_key,seq')){const k=String(r.player_key);(doc.bidHistory[k]||=[]).push({team:r.team,priceCr:Number(r.price_cr),ts:r.created_at});}
 doc.passedTeams={};for(const r of db.query('SELECT player_key,team FROM live_passes ORDER BY player_key,created_at')){const k=String(r.player_key);(doc.passedTeams[k]||=[]).push(r.team);}
 doc.chatMessages=db.query('SELECT sender,role,text,ts FROM live_chat ORDER BY id DESC LIMIT 200').reverse();return doc;
}
let doc=loadState();
function setMeta(meta){db.run('UPDATE live_state SET data=? WHERE id=1',[JSON.stringify(meta)]);}
function setPath(target,path,value){const parts=String(path).split('.');let cur=target;for(let i=0;i<parts.length-1;i++){const p=parts[i];if(!plain(cur[p]))cur[p]={};cur=cur[p];}const last=parts[parts.length-1];if(del(value))delete cur[last];else if(serverTs(value))cur[last]={__ts:Date.now()};else cur[last]=clone(value);}
function mergeInto(target,source){for(const rawKey of Object.keys(source||{})){const value=source[rawKey];if(rawKey.includes('.'))setPath(target,rawKey,value);else if(del(value))delete target[rawKey];else if(serverTs(value))target[rawKey]={__ts:Date.now()};else if(plain(value)){if(!plain(target[rawKey]))target[rawKey]={};mergeInto(target[rawKey],value);}else target[rawKey]=clone(value);}}
function persistAuctionStateValue(key,value,now){if(del(value)){db.run('DELETE FROM live_auction_state WHERE player_key=?',[String(key)]);return;}if(!plain(value)||!['sold','unsold'].includes(value.status))return;db.run(`INSERT INTO live_auction_state(player_key,status,team,price_cr,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(player_key) DO UPDATE SET status=excluded.status,team=excluded.team,price_cr=excluded.price_cr,updated_at=excluded.updated_at`,[String(key),value.status,value.team||null,value.priceCr==null?null:Number(value.priceCr),now]);}
function persistBidHistoryKey(key,list,now){if(del(list)){db.run('DELETE FROM live_bids WHERE player_key=?',[String(key)]);return;}if(!Array.isArray(list))return;const k=String(key);const existing=Number(db.get('SELECT COALESCE(MAX(seq),0) n FROM live_bids WHERE player_key=?',[k]).n)||0;for(let i=existing;i<list.length;i++){const b=list[i];if(!b||!b.team||!Number.isFinite(Number(b.priceCr)))continue;db.run('INSERT OR IGNORE INTO live_bids(player_key,seq,team,price_cr,created_at) VALUES(?,?,?,?,?)',[k,i+1,b.team,Number(b.priceCr),Number(b.ts)||now]);}}
function persistPasses(value,now){if(!plain(value))return;for(const [key,list] of Object.entries(value)){if(del(list)){db.run('DELETE FROM live_passes WHERE player_key=?',[key]);continue;}if(!Array.isArray(list))continue;const existing=new Set(db.query('SELECT team FROM live_passes WHERE player_key=?',[key]).map(r=>r.team));for(const team of list)if(!existing.has(team))db.run('INSERT OR IGNORE INTO live_passes(player_key,team,created_at) VALUES(?,?,?)',[key,team,now]);}}
function persistChat(value,now){if(!Array.isArray(value))return;for(const m of value.slice(-50)){if(!m||!m.text||!m.sender)continue;const found=db.get('SELECT id FROM live_chat WHERE sender=? AND text=? AND ts=? LIMIT 1',[String(m.sender),String(m.text),Number(m.ts)||now]);if(!found)db.run('INSERT INTO live_chat(sender,role,text,ts) VALUES(?,?,?,?)',[String(m.sender),String(m.role||''),String(m.text),Number(m.ts)||now]);}db.run('DELETE FROM live_chat WHERE id NOT IN (SELECT id FROM live_chat ORDER BY id DESC LIMIT 200)');}
function persistUpdates(updates,now){
 const meta=readMeta();const metaKeys=new Set(['currentIdx','currentBid','timerEndAt','paused','autoAdvance','auctionStarted','_clockSyncTs','presence','sessionLocks','lastResolvedKey','lastResolvedIdx']);
 for(const [rawKey,value] of Object.entries(updates||{})){const key=rawKey.includes('.')?rawKey.split('.')[0]:rawKey;
  if(key==='auctionState'){if(rawKey==='auctionState'&&plain(value))for(const [k,v] of Object.entries(value))persistAuctionStateValue(k,v,now);else if(rawKey.startsWith('auctionState.'))persistAuctionStateValue(rawKey.slice(14),value,now);}
  else if(key==='bidHistory'){if(rawKey==='bidHistory'&&plain(value))for(const [k,v] of Object.entries(value))persistBidHistoryKey(k,v,now);else if(rawKey.startsWith('bidHistory.'))persistBidHistoryKey(rawKey.slice(11),value,now);}
  else if(key==='passedTeams')persistPasses(value,now);else if(key==='chatMessages')persistChat(value,now);else if(metaKeys.has(key)){if(rawKey.includes('.'))setPath(meta,key,value);else if(del(value))delete meta[key];else meta[key]=clone(value);}
 }
 delete meta.auctionState;delete meta.bidHistory;delete meta.passedTeams;delete meta.chatMessages;setMeta(meta);
}
function getDoc(){return doc;}
function resolveSentinelsDeep(source,now){if(del(source))return source;if(serverTs(source))return{__ts:now};if(Array.isArray(source))return source.map(v=>resolveSentinelsDeep(v,now));if(plain(source)){const out={};for(const k of Object.keys(source))out[k]=resolveSentinelsDeep(source[k],now);return out;}return source;}
function applySet(updates){const now=Date.now();mergeInto(doc,updates||{});persistUpdates(updates||{},now);return{doc,patch:resolveSentinelsDeep(updates||{},now)};}

// Transactions are optimistic: begin returns a snapshot and a short-lived
// token, while commit validates against the latest authoritative document.
// There is no global waiting queue, so simultaneous bids don't block each other.
const txs=new Map();const TX_TIMEOUT_MS=4000;
function beginTransaction(socketId){const txId=Math.random().toString(36).slice(2)+Date.now().toString(36);const timer=setTimeout(()=>txs.delete(txId),TX_TIMEOUT_MS);txs.set(txId,{socketId,timer});return Promise.resolve({txId,doc:clone(doc)});}
function commitTransaction(socketId,txId,updates){const tx=txs.get(txId);if(!tx||tx.socketId!==socketId)throw new Error('Transaction expired — please try again.');clearTimeout(tx.timer);txs.delete(txId);return applySet(updates||{});}
function abortTransaction(socketId,txId){const tx=txs.get(txId);if(tx&&tx.socketId===socketId){clearTimeout(tx.timer);txs.delete(txId);}}
function releaseIfHeldBy(socketId){for(const [id,tx] of txs){if(tx.socketId===socketId){clearTimeout(tx.timer);txs.delete(id);}}}
module.exports={getDoc,applySet,beginTransaction,commitTransaction,abortTransaction,releaseIfHeldBy};
