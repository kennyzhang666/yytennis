import { createRng, type Rng } from '../sim/math';

/**
 * Offline sound design. Everything is rendered to sample buffers once, in a
 * worker, so playback is as cheap as playing recordings and no files download.
 */
export interface RenderedSound {
  sampleRate: number;
  channels: Float32Array[];
}

const TAU = Math.PI * 2;
const SFX_RATE = 44100;
const CROWD_RATE = 22050;
const VARIANTS = 3;

class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private z1 = 0;
  private z2 = 0;

  private coefficients(frequency: number, q: number, sr: number) {
    const w = (TAU * Math.min(frequency, sr * 0.45)) / sr;
    const alpha = Math.sin(w) / (2 * q);
    return { c: Math.cos(w), alpha, a0: 1 + alpha };
  }

  bandpass(frequency: number, q: number, sr: number): this {
    const { c, alpha, a0 } = this.coefficients(frequency, q, sr);
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  lowpass(frequency: number, q: number, sr: number): this {
    const { c, alpha, a0 } = this.coefficients(frequency, q, sr);
    this.b0 = (1 - c) / 2 / a0;
    this.b1 = (1 - c) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  highpass(frequency: number, q: number, sr: number): this {
    const { c, alpha, a0 } = this.coefficients(frequency, q, sr);
    this.b0 = (1 + c) / 2 / a0;
    this.b1 = -(1 + c) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

const samples = (seconds: number, sr: number) => new Float32Array(Math.max(1, Math.ceil(seconds * sr)));
const between = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();

function hashName(name: string): number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return h >>> 0;
}

function normalize(channels: Float32Array[], peak: number): void {
  let max = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) max = Math.max(max, Math.abs(c[i]));
  if (max < 1e-9) return;
  const k = peak / max;
  for (const c of channels) for (let i = 0; i < c.length; i++) c[i] *= k;
}

function filterInPlace(data: Float32Array, filter: Biquad): void {
  for (let i = 0; i < data.length; i++) data[i] = filter.process(data[i]);
}

/** A struck resonance: a sine that decays exponentially and settles slightly in pitch. */
function addMode(
  out: Float32Array,
  sr: number,
  frequency: number,
  tau: number,
  gain: number,
  phase: number,
  glide = 0.03,
  start = 0,
): void {
  const n = Math.min(out.length - start, Math.ceil(tau * sr * 9));
  const decay = Math.exp(-1 / (tau * sr));
  const glideDecay = Math.exp(-1 / (0.004 * sr));
  let env = gain;
  let bend = glide;
  let ph = phase;
  for (let i = 0; i < n; i++) {
    ph += (TAU * frequency * (1 + bend)) / sr;
    out[start + i] += env * Math.sin(ph);
    env *= decay;
    bend *= glideDecay;
  }
}

/** The ball is in contact for a few milliseconds, which softens the very start. */
function shapeAttack(out: Float32Array, count: number): void {
  const n = Math.min(out.length, Math.max(1, Math.round(count)));
  for (let i = 0; i < n; i++) {
    const s = Math.sin((Math.PI / 2) * (i / n));
    out[i] *= s * s;
  }
}

interface NoiseShape {
  duration: number;
  gain: number;
  filter: Biquad;
  start?: number;
  /** 'decay' for impacts, 'swell' for brushing and swishing sounds. */
  envelope?: 'decay' | 'swell';
}

function addNoise(out: Float32Array, sr: number, rng: Rng, o: NoiseShape): void {
  const start = Math.round((o.start ?? 0) * sr);
  const n = Math.min(out.length - start, Math.ceil(o.duration * sr * (o.envelope === 'swell' ? 1 : 4)));
  const tau = o.duration / 2.2;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env =
      o.envelope === 'swell'
        ? Math.sin((Math.PI * Math.min(1, t / o.duration)) ** 1) ** 2
        : Math.min(1, t / 0.0005) * Math.exp(-t / tau);
    out[start + i] += o.filter.process((rng() * 2 - 1) * env) * o.gain;
  }
}

type ModeSpec = readonly [frequency: number, tau: number, gain: number];

interface StrikeRecipe {
  seconds: number;
  contact: number;
  modes: readonly ModeSpec[];
  crack?: { duration: number; frequency: number; gain: number };
  brush?: { duration: number; frequency: number; gain: number };
  thud?: { duration: number; frequency: number; gain: number };
}

/**
 * Racket impact: hollow ball, string bed and frame each ring at their own
 * frequencies. A harder strike has a shorter contact and excites the top end.
 */
const STRIKES: Record<string, StrikeRecipe> = {
  drive: {
    seconds: 0.24,
    contact: 0.0045,
    modes: [
      [165, 0.03, 0.42],
      [420, 0.016, 0.35],
      [612, 0.013, 0.85],
      [1180, 0.007, 0.6],
      [1950, 0.0045, 0.32],
      [3300, 0.0022, 0.16],
    ],
    crack: { duration: 0.0035, frequency: 3000, gain: 0.55 },
  },
  spin: {
    seconds: 0.24,
    contact: 0.005,
    modes: [
      [158, 0.028, 0.4],
      [405, 0.016, 0.33],
      [590, 0.012, 0.8],
      [1130, 0.0065, 0.5],
      [1880, 0.004, 0.25],
    ],
    crack: { duration: 0.003, frequency: 2600, gain: 0.38 },
    brush: { duration: 0.036, frequency: 4300, gain: 0.34 },
  },
  volley: {
    seconds: 0.16,
    contact: 0.0056,
    modes: [
      [190, 0.018, 0.4],
      [520, 0.01, 0.72],
      [980, 0.006, 0.45],
      [1700, 0.003, 0.18],
    ],
    crack: { duration: 0.0025, frequency: 2200, gain: 0.24 },
  },
  serve: {
    seconds: 0.3,
    contact: 0.0038,
    modes: [
      [118, 0.046, 0.72],
      [300, 0.022, 0.46],
      [640, 0.016, 1],
      [1250, 0.008, 0.7],
      [2300, 0.005, 0.4],
      [4100, 0.0025, 0.22],
    ],
    crack: { duration: 0.0032, frequency: 3400, gain: 0.72 },
  },
  smash: {
    seconds: 0.36,
    contact: 0.0034,
    modes: [
      [86, 0.07, 0.86],
      [172, 0.04, 0.6],
      [640, 0.017, 0.95],
      [1320, 0.009, 0.72],
      [2500, 0.005, 0.44],
      [4600, 0.0024, 0.25],
    ],
    crack: { duration: 0.004, frequency: 3600, gain: 0.82 },
  },
  frame: {
    seconds: 0.2,
    contact: 0.0024,
    modes: [
      [242, 0.02, 0.5],
      [872, 0.012, 0.92],
      [1524, 0.008, 0.62],
      [2641, 0.005, 0.36],
    ],
    crack: { duration: 0.002, frequency: 3800, gain: 0.4 },
  },
  power: {
    seconds: 0.62,
    contact: 0.003,
    modes: [
      [58, 0.14, 1],
      [116, 0.07, 0.72],
      [640, 0.02, 0.9],
      [1280, 0.011, 0.66],
      [2440, 0.006, 0.42],
      [5200, 0.0026, 0.26],
    ],
    crack: { duration: 0.0048, frequency: 3900, gain: 0.95 },
    thud: { duration: 0.16, frequency: 420, gain: 0.5 },
  },
};

function renderStrike(recipe: StrikeRecipe, rng: Rng): Float32Array {
  const sr = SFX_RATE;
  const out = samples(recipe.seconds, sr);
  for (const [frequency, tau, gain] of recipe.modes) {
    addMode(
      out,
      sr,
      frequency * between(rng, 0.965, 1.035),
      tau * between(rng, 0.9, 1.12),
      gain * between(rng, 0.88, 1.12),
      rng() * TAU,
    );
  }
  if (recipe.crack) {
    const { duration, frequency, gain } = recipe.crack;
    addNoise(out, sr, rng, { duration, gain, filter: new Biquad().bandpass(frequency, 0.8, sr) });
  }
  if (recipe.brush) {
    const { duration, frequency, gain } = recipe.brush;
    addNoise(out, sr, rng, {
      duration,
      gain,
      envelope: 'swell',
      filter: new Biquad().bandpass(frequency, 1.1, sr),
    });
  }
  if (recipe.thud) {
    const { duration, frequency, gain } = recipe.thud;
    addNoise(out, sr, rng, { duration, gain, filter: new Biquad().lowpass(frequency, 0.8, sr) });
  }
  shapeAttack(out, recipe.contact * sr * 0.5);
  normalize([out], 0.92);
  return out;
}

const BOUNCE_RECIPE: StrikeRecipe = {
  seconds: 0.12,
  contact: 0.006,
  modes: [
    [150, 0.02, 0.8],
    [305, 0.013, 0.5],
    [820, 0.006, 0.34],
    [1650, 0.0032, 0.15],
  ],
  thud: { duration: 0.006, frequency: 2300, gain: 0.5 },
};

const STEP_RECIPE: StrikeRecipe = {
  seconds: 0.12,
  contact: 0.01,
  modes: [
    [96, 0.03, 0.8],
    [212, 0.018, 0.4],
  ],
  thud: { duration: 0.018, frequency: 900, gain: 0.55 },
};

/** A rubber sole dragging on hard court: a stick-slip tone that wavers. */
function renderSqueak(rng: Rng): Float32Array {
  const sr = SFX_RATE;
  const seconds = between(rng, 0.09, 0.2);
  const out = samples(seconds, sr);
  const f0 = between(rng, 1500, 2100);
  const f1 = f0 * between(rng, 1.15, 1.5);
  const wobble = between(rng, 40, 75);
  let ph = 0;
  let rough = 0;
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    const k = t / seconds;
    rough += (rng() * 2 - 1 - rough) * 0.04;
    const f = (f0 + (f1 - f0) * k) * (1 + 0.035 * Math.sin(TAU * wobble * t) + rough * 0.05);
    ph += (TAU * f) / sr;
    const env = Math.min(1, t / 0.008) * (1 - k) ** 1.4;
    out[i] = env * (Math.sin(ph) + 0.5 * Math.sin(2 * ph + 0.4) + 0.24 * Math.sin(3 * ph + 1.1) + 0.1 * Math.sin(5 * ph));
  }
  normalize([out], 0.8);
  return out;
}

function renderWhoosh(rng: Rng): Float32Array {
  const sr = SFX_RATE;
  const seconds = between(rng, 0.2, 0.27);
  const out = samples(seconds, sr);
  const filter = new Biquad();
  const low = between(rng, 420, 620);
  const high = between(rng, 1700, 2500);
  for (let i = 0; i < out.length; i++) {
    const k = i / out.length;
    if (i % 32 === 0) filter.bandpass(low + (high - low) * Math.sin(Math.PI * k) ** 2, 1.15, sr);
    out[i] = filter.process(rng() * 2 - 1) * Math.sin(Math.PI * k) ** 2;
  }
  normalize([out], 0.8);
  return out;
}

function renderNet(rng: Rng): Float32Array {
  const sr = SFX_RATE;
  const out = samples(0.42, sr);
  addMode(out, sr, 86, 0.07, 0.8, rng() * TAU, 0.08);
  addMode(out, sr, 172, 0.035, 0.28, rng() * TAU, 0.05);
  for (let i = 0; i < 16; i++) {
    addNoise(out, sr, rng, {
      start: between(rng, 0, 0.26) ** 1.4,
      duration: between(rng, 0.01, 0.03),
      gain: between(rng, 0.12, 0.3),
      filter: new Biquad().bandpass(between(rng, 700, 2600), 1.2, sr),
    });
  }
  normalize([out], 0.8);
  return out;
}

function renderChargeReady(rng: Rng): Float32Array {
  const sr = SFX_RATE;
  const out = samples(0.75, sr);
  const notes: ModeSpec[] = [
    [1568, 0.22, 0.5],
    [2349, 0.16, 0.36],
    [3136, 0.11, 0.25],
    [4699, 0.07, 0.12],
  ];
  for (const [f, tau, gain] of notes) addMode(out, sr, f, tau, gain, rng() * TAU, 0.004);
  shapeAttack(out, 0.002 * sr);
  normalize([out], 0.7);
  return out;
}

function renderStadiumResponse(rng: Rng): RenderedSound {
  const sr = CROWD_RATE;
  const seconds = 1.5;
  const channels = [samples(seconds, sr), samples(seconds, sr)];
  channels.forEach((c) => {
    // Reflections from the stands, then a dark diffuse tail.
    for (let i = 0; i < 14; i++) {
      const t = between(rng, 0.024, 0.19);
      const at = Math.floor(t * sr);
      c[at] += (rng() < 0.5 ? -1 : 1) * between(rng, 0.2, 0.62) * Math.exp(-t / 0.12);
    }
    let low = 0;
    const start = Math.floor(0.05 * sr);
    for (let i = start; i < c.length; i++) {
      const t = i / sr;
      const cutoff = 0.5 * Math.exp(-t / 0.62) + 0.05;
      low += ((rng() * 2 - 1) - low) * cutoff;
      const fadeIn = Math.min(1, (t - 0.05) / 0.06);
      const fadeOut = Math.min(1, (seconds - t) / 0.2);
      c[i] += low * Math.exp(-t / 0.26) * 0.8 * fadeIn * fadeOut;
    }
  });
  normalize(channels, 0.9);
  return { sampleRate: sr, channels };
}

function pan(position: number): [number, number] {
  const a = ((position + 1) / 2) * (Math.PI / 2);
  return [Math.cos(a), Math.sin(a)];
}

/** Many separate clappers, each with their own rhythm, distance and seat. */
function renderApplause(rng: Rng, seconds: number, clappers: number, tail: number): RenderedSound {
  const sr = CROWD_RATE;
  const channels = [samples(seconds, sr), samples(seconds, sr)];
  const grains: Float32Array[] = [];
  for (let i = 0; i < 28; i++) {
    const grain = samples(0.03, sr);
    const tau = between(rng, 0.0028, 0.008);
    const body = new Biquad().bandpass(between(rng, 1000, 3100), between(rng, 0.8, 2.1), sr);
    const palm = new Biquad().bandpass(between(rng, 420, 900), 1.1, sr);
    for (let n = 0; n < grain.length; n++) {
      const x = (rng() * 2 - 1) * Math.exp(-(n / sr) / tau);
      grain[n] = body.process(x) + palm.process(x) * 0.45;
    }
    normalize([grain], 1);
    grains.push(grain);
  }

  const fadeStart = seconds - tail;
  for (let c = 0; c < clappers; c++) {
    const distance = between(rng, 0.2, 1) ** 1.6;
    const [l, r] = pan(between(rng, -1, 1));
    const rate = between(rng, 2.7, 5.4);
    let t = between(rng, 0, 0.42) ** 1.5;
    const stop = fadeStart + rng() * tail;
    const grain = grains[Math.floor(rng() * grains.length)];
    while (t < stop) {
      const env = Math.min(1, t / 0.14) * (t > fadeStart ? 1 - (t - fadeStart) / tail : 1);
      const gain = distance * env * between(rng, 0.7, 1);
      const at = Math.floor(t * sr);
      for (let n = 0; n < grain.length && at + n < channels[0].length; n++) {
        channels[0][at + n] += grain[n] * gain * l;
        channels[1][at + n] += grain[n] * gain * r;
      }
      t += (1 / rate) * between(rng, 0.92, 1.1);
    }
  }
  for (const ch of channels) filterInPlace(ch, new Biquad().lowpass(6200, 0.7, sr));
  normalize(channels, 0.85);
  return { sampleRate: sr, channels };
}

const VOWELS = {
  ah: [760, 1220, 2600],
  eh: [560, 1720, 2550],
  oh: [470, 860, 2500],
  oo: [330, 780, 2300],
  uh: [620, 1120, 2450],
} as const;

interface VoiceRecipe {
  seconds: number;
  voices: number;
  from: readonly number[];
  to: readonly number[];
  pitch: (k: number) => number;
  level: (k: number) => number;
  breath: number;
}

/** A crowd reaction: many short vocal tracts, none exactly in time or in tune. */
function renderVoices(rng: Rng, r: VoiceRecipe): RenderedSound {
  const sr = CROWD_RATE;
  const channels = [samples(r.seconds, sr), samples(r.seconds, sr)];
  const n = channels[0].length;
  for (let v = 0; v < r.voices; v++) {
    const f0 = between(rng, 118, 300);
    const tract = between(rng, 0.9, 1.16);
    const delay = between(rng, 0, 0.11);
    const stretch = between(rng, 0.86, 1.08);
    const vibrato = between(rng, 4.5, 6.5);
    const depth = between(rng, 0.008, 0.03);
    const gain = between(rng, 0.35, 1);
    const [l, r0] = pan(between(rng, -1, 1));
    const f = [new Biquad(), new Biquad(), new Biquad()];
    let ph = rng();
    let low = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const k = Math.max(0, Math.min(1, (t - delay) / (r.seconds * stretch)));
      if (i % 96 === 0) {
        for (let m = 0; m < 3; m++) {
          const hz = (r.from[m] + (r.to[m] - r.from[m]) * k) * tract;
          f[m].bandpass(hz, m === 0 ? 5 : 7, sr);
        }
      }
      ph += (f0 * r.pitch(k) * (1 + depth * Math.sin(TAU * vibrato * t))) / sr;
      if (ph >= 1) ph -= 1;
      low += (2 * ph - 1 - low) * 0.22;
      const src = low + (rng() * 2 - 1) * r.breath;
      const y = f[0].process(src) + f[1].process(src) * 0.62 + f[2].process(src) * 0.24;
      const a = y * gain * r.level(k);
      channels[0][i] += a * l;
      channels[1][i] += a * r0;
    }
  }
  for (const ch of channels) {
    filterInPlace(ch, new Biquad().highpass(150, 0.7, sr));
    filterInPlace(ch, new Biquad().lowpass(5200, 0.7, sr));
  }
  normalize(channels, 0.8);
  return { sampleRate: sr, channels };
}

const hump = (k: number, rise: number, fall: number) =>
  Math.min(1, k / rise) ** 1.4 * Math.min(1, (1 - k) / fall) ** 1.2;

/** The hum of a seated crowd: quiet, overlapping, unintelligible conversations. */
function renderMurmur(rng: Rng): RenderedSound {
  const sr = CROWD_RATE;
  const seconds = 12;
  const overlap = 1.5;
  const total = Math.ceil((seconds + overlap) * sr);
  const vowels = Object.values(VOWELS);
  const channels = [new Float32Array(total), new Float32Array(total)];
  for (const out of channels) {
    for (let v = 0; v < 11; v++) {
      const f0 = between(rng, 100, 235);
      const tract = between(rng, 0.9, 1.15);
      const gain = between(rng, 0.3, 1);
      const a = new Biquad();
      const b = new Biquad();
      let ph = rng();
      let env = 0;
      let target = 0;
      let next = 0;
      let low = 0;
      for (let i = 0; i < total; i++) {
        if (i >= next) {
          const talking = rng() < 0.74;
          target = talking ? between(rng, 0.45, 1) : 0;
          next = i + Math.floor(between(rng, 0.08, talking ? 0.24 : 0.42) * sr);
          const vowel = vowels[Math.floor(rng() * vowels.length)];
          a.bandpass(vowel[0] * tract, 4, sr);
          b.bandpass(vowel[1] * tract, 6, sr);
        }
        env += (target - env) * 0.0028;
        ph += (f0 * (1 + 0.04 * env)) / sr;
        if (ph >= 1) ph -= 1;
        low += (2 * ph - 1 - low) * 0.2;
        const src = low + (rng() * 2 - 1) * 0.55;
        out[i] += (a.process(src) + b.process(src) * 0.55) * env * gain;
      }
    }
    filterInPlace(out, new Biquad().highpass(170, 0.7, sr));
    filterInPlace(out, new Biquad().lowpass(3000, 0.7, sr));
  }

  const length = Math.ceil(seconds * sr);
  const blend = total - length;
  const looped = channels.map((c) => {
    const out = c.slice(0, length);
    for (let i = 0; i < blend; i++) {
      const k = i / blend;
      out[i] = out[i] * Math.sqrt(k) + c[length + i] * Math.sqrt(1 - k);
    }
    return out;
  });
  normalize(looped, 0.7);
  return { sampleRate: sr, channels: looped };
}

function renderNoiseLoop(rng: Rng): RenderedSound {
  const out = samples(2, CROWD_RATE);
  for (let i = 0; i < out.length; i++) out[i] = rng() * 2 - 1;
  return { sampleRate: CROWD_RATE, channels: [out] };
}

const mono = (data: Float32Array): RenderedSound => ({ sampleRate: SFX_RATE, channels: [data] });

const variants = (prefix: string, render: (rng: Rng) => Float32Array) =>
  Array.from({ length: VARIANTS }, (_, i): [string, (rng: Rng) => RenderedSound] => [
    `${prefix}.${i}`,
    (rng) => mono(render(rng)),
  ]);

const RECIPES = new Map<string, (rng: Rng) => RenderedSound>([
  ...Object.keys(STRIKES).flatMap((kind) => variants(`hit.${kind}`, (rng) => renderStrike(STRIKES[kind], rng))),
  ...variants('bounce', (rng) => renderStrike(BOUNCE_RECIPE, rng)),
  ...variants('step', (rng) => renderStrike(STEP_RECIPE, rng)),
  ...variants('squeak', renderSqueak),
  ...variants('whoosh', renderWhoosh),
  ['net.0', (rng) => mono(renderNet(rng))],
  ['charge.ready', (rng) => mono(renderChargeReady(rng))],
  ['noise', renderNoiseLoop],
  ['ir.stadium', renderStadiumResponse],
  ['crowd.murmur', renderMurmur],
  ['crowd.clapsLight', (rng) => renderApplause(rng, 3.2, 70, 1.5)],
  ['crowd.clapsBig', (rng) => renderApplause(rng, 5, 260, 2.2)],
  [
    'crowd.cheer',
    (rng) =>
      renderVoices(rng, {
        seconds: 2.5,
        voices: 38,
        from: VOWELS.ah,
        to: VOWELS.eh,
        pitch: (k) => 1 + 0.2 * Math.min(1, k / 0.16) - 0.12 * k,
        level: (k) => hump(k, 0.1, 0.5),
        breath: 0.32,
      }),
  ],
  [
    'crowd.ooh',
    (rng) =>
      renderVoices(rng, {
        seconds: 1.35,
        voices: 26,
        from: VOWELS.oo,
        to: VOWELS.oh,
        pitch: (k) => 0.92 + 0.3 * Math.sin(Math.PI * Math.min(1, k * 1.15)),
        level: (k) => hump(k, 0.3, 0.55),
        breath: 0.22,
      }),
  ],
  [
    'crowd.groan',
    (rng) =>
      renderVoices(rng, {
        seconds: 1.25,
        voices: 22,
        from: VOWELS.uh,
        to: VOWELS.oh,
        pitch: (k) => 1.12 - 0.34 * k,
        level: (k) => hump(k, 0.14, 0.62),
        breath: 0.26,
      }),
  ],
]);

/** Quick, gameplay-critical sounds come first, the slow crowd beds last. */
export const SOUND_NAMES: readonly string[] = [...RECIPES.keys()];

export function renderSound(name: string): RenderedSound {
  const recipe = RECIPES.get(name);
  if (!recipe) throw new Error(`Unknown sound: ${name}`);
  return recipe(createRng(hashName(name)));
}
