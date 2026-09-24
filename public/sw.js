// Minimal service worker: exists solely to satisfy PWA installability
// requirements (Chrome requires a registered service worker with a fetch
// handler). It deliberately does no caching so the app always gets live
// data from the server.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
