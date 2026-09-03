// SSL T10 — Season 1 · Live Auction Board
// Talks to the SAME backend contract as the original app (liveDocRef +
// db.runTransaction, provided by realtime-shim.js) — no backend changes.

const SESSION_KEY = 'ssl10-s1-session';
const TIMER_SECONDS = 15;
const TIMER_CIRC = 2 * Math.PI * 28; // matches the SVG circle r=28

let session = null;
let TEAMS = [], PURSE_CR = 120, SQUAD_MAX = 20, PLAYERS = [], PLAYERS_BY_KEY = {};
let auctionState = {}, currentIdx = -1, currentBid = null, timerEndAt = null, passedTeams = {};
let lastRenderedIdx = null, lastRevealedKey = null;
let bidInFlight = false;
let rafHandle = null;

// Every GSAP call in this file is wrapped through this — a blocked/slow
// CDN script must never stop text/data updates (bid amount, team strip,
// controls) from rendering. Animation is a nice-to-have layered on top of
// state that always has to render correctly on its own.
function safeGsap(fn) {
  try { fn(); } catch (e) { console.warn('Animation skipped (GSAP unavailable):', e); }
}

// ---------- Boot ----------
(async function init(){
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) { window.location.href = '/login.html'; return; }
  session = JSON.parse(raw);
  document.getElementById('whoami').textContent =
    session.role === 'host' ? 'Host' : session.team;

  if (session.role === 'owner') document.getElementById('ownerActions').style.display = '';
  if (session.role === 'host') document.getElementById('hostActions').style.display = '';

  const res = await fetch('/api/config/current');
  const cfg = await res.json();
  if (!cfg.active) { document.getElementById('lotName').textContent = 'Auction not active.'; return; }

  TEAMS = cfg.teams || [];
  PURSE_CR = cfg.purseCr || 120;
  SQUAD_MAX = cfg.squadMax || 20;
  PLAYERS = cfg.players || [];
  PLAYERS_BY_KEY = {};
  for (const p of PLAYERS) PLAYERS_BY_KEY[String(p['Auction #'])] = p;

  renderTeamStrip();

  const snap = await liveDocRef.get();
  applyDoc(snap.data() || {});
  render();

  liveDocRef.onSnapshot((snap) => {
    applyDoc(snap.data() || {});
    render();
  });

  wireControls();
  wireQueue();
  wireChat();
  tick();
})();

let lastResolvedIdx = null, lastResolvedKey = null; // for Undo
let chatMessages = [], chatSeenCount = 0;

function applyDoc(d){
  auctionState = d.auctionState || {};
  currentIdx = (typeof d.currentIdx === 'number') ? d.currentIdx : -1;
  currentBid = d.currentBid || null;
  timerEndAt = (typeof d.timerEndAt === 'number') ? d.timerEndAt : null;
  passedTeams = d.passedTeams || {};

  const p = currentPlayer();
  if (p){
    const key = String(p['Auction #']);
    const state = auctionState[key];
    if (state && (state.status === 'sold' || state.status === 'unsold')){
      lastResolvedIdx = currentIdx;
      lastResolvedKey = key;
    }
  }
  document.getElementById('undoBtn').style.display =
    (session && session.role === 'host' && lastResolvedKey) ? '' : 'none';

  const prevCount = chatMessages.length;
  chatMessages = d.chatMessages || [];
  if (chatMessages.length > prevCount) renderChat();
  updateChatBadge();
}

function currentPlayer(){ return currentIdx >= 0 ? PLAYERS[currentIdx] : null; }
function baseToCr(s){ if(!s) return 0; s = String(s).trim();
  if (s.endsWith('C')) return parseFloat(s);
  if (s.endsWith('L')) return parseFloat(s)/100;
  return parseFloat(s) || 0; }
function fmtCr(cr){ if (cr==null || isNaN(cr)) return '—';
  return cr >= 1 ? cr.toFixed(2).replace(/\.00$/,'') + ' Cr' : Math.round(cr*100) + ' L'; }
function baseIncrementCr(baseCr){
  if (baseCr < 1) return 0.05;
  if (baseCr < 2) return 0.10;
  if (baseCr < 5) return 0.25;
  return 0.50;
}
function teamSpent(team){
  let cr = 0, count = 0;
  for (const k in auctionState){
    const s = auctionState[k];
    if (s.status === 'sold' && s.team === team){ cr += s.priceCr; count++; }
  }
  return { cr, count };
}

// ---------- Render ----------
function render(){
  const p = currentPlayer();
  const key = p ? String(p['Auction #']) : null;
  const state = key ? auctionState[key] : null;
  const finished = state && (state.status === 'sold' || state.status === 'unsold');

  if (!p){
    document.getElementById('lotSet').textContent = '—';
    document.getElementById('lotName').textContent = 'Waiting for the host…';
    document.getElementById('lotBase').textContent = '—';
    document.getElementById('bidAmt').textContent = '—';
    document.getElementById('bidTeam').textContent = 'No bids yet';
    document.getElementById('timer').style.display = 'none';
  } else {
    document.getElementById('lotSet').textContent = p['SET'] || '';
    document.getElementById('lotName').textContent = p['PLAYER NAME'] || '';
    document.getElementById('lotBase').textContent = fmtCr(baseToCr(p['BASE PRICE']));

    const newAmt = currentBid ? fmtCr(currentBid.priceCr) : fmtCr(baseToCr(p['BASE PRICE']));
    const amtEl = document.getElementById('bidAmt');
    if (amtEl.textContent !== newAmt){
      amtEl.textContent = newAmt;
      safeGsap(() => gsap.fromTo(amtEl, { scale: 1.15, color: '#A9762E' }, { scale: 1, color: '#5C1A1A', duration: 0.35, ease: 'power2.out' }));
    }
    document.getElementById('bidTeam').textContent = currentBid ? `Leading: ${currentBid.team}` : 'No bids yet — base price shown';

    document.getElementById('timer').style.display = (timerEndAt && !finished) ? '' : 'none';
  }

  // Entrance animation when the live player changes
  if (currentIdx !== lastRenderedIdx){
    lastRenderedIdx = currentIdx;
    safeGsap(() => gsap.fromTo('#lotCard', { opacity: 0.4, y: 8 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' }));
  }

  // SOLD / UNSOLD reveal — fires once per resolution
  if (finished && key !== lastRevealedKey){
    lastRevealedKey = key;
    showReveal(state.status, state.team);
  }
  if (!finished) lastRevealedKey = null;

  renderOwnerControls(p, key, finished);
  renderPassedBar(key);
  renderTeamStrip();
}

function renderOwnerControls(p, key, finished){
  if (session.role !== 'owner') return;
  const quickBtn = document.getElementById('quickBidBtn');
  const outBtn = document.getElementById('outBtn');
  const customRow = document.querySelector('.actions__custom');
  const waiting = document.getElementById('waitingBox');
  const errBox = document.getElementById('bidError');

  const iPassed = key && (passedTeams[key] || []).includes(session.team);
  const amHighest = !!(currentBid && currentBid.team === session.team);

  if (!p || finished || iPassed){
    quickBtn.style.display = 'none';
    outBtn.style.display = 'none';
    customRow.style.display = 'none';
    waiting.style.display = iPassed && !finished ? '' : 'none';
    if (iPassed && !finished) waiting.textContent = "You're sitting this player out.";
    return;
  }

  if (amHighest){
    quickBtn.style.display = 'none';
    outBtn.style.display = 'none';
    customRow.style.display = 'none';
    waiting.style.display = '';
    waiting.textContent = 'You are the highest bidder — waiting…';
    return;
  }

  waiting.style.display = 'none';
  customRow.style.display = '';
  outBtn.style.display = '';
  quickBtn.style.display = '';

  const base = currentBid ? currentBid.priceCr : baseToCr(p['BASE PRICE']);
  const step = baseIncrementCr(base);
  const next = currentBid ? +(base + step).toFixed(2) : base;
  quickBtn.textContent = currentBid ? `+ Bid ${fmtCr(next)}` : `Bid Base ${fmtCr(next)}`;
  quickBtn.onclick = () => placeBid(next, key, p);

  document.getElementById('customBidBtn').onclick = () => {
    const amt = parseFloat(document.getElementById('customAmt').value);
    if (!amt || amt <= 0){ errBox.textContent = 'Enter a valid amount.'; return; }
    placeBid(amt, key, p);
    document.getElementById('customAmt').value = '';
  };

  outBtn.onclick = () => placeOut(key);
}

function renderPassedBar(key){
  const bar = document.getElementById('passedBar');
  const list = key ? (passedTeams[key] || []) : [];
  bar.textContent = list.length ? `Sat out: ${list.join(', ')}` : '';
}

function renderTeamStrip(){
  const strip = document.getElementById('teamStrip');
  strip.innerHTML = '';
  for (const team of TEAMS){
    const { cr, count } = teamSpent(team);
    const chip = document.createElement('div');
    chip.className = 'team-chip' + (currentBid && currentBid.team === team ? ' is-leading' : '');
    chip.innerHTML = `
      <div class="team-chip__name">${team}</div>
      <div class="team-chip__purse num">${fmtCr(PURSE_CR - cr)} left</div>
      <div class="team-chip__count">${count}/${SQUAD_MAX} players</div>`;
    strip.appendChild(chip);
  }
}

// ---------- Timer loop ----------
function tick(){
  const timerEl = document.getElementById('timer');
  const fill = document.getElementById('timerFill');
  const num = document.getElementById('timerNum');

  if (timerEndAt && timerEl.style.display !== 'none'){
    const remainingMs = timerEndAt - Date.now();
    const remaining = Math.max(0, Math.ceil(remainingMs / 1000));
    num.textContent = remaining;
    const pct = Math.max(0, Math.min(1, remainingMs / (TIMER_SECONDS * 1000)));
    fill.setAttribute('stroke-dashoffset', String(TIMER_CIRC * (1 - pct)));
    timerEl.classList.toggle('is-urgent', remaining <= 5);
  }
  rafHandle = requestAnimationFrame(tick);
}

// ---------- Reveal animation ----------
function showReveal(status, team){
  const reveal = document.getElementById('reveal');
  const stamp = document.getElementById('revealStamp');
  stamp.className = 'reveal__stamp reveal__stamp--' + status;
  stamp.textContent = status === 'sold' ? `SOLD — ${team}` : 'UNSOLD';

  safeGsap(() => {
    gsap.timeline()
      .set(reveal, { opacity: 1 })
      .fromTo(stamp, { scale: 0.5, rotate: -8, opacity: 0 },
        { scale: 1, rotate: -6, opacity: 1, duration: 0.4, ease: 'back.out(2.2)' })
      .to(stamp, { scale: 1.03, duration: 0.15, yoyo: true, repeat: 1, ease: 'power1.inOut' })
      .to(reveal, { opacity: 0, duration: 0.4, delay: 1.1, ease: 'power2.in' });
  });
}

// ---------- Owner actions ----------
async function placeBid(priceCr, key, p){
  if (bidInFlight) return;
  bidInFlight = true;
  const errBox = document.getElementById('bidError');
  errBox.textContent = '';

  let acceptedBid = null, acceptedTimerEndAt = null, baseForMsg = null;
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(liveDocRef);
      const d = snap.data() || {};
      const liveIdx = (typeof d.currentIdx === 'number') ? d.currentIdx : -1;
      const liveBid = d.currentBid || null;

      if (liveIdx !== currentIdx) throw new Error('STALE_PLAYER');
      if (liveBid && liveBid.team === session.team) throw new Error('ALREADY_HIGHEST');
      const passedList = (d.passedTeams && d.passedTeams[key]) || [];
      if (passedList.includes(session.team)) throw new Error('YOU_PASSED');

      const base = liveBid ? liveBid.priceCr : baseToCr(p['BASE PRICE']);
      baseForMsg = base;
      if (!liveBid){
        if (Math.abs(priceCr - base) > 0.001) throw new Error('MUST_MATCH_BASE');
      } else if (priceCr <= base){
        throw new Error('MUST_EXCEED');
      }

      const { cr, count } = teamSpent(session.team);
      if (count >= SQUAD_MAX) throw new Error('SQUAD_FULL');
      if (cr + priceCr > PURSE_CR) throw new Error('PURSE_LOW');

      const newBid = { team: session.team, priceCr };
      const newTimerEndAt = Date.now() + TIMER_SECONDS * 1000;
      tx.set(liveDocRef, { currentBid: newBid, timerEndAt: newTimerEndAt }, { merge: true });
      acceptedBid = newBid;
      acceptedTimerEndAt = newTimerEndAt;
    });
  } catch (e) {
    const messages = {
      STALE_PLAYER: 'The live player changed — try again.',
      ALREADY_HIGHEST: 'You are already the highest bidder.',
      MUST_MATCH_BASE: `First bid must be exactly ${fmtCr(baseForMsg)}.`,
      MUST_EXCEED: `Bid must exceed ${fmtCr(baseForMsg)}.`,
      YOU_PASSED: "You're sitting this player out.",
      SQUAD_FULL: `Squad already has the max ${SQUAD_MAX} players.`,
      PURSE_LOW: 'Not enough purse left.'
    };
    errBox.textContent = messages[e.message] || 'Could not place bid — try again.';
    bidInFlight = false;
    return;
  }

  currentBid = acceptedBid;
  timerEndAt = acceptedTimerEndAt;
  bidInFlight = false;
  render();
}

async function placeOut(key){
  try {
    await liveDocRef.set({ [`passedTeams.${key}`]: [...(passedTeams[key] || []), session.team] }, { merge: true });
  } catch (e) { console.error('placeOut failed', e); }
}

// ---------- Host actions ----------
function wireControls(){
  if (session.role !== 'host') return;

  document.getElementById('nextPlayerBtn').onclick = async () => {
    const nextIdx = PLAYERS.findIndex((p, i) => !auctionState[String(p['Auction #'])] && i !== currentIdx);
    if (nextIdx === -1) { alert('No players left.'); return; }
    await liveDocRef.set({
      currentIdx: nextIdx,
      currentBid: null,
      timerEndAt: Date.now() + TIMER_SECONDS * 1000
    }, { merge: true });
  };

  document.getElementById('soldBtn').onclick = async () => {
    const p = currentPlayer();
    if (!p) return;
    if (!currentBid){ alert('No bid has been placed — use Unsold instead.'); return; }
    const key = String(p['Auction #']);
    await liveDocRef.set({
      [`auctionState.${key}`]: { status: 'sold', team: currentBid.team, priceCr: currentBid.priceCr },
      currentBid: null,
      timerEndAt: { __op: 'delete' }
    }, { merge: true });
  };

  document.getElementById('unsoldBtn').onclick = async () => {
    const p = currentPlayer();
    if (!p) return;
    const key = String(p['Auction #']);
    await liveDocRef.set({
      [`auctionState.${key}`]: { status: 'unsold' },
      currentBid: null,
      timerEndAt: { __op: 'delete' }
    }, { merge: true });
  };

  document.getElementById('undoBtn').onclick = async () => {
    if (!lastResolvedKey) return;
    await liveDocRef.set({
      [`auctionState.${lastResolvedKey}`]: { __op: 'delete' },
      currentIdx: lastResolvedIdx,
      currentBid: null,
      timerEndAt: Date.now() + TIMER_SECONDS * 1000
    }, { merge: true });
    lastResolvedKey = null;
    lastResolvedIdx = null;
  };
}

// ---------- Player queue panel ----------
function wireQueue(){
  const panel = document.getElementById('queuePanel');
  const sheet = panel.querySelector('.panel__sheet');
  document.getElementById('openQueueBtn').onclick = () => { openPanel(panel, sheet); renderQueue(); };
  document.getElementById('closeQueueBtn').onclick = () => closePanel(panel, sheet);
  panel.addEventListener('click', (e) => { if (e.target === panel) closePanel(panel, sheet); });
  document.getElementById('queueSearch').addEventListener('input', renderQueue);
}

function renderQueue(){
  const list = document.getElementById('queueList');
  const q = document.getElementById('queueSearch').value.trim().toLowerCase();
  const isHost = session.role === 'host';
  list.innerHTML = '';

  PLAYERS.forEach((p, idx) => {
    const name = p['PLAYER NAME'] || '';
    if (q && !name.toLowerCase().includes(q)) return;
    const key = String(p['Auction #']);
    const state = auctionState[key];
    const isLive = idx === currentIdx;

    const row = document.createElement('div');
    row.className = 'queue__row' + (isLive ? ' is-live' : '');
    const statusText = state
      ? (state.status === 'sold' ? `Sold — ${state.team} (${fmtCr(state.priceCr)})` : 'Unsold')
      : (isLive ? 'Live now' : 'Pending');

    row.innerHTML = `
      <div>
        <div class="queue__row-name">${name}</div>
        <div class="queue__row-meta">${p['SET'] || ''} · Base ${fmtCr(baseToCr(p['BASE PRICE']))} · ${statusText}</div>
      </div>`;

    if (isHost && !isLive){
      const btn = document.createElement('button');
      btn.className = 'queue__row-action';
      btn.textContent = 'Release';
      btn.onclick = async () => {
        const fields = { currentIdx: idx, currentBid: null, timerEndAt: Date.now() + TIMER_SECONDS * 1000 };
        if (state) fields[`auctionState.${key}`] = { __op: 'delete' };
        await liveDocRef.set(fields, { merge: true });
        closePanel(document.getElementById('queuePanel'), document.querySelector('#queuePanel .panel__sheet'));
      };
      row.appendChild(btn);
    }
    list.appendChild(row);
  });
}

// ---------- Chat panel ----------
function wireChat(){
  const panel = document.getElementById('chatPanel');
  const sheet = panel.querySelector('.panel__sheet');
  document.getElementById('openChatBtn').onclick = () => {
    openPanel(panel, sheet);
    chatSeenCount = chatMessages.length;
    updateChatBadge();
    renderChat();
  };
  document.getElementById('closeChatBtn').onclick = () => closePanel(panel, sheet);
  panel.addEventListener('click', (e) => { if (e.target === panel) closePanel(panel, sheet); });

  const send = async () => {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const sender = session.role === 'host' ? 'HOST' : session.team;
    const msg = { sender, role: session.role, text, ts: Date.now() };
    const snap = await liveDocRef.get();
    const d = snap.data() || {};
    const msgs = (d.chatMessages || []).concat(msg);
    await liveDocRef.set({ chatMessages: msgs }, { merge: true });
  };
  document.getElementById('chatSendBtn').onclick = send;
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });
}

function renderChat(){
  const list = document.getElementById('chatList');
  list.innerHTML = chatMessages.map(m => {
    const isHost = m.role === 'host';
    const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="chat__msg${isHost ? ' is-host' : ''}">
      <div class="chat__msg-meta">${m.sender} · ${time}</div>
      <div class="chat__msg-bubble">${escapeHtml(m.text)}</div>
    </div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}

function updateChatBadge(){
  const badge = document.getElementById('chatBadge');
  const unread = Math.max(0, chatMessages.length - chatSeenCount);
  badge.style.display = unread > 0 ? '' : 'none';
  badge.textContent = String(unread);
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Panel open/close (GSAP slide-up) ----------
// Each has a direct-style fallback — if GSAP is unavailable, the panel
// must still open/close correctly, just as a snap instead of a slide.
function openPanel(panel, sheet){
  panel.classList.add('is-open');
  try {
    gsap.to(panel, { opacity: 1, duration: 0.2 });
    gsap.to(sheet, { y: 0, duration: 0.35, ease: 'power3.out' });
  } catch (e) {
    panel.style.opacity = 1;
    sheet.style.transform = 'translateY(0)';
  }
}
function closePanel(panel, sheet){
  const finish = () => panel.classList.remove('is-open');
  try {
    gsap.to(sheet, { y: '100%', duration: 0.3, ease: 'power2.in' });
    gsap.to(panel, { opacity: 0, duration: 0.25, delay: 0.05, onComplete: finish });
  } catch (e) {
    panel.style.opacity = 0;
    sheet.style.transform = 'translateY(100%)';
    finish();
  }
}
