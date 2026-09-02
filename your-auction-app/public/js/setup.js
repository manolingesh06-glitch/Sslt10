/* ============================================================
   HOST SETUP — fully separate from the main app script, same
   isolation principle the old admin panel used. Uses its own
   sessionStorage key ('setupKey') so it never touches the main
   app's session. Only crosses over via loadAdminConfig() in
   app.js, which reads /api/config/current — nothing here calls
   into the main app's functions directly.

   No accounts, no signup, no per-user ownership: this is a single
   shared passphrase (HOST_SETUP_KEY, set in .env) that unlocks
   editing the one auction this deployment runs. Reachable from the
   login screen (so the very first auction can be set up before any
   host/team password exists yet) and from inside the host's own
   dashboard once the auction is live (for later touch-ups).
   ============================================================ */
(function(){
  const state = { key: sessionStorage.getItem('setupKey') };

  async function setupApi(path, opts = {}){
    const headers = opts.headers || {};
    if(state.key) headers['Authorization'] = 'Bearer ' + state.key;
    if(!(opts.body instanceof FormData) && opts.body) headers['Content-Type'] = 'application/json';
    const res = await fetch('/api' + path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function openSetup(){
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mainApp').classList.add('hidden');
    document.getElementById('setupScreen').classList.remove('hidden');
    route();
  }
  function closeSetup(){
    document.getElementById('setupScreen').classList.add('hidden');
    // Return to wherever makes sense: back to the host dashboard if a
    // session is already active, otherwise back to the login screen.
    let hasSession = false;
    try{ hasSession = !!sessionStorage.getItem('spl-s3-session'); }catch(e){}
    if(hasSession){
      document.getElementById('mainApp').classList.remove('hidden');
    }else{
      document.getElementById('loginScreen').style.display = '';
    }
  }

  const loginToggle = document.getElementById('setupToggle');
  if(loginToggle) loginToggle.addEventListener('click', openSetup);
  const hostToggle = document.getElementById('openSetupBtn');
  if(hostToggle) hostToggle.addEventListener('click', openSetup);
  document.getElementById('setupBackToLogin').addEventListener('click', closeSetup);

  function route(){
    if(state.key){
      document.getElementById('setupKeyBox').classList.add('hidden');
      document.getElementById('setupDashboard').classList.remove('hidden');
      loadAuction();
    }else{
      document.getElementById('setupKeyBox').classList.remove('hidden');
      document.getElementById('setupDashboard').classList.add('hidden');
    }
  }

  function saveKey(key){
    state.key = key;
    sessionStorage.setItem('setupKey', key);
  }

  document.getElementById('setupKeyBtn').addEventListener('click', async () => {
    const err = document.getElementById('setupKeyError'); err.textContent = '';
    const key = document.getElementById('setupKeyInput').value;
    try{
      state.key = key; // set before the call so setupApi() sends it as the Bearer token
      await setupApi('/setup/unlock', { method:'POST' });
      saveKey(key);
      route();
    }catch(e){ state.key = null; err.textContent = e.message; }
  });

  async function loadAuction(){
    ['setSaveResult','setPlayersResult','setSoundsResult','setCredsResult','setActivateResult']
      .forEach(id => document.getElementById(id).innerHTML = '');
    try{
      const a = await setupApi('/setup/auction');
      document.getElementById('setName').value = a.name || '';
      document.getElementById('setPurse').value = a.purseCr || 120;
      document.getElementById('setSquadMin').value = a.squadMin || 16;
      document.getElementById('setSquadMax').value = a.squadMax || 20;
      document.getElementById('setTimer').value = a.timerSeconds || 15;
      document.getElementById('setTeams').value = (a.teams || []).join('\n');
      renderCredEditor(a.teams || [], a.hostPassword, a.teamPasswords || {});
    }catch(e){
      document.getElementById('setSaveResult').innerHTML = `<span class="err">${e.message}</span>`;
    }
  }

  document.getElementById('setSaveBtn').addEventListener('click', async () => {
    const box = document.getElementById('setSaveResult'); box.innerHTML = '';
    const teams = document.getElementById('setTeams').value.split('\n').map(s => s.trim().toUpperCase()).filter(Boolean);
    try{
      await setupApi('/setup/auction', { method:'POST', body: JSON.stringify({
        name: document.getElementById('setName').value.trim(),
        purseCr: parseFloat(document.getElementById('setPurse').value),
        squadMin: parseInt(document.getElementById('setSquadMin').value),
        squadMax: parseInt(document.getElementById('setSquadMax').value),
        timerSeconds: parseInt(document.getElementById('setTimer').value),
        teams,
      })});
      box.innerHTML = '<span class="ok">Saved.</span>';
      renderCredEditor(teams, null, null); // team list may have changed — refresh the password rows
    }catch(e){ box.innerHTML = `<span class="err">${e.message}</span>`; }
  });

  function renderCredEditor(teams, hostPassword, teamPasswords){
    const box = document.getElementById('setCredEditRows');
    box.innerHTML = '';
    const hostRow = document.createElement('div');
    hostRow.className = 'admin-cred-edit-row';
    hostRow.innerHTML = `<span class="cred-label">host</span><input type="text" data-role="host" value="${(hostPassword||'').replace(/"/g,'&quot;')}" placeholder="host password">`;
    box.appendChild(hostRow);
    for(const team of teams){
      const row = document.createElement('div');
      row.className = 'admin-cred-edit-row';
      const pw = (teamPasswords && teamPasswords[team]) || '';
      row.innerHTML = `<span class="cred-label">${team}</span><input type="text" data-role="team" data-team="${team}" value="${pw.replace(/"/g,'&quot;')}" placeholder="${team} password">`;
      box.appendChild(row);
    }
  }

  function genRandomPw(){ return Math.random().toString(36).slice(2, 8); }

  document.getElementById('setAutofillCredsBtn').addEventListener('click', () => {
    document.querySelectorAll('#setCredEditRows input').forEach(input => { input.value = genRandomPw(); });
  });

  document.getElementById('setSaveCredsBtn').addEventListener('click', async () => {
    const box = document.getElementById('setCredsResult'); box.innerHTML = '';
    const hostInput = document.querySelector('#setCredEditRows input[data-role="host"]');
    const teamPasswords = {};
    document.querySelectorAll('#setCredEditRows input[data-role="team"]').forEach(input => {
      teamPasswords[input.dataset.team] = input.value.trim();
    });
    try{
      await setupApi('/setup/credentials/manual', {
        method: 'POST',
        body: JSON.stringify({ hostPassword: hostInput.value.trim(), teamPasswords }),
      });
      box.innerHTML = '<span class="ok">Saved. If this auction is already live, everyone should re-enter with the new passwords.</span>';
    }catch(e){ box.innerHTML = `<span class="err">${e.message}</span>`; }
  });

  document.getElementById('setUploadPlayersBtn').addEventListener('click', async () => {
    const box = document.getElementById('setPlayersResult');
    const file = document.getElementById('setPlayersFile').files[0];
    if(!file){ box.innerHTML = '<span class="err">Choose a file first.</span>'; return; }
    const fd = new FormData(); fd.append('file', file);
    try{
      const data = await setupApi('/setup/players', { method:'POST', body: fd });
      let html = `<span class="ok">Imported ${data.imported} of ${data.totalRows} rows.</span>`;
      if(data.errors && data.errors.length) html += `<br><span class="err">${data.errors.length} row(s) skipped, e.g. row ${data.errors[0].row}: ${data.errors[0].error}</span>`;
      box.innerHTML = html;
    }catch(e){ box.innerHTML = `<span class="err">${e.message}</span>`; }
  });

  document.getElementById('setUploadSoundsBtn').addEventListener('click', async () => {
    const box = document.getElementById('setSoundsResult');
    const fd = new FormData();
    let any = false;
    for(const key of ['bid','sold','unsold']){
      const el = document.getElementById('setSound' + key[0].toUpperCase() + key.slice(1));
      if(el.files[0]){ fd.append(key, el.files[0]); any = true; }
    }
    if(!any){ box.innerHTML = '<span class="err">Choose at least one sound.</span>'; return; }
    try{
      const data = await setupApi('/setup/sounds', { method:'POST', body: fd });
      box.innerHTML = `<span class="ok">Saved: ${data.updated.join(', ')}</span>`;
    }catch(e){ box.innerHTML = `<span class="err">${e.message}</span>`; }
  });

  document.getElementById('setActivateBtn').addEventListener('click', async () => {
    const box = document.getElementById('setActivateResult');
    try{
      await setupApi('/setup/activate', { method:'POST' });
      box.innerHTML = '<span class="ok">Activated — reloading so the login screen picks it up…</span>';
      setTimeout(() => location.reload(), 1200);
    }catch(e){ box.innerHTML = `<span class="err">${e.message}</span>`; }
  });
})();
