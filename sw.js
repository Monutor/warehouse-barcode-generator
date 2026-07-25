const CACHE_NAME = 'barcode-app-v6';
const CDN_CACHE_NAME = 'barcode-cdn-v6';

const ASSETS = [
  '/warehouse-barcode-generator/index.html',
  '/warehouse-barcode-generator/css/style.css',
  '/warehouse-barcode-generator/js/app.js',
  '/warehouse-barcode-generator/data/shelves.json',
  '/warehouse-barcode-generator/manifest.json'
];

const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/vue@3.4.21/dist/vue.global.prod.js',
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {}),
      caches.open(CDN_CACHE_NAME).then((cache) => cache.addAll(CDN_ASSETS)).catch(() => {})
    ])
  );
  self.skipWaiting();
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME && k !== CDN_CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin.includes('cdn.jsdelivr.net')) {
    event.respondWith(
      caches.match(event.request).then((response) => {
          return response || fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const responseToCache = networkResponse.clone();
            caches.open(CDN_CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            }).catch(() => {});
          }
          return networkResponse;
        }).catch(() => caches.match(event.request));
      })
    );
  } else {
    event.respondWith(
      caches.match(event.request).then((response) => {
        return response || fetch(event.request).catch(() => {
          return new Response('Offline', { status: 503 });
        });
      })
    );
  }
});
