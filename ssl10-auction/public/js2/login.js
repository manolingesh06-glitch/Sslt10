// SSL T10 — Season 1 · Login
// Talks to the real backend (GET /api/config/current) — no hardcoded
// team counts or numbers. If the auction isn't active/configured yet,
// we say so instead of showing a broken form.

const SESSION_KEY = 'ssl10-s1-session';

const panel      = document.getElementById('panel');
const tabs       = document.querySelectorAll('.login__tab');
const teamField  = document.getElementById('teamField');
const teamSelect = document.getElementById('team');
const form       = document.getElementById('loginForm');
const errorBox   = document.getElementById('loginError');
const footnote   = document.getElementById('footnote');
const submitBtn  = document.getElementById('submitBtn');
const submitLabel= document.getElementById('submitLabel');

let role = 'owner';
let config = null; // { active, teams, passwords: { host, teams } }

// ---------- Entrance animation ----------
// One timeline, GPU-friendly properties only (opacity/transform), so this
// stays smooth even on low-end phones. Elements are revealed in a light
// stagger rather than all at once — reads as considered, not slow.
gsap.set(panel, { y: 14 });
gsap.timeline({ defaults: { ease: 'power3.out' } })
  .to(panel, { opacity: 1, y: 0, duration: 0.55 })
  .from('.login__eyebrow, .login__title, .login__rule', {
    opacity: 0, y: 8, duration: 0.4, stagger: 0.05
  }, 0.05)
  .from('.login__tabs, .field, .login__submit', {
    opacity: 0, y: 10, duration: 0.4, stagger: 0.06
  }, 0.15);

// ---------- Role tabs ----------
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.role === role) return;
    role = tab.dataset.role;
    tabs.forEach(t => t.classList.toggle('is-active', t === tab));
    clearError();

    if (role === 'host') {
      gsap.to(teamField, {
        height: 0, opacity: 0, marginBottom: -16, duration: 0.28, ease: 'power2.inOut',
        onComplete: () => { teamField.style.display = 'none'; teamSelect.required = false; }
      });
    } else {
      teamField.style.display = '';
      teamField.style.height = 'auto';
      gsap.fromTo(teamField,
        { height: 0, opacity: 0, marginBottom: -16 },
        { height: 'auto', opacity: 1, marginBottom: 0, duration: 0.3, ease: 'power2.inOut',
          onComplete: () => { teamSelect.required = true; } }
      );
    }
  });
});

// ---------- Load real config ----------
async function loadConfig() {
  try {
    const res = await fetch('/api/config/current');
    config = await res.json();
  } catch (e) {
    showFootnote('Could not reach the server. Refresh to try again.', true);
    return;
  }

  if (!config.active) {
    showFootnote('The host hasn\u2019t activated this auction yet.', true);
    submitBtn.disabled = true;
    return;
  }

  const teams = config.teams || [];
  if (teams.length < 2) {
    showFootnote('Waiting for teams to be configured.', true);
    submitBtn.disabled = true;
    return;
  }

  teamSelect.innerHTML = teams.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  footnote.style.display = 'none';
  submitBtn.disabled = false;
}

function showFootnote(text, isWarning) {
  footnote.textContent = text;
  footnote.style.display = '';
  footnote.style.color = isWarning ? 'var(--unsold, #7A3B34)' : '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Submit ----------
form.addEventListener('submit', (e) => {
  e.preventDefault();
  clearError();
  if (!config || !config.active) return;

  const password = document.getElementById('password').value.trim();
  if (!password) return;

  setSubmitting(true);

  // Tiny deliberate delay so the button's loading state is perceptible —
  // the actual check is instant, but a 0ms "loading" state reads as a
  // glitch rather than a response.
  setTimeout(() => {
    let session = null;

    if (role === 'host') {
      if (password === config.passwords.host) session = { role: 'host', team: null };
    } else {
      const team = teamSelect.value;
      if (config.passwords.teams[team] && password === config.passwords.teams[team]) {
        session = { role: 'owner', team };
      }
    }

    if (!session) {
      setSubmitting(false);
      shakeError('Incorrect passcode — check with your host.');
      return;
    }

    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));

    gsap.to(panel, {
      opacity: 0, y: -10, duration: 0.3, ease: 'power2.in',
      onComplete: () => { window.location.href = '/auction.html'; }
    });
  }, 250);
});

function setSubmitting(isSubmitting) {
  submitBtn.disabled = isSubmitting;
  submitLabel.textContent = isSubmitting ? 'Checking\u2026' : 'Enter the auction';
}

function clearError() {
  errorBox.classList.remove('is-visible');
}

function shakeError(message) {
  errorBox.textContent = message;
  errorBox.classList.add('is-visible');
  gsap.fromTo(errorBox,
    { x: 0 },
    { x: 8, duration: 0.06, repeat: 5, yoyo: true, ease: 'power1.inOut',
      onComplete: () => gsap.set(errorBox, { x: 0 }) }
  );
}

loadConfig();
