// Tests for the chat filter.
// Run with:  node scripts/clean-tests.mjs   (or npm test, which runs both suites)
//
// Two halves, and the first one is the important one. Anybody can lengthen a word list;
// the way a filter like this fails in the wild is by refusing "classic" and "Scunthorpe"
// and telling a player they swore when they did not. So the false-positive cases come
// first and outnumber the rest.

import { findBadWord, maskText } from '../public/clean.js';

let passed = 0;
const failures = [];
const t = (text, shouldBlock, note = '') => {
  const hit = findBadWord(text);
  const ok = shouldBlock ? hit !== null : hit === null;
  if (ok) { passed += 1; return; }
  failures.push(shouldBlock
    ? `should have blocked ${JSON.stringify(text)}${note ? ' — ' + note : ''}`
    : `wrongly blocked ${JSON.stringify(text)} as "${hit}"${note ? ' — ' + note : ''}`);
};

// ---------------------------------------------------------------- must not block
// Ordinary things people type at a board game, plus the classic false positives every
// naive filter trips over.
for (const s of [
  'good game', 'nice roll', 'I need wheat', 'anyone got ore?', 'pass me a sheep',
  'gg everyone', 'unlucky', 'well played', 'I am one point away',

  // the Scunthorpe family
  'that was a classic move', 'my class starts soon', 'I will pass', 'the grass tile',
  'assign me the ore port', 'I assume you want brick', 'assist me', 'assassin',
  'assess the board', 'my assets', 'password', 'massive', 'compass', 'brass', 'glass',
  'I am from Scunthorpe', 'we drove through Sussex', 'Essex', 'Penistone', 'Clitheroe',
  'check the cockpit', 'a cocktail', 'shuttlecock', 'peacock', 'cockroach', 'Cockney',
  'analysis of the board', 'lets analyse', 'the canal', 'that is banal',
  'hello there', 'shell company', 'Michelle', 'Othello', 'shelter',
  'Amsterdam', 'damage report', 'the dam', 'Damascus',
  'document that', 'circumstance', 'accumulate ore', 'cumin',
  'butter', 'button', 'debut', 'halibut', 'the title', 'substitute', 'constitution',
]) t(s, false);

// ---------------------------------------------------------------- must block
for (const s of [
  'fuck', 'you are a bitch', 'this is shit', 'what an asshole', 'bastard', 'twat',
]) t(s, true);

// Disguises: separators, repeats, leetspeak, case.
for (const s of [
  'f.u.c.k', 'f u c k', 'fuuuuck', 'fu*ck', 'F-U-C-K', 'f_u_c_k',
  'sh1t', 's h i t', '$hit', 'shiiit', 'b1tch', 'a$$hole', 'c u n t', 'phuck', 'fck', 'fuk',
]) t(s, true);

// The milder end, on its own rather than inside a word.
for (const s of ['damn', 'what the hell', 'hell of a game', 'that is crap', 'piss off']) {
  t(s, true);
}

// ---------------------------------------------------------------- masking
// What a message that got in some other way looks like once it is on screen.
const masks = [
  ['you fuck', 'you ****'],
  ['nice game everyone', 'nice game everyone'],
  ['that is shit but ok', 'that is **** but ok'],
  ['classic move', 'classic move'],
];
for (const [input, want] of masks) {
  const got = maskText(input);
  if (got === want) passed += 1;
  else failures.push(`mask ${JSON.stringify(input)} gave ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

// A known and accepted limit, asserted so it cannot change without somebody noticing.
// A digit standing in for a DIFFERENT vowel — f0ck for fuck — is not caught, because
// catching it needs fuzzy matching and fuzzy matching is what starts refusing real
// words. The mask on the way in is what covers this, not the list.
if (findBadWord('f0ck') === null) passed += 1;
else failures.push('f0ck is now caught — good, but update the note in clean.js that says it is not');

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL  ' + f);
process.exit(failures.length ? 1 : 0);
