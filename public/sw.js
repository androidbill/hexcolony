// HexColony service worker — the ?v= in the registration URL busts the cache on deploy.
const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE = `hexcolony-${VERSION}`;

const CORE = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'board.js',
  'rules.js',
  'render.js',
  'audio.js',
  'wordcodes.js',
  'version.js',
  'firebase-config.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

// Terrain illustrations, precached so the board looks right offline. Each entry is
// fetched with a tolerant catch below, so extensions that do not exist cost one failed
// request at install and nothing else.
const ART = ['wood', 'brick', 'sheep', 'wheat', 'ore']
  .flatMap((n) => [`art/${n}.jpg`, `art/${n}.png`, `art/${n}.webp`]);

self.addEventListener('install', (e) => {
  // cache:'reload' so a new VERSION always pulls fresh bytes. Plain addAll() may answer
  // from the browser's own HTTP cache, leaving new JS running against an old module.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all([...CORE, ...ART].map((f) => fetch(f, { cache: 'reload' })
        .then((res) => (res && res.ok) ? c.put(f, res) : null)
        .catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for same-origin so the app is always fresh online, cache as the
// offline fallback. Firebase traffic is cross-origin and passes straight through.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then((hit) => hit || caches.match('index.html')))
  );
});
