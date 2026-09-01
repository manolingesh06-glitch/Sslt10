(() => {
  const SESSION_KEY = 'sslt10-session';
  const TOKEN_KEY = 'sslt10-token';

  function readSession(){
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || sessionStorage.getItem('sslt10-session') || 'null'); }
    catch { return null; }
  }
  function saveSession(s){
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    sessionStorage.setItem(TOKEN_KEY, s.token);
    // The legacy auction UI reads this key. The server-issued token is the
    // source of truth; this compatibility object only carries role/team.
    sessionStorage.setItem('sslt10-session', JSON.stringify(s));
  }
  function clearSession(){
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem('sslt10-session');
    sessionStorage.removeItem('spl-s3-session');
  }
  async function api(url, options={}){
    const headers = new Headers(options.headers || {});
    const token = sessionStorage.getItem(TOKEN_KEY);
    if(token) headers.set('Authorization', `Bearer ${token}`);
    if(options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type','application/json');
    const res = await fetch(url, {...options, headers});
    let data = null;
    try { data = await res.json(); } catch {}
    if(!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }
  window.sslt10Api = api;
  window.sslt10Session = readSession;

  function hideLegacyAdmin(){
    ['adminScreen','adminPanelToggle','adminResetPwdBtn','adminPwdModalOverlay'].forEach(id => {
      const el = document.getElementById(id);
      if(el) el.remove();
    });
    document.querySelectorAll('.admin-toggle-link,.admin-wrap').forEach(el => el.remove());
  }

  async function login(){
    const user = document.getElementById('loginUser')?.value || '';
    const pass = document.getElementById('loginPass')?.value || '';
    const error = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');
    if(!user || !pass){ if(error) error.textContent='Username and password are required.'; return; }
    if(btn){ btn.disabled=true; btn.textContent='Authenticating…'; }
    try{
      const result = await api('/api/auth/login', {method:'POST', body:JSON.stringify({username:user,password:pass})});
      const session = { role: result.role, team: result.team || null, username: result.username, userId: result.userId, token: result.token, sid: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}` };
      saveSession(session);
      location.reload();
    }catch(e){
      if(error) error.textContent=e.message;
      if(btn){ btn.disabled=false; btn.textContent='Enter the Auction'; }
    }
  }

  async function changePassword(){
    const modal = document.getElementById('pwdModalOverlay');
    if(!modal) return;
    modal.style.display='flex';
    const save = document.getElementById('pwdSaveBtn');
    const oldHandler = save.onclick;
    save.onclick = async () => {
      const error = document.getElementById('pwdError');
      const currentPassword = document.getElementById('pwdCurrent')?.value || '';
      const newPassword = document.getElementById('pwdNew')?.value || '';
      const confirm = document.getElementById('pwdConfirm')?.value || '';
      if(newPassword !== confirm){ error.textContent='New passwords do not match.'; return; }
      try{
        await api('/api/auth/change-password',{method:'POST',body:JSON.stringify({currentPassword,newPassword})});
        modal.style.display='none';
        alert('Password changed successfully.');
      }catch(e){ error.textContent=e.message; }
    };
  }

  function wire(){
    hideLegacyAdmin();
    const loginBtn=document.getElementById('loginBtn');
    if(loginBtn) loginBtn.onclick=login;
    const change=document.getElementById('changePwdBtn');
    if(change) change.onclick=changePassword;
    const logout=document.getElementById('logoutBtn');
    if(logout){
      logout.onclick=()=>{ clearSession(); location.reload(); };
    }
    const title=document.querySelector('title');
    if(title) title.textContent='SSLT10 — Live Auction Board';
  }

  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire, {once:true});
  else wire();
})();
