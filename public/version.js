// Single source of truth for the app version — bump on EVERY change (YYYY.MM.DD.NN).
// The app fetches this file fresh on open to spot a stale installed copy, and the
// service worker registration carries it as ?v= to bust its cache.
export const APP_VERSION = '2026.08.24.04';
