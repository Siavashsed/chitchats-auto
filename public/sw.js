// Service Worker for ChitChats Auto PWA.
// Handles: push notifications (wake on push, fetch data, show notification)
// and basic asset caching for offline access to the dashboard.

const CACHE = 'chitchats-v1';
const SHELL = ['/', '/manifest.json', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Network-first for API calls; cache-first for shell assets.
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/label/')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});

// Push received: server sent a bodyless push. Fetch notification details.
self.addEventListener('push', async e => {
  e.waitUntil((async () => {
    let title = 'Dalmend - New Orders';
    let body = 'Tap to view your shipping dashboard.';
    let badge = 0;

    try {
      // The server has a /api/pending-notifications endpoint returning summary
      const res = await fetch('/api/pending-notifications');
      if (res.ok) {
        const d = await res.json();
        badge = d.count || 0;
        if (d.count === 0) {
          title = 'Dalmend - All caught up';
          body = d.summary || 'No new orders.';
        } else {
          title = `Dalmend - ${d.count} order${d.count !== 1 ? 's' : ''} ready`;
          body = d.summary || `${d.count} new order${d.count !== 1 ? 's' : ''} to ship.`;
        }
      }
    } catch {}

    await self.registration.showNotification(title, {
      body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'dalmend-orders',    // replace old notification instead of stacking
      renotify: true,
      data: { url: '/' },
      actions: [
        { action: 'open', title: 'View Dashboard' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(all => {
      for (const c of all) {
        if (c.url.includes(self.location.origin)) return c.focus();
      }
      return clients.openWindow('/');
    })
  );
});
