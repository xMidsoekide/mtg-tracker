/* Service worker — makes the tracker installable + offline-capable.
   Strategy:
   - App shell (this origin) is precached on install.
   - Navigations: network-first so a freshly-deployed index.html wins, cached index as fallback.
   - Other same-origin GETs: stale-while-revalidate — instant from cache, refresh in the background.
   - Cross-origin (Scryfall images, api.github.com gist sync) is NOT intercepted: those need
     live network + auth, and caching them here would only get in the way.
   Bump VERSION whenever the shell changes so old caches are cleared on activate. */
const VERSION = "v3";
const CACHE = `mtg-tracker-${VERSION}`;

const PRECACHE = [
  ".",
  "index.html",
  "manifest.json",
  "js/app.js",
  "js/metrics.js",
  "js/scryfall.js",
  "js/storage.js",
  "js/sync.js",
  "data/players.json",
  "data/decks.json",
  "data/games.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const { request } = e;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // let Scryfall / GitHub go straight to network

  if (request.mode === "navigate") {
    e.respondWith(
      fetch(request)
        .then(r => { caches.open(CACHE).then(c => c.put(request, r.clone())); return r; })
        .catch(() => caches.match(request).then(r => r || caches.match("index.html")))
    );
    return;
  }

  e.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request)
        .then(r => { caches.open(CACHE).then(c => c.put(request, r.clone())); return r; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
