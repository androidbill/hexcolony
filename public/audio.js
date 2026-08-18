// HexColony sound. Every effect is synthesised from oscillators at play time — no audio
// files, nothing to download, and the whole module is under a hundred lines.

let ctx = null;
let enabled = localStorage.getItem('hexcolony_sound') !== 'off';

export function soundEnabled() { return enabled; }
export function setSound(on) {
  enabled = !!on;
  localStorage.setItem('hexcolony_sound', enabled ? 'on' : 'off');
}

// Browsers only allow audio to start inside a gesture, so this is called from the
// first tap and is safe to call repeatedly afterwards.
export function unlock() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { /* device has no audio — everything below degrades to silence */ }
}

function tone(freq, dur = 0.12, vol = 0.22, type = 'triangle', delay = 0) {
  if (!enabled) return;
  try {
    unlock();
    if (!ctx) return;
    const t0 = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  } catch { /* fine */ }
}

function noise(dur = 0.2, vol = 0.18, hp = 800) {
  if (!enabled) return;
  try {
    unlock();
    if (!ctx) return;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(ctx.destination);
    src.start();
  } catch { /* fine */ }
}

export const sfx = {
  tap:      () => tone(660, 0.05, 0.12, 'sine'),
  // Dice are two wooden knocks and a scatter of noise.
  dice:     () => { noise(0.26, 0.14, 1200); tone(180, 0.06, 0.18, 'square'); tone(150, 0.06, 0.16, 'square', 0.09); },
  build:    () => { tone(392, 0.09, 0.2); tone(587, 0.14, 0.2, 'triangle', 0.07); },
  city:     () => { [392, 523, 659].forEach((f, i) => tone(f, 0.14, 0.2, 'triangle', i * 0.07)); },
  road:     () => tone(330, 0.09, 0.18, 'square'),
  card:     () => { noise(0.12, 0.10, 2200); tone(880, 0.06, 0.10, 'sine', 0.03); },
  trade:    () => { tone(523, 0.09, 0.18); tone(784, 0.12, 0.18, 'triangle', 0.08); },
  // The robber gets a low, unwelcome pair of notes.
  robber:   () => { tone(150, 0.20, 0.24, 'sawtooth'); tone(110, 0.30, 0.22, 'sawtooth', 0.14); },
  steal:    () => { tone(300, 0.08, 0.18, 'sawtooth'); tone(200, 0.14, 0.18, 'sawtooth', 0.07); },
  gain:     () => { tone(659, 0.08, 0.16, 'sine'); tone(988, 0.10, 0.14, 'sine', 0.06); },
  yourTurn: () => { tone(523, 0.10, 0.20); tone(659, 0.10, 0.20, 'triangle', 0.10); tone(784, 0.18, 0.20, 'triangle', 0.20); },
  error:    () => tone(160, 0.16, 0.18, 'sawtooth'),
  win:      () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.26, 0.22, 'triangle', i * 0.11)),
  lose:     () => [440, 392, 330, 262].forEach((f, i) => tone(f, 0.24, 0.18, 'triangle', i * 0.13)),
  join:     () => { tone(587, 0.08, 0.16, 'sine'); tone(880, 0.12, 0.14, 'sine', 0.07); },
};

export function buzz(pattern) {
  if (localStorage.getItem('hexcolony_haptics') === 'off') return;
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch { /* fine */ }
}
