require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const { Server } = require('socket.io');
const routes = require('./routes');
const live = require('./liveState');
const db = require('./db');
const { verifyToken } = require('./hostAuth');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Serve the legacy UI through a small runtime migration layer. This keeps the
// working auction interactions while removing the old hardcoded tournament
// data and Admin UI from the actual application delivered to users.
const publicDir = path.join(__dirname, '..', 'public');
const appSourcePath = path.join(publicDir, 'js', 'app.js');
const indexSourcePath = path.join(publicDir, 'index.html');
let transformedAppCache = null;
let transformedIndexCache = null;
function transformAppSource(){
  const raw = fs.readFileSync(appSourcePath, 'utf8');
  let out = raw;
  out = out.replace(/^let PLAYERS_DATA = .*?;\n\nlet TEAMS = \[.*?\];/s, 'let PLAYERS_DATA = [];\nlet TEAMS = [];');
  out = out.replace(/const CREDENTIALS = \{.*?\};\n\nlet PLAYERS =/s, "const CREDENTIALS = { host:{password:''}, teams:{} };\n\nlet PLAYERS =");
  out = out.replace(/if\(Array\.isArray\(cfg\.teams\) && cfg\.teams\.length >= 2\) TEAMS = cfg\.teams;/, 'if(Array.isArray(cfg.teams)) TEAMS = cfg.teams;');
  out = out.replace(/if\(Array\.isArray\(cfg\.players\) && cfg\.players\.length > 0\) PLAYERS_DATA = cfg\.players;/, 'if(Array.isArray(cfg.players)) PLAYERS_DATA = cfg.players;');
  out = out.replace(/continuing with default SPL dataset/g, 'continuing with empty SSLT10 dataset');
  out = out.replace(/spl-s3-session/g, 'sslt10-session');
  out = out.replace(/spl-s3-chatSender/g, 'sslt10-chatSender');
  out = out.replace(/splSoundMuted/g, 'sslt10SoundMuted').replace(/splTheme/g, 'sslt10Theme').replace(/splSfxVolume/g, 'sslt10SfxVolume').replace(/splVcVolume/g, 'sslt10VcVolume');
  out = out.replace(/SPL_Season3_Auction_/g, 'SSLT10_Auction_');
  out = out.replace(/SPL Season 3/g, 'SSLT10').replace(/SPL Season 3/g, 'SSLT10');
  return out;
}
function transformIndexSource(){
  const raw = fs.readFileSync(indexSourcePath, 'utf8');
  let out = raw;
  const adminStart = out.indexOf('<!-- ============================================================\n     ADMIN PANEL');
  const mainStart = out.indexOf('<div class="wrap hidden" id="mainApp">');
  if(adminStart >= 0 && mainStart > adminStart) out = out.slice(0, adminStart) + out.slice(mainStart);
  out = out.replace(/<button type="button" class="admin-toggle-link" id="adminPanelToggle">.*?<\/button>/s, '');
  out = out.replace(/<div id="adminPwdModalOverlay".*?<\/div>\n\n<div id="joinNameModalOverlay"/s, '<div id="joinNameModalOverlay"');
  out = out.replace(/<script src="\/js\/admin\.js"><\/script>\n?/g, '');
  out = out.replace(/<script src="\/js\/app\.js"><\/script>/, '<script src="/js/app.js"></script>\n<script src="/js/security-bridge.js"></script>\n<script src="/js/host-console.js"></script>');
  out = out.replace(/SPL Season 3/g, 'SSLT10').replace(/SPL Auction/g, 'SSLT10 Auction').replace(/SPL SEASON 3/g, 'SSLT10');
  out = out.replace(/591 PLAYERS/g, 'DYNAMIC PLAYER POOL').replace(/12 FRANCHISES/g, 'HOST-MANAGED TEAMS').replace(/591 players/g, 'Dynamic players').replace(/12 franchises/g, 'Host-managed teams');
  out = out.replace(/<text x="50" y="63"[^>]*>S3<\/text>/g, '<text x="50" y="63" text-anchor="middle" font-family="Anton, sans-serif" font-size="22" fill="#1a1200">10</text>');
  out = out.replace(/progressLabel[^>]*>0 \/ 591/, 'progressLabel">0 / 0');
  return out;
}
app.get('/js/app.js', (req, res) => {
  if (!transformedAppCache || process.env.NODE_ENV !== 'production') transformedAppCache = transformAppSource();
  res.type('application/javascript').send(transformedAppCache);
});
app.get('/index.html', (req, res) => {
  if (!transformedIndexCache || process.env.NODE_ENV !== 'production') transformedIndexCache = transformIndexSource();
  res.type('html').send(transformedIndexCache);
});
app.get('/', (req, res) => {
  if (!transformedIndexCache || process.env.NODE_ENV !== 'production') transformedIndexCache = transformIndexSource();
  res.type('html').send(transformedIndexCache);
});

app.use('/api', routes);
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use(express.static(publicDir));
app.get('/health', (req, res) => res.json({ ok: true, name: 'SSLT10' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    socket.data.user = verifyToken(token);
    next();
  } catch (e) {
    next(new Error('Invalid or expired session'));
  }
});

function dottedValue(updates, prefix) {
  if (Object.prototype.hasOwnProperty.call(updates || {}, prefix)) return updates[prefix];
  const nested = updates?.[prefix.split('.')[0]];
  if (nested && Object.prototype.hasOwnProperty.call(nested, prefix.split('.').slice(1).join('.'))) return nested[prefix.split('.').slice(1).join('.')];
  return undefined;
}
function currentPlayerFor(doc) {
  const idx = Number.isInteger(doc.currentIdx) ? doc.currentIdx : -1;
  if (idx < 0) return null;
  const rows = db.query('SELECT * FROM players WHERE available=1 ORDER BY auction_order,id');
  return rows[idx] || null;
}
function teamSpend(doc, shortName) {
  let spent = 0, count = 0;
  for (const state of Object.values(doc.auctionState || {})) {
    if (state?.status === 'sold' && state.team === shortName) { spent += Number(state.priceCr) || 0; count++; }
  }
  return { spent, count };
}
function getTeam(shortName) { return db.get('SELECT * FROM teams WHERE short_name=?', [shortName]); }
function reject(reason) { throw new Error(reason); }
function sameArray(a, b) { return JSON.stringify(a || []) === JSON.stringify(b || []); }

function authorizeMutation(user, updates, doc) {
  const u = user || {};
  const keys = Object.keys(updates || {});
  if (!keys.length) return;
  if (keys.some(k => /admin|pwdOverrides/i.test(k))) reject('Forbidden field');

  const common = new Set(['chatMessages','_clockSyncTs','presence','sessionLocks']);
  if (u.role === 'host') return; // Host is the auction controller; API-level Host auth is still required.
  if (u.role === 'analyst') reject('Read-only role');
  if (u.role !== 'owner' || !u.team) reject('Forbidden');

  const allowed = new Set(['currentBid','timerEndAt','bidHistory','passedTeams','chatMessages','_clockSyncTs','presence','sessionLocks','auctionState']);
  if (keys.some(k => !allowed.has(k) && !common.has(k))) reject('Forbidden field');

  const currentPlayer = currentPlayerFor(doc);
  if (!currentPlayer) reject('No live player');
  const key = String(currentPlayer.auction_order);
  const team = getTeam(u.team);
  if (!team) reject('Team not found');

  if (Object.prototype.hasOwnProperty.call(updates, 'currentBid')) {
    const bid = updates.currentBid;
    if (!bid || bid.team !== u.team || !Number.isFinite(Number(bid.priceCr)) || Number(bid.priceCr) <= 0) reject('Invalid bid');
    const oldBid = doc.currentBid || null;
    const base = Number(currentPlayer.base_price_cr) || 0;
    const price = Number(bid.priceCr);
    if (oldBid ? price <= Number(oldBid.priceCr) : Math.abs(price - base) > 0.001) reject(oldBid ? 'Bid must be higher than current bid' : 'First bid must equal base price');
    const spend = teamSpend(doc, u.team);
    if (spend.count >= team.max_squad_size) reject('Squad is full');
    if (spend.spent + price > team.budget_cr) reject('Insufficient purse');
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'timerEndAt') && !Object.prototype.hasOwnProperty.call(updates, 'currentBid')) reject('Timer may only be reset with a bid');

  if (Object.prototype.hasOwnProperty.call(updates, 'bidHistory')) {
    const incoming = updates.bidHistory[key];
    const existing = (doc.bidHistory || {})[key] || [];
    if (!Array.isArray(incoming) || incoming.length !== existing.length + 1) reject('Invalid bid history');
    for (let i=0;i<existing.length;i++) if (JSON.stringify(existing[i]) !== JSON.stringify(incoming[i])) reject('Bid history cannot be rewritten');
    const last = incoming[incoming.length-1];
    if (!last || last.team !== u.team) reject('Bid history identity mismatch');
  }
  for (const k of keys.filter(k => k.startsWith('bidHistory.'))) {
    const incoming = updates[k];
    const existing = (doc.bidHistory || {})[k.split('.')[1]] || [];
    if (!Array.isArray(incoming) || incoming.length !== existing.length + 1) reject('Invalid bid history');
    for (let i=0;i<existing.length;i++) if (JSON.stringify(existing[i]) !== JSON.stringify(incoming[i])) reject('Bid history cannot be rewritten');
    if (incoming[incoming.length-1]?.team !== u.team) reject('Bid history identity mismatch');
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'passedTeams')) {
    const incoming = updates.passedTeams || {};
    const existing = doc.passedTeams || {};
    for (const k of new Set([...Object.keys(existing), ...Object.keys(incoming)])) {
      if (k === key) {
        const oldList = existing[k] || [], newList = incoming[k] || [];
        if (newList.length !== oldList.length + 1 || !newList.includes(u.team) || oldList.some(x => !newList.includes(x))) reject('Invalid pass state');
      } else if (!sameArray(existing[k], incoming[k])) reject('Cannot modify another player pass state');
    }
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'auctionState')) {
    const incoming = updates.auctionState || {};
    const existing = doc.auctionState || {};
    for (const k of Object.keys(existing)) if (k !== key && JSON.stringify(existing[k]) !== JSON.stringify(incoming[k])) reject('Cannot rewrite auction results');
    const state = incoming[key];
    const bid = doc.currentBid;
    if (!state || state.status !== 'sold' || state.team !== u.team || !bid || bid.team !== u.team || Number(state.priceCr) !== Number(bid.priceCr)) reject('Invalid automatic sale');
  }

  for (const k of keys.filter(k => k.startsWith('presence.'))) {
    if (k !== `presence.${u.team}`) reject('Cannot modify another team presence');
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'presence')) {
    const incoming = updates.presence || {}, existing = doc.presence || {};
    for (const k of Object.keys(incoming)) if (k !== u.team && incoming[k] !== existing[k]) reject('Cannot modify another team presence');
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'sessionLocks')) {
    const incoming = updates.sessionLocks || {}, existing = doc.sessionLocks || {};
    for (const k of new Set([...Object.keys(existing), ...Object.keys(incoming)])) {
      if (k !== u.team && JSON.stringify(existing[k]) !== JSON.stringify(incoming[k])) reject('Cannot modify another team session');
    }
  }
}

io.on('connection', (socket) => {
  socket.emit('snapshot', live.getDoc());

  socket.on('get', (ack) => {
    if (typeof ack === 'function') ack(live.getDoc());
  });

  socket.on('set', (fields, ack) => {
    try {
      authorizeMutation(socket.data.user, fields || {}, live.getDoc());
      const { patch } = live.applySet(fields || {});
      io.emit('patch', patch);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: e.message || 'Write failed' });
    }
  });

  socket.on('beginTransaction', async (ack) => {
    if (!['host','owner'].includes(socket.data.user?.role)) return ack?.({ error: 'Forbidden' });
    try { ack?.(await live.beginTransaction(socket.id)); }
    catch (e) { ack?.({ error: e.message || 'Could not start transaction' }); }
  });

  socket.on('commitTransaction', (payload, ack) => {
    try {
      const { txId, updates } = payload || {};
      authorizeMutation(socket.data.user, updates || {}, live.getDoc());
      const { patch } = live.commitTransaction(socket.id, txId, updates || {});
      io.emit('patch', patch);
      if (typeof ack === 'function') ack({ ok: true });
    } catch (e) {
      if (typeof ack === 'function') ack({ error: e.message || 'Transaction failed' });
    }
  });

  socket.on('abortTransaction', (payload, ack) => {
    const { txId } = payload || {};
    live.abortTransaction(socket.id, txId);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => live.releaseIfHeldBy(socket.id));
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`SSLT10 auction backend running at http://localhost:${PORT}`));
