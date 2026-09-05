// SSL T10 — Season 1 · Live Auction Board
// Talks to the SAME backend contract as the original app (liveDocRef +
// db.runTransaction, provided by realtime-shim.js) — no backend changes.

const SESSION_KEY = 'ssl10-s1-session';
const TIMER_SECONDS = 15;
const TIMER_CIRC = 2 * Math.PI * 28; // matches the SVG circle r=28

let session = null;
let lastRenderSig = null;
function hasRenderRelevantChange(d){
  const sig = JSON.stringify({
    auctionState: d.auctionState, currentIdx: d.currentIdx, currentBid: d.currentBid,
    timerEndAt: d.timerEndAt, passedTeams: d.passedTeams, isPaused: d.isPaused
  });
  const changed = sig !== lastRenderSig;
  lastRenderSig = sig;
  return changed;
}

let TEAMS = [], PURSE_CR = 120, SQUAD_MAX = 20, PLAYERS = [], PLAYERS_BY_KEY = {};
let sounds = {}; // { bid, sold, unsold } -> HTMLAudioElement, preloaded once
let soundsMuted = sessionStorage.getItem('ssl10-sfx-muted') === '1';

function loadSounds(cfg){
  sounds = {};
  if (!cfg) return;
  ['bid', 'sold', 'unsold'].forEach(k => {
    if (cfg[k]) {
      const a = new Audio(cfg[k]);
      a.preload = 'auto';
      sounds[k] = a;
    }
  });
}
function playSound(key){
  if (soundsMuted || !sounds[key]) return;
  try {
    // Clone so rapid-fire plays (multiple bids in quick succession with
    // 10+ people bidding) don't cut each other off restarting the same tag.
    const el = sounds[key].cloneNode();
    el.volume = 0.7;
    el.play().catch(() => {}); // browsers block autoplay until first user gesture — fine to ignore
  } catch (e) { /* non-critical */ }
}
let auctionState = {}, currentIdx = -1, currentBid = null, timerEndAt = null, passedTeams = {};
let lastRenderedIdx = null, lastRevealedKey = null;
let bidInFlight = false;
let rafHandle = null;

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
  loadSounds(cfg.sounds);

  renderTeamStrip();

  // Wiring every button happens unconditionally, up front — a slow or
  // failed live connection (Railway free-tier cold start can take well
  // over the shim's 8s timeout) must never prevent buttons from working.
  // Before this fix, an unguarded await here meant one slow wake-up
  // silently killed every click handler for the rest of the session,
  // even after the connection succeeded moments later.
  wireControls();
  wireQueue();
  wireChat();
  wireMyTeam();
  wireHostToolbar();
  wirePressFeedback();
  wireMuteToggle();
  tick();

  await connectLiveDoc();
})();

let liveConnected = false;
async function connectLiveDoc(attempt){
  attempt = attempt || 1;
  try {
    const snap = await liveDocRef.get();
    applyDoc(snap.data() || {});
    render();
    liveConnected = true;

    liveDocRef.onSnapshot((snap) => {
      const d = snap.data() || {};
      const changed = hasRenderRelevantChange(d);
      applyDoc(d);
      if (changed) render();
    });
  } catch (e) {
    // Cold start on free hosting can take longer than the shim's 8s
    // timeout. Retry with backoff instead of leaving the board stuck
    // on "Waiting for the host…" forever — most of the time this
    // resolves within a few retries once the container finishes waking.
    const lotName = document.getElementById('lotName');
    if (lotName) lotName.textContent = `Connecting… (retry ${attempt})`;
    const delay = Math.min(2000 * attempt, 10000);
    setTimeout(() => connectLiveDoc(attempt + 1), delay);
  }
}

function wireMuteToggle(){
  const btn = document.getElementById('muteToggle');
  btn.textContent = soundsMuted ? '🔇' : '🔊';
  btn.onclick = () => {
    soundsMuted = !soundsMuted;
    sessionStorage.setItem('ssl10-sfx-muted', soundsMuted ? '1' : '0');
    btn.textContent = soundsMuted ? '🔇' : '🔊';
  };
}

// ---------- Global press feedback ----------
// One listener for every button, rather than per-button GSAP calls — gives
// every tap in the app the same tactile snap (98% scale, quick spring back)
// without hand-wiring it onto each new button as the UI grows.
function wirePressFeedback(){
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.btn, .quickbid-chip, .toggle-chip, .queue__row-action');
    if (!btn || btn.disabled) return;
    safeGsap(() => gsap.to(btn, { scale: 0.96, duration: 0.08, ease: 'power2.out' }));
  });
  document.addEventListener('pointerup', (e) => {
    const btn = e.target.closest('.btn, .quickbid-chip, .toggle-chip, .queue__row-action');
    if (!btn) return;
    safeGsap(() => gsap.to(btn, { scale: 1, duration: 0.25, ease: 'back.out(2.5)' }));
  });
}

let lastResolvedIdx = null, lastResolvedKey = null; // for Undo
let chatMessages = [], chatSeenCount = 0;
let bidHistory = [];
let autoAdvance = false, isPaused = false;

function applyDoc(d){
  auctionState = d.auctionState || {};
  currentIdx = (typeof d.currentIdx === 'number') ? d.currentIdx : -1;
  currentBid = d.currentBid || null;
  timerEndAt = (typeof d.timerEndAt === 'number') ? d.timerEndAt : null;
  passedTeams = d.passedTeams || {};
  autoAdvance = !!d.autoAdvance;
  isPaused = !!d.isPaused;

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
  if (chatMessages.length > prevCount){
    renderChat();
    const newest = chatMessages[chatMessages.length - 1];
    if (newest && newest.sender !== getChatDisplayName()) showChatToast(newest);
  }
  updateChatBadge();
  renderTypingIndicator(d.typing);

  const newHistory = d.bidHistory || [];
  if (newHistory.length !== bidHistory.length){ bidHistory = newHistory; renderBidHistory(); }

  renderProgress();
  renderPauseState();
  renderHostToolbarState();
}

function renderProgress(){
  const total = PLAYERS.length;
  const done = Object.keys(auctionState).length;
  document.getElementById('progressLabel').textContent = `${done} / ${total}`;
  document.getElementById('progressFill').style.width = total ? `${(done/total)*100}%` : '0%';
}

function renderBidHistory(){
  const box = document.getElementById('bidHistory');
  if (!bidHistory.length){ box.innerHTML = ''; return; }
  box.innerHTML = bidHistory.slice(-6).reverse().map(b =>
    `<div class="bidhist__row"><span>${escapeHtml(b.team)}</span><span class="num">${fmtCr(b.priceCr)}</span></div>`
  ).join('');
}

function renderPauseState(){
  document.getElementById('pauseOverlay').style.display = isPaused ? '' : 'none';
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
      if (currentBid) playSound('bid');
    }
    document.getElementById('bidTeam').textContent = currentBid ? `Leading: ${currentBid.team}` : 'No bids yet — base price shown';

    document.getElementById('timer').style.display = (timerEndAt && !finished) ? '' : 'none';
  }

  // Entrance animation when the live player changes — wrapped in safeGsap
  // because this line sits BEFORE renderOwnerControls/renderTeamStrip in
  // this function. If GSAP is slow/blocked and this throws unguarded, it
  // aborts the rest of render() and leaves the Bid/Out buttons stuck in
  // their default visible state forever — exactly the bug this caused.
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
  const chipsRow = document.getElementById('quickBidChips');
  const waiting = document.getElementById('waitingBox');
  const errBox = document.getElementById('bidError');

  const iPassed = key && (passedTeams[key] || []).includes(session.team);
  const amHighest = !!(currentBid && currentBid.team === session.team);

  if (isPaused){
    quickBtn.style.display = 'none';
    outBtn.style.display = 'none';
    customRow.style.display = 'none';
    chipsRow.style.display = 'none';
    waiting.style.display = '';
    waiting.textContent = 'Auction is paused by the host.';
    return;
  }

  if (!p || finished || iPassed){
    quickBtn.style.display = 'none';
    outBtn.style.display = 'none';
    customRow.style.display = 'none';
    chipsRow.style.display = 'none';
    waiting.style.display = iPassed && !finished ? '' : 'none';
    if (iPassed && !finished) waiting.textContent = "You're sitting this player out.";
    return;
  }

  if (amHighest){
    quickBtn.style.display = 'none';
    outBtn.style.display = 'none';
    customRow.style.display = 'none';
    chipsRow.style.display = 'none';
    waiting.style.display = '';
    waiting.textContent = 'You are the highest bidder — waiting…';
    return;
  }

  waiting.style.display = 'none';
  customRow.style.display = '';
  chipsRow.style.display = '';
  outBtn.style.display = '';
  quickBtn.style.display = '';

  const base = currentBid ? currentBid.priceCr : baseToCr(p['BASE PRICE']);
  const step = baseIncrementCr(base);
  const next = currentBid ? +(base + step).toFixed(2) : base;
  quickBtn.textContent = currentBid ? `+ Bid ${fmtCr(next)}` : `Bid Base ${fmtCr(next)}`;
  quickBtn.onclick = () => placeBid(next, key, p);

  // Quick-bid preset chips — one step, and a few multiples of it, so an
  // owner can jump ahead without typing a custom amount every time.
  chipsRow.innerHTML = '';
  if (currentBid){
    [1, 2, 4].forEach(mult => {
      const amt = +(base + step * mult).toFixed(2);
      const chip = document.createElement('button');
      chip.className = 'quickbid-chip';
      chip.textContent = `+${fmtCr(step * mult)}`;
      chip.onclick = () => placeBid(amt, key, p);
      chipsRow.appendChild(chip);
    });
  }

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

let lastLeadingTeam = null;

function renderTeamStrip(){
  const strip = document.getElementById('teamStrip');
  const leader = currentBid ? currentBid.team : null;
  strip.innerHTML = '';
  for (const team of TEAMS){
    const { cr, count } = teamSpent(team);
    const chip = document.createElement('div');
    chip.className = 'team-chip' + (leader === team ? ' is-leading' : '');
    chip.innerHTML = `
      <div class="team-chip__name">${team}</div>
      <div class="team-chip__purse num">${fmtCr(PURSE_CR - cr)} left</div>
      <div class="team-chip__count">${count}/${SQUAD_MAX} players</div>`;
    strip.appendChild(chip);
    // Pulse only the chip that just became the leader — re-animating the
    // whole strip on every render (which fires on every live update) would
    // be constant motion, not smoothness.
    if (leader === team && leader !== lastLeadingTeam){
      safeGsap(() => gsap.fromTo(chip, { scale: 1.06 }, { scale: 1, duration: 0.3, ease: 'power2.out' }));
    }
  }
  lastLeadingTeam = leader;
}

// ---------- Timer loop ----------
let urgentPulseStarted = false;

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

    const isUrgent = remaining <= 5 && remaining > 0;
    timerEl.classList.toggle('is-urgent', isUrgent);
    if (isUrgent && !urgentPulseStarted){
      urgentPulseStarted = true;
      safeGsap(() => gsap.to(timerEl, { scale: 1.08, duration: 0.35, repeat: -1, yoyo: true, ease: 'power1.inOut' }));
    } else if (!isUrgent && urgentPulseStarted){
      urgentPulseStarted = false;
      safeGsap(() => gsap.killTweensOf(timerEl));
      timerEl.style.transform = '';
    }
  } else if (urgentPulseStarted) {
    urgentPulseStarted = false;
    safeGsap(() => gsap.killTweensOf(timerEl));
    timerEl.style.transform = '';
  }

  // Host-only: resolve the player automatically when the clock hits zero,
  // matching the old app's behaviour. Only the host's browser writes this —
  // if every connected client tried to resolve on zero simultaneously, 10+
  // people would all fire the same write at once and hammer the lock queue.
  if (session && session.role === 'host' && timerEndAt && !isPaused && Date.now() >= timerEndAt){
    autoResolveTimerExpiry();
  }

  rafHandle = requestAnimationFrame(tick);
}

let resolvingTimerFor = null;
async function autoResolveTimerExpiry(){
  const p = currentPlayer();
  if (!p) return;
  const key = String(p['Auction #']);
  if (resolvingTimerFor === key) return; // already in flight for this player
  resolvingTimerFor = key;

  try {
    if (currentBid){
      await liveDocRef.set({
        [`auctionState.${key}`]: { status: 'sold', team: currentBid.team, priceCr: currentBid.priceCr },
        currentBid: null,
        timerEndAt: { __op: 'delete' }
      }, { merge: true });
    } else {
      await liveDocRef.set({
        [`auctionState.${key}`]: { status: 'unsold' },
        currentBid: null,
        timerEndAt: { __op: 'delete' }
      }, { merge: true });
    }
    if (autoAdvance){
      const nextIdx = PLAYERS.findIndex((pl, i) => !auctionState[String(pl['Auction #'])] && i !== currentIdx);
      if (nextIdx !== -1){
        setTimeout(() => liveDocRef.set({
          currentIdx: nextIdx, currentBid: null, timerEndAt: Date.now() + TIMER_SECONDS * 1000
        }, { merge: true }), 2500);
      }
    }
  } finally {
    resolvingTimerFor = null;
  }
}

// ---------- Confetti (lightweight, no library) ----------
function fireConfetti(){
  // Guard before creating any DOM elements — if GSAP is unavailable, we
  // must not append pieces we then have no way to animate away; that would
  // leave stray divs stuck on screen forever instead of just skipping the
  // celebration effect.
  if (typeof gsap === 'undefined') return;
  try {
    const colors = ['#5C1A1A', '#A9762E', '#3E5C2E'];
    for (let i = 0; i < 24; i++){
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.background = colors[i % colors.length];
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      document.body.appendChild(piece);
      gsap.to(piece, {
        y: window.innerHeight + 40,
        x: (Math.random() - 0.5) * 120,
        rotate: `+=${360 + Math.random() * 360}`,
        opacity: 0,
        duration: 1.2 + Math.random() * 0.6,
        ease: 'power1.in',
        onComplete: () => piece.remove()
      });
    }
  } catch (e) { console.warn('Confetti skipped:', e); }
}

// ---------- Reveal animation ----------
function showReveal(status, team){
  const reveal = document.getElementById('reveal');
  const stamp = document.getElementById('revealStamp');
  stamp.className = 'reveal__stamp reveal__stamp--' + status;
  stamp.textContent = status === 'sold' ? `SOLD — ${team}` : 'UNSOLD';
  playSound(status);
  if (status === 'sold') fireConfetti();

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
  if (isPaused) return;
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

      if (d.isPaused) throw new Error('PAUSED');
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
      // Capped at 150 entries — the backend broadcasts and persists this
      // whole array on every write (not a diff), so letting it grow
      // unbounded over a multi-hour auction with 10+ clients would mean
      // an ever-larger payload sent to everyone on every single bid.
      const newHistory = (d.bidHistory || []).concat({ team: session.team, priceCr, playerKey: key }).slice(-150);
      tx.set(liveDocRef, { currentBid: newBid, timerEndAt: newTimerEndAt, bidHistory: newHistory }, { merge: true });
      acceptedBid = newBid;
      acceptedTimerEndAt = newTimerEndAt;
    });
  } catch (e) {
    const messages = {
      PAUSED: 'The host has paused the auction.',
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

  async function releaseNext(){
    const nextIdx = PLAYERS.findIndex((p, i) => !auctionState[String(p['Auction #'])] && i !== currentIdx);
    if (nextIdx === -1) { showModal('No players left to release.'); return; }
    await liveDocRef.set({
      currentIdx: nextIdx,
      currentBid: null,
      timerEndAt: Date.now() + TIMER_SECONDS * 1000
    }, { merge: true });
  }

  document.getElementById('nextPlayerBtn').onclick = releaseNext;

  document.getElementById('soldBtn').onclick = async () => {
    const p = currentPlayer();
    if (!p) return;
    if (!currentBid){ showModal('No bid has been placed — use Unsold instead.'); return; }
    const key = String(p['Auction #']);
    await liveDocRef.set({
      [`auctionState.${key}`]: { status: 'sold', team: currentBid.team, priceCr: currentBid.priceCr },
      currentBid: null,
      timerEndAt: { __op: 'delete' }
    }, { merge: true });
    if (autoAdvance) setTimeout(releaseNext, 2500);
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
    if (autoAdvance) setTimeout(releaseNext, 2500);
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

// ---------- Host toolbar: auto-advance, pause, export ----------
function wireHostToolbar(){
  if (session.role !== 'host') return;
  document.getElementById('hostToolbar').style.display = '';
  document.getElementById('exportToolbar').style.display = '';
  document.getElementById('squadExportRow').style.display = '';

  document.getElementById('autoAdvanceToggle').onclick = async () => {
    await liveDocRef.set({ autoAdvance: !autoAdvance }, { merge: true });
  };
  document.getElementById('pauseToggle').onclick = async () => {
    await liveDocRef.set({ isPaused: !isPaused }, { merge: true });
  };
  document.getElementById('resetAuctionBtn').onclick = () => {
    showModal(
      'This clears every Sold/Unsold result, all bids, and passed teams — players and passwords stay. This cannot be undone.',
      async () => {
        await liveDocRef.set({
          auctionState: {}, currentIdx: -1, currentBid: null,
          timerEndAt: { __op: 'delete' }, passedTeams: {}, bidHistory: [],
          autoAdvance: false, isPaused: false
        }, { merge: false });
        lastResolvedKey = null; lastResolvedIdx = null;
      },
      'Reset auction'
    );
  };

  document.getElementById('exportAllBtn').onclick = () => exportRows(playerRows(), 'ssl10-results-full.xlsx');
  document.getElementById('exportUpcomingBtn').onclick = () =>
    exportRows(playerRows().filter(r => r.Status === 'pending'), 'ssl10-results-upcoming.xlsx');
  document.getElementById('exportUnsoldBtn').onclick = () =>
    exportRows(playerRows().filter(r => r.Status === 'unsold'), 'ssl10-results-unsold.xlsx');

  const teamSelect = document.getElementById('squadExportTeam');
  teamSelect.innerHTML = TEAMS.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  document.getElementById('exportSquadBtn').onclick = () => exportSquad(teamSelect.value);
}

function renderHostToolbarState(){
  if (session.role !== 'host') return;
  const auto = document.getElementById('autoAdvanceToggle');
  const pause = document.getElementById('pauseToggle');
  auto.textContent = `⏭ Auto-advance: ${autoAdvance ? 'on' : 'off'}`;
  auto.classList.toggle('is-on', autoAdvance);
  pause.textContent = isPaused ? '▶ Resume auction' : '⏸ Pause auction';
  pause.classList.toggle('is-on', isPaused);
}

// ---------- Export to Excel ----------
function playerRows(){
  return PLAYERS.map(p => {
    const key = String(p['Auction #']);
    const state = auctionState[key];
    return {
      'Player': p['PLAYER NAME'],
      'Set': p['SET'],
      'Base Price': p['BASE PRICE'],
      'Status': state ? state.status : 'pending',
      'Team': state && state.status === 'sold' ? state.team : '',
      'Sold Price (Cr)': state && state.status === 'sold' ? state.priceCr : ''
    };
  });
}
function exportRows(rows, filename){
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, filename);
}
function exportSquad(team){
  const rows = PLAYERS
    .map(p => ({ p, state: auctionState[String(p['Auction #'])] }))
    .filter(x => x.state && x.state.status === 'sold' && x.state.team === team)
    .map(x => ({ 'Player': x.p['PLAYER NAME'], 'Set': x.p['SET'], 'Price (Cr)': x.state.priceCr }));
  exportRows(rows, `ssl10-squad-${team.replace(/\s+/g,'-').toLowerCase()}.xlsx`);
}

// ---------- My Team panel ----------
function wireMyTeam(){
  if (session.role !== 'owner') return;
  document.getElementById('openMyTeamBtn').style.display = '';
  const panel = document.getElementById('myTeamPanel');
  const sheet = panel.querySelector('.panel__sheet');
  document.getElementById('openMyTeamBtn').onclick = () => { openPanel(panel, sheet); renderMyTeam(); };
  document.getElementById('closeMyTeamBtn').onclick = () => closePanel(panel, sheet);
  panel.addEventListener('click', (e) => { if (e.target === panel) closePanel(panel, sheet); });
  document.getElementById('exportMySquadBtn').onclick = () => exportSquad(session.team);
}

function renderMyTeam(){
  const { cr, count } = teamSpent(session.team);
  document.getElementById('myTeamSummary').innerHTML = `
    <div class="myteam-summary__stat"><span class="num">${fmtCr(PURSE_CR - cr)}</span><span>Purse left</span></div>
    <div class="myteam-summary__stat"><span class="num">${count}/${SQUAD_MAX}</span><span>Squad</span></div>
    <div class="myteam-summary__stat"><span class="num">${fmtCr(cr)}</span><span>Spent</span></div>`;

  const mine = PLAYERS.filter(p => {
    const s = auctionState[String(p['Auction #'])];
    return s && s.status === 'sold' && s.team === session.team;
  });
  const list = document.getElementById('myTeamList');
  list.innerHTML = mine.length
    ? mine.map(p => {
        const s = auctionState[String(p['Auction #'])];
        return `<div class="myteam-row"><span>${escapeHtml(p['PLAYER NAME'])}</span><span class="myteam-row__price num">${fmtCr(s.priceCr)}</span></div>`;
      }).join('')
    : '<div class="myteam-empty">No players acquired yet.</div>';
  safeGsap(() => gsap.from('.myteam-row', { opacity: 0, x: -8, duration: 0.25, stagger: 0.03, ease: 'power2.out' }));
}

// ---------- Custom modal (replaces browser alert/confirm) ----------
function showModal(message, onConfirm, confirmLabel){
  const gate = document.getElementById('modalGate');
  const box = gate.querySelector('.modal-gate__box');
  document.getElementById('modalMsg').textContent = message;
  const actions = document.getElementById('modalActions');
  actions.innerHTML = '';

  const closeModal = () => {
    safeGsap(() => gsap.to(box, { scale: 0.94, duration: 0.15 }));
    safeGsap(() => gsap.to(gate, { opacity: 0, duration: 0.2, onComplete: () => gate.classList.remove('is-open') }));
  };

  if (onConfirm){
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn--ghost';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = closeModal;
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn--primary';
    okBtn.textContent = confirmLabel || 'Confirm';
    okBtn.onclick = () => { closeModal(); onConfirm(); };
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
  } else {
    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn--primary';
    okBtn.textContent = 'OK';
    okBtn.onclick = closeModal;
    actions.appendChild(okBtn);
  }

  gate.classList.add('is-open');
  safeGsap(() => gsap.to(gate, { opacity: 1, duration: 0.2 }));
  safeGsap(() => gsap.to(box, { scale: 1, duration: 0.2 }));
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
  safeGsap(() => gsap.from('.queue__row', { opacity: 0, y: 6, duration: 0.25, stagger: 0.02, ease: 'power2.out' }));
}

// ---------- Chat panel ----------
const CHAT_NICK_KEY = 'ssl10-chat-nick';
let chatPanelOpen = false;
let typingDebounce = null;
let lastTypingWrite = 0;

function getChatDisplayName(){
  const saved = sessionStorage.getItem(CHAT_NICK_KEY);
  if (saved) return saved;
  return session.role === 'host' ? 'HOST' : session.team;
}

function wireChat(){
  const panel = document.getElementById('chatPanel');
  const sheet = panel.querySelector('.panel__sheet');
  document.getElementById('openChatBtn').onclick = () => {
    openPanel(panel, sheet);
    chatPanelOpen = true;
    chatSeenCount = chatMessages.length;
    updateChatBadge();
    renderChat();
  };
  document.getElementById('closeChatBtn').onclick = () => { closePanel(panel, sheet); chatPanelOpen = false; };
  panel.addEventListener('click', (e) => { if (e.target === panel) { closePanel(panel, sheet); chatPanelOpen = false; } });

  // Nickname editor
  document.getElementById('chatWhoAmI').textContent = getChatDisplayName();
  const editRow = document.getElementById('chatNicknameEdit');
  document.getElementById('chatEditNameBtn').onclick = () => {
    editRow.classList.toggle('is-open');
    document.getElementById('chatNicknameInput').value = getChatDisplayName();
  };
  document.getElementById('chatNicknameSaveBtn').onclick = () => {
    const v = document.getElementById('chatNicknameInput').value.trim().slice(0, 24);
    if (v) sessionStorage.setItem(CHAT_NICK_KEY, v);
    document.getElementById('chatWhoAmI').textContent = getChatDisplayName();
    editRow.classList.remove('is-open');
  };

  const send = async () => {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const sender = getChatDisplayName();
    const msg = { sender, role: session.role, text, ts: Date.now() };
    const snap = await liveDocRef.get();
    const d = snap.data() || {};
    // Capped at 200 messages for the same reason as bidHistory — this
    // whole array gets broadcast and persisted on every send.
    const msgs = (d.chatMessages || []).concat(msg).slice(-200);
    await liveDocRef.set({ chatMessages: msgs }, { merge: true });
    clearTyping();
  };
  document.getElementById('chatSendBtn').onclick = send;
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') send();
  });

  // Typing indicator — heavily throttled: at most one write every 2s while
  // actively typing, and it self-expires via timestamp (read side ignores
  // entries older than 4s) instead of needing a separate "stopped typing"
  // write. With 10+ people this keeps it to a trickle of writes, not one
  // per keystroke.
  document.getElementById('chatInput').addEventListener('input', () => {
    clearTimeout(typingDebounce);
    const now = Date.now();
    if (now - lastTypingWrite > 2000){
      lastTypingWrite = now;
      liveDocRef.set({ [`typing.${typingKey(getChatDisplayName())}`]: now }, { merge: true }).catch(()=>{});
    }
    typingDebounce = setTimeout(clearTyping, 3000);
  });
}

function typingKey(name){
  // Dots are path separators in the backend's dotted-key merge logic, so a
  // name containing one (unlikely, but a nickname could) would corrupt the
  // nested structure instead of just being a weird-looking key.
  return String(name).replace(/\./g, '·');
}
function clearTyping(){
  liveDocRef.set({ [`typing.${typingKey(getChatDisplayName())}`]: { __op: 'delete' } }, { merge: true }).catch(()=>{});
}

function renderChat(){
  const list = document.getElementById('chatList');
  list.innerHTML = chatMessages.map(m => {
    const isHost = m.role === 'host';
    const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="chat__msg${isHost ? ' is-host' : ''}">
      <div class="chat__msg-meta">${escapeHtml(m.sender)} · ${time}</div>
      <div class="chat__msg-bubble">${escapeHtml(m.text)}</div>
    </div>`;
  }).join('');
  list.scrollTop = list.scrollHeight;
}

function renderTypingIndicator(typing){
  const el = document.getElementById('chatTypingIndicator');
  if (!el) return;
  const now = Date.now();
  const me = typingKey(getChatDisplayName());
  const active = Object.keys(typing || {}).filter(name => name !== me && (now - typing[name]) < 4000);
  el.textContent = active.length
    ? (active.length === 1 ? `${active[0]} is typing…` : `${active.length} people are typing…`)
    : '';
}

function updateChatBadge(){
  const badge = document.getElementById('chatBadge');
  const unread = Math.max(0, chatMessages.length - chatSeenCount);
  badge.style.display = unread > 0 ? '' : 'none';
  badge.textContent = String(unread);
}

function showChatToast(msg){
  if (chatPanelOpen) return;
  let toast = document.getElementById('chatToast');
  if (!toast){
    toast = document.createElement('div');
    toast.className = 'chat-toast';
    toast.id = 'chatToast';
    document.body.appendChild(toast);
  }
  toast.innerHTML = `<strong>${escapeHtml(msg.sender)}:</strong> ${escapeHtml(msg.text)}`;
  safeGsap(() => {
    gsap.killTweensOf(toast);
    gsap.timeline()
      .to(toast, { opacity: 1, y: 0, duration: 0.25, ease: 'power2.out' })
      .to(toast, { opacity: 0, y: 8, duration: 0.3, delay: 2.2, ease: 'power2.in' });
  });
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Panel open/close (GSAP slide-up) ----------
// Each has a direct-style fallback — if GSAP is unavailable or slow to
// load, the panel must still open/close correctly, just as a snap instead
// of a slide, rather than getting stuck invisible or stuck open.
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
