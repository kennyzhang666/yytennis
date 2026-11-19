import { clamp, clamp01, lerp } from '../sim/math';
import type { ShotKind } from '../sim/shot';
import { renderSound, SOUND_NAMES, type RenderedSound } from './synth';

type AudioContextConstructor = typeof AudioContext;
export type CrowdMood = 'idle' | 'hushed' | 'silent';

export interface HitSound {
  shot: ShotKind;
  quality: number;
  speed: number;
  x: number;
  z: number;
  charge: number;
  /** Playback speed, below 1 during slow-motion replays. */
  rate?: number;
}

interface PlayOptions {
  gain: number;
  pan?: number;
  rate?: number;
  /** How much of the sound feeds the stadium reverb. */
  send?: number;
  /** Air absorption for distant sounds. */
  cutoff?: number;
  delay?: number;
  bus?: GainNode;
}

const MOOD_LEVEL: Record<CrowdMood, number> = { idle: 0.26, hushed: 0.055, silent: 0.012 };
const VARIANTS = 3;

const nearness = (z: number) => lerp(0.42, 1, clamp01((z + 12) / 24));

export class AudioEngine {
  muted = false;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private crowd: GainNode | null = null;
  private crowdTone: BiquadFilterNode | null = null;
  private reverb: ConvolverNode | null = null;
  private murmur: GainNode | null = null;
  private murmurSource: AudioBufferSourceNode | null = null;
  private mood: CrowdMood = 'idle';
  private riserGain: GainNode | null = null;
  private riserFilter: BiquadFilterNode | null = null;
  private riserTone: OscillatorNode | null = null;
  private riserToneGain: GainNode | null = null;
  private lastApplause = -10;
  private readonly rendered = new Map<string, RenderedSound>();
  private readonly buffers = new Map<string, AudioBuffer>();

  constructor() {
    this.renderBank();
  }

  /** Sounds are prepared in the background so the game never hitches for them. */
  private renderBank(): void {
    const onSound = (name: string, sound: RenderedSound) => {
      this.rendered.set(name, sound);
      if (name === 'ir.stadium' || name === 'crowd.murmur' || name === 'noise') this.connectBeds();
    };
    const renderHere = (from: number) => {
      let index = from;
      const next = () => {
        if (index >= SOUND_NAMES.length) return;
        const name = SOUND_NAMES[index++];
        if (!this.rendered.has(name)) onSound(name, renderSound(name));
        window.setTimeout(next, 12);
      };
      next();
    };
    try {
      const worker = new Worker(new URL('./synthWorker.ts', import.meta.url), { type: 'module' });
      let received = 0;
      worker.onmessage = (e: MessageEvent<RenderedSound & { name: string }>) => {
        onSound(e.data.name, { sampleRate: e.data.sampleRate, channels: e.data.channels });
        if (++received === SOUND_NAMES.length) worker.terminate();
      };
      worker.onerror = () => {
        worker.terminate();
        renderHere(0);
      };
    } catch {
      renderHere(0);
    }
  }

  private buffer(name: string): AudioBuffer | null {
    const { ctx } = this;
    if (!ctx) return null;
    const ready = this.buffers.get(name);
    if (ready) return ready;
    const sound = this.rendered.get(name);
    if (!sound) return null;
    const buffer = ctx.createBuffer(sound.channels.length, sound.channels[0].length, sound.sampleRate);
    sound.channels.forEach((data, i) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, i));
    this.buffers.set(name, buffer);
    return buffer;
  }

  /** A convolver only accepts buffers at the output's own sample rate. */
  private resampled(sound: RenderedSound, ctx: AudioContext): AudioBuffer {
    const ratio = sound.sampleRate / ctx.sampleRate;
    const length = Math.floor(sound.channels[0].length / ratio);
    const buffer = ctx.createBuffer(sound.channels.length, length, ctx.sampleRate);
    sound.channels.forEach((source, c) => {
      const out = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) {
        const at = i * ratio;
        const a = Math.floor(at);
        const b = Math.min(source.length - 1, a + 1);
        out[i] = source[a] + (source[b] - source[a]) * (at - a);
      }
    });
    return buffer;
  }

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

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 10;
    limiter.ratio.value = 5;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.16;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.92;
    this.master.connect(limiter).connect(ctx.destination);

    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);

    this.crowdTone = ctx.createBiquadFilter();
    this.crowdTone.type = 'lowpass';
    this.crowdTone.frequency.value = 9000;
    this.crowd = ctx.createGain();
    this.crowd.connect(this.crowdTone).connect(this.master);

    this.reverb = ctx.createConvolver();
    const wet = ctx.createGain();
    wet.gain.value = 0.6;
    this.reverb.connect(wet).connect(this.master);

    this.murmur = ctx.createGain();
    this.murmur.gain.value = MOOD_LEVEL[this.mood];
    this.murmur.connect(this.crowd);

    this.connectBeds();
    if (ctx.state === 'suspended') void ctx.resume();
  }

  private connectBeds(): void {
    const { ctx, reverb, murmur } = this;
    if (!ctx || !reverb || !murmur) return;
    if (!reverb.buffer) {
      const response = this.rendered.get('ir.stadium');
      if (response) reverb.buffer = this.resampled(response, ctx);
    }
    if (!this.murmurSource) {
      const bed = this.buffer('crowd.murmur');
      if (bed) {
        const source = ctx.createBufferSource();
        source.buffer = bed;
        source.loop = true;
        source.connect(murmur);
        source.start();
        this.murmurSource = source;
      }
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.92, this.ctx.currentTime, 0.02);
    }
  }

  suspend(): void {
    this.setCharge(0);
    if (this.ctx?.state === 'running') void this.ctx.suspend();
  }

  private play(name: string, o: PlayOptions): void {
    const { ctx, sfx, reverb } = this;
    const buffer = this.buffer(name);
    if (!ctx || !sfx || !buffer) return;
    const when = ctx.currentTime + (o.delay ?? 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = o.rate ?? 1;

    let tail: AudioNode = source;
    if (o.cutoff !== undefined) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = o.cutoff;
      tail.connect(filter);
      tail = filter;
    }
    const gain = ctx.createGain();
    gain.gain.value = o.gain;
    tail.connect(gain);
    tail = gain;
    if (o.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(o.pan, -1, 1);
      tail.connect(panner);
      tail = panner;
    }
    tail.connect(o.bus ?? sfx);
    if (o.send && reverb) {
      const send = ctx.createGain();
      send.gain.value = o.send;
      tail.connect(send).connect(reverb);
    }
    source.start(when);
  }

  private pick(prefix: string): string {
    return `${prefix}.${Math.floor(Math.random() * VARIANTS)}`;
  }

  hit(s: HitSound): void {
    const near = nearness(s.z);
    const power = clamp01((s.speed - 12) / 24);
    let kind = 'drive';
    if (s.charge > 0.5) kind = 'power';
    else if (s.quality < 0.2) kind = 'frame';
    else if (s.shot === 'smash') kind = 'smash';
    else if (s.shot === 'serve') kind = 'serve';
    else if (s.shot === 'volley') kind = 'volley';
    else if (s.shot === 'lob' || s.quality < 0.8) kind = 'spin';

    const rate = (s.rate ?? 1) * lerp(0.97, 1.05, Math.random());
    this.play(this.pick(`hit.${kind}`), {
      gain: lerp(0.5, 1, power) * near * (1 + s.charge * 0.2),
      pan: s.x / 11,
      rate,
      send: lerp(0.5, 0.26, near),
      cutoff: lerp(4200, 16000, near),
    });
  }

  bounce(speed: number, x: number, z: number, rate = 1): void {
    const near = nearness(z);
    this.play(this.pick('bounce'), {
      gain: lerp(0.16, 0.56, clamp01(speed / 26)) * near,
      pan: x / 11,
      rate: rate * lerp(0.94, 1.08, Math.random()),
      send: lerp(0.4, 0.2, near),
      cutoff: lerp(3000, 12000, near),
    });
  }

  net(rate = 1): void {
    this.play('net.0', { gain: 0.42, rate, send: 0.28 });
  }

  swing(power: number, x: number, z: number, rate = 1): void {
    this.play(this.pick('whoosh'), {
      gain: lerp(0.05, 0.16, clamp01(power)) * nearness(z),
      pan: x / 11,
      rate: rate * lerp(0.92, 1.12, Math.random()),
    });
  }

  toss(): void {
    this.play(this.pick('whoosh'), { gain: 0.035, rate: 1.5 });
  }

  step(x: number, z: number, level: number): void {
    this.play(this.pick('step'), {
      gain: 0.09 * level * nearness(z),
      pan: x / 11,
      rate: lerp(0.9, 1.15, Math.random()),
      send: 0.08,
    });
  }

  squeak(x: number, z: number, level: number): void {
    this.play(this.pick('squeak'), {
      gain: 0.1 * clamp01(level) * nearness(z),
      pan: x / 11,
      rate: lerp(0.9, 1.16, Math.random()),
      send: 0.34,
    });
  }

  fault(): void {
    this.crowdReaction('crowd.groan', 0.16, 0.05);
  }

  click(): void {
    this.play(this.pick('bounce'), { gain: 0.16, rate: 2.2 });
  }

  // --- Crowd ------------------------------------------------------------------

  private crowdReaction(name: string, gain: number, delay: number, rate = 1): void {
    if (!this.crowd) return;
    this.play(name, { gain, delay, rate, send: 0.42, bus: this.crowd });
  }

  /** Spectators talk between points and fall silent while the ball is in play. */
  setCrowdMood(mood: CrowdMood): void {
    this.mood = mood;
    if (this.ctx && this.murmur) {
      this.murmur.gain.setTargetAtTime(MOOD_LEVEL[mood], this.ctx.currentTime, mood === 'idle' ? 0.9 : 0.5);
    }
  }

  applause(level: number, delay = 0.05): void {
    const now = this.ctx?.currentTime ?? 0;
    if (now - this.lastApplause < 0.6) return;
    this.lastApplause = now;
    const big = level > 0.62;
    this.crowdReaction(big ? 'crowd.clapsBig' : 'crowd.clapsLight', lerp(0.32, 0.72, clamp01(level)), delay);
  }

  cheer(level: number): void {
    this.crowdReaction('crowd.cheer', 0.5 * clamp01(level), 0.02, lerp(0.97, 1.05, Math.random()));
  }

  ooh(level: number): void {
    this.crowdReaction('crowd.ooh', 0.42 * clamp01(level), 0.02, lerp(0.96, 1.06, Math.random()));
  }

  groan(level: number): void {
    this.crowdReaction('crowd.groan', 0.36 * clamp01(level), 0.04, lerp(0.96, 1.05, Math.random()));
  }

  /** Dulls the crowd and drops its pitch for slow-motion replays. */
  setSlowMotion(on: boolean): void {
    const { ctx, crowdTone, murmurSource } = this;
    if (!ctx || !crowdTone) return;
    crowdTone.frequency.setTargetAtTime(on ? 1100 : 9000, ctx.currentTime, 0.12);
    murmurSource?.playbackRate.setTargetAtTime(on ? 0.62 : 1, ctx.currentTime, 0.15);
  }

  // --- Power shots --------------------------------------------------------------

  private ensureRiser(): boolean {
    const { ctx, sfx } = this;
    if (!ctx || !sfx) return false;
    if (this.riserGain) return true;
    const noise = this.buffer('noise');
    if (!noise) return false;
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    this.riserFilter = ctx.createBiquadFilter();
    this.riserFilter.type = 'bandpass';
    this.riserFilter.Q.value = 3.2;
    this.riserFilter.frequency.value = 500;
    this.riserGain = ctx.createGain();
    this.riserGain.gain.value = 0;
    source.connect(this.riserFilter).connect(this.riserGain).connect(sfx);
    source.start();

    this.riserTone = ctx.createOscillator();
    this.riserTone.type = 'sawtooth';
    this.riserTone.frequency.value = 70;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 460;
    this.riserToneGain = ctx.createGain();
    this.riserToneGain.gain.value = 0;
    this.riserTone.connect(low).connect(this.riserToneGain).connect(sfx);
    this.riserTone.start();
    return true;
  }

  /** The rising hum while a shot is being wound up. Pass 0 to silence it. */
  setCharge(level: number): void {
    if (level <= 0 && !this.riserGain) return;
    if (!this.ensureRiser()) return;
    const { ctx, riserGain, riserFilter, riserTone, riserToneGain } = this;
    if (!ctx || !riserGain || !riserFilter || !riserTone || !riserToneGain) return;
    const now = ctx.currentTime;
    const k = clamp01(level);
    riserGain.gain.setTargetAtTime(k * 0.046, now, 0.03);
    riserToneGain.gain.setTargetAtTime(k * 0.036, now, 0.03);
    riserFilter.frequency.setTargetAtTime(lerp(420, 3200, k), now, 0.05);
    riserTone.frequency.setTargetAtTime(lerp(62, 165, k), now, 0.05);
  }

  chargeReady(): void {
    this.play('charge.ready', { gain: 0.3, send: 0.4 });
  }
}
