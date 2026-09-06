// App-shell cache only. Trivia questions and Firebase traffic always go to the network —
// caching those would let a player answer a stale question or lose sync with their room.
const CACHE = 'xtrivia-shell-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './fb.js',
  './room.js',
  './trivia-api.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return; // let Firebase/opentdb go straight to network
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request)),
  );
});
