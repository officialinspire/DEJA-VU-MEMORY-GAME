// DEJA VU PWA service worker.
// App code uses network-first while online so GitHub Pages serves gameplay fixes
// immediately. Cached fallbacks preserve offline play.
const CACHE_NAME = 'deja-vu-v1.0.19-rc1';
const CACHE_PREFIX = 'deja-vu-';

const APP_SHELL = [
  './', './index.html', './styles.css', './deja-vu-backgrounds.css', './responsive-board.css',
  './matched-card-polish.css', './gameplay-preview.css', './results-ux.css',
  './runtime-config.js', './index.js', './gameplay-preview.js', './input-guard.js',
  './accessibility.js', './results-ux.js', './sprite-atlas.js', './save-integrity.js',
  './stats-integrity.js', './manifest.webmanifest', './card-flip-sprite-sheet.png',
  './logo.png', './inspiresoftwareintro.mp4', './deja-vu-theme.mp3',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

function isCacheable(response) {
  return Boolean(response && response.ok && (response.type === 'basic' || response.type === 'default'));
}

async function cacheResponse(request, response) {
  if (!isCacheable(response)) return response;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  } catch (_) {
    // A cache-write failure must never discard a healthy network response.
  }
  return response;
}

async function networkFirst(request, navigationFallback = false) {
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    return cacheResponse(request, response);
  } catch (_) {
    const cached = await caches.match(request);
    if (cached) return cached;
    if (navigationFallback) {
      return (await caches.match('./index.html')) || (await caches.match('./')) || Response.error();
    }
    return Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const network = fetch(request).then((response) => cacheResponse(request, response)).catch(() => null);
  if (cached) {
    network.catch(() => null);
    return cached;
  }
  return (await network) || Response.error();
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Let the browser handle byte-range media requests directly.
  if (request.headers.has('range')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, true));
    return;
  }

  // Gameplay code/styles should update on the first online load, not one load
  // later through stale-while-revalidate.
  if (request.destination === 'script' || request.destination === 'style') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});
