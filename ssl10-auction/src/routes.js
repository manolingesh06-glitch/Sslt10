const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { requireSetupKey } = require('./auth');
const { parsePlayerFile } = require('./importPlayers');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10*1024*1024 } });

// Setup keys can be short/memorable, so without this, the key is
// brute-forceable. 10 attempts per 15 minutes per IP is plenty for a real
// person who mistyped it, not enough for a script.
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
});

function genPassword(){ return Math.random().toString(36).slice(2, 8); }

// Single-tenant: there is exactly one auction row (id = 1), created on
// first save if it doesn't exist yet.
function getOrCreateAuction(){
  let a = db.get(`SELECT * FROM auctions WHERE id = 1`);
  if(!a){
    db.run(`INSERT INTO auctions (id) VALUES (1)`);
    a = db.get(`SELECT * FROM auctions WHERE id = 1`);
  }
  return a;
}

// A lightweight "is the key correct" check the Setup screen calls once,
// right after the key is typed in, before showing the dashboard.
router.post('/setup/unlock', setupLimiter, requireSetupKey, (req,res) => {
  res.json({ ok: true });
});

router.get('/setup/auction', requireSetupKey, (req,res) => {
  const a = getOrCreateAuction();
  res.json({
    name: a.name,
    active: !!a.active,
    purseCr: a.purse_cr,
    squadMin: a.squad_min,
    squadMax: a.squad_max,
    timerSeconds: a.timer_seconds,
    teams: JSON.parse(a.teams_json || '[]'),
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

router.post('/setup/auction', requireSetupKey, (req,res) => {
  const { name, purseCr, squadMin, squadMax, timerSeconds, teams } = req.body;
  if(!name || !Array.isArray(teams) || teams.length < 2){
    return res.status(400).json({ error: 'name and at least 2 teams are required' });
  }
  getOrCreateAuction();
  db.run(
    `UPDATE auctions SET name=?, purse_cr=?, squad_min=?, squad_max=?, timer_seconds=?, teams_json=? WHERE id = 1`,
    [name.trim(), purseCr||120, squadMin||16, squadMax||20, timerSeconds||15, JSON.stringify(teams)]
  );
  res.json({ ok: true });
});

router.post('/setup/players', requireSetupKey, upload.single('file'), (req,res) => {
  if(!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { players, errors, totalRows } = parsePlayerFile(req.file.buffer);
  if(players.length > 0){
    getOrCreateAuction();
    db.run(`UPDATE auctions SET players_json = ? WHERE id = 1`, [JSON.stringify(players)]);
  }
  res.json({ imported: players.length, totalRows, errors });
});

router.post('/setup/sounds', requireSetupKey,
  upload.fields([{ name:'bid' }, { name:'sold' }, { name:'unsold' }]),
  (req,res) => {
    getOrCreateAuction();
    const dir = path.join(__dirname, '..', 'uploads', 'sounds');
    fs.mkdirSync(dir, { recursive: true });
    const updates = {};
    for(const key of ['bid','sold','unsold']){
      const file = req.files && req.files[key] && req.files[key][0];
      if(file){
        const filename = key + (path.extname(file.originalname) || '.mp3');
        fs.writeFileSync(path.join(dir, filename), file.buffer);
        updates['sound_' + key] = '/uploads/sounds/' + filename;
      }
    }
    if(Object.keys(updates).length){
      const setClause = Object.keys(updates).map(k => k + ' = ?').join(', ');
      db.run(`UPDATE auctions SET ${setClause} WHERE id = 1`, Object.values(updates));
    }
    res.json({ ok:true, updated: Object.keys(updates) });
  }
);

router.post('/setup/credentials', requireSetupKey, (req,res) => {
  const a = getOrCreateAuction();
  const teams = JSON.parse(a.teams_json || '[]');
  const hostPassword = genPassword();
  const teamPasswords = {};
  const credentials = [{ role:'host', username:'host', password: hostPassword }];
  for(const team of teams){
    const pw = genPassword();
    teamPasswords[team] = pw;
    credentials.push({ role:'owner', team, username: team, password: pw });
  }
  db.run(`UPDATE auctions SET host_password = ?, team_passwords_json = ? WHERE id = 1`,
    [hostPassword, JSON.stringify(teamPasswords)]);
  res.json({ credentials });
});

// Save passwords typed in by hand (the "auto-generate" route above is still
// here for a one-click random suggestion, but this is what actually lets
// someone set — and later come back and edit — their own choice instead of
// only ever getting random strings).
router.post('/setup/credentials/manual', requireSetupKey, (req,res) => {
  const a = getOrCreateAuction();
  const teams = JSON.parse(a.teams_json || '[]');
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
  db.run(`UPDATE auctions SET host_password = ?, team_passwords_json = ? WHERE id = 1`,
    [String(hostPassword).trim(), JSON.stringify(clean)]);
  res.json({ ok: true });
});

router.post('/setup/activate', requireSetupKey, (req,res) => {
  getOrCreateAuction();
  db.run(`UPDATE auctions SET active = 1 WHERE id = 1`);
  res.json({ ok:true });
});

router.get('/config/current', (req,res) => {
  const auction = db.get(`SELECT * FROM auctions WHERE id = 1 AND active = 1`);
  if(!auction) return res.json({ active: false });

  res.json({
    active: true,
    teams: JSON.parse(auction.teams_json || '[]'),
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
