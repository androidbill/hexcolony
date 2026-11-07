// Keeping a player's profile safe across phones: a secret restore code, the payload that
// is saved under it, and the file export. Storage is passed in so this runs in Node too.
//
// What travels: level and XP, achievements, challenges, game history (without replays),
// and the style choices. Nothing about a live game, and no password of any kind.

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I/L
export const CODE_KEY = 'hexcolony_savecode';
export const HISTORY_CAP = 100;
const SKIN_KINDS = ['dice', 'piece', 'robber'];

/** 16 random characters (about 80 bits), shown as XXXX-XXXX-XXXX-XXXX. */
export function newCode(rand = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = rand(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

export const pretty = (code) => String(code).match(/.{1,4}/g)?.join('-') || '';

/** What someone typed, back to the bare 16 characters; null when it cannot be a code. */
export function normalise(text) {
  const s = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 16 && [...s].every((ch) => ALPHABET.includes(ch)) ? s : null;
}

const read = (store, key, fallback) => {
  try { const v = JSON.parse(store.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; }
};

/** Everything worth keeping, as one plain object. */
export function gather(store) {
  const skins = {};
  for (const k of SKIN_KINDS) skins[k] = store.getItem(`hexcolony_skin_${k}`) || 'classic';
  const history = read(store, 'hexcolony_history', [])
    .slice(0, HISTORY_CAP)
    .map((h) => { const { replay, ...rest } = h; return rest; });
  return {
    v: 1,
    saved: Date.now(),
    profile: read(store, 'hexcolony_profile', null),
    history,
    skins,
    colour: store.getItem('hexcolony_color'),
    name: store.getItem('hexcolony_name'),
  };
}

/** Is this a payload this build understands? */
export function valid(p) {
  return !!p && typeof p === 'object' && p.v === 1
    && (p.profile === null || (typeof p.profile === 'object' && Number.isFinite(p.profile.xp)))
    && Array.isArray(p.history);
}

/**
 * Put a payload onto this device. The better of the two profiles wins (more XP), game
 * history from both is merged, and the style choices come from the payload.
 * Returns what changed, for a message.
 */
export function apply(store, p) {
  const mine = read(store, 'hexcolony_profile', null);
  const theirs = p.profile;
  let profile = theirs || mine;
  if (mine && theirs) {
    profile = {
      ...(mine.xp > theirs.xp ? mine : theirs),
      // Never lose an achievement or challenge either side had earned.
      ach: { ...theirs.ach, ...mine.ach },
      challenges: { ...theirs.challenges, ...mine.challenges },
    };
  }
  if (profile) store.setItem('hexcolony_profile', JSON.stringify(profile));

  const have = read(store, 'hexcolony_history', []);
  const seen = new Set(have.map((h) => h.id));
  const merged = [...have, ...p.history.filter((h) => !seen.has(h.id))]
    .sort((a, b) => (b.at || 0) - (a.at || 0))
    .slice(0, HISTORY_CAP);
  store.setItem('hexcolony_history', JSON.stringify(merged));

  for (const k of SKIN_KINDS) if (p.skins?.[k]) store.setItem(`hexcolony_skin_${k}`, p.skins[k]);
  if (p.colour !== null && p.colour !== undefined && !store.getItem('hexcolony_color')) store.setItem('hexcolony_color', p.colour);
  if (p.name && !store.getItem('hexcolony_name')) store.setItem('hexcolony_name', p.name);
  return { xp: profile?.xp || 0, games: merged.length };
}
