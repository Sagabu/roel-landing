/**
 * Admin-lock: PIN-beskyttelse for admin-sider
 * Laster før siden vises og krever PIN hvis ADMIN_PIN er satt i .env
 */
(function() {
  const STORAGE_KEY = 'fuglehund_admin_unlocked';
  const SESSION_DURATION = 4 * 60 * 60 * 1000; // 4 timer

  // Sjekk om allerede ulast
  function isUnlocked() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return false;

    try {
      const data = JSON.parse(stored);
      if (data.expiry && Date.now() < data.expiry) {
        return true;
      }
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      localStorage.removeItem(STORAGE_KEY);
    }
    return false;
  }

  // Lagre ulast-status
  function setUnlocked() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      expiry: Date.now() + SESSION_DURATION
    }));
  }

  // Vis PIN-skjerm
  function showLockScreen() {
    document.body.innerHTML = '';
    document.body.style.cssText = 'margin:0;padding:0;font-family:Inter,system-ui,sans-serif;background:#FAF8F5;min-height:100vh;display:flex;align-items:center;justify-content:center;';

    const container = document.createElement('div');
    container.style.cssText = 'background:white;padding:2.5rem;border-radius:1rem;box-shadow:0 4px 20px rgba(0,0,0,0.1);max-width:360px;width:90%;text-align:center;';

    container.innerHTML = `
      <div style="width:64px;height:64px;background:#fef3c7;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 1.5rem;">
        <svg style="width:32px;height:32px;color:#d97706;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
        </svg>
      </div>
      <h1 style="font-size:1.5rem;font-weight:bold;color:#2a2321;margin:0 0 0.5rem;">Admin-tilgang</h1>
      <p style="color:#756259;font-size:0.9rem;margin:0 0 1.5rem;">Skriv inn admin-PIN for a fortsette</p>
      <form id="adminPinForm">
        <input type="password" id="adminPinInput" placeholder="PIN-kode"
          style="width:100%;padding:0.875rem 1rem;border:2px solid #ddd6d0;border-radius:0.75rem;font-size:1.25rem;text-align:center;letter-spacing:0.25em;box-sizing:border-box;outline:none;"
          maxlength="8" inputmode="numeric" autocomplete="off">
        <p id="adminPinError" style="color:#dc2626;font-size:0.875rem;margin:0.75rem 0 0;display:none;">Feil PIN-kode</p>
        <button type="submit" style="width:100%;margin-top:1rem;padding:0.875rem;background:#0ea5e9;color:white;border:none;border-radius:0.75rem;font-size:1rem;font-weight:600;cursor:pointer;">
          Las opp
        </button>
      </form>
      <p style="color:#9a8677;font-size:0.75rem;margin-top:1.5rem;">
        <a href="/" style="color:#0ea5e9;text-decoration:none;">Tilbake til forsiden</a>
      </p>
    `;

    document.body.appendChild(container);

    const form = document.getElementById('adminPinForm');
    const input = document.getElementById('adminPinInput');
    const error = document.getElementById('adminPinError');

    input.focus();

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pin = input.value.trim();

      if (!pin) {
        error.textContent = 'Skriv inn PIN';
        error.style.display = 'block';
        return;
      }

      try {
        const resp = await fetch('/api/admin-lock/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin })
        });

        if (resp.ok) {
          setUnlocked();
          window.location.reload();
        } else {
          error.textContent = 'Feil PIN-kode';
          error.style.display = 'block';
          input.value = '';
          input.focus();
        }
      } catch (err) {
        error.textContent = 'Noe gikk galt';
        error.style.display = 'block';
      }
    });
  }

  // Sjekk om bruker har admin-tilgang via innlogging
  function hasAdminAccess() {
    // Sjekk userSession for proveleder/klubbleder/admin rolle
    const userSession = localStorage.getItem('userSession');
    if (userSession) {
      try {
        const session = JSON.parse(userSession);
        // Sjekk om bruker har proveleder-rolle på en prøve
        if (session.trials?.some(t => t.roles?.some(r =>
          r.type === 'proveleder' || r.type === 'klubbleder' || r.type === 'admin'
        ))) {
          return true;
        }
        // Sjekk isTrialAdmin flagg
        if (session.isTrialAdmin) {
          return true;
        }
      } catch {}
    }

    // Sjekk JWT token bruker
    const jwtUser = localStorage.getItem('fuglehund_user');
    if (jwtUser) {
      try {
        const user = JSON.parse(jwtUser);
        const roller = (user.rolle || '').split(',').map(r => r.trim());
        if (roller.includes('admin') || roller.includes('proveleder') || roller.includes('klubbleder')) {
          return true;
        }
      } catch {}
    }

    return false;
  }

  // Hovedlogikk
  async function init() {
    // Sjekk om admin-lock er aktivert
    try {
      const resp = await fetch('/api/admin-lock/status');
      const data = await resp.json();

      if (!data.enabled) {
        // Admin-lock ikke aktivert, fortsett normalt
        return;
      }

      // Sjekk om allerede ulåst via PIN
      if (isUnlocked()) {
        return;
      }

      // Sjekk om bruker har admin-tilgang via innlogging (proveleder, klubbleder, admin)
      if (hasAdminAccess()) {
        return;
      }

      // Vis PIN-skjerm
      showLockScreen();

    } catch (err) {
      console.error('Admin-lock feil:', err);
      // Ved feil, la siden laste (fallback)
    }
  }

  // Kjor umiddelbart
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
