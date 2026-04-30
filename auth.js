/**
 * Auth helper for Fuglehundprøve
 *
 * Håndterer JWT tokens og autentisering mot backend.
 * Inkluder dette scriptet før andre scripts som trenger auth.
 *
 * Guard mot dobbel-lasting: hvis auth.js lastes to ganger (f.eks. HTML har
 * script-tag + serveWithShim auto-injecter), ville `const FuglehundAuth` og
 * lignende deklarasjoner kastet SyntaxError ved andre evaluering og stoppet
 * resten av siden sin JS. Hopp over hele initialiseringen hvis allerede lastet.
 */
if (typeof window.FuglehundAuth === 'undefined') {

const FuglehundAuth = (function() {
  const TOKEN_KEY = 'fuglehund_token';
  const USER_KEY = 'fuglehund_user';
  const LAST_ACTIVITY_KEY = 'fuglehund_last_activity';

  // Sesjon-timeouts
  const INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000;      // 60 min uten aktivitet → logg ut
  const ACTIVITY_CHECK_INTERVAL_MS = 60 * 1000;      // Sjekk hvert minutt
  const ACTIVITY_UPDATE_THROTTLE_MS = 30 * 1000;     // Oppdater last_activity maks hvert 30 sek

  let lastActivityUpdate = 0;

  // Hent lagret token
  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  // Oppdater "siste aktivitet"-tidspunkt
  function touchActivity() {
    const now = Date.now();
    // Throttle: ikke oppdater oftere enn hvert 30 sekund
    if (now - lastActivityUpdate < ACTIVITY_UPDATE_THROTTLE_MS) return;
    lastActivityUpdate = now;
    try {
      localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
    } catch {}
  }

  // Sjekk om sesjon har utløpt pga. inaktivitet
  function isSessionExpiredByInactivity() {
    const lastActivity = parseInt(localStorage.getItem(LAST_ACTIVITY_KEY) || '0', 10);
    if (!lastActivity) return false; // Ingen aktivitetssporing ennå - ikke utløpt
    return (Date.now() - lastActivity) > INACTIVITY_TIMEOUT_MS;
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

  // Sjekk om bruker er innlogget (gyldig JWT OG ikke utløpt pga. inaktivitet)
  function isLoggedIn() {
    // Sjekk JWT token - INGEN fallback til localStorage
    // LocalStorage kan manipuleres av brukeren, JWT kan ikke
    const token = getToken();
    if (!token) return false;

    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      const exp = payload.exp * 1000;
      if (Date.now() >= exp) {
        // JWT har utløpt - rydd opp
        clearSession();
        return false;
      }
    } catch {
      // Ugyldig token - fjern det
      clearSession();
      return false;
    }

    // Sjekk inaktivitets-timeout
    if (isSessionExpiredByInactivity()) {
      console.log('[Auth] Sesjon utløpt pga. inaktivitet');
      clearSession();
      return false;
    }

    return true;
  }

  // Rydd opp sesjons-data fra localStorage
  function clearSession() {
    const sessionKeys = ['userSession', 'judgeSession', 'userProfile', TOKEN_KEY, USER_KEY, LAST_ACTIVITY_KEY];
    sessionKeys.forEach(key => {
      try { localStorage.removeItem(key); } catch {}
    });
  }

  // Sjekk rolle - KUN basert på JWT-verifisert brukerinfo
  // INGEN fallback til localStorage da dette kan manipuleres
  function hasRole(rolle) {
    // Sjekk først at bruker er innlogget med gyldig JWT
    if (!isLoggedIn()) return false;

    // Hent brukerinfo fra JWT (lagret ved innlogging)
    const user = getUser();
    if (!user) return false;

    // Hvis rolle er null (bare krever innlogging), er vi allerede OK
    if (rolle === null) return true;

    const roller = (user.rolle || '').split(',').map(r => r.trim());

    // Sjekk spesifikke roller
    if (rolle === 'admin') {
      // Admin-rolle gis til:
      //  - global admin/superadmin/proveleder/klubbleder/sekretær via brukerens rolle-streng
      //  - klubb-admin via klubb_admins-tabellen (lagret som userSession.isTrialAdmin
      //    + clubId etter innlogging, eller cachedUserData.klubbAdmins). Klient-siden
      //    sjekken her er kun for sidetilgang/UI; server-side håndhever per-klubb-
      //    handlinger uavhengig.
      if (roller.includes('admin') || roller.includes('superadmin') ||
          roller.includes('proveleder') || roller.includes('klubbleder') ||
          roller.includes('sekretær') || roller.includes('sekretar')) {
        return true;
      }
      try {
        const session = JSON.parse(localStorage.getItem('userSession') || '{}');
        if (session.isTrialAdmin === true || session.clubId) return true;
      } catch {}
      return false;
    }
    if (rolle === 'dommer') {
      // Dommer-sider tillates også for alle admin-varianter, inkl. proveleder/
      // klubbleder/sekretær/superadmin. Dette er nødvendig fordi en bruker
      // med admin-rolle (uten dommer-rolle) kan være tildelt som "live_admin"
      // på et VK-parti og må kunne åpne dommer-vk.html for å styre rangeringen.
      return roller.includes('dommer')
          || roller.includes('admin')
          || roller.includes('proveleder')
          || roller.includes('klubbleder')
          || roller.includes('sekretær')
          || roller.includes('sekretar')
          || roller.includes('superadmin');
    }
    if (rolle === 'klubbleder') return roller.includes('klubbleder') || roller.includes('admin');
    if (rolle === 'nkkrep') return roller.includes('nkkrep') || roller.includes('admin');
    if (rolle === 'proveleder') return roller.includes('proveleder') || roller.includes('admin');

    // Ukjent rolle - avvis
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

    // Start aktivitetssporing ved innlogging
    localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
    lastActivityUpdate = Date.now();

    // Prøv å koble hunder fra deltakerliste til denne brukeren
    try {
      const kobleResp = await fetch('/api/koble-hunder', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${data.token}`
        }
      });
      if (kobleResp.ok) {
        const kobleResult = await kobleResp.json();
        if (kobleResult.linked > 0) {
          // Hunder koblet til brukerprofil
        }
      }
    } catch (err) {
      console.warn('Kunne ikke koble hunder:', err);
    }

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
    clearSession();
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

    // Vellykket API-kall teller som aktivitet (dommer som poller live-rangering, etc.)
    if (response.ok) {
      touchActivity();
    }

    // Hvis 401, er token utløpt - logg ut
    if (response.status === 401) {
      logout();
      // Redirect til login (min-side.html = passord-login)
      const path = window.location.pathname;
      if (path !== '/min-side.html' &&
          path !== '/dommer.html' &&
          path !== '/deltaker.html' &&
          path !== '/index.html' &&
          path !== '/') {
        const returnTo = encodeURIComponent(path + window.location.search);
        window.location.href = `/min-side.html?expired=1&returnTo=${returnTo}`;
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
    'admin.html': 'admin',         // Krever admin-rolle (inkl. klubb-admin)
    // admin-panel.html er beskyttet med PIN via admin-lock.js, ikke rolle
    'klubb.html': null,            // Krever bare innlogging — klubb.html viser
                                   // klubb-data offentlig; redigering er server-side
                                   // beskyttet. Tidligere krevde 'admin' globalt,
                                   // som låste ute brukere som var klubb-admin via
                                   // klubb_admins-tabellen (f.eks. styremedlem) men
                                   // ikke hadde rollen 'klubbleder' på sin profil.
    'opprett-prove.html': 'admin',
    // 'opprett-klubb.html' er IKKE beskyttet - skal være offentlig tilgjengelig for nye klubber
    'nkk-godkjenning.html': 'nkkrep'
  };

  // Automatisk auth-guard basert på side
  function checkPageAccess() {
    // Skip auth if SKIP_AUTH is set (for testing)
    if (window.SKIP_AUTH === true) return true;

    const page = window.location.pathname.split('/').pop() || 'index.html';
    const requiredRole = PROTECTED_PAGES[page];

    // Siden krever ikke beskyttelse
    if (requiredRole === undefined) return true;

    // Sjekk om innlogget - redirect til passord-login (min-side.html)
    if (!isLoggedIn()) {
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/min-side.html?returnTo=${returnTo}`;
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

  // Håndter sesjon-utløp: logg ut og redirect til passord-innloggingsside
  function handleSessionExpired(reason) {
    console.log('[Auth] Sesjon utløpt:', reason);
    clearSession();

    const page = window.location.pathname.split('/').pop() || 'index.html';
    const requiresAuth = PROTECTED_PAGES[page] !== undefined;

    if (requiresAuth) {
      const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
      // min-side.html er passord-login (ikke SMS-kode) - bedre UX ved timeout
      window.location.href = `/min-side.html?expired=1&returnTo=${returnTo}`;
    }
    // Hvis siden ikke krever auth (f.eks. index.html), gjør ingenting - bare rydd opp
  }

  // Sett opp aktivitetssporing når bruker er innlogget
  function setupActivityTracking() {
    // Events som regnes som "aktivitet"
    const activityEvents = ['click', 'keydown', 'scroll', 'mousemove', 'touchstart'];
    activityEvents.forEach(evt => {
      document.addEventListener(evt, touchActivity, { passive: true, capture: true });
    });

    // Wrap global fetch slik at alle vellykkede API-kall teller som aktivitet
    // Dette dekker polling (dommer-VK live rangering), auto-save, direkte fetch-kall osv.
    const _origFetch = window.fetch.bind(window);
    window.fetch = async function(...args) {
      const response = await _origFetch(...args);
      // Kun vellykkede kall (2xx) teller som aktivitet
      if (response.ok && getToken()) {
        touchActivity();
      }
      return response;
    };

    // Periodisk sjekk av sesjon-status (hvert minutt)
    setInterval(() => {
      if (!getToken()) return; // Ikke innlogget - ingen sjekk trengs
      if (!isLoggedIn()) {
        handleSessionExpired('inaktivitet eller utløpt JWT');
      }
    }, ACTIVITY_CHECK_INTERVAL_MS);

    // Sjekk også ved tabbytte/returning til vinduet
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && getToken()) {
        if (!isLoggedIn()) {
          handleSessionExpired('sesjon utløp mens tab var inaktiv');
        } else {
          touchActivity();
        }
      }
    });

    window.addEventListener('focus', () => {
      if (getToken() && !isLoggedIn()) {
        handleSessionExpired('sesjon utløp mens vindu var inaktivt');
      }
    });
  }

  // Auto-oppdater UI når DOM er klar
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      checkPageAccess();
      updateUI();
      setupActivityTracking();
      if (getToken()) touchActivity();
    });
  } else {
    checkPageAccess();
    updateUI();
    setupActivityTracking();
    if (getToken()) touchActivity();
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

// Superadmin knapp - vises for superadmin-rolle
(function() {
  function injectAdminButton() {
    try {
      // Sjekk om bruker har superadmin-rolle
      const userData = JSON.parse(localStorage.getItem('fuglehund_user') || '{}');
      const userProfile = JSON.parse(localStorage.getItem('userProfile') || '{}');
      const rolle = userProfile.rolle || userData.rolle || '';
      const isSuperadmin = rolle.includes('superadmin');

      if (!isSuperadmin) return;

      // Ikke vis knappen på sider som allerede har admin-navigasjon eller egen superadmin-knapp
      const currentPage = window.location.pathname.split('/').pop() || 'index.html';
      const excludedPages = ['admin-panel.html', 'admin.html', 'klubb.html', 'min-side.html', 'profil.html', 'mine-hunder.html', 'jaktprover.html', 'fullmakter.html'];
      if (excludedPages.includes(currentPage)) return;

      // Sjekk om knappen allerede finnes (enten injisert eller statisk adminHeaderBtn)
      if (document.getElementById('superadmin-btn') || document.getElementById('adminHeaderBtn')) return;

      // Finn header
      const header = document.querySelector('header');
      if (!header) return;

      // Lag superadmin-knappen
      const adminBtn = document.createElement('a');
      adminBtn.id = 'superadmin-btn';
      adminBtn.href = '/admin-panel.html';
      adminBtn.className = 'bg-warm-500 hover:bg-warm-600 px-4 py-2 rounded-xl text-sm font-medium transition text-white';
      adminBtn.textContent = 'Superadmin';

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

// Partilister-poller: lett mekanisme som oppdager at admin har gjort
// endringer (ikke-møtt, trekk, partifordeling, venteliste) og lar siden
// silent-refreshe sin egen DOM uten side-reload. Fronten sider kan abonnere
// via window.FuglehundPartilisterPoller.start(proveId, onChange).
//
// Pauser automatisk når tab-en er skjult (visibilitychange) for å unngå
// unødig nettverk når admin minimerer eller bytter fane.
if (typeof window.FuglehundPartilisterPoller === 'undefined') {
  window.FuglehundPartilisterPoller = (function() {
    const POLL_INTERVAL_MS = 15000;
    const aktive = new Map(); // proveId -> { lastEndret, baseline, intervalId, onChange, sjekk }

    async function sjekk(proveId, state) {
      try {
        const resp = await fetch('/api/prover/' + encodeURIComponent(proveId) + '/partilister/version', {
          cache: 'no-store'
        });
        if (!resp.ok) return;
        const data = await resp.json();
        // Første fetch: bare sett baseline (ikke fyr onChange).
        // Senere: fyr onChange ved enhver endring i endret_at — også
        // overgangen NULL → første timestamp (typisk for prøver som
        // aldri tidligere har hatt en bump).
        if (!state.baseline) {
          state.baseline = true;
        } else if (data.endret_at !== state.lastEndret) {
          try {
            await state.onChange(data.endret_at, state.lastEndret);
          } catch (e) {
            console.warn('[poller] onChange feilet:', e);
          }
        }
        state.lastEndret = data.endret_at;
      } catch (e) {
        // Stille — nettverksfeil retries ved neste tick
      }
    }

    function start(proveId, onChange) {
      if (!proveId || typeof onChange !== 'function') return () => {};
      stop(proveId); // Sikrer kun én aktiv poller per proveId
      const state = { lastEndret: null, baseline: false, intervalId: null, onChange, sjekk: null };
      state.sjekk = () => sjekk(proveId, state);
      // Initial fetch — setter baseline uten å trigge onChange
      state.sjekk();
      state.intervalId = setInterval(state.sjekk, POLL_INTERVAL_MS);
      aktive.set(proveId, state);
      return () => stop(proveId);
    }

    function stop(proveId) {
      const state = aktive.get(proveId);
      if (state?.intervalId) clearInterval(state.intervalId);
      aktive.delete(proveId);
    }

    function stopAll() {
      for (const [proveId] of aktive) stop(proveId);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        for (const state of aktive.values()) {
          if (state.intervalId) {
            clearInterval(state.intervalId);
            state.intervalId = null;
          }
        }
      } else {
        for (const state of aktive.values()) {
          if (!state.intervalId && state.sjekk) {
            state.sjekk(); // Umiddelbar sjekk når tab kommer tilbake
            state.intervalId = setInterval(state.sjekk, POLL_INTERVAL_MS);
          }
        }
      }
    });

    return { start, stop, stopAll };
  })();
}

} // end if (typeof window.FuglehundAuth === 'undefined')
