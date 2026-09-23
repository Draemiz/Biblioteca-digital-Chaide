/* Chaide Digital Library — service worker.
 * Scope is deliberately conservative so nothing can serve stale app code:
 *  - Hashed build assets (/assets/*) and pdf.js cMaps (/cmaps/*) are immutable
 *    -> cache-first (instant repeat loads, basic offline).
 *  - Everything else (HTML navigation, /api/*, PDFs) is network-first / passthrough.
 *  - PDF byte-range requests (206 Partial Content) are never cached here; they
 *    rely on the immutable HTTP cache instead.
 */
const CACHE = 'chaide-static-v1';
const SCOPE_PATH = new URL(self.registration.scope).pathname;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isImmutableAsset(url) {
  return (
    url.pathname.startsWith(`${SCOPE_PATH}assets/`) ||
    url.pathname.startsWith(`${SCOPE_PATH}cmaps/`)
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  // Only handle same-origin requests.
  if (url.origin !== self.location.origin) return;

  // Never touch byte-range requests (PDF streaming) or API calls.
  if (req.headers.has('range')) return;
  if (url.pathname.startsWith(`${SCOPE_PATH}api/`)) return;
  if (url.pathname.startsWith(`${SCOPE_PATH}storage/`)) return;

  // Cache-first for immutable hashed assets / cMaps.
  if (isImmutableAsset(url)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && res.status === 200) cache.put(req, res.clone());
          return res;
        } catch (e) {
          return hit || Response.error();
        }
      })
    );
  }
  // Other GETs fall through to the network normally.
});
