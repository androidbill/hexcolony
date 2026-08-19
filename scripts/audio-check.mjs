// Drive every sound effect against a stand-in Web Audio API and check that the graph it
// builds is valid: no undefined frequencies, no non-finite gains, no exponential ramp to
// zero (which throws in a real browser), everything connected and scheduled forward.

const problems = [];
let nodeCount = 0;
let scheduled = 0;

const param = (name, initial = 0) => {
  const p = {
    _name: name,
    value: initial,
    setValueAtTime(v, t) { check(name, v, t); return p; },
    exponentialRampToValueAtTime(v, t) {
      if (v === 0) problems.push(`${name}: exponential ramp to exactly 0 throws in browsers`);
      check(name, v, t);
      return p;
    },
    linearRampToValueAtTime(v, t) { check(name, v, t); return p; },
  };
  return p;
};

function check(name, v, t) {
  if (!Number.isFinite(v)) problems.push(`${name}: value ${v}`);
  if (!Number.isFinite(t)) problems.push(`${name}: time ${t}`);
  if (t < 0) problems.push(`${name}: scheduled in the past (${t})`);
}

const node = (kind, extra = {}) => {
  nodeCount++;
  const n = {
    kind,
    _connected: false,
    connect(dst) {
      if (!dst) problems.push(`${kind}: connected to nothing`);
      n._connected = true;
      return dst;
    },
    disconnect() {},
    ...extra,
  };
  return n;
};

class FakeCtx {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 10;      // non-zero, as a real context is by the first tap
    this.state = 'running';
    this.destination = node('destination');
  }
  resume() {}
  createGain() { return node('gain', { gain: param('gain.gain', 1) }); }
  createStereoPanner() { return node('panner', { pan: param('panner.pan', 0) }); }
  createBiquadFilter() {
    return node('filter', { type: 'lowpass', frequency: param('filter.freq', 350), Q: param('filter.Q', 1) });
  }
  createConvolver() { return node('convolver', { buffer: null }); }
  createDynamicsCompressor() {
    return node('comp', {
      threshold: param('comp.threshold', -24), knee: param('comp.knee', 30),
      ratio: param('comp.ratio', 12), attack: param('comp.attack', 0.003),
      release: param('comp.release', 0.25),
    });
  }
  createOscillator() {
    return node('osc', {
      type: 'sine',
      frequency: param('osc.freq', 440),
      detune: param('osc.detune', 0),
      start(t) { scheduled++; check('osc.start', 0, t); },
      stop(t) { check('osc.stop', 0, t); },
    });
  }
  createBufferSource() {
    return node('bufsrc', {
      buffer: null,
      playbackRate: param('src.rate', 1),
      start(t, off, dur) {
        scheduled++;
        check('src.start', 0, t);
        if (off !== undefined && (!Number.isFinite(off) || off < 0)) problems.push(`src.start offset ${off}`);
        if (dur !== undefined && (!Number.isFinite(dur) || dur <= 0)) problems.push(`src.start duration ${dur}`);
      },
    });
  }
  createBuffer(ch, len, rate) {
    if (!Number.isFinite(len) || len <= 0) problems.push(`createBuffer length ${len}`);
    const data = Array.from({ length: ch }, () => new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: rate, getChannelData: (i) => data[i] };
  }
}

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = { AudioContext: FakeCtx };
Object.defineProperty(globalThis, 'navigator', { value: { vibrate: () => true }, configurable: true });

const { sfx, unlock, setSound, soundEnabled } = await import('../public/audio.js');

unlock();

for (const [name, fn] of Object.entries(sfx)) {
  const before = problems.length;
  const nodesBefore = nodeCount;
  const schedBefore = scheduled;
  try { fn(); } catch (e) { problems.push(`${name}: threw ${e.message}`); }
  const voices = scheduled - schedBefore;
  if (voices === 0) problems.push(`${name}: made no sound at all`);
  console.log(
    `  ${name.padEnd(9)} ${String(voices).padStart(2)} voices, ` +
    `${String(nodeCount - nodesBefore).padStart(3)} nodes` +
    (problems.length > before ? '   <-- PROBLEM' : '')
  );
}

// Muted really means muted.
setSound(false);
const schedMuted = scheduled;
for (const fn of Object.values(sfx)) fn();
if (scheduled !== schedMuted) problems.push('sounds still played while muted');
setSound(true);
if (!soundEnabled()) problems.push('setSound(true) did not re-enable');

console.log(`\n${scheduled} voices scheduled across ${nodeCount} nodes`);
if (problems.length) {
  console.log(`\n${problems.length} problems:`);
  for (const p of [...new Set(problems)]) console.log('  - ' + p);
  process.exit(1);
}
console.log('audio graph is valid');
