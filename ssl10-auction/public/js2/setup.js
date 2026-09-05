// SSL T10 — Host Setup
// Talks directly to the real backend routes in src/routes.js.

const KEY_STORAGE = 'ssl10-setup-key';
let setupKey = null;
let teams = [];
let currentAuction = null;

const gate = document.getElementById('gate');
const dashboard = document.getElementById('dashboard');

// ---------- Gate ----------
document.getElementById('gateBtn').onclick = tryUnlock;
document.getElementById('gateKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

async function tryUnlock() {
  const key = document.getElementById('gateKey').value.trim();
  const errBox = document.getElementById('gateError');
  errBox.style.display = 'none';
  if (!key) return;

  try {
    const res = await fetch('/api/setup/unlock', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      errBox.textContent = d.error || 'Incorrect setup key.';
      errBox.style.display = '';
      return;
    }
  } catch (e) {
    errBox.textContent = 'Could not reach the server.';
    errBox.style.display = '';
    return;
  }

  setupKey = key;
  sessionStorage.setItem(KEY_STORAGE, key);

  // Showing the dashboard is a real state change, not decoration — it must
  // happen even if GSAP's CDN script is blocked/slow on this network.
  const reveal = () => { gate.style.display = 'none'; showDashboard(); };
  try {
    gsap.to(gate, { opacity: 0, duration: 0.25, onComplete: reveal });
  } catch (e) {
    reveal();
  }
}

function authHeaders(extra) {
  return Object.assign({ Authorization: `Bearer ${setupKey}` }, extra || {});
}

function showDashboard() {
  dashboard.style.display = '';
  try {
    gsap.from(dashboard, { opacity: 0, y: 12, duration: 0.4, ease: 'power2.out' });
  } catch (e) { /* dashboard is already visible via display change above */ }
  loadAuction();
}

// Auto-unlock if we already have a key from earlier this session
(function tryAutoUnlock(){
  const saved = sessionStorage.getItem(KEY_STORAGE);
  if (saved) { document.getElementById('gateKey').value = saved; tryUnlock(); }
})();

// ---------- Load current config ----------
async function loadAuction() {
  const res = await fetch('/api/setup/auction', { headers: authHeaders() });
  const a = await res.json();
  currentAuction = a;
  teams = a.teams || [];

  document.getElementById('fName').value = a.name || '';
  document.getElementById('fPurse').value = a.purseCr || 120;
  document.getElementById('fTimer').value = a.timerSeconds || 15;
  document.getElementById('fSquadMin').value = a.squadMin || 16;
  document.getElementById('fSquadMax').value = a.squadMax || 20;

  renderTeamChips();
  renderCredsTable();
  renderStatus(a);

  if (a.hasPlayers) document.getElementById('playersResult').textContent = 'Players already uploaded ✓';
  ['bid','sold','unsold'].forEach(k => {
    if (a.sounds && a.sounds[k]) {
      document.querySelector(`#drop${k[0].toUpperCase()+k.slice(1)} .filedrop__result`).textContent = 'Uploaded ✓';
    }
  });
}

function renderStatus(a) {
  const banner = document.getElementById('statusBanner');
  if (a.active) {
    banner.className = 'setup__status setup__status--live';
    banner.textContent = '● Live — this auction is active and accepting logins';
  } else {
    banner.className = 'setup__status setup__status--draft';
    banner.textContent = '○ Draft — not activated yet';
  }
}

// ---------- Teams ----------
document.getElementById('addTeamBtn').onclick = addTeam;
document.getElementById('teamNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTeam(); });

function addTeam() {
  const input = document.getElementById('teamNameInput');
  const name = input.value.trim();
  if (!name || teams.includes(name)) { input.value = ''; return; }
  teams.push(name);
  input.value = '';
  renderTeamChips();
  renderCredsTable();
}

function renderTeamChips() {
  const wrap = document.getElementById('teamChips');
  wrap.innerHTML = '';
  teams.forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'team-chip-tag';
    chip.innerHTML = `${escapeHtml(t)} <button aria-label="Remove ${escapeHtml(t)}">✕</button>`;
    chip.querySelector('button').onclick = () => {
      teams = teams.filter(x => x !== t);
      renderTeamChips();
      renderCredsTable();
    };
    wrap.appendChild(chip);
  });
}

// ---------- Save auction + teams ----------
document.getElementById('saveAuctionBtn').onclick = async () => {
  const name = document.getElementById('fName').value.trim();
  if (!name) return toast('Enter an auction name.', true);
  if (teams.length < 2) return toast('Add at least 2 teams.', true);

  const body = {
    name,
    purseCr: parseFloat(document.getElementById('fPurse').value) || 120,
    timerSeconds: parseInt(document.getElementById('fTimer').value) || 15,
    squadMin: parseInt(document.getElementById('fSquadMin').value) || 16,
    squadMax: parseInt(document.getElementById('fSquadMax').value) || 20,
    teams
  };

  const res = await fetch('/api/setup/auction', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });
  const d = await res.json();
  if (!res.ok) return toast(d.error || 'Could not save.', true);
  toast('Auction details saved.', false);
  renderCredsTable();
};

// ---------- Players upload ----------
document.getElementById('playersFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const resultBox = document.getElementById('playersResult');
  resultBox.textContent = 'Uploading…';

  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/setup/players', { method: 'POST', headers: authHeaders(), body: fd });
  const d = await res.json();
  if (!res.ok) { resultBox.textContent = d.error || 'Upload failed.'; return; }

  document.getElementById('playersDrop').classList.add('has-file');
  resultBox.textContent = `Imported ${d.imported} of ${d.totalRows} rows` +
    (d.errors && d.errors.length ? ` (${d.errors.length} skipped)` : '');
});

// ---------- Sounds upload ----------
function wireSound(inputId, dropId) {
  document.getElementById(inputId).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const drop = document.getElementById(dropId);
    const resultBox = drop.querySelector('.filedrop__result');
    resultBox.textContent = 'Uploading…';

    const fd = new FormData();
    fd.append(inputId.replace('sound','').toLowerCase(), file);
    const res = await fetch('/api/setup/sounds', { method: 'POST', headers: authHeaders(), body: fd });
    const d = await res.json();
    if (!res.ok) { resultBox.textContent = 'Failed.'; return; }
    drop.classList.add('has-file');
    resultBox.textContent = 'Uploaded ✓';
  });
}
wireSound('soundBid', 'dropBid');
wireSound('soundSold', 'dropSold');
wireSound('soundUnsold', 'dropUnsold');

// ---------- Credentials ----------
function renderCredsTable() {
  const table = document.getElementById('credsTable');
  table.innerHTML = '';

  const hostRow = document.createElement('div');
  hostRow.className = 'creds-row';
  hostRow.innerHTML = `<div class="creds-row__name">Host</div><input id="credHost" placeholder="passcode" value="${escapeAttr(currentAuction && currentAuction.hostPassword || '')}">`;
  table.appendChild(hostRow);

  teams.forEach((t) => {
    const existing = (currentAuction && currentAuction.teamPasswords && currentAuction.teamPasswords[t]) || '';
    const row = document.createElement('div');
    row.className = 'creds-row';
    row.innerHTML = `<div class="creds-row__name">${escapeHtml(t)}</div><input class="cred-team" data-team="${escapeAttr(t)}" placeholder="passcode" value="${escapeAttr(existing)}">`;
    table.appendChild(row);
  });
}

document.getElementById('genCredsBtn').onclick = async () => {
  if (teams.length < 2) return toast('Save at least 2 teams first.', true);
  const res = await fetch('/api/setup/credentials', { method: 'POST', headers: authHeaders() });
  const d = await res.json();
  if (!res.ok) return toast(d.error || 'Could not generate.', true);

  const hostCred = d.credentials.find(c => c.role === 'host');
  document.getElementById('credHost').value = hostCred.password;
  d.credentials.filter(c => c.role === 'owner').forEach(c => {
    const input = document.querySelector(`.cred-team[data-team="${cssEscape(c.team)}"]`);
    if (input) input.value = c.password;
  });
  toast('Random passwords generated — remember to Save.', false);
};

document.getElementById('saveCredsBtn').onclick = async () => {
  const hostPassword = document.getElementById('credHost').value.trim();
  if (!hostPassword) return toast('Host password is required.', true);

  const teamPasswords = {};
  let missing = null;
  document.querySelectorAll('.cred-team').forEach(input => {
    const v = input.value.trim();
    if (!v) missing = input.dataset.team;
    teamPasswords[input.dataset.team] = v;
  });
  if (missing) return toast(`Password required for ${missing}.`, true);

  const res = await fetch('/api/setup/credentials/manual', {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ hostPassword, teamPasswords })
  });
  const d = await res.json();
  if (!res.ok) return toast(d.error || 'Could not save.', true);
  toast('Passwords saved.', false);
};

// ---------- Activate ----------
document.getElementById('activateBtn').onclick = async () => {
  if (teams.length < 2) return toast('Add and save at least 2 teams first.', true);
  const res = await fetch('/api/setup/activate', { method: 'POST', headers: authHeaders() });
  const d = await res.json();
  if (!res.ok) return toast(d.error || 'Could not activate.', true);
  toast('Auction activated! Teams can now log in.', false);
  loadAuction();
};

// ---------- Helpers ----------
function toast(msg, isError) {
  const box = document.getElementById('toast');
  box.textContent = msg;
  box.style.color = isError ? '#7A3B34' : '#3E5C2E';
  gsap.fromTo(box, { opacity: 0 }, { opacity: 1, duration: 0.2 });
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s){ return escapeHtml(s); }
function cssEscape(s){ return String(s).replace(/["\\]/g, '\\$&'); }
