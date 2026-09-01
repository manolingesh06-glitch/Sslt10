let PLAYERS_DATA = [];
let TEAMS = [];
let PURSE_CR = 120;
let SQUAD_MIN = 16, SQUAD_MAX = 20;

// Login credentials — change these to whatever you like before sharing the link.
// Host runs the whole auction. Each of the 12 owners can only log in with their
// own team's username/password and can only place bids for their own team.
const CREDENTIALS = { host:{password:''}, teams:{} };

let PLAYERS = [];
let PLAYERS_BY_KEY = {}; // Auction # -> player, O(1) lookup instead of PLAYERS.find() scans
let auctionState = {}; // key: Auction#, value: {status:'sold'|'unsold', team, priceCr}
let currentIdx = -1; // -1 = no player is live yet; host must release one
let lastResolvedKey = null; // Auction # of the most recently sold/unsold player, for "Undo Last Sale"
let lastResolvedIdx = null; // that player's index in PLAYERS, so the undo can bring it back live
let ownerUnit = 'L';
let currentBid = null; // {team, priceCr} — live bid on the player currently up for auction
let bidHistory = {}; // {auctionNoKey: [{team, priceCr}, ...]} — every valid bid, in order, per player (persists after sale)
let passedTeamsCache = {}; // {auctionNoKey: [team, ...]} — teams that clicked "Out" for that specific player
let chatMessagesCache = []; // [{sender, role, text, ts}, ...] — most recent chat messages, newest last
let chatSeenCount = 0; // how many chat messages the user has actually looked at (drives the unread badge)
let chatPanelOpen = false;
let auctionPaused = false; // host-controlled pause; blocks bidding/sold/unsold while true
let autoAdvance = false; // host-controlled: when true, Sold/Unsold auto-moves to the next player (after a 3s pause); when false (default) host clicks NEXT manually
let autoAdvanceTimeoutHandle = null; // guards the 3s pause before Auto Auction loads the next player — never more than one pending at once
let auctionStarted = false; // host-controlled: gates the "Start Auction Now" screen — host must click it before picking the first player
let session = null; // {role:'host'|'owner', team: 'RCB'|null}

// ---------------------------------------------------------------------
// ADMIN CONFIG OVERRIDE — added to support the new Admin panel (create
// auction / upload players / upload sounds / generate logins) without
// touching any of the existing app logic below. If an Admin has set up
// and activated an auction on the backend, this pulls in their TEAMS,
// PURSE_CR, SQUAD_MIN/MAX, PLAYERS_DATA, host/team passwords, and sound
// files, overriding the hardcoded SSLT10 defaults above.
//
// If there's no backend reachable, or no auction has been activated yet,
// this silently does nothing and the app runs exactly as it always did
// with the hardcoded 591-player SPL dataset — zero risk to existing usage.
// ---------------------------------------------------------------------
async function loadAdminConfig(){
  try{
    const res = await fetch('/api/config/current');
    if(!res.ok) return; // no active admin-configured auction — keep defaults
    const cfg = await res.json();
    if(!cfg || !cfg.active) return;

    window.__ACTIVE_AUCTION_ID = cfg.auctionId;

    if(Array.isArray(cfg.teams)) TEAMS = cfg.teams;
    if(typeof cfg.purseCr === 'number') PURSE_CR = cfg.purseCr;
    if(typeof cfg.squadMin === 'number') SQUAD_MIN = cfg.squadMin;
    if(typeof cfg.squadMax === 'number') SQUAD_MAX = cfg.squadMax;
    if(Array.isArray(cfg.players)) PLAYERS_DATA = cfg.players;

    // Seed host/team passwords via the app's existing pwdOverrides
    // mechanism (see effectivePassword() below) — no changes needed to
    // checkCredentials() or doLogin() at all.
    if(cfg.passwords){
      if(cfg.passwords.host) pwdOverrides['HOST'] = cfg.passwords.host;
      for(const team of TEAMS){
        if(cfg.passwords.teams && cfg.passwords.teams[team]) pwdOverrides[team] = cfg.passwords.teams[team];
      }
    }

    // Custom sounds — falls back to the existing local sold.mp3/unsold.mp3/
    // intense_bid.mp3 files if the Admin didn't upload a replacement.
    if(cfg.sounds){
      if(cfg.sounds.sold) document.getElementById('sfxSold').src = cfg.sounds.sold;
      if(cfg.sounds.unsold) document.getElementById('sfxUnsold').src = cfg.sounds.unsold;
      if(cfg.sounds.bid) document.getElementById('sfxIntense').src = cfg.sounds.bid;
    }
  }catch(e){
    console.error('loadAdminConfig failed — continuing with empty SSLT10 dataset', e);
  }
}

function baseToCr(baseStr){
  if(!baseStr) return 0;
  baseStr = String(baseStr).trim();
  if(baseStr.endsWith('C')) return parseFloat(baseStr);
  if(baseStr.endsWith('L')) return parseFloat(baseStr)/100;
  return parseFloat(baseStr)||0;
}
function fmtCr(cr){
  if(cr === undefined || cr === null || isNaN(cr)) return '—';
  if(cr >= 1) return cr.toFixed(2).replace(/\.00$/,'') + ' Cr';
  return Math.round(cr*100) + ' L';
}

async function loadData(){
  PLAYERS = PLAYERS_DATA;
  PLAYERS_BY_KEY = {};
  for(const p of PLAYERS){ PLAYERS_BY_KEY[String(p['Auction #'])] = p; }
}

// All shared auction data (auctionState, currentIdx, currentBid, pwdOverrides)
// lives in one Firestore document so every device — host and all 12 owners —
// sees the exact same live state instantly via a real-time listener (see
// startLiveSync below). These load/save functions still exist so the rest of
// the app's code doesn't need to change, but they now read/write Firestore
// directly instead of localStorage.
async function loadState(){
  try{
    const snap = await liveDocRef.get();
    const d = snap.data();
    auctionState = (d && d.auctionState) ? d.auctionState : {};
    auctionPaused = !!(d && d.paused);
  }catch(e){ console.error('loadState failed', e); }
}
async function loadIdx(){
  try{
    const snap = await liveDocRef.get();
    const d = snap.data();
    currentIdx = (d && typeof d.currentIdx === 'number') ? d.currentIdx : -1;
    auctionStarted = !!(d && d.auctionStarted);
  }catch(e){ console.error('loadIdx failed', e); currentIdx = -1; auctionStarted = false; }
}
async function saveState(){
  try{ await liveDocRef.set({auctionState}, {merge:true}); }catch(e){ console.error('saveState failed', e); }
}
async function saveIdx(){
  try{ await liveDocRef.set({currentIdx}, {merge:true}); }catch(e){ console.error('saveIdx failed', e); }
}
// Writes several fields to the shared doc in one atomic call instead of
// several separate .set() calls — separate calls each fire the live listener
// on every device mid-update, which caused visible flicker/inconsistent
// states until an extra tap forced things to settle.
async function saveLive(fields){
  try{ await liveDocRef.set(fields, {merge:true}); }catch(e){ console.error('saveLive failed', e); }
  if('currentIdx' in fields) currentIdx = fields.currentIdx;
  if('currentBid' in fields) currentBid = fields.currentBid;
  // NOTE: auctionState/bidHistory/presence are NOT synced back here — callers
  // that clear keys from these must use FieldValue.delete() on the specific
  // dotted path (see releasePlayerByIdx/undoPlayer/resetAll) because
  // Firestore's merge:true does a DEEP merge on nested map fields: sending
  // the whole (locally-shrunk) object only ADDS/UPDATES the keys present —
  // it never removes keys missing from that object on the server. Sending
  // {auctionState:{}} to "clear everything" silently does nothing, which is
  // why Reset used to look like it needed 2 clicks to actually take effect.
}
async function saveStarted(){
  try{ await liveDocRef.set({auctionStarted}, {merge:true}); }catch(e){ console.error('saveStarted failed', e); }
}

async function loadBid(){
  try{
    const snap = await liveDocRef.get();
    const d = snap.data();
    currentBid = (d && d.currentBid) ? d.currentBid : null;
  }catch(e){ console.error('loadBid failed', e); currentBid = null; }
}
async function saveBid(bid){
  currentBid = bid;
  try{ await liveDocRef.set({currentBid: bid || null}, {merge:true}); }catch(e){ console.error('saveBid failed', e); }
}

// Bid History: every valid bid placed on a player, in order. Keyed the same
// way as auctionState (String(Auction #)). Persists after the player is sold
// so the Sold Players list can show "View Bid History" later. Only cleared
// when a player is explicitly undone / re-opened / the whole auction reset.
async function loadBidHistory(){
  try{
    const snap = await liveDocRef.get();
    const d = snap.data();
    bidHistory = (d && d.bidHistory) ? d.bidHistory : {};
  }catch(e){ console.error('loadBidHistory failed', e); bidHistory = {}; }
}
async function saveBidHistory(){
  try{ await liveDocRef.set({bidHistory}, {merge:true}); }catch(e){ console.error('saveBidHistory failed', e); }
}

// Host-only pause/resume — freezes owner bidding and sold/unsold marking
// across every connected device the moment it's toggled.
async function togglePause(){
  if(!session || session.role !== 'host') return;
  auctionPaused = !auctionPaused;
  try{ await liveDocRef.set({paused: auctionPaused}, {merge:true}); }catch(e){ console.error('savePaused failed', e); }
  if(auctionPaused){
    stopIntenseSound();
    await clearAuctionTimer(); // freeze — no expiry while paused
  } else {
    startAuctionTimer(); // resume with a fresh 15s window
  }
  renderPauseUI();
}
function renderPauseUI(){
  const banner = document.getElementById('pausedBanner');
  if(banner) banner.classList.toggle('hidden', !auctionPaused);
  const btn = document.getElementById('pauseToggleBtn');
  if(btn){
    btn.textContent = auctionPaused ? '▶ Resume Auction' : '⏸ Pause Auction';
    btn.classList.toggle('is-pause', !auctionPaused);
    btn.classList.toggle('is-resume', auctionPaused);
  }
  const ownerBidBtn = document.getElementById('ownerBidBtn');
  if(ownerBidBtn) ownerBidBtn.disabled = auctionPaused;
}

// Host-only: toggles whether marking a player Sold/Unsold auto-moves to the
// next player, or leaves it on screen for the host to click NEXT manually.
// Synced via Firestore so it stays in the same state across a host's devices.
async function toggleAutoAdvance(){
  if(!session || session.role !== 'host') return;
  autoAdvance = !autoAdvance;
  if(!autoAdvance && autoAdvanceTimeoutHandle){
    // Stopping mid-wait: cancel the pending 3s auto-load so it never fires.
    clearTimeout(autoAdvanceTimeoutHandle);
    autoAdvanceTimeoutHandle = null;
  }
  try{ await liveDocRef.set({autoAdvance}, {merge:true}); }catch(e){ console.error('saveAutoAdvance failed', e); }
  renderAutoAdvanceUI();
}
function renderAutoAdvanceUI(){
  const btn = document.getElementById('autoAdvanceToggleBtn');
  if(!btn) return;
  btn.textContent = autoAdvance ? '⏹ Stop Auto Auction' : '▶ Start Auto Auction';
  btn.classList.toggle('is-export', !autoAdvance);
  btn.classList.toggle('is-on', autoAdvance);
}

// Host-only: shows the "Start Auction Now" gate until the host has clicked it
// on a fresh auction; once clicked (or once a player has ever been released),
// the normal search/release + bid/sold/unsold controls take over.
function renderHostStartUI(){
  const startWrap = document.getElementById('startAuctionWrap');
  const liveControls = document.getElementById('hostLiveControls');
  if(!startWrap || !liveControls) return;
  const showStart = !auctionStarted && currentIdx === -1;
  startWrap.classList.toggle('hidden', !showStart);
  liveControls.classList.toggle('hidden', showStart);
}

function teamSpent(team){
  let cr = 0, count = 0;
  for(const k in auctionState){
    const s = auctionState[k];
    if(s.status === 'sold' && s.team === team){ cr += s.priceCr; count++; }
  }
  return {cr, count};
}

function squadBreakdown(team){
  const counts = {BATTER:0,BOWLER:0,'ALL ROUNDER':0,WK:0,MARQUEE:0};
  for(const k in auctionState){
    const s = auctionState[k];
    if(s.status === 'sold' && s.team === team){
      const p = PLAYERS_BY_KEY[k];
      if(p) counts[p['SET']] = (counts[p['SET']]||0) + 1;
    }
  }
  return counts;
}

// One pass over auctionState for ALL teams at once — renderTeamTable used to
// call teamSpent() once per team (12x), each re-scanning the whole
// auctionState object; that's ~12x more work than necessary on every single
// re-render (which happens on nearly every bid/snapshot).
function computeAllTeamSpent(){
  const out = {};
  for(const t of TEAMS){ out[t] = {cr:0, count:0}; }
  for(const k in auctionState){
    const s = auctionState[k];
    if(s.status === 'sold' && out[s.team]){
      out[s.team].cr += s.priceCr;
      out[s.team].count++;
    }
  }
  return out;
}

function renderTeamTable(){
  const tbody = document.getElementById('teamTableBody');
  tbody.innerHTML = '';
  const p = currentPlayer();
  const liveKey = p ? String(p['Auction #']) : null;
  const isBiddingLive = liveKey && !auctionState[liveKey] && currentBid && currentBid.team;
  const allSpent = computeAllTeamSpent(); // one pass over auctionState for every team, not 12

  // Cheapest still-available player's base price — used below to flag a team
  // whose remaining purse genuinely can't cover reaching the minimum squad
  // size, not just a raw "players short" count.
  let cheapestRemainingCr = Infinity;
  for(const pl of PLAYERS){
    const k = String(pl['Auction #']);
    if(!auctionState[k]){
      const b = baseToCr(pl['BASE PRICE']);
      if(b < cheapestRemainingCr) cheapestRemainingCr = b;
    }
  }
  if(!isFinite(cheapestRemainingCr)) cheapestRemainingCr = 0;

  TEAMS.forEach(team => {
    const {cr, count} = allSpent[team];
    const left = PURSE_CR - cr;
    const stillNeeded = Math.max(0, SQUAD_MIN - count);
    const budgetTight = stillNeeded > 0 && left < stillNeeded * cheapestRemainingCr;

    const tr = document.createElement('tr');
    tr.className = 'team-row' + (isBiddingLive && currentBid.team === team ? ' team-row-leading' : '');
    tr.dataset.team = team; // lets updateLeadingTeamRow() toggle the highlight later without a full rebuild
    const countColor = count < SQUAD_MIN ? 'var(--gold)' : (count > SQUAD_MAX ? 'var(--red)' : 'var(--text)');

    let statusMsg;
    if(count < SQUAD_MIN){
      statusMsg = `${SQUAD_MIN-count} more to reach min (16)`;
    } else if(count < SQUAD_MAX){
      statusMsg = `16 reached · ${SQUAD_MAX-count} more to max · ₹${left.toFixed(2)}Cr left`;
    } else {
      statusMsg = `Squad full (20) · ₹${left.toFixed(2)}Cr left`;
    }
    if(budgetTight){
      statusMsg += `<br><span class="budget-warn-badge">⚠️ Purse too low for min squad</span>`;
    }

    const pctSpent = Math.min(100, (cr / PURSE_CR * 100));
    const barColor = pctSpent < 50 ? 'var(--green)' : (pctSpent < 80 ? 'var(--gold)' : 'var(--red)');

    tr.innerHTML = `<td data-label="Team"><span class="status-dot ${isTeamOnline(team) ? 'online' : 'offline'}"></span> <strong>${team}</strong></td>
      <td class="num" data-label="Players" style="color:${countColor};font-weight:700;">${count}/${SQUAD_MAX}</td>
      <td class="num" data-label="Spent">${cr.toFixed(2)}</td>
      <td class="num" data-label="Left">${left.toFixed(2)}
        <div class="purse-bar"><div class="purse-bar-fill" style="width:${pctSpent.toFixed(1)}%;background:${barColor};"></div></div>
      </td>
      <td data-label="Status" style="font-size:11px;color:var(--muted);">${statusMsg}</td>
      <td data-label="Squad" style="color:var(--gold);text-decoration:underline;">View</td>`;
    tr.onclick = () => openSquadModal(team);
    tbody.appendChild(tr);
  });
  renderAuctionSummary(); // keeps the owner-facing summary in sync with the host's table everywhere renderTeamTable() is called
}

// Cheap alternative to renderTeamTable() for when ONLY the live bid amount/
// team changed (no sale, no player change). Just moves the gold "leading"
// highlight to the correct row instead of tearing down and rebuilding all
// 12 rows — this is what keeps rapid bidding-war clicks smooth.
function updateLeadingTeamRow(){
  const tbody = document.getElementById('teamTableBody');
  if(!tbody) return;
  const p = currentPlayer();
  const liveKey = p ? String(p['Auction #']) : null;
  const isBiddingLive = liveKey && !auctionState[liveKey] && currentBid && currentBid.team;
  tbody.querySelectorAll('.team-row').forEach(tr => {
    const shouldLead = !!(isBiddingLive && tr.dataset.team === currentBid.team);
    tr.classList.toggle('team-row-leading', shouldLead);
  });
}

// Owner-facing view of every franchise's purse/squad — same numbers the host
// sees in the Purse Tracker, just read-only (no host action buttons) plus a
// "View Squad" button that reuses the existing squad modal.
function renderAuctionSummary(){
  const list = document.getElementById('auctionSummaryList');
  if(!list) return;
  const allSpent = computeAllTeamSpent();
  list.innerHTML = TEAMS.map(team => {
    const {cr, count} = allSpent[team];
    const left = PURSE_CR - cr;
    const online = isTeamOnline(team);
    const mine = session && session.role === 'owner' && session.team === team;
    return `<div class="summary-row" data-team="${team}">
      <div class="name"><span class="status-dot ${online ? 'online' : 'offline'}"></span>${team}${mine ? ' <span style="color:var(--muted);font-weight:400;">(You)</span>' : ''}</div>
      <div class="stats"><span><b>${count}</b>/${SQUAD_MAX} players</span><span>Spent <b>₹${cr.toFixed(2)}Cr</b></span><span>Left <b>₹${left.toFixed(2)}Cr</b></span></div>
      <button class="view-squad-btn" data-team="${team}">View Squad</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.view-squad-btn').forEach(btn => {
    btn.onclick = () => openSquadModal(btn.dataset.team);
  });
}

// Cheap alternative to a full renderTeamTable()/renderAuctionSummary() call
// when NOTHING but online/offline status changed — just flips the dot
// classes on rows that already exist, instead of rebuilding either table.
// Run on a 5s timer (see setInterval below) since a heartbeat going stale is
// a pure time-based event that doesn't necessarily arrive with a fresh
// Firestore snapshot to trigger a re-render on its own.
function updateAllStatusDots(){
  document.querySelectorAll('#teamTableBody tr.team-row, #auctionSummaryList .summary-row').forEach(row => {
    const dot = row.querySelector('.status-dot');
    if(!dot) return;
    const online = isTeamOnline(row.dataset.team);
    dot.classList.toggle('online', online);
    dot.classList.toggle('offline', !online);
  });
}

let currentSquadTeam = null;

function openSquadModal(team){
  currentSquadTeam = team;
  const title = document.getElementById('squadModalTitle');
  const body = document.getElementById('squadModalBody');
  const stats = document.getElementById('squadStats');
  title.textContent = `${team} — Squad`;

  const {cr, count} = teamSpent(team);
  const left = PURSE_CR - cr;
  stats.innerHTML = `
    <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">Players</div>
      <div style="font-family:'DM Mono',monospace;font-size:18px;">${count}</div></div>
    <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">Total Spent</div>
      <div style="font-family:'DM Mono',monospace;font-size:18px;color:var(--gold);">₹${cr.toFixed(2)} Cr</div></div>
    <div><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;">Purse Left</div>
      <div style="font-family:'DM Mono',monospace;font-size:18px;color:var(--green);">₹${left.toFixed(2)} Cr</div></div>
  `;

  const bought = [];
  for(const k in auctionState){
    const s = auctionState[k];
    if(s.status === 'sold' && s.team === team){
      const p = PLAYERS_BY_KEY[k];
      if(p) bought.push({...p, priceCr: s.priceCr});
    }
  }

  if(bought.length === 0){
    body.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:10px 0;">No players bought yet.</div>`;
  } else {
    bought.sort((a,b) => b.priceCr - a.priceCr);
    body.innerHTML = bought.map((p, idx) => `
      <div class="squad-row">
        <div class="squad-jersey">${idx + 1}</div>
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
          ${miniAvatarHTML(p['PLAYER NAME'])}
          <div style="min-width:0;">
            <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p['PLAYER NAME']}${idx === 0 ? ' <span class="squad-top-tag">TOP BUY</span>' : ''}</div>
            <div style="color:var(--muted);font-size:11px;">${p['SET']}</div>
          </div>
        </div>
        <div style="font-family:'DM Mono',monospace;color:var(--gold);flex-shrink:0;">${fmtCr(p.priceCr)}</div>
      </div>
    `).join('');
  }
  document.getElementById('squadModalOverlay').style.display = 'flex';
}

document.getElementById('squadModalCloseBtn').onclick = () => {
  document.getElementById('squadModalOverlay').style.display = 'none';
};

// Sold Players — full bid history (every valid bid, in order) plus the
// final winning bid. Never shown for Unsold players (no button rendered
// for them in renderList).
function openBidHistoryModal(p, state){
  const key = String(p['Auction #']);
  const history = bidHistory[key] || [];
  document.getElementById('bidHistoryModalTitle').textContent = `${p['PLAYER NAME']} — Bid History`;
  const body = document.getElementById('bidHistoryModalBody');
  let html = '';
  if(history.length === 0){
    html += `<div style="color:var(--muted);font-size:13px;padding:6px 0;">No bid history recorded for this player.</div>`;
  } else {
    html += history.map((b, i) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 4px;border-bottom:1px solid var(--line);font-size:13.5px;">
        <span>${i+1}. ${b.team}</span>
        <span style="font-family:'DM Mono',monospace;color:var(--gold);font-weight:700;">${fmtCr(b.priceCr)}</span>
      </div>
    `).join('');
  }
  if(state && state.status === 'sold'){
    html += `<div style="margin-top:12px;padding-top:12px;border-top:1.5px solid var(--line);display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:14px;">
      <span>Final Winning Bid — ${state.team}</span>
      <span style="color:var(--green);font-family:'DM Mono',monospace;">${fmtCr(state.priceCr)}</span>
    </div>`;
  }
  body.innerHTML = html;
  document.getElementById('bidHistoryModalOverlay').style.display = 'flex';
}
document.getElementById('bidHistoryModalCloseBtn').onclick = () => {
  document.getElementById('bidHistoryModalOverlay').style.display = 'none';
};

document.getElementById('squadDownloadBtn').onclick = async () => {
  const card = document.getElementById('squadCaptureCard');
  const btn = document.getElementById('squadDownloadBtn');
  btn.textContent = 'Generating…';
  try{
    const canvas = await html2canvas(card, {backgroundColor:'#1a2233', scale:2});
    const link = document.createElement('a');
    link.download = `${currentSquadTeam}_squad.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  } catch(e){
    await customAlert('Could not generate image. Try again.');
  }
  btn.textContent = '⬇ Download as Image';
};

function renderTeamSelect(){
  const sel = document.getElementById('teamSelect');
  sel.innerHTML = '<option value="">Select team…</option>' +
    TEAMS.map(t=>`<option value="${t}">${t}</option>`).join('');

  const adminSel = document.getElementById('adminPwdTeam');
  if(adminSel){
    adminSel.innerHTML = TEAMS.map(t=>`<option value="${t}">${t}</option>`).join('');
  }
}

function currentPlayer(){ return currentIdx >= 0 ? PLAYERS[currentIdx] : undefined; }

/* ---------------- PLAYER PHOTO (best-effort real photo, else initials avatar) ---------------- */

const photoCache = {}; // {name: url|null} — null means "looked up, no photo found"
let photoRequestSeq = 0;

function initialsFor(name){
  const parts = String(name||'').trim().split(/\s+/).filter(Boolean);
  if(parts.length === 0) return '?';
  if(parts.length === 1) return parts[0].slice(0,2).toUpperCase();
  return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
}
function colorFor(name){
  let hash = 0;
  for(let i=0;i<name.length;i++){ hash = name.charCodeAt(i) + ((hash<<5)-hash); }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 42%)`;
}
function showInitialsAvatar(el, name){
  el.classList.remove('photo-loading');
  el.style.backgroundImage = 'none';
  el.style.background = `linear-gradient(150deg, ${colorFor(name)}, var(--ink))`;
  el.textContent = initialsFor(name);
}

/* ---------------- SOUND ENGINE (Web Audio — no external audio files) ---------------- */
// Auction # keys whose sold/unsold sound was already played directly on THIS
// device (tied to the button click, for best autoplay reliability) — the
// real-time sync listener skips these once so the sound isn't played twice.
const locallyHandledResultKeys = new Set();

let soundMuted = (localStorage.getItem('splSoundMuted') === '1');
function setSoundMuted(val){
  soundMuted = val;
  try{ localStorage.setItem('splSoundMuted', val ? '1' : '0'); }catch(e){}
  updateMuteBtn();
}
function updateMuteBtn(){
  const btn = document.getElementById('muteToggleBtn');
  if(!btn) return;
  btn.textContent = soundMuted ? '🔇' : '🔊';
  btn.title = soundMuted ? 'Sound off — click to enable' : 'Sound on — click to mute';
  btn.classList.toggle('is-off', soundMuted);
  btn.classList.toggle('is-on', !soundMuted);
}

/* ---------------- THEME TOGGLE (dark / light) ---------------- */
function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('themeToggleBtn');
  if(btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
  try{ localStorage.setItem('splTheme', theme); }catch(e){}
}
applyTheme(localStorage.getItem('splTheme') || 'dark');
document.getElementById('themeToggleBtn').onclick = () => {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  applyTheme(isLight ? 'dark' : 'light');
};

/* ---------------- SOUND EFFECTS VOLUME (separate from voice call volume) ---------------- */
// Controls the sold/unsold/intense-bid mp3s AND the synthesized bid-tick /
// heartbeat sounds — NOT the LiveKit voice call, which has its own controls.
let sfxVolume = (() => {
  const saved = parseInt(localStorage.getItem('splSfxVolume'), 10);
  return isNaN(saved) ? 100 : Math.min(100, Math.max(0, saved));
})();
let masterSfxGainNode = null;
function getMasterSfxGain(ctx){
  if(!masterSfxGainNode){
    masterSfxGainNode = ctx.createGain();
    masterSfxGainNode.gain.value = sfxVolume / 100;
    masterSfxGainNode.connect(ctx.destination);
  }
  return masterSfxGainNode;
}
function applySfxVolume(){
  const vol = sfxVolume / 100;
  if(masterSfxGainNode) masterSfxGainNode.gain.value = vol;
  [document.getElementById('sfxSold'), document.getElementById('sfxUnsold'), document.getElementById('sfxIntense'), document.getElementById('sfxChat')]
    .forEach(el => { if(el) el.volume = vol; });
}
// Voice-chat volume — separate from the sold/unsold/intense sfxVolume above.
// This only controls how loud OTHER PEOPLE in the voice call sound to you;
// it never touches your own mic (that's the mic mute button, a totally
// different control — you can't make your own voice "louder" to yourself).
let vcVolume = (() => {
  const saved = parseInt(localStorage.getItem('splVcVolume'), 10);
  return (!isNaN(saved) && saved >= 0 && saved <= 100) ? saved : 100;
})();
// Applies the current vcVolume to every connected participant's hidden
// <audio> element (each one is id="audio-<identity>", set up down in the
// LiveKit trackSubscribed handler). Called both when the slider moves and
// right after a new participant's audio element is created, so a latecomer
// immediately picks up whatever level you'd already set.
function applyVcVolumeToAll(){
  document.querySelectorAll('audio[id^="audio-"]').forEach(el => { el.volume = vcVolume / 100; });
}
const vcVolumeSlider = document.getElementById('vcVolumeSlider');
if(vcVolumeSlider){
  vcVolumeSlider.value = vcVolume;
  vcVolumeSlider.addEventListener('input', (e) => {
    vcVolume = parseInt(e.target.value, 10);
    try{ localStorage.setItem('splVcVolume', vcVolume); }catch(err){}
    applyVcVolumeToAll();
  });
}

const sfxVolumeSlider = document.getElementById('sfxVolumeSlider');
if(sfxVolumeSlider){
  sfxVolumeSlider.value = sfxVolume;
  sfxVolumeSlider.addEventListener('input', (e) => {
    sfxVolume = parseInt(e.target.value, 10);
    try{ localStorage.setItem('splSfxVolume', sfxVolume); }catch(err){}
    applySfxVolume();
  });
}
applySfxVolume();

let audioCtx = null;
function getAudioCtx(){
  if(!audioCtx){
    try{ audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch(e){ return null; }
  }
  if(audioCtx.state === 'suspended'){ audioCtx.resume().catch(()=>{}); }
  return audioCtx;
}
// Called once on the first user click (login) so the browser's autoplay
// policy lets later, async (Firestore-triggered) sounds play without a gesture.
function primeAudio(){ getAudioCtx(); }

// SOLD: three sharp gavel knocks (low thump + filtered crack per knock).
function playSoldSound(){
  const ctx = getAudioCtx(); if(!ctx) return;
  [0, 0.16, 0.34].forEach((t, i) => {
    const start = ctx.currentTime + t;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(190, start);
    osc.frequency.exponentialRampToValueAtTime(58, start + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(i===2 ? 0.9 : 0.65, start + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
    osc.connect(g); g.connect(getMasterSfxGain(ctx));
    osc.start(start); osc.stop(start + 0.24);

    const bufSize = Math.floor(ctx.sampleRate * 0.05);
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for(let j=0;j<bufSize;j++){ data[j] = (Math.random()*2-1) * (1 - j/bufSize); }
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = 'highpass'; filt.frequency.value = 1200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(i===2 ? 0.5 : 0.32, start);
    ng.gain.exponentialRampToValueAtTime(0.0001, start + 0.05);
    noise.connect(filt); filt.connect(ng); ng.connect(getMasterSfxGain(ctx));
    noise.start(start);
  });
}

// UNSOLD: a short descending "buzzer" — deliberately different from SOLD.
function playUnsoldSound(){
  const ctx = getAudioCtx(); if(!ctx) return;
  const start = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(320, start);
  osc.frequency.linearRampToValueAtTime(110, start + 0.55);
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass'; filt.frequency.value = 850;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(0.32, start + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
  osc.connect(filt); filt.connect(g); g.connect(getMasterSfxGain(ctx));
  osc.start(start); osc.stop(start + 0.65);
}

// One "lub-dub" heartbeat pulse — used when bidding turns into a rapid war.
function playHeartbeatPulse(){
  if(soundMuted) return;
  const ctx = getAudioCtx(); if(!ctx) return;
  [[0,70,0.55,0.14],[0.14,54,0.4,0.16]].forEach(([t, freq, peak, dur]) => {
    const start = ctx.currentTime + t;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g); g.connect(getMasterSfxGain(ctx));
    osc.start(start); osc.stop(start + dur + 0.05);
  });
}

// A light, high "tick" for an ordinary (non-rapid) bid.
function playBidTick(){
  if(soundMuted) return;
  const ctx = getAudioCtx(); if(!ctx) return;
  const start = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(720, start);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(0.22, start + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
  osc.connect(g); g.connect(getMasterSfxGain(ctx));
  osc.start(start); osc.stop(start + 0.12);
}

// Briefly flashes a red glow around the live-bid boxes so the "heartbeat"
// during an intense bidding war is visible as well as audible.
function pulseLiveBidBoxes(){
  document.querySelectorAll('.bid-live-box').forEach(el => {
    el.classList.remove('heartbeat-pulse');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('heartbeat-pulse');
    setTimeout(() => el.classList.remove('heartbeat-pulse'), 1600);
  });
}

// Tracks bid pace so a fast run of bids on the SAME player escalates from a
// plain tick into the heartbeat effect. Resets whenever the live player
// changes or bidding goes quiet for a while.
const bidSoundTracker = { sig: null, idx: null, lastTime: 0, streak: 0, primed: false };
function trackBidForSound(bid, idx){
  if(!bidSoundTracker.primed){
    // Skip sound on the very first snapshot after page load / login.
    bidSoundTracker.primed = true;
    bidSoundTracker.sig = bid ? bid.team + ':' + bid.priceCr : null;
    bidSoundTracker.idx = idx;
    return;
  }
  if(idx !== bidSoundTracker.idx){
    bidSoundTracker.idx = idx;
    bidSoundTracker.sig = bid ? bid.team + ':' + bid.priceCr : null;
    bidSoundTracker.streak = 0;
    bidSoundTracker.lastTime = 0;
    return;
  }
  const sig = bid ? bid.team + ':' + bid.priceCr : null;
  if(!sig){ bidSoundTracker.streak = 0; bidSoundTracker.sig = null; return; }
  if(sig === bidSoundTracker.sig) return; // no actual change
  const now = Date.now();
  const gap = now - bidSoundTracker.lastTime;
  bidSoundTracker.sig = sig;
  bidSoundTracker.streak = (bidSoundTracker.lastTime && gap < 7000) ? bidSoundTracker.streak + 1 : 1;
  bidSoundTracker.lastTime = now;
  if(bidSoundTracker.streak >= 3){
    playHeartbeatPulse();
    pulseLiveBidBoxes();
  } else {
    playBidTick();
  }
}

/* ---------------- REAL AUDIO FILES (sold.mp3 / unsold.mp3 / intense_bid.mp3) ---------------- */
// These play alongside the existing synthesized sold/unsold cues above and are
// what's actually triggered from markSold/markUnsold/resolveTimerExpiry — kept
// as separate functions so the original Web Audio engine above stays intact.
const audioSoldEl = document.getElementById('sfxSold');
const audioUnsoldEl = document.getElementById('sfxUnsold');
const audioIntenseEl = document.getElementById('sfxIntense');
const audioChatEl = document.getElementById('sfxChat');
let intenseSoundActive = false;

function startIntenseSound(){
  if(soundMuted) return;
  if(intenseSoundActive || !audioIntenseEl) return;
  intenseSoundActive = true;
  audioIntenseEl.currentTime = 0;
  audioIntenseEl.play().catch(()=>{});
}
function stopIntenseSound(){
  intenseSoundActive = false;
  if(!audioIntenseEl) return;
  audioIntenseEl.pause();
  audioIntenseEl.currentTime = 0;
}
function playSoldMp3(){
  stopIntenseSound(); // intense bidding sound always stops before the sold/unsold sound
  if(soundMuted) return;
  if(!audioSoldEl) return;
  audioUnsoldEl && audioUnsoldEl.pause();
  audioSoldEl.currentTime = 0;
  audioSoldEl.play().catch(()=>{});
}
function playUnsoldMp3(){
  stopIntenseSound();
  if(soundMuted) return;
  if(!audioUnsoldEl) return;
  audioSoldEl && audioSoldEl.pause();
  audioUnsoldEl.currentTime = 0;
  audioUnsoldEl.play().catch(()=>{});
}
// Chat popup notification sound — deliberately doesn't touch the sold/
// unsold/intense sounds above (a chat ping shouldn't interrupt an ongoing
// bidding-war sound), just plays on its own short channel.
function playChatNotifySound(){
  if(soundMuted) return;
  if(!audioChatEl) return;
  audioChatEl.currentTime = 0;
  audioChatEl.play().catch(()=>{});
}
// Clears every result/intense sound and forgets which teams have bid so far —
// called whenever a new player becomes live so nothing bleeds over between players.
function resetAudioForNewPlayer(){
  stopIntenseSound();
  if(audioSoldEl){ audioSoldEl.pause(); audioSoldEl.currentTime = 0; }
  if(audioUnsoldEl){ audioUnsoldEl.pause(); audioUnsoldEl.currentTime = 0; }
  biddingTeamsTracker.idx = null;
  biddingTeamsTracker.teams = new Set();
}

// Tracks how many distinct teams have bid on the CURRENT player. The intense
// bidding-war sound only plays once the price is ₹10 Cr+ AND at least two
// different teams have been part of the bidding — a normal low-value bid, or
// a single team bidding against itself, never triggers it. It loops smoothly
// (no restart per bid) and is stopped as soon as bidding goes quiet, or the
// player is marked Sold/Unsold.
const biddingTeamsTracker = { idx: null, teams: new Set() };
function trackBiddingTeams(bid, idx){
  if(biddingTeamsTracker.idx !== idx){
    biddingTeamsTracker.idx = idx;
    biddingTeamsTracker.teams = new Set();
  }
  if(bid && bid.team) biddingTeamsTracker.teams.add(bid.team);
  const isBiddingWar = bid && bid.priceCr >= 10 && biddingTeamsTracker.teams.size >= 2;
  if(isBiddingWar) startIntenseSound();
  else stopIntenseSound();
}

/* ---------------- 15-SECOND SYNCED AUCTION TIMER ---------------- */
// timerEndAt (ms epoch) lives in the shared Firestore doc, exactly like
// currentBid/currentIdx, so every device — host and all owners — counts down
// from the exact same moment. Only a single setInterval is ever created
// (see ensureTimerLoop) so timers can never stack or double-run.
let timerEndAt = null;
// CLOCK-SYNC FIX: timerEndAt is one shared absolute timestamp (same for
// everyone), but each device previously compared it against its OWN
// Date.now() — a laptop's system clock and a phone's system clock are
// rarely within a few hundred ms of each other, so two devices watching
// the exact same countdown could legitimately show different numbers
// (e.g. host sees 15, an owner's phone sees 16). clockOffsetMs measures
// how far this device's clock is from Firestore's server clock, so every
// countdown calculation below can correct for it and every device shows
// the same number regardless of its own clock's drift.
let clockOffsetMs = 0;
async function syncClockOffset(){
  try{
    const localBefore = Date.now();
    await liveDocRef.set({_clockSyncTs: firebase.firestore.FieldValue.serverTimestamp()}, {merge:true});
    const snap = await liveDocRef.get();
    const ts = snap.data() && snap.data()._clockSyncTs;
    if(ts && typeof ts.toMillis === 'function'){
      const localAfter = Date.now();
      // subtract half the round-trip time so the offset reflects the
      // moment the server actually stamped it, not when we heard back
      clockOffsetMs = ts.toMillis() - Math.round((localBefore + localAfter) / 2);
    }
  }catch(e){ console.error('clock sync failed', e); }
}
let timerLocalInterval = null;
let timerResolvedForIdx = null; // guards against the host auto-resolving the same player twice

async function setTimerEndAt(ts){
  timerEndAt = ts;
  try{ await liveDocRef.set({timerEndAt: ts}, {merge:true}); }catch(e){ console.error('setTimerEndAt failed', e); }
}

// Starts (or restarts) the 15s countdown for whichever player is currently
// live — used on release, next/prev, undo, resume, and on every valid bid.
function startAuctionTimer(){
  const p = currentPlayer();
  if(!p || auctionPaused) return;
  const key = String(p['Auction #']);
  const state = auctionState[key];
  if(state && (state.status === 'sold' || state.status === 'unsold')) return;
  timerResolvedForIdx = null;
  setTimerEndAt(Date.now() + 15000);
}
function clearAuctionTimer(){
  timerResolvedForIdx = null;
  setTimerEndAt(null);
}

function ensureTimerLoop(){
  if(timerLocalInterval) return; // never start a second interval
  timerLocalInterval = setInterval(tickAuctionTimer, 200);
}

function tickAuctionTimer(){
  const wrap = document.getElementById('auctionTimerWrap');
  const numEl = document.getElementById('auctionTimerNum');
  const announceEl = document.getElementById('timerAnnounce');
  const circleEl = document.getElementById('auctionTimerCircle');
  if(!wrap || !numEl || !announceEl || !circleEl) return;

  const p = currentPlayer();
  const key = p ? String(p['Auction #']) : null;
  const state = key ? auctionState[key] : null;
  const finished = state && (state.status === 'sold' || state.status === 'unsold');

  if(!p || finished || auctionPaused || !timerEndAt){
    wrap.style.display = 'none';
    circleEl.classList.remove('timer-pulse');
    announceEl.classList.remove('show');
    announceEl.textContent = '';
    return;
  }

  wrap.style.display = 'flex';
  const remainingMs = timerEndAt - (Date.now() + clockOffsetMs);
  const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
  numEl.textContent = remaining;

  if(remaining <= 3 && remaining > 0){
    circleEl.classList.add('timer-pulse');
  } else {
    circleEl.classList.remove('timer-pulse');
  }

  let announceText = '';
  if(remaining === 3) announceText = 'Going Once...';
  else if(remaining === 2) announceText = 'Going Twice...';
  else if(remaining === 1) announceText = 'Final Call...';

  if(announceText){
    announceEl.textContent = announceText;
    announceEl.classList.add('show');
    stopIntenseSound(); // no more bids expected once the final countdown starts
  } else if(remaining > 3){
    announceEl.textContent = '';
    announceEl.classList.remove('show');
  }

  if(remainingMs <= 0){
    circleEl.classList.remove('timer-pulse');
    announceEl.classList.remove('show');
    if(session && session.role === 'host' && timerResolvedForIdx !== currentIdx){
      timerResolvedForIdx = currentIdx;
      resolveTimerExpiry();
    }
  }
}

// Host-only: fires once when the countdown hits zero. Re-uses the exact same
// Sold/Unsold state-writing, sound, and animation logic as the manual
// buttons — sells to the current highest bidder if there is one, otherwise
// marks the player unsold.
async function resolveTimerExpiry(){
  if(auctionPaused) return;
  const p = currentPlayer();
  if(!p) return;
  const key = String(p['Auction #']);
  if(auctionState[key]) return; // already resolved (e.g. host clicked a button first)

  // RACE-CONDITION FIX: this only fires off the HOST's own local 200ms
  // tick, counting down against whatever timerEndAt this device last
  // received. If a bid landed in the final second — while its own
  // startAuctionTimer() write to the server was still in flight — the
  // host's local timer could still hit zero on the OLD deadline before
  // that reset arrives, wrongly selling the player as if the bid never
  // happened. One authoritative re-read right before finalizing catches
  // that: if the server's timerEndAt has since moved into the future (a
  // last-second bid already extended it), bail out and let the next
  // 200ms tick pick up the new deadline instead of resolving early.
  let freshTimerEndAt = timerEndAt, freshBid = currentBid;
  try{
    const snap = await liveDocRef.get();
    const d = snap.data() || {};
    freshTimerEndAt = (typeof d.timerEndAt === 'number') ? d.timerEndAt : timerEndAt;
    freshBid = (d.currentBid !== undefined) ? d.currentBid : currentBid;
  }catch(e){ console.error('resolveTimerExpiry re-check failed', e); }

  if(freshTimerEndAt && freshTimerEndAt - (Date.now() + clockOffsetMs) > 0){
    timerEndAt = freshTimerEndAt; // pick up the extended deadline locally too
    currentBid = freshBid;
    timerResolvedForIdx = null; // let this player be re-checked on a future tick
    return;
  }
  if(auctionState[key]) return; // resolved by something else while we were re-checking

  if(freshBid && freshBid.team){
    const team = freshBid.team;
    const priceCr = freshBid.priceCr;
    currentBid = freshBid;
    primeAudio();
    playSoldMp3();
    locallyHandledResultKeys.add(key);
    auctionState[key] = {status: 'sold', team, priceCr};
    await saveState();
    await saveBid(null);
    await clearAuctionTimer();
    fireConfetti();
    renderPlayer();
    renderTeamTable();
    scheduleAutoAdvance();
  } else {
    primeAudio();
    playUnsoldMp3();
    locallyHandledResultKeys.add(key);
    auctionState[key] = {status: 'unsold'};
    await saveState();
    await saveBid(null);
    await clearAuctionTimer();
    fireUnsoldShake();
    renderPlayer();
    renderTeamTable();
    scheduleAutoAdvance();
  }
}

/* ---------------- SOLD celebration ---------------- */
function fireConfetti(){
  const colors = ['#ffc84a','#33e0a0','#5cc4ff','#7c7ff5','#ff5c6c'];
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  for(let i=0;i<36;i++){
    const bit = document.createElement('div');
    bit.className = 'confetti-bit';
    bit.style.left = (Math.random()*100) + 'vw';
    bit.style.background = colors[i % colors.length];
    bit.style.animationDelay = (Math.random()*0.3) + 's';
    bit.style.animationDuration = (1.4 + Math.random()*0.9) + 's';
    bit.style.transform = `rotate(${Math.random()*360}deg)`;
    layer.appendChild(bit);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 2400);
}

/* ---------------- UNSOLD shake ---------------- */
function fireUnsoldShake(){
  const cardEl = document.querySelector('.player-card');
  if(!cardEl) return;
  cardEl.classList.remove('unsold-shake');
  void cardEl.offsetWidth; // restart animation
  cardEl.classList.add('unsold-shake');
  setTimeout(() => cardEl.classList.remove('unsold-shake'), 650);
}

async function loadPlayerPhoto(name){
  const el = document.getElementById('playerPhoto');
  if(!el) return;
  const mySeq = ++photoRequestSeq;
  // Show initials immediately while we look for a real photo.
  showInitialsAvatar(el, name);

  if(photoCache.hasOwnProperty(name)){
    const cached = photoCache[name];
    if(cached && photoRequestSeq === mySeq){
      applyPhoto(el, cached);
    }
    return;
  }

  el.classList.add('photo-loading'); // shimmer while the real photo is being fetched
  const url = await fetchWikiPhoto(name);
  photoCache[name] = url;
  // BUG FIX: this used to call renderList() here unconditionally — rebuilding
  // the entire ~600-row queue from scratch — every single time a wiki photo
  // finished loading, even for a player the host had already clicked past
  // (mySeq no longer current) and even though only ONE row's tiny avatar
  // actually needs the new image. That was a second, separate source of lag
  // right after every "release player" click. Now we only touch the one
  // queue row that actually has this photo, and skip work entirely for
  // stale/discarded lookups.
  if(photoRequestSeq === mySeq){
    el.classList.remove('photo-loading');
    if(url) applyPhoto(el, url);
  }
  if(url) refreshRowAvatar(name, url);
}

// Patches a single queue row's mini-avatar image in place — used instead of
// a full renderList() rebuild when a wiki photo finishes loading after the
// row was already drawn with initials.
function refreshRowAvatar(name, url){
  const row = document.querySelector(`#playerList .list-row[data-player="${CSS.escape(name)}"]`);
  if(!row) return; // row isn't currently rendered (filtered out / different tab) — nothing to patch
  const avatar = row.querySelector('.mini-avatar');
  if(avatar) avatar.style.backgroundImage = `url('${url}')`;
}

// Setting the `background` shorthand (as this used to do) resets
// background-size/background-position back to their defaults, which made the
// photo show at its natural size instead of filling/covering the circle.
// Set every sub-property explicitly instead so it always covers cleanly.
function applyPhoto(el, url){
  el.style.backgroundColor = 'var(--panel2)';
  el.style.backgroundImage = `url("${url}")`;
  el.style.backgroundSize = 'cover';
  el.style.backgroundPosition = 'center top';
  el.style.backgroundRepeat = 'no-repeat';
  el.textContent = '';
}

// Two-step lookup: search Wikipedia for "<name> cricketer" to land on the right
// disambiguated page (many player names collide with footballers/actors/etc),
// then pull that exact page's summary thumbnail. Falls back to a direct
// summary lookup on the plain name if the search comes up empty.
async function fetchWikiPhoto(name){
  try{
    const searchUrl = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch='
      + encodeURIComponent(name + ' cricketer') + '&format=json&origin=*&srlimit=1';
    const sResp = await fetch(searchUrl);
    if(sResp.ok){
      const sData = await sResp.json();
      const hit = sData && sData.query && sData.query.search && sData.query.search[0];
      if(hit && hit.title){
        const thumb = await fetchSummaryThumb(hit.title);
        if(thumb) return thumb;
      }
    }
  }catch(e){ /* fall through to direct lookup */ }

  try{
    const thumb = await fetchSummaryThumb(name);
    if(thumb) return thumb;
  }catch(e){}

  return null;
}

async function fetchSummaryThumb(title){
  const resp = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title), {headers:{'Accept':'application/json'}});
  if(!resp.ok) return null;
  const data = await resp.json();
  return (data.thumbnail && data.thumbnail.source) ? data.thumbnail.source : null;
}

// Small cached-only avatar for list rows — never triggers a new network fetch;
// just reuses whatever loadPlayerPhoto() already resolved for that name so the
// queue doesn't fire hundreds of image requests at once.
function miniAvatarHTML(name){
  const cached = photoCache[name];
  if(cached){
    return `<span class="mini-avatar" style="background-image:url('${cached}')"></span>`;
  }
  return `<span class="mini-avatar" style="background:linear-gradient(150deg, ${colorFor(name)}, var(--ink));">${initialsFor(name)}</span>`;
}


// Renders text into an element as individual <span> letters with a
// staggered fade/rise-in animation — used for the player name reveal when a
// new player is released. Falls back to plain text if animate=false.
function setAnimatedName(el, text, animate){
  if(!el) return;
  if(!animate){ el.textContent = text; return; }
  el.innerHTML = '';
  const frag = document.createDocumentFragment();
  let i = 0;
  for(const ch of text){
    const span = document.createElement('span');
    span.className = 'letter';
    span.textContent = ch === ' ' ? '\u00A0' : ch;
    span.style.animationDelay = (i * 22) + 'ms';
    frag.appendChild(span);
    i++;
  }
  el.appendChild(frag);
}

let lastAnimatedPlayerNo = null;
function renderPlayer(){
  const p = currentPlayer();
  const bidRow = document.getElementById('hostBidRow');
  const actionsRow = document.getElementById('hostActionsRow');
  const cardEl = document.querySelector('.player-card');
  const thisNo = p ? p['Auction #'] : null;
  const isNewPlayer = thisNo !== lastAnimatedPlayerNo;
  if(cardEl && isNewPlayer){
    lastAnimatedPlayerNo = thisNo;
    cardEl.classList.remove('player-card-enter');
    void cardEl.offsetWidth; // restart animation
    cardEl.classList.add('player-card-enter');
  }

  if(!p){
    document.getElementById('auctionNo').textContent = 'NO PLAYER LIVE';
    setAnimatedName(document.getElementById('playerName'), 'Waiting for host…', false);
    document.getElementById('basePrice').textContent = '—';
    document.getElementById('playerBadges').innerHTML = '';
    document.getElementById('currentPriceDisplay').textContent = '—';
    document.getElementById('statusArea').innerHTML = '<span class="status-pill" style="background:var(--panel2);color:var(--muted);border:1px solid var(--line);">No player is live yet — search a name above and hit Release</span>';
    const photoEl = document.getElementById('playerPhoto');
    if(photoEl){ photoEl.style.backgroundImage = 'none'; photoEl.style.background = 'var(--panel2)'; photoEl.textContent = '🏏'; }
    if(bidRow) bidRow.classList.add('hidden');
    if(actionsRow) actionsRow.classList.add('hidden');
    updateProgress();
    renderList();
    renderLiveBid();
    return;
  }
  if(bidRow) bidRow.classList.remove('hidden');
  if(actionsRow) actionsRow.classList.remove('hidden');

  const key = String(p['Auction #']);
  const state = auctionState[key];

  document.getElementById('auctionNo').textContent = `AUCTION #${p['Auction #']} OF ${PLAYERS.length}`;
  setAnimatedName(document.getElementById('playerName'), p['PLAYER NAME'], isNewPlayer);
  document.getElementById('basePrice').textContent = p['BASE PRICE'];
  loadPlayerPhoto(p['PLAYER NAME']);

  const badgeHtml = `
    <span class="badge set">${p['SET']}</span>
    <span class="badge ${p['CAP/UNCAP'] && p['CAP/UNCAP'].trim().toUpperCase()==='CAPPED' ? 'capped':'uncapped'}">${p['CAP/UNCAP']}</span>
  `;
  document.getElementById('playerBadges').innerHTML = badgeHtml;

  const statusArea = document.getElementById('statusArea');
  const priceDisplay = document.getElementById('currentPriceDisplay');
  document.getElementById('teamSelect').value = '';
  document.getElementById('priceInput').value = '';

  if(state){
    if(state.status === 'sold'){
      priceDisplay.textContent = `${fmtCr(state.priceCr)} → ${state.team}`;
      statusArea.innerHTML = `<span class="status-pill sold">SOLD to <span class="team-name-big">${state.team}</span> for ${fmtCr(state.priceCr)}</span>`;
    } else {
      priceDisplay.textContent = '—';
      statusArea.innerHTML = `<span class="status-pill unsold">UNSOLD</span>`;
    }
  } else {
    // Player is live with no result yet — Current Bid starts exactly at the
    // Base Bid value and updates live as bids come in.
    priceDisplay.textContent = fmtCr(currentBid ? currentBid.priceCr : baseToCr(p['BASE PRICE']));
    statusArea.innerHTML = '';
  }

  updateProgress();
  renderList();
  renderLiveBid();
  if(session && session.role === 'owner') renderMyTeam();
}

function renderLiveBid(){
  const p = currentPlayer();
  const key = p ? String(p['Auction #']) : null;
  const state = key ? auctionState[key] : null;
  const finished = state && (state.status === 'sold' || state.status === 'unsold');

  // Host-side live bid box — shown as soon as a player enters the auction,
  // even before any bid: Current Bid starts exactly at the Base Bid value.
  const liveBox = document.getElementById('liveBidBox');
  if(liveBox){
    if(p && !finished){
      liveBox.style.display = 'block';
      if(currentBid){
        document.getElementById('liveBidAmt').textContent = fmtCr(currentBid.priceCr);
        document.getElementById('liveBidWho').innerHTML = `Highest bidder: <span class="team-name-big">${currentBid.team}</span>`;
        document.getElementById('teamSelect').value = currentBid.team;
        document.getElementById('priceInput').value = currentBid.priceCr;
      } else {
        document.getElementById('liveBidAmt').textContent = fmtCr(baseToCr(p['BASE PRICE']));
        document.getElementById('liveBidWho').innerHTML = `No bids yet — Base Bid`;
      }
    } else {
      liveBox.style.display = 'none';
    }
  }

  // Owner-side bid panel — also starts at exactly the Base Bid value before
  // any team has bid.
  const ownerAmt = document.getElementById('ownerBidAmt');
  if(ownerAmt){
    if(finished){
      document.getElementById('ownerBidWho').innerHTML = state.status === 'sold' ? `SOLD to <span class="team-name-big">${state.team}</span>` : 'Player went unsold';
      ownerAmt.textContent = state.status === 'sold' ? fmtCr(state.priceCr) : '—';
    } else if(currentBid){
      ownerAmt.textContent = fmtCr(currentBid.priceCr);
      document.getElementById('ownerBidWho').innerHTML = `Highest bidder: <span class="team-name-big">${currentBid.team}</span>`;
    } else {
      ownerAmt.textContent = p ? fmtCr(baseToCr(p['BASE PRICE'])) : '—';
      document.getElementById('ownerBidWho').textContent = p ? 'No bids yet — bidding open at Base Bid' : 'Waiting for host to release a player…';
    }
    renderQuickBids();
  }

  renderPassedBar();
  renderBidHistory();
}

// Live Bid History panel — shows every valid bid (in order) for the player
// currently up for auction. Clears automatically when a new player enters,
// since it's keyed by that player's Auction # and starts empty for them.
let lastBidHistoryCount = {};
function renderBidHistory(){
  const panel = document.getElementById('bidHistoryPanel');
  const list = document.getElementById('bidHistoryList');
  if(!panel || !list) return;
  const p = currentPlayer();
  if(!p){ panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const key = String(p['Auction #']);
  const history = bidHistory[key] || [];
  if(history.length === 0){
    list.innerHTML = '<div class="bid-history-empty">No bids yet.</div>';
    lastBidHistoryCount[key] = 0;
    return;
  }
  const prevCount = lastBidHistoryCount[key] || 0;
  const isFreshBid = history.length > prevCount;
  lastBidHistoryCount[key] = history.length;
  list.innerHTML = history.map((b, idx) => `
    <div class="bid-history-row${(isFreshBid && idx === history.length - 1) ? ' bh-new' : ''}">
      <span class="bh-team">${b.team}</span>
      <span class="bh-amt">${fmtCr(b.priceCr)}</span>
    </div>
  `).join('');
  list.scrollTop = list.scrollHeight;
}

function baseIncrementCr(baseCr){
  // Smart bid increment tiers, keyed off the CURRENT bid amount:
  //   < 1.00 Cr           -> +0.05 Cr ( 5 Lakh)
  //   1.00 - 1.99 Cr       -> +0.10 Cr (10 Lakh)
  //   2.00 - 4.99 Cr       -> +0.25 Cr (25 Lakh)
  //   5.00 Cr and above    -> +0.50 Cr (50 Lakh)
  if(baseCr < 1) return 0.05;
  if(baseCr < 2) return 0.10;
  if(baseCr < 5) return 0.25;
  return 0.50;
}

function renderQuickBids(){
  const container = document.getElementById('quickBids');
  if(!container) return;
  const p = currentPlayer();
  const key = p ? String(p['Auction #']) : null;
  const state = key ? auctionState[key] : null;
  const finished = state && (state.status === 'sold' || state.status === 'unsold');
  const customBox = document.querySelector('.custom-bid-box');
  const outBtn = document.getElementById('outBtn');
  const outMsg = document.getElementById('outStatusMsg');
  container.innerHTML = '';

  // "MID-BID OUT" FEATURE: every active team (i.e. one that hasn't pressed
  // Out for this player) sees Bid + Out — EXCEPT whichever team currently
  // holds the highest bid, who never sees an Out button while they're
  // leading. This is re-derived fresh from currentBid every render, so the
  // moment someone else outbids them, they're an ordinary active team again
  // and the Out button simply reappears — no separate state machine to get
  // out of sync. Once a team presses Out for this player, they're done for
  // good on this player (iPassed below) — resets automatically because
  // passedTeamsCache is keyed to THIS player's Auction #; a new player has
  // a different key, so nothing carries over.
  const iPassed = !!(session && session.role === 'owner' && key && (passedTeamsCache[key] || []).includes(session.team));
  const amHighestBidder = !!(session && currentBid && currentBid.team === session.team);

  if(!p || finished){
    if(customBox) customBox.style.display = 'none';
    if(outBtn) outBtn.style.display = 'none';
    if(outMsg) outMsg.style.display = 'none';
    return;
  }
  if(iPassed){
    if(customBox) customBox.style.display = 'none';
    if(outBtn) outBtn.style.display = 'none';
    if(outMsg){ outMsg.style.display = 'block'; outMsg.textContent = "You're sitting this player out."; }
    return;
  }
  if(customBox) customBox.style.display = '';
  if(outBtn) outBtn.style.display = (session && session.role === 'owner' && !amHighestBidder) ? '' : 'none';
  if(outMsg) outMsg.style.display = 'none';

  if(auctionPaused){
    container.innerHTML = '<div style="color:var(--muted);font-size:13px;font-weight:600;">⏸ Bidding is paused — please wait for the host to resume.</div>';
    return;
  }

  const base = currentBid ? currentBid.priceCr : baseToCr(p['BASE PRICE']);
  const step = baseIncrementCr(base);
  // First bid on a player must land exactly on the Base Bid — no auto
  // increment before anyone has bid. Only once currentBid exists do
  // quick-bids step up by the increment.
  const next = currentBid ? +(base + step).toFixed(2) : base;

  if(amHighestBidder){
    // Leading team: nothing to click (can't outbid yourself — the
    // transaction blocks that anyway), so show a clear waiting state
    // instead of a live Bid button.
    const waiting = document.createElement('div');
    waiting.className = 'qbid-waiting';
    waiting.textContent = '✅ You are the highest bidder — waiting for other teams…';
    container.appendChild(waiting);
    return;
  }

  const btn = document.createElement('button');
  btn.className = 'qbid';
  btn.textContent = currentBid ? `+ Bid ${fmtCr(next)}` : `Bid Base Price ${fmtCr(next)}`;
  btn.onclick = () => placeOwnerBid(next);
  container.appendChild(btn);
}

// Visible to host AND every owner — lists which teams have opted out of
// bidding on the CURRENTLY live player, so nobody's confused about who
// might still jump in with a bid.
function renderPassedBar(){
  const bar = document.getElementById('passedBar');
  if(!bar) return;
  const p = currentPlayer();
  const key = p ? String(p['Auction #']) : null;
  const passed = key ? (passedTeamsCache[key] || []) : [];
  if(!p || passed.length === 0){
    bar.classList.remove('show');
    bar.innerHTML = '';
    return;
  }
  bar.classList.add('show');
  bar.innerHTML = 'Sitting out this player: ' + passed.map(t => `<span class="tag">${t}</span>`).join('');
}

// MID-BID OUT: read-modify-write the whole passedTeams map inside a
// transaction (same whole-map pattern used for sessionLocks elsewhere in
// this file — a dotted-key merge can fail to create the nested field on a
// doc where this key doesn't exist yet). Doing this as a Firestore
// transaction — rather than a plain get()-then-set() — closes the race
// where a bid lands on the server between our read and our write: the
// transaction always re-reads the live doc right before committing, so a
// team can never be recorded as Out while, unbeknownst to their own stale
// UI, they've just become (or already are) the highest bidder.
//
// AUTO-SOLD ON ELIMINATION: once this Out leaves exactly one active team
// standing, and that team is the current highest bidder, this same
// transaction declares them the winner immediately — no waiting for the
// countdown timer. Only one team can ever trigger that specific transition
// (the highest bidder never has an Out button to click, so there's no
// possible double-fire race for "last team standing").
async function passOnPlayer(){
  if(!session || session.role !== 'owner') return;
  const p = currentPlayer();
  if(!p) return;
  const key = String(p['Auction #']);
  const idxAtClick = currentIdx;
  if(auctionPaused) return;
  const state = auctionState[key];
  if(state && (state.status === 'sold' || state.status === 'unsold')) return;

  let autoSold = false;
  let committedList = null; // this player's passed-team list, as actually written
  try{
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(liveDocRef);
      const d = snap.data() || {};
      const liveIdx = (typeof d.currentIdx === 'number') ? d.currentIdx : -1;
      // Someone released a different player while this click was in flight.
      if(liveIdx !== idxAtClick) throw new Error('STALE_PLAYER');
      const freshState = (d.auctionState && d.auctionState[key]) || null;
      if(freshState && (freshState.status === 'sold' || freshState.status === 'unsold')) throw new Error('ALREADY_RESOLVED');

      const liveBid = d.currentBid || null;
      // The current highest bidder can never press Out — re-checked fresh
      // here in case their own bid just landed and their local UI hasn't
      // caught up yet.
      if(liveBid && liveBid.team === session.team) throw new Error('YOU_ARE_HIGHEST');

      const map = Object.assign({}, d.passedTeams || {});
      const list = (map[key] || []).slice();
      if(list.includes(session.team)){ committedList = list; return; } // already Out — no-op, nothing to write

      list.push(session.team);
      map[key] = list;
      committedList = list;
      const updates = {passedTeams: map};

      // Exactly one active team left, and they're the highest bidder ->
      // auction ends right now, SOLD to that team.
      const activeTeams = TEAMS.filter(t => !list.includes(t));
      if(activeTeams.length === 1 && liveBid && liveBid.team === activeTeams[0]){
        updates.auctionState = Object.assign({}, d.auctionState || {}, {
          [key]: {status: 'sold', team: liveBid.team, priceCr: liveBid.priceCr}
        });
        updates.currentBid = null;
        updates.timerEndAt = null;
        autoSold = true;
      }

      tx.set(liveDocRef, updates, {merge:true});
    });
  }catch(e){
    if(e.message !== 'STALE_PLAYER' && e.message !== 'ALREADY_RESOLVED' && e.message !== 'YOU_ARE_HIGHEST'){
      console.error('passOnPlayer failed', e);
    }
    renderQuickBids();
    return;
  }
  // Reflect our own Out immediately, same as placeOwnerBid updates
  // `currentBid` locally right after its transaction — don't wait on the
  // onSnapshot echo just to hide our own Out button.
  if(committedList) passedTeamsCache[key] = committedList;
  // Sold sound, confetti, and the full re-render (including the SOLD popup
  // when autoSold fired) all arrive uniformly through the same onSnapshot
  // listener every device uses — no separate local handling needed here,
  // and no risk of double-playing the Sold sound.
  if(!autoSold){ renderQuickBids(); renderPassedBar(); }
}

/* ---------------- Team chat ---------------- */
function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
// CHAT NAME SELECTION: the account you're logged in as (team code / HOST)
// never changes — this only controls the display label attached to chat
// messages you send. The first time you open chat each session, a small
// modal (same pattern as "Join Voice") asks for a display name; after
// that it's remembered (sessionStorage, wiped on logout) and used
// silently for every message — no persistent input box cluttering the
// panel. Tap the ✏️ in the chat header any time to change it.
let chatSenderOverride = null;
let chatNameModalThenOpenPanel = false; // true when the modal was opened to gate a first-time chat-panel open
function chatSenderDefault(){
  if(!session) return '';
  return session.role === 'host' ? 'HOST' : session.team;
}
function chatSenderLabel(){
  if(!session) return '';
  const typed = (chatSenderOverride || '').trim();
  return typed || chatSenderDefault();
}
function updateChatNameEditLabel(){
  const lbl = document.getElementById('chatNameEditLabel');
  if(lbl) lbl.textContent = chatSenderLabel();
}
// Restores a name picked earlier this session (e.g. after a page refresh)
// without re-asking — called once at login. Does NOT show the modal.
function initChatSenderFromStorage(){
  if(chatSenderOverride === null){
    try{ chatSenderOverride = sessionStorage.getItem('sslt10-chatSender'); }catch(e){}
  }
  updateChatNameEditLabel();
}
function openChatNameModal(thenOpenPanel){
  chatNameModalThenOpenPanel = !!thenOpenPanel;
  const err = document.getElementById('chatNameError');
  if(err) err.textContent = '';
  const input = document.getElementById('chatNameInput');
  if(input){
    input.value = (chatSenderOverride && chatSenderOverride.trim()) ? chatSenderOverride : chatSenderDefault();
  }
  document.getElementById('chatNameModalOverlay').style.display = 'flex';
  if(input){ input.focus(); input.select(); }
}
function closeChatNameModal(){
  document.getElementById('chatNameModalOverlay').style.display = 'none';
}
function setChatSenderName(name){
  const clean = (name || '').trim();
  chatSenderOverride = clean || chatSenderDefault();
  try{ sessionStorage.setItem('sslt10-chatSender', chatSenderOverride); }catch(e){}
  updateChatNameEditLabel();
}
function confirmChatName(name){
  setChatSenderName(name);
  closeChatNameModal();
  if(chatNameModalThenOpenPanel){ chatNameModalThenOpenPanel = false; showChatPanelUI(); }
}
document.getElementById('chatNameConfirmBtn').addEventListener('click', () => {
  confirmChatName(document.getElementById('chatNameInput').value);
});
document.getElementById('chatNameCancelBtn').addEventListener('click', () => {
  confirmChatName(''); // empty -> falls back to the default team/HOST label
});
document.getElementById('chatNameInput').addEventListener('keydown', (e) => {
  if(e.key === 'Enter') document.getElementById('chatNameConfirmBtn').click();
});
document.getElementById('chatNameEditBtn').addEventListener('click', () => openChatNameModal(false));
function fmtChatTime(ts){
  try{ return new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }catch(e){ return ''; }
}
function renderChat(hasNew){
  const list = document.getElementById('chatMessages');
  const badge = document.getElementById('chatBadge');
  const fab = document.getElementById('chatFab');
  if(fab && session) fab.classList.remove('hidden'); // only show the chat button once logged in
  if(!list) return;
  list.innerHTML = chatMessagesCache.map(m => {
    const isHost = m.role === 'host';
    return `<div class="chat-msg"><span class="sender${isHost ? ' is-host' : ''}">${escapeHtml(m.sender)}</span>${escapeHtml(m.text)}<span class="time">${fmtChatTime(m.ts)}</span></div>`;
  }).join('');
  if(chatPanelOpen){
    list.scrollTop = list.scrollHeight;
    chatSeenCount = chatMessagesCache.length;
    if(badge) badge.classList.add('hidden');
  } else if(hasNew && badge){
    const unread = Math.max(0, chatMessagesCache.length - chatSeenCount);
    if(unread > 0){
      badge.textContent = unread > 9 ? '9+' : String(unread);
      badge.classList.remove('hidden');
    }
  }
}
// CHAT POPUP NOTIFICATIONS: stacked toasts, top-right, for incoming messages
// that aren't our own. Driven off each message's timestamp rather than
// array length, since the shared chat log is capped at 50 entries (older
// ones shift off the front) — a length-only comparison would silently stop
// detecting "new" messages forever once that cap is first reached.
let lastSeenChatTs = 0;
let chatSynced = false; // guards the very first snapshot after login from replaying the last 50 messages as fresh toasts
const MAX_CHAT_TOASTS = 5;
function isOwnChatMessage(m){
  if(!session) return false;
  if(session.role === 'host') return m.role === 'host';
  return m.role === 'owner' && m.byTeam === session.team;
}
function showChatToast(m){
  const stack = document.getElementById('chatToastStack');
  if(!stack) return;
  playChatNotifySound();
  const isHost = m.role === 'host';
  const toast = document.createElement('div');
  toast.className = 'chat-toast';
  toast.innerHTML = `<div class="ct-sender${isHost ? ' is-host' : ''}">${escapeHtml(m.sender)}</div><div class="ct-text">${escapeHtml(m.text)}</div>`;
  stack.appendChild(toast);
  while(stack.children.length > MAX_CHAT_TOASTS){ stack.removeChild(stack.firstChild); }
  const hideTimer = setTimeout(() => dismissChatToast(toast), 3000);
  toast.addEventListener('click', () => {
    clearTimeout(hideTimer);
    dismissChatToast(toast);
    openChatPanel();
  });
}
function dismissChatToast(toast){
  if(!toast || !toast.parentNode) return;
  toast.classList.add('chat-toast-out');
  setTimeout(() => toast.remove(), 200);
}
function clearAllChatToasts(){
  const stack = document.getElementById('chatToastStack');
  if(stack) stack.innerHTML = '';
}
// Same read-modify-write pattern as sessionLocks/passedTeams — avoids the
// dotted-key-merge bug found earlier. Capped at the last 50 messages so the
// shared document (which also holds the whole auction state) can't grow
// without bound over a long auction night.
async function sendChatMessage(){
  const input = document.getElementById('chatInput');
  if(!input) return;
  const text = input.value.trim();
  if(!text || !session) return;
  input.value = '';
  try{
    const snap = await liveDocRef.get();
    const d = snap.data() || {};
    const msgs = (d.chatMessages || []).slice();
    msgs.push({
      sender: chatSenderLabel(), role: session.role, text, ts: Date.now() + clockOffsetMs,
      // Real underlying identity, separate from the (possibly aliased) display
      // sender above — lets every device reliably tell "was this my own
      // message" apart, regardless of which sender name was picked.
      byTeam: session.role === 'owner' ? session.team : null
    });
    while(msgs.length > 50) msgs.shift();
    await liveDocRef.set({chatMessages: msgs}, {merge:true});
  }catch(e){ console.error('sendChatMessage failed', e); }
}
// The very first time this session that chat is opened, ask for a display
// name first (same pattern as "Join Voice") — the panel itself only opens
// once that's confirmed or skipped. Every later open just shows the panel
// directly, since chatSenderOverride is already set from then on.
function openChatPanel(){
  if(session && chatSenderOverride === null){
    openChatNameModal(true);
    return;
  }
  showChatPanelUI();
}
function showChatPanelUI(){
  chatPanelOpen = true;
  document.getElementById('chatPanel').classList.remove('hidden');
  chatSeenCount = chatMessagesCache.length;
  document.getElementById('chatBadge').classList.add('hidden');
  const list = document.getElementById('chatMessages');
  if(list) list.scrollTop = list.scrollHeight;
}
function closeChatPanel(){
  chatPanelOpen = false;
  document.getElementById('chatPanel').classList.add('hidden');
}
document.getElementById('chatFab').addEventListener('click', () => { chatPanelOpen ? closeChatPanel() : openChatPanel(); });
document.getElementById('chatCloseBtn').addEventListener('click', closeChatPanel);
document.getElementById('chatSendBtn').addEventListener('click', sendChatMessage);
document.getElementById('chatInput').addEventListener('keydown', e => { if(e.key === 'Enter') sendChatMessage(); });
document.getElementById('outBtn').addEventListener('click', passOnPlayer);

function renderMyTeam(){
  if(!session || session.role !== 'owner') return;
  const {cr, count} = teamSpent(session.team);
  const left = PURSE_CR - cr;
  document.getElementById('myTeamCount').textContent = `${count}/${SQUAD_MAX}`;
  document.getElementById('myTeamSpent').textContent = `₹${cr.toFixed(2)} Cr`;
  document.getElementById('myTeamLeft').textContent = `₹${left.toFixed(2)} Cr`;

  let statusMsg;
  if(count < SQUAD_MIN){
    statusMsg = `${SQUAD_MIN-count} more to reach min (16) · ₹${left.toFixed(2)}Cr left`;
  } else if(count < SQUAD_MAX){
    statusMsg = `Min 16 reached · ${SQUAD_MAX-count} more to max (20) · ₹${left.toFixed(2)}Cr left`;
  } else {
    statusMsg = `Squad full (20) · ₹${left.toFixed(2)}Cr left`;
  }
  document.getElementById('myTeamStatus').textContent = statusMsg;
}

// RACE-CONDITION FIX: the old version did loadBid() (a plain read), ran its
// checks against that, then saveBid() (a plain write) — two separate network
// round-trips with no lock between them. If two owners clicked within that
// window, both could pass validation against the same stale bid and the
// second write would silently overwrite the first, so one team would see
// "bid placed" even though it wasn't really the highest bid anymore.
// db.runTransaction() reads the live doc and writes the new bid as one
// atomic operation — Firestore automatically retries a transaction if the
// document changed underneath it, so only one of two simultaneous bids can
// ever win, and the loser gets a clear error instead of a silent overwrite.
async function placeOwnerBid(priceCr){
  // INSTANT-FEEDBACK FIX: previously nothing on screen changed between the
  // click and the transaction resolving, so on a slow connection or during
  // a fast bidding war (transaction retries), the button just sat there
  // looking unresponsive — people would click again, wondering if it
  // registered. Now the buttons disable and show "Bidding…" the instant
  // the click happens (before any network call), and a bidInFlight guard
  // stops a double-click from firing a second transaction. setBidButtonsBusy(false)
  // is called explicitly on every exit path below to restore both buttons —
  // the static custom-bid button needed that explicit reset since (unlike
  // the quick-bid button) it isn't rebuilt fresh by renderQuickBids().
  if(bidInFlight) return;
  bidInFlight = true;
  setBidButtonsBusy(true);

  const errBox = document.getElementById('ownerBidError');
  errBox.textContent = '';
  if(auctionPaused){ errBox.textContent = 'Bidding is paused by the host — please wait.'; bidInFlight = false; setBidButtonsBusy(false); return; }
  primeAudio(); // resume audio here, still inside the click's gesture context
  const p = currentPlayer();
  const key = String(p['Auction #']);
  const state = auctionState[key];
  if(state && (state.status === 'sold' || state.status === 'unsold')){
    errBox.textContent = 'Bidding is closed for this player.';
    bidInFlight = false; setBidButtonsBusy(false);
    return;
  }

  let baseForMsg = null; // captured inside the transaction so the catch block can still show the right amount
  let acceptedBid = null;
  let acceptedTimerEndAt = null;
  try{
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(liveDocRef);
      const d = snap.data() || {};
      const liveIdx = (typeof d.currentIdx === 'number') ? d.currentIdx : -1;
      const liveBid = d.currentBid || null;

      // Someone released a different player while this click was in flight —
      // bidding on the wrong player would be worse than just asking to retry.
      if(liveIdx !== currentIdx) throw new Error('STALE_PLAYER');
      if(liveBid && liveBid.team === session.team) throw new Error('ALREADY_HIGHEST');
      const passedList = (d.passedTeams && d.passedTeams[key]) || [];
      if(passedList.includes(session.team)) throw new Error('YOU_PASSED');

      const base = liveBid ? liveBid.priceCr : baseToCr(p['BASE PRICE']);
      baseForMsg = base;
      if(!liveBid){
        // No team has bid on this player yet — the first valid bid must land
        // exactly on the Base Bid amount, not above or below it.
        if(Math.abs(priceCr - base) > 0.001) throw new Error('MUST_MATCH_BASE');
      } else if(priceCr <= base){
        throw new Error('MUST_EXCEED');
      }

      const {cr, count} = teamSpent(session.team);
      if(count >= SQUAD_MAX) throw new Error('SQUAD_FULL');
      if(cr + priceCr > PURSE_CR) throw new Error('PURSE_LOW');

      const newBid = {team: session.team, priceCr};
      const existingHistory = (d.bidHistory && d.bidHistory[key]) || [];
      const newHistory = [...existingHistory, {team: session.team, priceCr}];
      // MOBILE-LAG FIX: the timer reset used to be a second, separate write
      // (startAuctionTimer() → its own liveDocRef.set()) fired only after
      // this transaction fully resolved — two full network round-trips back
      // to back, one waiting on the other. On a slow/mobile connection that
      // second round-trip is exactly what made bidding feel like it took an
      // extra second or two versus a fast desktop connection. Folding the
      // new timerEndAt into this SAME write means the bid and the timer
      // reset land in one round-trip instead of two.
      const newTimerEndAt = Date.now() + clockOffsetMs + 15000;
      // Written from the doc's OWN current bidHistory (read inside this same
      // transaction), not from the local `bidHistory` variable — so two
      // owners bidding at once can no longer make one team's history entry
      // vanish because the other team's stale local copy overwrote it.
      tx.set(liveDocRef, {
        currentBid: newBid,
        timerEndAt: newTimerEndAt,
        [`bidHistory.${key}`]: newHistory
      }, {merge:true});
      acceptedBid = newBid;
      acceptedTimerEndAt = newTimerEndAt;
    });
  }catch(e){
    const messages = {
      STALE_PLAYER: 'The live player changed — please try again.',
      ALREADY_HIGHEST: 'You are already the highest bidder — wait for another team to bid.',
      MUST_MATCH_BASE: `The first bid must be exactly the base price (${fmtCr(baseForMsg)}).`,
      MUST_EXCEED: `Bid must be higher than ${fmtCr(baseForMsg)}.`,
      YOU_PASSED: "You're sitting this player out and can't bid again.",
      SQUAD_FULL: `Your squad already has the maximum ${SQUAD_MAX} players.`,
      PURSE_LOW: 'Not enough purse left for this bid.'
    };
    errBox.textContent = messages[e.message] || 'Could not place bid — please try again.';
    bidInFlight = false;
    setBidButtonsBusy(false); // BUG FIX: the static custom-bid button isn't
                               // rebuilt by renderQuickBids() (only the
                               // quick-bid button is), so it was left stuck
                               // showing "Bidding…" forever after every bid.
    renderLiveBid(); // rebuilds the quick-bid button fresh (enabled) via renderQuickBids()
    return;
  }

  currentBid = acceptedBid;
  timerEndAt = acceptedTimerEndAt; // reflect the new deadline locally right away, no extra round-trip needed
  timerResolvedForIdx = null;
  if(!bidHistory[key]) bidHistory[key] = [];
  bidHistory[key].push({team: session.team, priceCr});
  trackBidForSound(acceptedBid, currentIdx); // immediate tick/heartbeat feedback for the bidder
  trackBiddingTeams(acceptedBid, currentIdx); // may kick off the intense_bid.mp3 loop
  bidInFlight = false;
  setBidButtonsBusy(false); // same fix as above, for the success path
  renderLiveBid(); // rebuilds the quick-bid button fresh (enabled) via renderQuickBids()
}
let bidInFlight = false;
function setBidButtonsBusy(busy){
  const custom = document.getElementById('ownerBidBtn');
  if(custom){ custom.disabled = busy; custom.textContent = busy ? '⏳ BIDDING…' : '🔥 PLACE CUSTOM BID'; }
  document.querySelectorAll('#quickBids .qbid').forEach(b => {
    if(busy){ b.dataset.origText = b.dataset.origText || b.textContent; b.disabled = true; b.textContent = '⏳ Bidding…'; }
  });
}

document.getElementById('ownerBidBtn').onclick = () => {
  const amt = parseFloat(document.getElementById('ownerCustomAmt').value);
  if(!amt || amt <= 0){ document.getElementById('ownerBidError').textContent = 'Enter a valid amount.'; return; }
  const priceCr = ownerUnit === 'L' ? amt/100 : amt;
  placeOwnerBid(priceCr);
  document.getElementById('ownerCustomAmt').value = '';
};
document.getElementById('ownerUnitL').onclick = () => { ownerUnit='L'; document.getElementById('ownerUnitL').classList.add('active'); document.getElementById('ownerUnitC').classList.remove('active'); };
document.getElementById('ownerUnitC').onclick = () => { ownerUnit='C'; document.getElementById('ownerUnitC').classList.add('active'); document.getElementById('ownerUnitL').classList.remove('active'); };

let progressTicksRendered = 0;
function renderProgressTicks(){
  const wrap = document.getElementById('progressTicks');
  if(!wrap || !PLAYERS.length || progressTicksRendered === PLAYERS.length) return;
  wrap.innerHTML = '';
  for(let m = 100; m < PLAYERS.length; m += 100){
    const pct = (m / PLAYERS.length * 100).toFixed(2);
    const tick = document.createElement('div');
    tick.className = 'progress-tick';
    tick.style.left = pct + '%';
    tick.title = `${m} players`;
    wrap.appendChild(tick);
  }
  progressTicksRendered = PLAYERS.length;
}
function updateProgress(){
  const done = Object.keys(auctionState).length;
  document.getElementById('progressLabel').textContent = `${done} / ${PLAYERS.length}`;
  document.getElementById('progressFill').style.width = `${(done/PLAYERS.length*100).toFixed(1)}%`;
  renderProgressTicks();
}

let currentFilter = 'all';

// Host-only: put a specific player up for bidding right now.
// Clears any stale live bid left over from the previous player.
async function releasePlayerByIdx(idx){
  if(!session || session.role !== 'host') return;
  if(idx === currentIdx) return;
  const p = PLAYERS[idx];
  currentIdx = idx;
  // Releasing a player must clear any old Unsold/Sold tag from a previous
  // round — otherwise the main auction screen kept showing "UNSOLD" even
  // though the player was live again, since that old status was never removed.
  // Must delete the specific auctionState.<key> path with FieldValue.delete()
  // — sending the whole (locally-shrunk) auctionState object via merge:true
  // only adds/updates keys, it never removes the old key on the server.
  const fields = {currentIdx, currentBid: null};
  if(p){
    const key = String(p['Auction #']);
    delete auctionState[key];
    fields[`auctionState.${key}`] = firebase.firestore.FieldValue.delete();
  }
  await saveLive(fields);
  resetAudioForNewPlayer();
  renderPlayer();
  renderTeamTable();
  startAuctionTimer();
}

function renderList(filter=''){
  const container = document.getElementById('playerList');
  container.innerHTML = '';
  const f = filter.trim().toLowerCase();
  PLAYERS.forEach((p, idx) => {
    if(f && !p['PLAYER NAME'].toLowerCase().includes(f)) return;
    const key = String(p['Auction #']);
    const state = auctionState[key];

    if(currentFilter === 'sold' && (!state || state.status !== 'sold')) return;
    if(currentFilter === 'unsold' && (!state || state.status !== 'unsold')) return;

    const isHost = session && session.role === 'host';

    const row = document.createElement('div');
    row.className = 'list-row' + (state ? ' done' : '') + (isHost && idx!==currentIdx ? ' host-clickable' : '');
    row.style.borderLeft = idx===currentIdx ? '3px solid var(--gold)' : '3px solid transparent';
    row.dataset.player = p['PLAYER NAME']; // lets refreshRowAvatar() find this row later without a full rebuild
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;min-width:0;">
        ${miniAvatarHTML(p['PLAYER NAME'])}
        <div style="min-width:0;">
          <div class="lname">#${p['Auction #']} ${p['PLAYER NAME']}</div>
          <div class="lmeta">${p['SET']} · ${p['BASE PRICE']}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="lmeta">${state ? (state.status==='sold' ? state.team+' · '+fmtCr(state.priceCr) : 'Unsold') : ''}</span>
        ${state && state.status === 'sold' ? '<button type="button" class="view-history-btn">History</button>' : ''}
        ${isHost ? (idx===currentIdx ? '<span class="lmeta" style="color:var(--gold);">● LIVE NOW</span>' : '<button type="button" class="release-tag">Release ▶</button>') : ''}
      </div>
    `;
    // Only the host can pick a player from the queue and release it for bidding —
    // tapping anywhere on the player's row (e.g. tapping "Virat Kohli") works,
    // not just the button. Owners can see the queue but cannot change who's live.
    if(isHost && idx !== currentIdx){
      const onRelease = (e) => { if(e) e.stopPropagation(); releasePlayerByIdx(idx); };
      row.onclick = onRelease;
      const releaseBtn = row.querySelector('.release-tag');
      if(releaseBtn) releaseBtn.onclick = onRelease;
    }
    // Sold players only — opens the full bid history + final winning bid.
    const historyBtn = row.querySelector('.view-history-btn');
    if(historyBtn){
      historyBtn.onclick = (e) => { e.stopPropagation(); openBidHistoryModal(p, state); };
    }
    container.appendChild(row);
  });
  renderExcelDownloadArea();
}

/* ---------------- Tab-wise Excel downloads (Sold/Unsold queue tabs) ----------------
   Separate from the host's full "Download Auction Data" export above — this
   gives a quick, filtered download that matches whichever tab is currently
   open: the Sold tab downloads the still-upcoming (not yet sold/unsold)
   players, and the Unsold tab downloads just the unsold list. */
function playersToRows(list){
  return list.map(p => ({
    'Auction #': p['Auction #'],
    'Player Name': p['PLAYER NAME'],
    'Set': p['SET'],
    'Base Price': p['BASE PRICE'],
    'Cap/Uncap': p['CAP/UNCAP']
  }));
}
function downloadExcelRows(rows, filename, sheetName){
  if(typeof XLSX === 'undefined'){ customAlert('Excel export library did not load — check your internet connection.'); return; }
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}
function downloadUpcomingPlayers(){
  const upcoming = PLAYERS.filter(p => !auctionState[String(p['Auction #'])]);
  downloadExcelRows(playersToRows(upcoming), 'Upcoming_Players.xlsx', 'Upcoming');
}
function downloadUnsoldPlayers(){
  const unsold = PLAYERS.filter(p => {
    const s = auctionState[String(p['Auction #'])];
    return s && s.status === 'unsold';
  });
  downloadExcelRows(playersToRows(unsold), 'Unsold_Players.xlsx', 'Unsold');
}
function renderExcelDownloadArea(){
  const area = document.getElementById('excelDownloadArea');
  if(!area) return;
  if(currentFilter === 'sold'){
    const count = PLAYERS.filter(p => !auctionState[String(p['Auction #'])]).length;
    area.innerHTML = `<button class="act btn-nav" id="dlUpcomingBtn" style="width:100%;">⬇ Download Upcoming Players (${count}) — Excel</button>`;
    document.getElementById('dlUpcomingBtn').onclick = downloadUpcomingPlayers;
  } else if(currentFilter === 'unsold'){
    const count = PLAYERS.filter(p => { const s = auctionState[String(p['Auction #'])]; return s && s.status==='unsold'; }).length;
    area.innerHTML = `<button class="act btn-nav" id="dlUnsoldBtn" style="width:100%;">⬇ Download Unsold Players (${count}) — Excel</button>`;
    document.getElementById('dlUnsoldBtn').onclick = downloadUnsoldPlayers;
  } else {
    area.innerHTML = '';
  }
}

// "Re-open all Unsold players" only makes sense while looking at the Unsold
// tab — showing it under All/Sold was confusing since it acted on players
// you couldn't even see in that view. Host-only either way.
function updateReopenBtnVisibility(){
  const isHost = session && session.role === 'host';
  document.getElementById('reopenBtn').style.display = (isHost && currentFilter === 'unsold') ? 'inline-block' : 'none';
}

document.querySelectorAll('.ftab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.ftab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.f;
    renderList(document.getElementById('searchBox').value);
    updateReopenBtnVisibility();
  };
});

function renderQuickReleaseResults(term){
  const box = document.getElementById('quickReleaseResults');
  const q = term.trim().toLowerCase();
  if(!q){ box.classList.add('hidden'); box.innerHTML=''; return; }

  const matches = PLAYERS
    .map((p, idx) => ({p, idx}))
    .filter(({p}) => p['PLAYER NAME'].toLowerCase().includes(q))
    .slice(0, 8);

  if(matches.length === 0){
    box.innerHTML = `<div class="qr-empty">No player matches "${term}".</div>`;
    box.classList.remove('hidden');
    return;
  }

  box.innerHTML = '';
  matches.forEach(({p, idx}) => {
    const key = String(p['Auction #']);
    const state = auctionState[key];
    const isLive = idx === currentIdx;
    const row = document.createElement('div');
    row.className = 'qr-row';
    const statusTxt = state ? (state.status === 'sold' ? `Sold · ${state.team} · ${fmtCr(state.priceCr)}` : 'Unsold') : `Base ${p['BASE PRICE']}`;
    row.innerHTML = `
      <div>
        <div class="qr-name">#${p['Auction #']} ${p['PLAYER NAME']}</div>
        <div class="qr-meta">${p['SET']} · ${statusTxt}</div>
      </div>
      ${isLive ? '<span class="lmeta" style="color:var(--gold);">● LIVE NOW</span>' : '<button type="button" class="release-tag">Release ▶</button>'}
    `;
    if(!isLive){
      const btn = row.querySelector('.release-tag');
      btn.onclick = async () => {
        await releasePlayerByIdx(idx);
        document.getElementById('quickReleaseInput').value = '';
        box.classList.add('hidden');
        box.innerHTML = '';
      };
    }
    box.appendChild(row);
  });
  box.classList.remove('hidden');
}

const quickReleaseInput = document.getElementById('quickReleaseInput');
if(quickReleaseInput){
  quickReleaseInput.addEventListener('input', (e) => renderQuickReleaseResults(e.target.value));
  quickReleaseInput.addEventListener('focus', (e) => { if(e.target.value.trim()) renderQuickReleaseResults(e.target.value); });
  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.quick-release-wrap');
    if(wrap && !wrap.contains(e.target)){
      document.getElementById('quickReleaseResults').classList.add('hidden');
    }
  });
}

async function reopenUnsold(){
  const unsoldKeys = Object.keys(auctionState).filter(k => auctionState[k].status === 'unsold');
  if(unsoldKeys.length === 0){
    await customAlert('No unsold players to re-open right now.');
    return;
  }
  const ok = await customConfirm(`Re-open ${unsoldKeys.length} unsold player(s) so they can be auctioned again?`);
  if(!ok) return;
  // Field-path FieldValue.delete() per key — sending the whole shrunk
  // auctionState/bidHistory objects via merge:true would leave every one of
  // these old server-side keys untouched (merge only adds/updates keys,
  // never removes ones missing from what you send).
  const fields = {};
  unsoldKeys.forEach(k => {
    delete auctionState[k];
    delete bidHistory[k];
    fields[`auctionState.${k}`] = firebase.firestore.FieldValue.delete();
    fields[`bidHistory.${k}`] = firebase.firestore.FieldValue.delete();
  });
  await saveLive(fields);
  renderPlayer();
  renderTeamTable();
}
document.getElementById('reopenBtn').onclick = reopenUnsold;

// Host-only: exports the full auction sheet (every player + result) plus a
// team purse summary as a downloadable .xlsx workbook.
function exportAuctionExcel(){
  if(typeof XLSX === 'undefined'){
    customAlert('The Excel export library failed to load — check your internet connection and try again.');
    return;
  }
  const rows = PLAYERS.map(p => {
    const key = String(p['Auction #']);
    const state = auctionState[key];
    const status = state ? (state.status === 'sold' ? 'SOLD' : 'UNSOLD') : 'PENDING';
    return {
      'Auction #': p['Auction #'],
      'Player Name': p['PLAYER NAME'],
      'Set': p['SET'],
      'Base Price': p['BASE PRICE'],
      'Cap/Uncap': p['CAP/UNCAP'],
      'Status': status,
      'Team': (state && state.status === 'sold') ? state.team : '',
      'Sold Price (Cr)': (state && state.status === 'sold') ? state.priceCr : ''
    };
  });
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{wch:11},{wch:26},{wch:14},{wch:11},{wch:11},{wch:10},{wch:8},{wch:15}];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Auction Data');

  const teamRows = TEAMS.map(team => {
    const {cr, count} = teamSpent(team);
    return {
      'Team': team,
      'Players Bought': count,
      'Spent (Cr)': +cr.toFixed(2),
      'Purse Left (Cr)': +(PURSE_CR - cr).toFixed(2)
    };
  });
  const ws2 = XLSX.utils.json_to_sheet(teamRows);
  ws2['!cols'] = [{wch:8},{wch:15},{wch:12},{wch:14}];
  XLSX.utils.book_append_sheet(wb, ws2, 'Team Purse Summary');

  const stamp = new Date().toISOString().slice(0,16).replace(/[:T]/g,'-');
  XLSX.writeFile(wb, `SPL_Season3_Auction_${stamp}.xlsx`);
}
document.getElementById('exportExcelBtn').onclick = exportAuctionExcel;
document.getElementById('pauseToggleBtn').onclick = togglePause;
document.getElementById('autoAdvanceToggleBtn').onclick = toggleAutoAdvance;
document.getElementById('startAuctionBtn').onclick = async () => {
  if(!session || session.role !== 'host') return;
  auctionStarted = true;
  await saveStarted();
  renderHostStartUI();
};

function showModal(msg, buttons){
  return new Promise(resolve => {
    const overlay = document.getElementById('modalOverlay');
    document.getElementById('modalMsg').textContent = msg;
    const actions = document.getElementById('modalActions');
    actions.innerHTML = '';
    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.className = 'act ' + (b.cls || 'btn-nav');
      btn.textContent = b.label;
      btn.onclick = () => { overlay.style.display = 'none'; resolve(b.value); };
      actions.appendChild(btn);
    });
    overlay.style.display = 'flex';
  });
}
function customConfirm(msg){
  return showModal(msg, [
    {label:'Cancel', value:false, cls:'btn-nav'},
    {label:'Yes, proceed', value:true, cls:'btn-sold'}
  ]);
}
function customAlert(msg){
  return showModal(msg, [{label:'OK', value:true, cls:'btn-nav'}]);
}

async function markSold(){
  if(auctionPaused){ await customAlert('The auction is paused. Resume it before marking a player sold.'); return; }
  const team = document.getElementById('teamSelect').value;
  const amt = parseFloat(document.getElementById('priceInput').value);
  if(!team){ await customAlert('Select a team first'); return; }
  if(!amt || amt <= 0){ await customAlert('Enter a valid sold price'); return; }
  const priceCr = amt;

  const {cr} = teamSpent(team);
  const {count} = teamSpent(team);
  if(count >= SQUAD_MAX){
    await customAlert(`${team} already has the maximum ${SQUAD_MAX} players. Pick a different team or undo one of their players first.`);
    return;
  }
  if(cr + priceCr > PURSE_CR){
    const ok = await customConfirm(`${team} only has ${(PURSE_CR-cr).toFixed(2)} Cr left. Proceed anyway?`);
    if(!ok) return;
  }

  const p = currentPlayer();
  if(!p){ await customAlert('No player is live right now.'); return; }
  const key = String(p['Auction #']);
  primeAudio();
  playSoldMp3(); // play immediately, tied to this click — most reliable across browsers
  locallyHandledResultKeys.add(key);
  auctionState[key] = {status:'sold', team, priceCr};
  lastResolvedKey = key;
  lastResolvedIdx = currentIdx;
  await saveState();
  await saveBid(null);
  await clearAuctionTimer();
  fireConfetti();
  renderPlayer();
  renderTeamTable();
  scheduleAutoAdvance();
}

async function markUnsold(){
  if(auctionPaused){ await customAlert('The auction is paused. Resume it before marking a player unsold.'); return; }
  const p = currentPlayer();
  if(!p) return;
  const key = String(p['Auction #']);
  primeAudio();
  playUnsoldMp3(); // play immediately, tied to this click — most reliable across browsers
  locallyHandledResultKeys.add(key);
  auctionState[key] = {status:'unsold'};
  lastResolvedKey = key;
  lastResolvedIdx = currentIdx;
  await saveState();
  await saveBid(null);
  await clearAuctionTimer();
  fireUnsoldShake();
  renderPlayer();
  renderTeamTable();
  scheduleAutoAdvance();
}

async function undoPlayer(){
  const p = currentPlayer();
  if(!p) return;
  const key = String(p['Auction #']);
  delete auctionState[key];
  delete bidHistory[key]; // player goes back to the queue — wipe its old bid trail too
  // Field-path FieldValue.delete() — sending the whole shrunk auctionState/
  // bidHistory objects via merge:true would leave the old server-side key
  // untouched (merge only adds/updates keys, never removes missing ones).
  await saveLive({
    currentBid: null,
    [`auctionState.${key}`]: firebase.firestore.FieldValue.delete(),
    [`bidHistory.${key}`]: firebase.firestore.FieldValue.delete()
  });
  resetAudioForNewPlayer();
  renderPlayer();
  renderTeamTable();
  startAuctionTimer();
}

// Undoes the most recently sold/unsold player, no matter how many players
// the host has already moved past since — unlike undoPlayer() above, which
// only works on whichever player happens to be live right now.
async function undoLastResolved(){
  if(!lastResolvedKey || !auctionState[lastResolvedKey]){
    await customAlert('No recent sale to undo.');
    return;
  }
  const key = lastResolvedKey;
  const idx = lastResolvedIdx;
  const wasSold = auctionState[key].status === 'sold';
  const label = wasSold ? `${auctionState[key].team} · ${fmtCr(auctionState[key].priceCr)}` : 'Unsold';
  const p = PLAYERS_BY_KEY[key];
  const ok = await customConfirm(`Undo the last result — ${p ? p['PLAYER NAME'] : 'this player'} (${label})?`);
  if(!ok) return;

  delete auctionState[key];
  delete bidHistory[key];
  await saveLive({
    currentIdx: idx,
    currentBid: null,
    [`auctionState.${key}`]: firebase.firestore.FieldValue.delete(),
    [`bidHistory.${key}`]: firebase.firestore.FieldValue.delete()
  });
  currentIdx = idx;
  lastResolvedKey = null;
  lastResolvedIdx = null;
  resetAudioForNewPlayer();
  renderPlayer();
  renderTeamTable();
  startAuctionTimer();
}

// Auto Auction Mode: called after a player is resolved (sold/unsold). If the
// host has Auto Auction on, waits 3s — same as a real auctioneer pausing
// before the next lot — then hands off to goNextAvailable(). A single
// pending timeout is enforced so a player can never be double-loaded, and
// stopping Auto Auction (toggleAutoAdvance) cancels this if it's mid-wait.
function scheduleAutoAdvance(){
  if(!autoAdvance) return;
  if(autoAdvanceTimeoutHandle){ clearTimeout(autoAdvanceTimeoutHandle); }
  const idxAtSchedule = currentIdx;
  autoAdvanceTimeoutHandle = setTimeout(() => {
    autoAdvanceTimeoutHandle = null;
    // Bail if Auto Auction was turned off, or the host already moved on
    // manually, during the 3s wait.
    if(!autoAdvance || currentIdx !== idxAtSchedule) return;
    goNextAvailable();
  }, 3000);
}

// Loads the next player that hasn't been sold/unsold yet (skipping over any
// already-resolved entries), so Auto Auction never reloads a finished player.
// Stops itself and hands control back to the host once none remain.
function goNextAvailable(){
  for(let i = currentIdx + 1; i < PLAYERS.length; i++){
    const key = String(PLAYERS[i]['Auction #']);
    if(!auctionState[key]){
      currentIdx = i; saveLive({currentIdx, currentBid: null});
      resetAudioForNewPlayer();
      renderPlayer();
      renderTeamTable();
      startAuctionTimer();
      return;
    }
  }
  autoAdvance = false;
  liveDocRef.set({autoAdvance:false}, {merge:true}).catch(e => console.error('saveAutoAdvance failed', e));
  renderAutoAdvanceUI();
}

function goNext(){
  if(currentIdx >= 0 && currentIdx < PLAYERS.length-1){
    currentIdx++; saveLive({currentIdx, currentBid: null});
    resetAudioForNewPlayer();
    renderPlayer();
    startAuctionTimer();
  }
}
function goPrev(){
  if(currentIdx > 0){
    currentIdx--; saveLive({currentIdx, currentBid: null});
    resetAudioForNewPlayer();
    renderPlayer();
    startAuctionTimer();
  }
}

async function resetAll(){
  const ok = await customConfirm('Reset the ENTIRE auction? This clears all sold/unsold data.');
  if(!ok) return;
  auctionState = {};
  bidHistory = {};
  currentIdx = -1;
  presence = {};
  passedTeamsCache = {};
  auctionPaused = false;
  autoAdvance = false;
  auctionStarted = false;
  if(autoAdvanceTimeoutHandle){ clearTimeout(autoAdvanceTimeoutHandle); autoAdvanceTimeoutHandle = null; }
  // auctionState/bidHistory/presence must be removed with FieldValue.delete()
  // — merge:true only ever ADDS/UPDATES keys, it never deletes ones missing
  // from the object you send, so sending {} here would silently leave all
  // the old sold/unsold data sitting on the server untouched.
  await saveLive({
    currentIdx, currentBid: null,
    paused: false, timerEndAt: null, autoAdvance: false, auctionStarted: false,
    auctionState: firebase.firestore.FieldValue.delete(),
    bidHistory: firebase.firestore.FieldValue.delete(),
    presence: firebase.firestore.FieldValue.delete(),
    passedTeams: firebase.firestore.FieldValue.delete() // otherwise a stale "Out" from the last auction would
                                                          // incorrectly still apply to whichever player reuses that key
  });
  timerEndAt = null;
  timerResolvedForIdx = null;
  resetAudioForNewPlayer();
  renderPlayer();
  renderTeamTable();
  renderJoinStatus();
  renderPassedBar();
  renderPauseUI();
  renderAutoAdvanceUI();
  renderHostStartUI();
}

document.getElementById('btnSold').onclick = markSold;
document.getElementById('btnUnsold').onclick = markUnsold;
document.getElementById('btnUndo').onclick = undoPlayer;
document.getElementById('btnUndoLast').onclick = undoLastResolved;
document.getElementById('btnNext').onclick = goNext;
document.getElementById('btnPrev').onclick = goPrev;
document.getElementById('resetBtn').onclick = resetAll;
// Debounced: without this, every keystroke rebuilt the entire (up to ~600
// row) queue list immediately — noticeable stutter for a fast typer on a
// lower-end phone. 120ms is short enough to still feel instant.
let searchBoxDebounce = null;
document.getElementById('searchBox').oninput = (e) => {
  const val = e.target.value;
  clearTimeout(searchBoxDebounce);
  searchBoxDebounce = setTimeout(() => renderList(val), 120);
};

/* ---------------- AUTH / LOGIN ---------------- */

let pwdOverrides = {}; // usernames who changed their password from within the app: {HOST:'...', RCB:'...', ...}

async function loadPwdOverrides(){
  try{
    const snap = await liveDocRef.get();
    const d = snap.data();
    pwdOverrides = (d && d.pwdOverrides) ? d.pwdOverrides : {};
  }catch(e){ console.error('loadPwdOverrides failed', e); pwdOverrides = {}; }
}
async function savePwdOverrides(){
  try{ await liveDocRef.set({pwdOverrides}, {merge:true}); }catch(e){ console.error('savePwdOverrides failed', e); }
}

function effectivePassword(role, team){
  const key = role === 'host' ? 'HOST' : team;
  if(pwdOverrides[key]) return pwdOverrides[key];
  return role === 'host' ? CREDENTIALS.host.password : CREDENTIALS.teams[team];
}

/* ---------------- PRESENCE (who has joined) ---------------- */

let presence = {}; // kept only for backward-compat with old saved docs; no longer used to decide joined/missing (see below)
let sessionLocksCache = {}; // {RCB:{sid,lastSeen}, ...} — refreshed from every live snapshot

async function loadPresence(){
  try{
    const snap = await liveDocRef.get();
    const d = snap.data();
    presence = (d && d.presence) ? d.presence : {};
    sessionLocksCache = (d && d.sessionLocks) ? d.sessionLocks : {};
  }catch(e){ console.error('loadPresence failed', e); presence = {}; }
}
async function savePresence(){
  try{ await liveDocRef.set({presence}, {merge:true}); }catch(e){ console.error('savePresence failed', e); }
}
async function markTeamPresent(team){
  // Writing straight to the nested `presence.<team>` path is atomic — no
  // read-then-write race. The old version did loadPresence() then merged
  // locally before saving, so two owners joining at nearly the same moment
  // could each save from a stale copy and the join count would undercount.
  try{
    await liveDocRef.set({ ['presence.' + team]: true }, {merge:true});
  }catch(e){ console.error('markTeamPresent failed', e); }
  presence[team] = true;
}
// BUG FIX: this used to just read the `presence` flag, which was set true on
// login and only ever set false by an explicit Logout click — so a team that
// closed their tab (crash, phone locked, browser killed) without logging out
// stayed "joined" forever with no way to tell the host they'd actually left.
// Now a team only counts as joined while their login-lock heartbeat (see the
// session-lock feature above) has pinged in the last SESSION_LOCK_STALE_MS —
// so it self-corrects within ~25s of them actually disappearing, same as the
// login-lock itself, with no extra bookkeeping needed.
function joinedTeams(){
  return TEAMS.filter(t => {
    const lock = sessionLocksCache[t];
    return lock && (Date.now() - (lock.lastSeen || 0) < SESSION_LOCK_STALE_MS);
  });
}
function missingTeams(){
  const joined = new Set(joinedTeams());
  return TEAMS.filter(t => !joined.has(t));
}
// Same heartbeat freshness check as joinedTeams(), just for a single team —
// used to draw the online/offline dot in both the host's Purse Tracker and
// the owner-facing Auction Summary.
function isTeamOnline(team){
  const lock = sessionLocksCache[team];
  return !!(lock && (Date.now() - (lock.lastSeen || 0) < SESSION_LOCK_STALE_MS));
}

function renderJoinStatus(){
  const card = document.getElementById('joinStatusCard');
  if(!card) return;
  // Only relevant before the auction has started; hide once the host has released the first player.
  if(currentIdx !== -1){ card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const joined = joinedTeams();
  const missing = missingTeams();
  document.getElementById('joinStatusCount').textContent = `${joined.length}/${TEAMS.length} teams joined`;
  const labelEl = document.getElementById('joinStatusMissingLabel');
  const listEl = document.getElementById('joinStatusMissing');
  if(missing.length === 0){
    labelEl.innerHTML = '<span style="color:var(--green);font-weight:700;">Everyone has joined ✓</span>';
    listEl.innerHTML = '';
  }else{
    labelEl.textContent = 'Waiting for:';
    listEl.innerHTML = missing.map(t => `<span class="badge">${t}</span>`).join('');
  }
}

/* ---------------- PRESENCE HEARTBEAT (Host + all 12 teams) ----------------
   This no longer enforces one-device-per-account. Each account just
   "heartbeats" sessionLocks.<account> with a random id (sid) for this tab
   every 10s, purely so other tabs can show accurate online/offline status
   dots via isTeamOnline()/joinedTeams(). Logging in on a second device no
   longer blocks the login and no longer signs the first device out.
*/
const SESSION_LOCK_STALE_MS = 25000; // how long a lock can go quiet before it's considered abandoned
const SESSION_HEARTBEAT_MS = 10000;  // how often this tab reconfirms its lock is still active
let mySessionSid = null;
let sessionHeartbeatTimer = null;
let currentHeartbeatLockKey = null; // which lock the running timer is refreshing, so a resume can re-beat it

function sessionLockKey(role, team){ return role === 'host' ? 'HOST' : team; }
function genSid(){ return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }

async function sessionHeartbeatBeat(){
  if(!mySessionSid || !currentHeartbeatLockKey) return;
  // Same fix as the login transaction above: write the whole sessionLocks
  // map (read-modify-write) instead of the dotted-key merge shortcut, since
  // that shortcut was the actual cause of the stuck "0/12 joined" bug.
  try{
    const snap = await liveDocRef.get();
    const d = snap.data() || {};
    const locks = Object.assign({}, d.sessionLocks || {});
    locks[currentHeartbeatLockKey] = {sid: mySessionSid, lastSeen: Date.now()};
    await liveDocRef.set({ sessionLocks: locks }, {merge:true});
  }catch(e){ console.error('session heartbeat failed', e); }
}
function startSessionHeartbeat(lockKey){
  stopSessionHeartbeat();
  currentHeartbeatLockKey = lockKey;
  sessionHeartbeatBeat(); // refresh right away — important right after a page reload, before the next 10s tick
  sessionHeartbeatTimer = setInterval(sessionHeartbeatBeat, SESSION_HEARTBEAT_MS);
}
function stopSessionHeartbeat(){
  if(sessionHeartbeatTimer){ clearInterval(sessionHeartbeatTimer); sessionHeartbeatTimer = null; }
  currentHeartbeatLockKey = null;
}
// Mobile WebViews throttle or fully suspend setInterval timers while the app
// is backgrounded (screen locked, user switched apps) to save battery — so
// the 10s heartbeat can silently stop ticking for longer than the 25s stale
// window, making a still-logged-in player look "offline" or occasionally
// get treated as if their session lapsed. Firing one beat immediately the
// moment the app becomes visible again (before the next scheduled tick)
// closes that gap in the common case of a quick app-switch or screen lock.
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState === 'visible' && sessionHeartbeatTimer){
    sessionHeartbeatBeat();
    renderJoinStatus();
    updateAllStatusDots();
  }
});

function checkCredentials(username, password){
  const u = (username || '').trim();
  if(u.toLowerCase() === 'host'){
    if(password === effectivePassword('host', null)) return {role:'host', team:null};
    return null;
  }
  const teamCode = TEAMS.find(t => t.toLowerCase() === u.toLowerCase());
  if(teamCode && password === effectivePassword('owner', teamCode)){
    return {role:'owner', team:teamCode};
  }
  return null;
}

function saveSession(s){
  session = s;
  try{ sessionStorage.setItem('sslt10-session', JSON.stringify(s)); }catch(e){}
}
function loadSession(){
  try{
    const raw = sessionStorage.getItem('sslt10-session');
    if(raw) session = JSON.parse(raw);
  }catch(e){ session = null; }
}
function clearSession(){
  session = null;
  try{ sessionStorage.removeItem('sslt10-session'); }catch(e){}
}

function applyRoleUI(){
  const isHost = session && session.role === 'host';
  const isOwner = session && session.role === 'owner';

  document.getElementById('hostControls').classList.toggle('hidden', !isHost);
  document.getElementById('ownerControls').classList.toggle('hidden', !isOwner);
  document.getElementById('myTeamCard').classList.toggle('hidden', !isOwner);
  document.getElementById('auctionSummaryCard').classList.toggle('hidden', !isOwner);
  document.getElementById('purseTrackerCard').classList.toggle('hidden', !isHost);
  document.getElementById('resetBtn').style.display = isHost ? 'inline-block' : 'none';
  document.getElementById('adminResetPwdBtn').style.display = isHost ? 'inline-block' : 'none';
  updateReopenBtnVisibility();

  const badge = document.getElementById('roleBadge');
  badge.textContent = isHost ? '🎙 HOST — running the auction' : `🏏 ${session.team} — Franchise Owner`;
}

// Auto-pause safety net: if the HOST's device goes offline mid-auction, the
// countdown timer and owner bidding would otherwise keep running with no one
// steering it. Pausing (host-only, mirrors the existing manual Pause button)
// freezes things the moment connectivity drops. Deliberately does NOT
// auto-resume on 'online' — the host should confirm things look right and
// resume manually.
window.addEventListener('offline', () => {
  if(session && session.role === 'host' && !auctionPaused && auctionStarted){
    togglePause();
    const s = document.getElementById('status');
    if(s) s.innerText = '🔴 You went offline — auction auto-paused. Resume it once you\'re back.';
  }
});
window.addEventListener('online', () => {
  if(session && session.role === 'host' && auctionPaused){
    const s = document.getElementById('status');
    if(s) s.innerText = '🟢 Back online — resume the auction when ready.';
  }
});

let loginInFlight = false; // guards against double-submit while a login attempt is still pending

async function doLogin(){
  // Ignore extra clicks/Enter-presses while a previous attempt hasn't
  // resolved yet — without this, tapping again during the network round
  // trip below could fire a second overlapping login attempt.
  if(loginInFlight) return;

  primeAudio();
  const user = document.getElementById('loginUser').value;
  const pass = document.getElementById('loginPass').value;
  const errBox = document.getElementById('loginError');
  const loginBtn = document.getElementById('loginBtn');

  loginInFlight = true;
  errBox.textContent = '';
  const originalBtnText = loginBtn.textContent;
  loginBtn.disabled = true;
  loginBtn.textContent = 'Logging in…';

  try{
    await loadPwdOverrides();
    const result = checkCredentials(user, pass);
    if(!result){ errBox.textContent = 'Invalid username or password.'; return; }

    const lockKey = sessionLockKey(result.role, result.team);
    const sid = genSid();
    // Single-device exclusivity removed — logging in here just (re)claims
    // the presence heartbeat for this account instead of blocking the login
    // or kicking any other already-signed-in device.
    try{
      const snap = await liveDocRef.get();
      const d = snap.data() || {};
      const locks = Object.assign({}, d.sessionLocks || {});
      locks[lockKey] = {sid, lastSeen: Date.now()};
      await liveDocRef.set({ sessionLocks: locks }, {merge:true});
    }catch(e){
      console.error('session lock write failed', e);
      // Non-fatal — presence/online-status just won't update for this
      // login, but the login itself still proceeds.
    }

    mySessionSid = sid;
    result.sid = sid; // persisted so a page refresh can recover it (see init() below)
    saveSession(result);
    errBox.textContent = '';
    startSessionHeartbeat(lockKey);
    await enterApp();
  } finally {
    // Only restore the button if we're still on the login screen — a
    // successful login already swaps to the main app, so touching the
    // button there would just be a harmless no-op.
    loginInFlight = false;
    loginBtn.disabled = false;
    loginBtn.textContent = originalBtnText;
  }
}

let logoutInFlight = false; // same double-tap problem as login: no earlier guard meant a second tap during the pending network calls fired a second concurrent doLogout()

async function doLogout(){
  if(logoutInFlight) return;
  logoutInFlight = true;
  const logoutBtn = document.getElementById('logoutBtn');
  logoutBtn.disabled = true;

  // VOICE CLEANUP — first and unconditionally, so it still runs even if
  // something below throws. Fully disconnects LiveKit (stops the mic
  // capture, stops playback of every remote speaker, drops the room
  // connection and all its event listeners) and cancels any pending
  // auto-reconnect timer, so no background voice connection survives
  // logout.
  try{
    if(typeof leaveVoiceRoom === 'function') await leaveVoiceRoom();
  }catch(e){ console.error('leaveVoiceRoom during logout failed', e); }

  // Owner logging out must clear their team's presence flag — otherwise the
  // "joined teams" count stayed inflated forever after the first join, since
  // nothing ever set presence[team] back to false.
  if(session && session.role === 'owner' && session.team){
    try{ await liveDocRef.set({ ['presence.' + session.team]: false }, {merge:true}); }catch(e){ console.error('clearPresence failed', e); }
    presence[session.team] = false;
  }
  // Release this account's login lock immediately so another device can log
  // in right away instead of waiting for the 25s staleness window.
  if(session){
    const lockKey = sessionLockKey(session.role, session.team);
    try{ await liveDocRef.set({ [`sessionLocks.${lockKey}`]: firebase.firestore.FieldValue.delete() }, {merge:true}); }catch(e){ console.error('releaseLock failed', e); }
  }
  stopSessionHeartbeat();
  mySessionSid = null;
  clearSession(); // wipes sessionStorage's saved login (sslt10-session)

  // Stop this tab's live Firestore subscription — no background listener,
  // no further writes/reads happen for this session after this point.
  if(liveUnsubscribe){ liveUnsubscribe(); liveUnsubscribe = null; }
  if(autoAdvanceTimeoutHandle){ clearTimeout(autoAdvanceTimeoutHandle); autoAdvanceTimeoutHandle = null; }

  // CLEAR TEMPORARY AUCTION STATE — everything below is re-hydrated fresh
  // from Firestore by enterApp() on the next login, so it's safe (and
  // correct — prevents stale data flashing, and frees the memory) to wipe
  // it all here rather than carry it across logins.
  auctionState = {};
  bidHistory = {};
  currentBid = null;
  currentIdx = -1;
  passedTeamsCache = {};
  presence = {};
  sessionLocksCache = {};
  pwdOverrides = {};
  timerEndAt = null;
  auctionPaused = false;
  autoAdvance = false;
  auctionStarted = false;
  lastResolvedKey = null;
  lastResolvedIdx = null;
  locallyHandledResultKeys.clear();

  // CLEAR CHAT SESSION — messages, unread state, notification tracking,
  // and the picked sender name/alias all belong to this login only.
  chatMessagesCache = [];
  chatSeenCount = 0;
  chatPanelOpen = false;
  chatSynced = false;
  lastSeenChatTs = 0;
  chatSenderOverride = null;
  try{ sessionStorage.removeItem('sslt10-chatSender'); }catch(e){}
  clearAllChatToasts();
  const chatPanelEl = document.getElementById('chatPanel');
  if(chatPanelEl) chatPanelEl.classList.add('hidden');
  const chatBadgeEl = document.getElementById('chatBadge');
  if(chatBadgeEl) chatBadgeEl.classList.add('hidden');
  const chatFabEl = document.getElementById('chatFab');
  if(chatFabEl) chatFabEl.classList.add('hidden');
  const chatMessagesEl = document.getElementById('chatMessages');
  if(chatMessagesEl) chatMessagesEl.innerHTML = '';
  const chatInputEl = document.getElementById('chatInput');
  if(chatInputEl) chatInputEl.value = '';
  const chatNameEditLabelEl = document.getElementById('chatNameEditLabel');
  if(chatNameEditLabelEl) chatNameEditLabelEl.textContent = '';
  const chatNameModalEl = document.getElementById('chatNameModalOverlay');
  if(chatNameModalEl) chatNameModalEl.style.display = 'none';
  chatNameModalThenOpenPanel = false;

  bidSoundTracker.primed = false;
  bidSoundTracker.sig = null;
  bidSoundTracker.idx = null;
  bidSoundTracker.streak = 0;
  resetAudioForNewPlayer();

  document.getElementById('mainApp').classList.add('hidden');
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('pausedBanner').classList.add('hidden');

  logoutInFlight = false;
  logoutBtn.disabled = false;
}

document.getElementById('viewMySquadBtn').onclick = () => {
  if(session && session.team) openSquadModal(session.team);
};

document.getElementById('adminResetPwdBtn').onclick = () => {
  document.getElementById('adminPwdNew').value = '';
  document.getElementById('adminPwdConfirm').value = '';
  document.getElementById('adminPwdError').textContent = '';
  document.getElementById('adminPwdModalOverlay').style.display = 'flex';
};
document.getElementById('adminPwdCancelBtn').onclick = () => {
  document.getElementById('adminPwdModalOverlay').style.display = 'none';
};
document.getElementById('adminPwdSaveBtn').onclick = async () => {
  const team = document.getElementById('adminPwdTeam').value;
  const next = document.getElementById('adminPwdNew').value;
  const confirmVal = document.getElementById('adminPwdConfirm').value;
  const errBox = document.getElementById('adminPwdError');

  if(!next || next.length < 4){
    errBox.textContent = 'New password must be at least 4 characters.';
    return;
  }
  if(next !== confirmVal){
    errBox.textContent = 'New password and confirmation do not match.';
    return;
  }
  await loadPwdOverrides();
  pwdOverrides[team] = next;
  await savePwdOverrides();
  document.getElementById('adminPwdModalOverlay').style.display = 'none';
  await customAlert(`Password for ${team} has been reset. Share the new password with them directly.`);
};

document.getElementById('loginBtn').onclick = doLogin;
// Android WebView has a long-standing quirk (not specific to this app) where
// the very first tap on a text input right after the page/keyboard-hosting
// view finishes initializing sometimes registers the tap but doesn't hand
// focus to the input, so no keyboard appears — the second tap then works
// because focus state has settled. Forcing an explicit .focus() call on
// touchend (in addition to the browser's own click-driven focus) gives the
// input a second, independent chance to grab focus in that situation,
// without changing behavior on devices where the first tap already worked.
['loginUser','loginPass'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('touchend', () => { el.focus(); }, {passive:true});
});
document.getElementById('loginPass').addEventListener('keydown', e => { if(e.key === 'Enter') doLogin(); });
document.getElementById('logoutBtn').onclick = doLogout;
document.getElementById('muteToggleBtn').onclick = () => setSoundMuted(!soundMuted);
updateMuteBtn();

/* ---------------- Password show/hide toggles ---------------- */
function setupPasswordToggle(inputId, btnId){
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if(!input || !btn) return;
  btn.textContent = 'SHOW'; // password starts hidden, so the button offers to reveal it
  btn.onclick = () => {
    const nowHidden = input.type === 'password';
    input.type = nowHidden ? 'text' : 'password';
    btn.textContent = nowHidden ? 'HIDE' : 'SHOW';
    btn.setAttribute('aria-label', nowHidden ? 'Hide password' : 'Show password');
  };
}
[
  ['loginPass','loginPassToggle'],
  ['adminPwdNew','adminPwdNewToggle'],
  ['adminPwdConfirm','adminPwdConfirmToggle'],
  ['pwdCurrent','pwdCurrentToggle'],
  ['pwdNew','pwdNewToggle'],
  ['pwdConfirm','pwdConfirmToggle']
].forEach(([inputId, btnId]) => setupPasswordToggle(inputId, btnId));

document.getElementById('changePwdBtn').onclick = () => {
  document.getElementById('pwdCurrent').value = '';
  document.getElementById('pwdNew').value = '';
  document.getElementById('pwdConfirm').value = '';
  document.getElementById('pwdError').textContent = '';
  document.getElementById('pwdModalOverlay').style.display = 'flex';
};
document.getElementById('pwdCancelBtn').onclick = () => {
  document.getElementById('pwdModalOverlay').style.display = 'none';
};
document.getElementById('pwdSaveBtn').onclick = async () => {
  const cur = document.getElementById('pwdCurrent').value;
  const next = document.getElementById('pwdNew').value;
  const confirmVal = document.getElementById('pwdConfirm').value;
  const errBox = document.getElementById('pwdError');

  await loadPwdOverrides();
  if(cur !== effectivePassword(session.role, session.team)){
    errBox.textContent = 'Current password is wrong.';
    return;
  }
  if(!next || next.length < 4){
    errBox.textContent = 'New password must be at least 4 characters.';
    return;
  }
  if(next !== confirmVal){
    errBox.textContent = 'New password and confirmation do not match.';
    return;
  }
  const key = session.role === 'host' ? 'HOST' : session.team;
  pwdOverrides[key] = next;
  await savePwdOverrides();
  document.getElementById('pwdModalOverlay').style.display = 'none';
  await customAlert('Password changed successfully. Use the new password next time you log in.');
};

let liveUnsubscribe = null;

// Real-time sync: every device (host + all 12 owners) is listening to the
// same Firestore document. The moment anyone writes a change, everyone else's
// screen updates instantly — no polling delay.
function startLiveSync(){
  if(liveUnsubscribe) liveUnsubscribe();
  liveUnsubscribe = liveDocRef.onSnapshot((snap) => {
    const d = snap.data() || {};
    const prevAuctionState = auctionState;
    const prevIdx = currentIdx;

    auctionState = d.auctionState || {};
    bidHistory = d.bidHistory || {};
    currentIdx = (typeof d.currentIdx === 'number') ? d.currentIdx : -1;
    currentBid = d.currentBid || null;
    auctionPaused = !!d.paused;
    pwdOverrides = d.pwdOverrides || {};
    presence = d.presence || {};
    timerEndAt = (typeof d.timerEndAt === 'number') ? d.timerEndAt : null;
    autoAdvance = !!d.autoAdvance;
    auctionStarted = !!d.auctionStarted;
    sessionLocksCache = d.sessionLocks || {}; // used by joinedTeams()/missingTeams() to check heartbeat freshness below
    passedTeamsCache = d.passedTeams || {};
    const prevChatCount = chatMessagesCache.length;
    chatMessagesCache = d.chatMessages || [];

    // Single-device forced-logout check removed — this tab no longer signs
    // itself out just because another device logged into the same account.
    // sessionLocksCache is still updated above and still drives the
    // online/offline status dots via isTeamOnline()/joinedTeams().

    // Sold/unsold sounds — fire for every device the instant a player's
    // result is written, whether it was this device or another one (unless
    // this device already played it directly from its own button click or
    // the timer expiring locally).
    const p = currentPlayer();
    Object.keys(auctionState).forEach(key => {
      if(!prevAuctionState[key] && auctionState[key]){
        if(locallyHandledResultKeys.has(key)){
          locallyHandledResultKeys.delete(key);
          return;
        }
        const result = auctionState[key];
        const playerName = (p && String(p['Auction #']) === key) ? p['PLAYER NAME']
          : (PLAYERS_BY_KEY[key] || {})['PLAYER NAME'];
        if(result.status === 'sold'){
          playSoldMp3();
          fireConfetti();
        } else if(result.status === 'unsold'){
          playUnsoldMp3();
          fireUnsoldShake();
        }
      }
    });
    // Bid-pace sound (tick, or heartbeat once bidding turns rapid) + the
    // intense bidding-war loop (10Cr+ with 2+ teams involved).
    trackBidForSound(currentBid, currentIdx);
    trackBiddingTeams(currentBid, currentIdx);

    // CHAT POPUP NOTIFICATIONS: fire a toast + sound for every incoming
    // message that isn't our own. Skipped entirely on the very first
    // snapshot after login (chatSynced still false) — otherwise the last
    // up-to-50 saved messages would all pop as "new" the moment you log in.
    if(chatSynced){
      chatMessagesCache.forEach(m => {
        if((m.ts || 0) > lastSeenChatTs && !isOwnChatMessage(m)) showChatToast(m);
      });
    }
    if(chatMessagesCache.length){
      lastSeenChatTs = chatMessagesCache.reduce((max, m) => Math.max(max, m.ts || 0), lastSeenChatTs);
    }
    chatSynced = true;

    // PERFORMANCE: renderPlayer()/renderTeamTable() rebuild the ~600-player
    // queue list and the whole team table from scratch (innerHTML='' + full
    // loop). Firing that on every single snapshot — including a plain bid
    // amount changing — is what caused the lag/jank during bidding wars,
    // since a fast bidding war can trigger many snapshots per second.
    // Only do the expensive full rebuild when something actually affects the
    // queue/team table's CONTENT (a sale/unsale, or the live player itself
    // changing). A pure bid-amount update just needs the live bid box and
    // the leading-team highlight refreshed — both O(1)/cheap.
    const auctionStateChanged = JSON.stringify(auctionState) !== JSON.stringify(prevAuctionState);
    const idxChanged = currentIdx !== prevIdx;

    if(auctionStateChanged || idxChanged){
      renderPlayer();     // internally also calls renderList() + renderLiveBid()
      renderTeamTable();
    } else {
      renderLiveBid();        // just updates the current-bid amount/team text
      updateLeadingTeamRow(); // just toggles the highlighted team row
    }
    renderJoinStatus();
    updateAllStatusDots(); // the online/offline dots run off session-lock heartbeats, not auctionState — so
                            // without this, a team logging in only updated its dot on the next 5s poll (see
                            // setInterval below) instead of the instant this snapshot (written by their own
                            // login) arrived. This call is cheap (just toggles CSS classes on existing rows,
                            // no rebuild), so it's safe to run on every snapshot.
    renderPauseUI();
    renderAutoAdvanceUI();
    renderHostStartUI();
    renderChat(chatMessagesCache.length > prevChatCount);
  }, (err) => {
    console.error('Live sync error', err);
  });
}

async function enterApp(){
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('mainApp').classList.remove('hidden');
  applyRoleUI();
  await syncClockOffset(); // must happen before the timer can show correct numbers
  await loadData();
  renderTeamSelect();
  await loadState();
  await loadIdx();
  await loadBid();
  await loadBidHistory();
  try{
    const snap = await liveDocRef.get();
    const d = snap.data();
    timerEndAt = (d && typeof d.timerEndAt === 'number') ? d.timerEndAt : null;
    autoAdvance = !!(d && d.autoAdvance);
    // BUG FIX: sessionLocksCache (what joinedTeams()/isTeamOnline() read to
    // decide the Joined count and every green/gray dot) was only being
    // populated here for the HOST via loadPresence(). An owner logging in
    // instead only called markTeamPresent(), which never touches
    // sessionLocksCache — so on first paint, before the very first
    // onSnapshot callback lands, every owner's screen briefly showed
    // "0/12 joined" and every dot gray, even though the host's screen was
    // already correct. Populating it from the doc we just fetched (for
    // BOTH roles) means the very first render is correct for everyone,
    // not just whoever happens to be host.
    sessionLocksCache = (d && d.sessionLocks) ? d.sessionLocks : {};
    // Hydrate chat state from the same fetch (no extra round-trip) so the
    // very first onSnapshot after login doesn't mistake the last 50 saved
    // messages for brand-new ones and fire a burst of toasts/sounds.
    chatMessagesCache = (d && d.chatMessages) ? d.chatMessages : [];
    lastSeenChatTs = chatMessagesCache.reduce((max, m) => Math.max(max, m.ts || 0), 0);
    chatSeenCount = chatMessagesCache.length;
    chatSynced = true;
  }catch(e){ timerEndAt = null; console.error('initial liveDocRef.get() failed', e); }
  if(session.role === 'owner'){ await markTeamPresent(session.team); }
  else{ await loadPresence(); }
  initChatSenderFromStorage();
  renderChat(false);
  renderJoinStatus();
  renderPlayer();
  renderTeamTable();
  renderPauseUI();
  renderAutoAdvanceUI();
  renderHostStartUI();
  startLiveSync();
  ensureTimerLoop(); // single interval for the whole session — never duplicated
}

// joinedTeams()/missingTeams() depend on Date.now() vs a heartbeat
// timestamp, which changes even when Firestore doesn't send a new snapshot
// (e.g. everyone's just sitting in the waiting room, nobody bidding). Without
// this, a team that vanished would only flip to "missing" once some
// unrelated write happened to trigger a fresh snapshot — could be a while.
setInterval(() => { renderJoinStatus(); updateAllStatusDots(); }, 5000);
setInterval(() => { if(session) syncClockOffset(); }, 180000); // re-sync every 3 min so long sessions don't drift

(async function init(){
  await loadAdminConfig();
  loadSession();
  if(session){
    // A page refresh restores `session` here directly (bypassing doLogin),
    // so we must also restore the lock sid and resume heartbeating it —
    // otherwise mySessionSid would stay null and the kicked-detection in
    // startLiveSync() would immediately (and wrongly) sign this tab out.
    mySessionSid = session.sid || null;
    if(mySessionSid){
      startSessionHeartbeat(sessionLockKey(session.role, session.team));
    }
    await enterApp();
  }
})();
