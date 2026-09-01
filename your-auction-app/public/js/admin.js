(function(){
  const admState = { token: localStorage.getItem('adminToken'), currentAuctionId: null };

  async function admApi(path, opts = {}){
    const headers = opts.headers || {};
    if(admState.token) headers['Authorization'] = 'Bearer ' + admState.token;
    if(!(opts.body instanceof FormData) && opts.body) headers['Content-Type'] = 'application/json';
    const res = await fetch('/api' + path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if(!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  document.getElementById('adminPanelToggle').addEventListener('click', () => {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('adminScreen').classList.remove('hidden');
    admRoute();
  });
  document.getElementById('adminBackToLogin').addEventListener('click', () => {
    document.getElementById('adminScreen').classList.add('hidden');
    document.getElementById('loginScreen').style.display = '';
  });

  document.querySelectorAll('#adminAuthBox .tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#adminAuthBox .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('admLoginForm').classList.toggle('hidden', tab.dataset.admtab !== 'login');
      document.getElementById('admSignupForm').classList.toggle('hidden', tab.dataset.admtab !== 'signup');
    });
  });

  function admRoute(){
    if(admState.token){
      document.getElementById('adminAuthBox').classList.add('hidden');
      document.getElementById('adminDashboard').classList.remove('hidden');
      admLoadAuctions();
    }else{
      document.getElementById('adminAuthBox').classList.remove('hidden');
      document.getElementById('adminDashboard').classList.add('hidden');
    }
  }

  function admSaveToken(token){
    admState.token = token;
    localStorage.setItem('adminToken', token);
  }

  document.getElementById('admLoginBtn').addEventListener('click', async () => {
    const err = document.getElementById('admAuthError'); err.textContent = '';
    try{
      const data = await admApi('/admin/login', { method:'POST', body: JSON.stringify({
        username: document.getElementById('admLoginUser').value.trim(),
        password: document.getElementById('admLoginPass').value,
      })});
      admSaveToken(data.token);
      admRoute();
    }catch(e){ err.textContent = e.message; }
  });

  document.getElementById('admSignupBtn').addEventListener('click', async () => {
    const err = document.getElementById('admAuthError'); err.textContent = '';
    try{
      const data = await admApi('/admin/signup', { method:'POST', body: JSON.stringify({
        username: document.getElementById('admSignupUser').value.trim(),
        password: document.getElementById('admSignupPass').value,
      })});
      admSaveToken(data.token);
      admRoute();
    }catch(e){ err.textContent = e.message; }
  });

  async function admLoadAuctions(){
    document.getElementById('admNewAuctionSection').classList.add('hidden');
    document.getElementById('admManageSection').classList.add('hidden');
    const list = document.getElementById('admAuctionList');
    try{
      const auctions = await admApi('/admin/auctions');
      list.innerHTML = auctions.length ? '' : '<p class="hint">No auctions yet.</p>';
      auctions.forEach(a => {
        const row = document.createElement('div');
        row.className = 'admin-auction-row';
        row.innerHTML = `<span>${a.name} ${a.active ? '🟢 LIVE' : ''}</span><button type="button" class="act btn-outline">Manage</button>`;
        row.querySelector('button').addEventListener('click', () => admOpenManage(a.id, a.name));
        list.appendChild(row);
      });
    }catch(e){ list.innerHTML = `<p class="admin-error">${e.message}</p>`; }
  }

  document.getElementById('admNewAuctionBtn').addEventListener('click', () => {
    const sec = document.getElementById('admNewAuctionSection');
    sec.classList.toggle('hidden');
    document.getElementById('admManageSection').classList.add('hidden');
  });

  document.getElementById('admCreateBtn').addEventListener('click', async () => {
    const err = document.getElementById('admCreateError'); err.textContent = '';
    const teams = document.getElementById('admTeams').value.split('\n').map(s => s.trim().toUpperCase()).filter(Boolean);
    try{
      const data = await admApi('/admin/auctions', { method:'POST', body: JSON.stringify({
        name: document.getElementById('admName').value.trim(),
        purseCr: parseFloat(document.getElementById('admPurse').value),
        squadMin: parseInt(document.getElementById('admSquadMin').value),
        squadMax: parseInt(document.getElementById('admSquadMax').value),
        timerSeconds: parseInt(document.getElementById('admTimer').value),
        teams,
      })});
      admOpenManage(data.id, document.getElementById('admName').value.trim());
    }catch(e){ err.textContent = e.message; }
  });

  function admOpenManage(id, name){
    admState.currentAuctionId = id;
    document.getElementById('admNewAuctionSection').classList.add('hidden');
    document.getElementById('admManageSection').classList.remove('hidden');
    document.getElementById('admManageTitle').textContent = name;
    ['admPlayersResult','admSoundsResult','admCredsResult','admActivateResult'].forEach(id2 => document.getElementById(id2).innerHTML = '');
    admLoadCredEditor();
  }

  // Pulls this auction's teams + whatever passwords already exist (blank
  // for a brand-new auction) and renders one editable password field per
  // team plus one for the host, so re-opening an auction later shows what's
  // actually set right now instead of a blank "auto-generate only" button.
  async function admLoadCredEditor(){
    const box = document.getElementById('admCredEditRows');
    box.innerHTML = '<p class="hint">Loading…</p>';
    try{
      const a = await admApi(`/admin/auctions/${admState.currentAuctionId}`);
      admState.currentTeams = a.teams;
      admRenderCredEditor(a.teams, a.hostPassword, a.teamPasswords || {});
    }catch(e){
      box.innerHTML = `<p class="admin-error">${e.message}</p>`;
    }
  }

  function admRenderCredEditor(teams, hostPassword, teamPasswords){
    const box = document.getElementById('admCredEditRows');
    box.innerHTML = '';
    const hostRow = document.createElement('div');
    hostRow.className = 'admin-cred-edit-row';
    hostRow.innerHTML = `<span class="cred-label">host</span><input type="text" data-role="host" value="${(hostPassword||'').replace(/"/g,'&quot;')}" placeholder="host password">`;
    box.appendChild(hostRow);
    for(const team of teams){
      const row = document.createElement('div');
      row.className = 'admin-cred-edit-row';
      const pw = teamPasswords[team] || '';
      row.innerHTML = `<span class="cred-label">${team}</span><input type="text" data-role="team" data-team="${team}" value="${pw.replace(/"/g,'&quot;')}" placeholder="${team} password">`;
      box.appendChild(row);
    }
  }

  function genRandomPw(){ return Math.random().toString(36).slice(2, 8); }

  document.getElementById('admAutofillCredsBtn').addEventListener('click', () => {
    // Purely client-side suggestion — fills the fields so they can still be
    // hand-edited before anything is actually saved to the server.
    document.querySelectorAll('#admCredEditRows input').forEach(input => { input.value = genRandomPw(); });
  });

  document.getElementById('admSaveCredsBtn').addEventListener('click', async () => {
    const box = document.getElementById('admCredsResult');
    box.innerHTML = '';
    const hostInput = document.querySelector('#admCredEditRows input[data-role="host"]');
    const teamPasswords = {};
    document.querySelectorAll('#admCredEditRows input[data-role="team"]').forEach(input => {
      teamPasswords[input.dataset.team] = input.value.trim();
    });
    try{
      await admApi(`/admin/auctions/${admState.currentAuctionId}/credentials/manual`, {
        method: 'POST',
        body: JSON.stringify({ hostPassword: hostInput.value.trim(), teamPasswords }),
      });
      box.innerHTML = '<span class="ok">Saved. If this auction is already live, everyone should re-enter with the new passwords.</span>';
    }catch(e){
      box.innerHTML = `<span class="err">${e.message}</span>`;
    }
  });

  document.getElementById('admUploadPlayersBtn').addEventListener('click', async () => {
    const box = document.getElementById('admPlayersResult');
    const file = document.getElementById('admPlayersFile').files[0];
    if(!file){ box.innerHTML = '<span class="err">Choose a file first.</span>'; return; }
    const fd = new FormData(); fd.append('file', file);
    try{
      const data = await admApi(`/admin/auctions/${admState.currentAuctionId}/players`, { method:'POST', body: fd });
      let html = `<span class="ok">Imported ${data.imported} of ${data.totalRows} rows.</span>`;
      if(data.errors && data.errors.length) html += `<br><span class="err">${data.errors.length} row(s) skipped, e.g. row ${data.errors[0].row}: ${data.errors[0].error}</span>`;
      box.innerHTML = html;
    }catch(e){ box.innerHTML = `<span class="err">${e.message}</span>`; }
  });

  document.getElementById('admUploadSoundsBtn').addEventListener('click', async () => {
    const box = document.getElementById('admSoundsResult');
    const fd = new FormData();
    let any = false;
    for(const key of ['bid','sold','unsold']){
      const el = document.getElementById('admSound' + key[0].toUpperCase() + key.slice(1));
      if(el.files[0]){ fd.append(key, el.files[0]); any = true; }
    }
    if(!any){ box.innerHTML = '<span class="err">Choose at least one sound.</span>'; return; }
    try{
      const data = await admApi(`/admin/auctions/${admState.currentAuctionId}/sounds`, { method:'POST', body: fd });
      box.innerHTML = `<span class="ok">Saved: ${data.updated.join(', ')}</span>`;
    }catch(e){ box.innerHTML = `<span class="err">${e.message}</span>`; }
  });

  document.getElementById('admActivateBtn').addEventListener('click', async () => {
    const box = document.getElementById('admActivateResult');
    try{
      await admApi(`/admin/auctions/${admState.currentAuctionId}/activate`, { method:'POST' });
      // The main login screen only reads teams/players/passwords once, at
      // page load (loadAdminConfig() inside init()) — without a reload it
      // just silently keeps showing whatever was already loaded, which
      // looked like "I activated an auction but the website didn't
      // update". Reloading is simplest and guaranteed correct.
      box.innerHTML = '<span class="ok">Activated — reloading so the login screen picks it up…</span>';
      setTimeout(() => location.reload(), 1200);
    }catch(e){ box.innerHTML = `<span class="err">${e.message}</span>`; }
  });
})();
