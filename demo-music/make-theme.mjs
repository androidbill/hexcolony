// An original piece for HexColony: Celtic-flavoured, D dorian, driving 8ths.
// Renders offline to a 16-bit stereo WAV so it can be heard without the game.
import fs from 'node:fs';

const SR = 32000;
const BPM = 120;
const EIGHTH = 60 / BPM / 2;          // seconds
const BAR = EIGHTH * 8;
const PASSES = 4;
const BARS = 8 * PASSES;
const TAIL = 4;                        // seconds of reverb ring-out
const N = Math.ceil((BARS * BAR + TAIL) * SR);
const dryL = new Float32Array(N), dryR = new Float32Array(N);
const wetL = new Float32Array(N), wetR = new Float32Array(N);

const hz = (m) => 440 * 2 ** ((m - 69) / 12);
const clamp = (x) => Math.max(-1, Math.min(1, x));

// One-pole low-pass helper state per voice render.
function voice({ start, dur, freq, gain, pan = 0, wave = 'saw', attack = 0.01, release = 0.08,
  cutoff = 3000, vibrato = 0, vibDelay = 0.15, decay = 0, wet = 0.3, detune = 0 }) {
  const i0 = Math.floor(start * SR);
  const len = Math.floor((dur + release) * SR);
  const a = Math.exp(-2 * Math.PI * cutoff / SR);
  let lp = 0, ph = 0, ph2 = 0;
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

// ---- the music
const CHORDS = {
  Dm: [50, 57, 62, 65], C: [48, 55, 60, 64], Bb: [46, 53, 58, 62], A: [45, 52, 57, 61],
};
const PROG = ['Dm', 'Dm', 'C', 'C', 'Bb', 'C', 'Dm', 'A'];
const BASS = { Dm: 38, C: 36, Bb: 34, A: 33 };
// [eighth, midi, length in eighths] per bar of the melody.
const MEL = [
  [[0, 69, 3], [3, 65, 1], [4, 69, 2], [6, 74, 2]],
  [[0, 72, 3], [3, 69, 1], [4, 67, 4]],
  [[0, 67, 2], [2, 72, 2], [4, 76, 3], [7, 74, 1]],
  [[0, 72, 4], [4, 67, 4]],
  [[0, 74, 3], [3, 77, 1], [4, 74, 2], [6, 70, 2]],
  [[0, 72, 3], [3, 76, 1], [4, 79, 4]],
  [[0, 77, 2], [2, 76, 2], [4, 74, 2], [6, 69, 2]],
  [[0, 76, 2], [2, 73, 2], [4, 69, 4]],
];
const ARP = [0, 2, 1, 2, 3, 2, 1, 2];
const DRUM = [[0, 1.0], [3, 0.55], [4, 0.8], [6, 0.5]];

for (let pass = 0; pass < PASSES; pass++) {
  for (let b = 0; b < 8; b++) {
    const bar = pass * 8 + b;
    const t0 = bar * BAR;
    const chord = PROG[b];
    const last = pass === PASSES - 1 && b === 7;

    // drone swells in over the first pass
    voice({ start: t0, dur: BAR, freq: hz(BASS[chord]), gain: 0.16, wave: 'tri', attack: 0.3, release: 0.4, cutoff: 700, wet: 0.2 });
    voice({ start: t0, dur: BAR, freq: hz(BASS[chord] + 7), gain: 0.07, wave: 'sine', attack: 0.4, release: 0.4, cutoff: 900, wet: 0.2 });

    // rolling plucked arpeggio, quieter on the first pass
    const arpGain = pass === 0 ? 0.075 : 0.11;
    for (let e = 0; e < 8; e++) {
      voice({ start: t0 + e * EIGHTH, dur: EIGHTH * 0.9, freq: hz(CHORDS[chord][ARP[e]] + 12), gain: arpGain,
        pan: e % 2 ? 0.35 : -0.35, wave: 'pluck', attack: 0.004, release: 0.12, decay: 5, cutoff: 3500, wet: 0.45 });
    }

    // drum from the second pass
    if (pass >= 1) for (const [e, s] of DRUM) drum(t0 + e * EIGHTH, 0.5 * s * (pass === 1 ? 0.8 : 1), e % 2 ? 0.2 : -0.1);

    // melody: fiddle lead; from pass 3 an octave-above-in-sixths harmony joins it
    const melody = pass === PASSES - 1 && b === 7
      ? [[0, 76, 2], [2, 73, 2], [4, 74, 4]]            // final bar comes home to D
      : MEL[b];
    for (const [e, m, len] of melody) {
      const dur = len * EIGHTH * 0.97;
      voice({ start: t0 + e * EIGHTH, dur, freq: hz(m), gain: pass === 0 ? 0.13 : 0.17, pan: 0.1, wave: 'saw',
        attack: 0.03, release: 0.12, cutoff: 2600, vibrato: 0.006, vibDelay: 0.18, wet: 0.5, detune: 0.004 });
      if (pass >= 2) {
        voice({ start: t0 + e * EIGHTH, dur, freq: hz(m - 3), gain: 0.07, pan: -0.25, wave: 'saw',
          attack: 0.04, release: 0.12, cutoff: 2000, vibrato: 0.005, vibDelay: 0.25, wet: 0.5, detune: 0.004 });
      }
    }
    if (last) voice({ start: t0 + 4 * EIGHTH, dur: 3.5, freq: hz(50), gain: 0.14, wave: 'tri', attack: 0.05, release: 2.5, cutoff: 1500, wet: 0.5 });
  }
}

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
fs.writeFileSync(new URL('./hexcolony-theme-demo.wav', import.meta.url), Buffer.concat([header, pcm]));
console.log(`wrote ${(pcm.length / 1e6).toFixed(1)} MB, ${(N / SR).toFixed(1)} s`);
