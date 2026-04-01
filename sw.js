/**
 * Service Worker for Fuglehundprøve
 *
 * Gir offline-støtte for dommere til fjells:
 * 1. Cacher alle nødvendige filer ved første besøk
 * 2. Serverer cached versjon når offline
 * 3. Oppdaterer cache i bakgrunnen når online
 */

const CACHE_NAME = 'fuglehund-v6';

// IndexedDB for offline request queue
const DB_NAME = 'fuglehund-offline';
const STORE_NAME = 'pending-requests';

// Filer som må caches for offline-bruk
const CORE_FILES = [
  '/',
  '/index.html',
  '/admin.html',
  '/opprett-prove.html',
  '/dommer.html',
  '/dommer-hjem.html',
  '/dommer-vk.html',
  '/dommer-kritikk.html',
  '/dommer-undersokelse.html',
  '/dommertest.html',
  '/undersokelse.html',
  '/min-side.html',
  '/mine-hunder.html',
  '/pamelding.html',
  '/partilister.html',
  '/storage-shim.js',
  '/auth.js',
  '/dog-search.js',
  '/klasse-validator.js',
  '/navbar.js',
  '/shared-config.js'
];

// CDN-ressurser som også bør caches
const CDN_FILES = [
  'https://cdn.tailwindcss.com'
];

// Install: Cache alle kjernefiler
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching core files');
      // Cache lokale filer
      const localPromise = cache.addAll(CORE_FILES).catch(err => {
        console.warn('[SW] Some core files failed to cache:', err);
      });
      // Cache CDN-filer separat (kan feile uten å blokkere)
      const cdnPromise = Promise.all(
        CDN_FILES.map(url =>
          cache.add(url).catch(err => console.warn('[SW] CDN cache failed:', url, err))
        )
      );
      return Promise.all([localPromise, cdnPromise]);
    }).then(() => {
      console.log('[SW] Installation complete');
      return self.skipWaiting(); // Aktiver umiddelbart
    })
  );
});

// Activate: Rydd opp gamle caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[SW] Activation complete');
      return self.clients.claim(); // Ta kontroll over alle tabs
    })
  );
});

// Fetch: Serve fra cache, fall back til nettverk
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Håndter POST/PUT til kritikk-APIet spesielt for offline-støtte
  if (url.pathname.startsWith('/api/kritikker') && (event.request.method === 'POST' || event.request.method === 'PUT')) {
    event.respondWith(
      fetch(event.request.clone())
        .catch(async () => {
          // Offline - lagre i IndexedDB for senere syncing
          const body = await event.request.clone().text();
          await queueOfflineRequest(url.pathname, event.request.method, body);
          return new Response(JSON.stringify({
            success: true,
            queued: true,
            offline: true,
            message: 'Kritikk lagret lokalt - synkroniseres automatisk når tilkoblingen er tilbake'
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        })
    );
    return;
  }

  // Ikke cache andre API-kall - de håndteres av offline-køen i storage-shim.js
  if (url.pathname.startsWith('/api/')) {
    return; // La nettleseren håndtere API-kall normalt
  }

  // For HTML, JS, CSS: Cache-first med network fallback
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Har cached versjon - bruk den, men oppdater i bakgrunnen
        event.waitUntil(
          fetch(event.request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(event.request, networkResponse.clone());
              });
            }
          }).catch(() => {
            // Ingen nett, det er greit - vi har cache
          })
        );
        return cachedResponse;
      }

      // Ingen cache - prøv nettverk
      return fetch(event.request).then((networkResponse) => {
        // Cache responsen for fremtidig offline-bruk
        if (networkResponse && networkResponse.status === 200) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Offline og ingen cache - vis offline-side for HTML-forespørsler
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('/offline.html').then(offlinePage => {
            if (offlinePage) return offlinePage;
            // Fallback hvis offline.html ikke er cachet
            return new Response(`
              <!DOCTYPE html>
              <html lang="no">
              <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Offline - Fuglehundprøve</title>
                <style>
                  body { font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f4; }
                  .box { text-align: center; padding: 2rem; background: white; border-radius: 1rem; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 400px; }
                  h1 { color: #166534; margin-bottom: 0.5rem; }
                  p { color: #57534e; }
                  button { background: #166534; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 0.5rem; font-size: 1rem; cursor: pointer; margin-top: 1rem; }
                </style>
              </head>
              <body>
                <div class="box">
                  <h1>Ingen dekning</h1>
                  <p>Du er offline. Siden du prøver å åpne er ikke tilgjengelig uten internett.</p>
                  <p><strong>Tips:</strong> Åpne dommer-siden mens du har dekning, så fungerer den også til fjells.</p>
                  <button onclick="location.reload()">Prøv igjen</button>
                </div>
              </body>
              </html>
            `, {
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
          });
        }
        // For andre ressurser, returner en tom respons
        return new Response('', { status: 503 });
      });
    })
  );
});

// Lytt etter meldinger fra hovedtråden
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
  if (event.data === 'clearCache') {
    caches.delete(CACHE_NAME).then(() => {
      console.log('[SW] Cache cleared');
    });
  }
  if (event.data === 'syncNow') {
    syncPendingRequests();
  }
});

// ======================================
// IndexedDB for offline kritikk-kø
// ======================================

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

async function queueOfflineRequest(url, method, body) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.add({
      url,
      method,
      body,
      timestamp: Date.now()
    });
    console.log('[SW] Kritikk lagret i offline-kø:', url);

    // Registrer for background sync hvis støttet
    if (self.registration.sync) {
      await self.registration.sync.register('sync-kritikker');
    }
  } catch (err) {
    console.error('[SW] Kunne ikke lagre i offline-kø:', err);
  }
}

async function getPendingRequests() {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function clearPendingRequest(id) {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.delete(id);
}

// Background sync når tilkoblingen er tilbake
self.addEventListener('sync', event => {
  if (event.tag === 'sync-kritikker') {
    console.log('[SW] Background sync triggered');
    event.waitUntil(syncPendingRequests());
  }
});

async function syncPendingRequests() {
  console.log('[SW] Synkroniserer ventende kritikker...');
  let successCount = 0;
  let failCount = 0;

  try {
    const pendingRequests = await getPendingRequests();
    console.log(`[SW] Fant ${pendingRequests.length} ventende forespørsler`);

    for (const req of pendingRequests) {
      try {
        const response = await fetch(req.url, {
          method: req.method,
          headers: { 'Content-Type': 'application/json' },
          body: req.body
        });

        if (response.ok) {
          await clearPendingRequest(req.id);
          successCount++;
          console.log('[SW] Synkronisert:', req.url);
        } else {
          failCount++;
          console.warn('[SW] Serverfeil ved sync:', response.status);
        }
      } catch (error) {
        failCount++;
        console.log('[SW] Kunne ikke synke, prøver igjen senere:', req.url);
      }
    }

    // Varsle alle klienter om synkroniseringsstatus
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({
        type: 'SYNC_COMPLETE',
        success: successCount,
        failed: failCount,
        pending: (await getPendingRequests()).length
      });
    });

  } catch (err) {
    console.error('[SW] Sync feilet:', err);
  }
}
