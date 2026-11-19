import { describe, expect, it } from 'vitest';
import { renderSound, SOUND_NAMES } from '../src/audio/synth';

const energy = (d: Float32Array, from: number, to: number) => {
  let sum = 0;
  const end = Math.min(d.length, to);
  for (let i = from; i < end; i++) sum += d[i] * d[i];
  return sum / Math.max(1, end - from);
};

const zeroCrossingRate = (d: Float32Array, sampleRate: number, seconds: number) => {
  const end = Math.min(d.length, Math.floor(seconds * sampleRate));
  let crossings = 0;
  for (let i = 1; i < end; i++) if (d[i - 1] < 0 !== d[i] < 0) crossings++;
  return (crossings / end) * sampleRate;
};

const lowShare = (d: Float32Array, sampleRate: number) => {
  const a = Math.exp((-2 * Math.PI * 220) / sampleRate);
  let low = 0;
  let lowEnergy = 0;
  let total = 0;
  for (let i = 0; i < d.length; i++) {
    low = low * a + d[i] * (1 - a);
    lowEnergy += low * low;
    total += d[i] * d[i];
  }
  return lowEnergy / total;
};

describe('sound bank', () => {
  const sounds = new Map(SOUND_NAMES.map((name) => [name, renderSound(name)]));
  const mono = (name: string) => {
    const sound = sounds.get(name);
    if (!sound) throw new Error(`Missing ${name}`);
    return sound;
  };

  it('renders every sound as finite, audible audio without clipping', () => {
    expect(SOUND_NAMES.length).toBeGreaterThan(30);
    for (const [name, sound] of sounds) {
      let peak = 0;
      let finite = true;
      for (const channel of sound.channels) {
        for (let i = 0; i < channel.length; i++) {
          if (!Number.isFinite(channel[i])) finite = false;
          peak = Math.max(peak, Math.abs(channel[i]));
        }
      }
      expect(finite, name).toBe(true);
      expect(peak, name).toBeLessThanOrEqual(1);
      expect(peak, name).toBeGreaterThan(0.2);
    }
  });

  it('is repeatable but gives each variant its own character', () => {
    const again = renderSound('hit.drive.0').channels[0];
    const first = mono('hit.drive.0').channels[0];
    const other = mono('hit.drive.1').channels[0];
    expect(Array.from(again.slice(0, 200))).toEqual(Array.from(first.slice(0, 200)));
    expect(Array.from(other.slice(40, 200))).not.toEqual(Array.from(first.slice(40, 200)));
  });

  it('makes racket hits sharp and short', () => {
    for (const kind of ['drive', 'spin', 'volley', 'serve', 'smash', 'frame', 'power']) {
      const { channels, sampleRate } = mono(`hit.${kind}.0`);
      const d = channels[0];
      const start = energy(d, 0, Math.floor(0.03 * sampleRate));
      const end = energy(d, d.length - Math.floor(0.03 * sampleRate), d.length);
      expect(start / Math.max(1e-12, end), kind).toBeGreaterThan(200);
    }
  });

  it('gives each impact the right weight', () => {
    const rate = 44100;
    const hit = mono('hit.drive.0').channels[0];
    const bounce = mono('bounce.0').channels[0];
    const smash = mono('hit.smash.0').channels[0];
    const volley = mono('hit.volley.0').channels[0];
    const power = mono('hit.power.0').channels[0];
    expect(zeroCrossingRate(hit, rate, 0.03)).toBeGreaterThan(zeroCrossingRate(bounce, rate, 0.03));
    expect(lowShare(smash, rate)).toBeGreaterThan(lowShare(volley, rate));
    expect(lowShare(power, rate)).toBeGreaterThan(lowShare(hit, rate));
  });

  it('builds a dense crowd rather than a few separate claps', () => {
    const { channels, sampleRate } = mono('crowd.clapsBig');
    const d = channels[0];
    const steady = d.subarray(Math.floor(0.8 * sampleRate), Math.floor(2 * sampleRate));
    let peak = 0;
    for (const v of steady) peak = Math.max(peak, Math.abs(v));
    const rms = Math.sqrt(energy(steady, 0, steady.length));
    expect(peak / rms).toBeLessThan(8);
    expect(energy(d, d.length - 2000, d.length)).toBeLessThan(energy(steady, 0, steady.length) * 0.05);
  });

  it('loops the crowd murmur without a click', () => {
    const { channels } = mono('crowd.murmur');
    for (const c of channels) {
      const step = Math.abs(c[0] - c[c.length - 1]);
      let typical = 0;
      for (let i = 1; i < 4000; i++) typical = Math.max(typical, Math.abs(c[i] - c[i - 1]));
      expect(step).toBeLessThanOrEqual(typical * 1.2);
    }
  });

  it('uses a wide, decaying stadium echo', () => {
    const { channels, sampleRate } = mono('ir.stadium');
    const [l, r] = channels;
    expect(energy(l, 0, Math.floor(0.2 * sampleRate))).toBeGreaterThan(energy(l, l.length - 2000, l.length) * 100);
    let cross = 0;
    let ll = 0;
    let rr = 0;
    for (let i = 0; i < l.length; i++) {
      cross += l[i] * r[i];
      ll += l[i] * l[i];
      rr += r[i] * r[i];
    }
    expect(Math.abs(cross / Math.sqrt(ll * rr))).toBeLessThan(0.3);
  });
});
