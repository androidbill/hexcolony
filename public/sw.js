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
  'bot.js',
  'cards.js',
  'fb.js',
  'discord.js',
  'discord-config.js',
  'render.js',
  'audio.js',
  'wordcodes.js',
  'version.js',
  'sfx/index.json',
  'firebase-config.js',
  'manifest.webmanifest',
  // Only the icon the app itself shows. The 512s are for the launcher and the splash
  // screen, which the OS fetches at install time — precaching them would cost every
  // player 330 KB for images the page never draws.
  'icons/icon-192.png',
  'icons/apple-touch-icon.png',
];

// Terrain illustrations, precached so the board looks right offline. Only the format
// actually shipped is listed — the fetch handler is network-first with a cache
// fallback, so art in any other format still gets cached the first time it is used;
// precaching every extension would just mean ten 404s on every install.
const ART = ['wood', 'brick', 'sheep', 'wheat', 'ore', 'desert'].map((n) => `art/${n}.jpg`);

/**
 * The recorded effects, read from their own index at install time.
 *
 * Listing them here instead would mean two places to edit every time one is added, and
 * the one that got forgotten would be this one — where the symptom is only ever "the
 * game is silent on a bad connection", which nobody reports.
 */
async function soundFiles() {
  try {
    const res = await fetch('sfx/index.json', { cache: 'reload' });
    if (!res.ok) return [];
    const list = await res.json();
    const names = Array.isArray(list)
      ? list.map((n) => `${n}.mp3`)
      : Object.entries(list).map(([n, v]) => (typeof v === 'string' ? v : v?.file) || `${n}.mp3`);
    return names.map((f) => `sfx/${f}`);
  } catch { return []; }
}

self.addEventListener('install', (e) => {
  // cache:'reload' so a new VERSION always pulls fresh bytes. Plain addAll() may answer
  // from the browser's own HTTP cache, leaving new JS running against an old module.
  e.waitUntil(
    Promise.all([caches.open(CACHE), soundFiles()])
      .then(([c, sounds]) => Promise.all([...CORE, ...ART, ...sounds].map((f) => fetch(f, { cache: 'reload' })
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
      // Tell the pages we just took over. A worker knows a new build has landed before
      // any polling would, so this is the earliest anything can say so.
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => clients.forEach((c) => c.postMessage({ type: 'NEW_VERSION', version: VERSION })))
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
