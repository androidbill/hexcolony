// HexColony service worker — the ?v= in the registration URL busts the cache on deploy.
const VERSION = new URL(self.location).searchParams.get('v') || 'dev';
const CACHE = `hexcolony-${VERSION}`;

// The launch video lives in a cache of its own, not the per-version one: it is 735 KB and
// never changes with a deploy, and every build is a new version, so keeping it with the
// rest would download it again on every update. Rename this (…-2) if the video is ever
// replaced, which also clears out the old one on activate.
const SPLASH_CACHE = 'hexcolony-splash-1';
const SPLASH_FILE = 'splash.mp4';

const CORE = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'board.js',
  'rules.js',
  'bot.js',
  'cards.js',
  'clean.js',
  'fb.js',
  'discord.js',
  'discord-config.js',
  'render.js',
  'render-fx.js',
  'fireworks.js',
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
const ART = [
  ...['wood', 'brick', 'sheep', 'wheat', 'ore', 'desert'].map((n) => `art/${n}.jpg`),
  // The two award cards. Precached with the terrain rather than fetched when an award
  // changes hands: that moment is two seconds long, and a card that arrives after it has
  // finished is worse than one that was never shown.
  'art/longest-road.png',
  'art/largest-army.png',
  ...['knight', 'road', 'plenty', 'mono', 'vp'].map((k) => `art/dev-${k}.webp`),
  // The banner on the landing page, which is the first thing drawn on every launch.
  'art/logo.webp',
];

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

/**
 * The launch video, from its own cache, with byte-range support.
 *
 * A <video> asks for the file in ranges, and Safari will not play one a service worker
 * answers with a plain 200 for a range request — so a cached copy has to be cut up and
 * sent back as a 206 itself. The first time through it is fetched whole and kept.
 */
async function serveSplash(request) {
  const cache = await caches.open(SPLASH_CACHE);
  let res = await cache.match(SPLASH_FILE);
  if (!res) {
    try {
      res = await fetch(SPLASH_FILE);
      if (res.ok) await cache.put(SPLASH_FILE, res.clone());
    } catch { return new Response('', { status: 504 }); }
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (!range) return res;
  const buf = await res.arrayBuffer();
  const size = buf.byteLength;
  let start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
  let end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
  if (!(start <= end) || start >= size) {
    return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    },
  });
}

self.addEventListener('install', (e) => {
  // Fetched once into its own cache if it is not there already, so the next launch does
  // not wait on the network for it. Failure is fine: serveSplash tries again on demand.
  e.waitUntil(
    caches.open(SPLASH_CACHE)
      .then((c) => c.match(SPLASH_FILE).then((hit) => hit || fetch(SPLASH_FILE).then((r) => (r.ok ? c.put(SPLASH_FILE, r) : null))))
      .catch(() => null)
  );
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
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SPLASH_CACHE).map((k) => caches.delete(k))))
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
  if (url.pathname.endsWith(`/${SPLASH_FILE}`)) { e.respondWith(serveSplash(e.request)); return; }
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        const copy = res.clone();
        // Kept alive with waitUntil — otherwise the worker can be killed the instant
        // res reaches the page, silently dropping this write before it lands.
        e.waitUntil(caches.open(CACHE).then((c) => c.put(e.request, copy)));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then((hit) => hit || caches.match('index.html')))
  );
});
