/* Calgo service worker — NETWORK-FIRST.
 *
 * Purpose: stop the browser/PWA from showing a stale cached build. When online we
 * always go to the network first (so the latest deployed index.html/manifest is used)
 * and only fall back to the cache when the network is unavailable (basic offline shell).
 *
 * Design notes:
 *  - Only same-origin GET requests are intercepted; Supabase/CDN calls pass through
 *    untouched (never cached here).
 *  - skipWaiting + clients.claim so a new SW version takes over immediately on next load.
 *  - This can never serve stale content while online, because network is always tried first.
 */
const CACHE = 'calgo-shell-v1';

self.addEventListener('install', event => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        // Drop any old caches from previous versions.
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const req = event.request;
    const url = new URL(req.url);

    // Only handle same-origin GETs (the app shell). Let everything else (Supabase, CDNs,
    // POST/PUT/etc.) go straight to the network with no interception.
    if (req.method !== 'GET' || url.origin !== self.location.origin) return;

    event.respondWith((async () => {
        try {
            const fresh = await fetch(req);
            // Cache a copy for offline fallback (best-effort).
            try {
                const cache = await caches.open(CACHE);
                cache.put(req, fresh.clone());
            } catch (e) { /* ignore cache write failures */ }
            return fresh;
        } catch (e) {
            // Offline → serve last-known-good from cache if we have it.
            const cached = await caches.match(req);
            if (cached) return cached;
            throw e;
        }
    })());
});
