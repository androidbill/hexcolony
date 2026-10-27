// How long people take to play, measured on THIS device and stored only in its
// localStorage — nothing here ever reaches the database.
//
// Every device at a table sees every turn change, so every device can time the whole
// table by itself. The clock watches the game state: it charges elapsed time to whoever
// the game is currently waiting on, and starts a fresh entry when that changes.
//
// Pure functions over a plain object, so the rules can be tested in Node without a DOM.

export const CLOCK_KEY = 'hexcolony_clock';

// A phone that was asleep or closed for longer than this between two looks at the game
// has told us nothing about how long anyone thought.
const GAP_MS = 60 * 1000;
// A live table keeps moving while this phone is asleep, so the gap counts — but not
// without limit, or a phone left in a drawer would charge someone for the night.
const TABLE_CAP_MS = 10 * 60 * 1000;
// Below this a turn is an auto-skip or a bot, which says nothing about how anyone plays.
export const MIN_TURN_MS = 1000;

export function newClock(gid, now, partial) {
  return { gid, turns: [], cur: null, last: now, done: false, partial: !!partial };
}

/**
 * Look at the game once. `look` carries: gid (which game), key (which step, unique within
 * it), pid (who it is waiting on), setup (a placement turn), paused, over, solo, now.
 * Mutates and returns the clock.
 */
export function tick(clock, look) {
  const { gid, key, pid, setup, paused, over, solo, now } = look;
  if (!clock || clock.gid !== gid) clock = newClock(gid, now, look.joinedLate);
  if (clock.done) return clock;

  const gap = now - clock.last;
  let dt = 0;
  if (!paused) {
    if (gap <= GAP_MS) dt = gap;
    else if (!solo) dt = Math.min(gap, TABLE_CAP_MS);
  }
  clock.last = now;
  if (clock.cur) clock.cur.ms += dt;

  if (clock.cur && (over || clock.cur.k !== key)) {
    clock.turns.push(clock.cur);
    clock.cur = null;
  }
  if (over) { clock.done = true; return clock; }
  if (!clock.cur && pid) {
    clock.cur = { k: key, pid, s: !!setup, ms: 0 };
    // The first turn a device ever sees of a game it joined late is only partly seen.
    if (clock.partial && clock.turns.length === 0) clock.cur.part = true;
  }
  return clock;
}

export function loadClock() {
  try {
    const c = JSON.parse(localStorage.getItem(CLOCK_KEY) || 'null');
    return c && typeof c === 'object' && Array.isArray(c.turns) ? c : null;
  } catch { return null; }
}

export function saveClock(clock) {
  try { localStorage.setItem(CLOCK_KEY, JSON.stringify(clock)); }
  catch { /* timing is nice to have, never essential to play */ }
}

/**
 * One player's numbers out of a finished clock. Placement turns and partly-seen turns
 * count toward total time but not toward longest/shortest/average, which are about
 * ordinary turns.
 */
export function playerTimes(clock, pid) {
  let ms = 0, n = 0, sum = 0, max = 0, min = Infinity;
  for (const t of clock.turns) {
    if (t.pid !== pid) continue;
    ms += t.ms;
    if (t.s || t.part || t.ms < MIN_TURN_MS) continue;
    n += 1; sum += t.ms;
    if (t.ms > max) max = t.ms;
    if (t.ms < min) min = t.ms;
  }
  return { ms, n, sum, max, min: n ? min : 0 };
}

/** Everyone in the game, plus the table total. Bots are left out — they are not people. */
export function gameTimes(clock, pids) {
  const total = clock.turns.reduce((a, t) => a + t.ms, 0);
  const per = {};
  for (const pid of pids) per[pid] = playerTimes(clock, pid);
  return { total, per, partial: !!clock.partial };
}

/** 42s · 2m 05s · 1h 12m — short enough for a stat tile. */
export function fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
