// DEJA VU PWA service worker.
//
// FIRST-ONLINE-LOAD REQUIREMENT
// The app must be loaded once while online. That first load registers this
// worker, which precaches the whole app shell into a single versioned cache
// during `install`. Offline play is available as soon as that install settles
// (the worker also claims the first page, so no second visit is needed). If the
// connection drops before install finishes, the install fails, nothing is
// activated, and the next online load retries from scratch.
//
// UPDATES
// One cache generation serves a whole page session, so a session never mixes
// old and new assets. A new worker precaches into a new cache and then waits:
// it activates on the next cold start, once no page is controlled by the old
// worker. Reloading a tab does not hand over, by design.
const CACHE_VERSION = 'v1.2.0';
const CACHE_NAME = `deja-vu-${CACHE_VERSION}`;
const CACHE_PREFIX = 'deja-vu-';

const APP_SHELL = [
  './', './index.html', './styles.css', './deja-vu-backgrounds.css', './responsive-board.css',
  './matched-card-polish.css', './gameplay-preview.css', './results-ux.css',
  './runtime-config.js', './index.js', './audio-manager.js', './feedback-manager.js', './gameplay-preview.js', './input-guard.js',
  './accessibility.js', './results-ux.js', './sprite-atlas.js', './save-integrity.js',
  './stats-integrity.js', './manifest.webmanifest', './card-flip-sprite-sheet.png',
  './logo.png', './inspiresoftwareintro.mp4',
  './Deja Vu - Main Menu (Vibe 1).mp3', './Minimalist Electronic Focus Theme.mp3',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
];

// Media and artwork are precached like everything else, but one failing entry
// must not abort the install and strand the app on the previous version. These
// are re-fetched and cached on demand the next time they are requested, and the
// game stays playable without them: audio play() rejections are swallowed by the
// music manager and the intro video falls through to the menu on error.
const OPTIONAL_ASSETS = new Set([
  './card-flip-sprite-sheet.png',
  './logo.png',
  './inspiresoftwareintro.mp4',
  './Deja Vu - Main Menu (Vibe 1).mp3',
  './Minimalist Electronic Focus Theme.mp3',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
]);

// Resolved against this worker's own URL, so a GitHub Pages project subpath
// (/<repo>/) works exactly like a root deployment.
const toAbsolute = (path) => new URL(path, self.location).href;
const SHELL_URL = toAbsolute('./index.html');
const ROOT_URL = toAbsolute('./');

// 206 responses cannot be stored by the Cache API, and an opaque response has
// an unknown status, so only full same-origin 200s are cacheable.
function isCacheable(response) {
  return Boolean(
    response
    && response.status === 200
    && (response.type === 'basic' || response.type === 'default')
  );
}

// Shell assets keyed by their path relative to scope, e.g. 'styles.css' and
// 'icons/icon-192.png'.
const SHELL_BY_PATH = new Map(
  APP_SHELL
    .filter((path) => path !== './')
    .map((path) => [path.replace(/^\.\//, ''), toAbsolute(path)])
);
const SCOPE_PATH = new URL('./', self.location).pathname;

// A navigation to a deeper same-origin path is answered with the shell, and the
// shell's relative asset URLs then resolve against that deeper path. Walk the
// tail of the request path back to a known shell asset so those still resolve.
function shellFallbackUrl(url) {
  if (!url.pathname.startsWith(SCOPE_PATH)) return null;
  const segments = url.pathname.slice(SCOPE_PATH.length).split('/').filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = SHELL_BY_PATH.get(segments.slice(index).join('/'));
    if (candidate) return candidate;
  }
  return null;
}

// Every lookup is pinned to the current generation's cache and ignores query
// strings, so `./index.js?v=3` resolves to the precached `./index.js`.
async function matchCached(request) {
  const direct = await caches.match(request, { cacheName: CACHE_NAME, ignoreSearch: true });
  if (direct) return direct;
  let url;
  try {
    url = new URL(typeof request === 'string' ? request : request.url);
  } catch (_) {
    return undefined;
  }
  const fallback = shellFallbackUrl(url);
  if (!fallback || fallback === url.href) return undefined;
  return caches.match(fallback, { cacheName: CACHE_NAME });
}

async function putCached(request, response) {
  if (!isCacheable(response)) return response;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  } catch (_) {
    // A cache-write failure must never discard a healthy network response.
  }
  return response;
}

// Failures are reported to any open page as well as to this worker's own
// console, so a broken deploy is visible in development wherever you are
// looking. matchAll includes uncontrolled windows, so the very first install
// reaches the page that triggered it.
async function report(message) {
  console.warn('[DEJA VU sw]', message.reason, message);
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    clients.forEach((client) => client.postMessage(message));
  } catch (_) {
    // Reporting must never be the reason an install fails.
  }
}

async function precache() {
  // Remember whether this generation's cache already existed. If it did, an
  // active or waiting worker is serving from it and it must survive a failed
  // re-install; if we created it, a failed install should not leave a partial
  // one behind for the next attempt to adopt.
  const preexisting = await caches.has(CACHE_NAME);
  const cache = await caches.open(CACHE_NAME);
  const failures = [];

  // Individually, not addAll(): addAll rejects as a unit, so one 404 would
  // discard every asset that did download.
  await Promise.all(APP_SHELL.map(async (path) => {
    try {
      // cache: 'reload' bypasses the HTTP cache so a new worker generation
      // never precaches a stale copy of an asset the browser already holds.
      const response = await fetch(toAbsolute(path), { cache: 'reload' });
      if (!response || !response.ok) throw new Error(`HTTP ${response ? response.status : 'no response'}`);
      await cache.put(toAbsolute(path), response);
    } catch (error) {
      failures.push({ path, reason: (error && error.message) || String(error) });
    }
  }));

  const required = failures.filter((failure) => !OPTIONAL_ASSETS.has(failure.path));
  if (required.length) {
    await report({ type: 'DEJA_VU_PRECACHE', reason: 'install-failed', version: CACHE_VERSION, failures });
    if (!preexisting) await caches.delete(CACHE_NAME);
    // Refuse to activate a half-built generation: the previous worker keeps
    // serving and the next online load retries.
    throw new Error(`app shell incomplete: ${required.map((failure) => `${failure.path} (${failure.reason})`).join(', ')}`);
  }
  if (failures.length) {
    await report({ type: 'DEJA_VU_PRECACHE', reason: 'optional-assets-missing', version: CACHE_VERSION, failures });
  }
}

self.addEventListener('install', (event) => {
  // No skipWaiting: see UPDATES above.
  event.waitUntil(precache());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
    // Only reached once this generation's cache is fully populated, so the
    // first visit becomes offline-capable without a reload.
    await self.clients.claim();
  })());
});

// Offline navigation always resolves to the cached shell, whatever the subpath
// or query string, because the request URL is not used for the lookup.
async function handleNavigate(request) {
  const shell = (await matchCached(SHELL_URL)) || (await matchCached(ROOT_URL));
  if (shell) return shell;
  try {
    return await putCached(request, await fetch(request));
  } catch (_) {
    return Response.error();
  }
}

async function handleAsset(request) {
  const cached = await matchCached(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    return putCached(request, response);
  } catch (_) {
    return Response.error();
  }
}

// Mobile browsers request media by byte range, and Safari will not play a
// resource that answers a Range request with a 200. Serve 206 slices out of the
// cached full response so the MP4 and MP3s play with no network at all.
function buildRangeResponse(rangeHeader, buffer, contentType) {
  const total = buffer.byteLength;
  const unsatisfiable = () => new Response(null, {
    status: 416,
    statusText: 'Range Not Satisfiable',
    headers: { 'Content-Range': `bytes */${total}` },
  });

  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
  if (!match || (match[1] === '' && match[2] === '')) return unsatisfiable();

  let start;
  let end;
  if (match[1] === '') {
    // Suffix form: the last N bytes.
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return unsatisfiable();
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? total - 1 : Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= total) {
      return unsatisfiable();
    }
    end = Math.min(end, total - 1);
  }

  const slice = buffer.slice(start, end + 1);
  const headers = new Headers({
    'Content-Length': String(slice.byteLength),
    'Content-Range': `bytes ${start}-${end}/${total}`,
    'Accept-Ranges': 'bytes',
    // The slice is assembled per request; the full body is already in the cache.
    'Cache-Control': 'no-store',
  });
  if (contentType) headers.set('Content-Type', contentType);
  return new Response(slice, { status: 206, statusText: 'Partial Content', headers });
}

async function handleRange(request) {
  const cached = await matchCached(request);
  if (cached) {
    try {
      const buffer = await cached.clone().arrayBuffer();
      return buildRangeResponse(request.headers.get('range'), buffer, cached.headers.get('Content-Type'));
    } catch (_) {
      // Fall through to the network rather than fail the media element.
    }
  }
  try {
    // Online and not yet cached: let the server range-serve it, and warm the
    // cache with a separate full copy for the next offline session.
    const response = await fetch(request);
    if (!cached) warmMediaCache(request);
    return response;
  } catch (_) {
    return Response.error();
  }
}

function warmMediaCache(request) {
  const url = new URL(request.url);
  url.search = '';
  fetch(url.href, { cache: 'no-cache' })
    .then((response) => (isCacheable(response) ? putCached(url.href, response) : null))
    .catch(() => null);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }
  // Anything cross-origin is left to the browser; this app ships no external
  // dependencies, so nothing here should be cross-origin in the first place.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
    return;
  }

  if (request.headers.has('range')) {
    event.respondWith(handleRange(request));
    return;
  }

  event.respondWith(handleAsset(request));
});
