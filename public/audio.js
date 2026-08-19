// HexColony sound.
//
// Every effect is synthesised at play time — no audio files, nothing to download, and it
// still works with no connection at all. That is the constraint; within it the aim is
// for the game to sound like a board game on a table rather than like a phone.
//
// Three things do most of that work:
//
//   * a shared output chain, so sounds sit in one space instead of arriving dry and
//     separate — a compressor keeps a stacked chord from clipping, and a short
//     synthesised room stops every note sounding like a test tone;
//   * real envelopes, so notes are plucked and knocks are struck rather than switched
//     on and off;
//   * a pentatonic scale for everything musical, so two cues landing together — a
//     payout while somebody else's turn arrives — can never sound wrong.
//
// The dice are the one sound built to imitate something specific, and they are worth the
// detail: a die roll is not a noise burst, it is a scatter of little wooden knocks that
// slows down and then stops. See `sfx.dice`.

let ctx = null;
let master = null;
let roomSend = null;
let noiseBuf = null;
let enabled = localStorage.getItem('hexcolony_sound') !== 'off';

export function soundEnabled() { return enabled; }
export function setSound(on) {
  enabled = !!on;
  localStorage.setItem('hexcolony_sound', enabled ? 'on' : 'off');
}

/** Two seconds of white noise, made once and re-used by every knock and riffle. */
function makeNoise() {
  const n = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/**
 * A small room, as a decaying noise impulse.
 *
 * Short on purpose — long enough to stop notes sounding like they were generated, short
 * enough that a quick sequence does not turn to mush. Stereo, with the two channels
 * decorrelated, so it widens rather than just blurring.
 */
function makeRoom(seconds = 0.55) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      d[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2.6;
    }
  }
  return buf;
}

/** Browsers only allow audio to start inside a gesture; safe to call repeatedly. */
export function unlock() {
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();

      master = ctx.createGain();
      master.gain.value = 0.85;

      // Catches the moments when several voices land at once — a win fanfare over a
      // payout — instead of letting them add up into distortion.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 22;
      comp.ratio.value = 5;
      comp.attack.value = 0.004;
      comp.release.value = 0.18;
      master.connect(comp).connect(ctx.destination);

      const conv = ctx.createConvolver();
      conv.buffer = makeRoom();
      roomSend = ctx.createGain();
      roomSend.gain.value = 0.5;
      roomSend.connect(conv).connect(master);

      noiseBuf = makeNoise();
    }
    if (ctx.state === 'suspended') ctx.resume();
  } catch { /* no audio on this device — everything below degrades to silence */ }
}

/** A panner, or a plain gain where StereoPannerNode is missing (older Safari). */
function panner(pan) {
  if (!pan || typeof ctx.createStereoPanner !== 'function') return ctx.createGain();
  const p = ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  return p;
}

function route(source, { vol, delay, dur, attack, pan, room }) {
  const t0 = ctx.currentTime + delay;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  const out = panner(pan);
  source.connect(g).connect(out);
  out.connect(master);
  if (room) {
    const s = ctx.createGain();
    s.gain.value = room;
    g.connect(s);
    s.connect(roomSend);
  }
  return t0;
}

/**
 * One plucked note.
 *
 * `to` glides the pitch, which is what turns a note into a whoop or a drop. `swell`
 * lengthens the attack for anything that should arrive rather than be struck.
 */
function note(freq, opts = {}) {
  if (!enabled) return;
  try {
    unlock();
    if (!ctx) return;
    const {
      to = 0, type = 'triangle', dur = 0.18, vol = 0.2, delay = 0,
      attack = 0.006, cutoff = 0, pan = 0, room = 0.16, detune = 0,
    } = opts;

    const o = ctx.createOscillator();
    o.type = type;
    let tail = o;
    if (cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = cutoff;
      o.connect(f);
      tail = f;
    }
    const t0 = route(tail, { vol, delay, dur, attack, pan, room });
    o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    if (detune) o.detune.setValueAtTime(detune, t0);
    o.start(t0);
    o.stop(t0 + dur + 0.06);
  } catch { /* fine */ }
}

/** Two notes a whisker apart. The beating between them is what stops a cue sounding thin. */
function fat(freq, opts = {}) {
  note(freq, opts);
  note(freq, { ...opts, detune: 7, vol: (opts.vol ?? 0.2) * 0.55, room: 0 });
}

/** A shaped burst of noise: the raw material for knocks, riffles and whooshes. */
function burst(opts = {}) {
  if (!enabled) return;
  try {
    unlock();
    if (!ctx) return;
    const {
      dur = 0.1, vol = 0.2, delay = 0, freq = 1400, q = 4,
      type = 'bandpass', pan = 0, room = 0.1, attack = 0.002, rate = 1,
    } = opts;

    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = rate;
    // A random offset into the shared buffer, so ten knocks in a row are ten different
    // knocks rather than the same click ten times.
    const off = Math.random() * 1.5;

    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    src.connect(f);

    const t0 = route(f, { vol, delay, dur, attack, pan, room });
    src.start(t0, off, dur + 0.05);
  } catch { /* fine */ }
}

/**
 * Wood on wood: a tuned tick with a thump underneath.
 *
 * A bandpass with a high Q rings at its centre frequency, which is what gives a noise
 * burst a pitch and makes it read as a solid object rather than as static.
 */
function knock(delay, vol, freq, pan = 0) {
  burst({ delay, dur: 0.05, vol: vol * 0.95, freq, q: 7, pan, room: 0.12 });
  note(freq * 0.26, { delay, dur: 0.055, vol: vol * 0.45, type: 'sine', pan, room: 0.06 });
}

// A major pentatonic, so nothing can clash with anything else.
const C5 = 523, D5 = 587, E5 = 659, G5 = 784, A5 = 880;
const C6 = 1047, D6 = 1175, E6 = 1319, G6 = 1568;
const C4 = 262, G4 = 392, E4 = 330;

const synth = {
  tap: () => note(A5, { dur: 0.045, vol: 0.09, type: 'sine', room: 0.05 }),

  /**
   * Dice.
   *
   * The shape of a real roll is the whole point: a rattle as they leave the hand, a
   * scatter of knocks that slows as the dice lose energy, then two heavier landings as
   * each one settles. The gap between knocks grows by a fixed ratio, which is what makes
   * it decelerate rather than just stop; the pitch, level and stereo position of every
   * knock are randomised, so no two rolls sound the same and none sounds like a loop.
   */
  dice: () => {
    burst({ dur: 0.2, vol: 0.09, freq: 3400, q: 0.7, attack: 0.09, room: 0.2 });
    let t = 0.05;
    let gap = 0.03;
    for (let i = 0; i < 10; i++) {
      const fade = 1 - (i / 10) * 0.4;
      knock(t, (0.15 + Math.random() * 0.06) * fade, 620 + Math.random() * 1500,
        (Math.random() * 2 - 1) * 0.75);
      t += gap;
      gap *= 1.16;
    }
    knock(t + 0.04, 0.3, 560, -0.3);
    knock(t + 0.15, 0.26, 470, 0.3);
  },

  // A settlement goes down with a knock and comes up in tune.
  build: () => {
    knock(0, 0.22, 900);
    fat(G5, { delay: 0.05, dur: 0.16, vol: 0.16 });
    fat(C6, { delay: 0.12, dur: 0.26, vol: 0.16 });
  },

  // Bigger building, bigger arpeggio, with a bass note under it.
  city: () => {
    knock(0, 0.24, 700);
    note(C4, { delay: 0.02, dur: 0.3, vol: 0.16, type: 'sine' });
    [C5, E5, G5, C6].forEach((f, i) => fat(f, { delay: 0.05 + i * 0.06, dur: 0.24, vol: 0.15 }));
  },

  road: () => {
    knock(0, 0.2, 520);
    note(G4, { delay: 0.03, dur: 0.12, vol: 0.12, type: 'triangle' });
  },

  // Paper: a riffle rather than a click.
  card: () => {
    burst({ dur: 0.09, vol: 0.13, freq: 4200, q: 0.8, type: 'highpass', room: 0.08 });
    burst({ delay: 0.05, dur: 0.07, vol: 0.09, freq: 5200, q: 0.8, type: 'highpass' });
    note(D6, { delay: 0.06, dur: 0.1, vol: 0.1, type: 'sine' });
  },

  // Two cards crossing the table: one line up, one down, at the same time.
  trade: () => {
    note(E5, { to: A5, dur: 0.2, vol: 0.15, pan: -0.4 });
    note(A5, { to: E5, dur: 0.2, vol: 0.15, pan: 0.4 });
    fat(C6, { delay: 0.16, dur: 0.24, vol: 0.15 });
  },

  // Coins. Bright, fast, and the reason a payout feels worth having.
  gain: () => {
    fat(E6, { dur: 0.09, vol: 0.15 });
    fat(G6, { delay: 0.07, dur: 0.26, vol: 0.15 });
  },

  // Menacing, but played for fun rather than for dread: a slither down, then footsteps.
  robber: () => {
    note(320, { to: 90, dur: 0.42, vol: 0.16, type: 'sawtooth', cutoff: 900, room: 0.3 });
    note(110, { delay: 0.18, dur: 0.14, vol: 0.18, type: 'square', cutoff: 700 });
    note(98, { delay: 0.32, dur: 0.18, vol: 0.16, type: 'square', cutoff: 600 });
  },

  // A card whipped out of a hand.
  steal: () => {
    burst({ dur: 0.14, vol: 0.16, freq: 2600, q: 1.2, attack: 0.05, room: 0.15 });
    note(A5, { to: E4, dur: 0.22, vol: 0.16, type: 'triangle' });
  },

  // Your turn: a little three-note call, with the root underneath.
  yourTurn: () => {
    note(C4, { dur: 0.34, vol: 0.14, type: 'sine' });
    [G5, C6, E6].forEach((f, i) => fat(f, { delay: i * 0.09, dur: 0.26, vol: 0.17 }));
  },

  // Wrong, without being unpleasant — it fires on ordinary mistakes.
  error: () => {
    note(220, { dur: 0.09, vol: 0.14, type: 'square', cutoff: 1200 });
    note(165, { delay: 0.1, dur: 0.16, vol: 0.14, type: 'square', cutoff: 1000 });
  },

  win: () => {
    note(C4, { dur: 0.9, vol: 0.16, type: 'sine', room: 0.4 });
    [C5, E5, G5, C6, E6].forEach((f, i) => fat(f, { delay: i * 0.1, dur: 0.34, vol: 0.18, room: 0.3 }));
    [C6, E6, G6].forEach((f) => fat(f, { delay: 0.56, dur: 0.9, vol: 0.14, room: 0.45 }));
  },

  // Losing gets a shrug, not a funeral.
  lose: () => {
    [A5, G5, E5].forEach((f, i) => note(f, { delay: i * 0.13, dur: 0.3, vol: 0.15, type: 'triangle' }));
    note(C5, { to: 175, delay: 0.4, dur: 0.5, vol: 0.16, type: 'triangle', room: 0.3 });
  },

  join: () => {
    fat(G5, { dur: 0.1, vol: 0.14 });
    fat(D6, { delay: 0.08, dur: 0.22, vol: 0.14 });
  },
};

// ---------------------------------------------------------------- recorded sounds
//
// Anything in public/sfx/ takes over from the synthesised version of the same name. This
// is the whole point of the arrangement: real recordings beat synthesis for the sounds
// that imitate an object — dice on a table above all — while synthesis stays perfectly
// good for the abstract ones, and neither has to be finished before the other is useful.
//
// public/sfx/index.json lists what is actually there, so a game with no recordings makes
// one small request rather than a 404 for every effect. A file that fails to load, or a
// device that cannot decode it, silently keeps the synthesised sound: there is no state
// in which the game goes quiet because a download failed.
//
// Playback goes through the same master chain as everything else, so recordings from
// different sources still land in one space and at one level.

const samples = new Map();       // name -> AudioBuffer
let samplesAsked = false;

async function loadSamples() {
  if (samplesAsked || !ctx) return;
  samplesAsked = true;
  try {
    const res = await fetch('sfx/index.json', { cache: 'no-cache' });
    if (!res.ok) return;                       // no recordings in this build
    const list = await res.json();

    // Either ["dice", "gain"] or { "dice": { file: "dice.mp3", gain: 0.8 } }.
    const entries = Array.isArray(list)
      ? list.map((name) => [name, {}])
      : Object.entries(list).map(([name, v]) => [name, typeof v === 'string' ? { file: v } : (v || {})]);

    await Promise.all(entries.map(async ([name, cfg]) => {
      if (!(name in synth)) return;            // not a sound this game plays
      try {
        const file = cfg.file || `${name}.mp3`;
        const r = await fetch(`sfx/${file}`);
        if (!r.ok) return;
        const buf = await ctx.decodeAudioData(await r.arrayBuffer());
        samples.set(name, {
          buf,
          gain: Number.isFinite(cfg.gain) ? cfg.gain : 1,
          room: cfg.room ?? 0.1,
          // Generators export fixed-length clips, so a half-second effect can arrive in a
          // two-second file. `offset` and `trim` play the part that matters and leave the
          // padding alone — no re-encoding, no tools, one number in index.json.
          offset: Number.isFinite(cfg.offset) ? Math.max(0, cfg.offset) : 0,
          trim: Number.isFinite(cfg.trim) ? Math.max(0.02, cfg.trim) : 0,
        });
      } catch { /* this one stays synthesised */ }
    }));
  } catch { /* offline, or no index — synthesis covers everything */ }
}

/** Play the recording for `name`. False means there isn't one, so the caller synthesises. */
function playSample(name) {
  const s = samples.get(name);
  if (!s || !ctx) return false;
  try {
    const src = ctx.createBufferSource();
    src.buffer = s.buf;
    const g = ctx.createGain();
    g.gain.value = s.gain;
    src.connect(g).connect(master);
    if (s.room) {
      const send = ctx.createGain();
      send.gain.value = s.room;
      g.connect(send);
      send.connect(roomSend);
    }
    if (s.trim) {
      // A hard stop clicks. Fade the last 30ms instead.
      const end = ctx.currentTime + s.trim;
      g.gain.setValueAtTime(s.gain, Math.max(ctx.currentTime, end - 0.03));
      g.gain.linearRampToValueAtTime(0.0001, end);
      src.start(0, s.offset, s.trim);
    } else {
      src.start(0, s.offset);
    }
    return true;
  } catch { return false; }
}

/**
 * Every effect, recorded where a recording exists and synthesised where it does not.
 * Callers never know which they got.
 */
export const sfx = Object.fromEntries(Object.keys(synth).map((name) => [name, () => {
  if (!enabled) return;
  unlock();
  loadSamples();
  if (!playSample(name)) synth[name]();
}]));

export function buzz(pattern) {
  if (localStorage.getItem('hexcolony_haptics') === 'off') return;
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* fine */ }
}
