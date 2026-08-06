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
// Bump this whenever a release must not be served from an old offline copy. The activate
// handler deletes every cache that isn't this one, so an installed PWA that was launched
// offline can't keep showing a previous build forever.
const CACHE = 'calgo-shell-v3';

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
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="114" fill="%23f5f3ec"/><g fill="%231b1e2a"><rect x="176" y="112" width="26" height="60" rx="13"/><rect x="310" y="112" width="26" height="60" rx="13"/><rect x="122" y="146" width="268" height="248" rx="54"/></g><g fill="none" stroke="%23d4483b" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"><path d="M186,222L248,270L186,318"/><path d="M272,222L334,270L272,318"/></g></svg>',
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
