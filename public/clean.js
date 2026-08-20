// Keeping the chat civil.
//
// Where this can and cannot work, stated plainly, because it changes what the code
// should try to be. There is no server: the app talks to Firestore directly, so anybody
// with devtools open can write whatever they like into the chat collection. A filter
// here cannot make it impossible to send a word. What it can do is make it impossible to
// send one by accident or in temper through the app, and make sure that a message which
// got in some other way is not shown to anybody. So it runs twice — once before a
// message goes, and again on every message that arrives — and the second pass is the one
// that actually protects the table.
//
// The hard part is not the list. It is that "ass" is in "class", "cunt" is in
// "Scunthorpe", and "cock" is in "cockpit" — and that anybody determined writes it as
// f.u.c.k or fuuuck or f0ck anyway. Those two pressures pull in opposite directions:
// normalise hard enough to catch the second and you start catching the first.
//
// So there are two lists and a normaliser for each.
//
//   HARD  words that essentially never appear inside an innocent English word. These are
//         matched on text put through the full normaliser — separators stripped, digits
//         and symbols folded back to letters, runs of a letter collapsed — so f.u.c.k,
//         f u c k, fuuuuck, f0ck and ƒuck all land on the same string.
//
//   SOFT  words that DO appear inside innocent words. These are matched only on whole
//         words in lightly-normalised text, so "class" and "assassin" and "Scunthorpe"
//         and "cockpit" all survive, and the cost is that the milder end of the list can
//         be smuggled through by writing it oddly. That is the right trade: a filter
//         that renames Scunthorpe is a worse bug than one that misses "a55".
//
// An allowlist runs before either, for the handful of real words that survive the full
// normaliser and would otherwise be caught anyway.

/** Real words that the aggressive normaliser would otherwise mangle into a match. */
const ALLOW = [
  'class', 'classes', 'classic', 'pass', 'passes', 'passed', 'password', 'grass', 'brass',
  'bass', 'mass', 'massive', 'glass', 'assess', 'assessment', 'asset', 'assets', 'assign',
  'assist', 'assistant', 'associate', 'assume', 'assure', 'assassin', 'embassy', 'compass',
  'canvass', 'harass', 'molasses', 'potassium',
  'scunthorpe', 'penistone', 'lightwater', 'clitheroe', 'sussex', 'essex', 'middlesex',
  'cockpit', 'cocktail', 'cockney', 'peacock', 'shuttlecock', 'cockroach', 'weathercock',
  'analysis', 'analyse', 'analyze', 'analyst', 'analytical', 'canal', 'banal',
  'shiitake', 'shih', 'title', 'titles', 'constitute', 'constitution', 'substitute',
  'hellenic', 'hello', 'shell', 'shelled', 'shelter', 'michelle', 'othello',
  'dammit', 'dam', 'dams', 'damage', 'damascus', 'amsterdam',
  'butter', 'button', 'buttons', 'butte', 'rebut', 'halibut', 'debut',
  'document', 'documents', 'circumstance', 'cumin', 'cumulative', 'accumulate',
  'hitachi', 'twittering', 'twitch',
];

/**
 * Words matched on the fully normalised string.
 *
 * Everything here is a word whose letters, once separators and lookalikes are folded
 * away, do not turn up inside ordinary English. Kept deliberately short: every entry is
 * a promise that it cannot collide with a real word, and a long list is a list nobody
 * has checked that promise for.
 */
const HARD = [
  'fuck', 'motherfucker', 'fucker', 'fucking', 'shit', 'bullshit', 'shitty',
  'cunt', 'bitch', 'bitches', 'bastard', 'wanker', 'wank', 'bollocks', 'bugger',
  'prick', 'twat', 'slut', 'whore', 'dickhead', 'asshole', 'arsehole', 'arse',
  'nigger', 'nigga', 'faggot', 'fag', 'retard', 'retarded', 'spastic', 'chink',
  'paki', 'wetback', 'tranny', 'dyke', 'kike', 'gook', 'coon', 'raghead',
  'pussy', 'cocksucker', 'jizz', 'wtf', 'stfu',
  // Common spellings that are not the word with a letter swapped but a word of their
  // own. Each checked against English the same way the rest were: no ordinary word puts
  // these letters next to each other. 'fuc' is deliberately NOT here — fuchsia.
  'phuck', 'fuk', 'fck', 'fkn',
  // The -ass compounds. Each is a whole word in its own right, so none can turn up inside
  // an innocent one — and "Bad Assistant" survives because the allowlist takes 'assistant'
  // out of the haystack before the hard list ever sees it.
  'asshat', 'dumbass', 'jackass', 'smartass', 'badass', 'fatass', 'asswipe',
];

/**
 * Words matched only as whole words, lightly normalised.
 *
 * Each of these lives inside a perfectly ordinary word, so hunting for them in a string
 * with the separators taken out is how a filter ends up refusing "classic".
 */
const SOFT = [
  'ass', 'asses', 'damn', 'goddamn', 'hell', 'crap', 'crappy', 'piss', 'pissed',
  'dick', 'cock', 'tits', 'boobs', 'bloody', 'bugger', 'git', 'sod', 'wang',
];

/** Digits and symbols people use for letters, and the letters they stand in for. */
const LOOKALIKE = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'i', '+': 't', '(': 'c', '<': 'c', '£': 'l',
};

/** Strip accents, fold lookalikes, lowercase. The gentle pass. */
function soften(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[013456789@$!|+(<£]/g, (c) => LOOKALIKE[c] || c);
}

/**
 * The gentle pass, then everything that is not a letter removed and runs of the same
 * letter collapsed to one.
 *
 * Collapsing runs is what catches "fuuuck", and it is also why this pass cannot be used
 * for the short words: it turns "pass" into "pas" and "bootie" into "botie", and a list
 * checked against collapsed text has to be checked collapsed too.
 */
function harden(text) {
  return soften(text).replace(/[^a-z]/g, '').replace(/([a-z])\1+/g, '$1');
}

const collapse = (w) => w.replace(/([a-z])\1+/g, '$1');
const HARD_COLLAPSED = HARD.map(collapse);
const ALLOW_COLLAPSED = ALLOW.map(collapse);

/**
 * Is there anything in here that should not be said?
 *
 * Returns the offending word, or null. The word is returned rather than a boolean so the
 * interface can say which one it objected to, which is the difference between a rule and
 * a mystery.
 */
export function findBadWord(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;

  const soft = soften(raw);
  const words = soft.split(/[^a-z]+/).filter(Boolean);

  // Anything that is a real word is a real word, whatever it contains.
  const innocent = new Set(words.filter((w) => ALLOW.includes(w)));

  // Whole-word matches first: cheap, and no risk of a false positive by construction.
  for (const w of words) {
    if (innocent.has(w)) continue;
    if (SOFT.includes(w) || HARD.includes(w)) return w;
  }

  // Then the hard list against the squeezed string, which is where the disguises land.
  // Words the allowlist vouched for are cut out of it first, or "classic" would put
  // "clasic" in the haystack and any list entry hiding in it would match.
  let hay = harden(raw);
  for (const ok of ALLOW_COLLAPSED) hay = hay.split(ok).join(' ');
  for (const [i, bad] of HARD_COLLAPSED.entries()) {
    if (bad.length >= 4 && hay.includes(bad)) return HARD[i];
  }
  return null;
}

/** Convenience: true when the text is fit to send. */
export const isClean = (text) => findBadWord(text) === null;

/**
 * Replace anything objectionable with asterisks, keeping the shape of the message.
 *
 * Used on the way IN, on every message the room hands us, because the check at the
 * sending end only binds people using the app as written. A message that arrived some
 * other way still has to be safe to put on somebody's screen.
 */
export function maskText(text) {
  const raw = String(text || '');
  return raw.replace(/[a-zA-Z0-9@$!|+(<£']+/g, (word) => (findBadWord(word) ? '*'.repeat(word.length) : word));
}

export const LISTS = { HARD, SOFT, ALLOW };
