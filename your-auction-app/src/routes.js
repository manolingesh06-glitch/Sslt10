const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcrypt');
const XLSX = require('xlsx');
const db = require('./db');
const { authenticate, requireRole, setUserPassword, HostAuthError } = require('./hostAuth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });
const hostOnly = requireRole('host');
const ownerOrHost = requireRole('host', 'owner');

function clean(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function slug(v) { return clean(v).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20); }
function number(v, fallback = null) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function parseCr(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') return raw >= 1 ? raw : raw;
  let s = String(raw).trim().toUpperCase().replace(/\s/g, '');
  if (s.endsWith('CR')) s = s.slice(0, -2) + 'C';
  if (s.endsWith('C')) return Number(s.slice(0, -1));
  if (s.endsWith('L')) return Number(s.slice(0, -1)) / 100;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function fmtBase(cr) {
  const n = Number(cr);
  if (!Number.isFinite(n)) return '';
  if (n < 1) return `${Math.round(n * 100)}L`;
  return `${String(Number(n.toFixed(2)))}C`;
}
function genPassword() { return Math.random().toString(36).slice(2, 10); }
function currentTournament() { return db.get('SELECT * FROM tournaments WHERE id = 1'); }
function teams() { return db.query('SELECT * FROM teams ORDER BY sort_order, id'); }
function publicPlayer(p) {
  return {
    'Auction #': p.auction_order,
    'Original S.No': p.auction_order,
    'SET': p.category || 'GENERAL',
    'PLAYER NAME': p.name,
    'BASE PRICE': fmtBase(p.base_price_cr),
    'CAP/UNCAP': p.nationality === 'OVERSEAS' ? 'Overseas' : (p.local_overseas || 'Local'),
    playerId: p.player_id,
    role: p.role || '',
    nationality: p.nationality || '',
    localOverseas: p.local_overseas || '',
    battingStyle: p.batting_style || '',
    bowlingStyle: p.bowling_style || '',
    photo: p.photo_url || null,
  };
}
function publicTeam(t) {
  return {
    id: t.id,
    name: t.name,
    shortName: t.short_name,
    owner: t.owner_name || '',
    logo: t.logo_url || null,
    budget: t.budget_cr,
    maxSquadSize: t.max_squad_size,
    minSquadSize: t.min_squad_size,
    maxOverseas: t.max_overseas,
    sortOrder: t.sort_order,
  };
}
function normalizeHeaders(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[clean(k).toLowerCase().replace(/[^a-z0-9]/g, '')] = v;
  return out;
}
function first(row, aliases) {
  const n = normalizeHeaders(row);
  for (const a of aliases) if (n[a] !== undefined) return n[a];
  return undefined;
}
function readSheet(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '' });
}

// ---------------- AUTH ----------------
router.post('/auth/login', authLimiter, async (req, res) => {
  try { res.json(await authenticate(req.body?.username, req.body?.password)); }
  catch (e) {
    if (e instanceof HostAuthError) return res.status(401).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/auth/change-password', ownerOrHost, async (req, res) => {
  try {
    const current = String(req.body?.currentPassword || '');
    const next = String(req.body?.newPassword || '');
    const user = db.get('SELECT * FROM users WHERE id = ?', [req.user.userId]);
    if (!user || !(await bcrypt.compare(current, user.password_hash))) return res.status(400).json({ error: 'Current password is incorrect' });
    await setUserPassword(user.id, next);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------------- PUBLIC LIVE CONFIG ----------------
router.get('/config/current', (req, res) => {
  const t = currentTournament();
  const teamRows = teams();
  const playerRows = db.query('SELECT * FROM players WHERE available = 1 ORDER BY auction_order, id');
  res.json({
    active: !!t,
    tournament: { name: 'SSLT10', purseCr: t?.purse_cr ?? 120, squadMin: t?.squad_min ?? 16, squadMax: t?.squad_max ?? 20, timerSeconds: t?.timer_seconds ?? 15 },
    auctionId: 1,
    teams: teamRows.map(t => t.short_name),
    teamDetails: teamRows.map(publicTeam),
    players: playerRows.map(publicPlayer),
    sounds: { bid: null, sold: null, unsold: null },
  });
});

// ---------------- HOST DASHBOARD ----------------
router.get('/host/dashboard', hostOnly, (req, res) => {
  const all = db.query('SELECT * FROM players ORDER BY auction_order, id');
  const state = db.get('SELECT data FROM live_state WHERE id = 1');
  const live = state ? JSON.parse(state.data || '{}') : {};
  const sold = Object.values(live.auctionState || {}).filter(x => x?.status === 'sold').length;
  const unsold = Object.values(live.auctionState || {}).filter(x => x?.status === 'unsold').length;
  res.json({ tournament: currentTournament(), teams: teams().length, players: all.length, sold, unsold, auctionStarted: !!live.auctionStarted, currentIdx: live.currentIdx ?? -1, currentBid: live.currentBid || null });
});

router.get('/host/teams', hostOnly, (req, res) => res.json(teams().map(publicTeam)));

router.post('/host/teams', hostOnly, async (req, res) => {
  const body = req.body || {};
  const name = clean(body.name);
  const shortName = slug(body.shortName || name);
  const budget = number(body.budget, 120);
  const maxSquadSize = number(body.maxSquadSize, 20);
  const minSquadSize = number(body.minSquadSize, 16);
  if (!name || !shortName) return res.status(400).json({ error: 'Team name and short name are required' });
  if (db.get('SELECT id FROM teams WHERE short_name = ?', [shortName])) return res.status(409).json({ error: `Duplicate team short name: ${shortName}` });
  if (budget <= 0 || maxSquadSize < 1 || minSquadSize < 0 || minSquadSize > maxSquadSize) return res.status(400).json({ error: 'Invalid team settings' });
  const order = teams().length;
  const result = db.run(`INSERT INTO teams (name, short_name, owner_name, logo_url, budget_cr, max_squad_size, min_squad_size, max_overseas, sort_order) VALUES (?,?,?,?,?,?,?,?,?)`, [name, shortName, clean(body.owner), clean(body.logo), budget, maxSquadSize, minSquadSize, number(body.maxOverseas), order]);
  const teamId = result.lastInsertId;
  const password = clean(body.password) || genPassword();
  const hash = await bcrypt.hash(password, 10);
  db.run('INSERT INTO users (username, password_hash, role, team_id) VALUES (?,?,\'owner\',?)', [shortName.toLowerCase(), hash, teamId]);
  res.status(201).json({ team: publicTeam(db.get('SELECT * FROM teams WHERE id = ?', [teamId])), credentials: { username: shortName.toLowerCase(), password } });
});

router.put('/host/teams/:id', hostOnly, async (req, res) => {
  const id = Number(req.params.id);
  const old = db.get('SELECT * FROM teams WHERE id = ?', [id]);
  if (!old) return res.status(404).json({ error: 'Team not found' });
  const name = clean(req.body?.name) || old.name;
  const shortName = slug(req.body?.shortName || old.short_name);
  const duplicate = db.get('SELECT id FROM teams WHERE short_name = ? AND id <> ?', [shortName, id]);
  if (duplicate) return res.status(409).json({ error: `Duplicate team short name: ${shortName}` });
  db.run(`UPDATE teams SET name=?, short_name=?, owner_name=?, logo_url=?, budget_cr=?, max_squad_size=?, min_squad_size=?, max_overseas=?, updated_at=datetime('now') WHERE id=?`, [name, shortName, clean(req.body?.owner), clean(req.body?.logo), number(req.body?.budget, old.budget_cr), number(req.body?.maxSquadSize, old.max_squad_size), number(req.body?.minSquadSize, old.min_squad_size), number(req.body?.maxOverseas, old.max_overseas), id]);
  db.run('UPDATE users SET username = ? WHERE team_id = ? AND role = \'owner\'', [shortName.toLowerCase(), id]);
  if (req.body?.password) await setUserPassword(db.get("SELECT id FROM users WHERE team_id=? AND role='owner'", [id]).id, req.body.password);
  res.json({ team: publicTeam(db.get('SELECT * FROM teams WHERE id = ?', [id])) });
});

router.delete('/host/teams/:id', hostOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!db.get('SELECT id FROM teams WHERE id = ?', [id])) return res.status(404).json({ error: 'Team not found' });
  db.run('DELETE FROM teams WHERE id = ?', [id]);
  res.json({ ok: true });
});

router.post('/host/teams/preview', hostOnly, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const rows = readSheet(req.file.buffer);
  const seen = new Set();
  const errors = [];
  const valid = [];
  rows.forEach((row, i) => {
    const rowNo = i + 2;
    const name = clean(first(row, ['teamname', 'name', 'team']));
    const shortName = slug(first(row, ['shortname', 'code', 'teamcode']) || name);
    const budget = number(first(row, ['budget', 'purse', 'startingbudget']), 120);
    if (!name) { errors.push({ row: rowNo, error: 'Missing Team Name' }); return; }
    if (!shortName) { errors.push({ row: rowNo, error: 'Missing Short Name' }); return; }
    if (seen.has(shortName) || db.get('SELECT id FROM teams WHERE short_name = ?', [shortName])) { errors.push({ row: rowNo, error: `Duplicate team: ${shortName}` }); return; }
    if (!(budget > 0)) { errors.push({ row: rowNo, error: 'Invalid budget' }); return; }
    seen.add(shortName);
    valid.push({ name, shortName, owner: clean(first(row, ['owner', 'ownername'])), budget, maxSquadSize: number(first(row, ['maxsquadsize', 'maxsquad']), 20), minSquadSize: number(first(row, ['minsquadsize', 'minsquad']), 16), maxOverseas: number(first(row, ['maxoverseas', 'overseaslimit'])) });
  });
  res.json({ totalRows: rows.length, validCount: valid.length, invalidCount: errors.length, valid, errors });
});

router.post('/host/teams/import', hostOnly, async (req, res) => {
  const rows = Array.isArray(req.body?.teams) ? req.body.teams : [];
  if (!rows.length) return res.status(400).json({ error: 'No teams to import' });
  const created = [];
  for (const row of rows) {
    const name = clean(row.name), shortName = slug(row.shortName);
    if (!name || !shortName || db.get('SELECT id FROM teams WHERE short_name = ?', [shortName])) continue;
    const order = teams().length;
    const r = db.run(`INSERT INTO teams (name, short_name, owner_name, logo_url, budget_cr, max_squad_size, min_squad_size, max_overseas, sort_order) VALUES (?,?,?,?,?,?,?,?,?)`, [name, shortName, clean(row.owner), clean(row.logo), number(row.budget, 120), number(row.maxSquadSize, 20), number(row.minSquadSize, 16), number(row.maxOverseas), order]);
    const password = genPassword();
    const hash = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (username, password_hash, role, team_id) VALUES (?,?,\'owner\',?)', [shortName.toLowerCase(), hash, r.lastInsertId]);
    created.push({ name, shortName, username: shortName.toLowerCase(), password });
  }
  res.json({ imported: created.length, credentials: created });
});

// ---------------- PLAYERS ----------------
router.get('/host/players', hostOnly, (req, res) => res.json(db.query('SELECT * FROM players ORDER BY auction_order, id')));

router.post('/host/players', hostOnly, (req, res) => {
  const b = req.body || {};
  const playerId = clean(b.playerId);
  const name = clean(b.name);
  const base = parseCr(b.basePrice);
  if (!playerId || !name || base === null || !(base >= 0)) return res.status(400).json({ error: 'Player ID, name and valid base price are required' });
  if (db.get('SELECT id FROM players WHERE player_id = ?', [playerId])) return res.status(409).json({ error: `Duplicate player ID: ${playerId}` });
  const maxOrder = db.get('SELECT COALESCE(MAX(auction_order),0) n FROM players').n;
  const r = db.run(`INSERT INTO players (player_id,name,category,role,base_price_cr,nationality,local_overseas,batting_style,bowling_style,photo_url,auction_order,available) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`, [playerId,name,clean(b.category),clean(b.role),base,clean(b.nationality),clean(b.localOverseas),clean(b.battingStyle),clean(b.bowlingStyle),clean(b.photo),number(b.auctionOrder,maxOrder+1)]);
  res.status(201).json({ player: db.get('SELECT * FROM players WHERE id=?',[r.lastInsertId]) });
});

router.put('/host/players/:id', hostOnly, (req, res) => {
  const id = Number(req.params.id), old = db.get('SELECT * FROM players WHERE id=?',[id]);
  if (!old) return res.status(404).json({ error: 'Player not found' });
  const playerId = clean(req.body?.playerId) || old.player_id;
  const dup = db.get('SELECT id FROM players WHERE player_id=? AND id<>?',[playerId,id]);
  if (dup) return res.status(409).json({ error: 'Duplicate player ID' });
  const base = parseCr(req.body?.basePrice);
  db.run(`UPDATE players SET player_id=?,name=?,category=?,role=?,base_price_cr=?,nationality=?,local_overseas=?,batting_style=?,bowling_style=?,photo_url=?,auction_order=?,available=?,updated_at=datetime('now') WHERE id=?`, [playerId,clean(req.body?.name)||old.name,clean(req.body?.category),clean(req.body?.role),base===null?old.base_price_cr:base,clean(req.body?.nationality),clean(req.body?.localOverseas),clean(req.body?.battingStyle),clean(req.body?.bowlingStyle),clean(req.body?.photo)||old.photo_url,number(req.body?.auctionOrder,old.auction_order),req.body?.available===undefined?old.available:(req.body.available?1:0),id]);
  res.json({ player: db.get('SELECT * FROM players WHERE id=?',[id]) });
});

router.delete('/host/players/:id', hostOnly, (req, res) => {
  const id = Number(req.params.id);
  if (!db.get('SELECT id FROM players WHERE id=?',[id])) return res.status(404).json({ error: 'Player not found' });
  db.run('DELETE FROM players WHERE id=?',[id]);
  res.json({ ok:true });
});

router.post('/host/players/preview', hostOnly, upload.single('file'), (req,res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const rows = readSheet(req.file.buffer);
  const seenId = new Set(), seenName = new Set(), errors = [], valid = [];
  rows.forEach((row,i) => {
    const rowNo=i+2;
    const playerId=clean(first(row,['playerid','id','sno','playernumber']));
    const name=clean(first(row,['playername','name','player']));
    const base=parseCr(first(row,['baseprice','basebid','price','base']));
    if(!playerId) { errors.push({row:rowNo,error:'Missing Player ID'}); return; }
    if(!name) { errors.push({row:rowNo,error:'Missing Player Name'}); return; }
    if(base===null || base<0) { errors.push({row:rowNo,error:`Invalid base price for ${name}`}); return; }
    if(seenId.has(playerId) || db.get('SELECT id FROM players WHERE player_id=?',[playerId])) { errors.push({row:rowNo,error:`Duplicate player ID: ${playerId}`}); return; }
    const nameKey=name.toLowerCase();
    if(seenName.has(nameKey) || db.get('SELECT id FROM players WHERE lower(name)=lower(?)',[name])) { errors.push({row:rowNo,error:`Duplicate player: ${name}`}); return; }
    seenId.add(playerId); seenName.add(nameKey);
    valid.push({ playerId,name,category:clean(first(row,['category','set','type'])),role:clean(first(row,['role','playingrole'])),basePrice:base,nationality:clean(first(row,['nationality','country'])),localOverseas:clean(first(row,['localoverseas','status','domesticinternational'])),battingStyle:clean(first(row,['battingstyle','batting'])),bowlingStyle:clean(first(row,['bowlingstyle','bowling'])),photo:clean(first(row,['photo','photourl','image'])),auctionOrder:number(first(row,['auctionorder','order','auctionnumber']),valid.length+1)});
  });
  res.json({totalRows:rows.length,validCount:valid.length,invalidCount:errors.length,valid,errors});
});

router.post('/host/players/import', hostOnly, (req,res) => {
  const rows=Array.isArray(req.body?.players)?req.body.players:[];
  if(!rows.length) return res.status(400).json({error:'No players to import'});
  const imported=[];
  for(const p of rows){
    const playerId=clean(p.playerId), name=clean(p.name), base=parseCr(p.basePrice);
    if(!playerId || !name || base===null || db.get('SELECT id FROM players WHERE player_id=?',[playerId])) continue;
    const r=db.run(`INSERT INTO players (player_id,name,category,role,base_price_cr,nationality,local_overseas,batting_style,bowling_style,photo_url,auction_order,available) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,[playerId,name,clean(p.category),clean(p.role),base,clean(p.nationality),clean(p.localOverseas),clean(p.battingStyle),clean(p.bowlingStyle),clean(p.photo),number(p.auctionOrder,imported.length+1)]);
    imported.push(r.lastInsertId);
  }
  res.json({imported:imported.length});
});

router.post('/host/players/replace', hostOnly, (req,res) => {
  const rows=Array.isArray(req.body?.players)?req.body.players:[];
  if(!rows.length) return res.status(400).json({error:'Replacement pool is empty'});
  db.transaction(() => {
    db.run('DELETE FROM players');
    for(const p of rows){
      const base=parseCr(p.basePrice); if(!p.playerId || !p.name || base===null) throw new Error('Invalid player in replacement pool');
      db.run(`INSERT INTO players (player_id,name,category,role,base_price_cr,nationality,local_overseas,batting_style,bowling_style,photo_url,auction_order,available) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,[clean(p.playerId),clean(p.name),clean(p.category),clean(p.role),base,clean(p.nationality),clean(p.localOverseas),clean(p.battingStyle),clean(p.bowlingStyle),clean(p.photo),number(p.auctionOrder,0)]);
    }
  });
  res.json({ok:true,players:db.query('SELECT * FROM players ORDER BY auction_order,id').length});
});

// ---------------- SETTINGS / RESULTS ----------------
router.put('/host/settings', hostOnly, (req,res) => {
  const old=currentTournament();
  db.run(`UPDATE tournaments SET name='SSLT10', purse_cr=?, squad_min=?, squad_max=?, timer_seconds=?, updated_at=datetime('now') WHERE id=1`, [number(req.body?.purseCr,old.purse_cr),number(req.body?.squadMin,old.squad_min),number(req.body?.squadMax,old.squad_max),number(req.body?.timerSeconds,old.timer_seconds)]);
  res.json({tournament:currentTournament()});
});

router.post('/host/teams/:id/password', hostOnly, async (req,res) => {
  const user=db.get("SELECT * FROM users WHERE team_id=? AND role='owner'",[Number(req.params.id)]);
  if(!user) return res.status(404).json({error:'Team login not found'});
  try { await setUserPassword(user.id,req.body?.password); res.json({ok:true}); }
  catch(e){ res.status(400).json({error:e.message}); }
});

router.post('/host/reset-auction', hostOnly, (req,res) => {
  db.run("UPDATE live_state SET data='{}' WHERE id=1");
  res.json({ok:true});
});

module.exports = router;
