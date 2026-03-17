/**
 * localStorage → Server bridge shim
 *
 * Intercepts localStorage calls and syncs them to the server API.
 * Pages work exactly as before, but data persists in SQLite.
 *
 * Strategy: write-through cache. localStorage stays as fast local cache,
 * every write also goes to the server. On page load, server state is
 * pulled down to hydrate localStorage.
 */
(function() {
  const API = '/api/storage';
  const TOKEN_KEY = 'fuglehund_token';
  const SYNCED_KEYS = [
    'userProfile', 'userDogs', 'userTrials', 'userMandates',
    'judgeSession', 'clubLogo',
    'trialParticipants', 'trialParties', 'praktiskInfo', 'currentTrialId'
  ];
  // judgeData_* keys are dynamic (per party)
  function isSyncedKey(key) {
    return SYNCED_KEYS.includes(key) || key.startsWith('judgeData_');
  }

  // Hent auth headers for requests
  function getAuthHeaders() {
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  const _setItem = localStorage.setItem.bind(localStorage);
  const _getItem = localStorage.getItem.bind(localStorage);
  const _removeItem = localStorage.removeItem.bind(localStorage);

  // Override setItem: write local + fire-and-forget to server
  localStorage.setItem = function(key, value) {
    _setItem(key, value);
    if (isSyncedKey(key)) {
      try {
        const parsed = JSON.parse(value);
        fetch(`${API}/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify({ value: parsed })
        }).catch(() => {}); // fire and forget
      } catch {
        // Not JSON, store as string
        fetch(`${API}/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: JSON.stringify({ value: value })
        }).catch(() => {});
      }
    }
  };

  // Override removeItem
  localStorage.removeItem = function(key) {
    _removeItem(key);
    if (isSyncedKey(key)) {
      fetch(`${API}/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      }).catch(() => {});
    }
  };

  // Hydrate on load: pull server state into localStorage
  async function hydrate() {
    try {
      const resp = await fetch(API);
      if (!resp.ok) return;
      const { keys } = await resp.json();
      for (const { key } of keys) {
        if (isSyncedKey(key)) {
          const r = await fetch(`${API}/${encodeURIComponent(key)}`);
          if (r.ok) {
            const { value } = await r.json();
            if (value !== null) {
              _setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
            }
          }
        }
      }
    } catch {
      // Server down — localStorage still works offline
    }
  }

  // Hydrate when DOM is ready (non-blocking)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrate);
  } else {
    hydrate();
  }

  // Visual indicator that backend is active
  window.addEventListener('load', () => {
    const badge = document.createElement('div');
    badge.innerHTML = '● Tilkoblet';
    badge.style.cssText = 'position:fixed;bottom:8px;right:8px;background:#14532d;color:#86efac;padding:4px 10px;border-radius:12px;font-size:11px;font-family:system-ui;z-index:9999;opacity:0.8;pointer-events:none;';
    document.body.appendChild(badge);

    // Verify connection
    fetch('/api/stats').then(r => {
      if (!r.ok) throw new Error();
      badge.innerHTML = '● Tilkoblet — SQLite';
    }).catch(() => {
      badge.innerHTML = '○ Frakoblet — localStorage';
      badge.style.background = '#5a3a2a';
      badge.style.color = '#d4b896';
    });
  });
})();
