// Delete finished HexColony rooms that have been kept for inspection long enough.
//
// A game that ends is no longer deleted when its last player leaves: it stays in the
// Realtime Database so a bug report can be checked against the real game. Nothing in the
// app removes them afterwards (the database rules only allow reading a room by its code),
// so this finds them by trying every room-code word.
//
//   node scripts/sweep-archived-rooms.mjs                  # list rooms and their age
//   node scripts/sweep-archived-rooms.mjs --delete         # delete finished rooms older than 24h
//   node scripts/sweep-archived-rooms.mjs --delete --hours=72
import { WORD_CODES } from '../public/wordcodes.js';

const DB = 'https://catanx-6644-default-rtdb.firebaseio.com';
const args = process.argv.slice(2);
const DELETE = args.includes('--delete');
const hours = Number((args.find((a) => a.startsWith('--hours=')) || '--hours=24').split('=')[1]);
const words = WORD_CODES.filter((w) => w.length === 4);
const found = [];
let i = 0;

async function worker() {
  while (i < words.length) {
    const code = `R${words[i++]}`;
    try {
      const j = await (await fetch(`${DB}/rooms/${code}.json?shallow=true`)).json();
      if (j && !j.error) found.push(code);
    } catch { /* skip */ }
  }
}
await Promise.all(Array.from({ length: 24 }, worker));

let removed = 0;
for (const code of found.sort()) {
  const r = await (await fetch(`${DB}/rooms/${code}.json`)).json();
  const ended = typeof r?.endedAt === 'number' ? r.endedAt : null;
  const ageH = ended ? (Date.now() - ended) / 3600000 : null;
  const names = Object.values(r?.players || {}).map((p) => p.name).join(',');
  const old = r?.state === 'over' && ageH !== null && ageH > hours;
  console.log(`${code} ${r?.state} ${names} ${ageH === null ? '' : `${ageH.toFixed(1)}h`}${old ? '  <- old' : ''}`);
  if (DELETE && old) { await fetch(`${DB}/rooms/${code}.json`, { method: 'DELETE' }); removed++; }
}
console.log(DELETE ? `${removed} deleted` : 'Dry run — add --delete to remove the old ones.');
