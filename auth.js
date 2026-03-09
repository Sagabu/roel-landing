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

    // Fallback: sjekk userSession (fra min-side.html)
    const userSession = localStorage.getItem('userSession');
    if (userSession) {
      try {
        const session = JSON.parse(userSession);
        if (session.phone) return true;
      } catch {}
    }

    // Fallback: sjekk judgeSession
    const judgeSession = localStorage.getItem('judgeSession');
    if (judgeSession) {
      try {
        const session = JSON.parse(judgeSession);
        if (session.phone) return true;
      } catch {}
    }

    return false;
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

    // Fjern lokale data
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
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
  const PROTECTED_PAGES = {
    'profil.html': null,           // Krever innlogging, alle roller
    'mine-hunder.html': null,
    'jaktprover.html': null,
    'fullmakter.html': null,
    'min-side.html': null,
    'dommer-hjem.html': 'dommer',  // Krever dommer-rolle
    'dommer-vk.html': 'dommer',
    'dommer-kritikk.html': 'dommer',
    'admin.html': 'admin',         // Krever admin-rolle
    'admin-panel.html': 'admin',
    'klubb.html': 'admin',
    'opprett-prove.html': 'admin',
    'opprett-klubb.html': 'admin',
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
    isLoggedIn,
    hasRole,
    login,
    logout,
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
