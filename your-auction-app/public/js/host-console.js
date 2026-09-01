(() => {
  const css = `
    #sslt10HostBtn{position:fixed;right:16px;bottom:18px;z-index:1100;border:1px solid rgba(255,200,74,.5);background:#171d2b;color:#ffc84a;border-radius:10px;padding:11px 14px;font-weight:800;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.28)}
    #sslt10HostOverlay{position:fixed;inset:0;z-index:1090;background:rgba(5,8,14,.82);backdrop-filter:blur(10px);display:none;padding:18px;overflow:auto}
    #sslt10HostPanel{max-width:1180px;margin:0 auto;background:#111827;border:1px solid #2a3448;border-radius:18px;min-height:calc(100vh - 36px);color:#eef2f7;overflow:hidden}
    .s10-top{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:18px 20px;border-bottom:1px solid #2a3448;position:sticky;top:0;background:#111827;z-index:3}
    .s10-brand{font-size:22px;font-weight:900;letter-spacing:.5px}.s10-brand span{color:#ffc84a}.s10-close{border:0;background:#252d3d;color:#fff;border-radius:9px;padding:9px 12px;cursor:pointer}
    .s10-layout{display:grid;grid-template-columns:180px 1fr;min-height:calc(100vh - 110px)}
    .s10-nav{padding:14px;border-right:1px solid #2a3448;background:#0d1320}.s10-nav button{width:100%;text-align:left;border:0;background:transparent;color:#9ba7b8;padding:11px 12px;border-radius:9px;margin-bottom:5px;cursor:pointer;font-weight:700}.s10-nav button.active,.s10-nav button:hover{background:#20283a;color:#ffc84a}
    .s10-content{padding:22px}.s10-section{display:none}.s10-section.active{display:block}.s10-title{font-size:25px;font-weight:900;margin:0 0 6px}.s10-muted{color:#9ba7b8;font-size:13px}.s10-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0}.s10-card{background:#171f2e;border:1px solid #2a3448;border-radius:13px;padding:16px}.s10-card .n{font-size:27px;font-weight:900;color:#ffc84a}.s10-card .l{font-size:11px;color:#9ba7b8;text-transform:uppercase;letter-spacing:.6px;margin-top:3px}
    .s10-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;background:#171f2e;border:1px solid #2a3448;border-radius:13px;padding:14px;margin:14px 0}.s10-form label{font-size:11px;color:#9ba7b8;text-transform:uppercase}.s10-form input,.s10-form select{width:100%;box-sizing:border-box;margin-top:5px;background:#0c1220;color:#eef2f7;border:1px solid #344056;border-radius:8px;padding:10px}.s10-btn{border:0;border-radius:8px;padding:10px 13px;cursor:pointer;font-weight:800}.s10-primary{background:#ffc84a;color:#15110a}.s10-secondary{background:#273145;color:#eef2f7}.s10-danger{background:#572631;color:#ffb5bd}.s10-table-wrap{overflow:auto;border:1px solid #2a3448;border-radius:12px}.s10-table{width:100%;border-collapse:collapse;min-width:720px}.s10-table th,.s10-table td{padding:10px;border-bottom:1px solid #263043;text-align:left;font-size:12px}.s10-table th{color:#9ba7b8;text-transform:uppercase;font-size:10px;letter-spacing:.5px;background:#151c2a;position:sticky;top:0}.s10-actions{display:flex;gap:6px;flex-wrap:wrap}.s10-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:12px 0}.s10-preview{background:#0b111d;border:1px solid #2a3448;border-radius:10px;padding:12px;max-height:240px;overflow:auto;font-size:12px}.s10-error{color:#ff9ca8;margin-top:8px;white-space:pre-wrap}.s10-success{color:#6ee7b7;margin-top:8px;white-space:pre-wrap}.s10-setup-banner{padding:14px;border:1px solid rgba(255,200,74,.35);background:rgba(255,200,74,.08);border-radius:12px;margin-bottom:16px}
    @media(max-width:800px){.s10-layout{grid-template-columns:1fr}.s10-nav{display:flex;overflow:auto;border-right:0;border-bottom:1px solid #2a3448;gap:6px}.s10-nav button{min-width:max-content;margin:0}.s10-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.s10-form{grid-template-columns:1fr}.s10-content{padding:14px}.s10-top{position:sticky}}
  `;
  const style=document.createElement('style'); style.textContent=css; document.head.appendChild(style);

  let teams=[], players=[], dashboard=null;
  const api=window.sslt10Api;
  const session=window.sslt10Session ? window.sslt10Session() : null;
  if(!session || session.role!=='host' || !api) return;

  const btn=document.createElement('button'); btn.id='sslt10HostBtn'; btn.textContent='⚙ HOST SETUP'; document.body.appendChild(btn);
  const overlay=document.createElement('div'); overlay.id='sslt10HostOverlay';
  overlay.innerHTML=`<div id="sslt10HostPanel">
    <div class="s10-top"><div class="s10-brand"><span>SSLT10</span> Host Console</div><button class="s10-close" id="s10Close">Close</button></div>
    <div class="s10-layout">
      <nav class="s10-nav">
        <button class="active" data-tab="dashboard">Dashboard</button><button data-tab="teams">Teams</button><button data-tab="players">Players</button><button data-tab="auction">Live Auction</button><button data-tab="results">Results</button><button data-tab="settings">Settings</button>
      </nav>
      <main class="s10-content">
        <section id="s10-dashboard" class="s10-section active"></section>
        <section id="s10-teams" class="s10-section"></section>
        <section id="s10-players" class="s10-section"></section>
        <section id="s10-auction" class="s10-section"></section>
        <section id="s10-results" class="s10-section"></section>
        <section id="s10-settings" class="s10-section"></section>
      </main>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  function esc(v){const d=document.createElement('div');d.textContent=v??'';return d.innerHTML;}
  function open(){overlay.style.display='block'; refreshAll();}
  function close(){overlay.style.display='none';}
  btn.onclick=open; overlay.querySelector('#s10Close').onclick=close;
  overlay.querySelectorAll('.s10-nav button').forEach(b=>b.onclick=()=>switchTab(b.dataset.tab));
  function switchTab(tab){
    overlay.querySelectorAll('.s10-nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
    overlay.querySelectorAll('.s10-section').forEach(s=>s.classList.toggle('active',s.id===`s10-${tab}`));
    renderTab(tab);
  }

  async function refreshAll(){
    try{
      [teams,players,dashboard]=await Promise.all([api('/api/host/teams'),api('/api/host/players'),api('/api/host/dashboard')]);
      renderTab('dashboard');
      if(!teams.length || !players.length){
        overlay.querySelector('#s10-dashboard').insertAdjacentHTML('afterbegin',`<div class="s10-setup-banner"><b>Start with a clean SSLT10 auction.</b><div class="s10-muted">No old teams or players are preloaded. Add your real teams and player pool before starting the live auction.</div></div>`);
      }
    }catch(e){alert(e.message);}
  }
  function renderTab(tab){if(tab==='dashboard')renderDashboard();if(tab==='teams')renderTeams();if(tab==='players')renderPlayers();if(tab==='auction')renderAuction();if(tab==='results')renderResults();if(tab==='settings')renderSettings();}

  function renderDashboard(){
    const d=dashboard||{}; const el=document.getElementById('s10-dashboard');
    el.innerHTML=`<h2 class="s10-title">Host Dashboard</h2><div class="s10-muted">SSLT10 setup and auction control</div>
      <div class="s10-grid"><div class="s10-card"><div class="n">${d.teams||0}</div><div class="l">Teams</div></div><div class="s10-card"><div class="n">${d.players||0}</div><div class="l">Players</div></div><div class="s10-card"><div class="n">${d.sold||0}</div><div class="l">Sold</div></div><div class="s10-card"><div class="n">${d.unsold||0}</div><div class="l">Unsold</div></div></div>
      <div class="s10-card"><b>Auction status:</b> ${d.auctionStarted?'LIVE / STARTED':'Not started'} &nbsp; <span class="s10-muted">Current player index: ${d.currentIdx??-1}</span></div>`;
  }

  function renderTeams(){
    const el=document.getElementById('s10-teams');
    el.innerHTML=`<h2 class="s10-title">Teams</h2><div class="s10-muted">Create the new SSLT10 team pool. No legacy teams are loaded.</div>
      <form class="s10-form" id="s10TeamForm">
        <label>Team Name<input name="name" required placeholder="Chennai Strikers"></label><label>Short Name<input name="shortName" required placeholder="CS"></label><label>Owner Name<input name="owner" placeholder="Owner"></label>
        <label>Budget (Cr)<input name="budget" type="number" step="0.01" value="120"></label><label>Min Squad<input name="minSquadSize" type="number" value="16"></label><label>Max Squad<input name="maxSquadSize" type="number" value="20"></label>
        <label>Max Overseas<input name="maxOverseas" type="number" placeholder="Optional"></label><label>Team Logo URL<input name="logo" placeholder="Optional image URL"></label><label>Owner Password<input name="password" placeholder="Optional; auto-generated if blank"></label>
        <div><button class="s10-btn s10-primary">+ Add Team</button></div><div id="s10TeamMsg"></div>
      </form>
      <div class="s10-toolbar"><b>${teams.length} teams</b><label class="s10-btn s10-secondary" style="cursor:pointer">Bulk CSV/XLSX <input id="s10TeamFile" type="file" accept=".csv,.xlsx,.xls" style="display:none"></label><button class="s10-btn s10-secondary" id="s10TeamRefresh">Refresh</button></div>
      <div id="s10TeamPreview"></div><div class="s10-table-wrap"><table class="s10-table"><thead><tr><th>Team</th><th>Short</th><th>Owner</th><th>Budget</th><th>Squad</th><th>Actions</th></tr></thead><tbody>${teams.map(t=>`<tr><td>${esc(t.name)}</td><td><b>${esc(t.shortName)}</b></td><td>${esc(t.owner)}</td><td>₹${Number(t.budget).toFixed(2)} Cr</td><td>${t.minSquadSize}-${t.maxSquadSize}</td><td><div class="s10-actions"><button class="s10-btn s10-danger" data-del-team="${t.id}">Delete</button><button class="s10-btn s10-secondary" data-pwd-team="${t.id}">Password</button></div></td></tr>`).join('')}</tbody></table></div>`;
    el.querySelector('#s10TeamForm').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);const b=Object.fromEntries(f.entries());try{const r=await api('/api/host/teams',{method:'POST',body:JSON.stringify(b)});document.getElementById('s10TeamMsg').innerHTML=`<div class="s10-success">Created ${esc(r.team.shortName)} — login: ${esc(r.credentials.username)} / ${esc(r.credentials.password)}</div>`;e.target.reset();await refreshAll();renderTeams();}catch(x){document.getElementById('s10TeamMsg').innerHTML=`<div class="s10-error">${esc(x.message)}</div>`;}};
    el.querySelector('#s10TeamRefresh').onclick=refreshAll;
    el.querySelectorAll('[data-del-team]').forEach(b=>b.onclick=async()=>{if(confirm('Delete this team and its login?')){await api('/api/host/teams/'+b.dataset.delTeam,{method:'DELETE'});await refreshAll();renderTeams();}});
    el.querySelectorAll('[data-pwd-team]').forEach(b=>b.onclick=async()=>{const p=prompt('New team password:');if(p){await api('/api/host/teams/'+b.dataset.pwdTeam+'/password',{method:'POST',body:JSON.stringify({password:p})});alert('Password updated.');}});
    el.querySelector('#s10TeamFile').onchange=async e=>{if(!e.target.files[0])return;const fd=new FormData();fd.append('file',e.target.files[0]);try{const r=await api('/api/host/teams/preview',{method:'POST',body:fd});document.getElementById('s10TeamPreview').innerHTML=`<div class="s10-preview"><b>Preview:</b> ${r.validCount} valid, ${r.invalidCount} invalid<br>${r.errors.map(x=>`Row ${x.row}: ${esc(x.error)}`).join('<br>')}<br><br><button class="s10-btn s10-primary" id="s10ConfirmTeams">Confirm valid teams</button></div>`;document.getElementById('s10ConfirmTeams').onclick=async()=>{const x=await api('/api/host/teams/import',{method:'POST',body:JSON.stringify({teams:r.valid})});alert(`Imported ${x.imported} teams. Save the generated owner credentials now:\n\n`+x.credentials.map(c=>`${c.username} / ${c.password}`).join('\n'));await refreshAll();renderTeams();};}catch(x){alert(x.message);}};
  }

  function renderPlayers(){
    const el=document.getElementById('s10-players');
    const rows=players.filter(p=>!window.__s10PlayerSearch || p.name.toLowerCase().includes(window.__s10PlayerSearch));
    el.innerHTML=`<h2 class="s10-title">Players</h2><div class="s10-muted">Build the SSLT10 player pool with validation before bulk import.</div>
      <form class="s10-form" id="s10PlayerForm"><label>Player ID<input name="playerId" required placeholder="P001"></label><label>Player Name<input name="name" required></label><label>Base Price<input name="basePrice" required placeholder="50L / 0.5C"></label><label>Category<input name="category" placeholder="BATTER"></label><label>Role<input name="role" placeholder="Batter / Bowler / All-Rounder / WK"></label><label>Local/Overseas<input name="localOverseas" placeholder="Local / Overseas"></label><label>Nationality<input name="nationality"></label><label>Batting Style<input name="battingStyle"></label><label>Bowling Style<input name="bowlingStyle"></label><label>Photo URL<input name="photo"></label><div><button class="s10-btn s10-primary">+ Add Player</button></div><div id="s10PlayerMsg"></div></form>
      <div class="s10-toolbar"><input id="s10PlayerSearch" class="s10-btn s10-secondary" style="text-align:left" placeholder="Search player…" value="${esc(window.__s10PlayerSearch||'')}"><label class="s10-btn s10-secondary" style="cursor:pointer">Bulk CSV/XLSX <input id="s10PlayerFile" type="file" accept=".csv,.xlsx,.xls" style="display:none"></label><button class="s10-btn s10-secondary" id="s10PlayerRefresh">Refresh</button></div>
      <div id="s10PlayerPreview"></div><div class="s10-table-wrap"><table class="s10-table"><thead><tr><th>ID</th><th>Player</th><th>Category</th><th>Role</th><th>Base</th><th>Local/Overseas</th><th>Order</th><th>Actions</th></tr></thead><tbody>${rows.slice(0,250).map(p=>`<tr><td>${esc(p.player_id)}</td><td><b>${esc(p.name)}</b></td><td>${esc(p.category)}</td><td>${esc(p.role)}</td><td>${Number(p.base_price_cr).toFixed(2)} Cr</td><td>${esc(p.local_overseas)}</td><td>${p.auction_order}</td><td><button class="s10-btn s10-danger" data-del-player="${p.id}">Delete</button></td></tr>`).join('')}</tbody></table></div><div class="s10-muted" style="margin-top:8px">Showing ${Math.min(rows.length,250)} of ${rows.length} matching players.</div>`;
    el.querySelector('#s10PlayerForm').onsubmit=async e=>{e.preventDefault();const b=Object.fromEntries(new FormData(e.target).entries());try{await api('/api/host/players',{method:'POST',body:JSON.stringify(b)});e.target.reset();await refreshAll();renderPlayers();}catch(x){document.getElementById('s10PlayerMsg').innerHTML=`<div class="s10-error">${esc(x.message)}</div>`;}};
    el.querySelector('#s10PlayerSearch').oninput=e=>{window.__s10PlayerSearch=e.target.value.toLowerCase().trim();renderPlayers();};
    el.querySelector('#s10PlayerRefresh').onclick=refreshAll;
    el.querySelectorAll('[data-del-player]').forEach(b=>b.onclick=async()=>{if(confirm('Delete this player?')){await api('/api/host/players/'+b.dataset.delPlayer,{method:'DELETE'});await refreshAll();renderPlayers();}});
    el.querySelector('#s10PlayerFile').onchange=async e=>{if(!e.target.files[0])return;const fd=new FormData();fd.append('file',e.target.files[0]);try{const r=await api('/api/host/players/preview',{method:'POST',body:fd});document.getElementById('s10PlayerPreview').innerHTML=`<div class="s10-preview"><b>Preview:</b> ${r.validCount} valid, ${r.invalidCount} invalid<br>${r.errors.slice(0,40).map(x=>`Row ${x.row}: ${esc(x.error)}`).join('<br>')}${r.errors.length>40?'<br>…':''}<br><br><button class="s10-btn s10-primary" id="s10ConfirmPlayers">Confirm valid players</button></div>`;document.getElementById('s10ConfirmPlayers').onclick=async()=>{const x=await api('/api/host/players/import',{method:'POST',body:JSON.stringify({players:r.valid})});alert(`Imported ${x.imported} players.`);await refreshAll();renderPlayers();};}catch(x){alert(x.message);}};
  }

  function renderAuction(){
    document.getElementById('s10-auction').innerHTML=`<h2 class="s10-title">Live Auction</h2><div class="s10-muted">The existing fast auction board remains the live control surface.</div><div class="s10-card" style="margin-top:16px"><p>Use the main auction screen to release players, control the timer, pause/resume, sell/unsold and manage bids.</p><button class="s10-btn s10-primary" id="s10CloseToAuction">Return to Live Auction</button></div>`;
    document.getElementById('s10CloseToAuction').onclick=close;
  }
  function renderResults(){
    document.getElementById('s10-results').innerHTML=`<h2 class="s10-title">Results</h2><div class="s10-muted">Use the existing Excel export on the live auction screen for the full auction sheet and team purse summary.</div>`;
  }
  function renderSettings(){
    const t=dashboard?.tournament||{};
    document.getElementById('s10-settings').innerHTML=`<h2 class="s10-title">Settings</h2><div class="s10-muted">Auction defaults for SSLT10.</div><form class="s10-form" id="s10SettingsForm"><label>Purse (Cr)<input name="purseCr" type="number" step="0.01" value="${t.purse_cr??120}"></label><label>Min Squad<input name="squadMin" type="number" value="${t.squad_min??16}"></label><label>Max Squad<input name="squadMax" type="number" value="${t.squad_max??20}"></label><label>Timer Seconds<input name="timerSeconds" type="number" value="${t.timer_seconds??15}"></label><div><button class="s10-btn s10-primary">Save Settings</button></div></form><div class="s10-card" style="margin-top:12px"><b>Security</b><p class="s10-muted">Host and team passwords are verified by the backend and are never returned by the public config endpoint.</p><button class="s10-btn s10-secondary" id="s10RefreshBoard">Save and refresh live board</button></div>`;
    document.getElementById('s10SettingsForm').onsubmit=async e=>{e.preventDefault();await api('/api/host/settings',{method:'PUT',body:JSON.stringify(Object.fromEntries(new FormData(e.target).entries()))});alert('Settings saved.');};
    document.getElementById('s10RefreshBoard').onclick=()=>location.reload();
  }

  // Open the console automatically when a brand-new SSLT10 auction has no
  // teams or players yet. The Host can close it and return to the live board.
  setTimeout(async()=>{
    try{const d=await api('/api/host/dashboard'); if(!d.teams || !d.players) open();}catch{}
  },700);
})();
