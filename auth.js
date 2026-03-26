/**
 * Auth helper for Fuglehundprøve
 *
 * Håndterer JWT tokens og autentisering mot backend.
 * Inkluder dette scriptet før andre scripts som trenger auth.
 */

const FuglehundAuth = (function() {
  const TOKEN_KEY = 'fuglehund_token';
  const USER_KEY = 'fuglehund_user';

  // Hent lagret token
  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  // Hent lagret brukerinfo
  function getUser() {
    const data = localStorage.getItem(USER_KEY);
    return data ? JSON.parse(data) : null;
  }

  // Hent telefonnummer fra alle mulige session-kilder
  function getSessionPhone() {
    const sources = ['userSession', 'judgeSession', 'userProfile', USER_KEY];

    for (const key of sources) {
      const data = localStorage.getItem(key);
      if (data) {
        try {
          const parsed = JSON.parse(data);
          const phone = parsed.phone || parsed.telefon;
          if (phone) {
            return phone.replace(/\D/g, '');
          }
        } catch {}
      }
    }
    return null;
  }

  // Sjekk om bruker er innlogget
  function isLoggedIn() {
    // Sjekk JWT token først
    const token = getToken();
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        const exp = payload.exp * 1000;
        if (Date.now() < exp) return true;
      } catch {
        // Ugyldig token
      }
    }

    // Fallback: sjekk alle session-typer
    return !!getSessionPhone();
  }

  // Sjekk rolle
  function hasRole(rolle) {
    // Sjekk JWT bruker først
    const user = getUser();
    if (user) {
      const roller = (user.rolle || '').split(',').map(r => r.trim());
      if (rolle === 'admin') {
        // Admin-rolle gis til admin, proveleder og klubbleder
        return roller.includes('admin') || roller.includes('proveleder') || roller.includes('klubbleder');
      }
      if (rolle === 'dommer') return roller.includes('dommer') || roller.includes('admin');
      if (rolle === 'klubbleder') return roller.includes('klubbleder') || roller.includes('admin');
      if (rolle === 'nkkrep') return roller.includes('nkkrep') || roller.includes('admin');
      if (rolle === 'proveleder') return roller.includes('proveleder') || roller.includes('admin');
      return true;
    }

    // Fallback: sjekk judgeSession for dommer-rolle
    if (rolle === 'dommer') {
      const judgeSession = localStorage.getItem('judgeSession');
      if (judgeSession) {
        try {
          const session = JSON.parse(judgeSession);
          if (session.isJudge || session.assignedParty) return true;
        } catch {}
      }
    }

    // Fallback: sjekk userSession for roller
    const userSession = localStorage.getItem('userSession');
    if (userSession) {
      // Hvis rolle er null (bare krever innlogging), godta det
      if (rolle === null) return true;

      try {
        const session = JSON.parse(userSession);

        // Sjekk om bruker har nkkrep-rolle fra API-data
        if (rolle === 'nkkrep') {
          if (session.trials?.some(t => t.roles?.some(r => r.type === 'nkkrep'))) {
            return true;
          }
        }

        // Sjekk om bruker har proveleder/klubbleder-rolle fra API-data (gir admin-tilgang)
        if (rolle === 'admin' || rolle === 'proveleder') {
          if (session.trials?.some(t => t.roles?.some(r =>
            r.type === 'proveleder' || r.type === 'klubbleder'
          ))) {
            return true;
          }
          if (session.isTrialAdmin) {
            return true;
          }
        }

        // Sjekk klubbleder separat
        if (rolle === 'klubbleder') {
          if (session.trials?.some(t => t.roles?.some(r => r.type === 'klubbleder'))) {
            return true;
          }
        }
      } catch {}
    }

    // Fallback: sjekk userProfile for roller (legacy)
    const userProfile = localStorage.getItem('userProfile');
    if (userProfile) {
      try {
        const profile = JSON.parse(userProfile);
        if (rolle === null && profile.phone) return true;

        // Sjekk rolle-felt direkte (fra eldre innlogginger)
        if (profile.role) {
          const roller = profile.role.split(',').map(r => r.trim());
          if (rolle === 'admin') {
            if (roller.includes('admin') || roller.includes('proveleder') || roller.includes('klubbleder')) {
              return true;
            }
          }
          if (rolle === 'proveleder' && roller.includes('proveleder')) return true;
          if (rolle === 'klubbleder' && roller.includes('klubbleder')) return true;
          if (rolle === 'nkkrep' && roller.includes('nkkrep')) return true;
        }
      } catch {}
    }

    return false;
  }

  // Synkroniser alle session-typer for konsistens
  async function syncSessions() {
    const phone = getSessionPhone();
    if (!phone) return null;

    try {
      // Hent brukerdata fra API
      const resp = await fetch(`/api/brukere/${phone}`);
      if (!resp.ok) return null;

      const userData = await resp.json();
      const name = `${userData.fornavn || ''} ${userData.etternavn || ''}`.trim() || 'Bruker';
      const loggedInAt = new Date().toISOString();

      // Hent dommer-info
      let isDommer = false;
      let dommerInfo = null;
      try {
        const dommerResp = await fetch(`/api/brukere/${phone}/dommer-info`);
        if (dommerResp.ok) {
          const data = await dommerResp.json();
          if (data.isDommer && data.tildelinger?.length > 0) {
            isDommer = true;
            dommerInfo = data.tildelinger[0];
          }
        }
      } catch {}

      // Oppdater userSession
      const userSession = {
        phone,
        name,
        loggedInAt,
        isTrialAdmin: !!userData.klubbAdmin,
        clubId: userData.klubbAdmin?.klubb_id || null,
        clubName: userData.klubbAdmin?.klubb_navn || null,
        clubRole: userData.klubbAdmin?.klubb_rolle || null
      };
      localStorage.setItem('userSession', JSON.stringify(userSession));

      // Oppdater userProfile for bakoverkompatibilitet
      localStorage.setItem('userProfile', JSON.stringify({
        phone,
        name,
        email: userData.epost || '',
        role: userData.rolle || '',
        loggedInAt
      }));

      // Oppdater judgeSession hvis bruker er dommer
      if (isDommer && dommerInfo) {
        localStorage.setItem('judgeSession', JSON.stringify({
          name,
          phone,
          isJudge: true,
          assignedParty: dommerInfo.parti,
          judgeRole: dommerInfo.dommerRolle,
          loggedInAt
        }));
      }

      // Oppdater fuglehund_user
      localStorage.setItem(USER_KEY, JSON.stringify({
        telefon: phone,
        fornavn: userData.fornavn,
        etternavn: userData.etternavn,
        navn: name,
        rolle: userData.rolle
      }));

      return { phone, name, userData, isDommer, dommerInfo };
    } catch (e) {
      console.error('syncSessions error:', e);
      return null;
    }
  }

  // Login - send telefon og kode, få tilbake token
  async function login(telefon, kode = '') {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefon, kode })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Innlogging feilet');
    }

    // Lagre token og brukerinfo
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.bruker));

    return data.bruker;
  }

  // Logg ut
  async function logout() {
    const token = getToken();

    // Prøv å logge ut på server (ikke kritisk om det feiler)
    if (token) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` }
        });
      } catch {
        // Ignorer feil
      }
    }

    // Fjern ALLE session-typer
    const sessionKeys = ['userSession', 'judgeSession', 'userProfile', TOKEN_KEY, USER_KEY];
    sessionKeys.forEach(key => localStorage.removeItem(key));
  }

  // Hent Authorization header for API-kall
  function getAuthHeader() {
    const token = getToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }

  // Authenticated fetch - legger til token automatisk
  async function authFetch(url, options = {}) {
    const token = getToken();
    const headers = {
      ...options.headers,
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };

    const response = await fetch(url, { ...options, headers });

    // Hvis 401, er token utløpt - logg ut
    if (response.status === 401) {
      logout();
      // Redirect til login
      if (window.location.pathname !== '/dommer.html' &&
          window.location.pathname !== '/deltaker.html' &&
          window.location.pathname !== '/index.html') {
        window.location.href = '/dommer.html?expired=1';
      }
    }

    return response;
  }

  // Refresh token hvis det er i ferd med å utløpe
  async function refreshTokenIfNeeded() {
    const token = getToken();
    if (!token) return;

    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const exp = payload.exp * 1000;
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;

      // Refresh hvis mindre enn 1 dag til utløp
      if (exp - now < oneDay) {
        const response = await authFetch('/api/auth/refresh', { method: 'POST' });
        if (response.ok) {
          const data = await response.json();
          localStorage.setItem(TOKEN_KEY, data.token);
        }
      }
    } catch {
      // Ignorer feil
    }
  }

  // Verifiser token mot server og oppdater brukerinfo
  async function verifyAndRefresh() {
    if (!isLoggedIn()) return null;

    try {
      const response = await authFetch('/api/auth/me');
      if (response.ok) {
        const user = await response.json();
        localStorage.setItem(USER_KEY, JSON.stringify(user));
        return user;
      }
    } catch {
      // Token er ugyldig
      logout();
    }

    return null;
  }

  // Redirect til login hvis ikke innlogget
  function requireLogin(redirectUrl = '/dommer.html') {
    if (!isLoggedIn()) {
      const returnTo = encodeURIComponent(window.location.pathname);
      window.location.href = `${redirectUrl}?returnTo=${returnTo}`;
      return false;
    }
    return true;
  }

  // Vis/skjul elementer basert på innlogging
  function updateUI() {
    const user = getUser();
    const loggedIn = isLoggedIn();

    // Elementer som vises når innlogget
    document.querySelectorAll('[data-auth="logged-in"]').forEach(el => {
      el.style.display = loggedIn ? '' : 'none';
    });

    // Elementer som vises når ikke innlogget
    document.querySelectorAll('[data-auth="logged-out"]').forEach(el => {
      el.style.display = loggedIn ? 'none' : '';
    });

    // Elementer som vises for spesifikke roller
    document.querySelectorAll('[data-auth-role]').forEach(el => {
      const requiredRole = el.getAttribute('data-auth-role');
      el.style.display = hasRole(requiredRole) ? '' : 'none';
    });

    // Sett brukernavn der det trengs
    if (user) {
      document.querySelectorAll('[data-auth-name]').forEach(el => {
        el.textContent = `${user.fornavn} ${user.etternavn}`;
      });
    }
  }

  // Sider som krever innlogging og hvilken rolle
  // MERK: min-side.html er IKKE beskyttet - den ER innloggingssiden
  const PROTECTED_PAGES = {
    'profil.html': null,           // Krever innlogging, alle roller
    'mine-hunder.html': null,
    'jaktprover.html': null,
    'fullmakter.html': null,
    // 'min-side.html': null,      // FJERNET - dette er innloggingssiden!
    'dommer-hjem.html': 'dommer',  // Krever dommer-rolle
    'dommer-vk.html': 'dommer',
    'dommer-kritikk.html': 'dommer',
    'admin.html': 'admin',         // Krever admin-rolle
    // admin-panel.html er beskyttet med PIN via admin-lock.js, ikke rolle
    'klubb.html': 'admin',
    'opprett-prove.html': 'admin',
    // 'opprett-klubb.html' er IKKE beskyttet - skal være offentlig tilgjengelig for nye klubber
    'nkk-godkjenning.html': 'nkkrep'
  };

  // Automatisk auth-guard basert på side
  function checkPageAccess() {
    const page = window.location.pathname.split('/').pop() || 'index.html';
    const requiredRole = PROTECTED_PAGES[page];

    // Siden krever ikke beskyttelse
    if (requiredRole === undefined) return true;

    // Sjekk om innlogget
    if (!isLoggedIn()) {
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/deltaker.html?returnTo=${returnTo}`;
      return false;
    }

    // Sjekk rolle hvis spesifisert
    if (requiredRole && !hasRole(requiredRole)) {
      alert('Du har ikke tilgang til denne siden.');
      window.location.href = '/index.html';
      return false;
    }

    return true;
  }

  // Auto-oppdater UI når DOM er klar
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      checkPageAccess();
      updateUI();
    });
  } else {
    checkPageAccess();
    updateUI();
  }

  // Refresh token i bakgrunnen
  refreshTokenIfNeeded();

  // Eksporter public API
  return {
    getToken,
    getUser,
    getSessionPhone,
    isLoggedIn,
    hasRole,
    login,
    logout,
    syncSessions,
    getAuthHeader,
    authFetch,
    verifyAndRefresh,
    requireLogin,
    checkPageAccess,
    updateUI
  };
})();

// Gjør tilgjengelig globalt
window.FuglehundAuth = FuglehundAuth;

/**
 * Global Toast/Notification System
 * Brukervennlige meldinger for feil, suksess og advarsler
 */
const FuglehundToast = (function() {
  let container = null;

  function ensureContainer() {
    if (!container) {
      container = document.createElement('div');
      container.id = 'fuglehund-toast-container';
      container.className = 'fixed top-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm';
      document.body.appendChild(container);
    }
    return container;
  }

  function show(message, type = 'info', duration = 5000) {
    const cont = ensureContainer();

    const colors = {
      success: 'bg-green-50 border-green-200 text-green-800',
      error: 'bg-red-50 border-red-200 text-red-800',
      warning: 'bg-amber-50 border-amber-200 text-amber-800',
      info: 'bg-sky-50 border-sky-200 text-sky-800'
    };

    const icons = {
      success: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>',
      error: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
      warning: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>',
      info: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>'
    };

    const toast = document.createElement('div');
    toast.className = `${colors[type] || colors.info} border rounded-xl p-4 shadow-lg flex items-start gap-3 animate-slide-in`;
    toast.innerHTML = `
      <svg class="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        ${icons[type] || icons.info}
      </svg>
      <div class="flex-1">
        <p class="text-sm font-medium">${message}</p>
      </div>
      <button onclick="this.parentElement.remove()" class="text-current opacity-50 hover:opacity-100">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    `;

    // Add animation styles if not exists
    if (!document.getElementById('toast-styles')) {
      const style = document.createElement('style');
      style.id = 'toast-styles';
      style.textContent = `
        @keyframes slideIn { from { transform: translateX(100%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes slideOut { from { transform: translateX(0); opacity: 1; } to { transform: translateX(100%); opacity: 0; } }
        .animate-slide-in { animation: slideIn 0.3s ease-out; }
        .animate-slide-out { animation: slideOut 0.3s ease-in forwards; }
      `;
      document.head.appendChild(style);
    }

    cont.appendChild(toast);

    // Auto-remove etter duration
    if (duration > 0) {
      setTimeout(() => {
        toast.classList.add('animate-slide-out');
        setTimeout(() => toast.remove(), 300);
      }, duration);
    }

    return toast;
  }

  return {
    show,
    success: (msg, dur) => show(msg, 'success', dur),
    error: (msg, dur) => show(msg, 'error', dur || 8000),
    warning: (msg, dur) => show(msg, 'warning', dur),
    info: (msg, dur) => show(msg, 'info', dur)
  };
})();

window.FuglehundToast = FuglehundToast;

// Global error handler for unhandled errors
window.addEventListener('error', function(event) {
  console.error('Uventet feil:', event.error);
  // Bare vis toast for kritiske feil, ikke for manglende ressurser etc.
  if (event.error && event.error.message && !event.filename?.includes('cdn.')) {
    // Logg til konsoll, men ikke vis toast for hver feil
    // FuglehundToast.error('En uventet feil oppstod. Prøv å laste siden på nytt.');
  }
});

// Global handler for unhandled promise rejections
window.addEventListener('unhandledrejection', function(event) {
  console.error('Ubehandlet Promise-feil:', event.reason);
  // Ikke vis toast for alle promise-feil, bare logg
});

// Helper for API-feil
window.handleApiError = function(error, customMessage) {
  console.error('API-feil:', error);
  const message = customMessage || error.message || 'Kunne ikke fullføre forespørselen. Prøv igjen.';
  FuglehundToast.error(message);
};

// Superadmin knapp - vises kun for telefon 90852833
(function() {
  const SUPERADMIN_PHONE = '90852833';

  function injectAdminButton() {
    try {
      const userData = JSON.parse(localStorage.getItem('fuglehund_user') || '{}');
      if (userData.telefon !== SUPERADMIN_PHONE) return;

      // Ikke vis knappen på sider som allerede har admin-navigasjon
      const currentPage = window.location.pathname.split('/').pop() || 'index.html';
      const excludedPages = ['admin-panel.html', 'admin.html', 'klubb.html', 'min-side.html'];
      if (excludedPages.includes(currentPage)) return;

      // Sjekk om knappen allerede finnes
      if (document.getElementById('superadmin-btn')) return;

      // Finn header
      const header = document.querySelector('header');
      if (!header) return;

      // Lag admin-knappen
      const adminBtn = document.createElement('a');
      adminBtn.id = 'superadmin-btn';
      adminBtn.href = '/admin-panel.html';
      adminBtn.className = 'bg-amber-600 hover:bg-amber-700 px-4 py-2 rounded-xl text-sm font-medium transition text-white';
      adminBtn.textContent = 'Admin';

      // Prøv å finne logg ut-knappen først
      const logoutBtn = header.querySelector('button[onclick*="logout"]');
      if (logoutBtn && logoutBtn.parentElement) {
        logoutBtn.parentElement.insertBefore(adminBtn, logoutBtn);
        return;
      }

      // Fallback: legg til i første div med flex i header
      const flexContainer = header.querySelector('.flex.items-center.gap-3') ||
                            header.querySelector('.flex.items-center') ||
                            header.querySelector('div > div:last-child');
      if (flexContainer) {
        flexContainer.appendChild(adminBtn);
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectAdminButton);
  } else {
    injectAdminButton();
  }
})();
