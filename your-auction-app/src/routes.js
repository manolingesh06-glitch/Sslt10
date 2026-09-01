const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { signup, login, requireAuth, AuthError } = require('./auth');
const { parsePlayerFile } = require('./importPlayers');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });

// Admin passwords can be as short as 4 characters, so without this, login
// is brute-forceable. 10 attempts per 15 minutes per IP is plenty for a
// real person who mistyped their password, not enough for a script.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
});

function genPassword(){ return Math.random().toString(36).slice(2, 8); }

router.post('/admin/signup', authLimiter, async (req,res) => {
  try{
    const { username, password } = req.body;
    if(!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if(password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    res.json(await signup(username.trim(), password));
  }catch(e){
    if(e instanceof AuthError) return res.status(409).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Signup failed' });
  }
});

router.post('/admin/login', authLimiter, async (req,res) => {
  try{
    const { username, password } = req.body;
    if(!username || !password) return res.status(400).json({ error: 'Username and password required' });
    res.json(await login(username.trim(), password));
  }catch(e){
    if(e instanceof AuthError) return res.status(401).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/admin/auctions', requireAuth, (req,res) => {
  const rows = db.query(`SELECT id, name, active FROM auctions WHERE admin_id = ? ORDER BY created_at DESC`, [req.admin.adminId]);
  res.json(rows.map(r => ({ ...r, active: !!r.active })));
});

router.post('/admin/auctions', requireAuth, (req,res) => {
  const { name, purseCr, squadMin, squadMax, timerSeconds, teams } = req.body;
  if(!name || !Array.isArray(teams) || teams.length < 2){
    return res.status(400).json({ error: 'name and at least 2 teams are required' });
  }
  const { lastInsertId } = db.run(
    `INSERT INTO auctions (admin_id, name, purse_cr, squad_min, squad_max, timer_seconds, teams_json)
     VALUES (?,?,?,?,?,?,?)`,
    [req.admin.adminId, name.trim(), purseCr||120, squadMin||16, squadMax||20, timerSeconds||15, JSON.stringify(teams)]
  );
  res.json({ id: lastInsertId });
});

function ownedAuction(req, res, next){
  const auction = db.get(`SELECT * FROM auctions WHERE id = ? AND admin_id = ?`, [req.params.id, req.admin.adminId]);
  if(!auction) return res.status(404).json({ error: 'Auction not found' });
  req.auction = auction;
  next();
}

// Full detail for one auction, including its CURRENT host/team passwords —
// needed so the admin panel can pre-fill an editable credentials form
// instead of only offering "auto-generate random and lose whatever was
// there before".
router.get('/admin/auctions/:id', requireAuth, ownedAuction, (req,res) => {
  const a = req.auction;
  res.json({
    id: a.id,
    name: a.name,
    active: !!a.active,
    purseCr: a.purse_cr,
    squadMin: a.squad_min,
    squadMax: a.squad_max,
    timerSeconds: a.timer_seconds,
    teams: JSON.parse(a.teams_json),
    hasPlayers: !!a.players_json,
    hostPassword: a.host_password || '',
    teamPasswords: a.team_passwords_json ? JSON.parse(a.team_passwords_json) : {},
    sounds: {
      bid: a.sound_bid || null,
      sold: a.sound_sold || null,
      unsold: a.sound_unsold || null,
    },
  });
});

router.post('/admin/auctions/:id/players', requireAuth, ownedAuction, upload.single('file'), (req,res) => {
  if(!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { players, errors, totalRows } = parsePlayerFile(req.file.buffer);
  if(players.length > 0){
    db.run(`UPDATE auctions SET players_json = ? WHERE id = ?`, [JSON.stringify(players), req.params.id]);
  }
  res.json({ imported: players.length, totalRows, errors });
});

router.post('/admin/auctions/:id/sounds', requireAuth, ownedAuction,
  upload.fields([{ name:'bid' }, { name:'sold' }, { name:'unsold' }]),
  (req,res) => {
    const dir = path.join(__dirname, '..', 'uploads', 'sounds', String(req.params.id));
    fs.mkdirSync(dir, { recursive: true });
    const updates = {};
    for(const key of ['bid','sold','unsold']){
      const file = req.files && req.files[key] && req.files[key][0];
      if(file){
        const filename = key + (path.extname(file.originalname) || '.mp3');
        fs.writeFileSync(path.join(dir, filename), file.buffer);
        updates['sound_' + key] = '/uploads/sounds/' + req.params.id + '/' + filename;
      }
    }
    if(Object.keys(updates).length){
      const setClause = Object.keys(updates).map(k => k + ' = ?').join(', ');
      db.run(`UPDATE auctions SET ${setClause} WHERE id = ?`, [...Object.values(updates), req.params.id]);
    }
    res.json({ ok:true, updated: Object.keys(updates) });
  }
);

router.post('/admin/auctions/:id/credentials', requireAuth, ownedAuction, (req,res) => {
  const teams = JSON.parse(req.auction.teams_json);
  const hostPassword = genPassword();
  const teamPasswords = {};
  const credentials = [{ role:'host', username:'host', password: hostPassword }];
  for(const team of teams){
    const pw = genPassword();
    teamPasswords[team] = pw;
    credentials.push({ role:'owner', team, username: team, password: pw });
  }
  db.run(`UPDATE auctions SET host_password = ?, team_passwords_json = ? WHERE id = ?`,
    [hostPassword, JSON.stringify(teamPasswords), req.params.id]);
  res.json({ credentials });
});

// Save passwords the admin typed in themselves (the "auto-generate" route
// above is still here for a one-click random suggestion, but this is what
// actually lets someone set — and later come back and edit — their own
// choice instead of only ever getting random strings).
router.post('/admin/auctions/:id/credentials/manual', requireAuth, ownedAuction, (req,res) => {
  const teams = JSON.parse(req.auction.teams_json);
  const { hostPassword, teamPasswords } = req.body || {};
  if(!hostPassword || !String(hostPassword).trim()){
    return res.status(400).json({ error: 'Host password is required' });
  }
  const clean = {};
  for(const team of teams){
    const pw = teamPasswords && teamPasswords[team];
    if(!pw || !String(pw).trim()){
      return res.status(400).json({ error: `Password required for ${team}` });
    }
    clean[team] = String(pw).trim();
  }
  db.run(`UPDATE auctions SET host_password = ?, team_passwords_json = ? WHERE id = ?`,
    [String(hostPassword).trim(), JSON.stringify(clean), req.params.id]);
  res.json({ ok: true });
});

router.post('/admin/auctions/:id/activate', requireAuth, ownedAuction, (req,res) => {
  db.run(`UPDATE auctions SET active = 0 WHERE admin_id = ?`, [req.admin.adminId]);
  db.run(`UPDATE auctions SET active = 1 WHERE id = ?`, [req.params.id]);
  res.json({ ok:true });
});

router.get('/config/current', (req,res) => {
  const auction = db.get(`SELECT * FROM auctions WHERE active = 1 ORDER BY created_at DESC LIMIT 1`);
  if(!auction) return res.json({ active: false });

  res.json({
    active: true,
    auctionId: auction.id,
    teams: JSON.parse(auction.teams_json),
    purseCr: auction.purse_cr,
    squadMin: auction.squad_min,
    squadMax: auction.squad_max,
    players: auction.players_json ? JSON.parse(auction.players_json) : null,
    passwords: {
      host: auction.host_password || null,
      teams: auction.team_passwords_json ? JSON.parse(auction.team_passwords_json) : {},
    },
    sounds: {
      bid: auction.sound_bid || null,
      sold: auction.sound_sold || null,
      unsold: auction.sound_unsold || null,
    },
  });
});

module.exports = router;
