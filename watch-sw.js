// Service Worker for 課題同盟 PWA
const CACHE = 'kadai-doumei-v4';
const PRECACHE = ['watch.html', 'watch.js', 'watch.css', 'watch-manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  // Firebase / CDN requests: network only
  if (e.request.url.includes('firebase') || e.request.url.includes('gstatic')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
