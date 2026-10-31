// Habit Tracker service worker (same approach as Canon's).
//
//  - The app SHELL (index.html, manifest) is network-first. Every deploy is
//    picked up on the next launch that has connectivity, with no version bump
//    and no manual cache clearing. The cached copy exists so the app opens
//    with no network at all.
//  - If the network is slow (over 2.5s) the saved copy opens right away while
//    the fresh download finishes in the background. When that newer build is
//    saved, open windows get a message so the app can offer a Reload.
//  - Icons are cache-first. Bump SHELL_CACHE_NAME only when PRECACHE_URLS
//    changes (for example a new icon file).
//  - Everything else goes straight to the network.

const SHELL_CACHE_NAME = 'habit-tracker-shell-v6';

const PRECACHE_URLS = [
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE_NAME).then((cache) =>
      // Cache each file on its own so one failure doesn't sink offline support.
      // cache:'reload' skips the browser's HTTP cache so we never store an old build.
      Promise.all(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((e) => {
            console.warn('Habit SW: precache skipped for', url, e && e.message);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          // Retire older Habit Tracker caches (including the v5 one). Leave anything else alone.
          .filter((name) => name.startsWith('habit-tracker-') && name !== SHELL_CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const isNavigation = event.request.mode === 'navigate';
  const isShellFile = url.pathname.endsWith('/index.html') || url.pathname.endsWith('/manifest.webmanifest');

  if (isNavigation || isShellFile) {
    event.respondWith(networkFirst(event.request, event));
    return;
  }

  if (/\.(png|ico|svg)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(event.request, event));
    return;
  }
  // anything else: untouched, straight to the network
});

const SHELL_NETWORK_TIMEOUT_MS = 2500;

// SHA-256 of the body. Headers aren't reliable: two builds can share a length.
async function shellSignature(resp) {
  try {
    const buf = await resp.clone().arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return 'x:' + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return ''; }
}

async function notifyUpdateReady() {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  windows.forEach((c) => c.postMessage({ type: 'habit-update-ready' }));
}

async function networkFirst(request, event) {
  const cache = await caches.open(SHELL_CACHE_NAME);
  const shellUrl = new URL('./index.html', self.registration.scope).href;
  const isNav = request.mode === 'navigate';

  // The app is ONE page. Whatever address a launch used (site root, index.html,
  // either with a ?query), it is saved to and served from one canonical entry.
  const fromCache = async () => {
    if (isNav) {
      const shell = await cache.match(shellUrl);
      if (shell) return shell;
    }
    return cache.match(request, { ignoreSearch: true });
  };

  // True once the page was handed the SAVED copy. Only then does a newer build
  // arriving later mean "this window is out of date".
  let servedSavedCopy = false;
  const networkPromise = fetch(request, { cache: 'no-cache' }).then(async (fresh) => {
    // Never let a 404/500 overwrite a good saved copy.
    if (fresh && fresh.ok) {
      let changed = false;
      if (isNav) {
        try {
          const old = await cache.match(shellUrl);
          if (old) {
            const [a, b] = await Promise.all([shellSignature(old), shellSignature(fresh)]);
            changed = !!a && !!b && a !== b;
          }
        } catch (e) { /* can't compare: just don't announce */ }
      }
      const saved = cache.put(isNav ? shellUrl : request, fresh.clone()).then(() => {
        if (changed && servedSavedCopy) return notifyUpdateReady();
      }).catch((e) => {
        console.warn('Habit SW: could not save', request.url, e && e.message);
      });
      if (event && event.waitUntil) event.waitUntil(saved);
    }
    return fresh;
  });
  networkPromise.catch(() => {});
  if (event && event.waitUntil) event.waitUntil(networkPromise.catch(() => {}));

  const cached = await fromCache();
  if (!cached) return networkPromise; // first ever load: nothing saved, so wait

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), SHELL_NETWORK_TIMEOUT_MS));
  try {
    const winner = await Promise.race([networkPromise, timeout]);
    if (winner && winner.ok) return winner;
  } catch (e) { /* offline or failed: use the saved copy */ }
  servedSavedCopy = true;
  return cached;
}

async function cacheFirst(request, event) {
  const cache = await caches.open(SHELL_CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const fresh = await fetch(request);
  if (fresh && fresh.ok) {
    const saved = cache.put(request, fresh.clone()).catch(() => {});
    if (event && event.waitUntil) event.waitUntil(saved);
  }
  return fresh;
}
