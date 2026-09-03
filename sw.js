// DEJA VU PWA service worker.
// Version this cache whenever the app shell changes. Activation removes older
// DEJA VU caches, while navigation uses network-first so GitHub Pages updates
// are picked up promptly without sacrificing the cached offline app.
const CACHE_NAME = 'deja-vu-v1.0.18-rc5';
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
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
  return response;
}

async function navigationResponse(request) {
  try {
    const response = await fetch(request, { cache: 'no-cache' });
    return cacheResponse(request, response);
  } catch (_) {
    return (await caches.match(request)) || (await caches.match('./index.html')) || (await caches.match('./'));
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
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigationResponse(request));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
