/**
 * localStorage → Server bridge shim med offline-støtte
 *
 * Intercepts localStorage calls and syncs them to the server API.
 * Pages work exactly as before, but data persists in SQLite.
 *
 * Strategy: write-through cache with offline queue.
 * - localStorage stays as fast local cache
 * - Every write goes to server (or queue if offline)
 * - Queue is processed when online again
 * - On page load, server state is pulled down to hydrate localStorage
 */
(function() {
  const API = '/api/storage';
  const TOKEN_KEY = 'fuglehund_token';
  const QUEUE_KEY = '_fuglehund_sync_queue';
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

  // ========================================
  // OFFLINE QUEUE
  // ========================================

  // Hent køen fra localStorage
  function getQueue() {
    try {
      return JSON.parse(_getItem(QUEUE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  // Lagre køen til localStorage
  function saveQueue(queue) {
    _setItem(QUEUE_KEY, JSON.stringify(queue));
    updateSyncBadge();
  }

  // Legg til i køen
  function enqueue(item) {
    const queue = getQueue();
    // Fjern eventuelle tidligere entries for samme key (vi vil kun ha siste verdi)
    const filtered = queue.filter(q => q.key !== item.key);
    filtered.push({ ...item, timestamp: Date.now() });
    saveQueue(filtered);
  }

  // Sjekk om vi er online
  function isOnline() {
    return navigator.onLine;
  }

  // Prosesser køen - send alt til server
  async function processQueue() {
    if (!isOnline()) return;

    const queue = getQueue();
    if (queue.length === 0) return;

    console.log(`[Sync] Processing ${queue.length} queued items...`);
    const failed = [];

    for (const item of queue) {
      try {
        const response = await fetch(`${API}/${encodeURIComponent(item.key)}`, {
          method: item.method,
          headers: getAuthHeaders(),
          body: item.body
        });

        if (response.ok) {
          console.log(`[Sync] ✓ ${item.key}`);
        } else {
          console.warn(`[Sync] ✗ ${item.key} (${response.status})`);
          failed.push(item);
        }
      } catch (err) {
        console.warn(`[Sync] ✗ ${item.key} (network error)`);
        failed.push(item);
      }
    }

    saveQueue(failed);

    if (failed.length === 0) {
      console.log('[Sync] All items synced successfully!');
    } else {
      console.log(`[Sync] ${failed.length} items still pending`);
    }
  }

  // ========================================
  // SYNC BADGE UI
  // ========================================

  let syncBadge = null;

  function createSyncBadge() {
    if (syncBadge) return syncBadge;

    syncBadge = document.createElement('div');
    syncBadge.id = 'fuglehund-sync-badge';
    syncBadge.style.cssText = `
      position: fixed;
      bottom: 8px;
      right: 8px;
      padding: 6px 12px;
      border-radius: 12px;
      font-size: 11px;
      font-family: system-ui, sans-serif;
      z-index: 9999;
      pointer-events: none;
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      gap: 6px;
    `;
    document.body.appendChild(syncBadge);
    return syncBadge;
  }

  function updateSyncBadge() {
    if (!syncBadge) return;

    const queue = getQueue();
    const online = isOnline();

    if (!online) {
      // Offline
      syncBadge.innerHTML = `
        <span style="display:inline-block;width:8px;height:8px;background:#f59e0b;border-radius:50%;"></span>
        Offline${queue.length > 0 ? ` (${queue.length} venter)` : ''}
      `;
      syncBadge.style.background = '#451a03';
      syncBadge.style.color = '#fcd34d';
    } else if (queue.length > 0) {
      // Online men har kø
      syncBadge.innerHTML = `
        <span style="display:inline-block;width:8px;height:8px;background:#3b82f6;border-radius:50%;animation:pulse 1s infinite;"></span>
        Synkroniserer (${queue.length})...
      `;
      syncBadge.style.background = '#1e3a5f';
      syncBadge.style.color = '#93c5fd';
    } else {
      // Online og alt synkronisert
      syncBadge.innerHTML = `
        <span style="display:inline-block;width:8px;height:8px;background:#22c55e;border-radius:50%;"></span>
        Synkronisert
      `;
      syncBadge.style.background = '#14532d';
      syncBadge.style.color = '#86efac';
    }
  }

  // ========================================
  // OVERRIDE localStorage METHODS
  // ========================================

  // Override setItem: write local + queue for server
  localStorage.setItem = function(key, value) {
    _setItem(key, value);

    if (isSyncedKey(key)) {
      let body;
      try {
        const parsed = JSON.parse(value);
        body = JSON.stringify({ value: parsed });
      } catch {
        body = JSON.stringify({ value: value });
      }

      if (isOnline()) {
        // Online: prøv å sende direkte
        fetch(`${API}/${encodeURIComponent(key)}`, {
          method: 'PUT',
          headers: getAuthHeaders(),
          body: body
        }).then(response => {
          if (!response.ok) {
            // Server-feil, legg i kø for retry
            enqueue({ key, method: 'PUT', body });
          }
          updateSyncBadge();
        }).catch(() => {
          // Nettverksfeil, legg i kø
          enqueue({ key, method: 'PUT', body });
        });
      } else {
        // Offline: legg direkte i kø
        enqueue({ key, method: 'PUT', body });
      }
    }
  };

  // Override removeItem
  localStorage.removeItem = function(key) {
    _removeItem(key);

    if (isSyncedKey(key)) {
      if (isOnline()) {
        fetch(`${API}/${encodeURIComponent(key)}`, {
          method: 'DELETE',
          headers: getAuthHeaders()
        }).catch(() => {
          enqueue({ key, method: 'DELETE', body: null });
        });
      } else {
        enqueue({ key, method: 'DELETE', body: null });
      }
    }
  };

  // ========================================
  // HYDRATE FROM SERVER
  // ========================================

  async function hydrate() {
    if (!isOnline()) {
      console.log('[Sync] Offline - using local data');
      return;
    }

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
      console.log('[Sync] Hydrated from server');
    } catch {
      console.log('[Sync] Server unavailable - using local data');
    }
  }

  // ========================================
  // INITIALIZE
  // ========================================

  // Lytt på online/offline events
  window.addEventListener('online', () => {
    console.log('[Sync] Back online!');
    updateSyncBadge();
    // Vent litt før sync for å la nettverket stabilisere seg
    setTimeout(processQueue, 1000);
  });

  window.addEventListener('offline', () => {
    console.log('[Sync] Gone offline');
    updateSyncBadge();
  });

  // Hydrate og sett opp badge når DOM er klar
  function init() {
    createSyncBadge();
    updateSyncBadge();
    hydrate().then(() => {
      // Prosesser eventuell eksisterende kø etter hydrating
      processQueue();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Prosesser kø periodisk (hvert 30. sekund) i tilfelle mislykket sync
  setInterval(() => {
    if (isOnline() && getQueue().length > 0) {
      processQueue();
    }
  }, 30000);

  // Legg til CSS for pulserende animasjon
  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  `;
  document.head.appendChild(style);

  // Eksporter funksjoner for debugging
  window._fuglehundSync = {
    getQueue,
    processQueue,
    isOnline,
    updateSyncBadge
  };
})();
