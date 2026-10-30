/*
 * Enyalië service worker: lets the app open without a network connection
 * after it has been loaded once.
 *
 * How it works:
 *  - On install it downloads index.html, finds the scripts, styles and
 *    starter decks that page refers to, and caches them together with the
 *    icons and the manifest (the "app shell").
 *  - Opening the app goes to the network first, so you get updates as soon as
 *    they are deployed. If the network fails or takes more than a few seconds,
 *    the cached copy is used instead.
 *  - Every other file from this site comes from the cache when it's there.
 *
 * Your decks are not stored here; they live in IndexedDB.
 * Bump CACHE_VERSION if you change this file in a way that should throw away
 * everything cached by older versions.
 */
const CACHE_VERSION = 5;
const CACHE_NAME = `enyalie-v${CACHE_VERSION}`;
const NAVIGATION_TIMEOUT_MS = 4000;

const SCOPE = self.registration.scope;
const SCOPE_PATH = new URL(SCOPE).pathname;
const INDEX_URL = new URL('./', SCOPE).href;
const STATIC_FILES = [
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
].map((path) => new URL(path, SCOPE).href);

/** Files in assets/ have a content hash in their name, so a cached copy never goes stale. */
function isHashedAsset(url) {
  return new URL(url).pathname.startsWith(`${SCOPE_PATH}assets/`);
}

function isAppPage(url) {
  return url.pathname === SCOPE_PATH || url.pathname === `${SCOPE_PATH}index.html`;
}

/** Same-origin URLs of the scripts, styles, icons and starter decks that index.html refers to. */
function referencedUrls(html) {
  const urls = new Set();
  for (const match of html.matchAll(/\b(?:src|href)="([^"#?]+)/g)) {
    const url = new URL(match[1], INDEX_URL);
    if (url.origin === self.location.origin && url.href !== INDEX_URL) urls.add(url.href);
  }
  return urls;
}

/** Stores a fresh index.html and makes sure everything it needs is cached. */
async function cacheAppShell(htmlResponse) {
  const cache = await caches.open(CACHE_NAME);
  const html = await htmlResponse.clone().text();
  const previous = await cache.match(INDEX_URL);
  const unchanged = previous !== undefined && (await previous.text()) === html;
  await cache.put(INDEX_URL, htmlResponse);

  const wanted = new Set([...referencedUrls(html), ...STATIC_FILES]);
  await Promise.all(
    [...wanted].map(async (url) => {
      const cached = await cache.match(url);
      if (cached && (unchanged || isHashedAsset(url))) return;
      try {
        const response = await fetch(url, { cache: 'no-cache' });
        if (response.ok) await cache.put(url, response);
      } catch {
        // Offline right now; we'll try again on the next visit.
      }
    }),
  );

  if (!unchanged) {
    // Drop scripts, styles and starter decks from older builds.
    for (const request of await cache.keys()) {
      if (isHashedAsset(request.url) && !wanted.has(request.url)) await cache.delete(request);
    }
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function handleAppPage(event) {
  // Ask the network straight away, and refresh the cached shell when it answers.
  const network = fetch(event.request).then((response) => ({
    response,
    copy: response.ok ? response.clone() : null,
  }));
  event.waitUntil(network.then(({ copy }) => (copy ? cacheAppShell(copy) : undefined)).catch(() => undefined));

  return (async () => {
    try {
      const { response } = await withTimeout(network, NAVIGATION_TIMEOUT_MS);
      return response;
    } catch {
      const cached = await caches.match(INDEX_URL);
      if (cached) return cached;
      return (await network).response; // nothing cached yet, so keep waiting for the network
    }
  })();
}

async function cacheFirst(event) {
  const cached = await caches.match(event.request);
  if (cached) return cached;
  const response = await fetch(event.request);
  if (response.ok && response.type === 'basic') {
    const copy = response.clone();
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)));
  }
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch(INDEX_URL, { cache: 'no-cache' });
      if (!response.ok) throw new Error(`Couldn't download ${INDEX_URL} (${response.status}).`);
      await cacheAppShell(response);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith('enyalie-') && key !== CACHE_NAME).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    if (isAppPage(url)) event.respondWith(handleAppPage(event));
    return; // other pages (e.g. opening a .json file directly) use the network as usual
  }
  event.respondWith(cacheFirst(event));
});
