// An original piece for HexColony: Celtic-flavoured, D dorian, driving 8ths.
// Renders offline to a 16-bit stereo WAV so it can be heard without the game.
import fs from 'node:fs';

const SR = 32000;
const BPM = 120;
const EIGHTH = 60 / BPM / 2;          // seconds
const BAR = EIGHTH * 8;
const PASSES = 4;
const INTRO = 1;  // bar of drones alone
const BARS = 8 * PASSES + INTRO;
const TAIL = 4;                        // seconds of reverb ring-out
const N = Math.ceil((BARS * BAR + TAIL) * SR);
const dryL = new Float32Array(N), dryR = new Float32Array(N);
const wetL = new Float32Array(N), wetR = new Float32Array(N);

const hz = (m) => 440 * 2 ** ((m - 69) / 12);
const clamp = (x) => Math.max(-1, Math.min(1, x));

function reso(st, x, f0, Q) {
  const w = 2 * Math.PI * f0 / SR, al = Math.sin(w) / (2 * Q), c = Math.cos(w);
  const b0 = al, b2 = -al, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  const y = (b0 * x + b2 * st.x2 - a1 * st.y1 - a2 * st.y2) / a0;
  st.x2 = st.x1; st.x1 = x; st.y2 = st.y1; st.y1 = y;
  return y;
}
// One-pole low-pass helper state per voice render.
function voice({ start, dur, freq, gain, pan = 0, wave = 'saw', attack = 0.01, release = 0.08,
  cutoff = 3000, vibrato = 0, vibDelay = 0.15, decay = 0, wet = 0.3, detune = 0 }) {
  const i0 = Math.floor(start * SR);
  const len = Math.floor((dur + release) * SR);
  const a = Math.exp(-2 * Math.PI * cutoff / SR);
  let lp = 0, ph = 0, ph2 = 0;
  const st1 = { x1: 0, x2: 0, y1: 0, y2: 0 }, st2 = { x1: 0, x2: 0, y1: 0, y2: 0 };
  const gl = gain * Math.cos((pan + 1) * Math.PI / 4);
  const gr = gain * Math.sin((pan + 1) * Math.PI / 4);
  for (let k = 0; k < len; k++) {
    const i = i0 + k;
    if (i >= N) break;
    const t = k / SR;
    let env = Math.min(1, t / attack);
    if (decay) env *= Math.exp(-t * decay);
    if (t > dur) env *= Math.max(0, 1 - (t - dur) / release);
    const vib = vibrato ? Math.sin(2 * Math.PI * 5.4 * t) * vibrato * Math.min(1, Math.max(0, (t - vibDelay) / 0.3)) : 0;
    const f = freq * (1 + vib);
    ph += f / SR; ph -= Math.floor(ph);
    ph2 += f * (1 + detune) / SR; ph2 -= Math.floor(ph2);
    let s;
    if (wave === 'saw') s = (2 * ph - 1) * 0.6 + (2 * ph2 - 1) * 0.4;
    else if (wave === 'tri') s = (Math.abs(4 * ph - 2) - 1);
    else if (wave === 'reed') {
      const sq = ph < 0.42 ? 1 : -1;
      s = (2 * ph - 1) * 0.55 + sq * 0.45;
      // two vocal-ish resonances give the chanter its nasal, reedy colour
      const bp1 = reso(st1, s, 1150, 4), bp2 = reso(st2, s, 2300, 5);
      s = s * 0.5 + bp1 * 1.1 + bp2 * 0.7;
    }
    else if (wave === 'pluck') s = (2 * ph - 1) * 0.5 + (Math.abs(4 * ph2 - 2) - 1) * 0.5;
    else s = Math.sin(2 * Math.PI * ph);
    lp = (1 - a) * s + a * lp;
    const v = lp * env;
    dryL[i] += v * gl; dryR[i] += v * gr;
    wetL[i] += v * gl * wet; wetR[i] += v * gr * wet;
  }
}

function drum(start, strength, pan = 0) {
  const i0 = Math.floor(start * SR);
  const len = Math.floor(0.35 * SR);
  let ph = 0, lp = 0, seed = (start * 1000) | 0 || 1;
  for (let k = 0; k < len; k++) {
    const i = i0 + k; if (i >= N) break;
    const t = k / SR;
    const f = 52 + 60 * Math.exp(-t * 28);
    ph += f / SR;
    const tone = Math.sin(2 * Math.PI * ph) * Math.exp(-t * 11);
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = ((seed / 4294967296) * 2 - 1);
    lp = lp * 0.7 + noise * 0.3;
    const skin = lp * Math.exp(-t * 60) * 0.5;
    const v = (tone + skin) * strength;
    dryL[i] += v * (1 - pan * 0.4); dryR[i] += v * (1 + pan * 0.4);
    wetL[i] += v * 0.15; wetR[i] += v * 0.15;
  }
}

// ---- the music: A mixolydian, which is what the pipe chanter plays
const CHORDS = { A: [45, 52, 57, 61], G: [43, 50, 55, 59], D: [50, 57, 62, 66] };
const PROG = ['A', 'A', 'G', 'G', 'D', 'G', 'A', 'A'];
const BASS = { A: 33, G: 31, D: 38 };
const MEL = [
  [[0, 69, 3], [3, 73, 1], [4, 76, 2], [6, 81, 2]],
  [[0, 79, 3], [3, 76, 1], [4, 73, 4]],
  [[0, 71, 2], [2, 74, 2], [4, 79, 3], [7, 78, 1]],
  [[0, 74, 4], [4, 71, 4]],
  [[0, 78, 3], [3, 81, 1], [4, 78, 2], [6, 74, 2]],
  [[0, 74, 3], [3, 79, 1], [4, 81, 4]],
  [[0, 79, 2], [2, 78, 2], [4, 76, 2], [6, 73, 2]],
  [[0, 76, 2], [2, 73, 2], [4, 69, 4]],
];
const ARP = [0, 2, 1, 2, 3, 2, 1, 2];
const DRUM = [[0, 1.0], [3, 0.55], [4, 0.8], [6, 0.5]];
const total = (BARS * BAR);

// Drones run under everything: two bass drones an octave apart-ish and a tenor.
for (const [m, g] of [[33, 0.10], [33, 0.09], [45, 0.08]]) {
  voice({ start: 0, dur: total - 0.5, freq: hz(m), gain: g, wave: 'saw', attack: 1.2, release: 2.5, cutoff: 650, detune: 0.003, wet: 0.35 });
}

function pipeNote(t, m, dur, gain) {
  // Pipes cannot get quieter or louder: a steady reed, with a quick cut before the note.
  const cutNote = m >= 79 ? 76 : 79;
  voice({ start: t - 0.045, dur: 0.04, freq: hz(cutNote), gain: gain * 0.9, wave: 'reed', attack: 0.004, release: 0.01, cutoff: 5000, wet: 0.35 });
  voice({ start: t, dur, freq: hz(m), gain, wave: 'reed', attack: 0.008, release: 0.03, cutoff: 5000, wet: 0.35 });
}

for (let pass = 0; pass < PASSES; pass++) {
  for (let b = 0; b < 8; b++) {
    const bar = INTRO + pass * 8 + b;
    const t0 = bar * BAR;
    const chord = PROG[b];
    const lastBar = pass === PASSES - 1 && b === 7;

    // pipes carry the tune on every pass, a little breath between phrases
    for (const [e, m, len] of MEL[b]) {
      const dur = Math.max(0.1, len * EIGHTH - 0.05);
      pipeNote(t0 + e * EIGHTH, m, dur, 0.15);
      // the fiddle doubles an octave below from pass 2, then plays with the pipes in thirds
      if (pass >= 1) {
        voice({ start: t0 + e * EIGHTH, dur: len * EIGHTH * 0.97, freq: hz(m - (pass >= 2 ? 3 : 12)), gain: 0.15, pan: -0.3,
          wave: 'saw', attack: 0.05, release: 0.12, cutoff: 2400, vibrato: 0.007, vibDelay: 0.15, detune: 0.004, wet: 0.5 });
      }
    }
    // pass 3 and 4: fiddle strums rolling chord tones
    if (pass >= 1) {
      for (let e = 0; e < 8; e++) {
        voice({ start: t0 + e * EIGHTH, dur: EIGHTH * 0.9, freq: hz(CHORDS[chord][ARP[e]] + 12), gain: pass === 1 ? 0.07 : 0.10,
          pan: e % 2 ? 0.35 : -0.35, wave: 'pluck', attack: 0.004, release: 0.12, decay: 5, cutoff: 3500, wet: 0.45 });
      }
      for (const [e, st] of DRUM) drum(t0 + e * EIGHTH, 0.5 * st, e % 2 ? 0.2 : -0.1);
    }
    if (lastBar) pipeNote(t0 + 4 * EIGHTH, 69, 3.2, 0.15);
  }
}
// the first pass has the fiddle waiting; give it one long note at the end of the first pass
voice({ start: (INTRO + 7) * BAR + 4 * EIGHTH, dur: 4 * EIGHTH, freq: hz(57), gain: 0.12, wave: 'saw', attack: 0.06, release: 0.15, cutoff: 2300, vibrato: 0.007, wet: 0.5 });

// ---- reverb: four combs and two all-passes per side, different delays left and right
function reverb(input, delays) {
  const out = new Float32Array(N);
  for (const d of delays.combs) {
    const buf = new Float32Array(d);
    let p = 0;
    for (let i = 0; i < N; i++) {
      const y = buf[p];
      buf[p] = input[i] + y * 0.78;
      out[i] += y * 0.25;
      p = (p + 1) % d;
    }
  }
  for (const d of delays.aps) {
    const buf = new Float32Array(d);
    let p = 0;
    for (let i = 0; i < N; i++) {
      const y = buf[p];
      const x = out[i];
      buf[p] = x + y * 0.5;
      out[i] = y - x * 0.5;
      p = (p + 1) % d;
    }
  }
  return out;
}
const rl = reverb(wetL, { combs: [1687, 1931, 2203, 2411], aps: [521, 193] });
const rr = reverb(wetR, { combs: [1733, 1987, 2251, 2459], aps: [541, 211] });

// ---- master
const pcm = Buffer.alloc(N * 4);
let peak = 0;
const L = new Float32Array(N), Rr = new Float32Array(N);
for (let i = 0; i < N; i++) {
  L[i] = dryL[i] + rl[i] * 1.3;
  Rr[i] = dryR[i] + rr[i] * 1.3;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(Rr[i]));
}
const norm = 0.85 / peak;
for (let i = 0; i < N; i++) {
  pcm.writeInt16LE(Math.round(clamp(L[i] * norm) * 32767), i * 4);
  pcm.writeInt16LE(Math.round(clamp(Rr[i] * norm) * 32767), i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 4, 28); header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
fs.writeFileSync(new URL('./hexcolony-pipes-fiddle-demo.wav', import.meta.url), Buffer.concat([header, pcm]));
console.log(`wrote ${(pcm.length / 1e6).toFixed(1)} MB, ${(N / SR).toFixed(1)} s`);
