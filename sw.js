// Offline support: app files are fetched fresh when online (so updates show
// up straight away) and served from cache when there's no signal.
// Address lookups and travel times are never cached here.

const CACHE = 'rider-route-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg',
  'src/app.js', 'src/geocode.js', 'src/plan.js', 'src/matrix.js', 'src/optimize.js',
  'src/ocr-browser.js', 'src/sheet-ocr.js', 'src/imageprep.js'];
const LIBS = ['unpkg.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request)));
  } else if (LIBS.includes(url.hostname)) {
    // pinned library versions never change: cache first
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    })));
  }
});
