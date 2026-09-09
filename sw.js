const CACHE_NAME = 'barcode-app-v15';
const CDN_CACHE_NAME = 'barcode-cdn-v6';

// P1-6: относительные пути — работают и под /warehouse-barcode-generator/,
// и на localhost, и на кастомном домене (резолвятся от URL самого sw.js)
const ASSETS = [
  'index.html',
  'css/style.css',
  'js/app.js',
  'data/shelves.json',
  'data/products.json',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/barcode-icon.svg',
  'icons/barcode-tag-icon.svg'
];

const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/vue@3.4.21/dist/vue.global.prod.js',
  'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/cam2qr@1.1.1/dist/index.js'
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
      ).catch(() => {})
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // P1-6: кэшируем только GET — match/put с POST падают
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin.includes('cdn.jsdelivr.net')) {
    // P1-6: stale-while-revalidate вместо cache-first-навсегда:
    // мгновенный ответ из кэша + тихое обновление в фоне.
    // Попутно кэшируются и саб-импорты cam2qr при первом онлайне.
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const responseToCache = networkResponse.clone();
            caches.open(CDN_CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            }).catch(() => {});
          }
          return networkResponse;
        }).catch(() => cached);
        return cached || network;
      })
    );
  } else if (event.request.mode === 'navigate' && url.origin === self.location.origin) {
    // P1-6: navigation-fallback — офлайн и диплинки (#print и т.п.)
    // отдают кэшированный index.html, а не текст 'Offline'
    const indexUrl = new URL('index.html', self.registration.scope).href;
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(indexUrl).then((cached) =>
          cached || new Response('Offline', { status: 503 })
        )
      )
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
