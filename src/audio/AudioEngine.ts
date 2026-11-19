import { clamp, clamp01, lerp } from '../sim/math';

interface NoiseOptions {
  duration: number;
  gain: number;
  filter: BiquadFilterType;
  frequency: number;
  endFrequency?: number;
  q?: number;
  pan?: number;
  delay?: number;
}

interface ToneOptions {
  frequency: number;
  endFrequency?: number;
  duration: number;
  gain: number;
  type?: OscillatorType;
  pan?: number;
  delay?: number;
}

type AudioContextConstructor = typeof AudioContext;

/** Every sound is synthesised, so the game downloads no audio files. */
export class AudioEngine {
  muted = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowd: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  /** Browsers only allow audio to start from a user gesture. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const scope = window as unknown as { webkitAudioContext?: AudioContextConstructor };
    const Ctor = window.AudioContext ?? scope.webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.85;
    this.master.connect(ctx.destination);

    const length = Math.floor(ctx.sampleRate * 2);
    this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 620;
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 140;
    this.crowd = ctx.createGain();
    this.crowd.gain.value = 0.018;
    source.connect(low).connect(high).connect(this.crowd).connect(this.master);
    source.start();
    if (ctx.state === 'suspended') void ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.85, this.ctx.currentTime, 0.02);
    }
  }

  suspend(): void {
    if (this.ctx?.state === 'running') void this.ctx.suspend();
  }

  private output(pan: number | undefined): AudioNode | null {
    const { ctx, master } = this;
    if (!ctx || !master) return null;
    if (pan !== undefined && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(pan, -1, 1);
      panner.connect(master);
      return panner;
    }
    return master;
  }

  private playNoise(o: NoiseOptions): void {
    const { ctx, noise } = this;
    const out = this.output(o.pan);
    if (!ctx || !noise || !out) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const source = ctx.createBufferSource();
    source.buffer = noise;
    const filter = ctx.createBiquadFilter();
    filter.type = o.filter;
    filter.frequency.setValueAtTime(o.frequency, t);
    if (o.endFrequency) filter.frequency.exponentialRampToValueAtTime(o.endFrequency, t + o.duration);
    filter.Q.value = o.q ?? 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(o.gain, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + o.duration);
    source.connect(filter).connect(gain).connect(out);
    source.start(t, Math.random() * 1.5, o.duration + 0.02);
  }

  private playTone(o: ToneOptions): void {
    const { ctx } = this;
    const out = this.output(o.pan);
    if (!ctx || !out) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.frequency, t);
    if (o.endFrequency) osc.frequency.exponentialRampToValueAtTime(o.endFrequency, t + o.duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(o.gain, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + o.duration);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + o.duration + 0.02);
  }

  hit(power: number, x: number, z: number, perfect: boolean): void {
    const near = lerp(0.5, 1, clamp01((z + 12) / 24));
    const pan = x / 11;
    const p = clamp01(power);
    this.playNoise({ duration: 0.055, gain: (0.22 + p * 0.3) * near, filter: 'bandpass', frequency: 2300, q: 0.7, pan });
    this.playTone({ frequency: 250 + p * 90, endFrequency: 105, duration: 0.1, gain: (0.3 + p * 0.28) * near, pan });
    this.playTone({ frequency: 640, endFrequency: 430, duration: 0.04, gain: 0.1 * near, type: 'triangle', pan });
    if (perfect) {
      this.playTone({ frequency: 1320, endFrequency: 1760, duration: 0.11, gain: 0.05 * near, type: 'triangle', pan });
    }
  }

  bounce(speed: number, x: number, z: number): void {
    const near = lerp(0.42, 1, clamp01((z + 12) / 24));
    const level = clamp01(speed / 24);
    const pan = x / 11;
    this.playTone({ frequency: 175, endFrequency: 88, duration: 0.075, gain: (0.08 + level * 0.18) * near, pan });
    this.playNoise({ duration: 0.04, gain: (0.04 + level * 0.09) * near, filter: 'lowpass', frequency: 1100, pan });
  }

  net(): void {
    this.playNoise({ duration: 0.2, gain: 0.2, filter: 'bandpass', frequency: 520, q: 0.5 });
    this.playTone({ frequency: 120, endFrequency: 70, duration: 0.12, gain: 0.12 });
  }

  swing(): void {
    this.playNoise({ duration: 0.15, gain: 0.05, filter: 'bandpass', frequency: 480, endFrequency: 1900, q: 1.1 });
  }

  toss(): void {
    this.playNoise({ duration: 0.09, gain: 0.03, filter: 'highpass', frequency: 1500 });
  }

  jump(): void {
    this.playTone({ frequency: 220, endFrequency: 330, duration: 0.08, gain: 0.035, type: 'triangle' });
  }

  fault(): void {
    this.playTone({ frequency: 240, endFrequency: 190, duration: 0.22, gain: 0.08, type: 'sawtooth' });
  }

  click(): void {
    this.playTone({ frequency: 760, endFrequency: 620, duration: 0.05, gain: 0.07, type: 'triangle' });
  }

  private notes(frequencies: number[], step: number, gain: number): void {
    frequencies.forEach((frequency, i) =>
      this.playTone({ frequency, duration: 0.22, gain, type: 'triangle', delay: i * step }),
    );
  }

  pointWon(): void {
    this.notes([523.25, 659.25, 783.99], 0.075, 0.075);
  }

  pointLost(): void {
    this.notes([329.63, 261.63], 0.1, 0.06);
  }

  matchWon(): void {
    this.notes([523.25, 659.25, 783.99, 1046.5, 1318.5], 0.1, 0.09);
  }

  matchLost(): void {
    this.notes([392, 329.63, 261.63, 196], 0.14, 0.07);
  }

  cheer(level: number): void {
    const { ctx, crowd } = this;
    if (!ctx || !crowd) return;
    const now = ctx.currentTime;
    crowd.gain.cancelScheduledValues(now);
    crowd.gain.setTargetAtTime(0.018 + level * 0.1, now, 0.08);
    crowd.gain.setTargetAtTime(0.018, now + 0.9, 0.5);
    const claps = Math.round(level * 34);
    for (let i = 0; i < claps; i++) {
      this.playNoise({
        duration: 0.03,
        gain: 0.018 + Math.random() * 0.03,
        filter: 'bandpass',
        frequency: 1200 + Math.random() * 1800,
        q: 1.4,
        pan: Math.random() * 1.6 - 0.8,
        delay: Math.random() * 1.3,
      });
    }
  }
}
