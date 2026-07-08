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

// Background push from the Calgo server (push-reminders Edge Function).
// Payload: { title, body, tag }
self.addEventListener('push', event => {
    let payload = { title: '📅 Calgo', body: '', tag: 'calgo-push' };
    try { payload = { ...payload, ...event.data.json() }; } catch (e) { /* keep defaults */ }
    event.waitUntil(self.registration.showNotification(payload.title, {
        body: payload.body,
        tag: payload.tag,
        renotify: true,
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="%236366f1"/><text x="50" y="68" text-anchor="middle" font-size="50">📅</text></svg>',
        data: { url: self.registration.scope }
    }));
});

// Notification tapped → focus an existing Calgo window, or open one.
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil((async () => {
        const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of clientList) {
            if ('focus' in client) return client.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
    })());
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
