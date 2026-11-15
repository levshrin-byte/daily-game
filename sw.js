// Service worker for the hosted site (scripts/build.mjs fills in VERSION and SHELL; the artifact never uses it).
//  - Pages: network first, so a new day's build shows up straight away; the cached page when offline.
//  - Hashed code (app.*.js, style.*.css) and the versioned data folder never change: cache first.
//  - Everything else from this site: cached copy at once, refreshed in the background.
//  - Other hosts (map tiles, fonts) are left to the browser and their own cache headers, as the OSM tile policy asks.
const VERSION = "__VERSION__";
const SHELL = [/*__SHELL__*/];
const CACHE = "elevation-" + VERSION;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("elevation-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  const put = (res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; };
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then(put).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match("./"))));
  } else if (/\/(app|style)\.[0-9a-f]{10}\.(js|css)$|\/data\/[0-9a-f]{10}\//.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(put)));
  } else {
    e.respondWith(caches.match(req).then((hit) => {
      const fresh = fetch(req).then(put).catch(() => hit);
      return hit || fresh;
    }));
  }
});
