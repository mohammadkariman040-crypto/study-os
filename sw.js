const CACHE = 'study-os-shell-v94';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './study-os-mark.svg',
  './cloud-sync.js?v=94',
  './study-os-v93.css?v=94',
  './study-os-v93.js?v=94'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('study-os-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).then(res => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(cache => cache.put('./index.html', copy)); }
      return res;
    }).catch(() => caches.match('./index.html').then(hit => hit || caches.match('./'))));
    return;
  }
  event.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(cache => cache.put(req, copy)); }
    return res;
  })));
});
