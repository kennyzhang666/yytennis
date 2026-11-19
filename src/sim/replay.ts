import type { Ball } from './ball';
import { BALL_RADIUS, BOUNCE, TICK } from './constants';
import type { IncomingFrame, SceneFrame } from './frame';
import { isCelebrating, shareBallPosition } from './frame';
import { clamp01, lerp } from './math';
import type { Player, Swing, SwingHand } from './player';
import type { ShotKind } from './shot';
import { FAR, NEAR, type Vec3 } from './types';
import type { GameEvent, PointReason, World } from './world';

const FRAME_RATE = 60;
const MAX_SECONDS = 16;
const MAX_CLIP_SECONDS = 9;
const PLAYER_FIELDS = 29;
const FRAME_FIELDS = PLAYER_FIELDS * 2;

/** Seconds of play kept before the second-last shot. */
const LEAD_IN = 0.55;
const SERVE_LEAD_IN = 0.85;

const HANDS: SwingHand[] = ['fore', 'back', 'over'];
const SHOTS: ShotKind[] = ['drive', 'volley', 'lob', 'smash', 'serve'];

const F = {
  x: 0,
  y: 1,
  z: 2,
  vx: 3,
  vy: 4,
  vz: 5,
  ground: 6,
  toss: 7,
  charge: 8,
  charging: 9,
  serving: 10,
  celebrating: 11,
  swing: 12,
  swingT: 13,
  approach: 14,
  releaseT: 15,
  hand: 16,
  swingFlags: 17,
  swingCharge: 18,
  shot: 19,
  contactX: 20,
  contactY: 21,
  contactZ: 22,
  incoming: 23,
  inT: 24,
  inX: 25,
  inY: 26,
  inZ: 27,
  inFlags: 28,
} as const;

/** One stretch of ball flight. Stored exactly, so slow motion stays smooth. */
export interface BallSegment {
  t: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  g: number;
  spin: number;
  charge: number;
  held: boolean;
  rolling: boolean;
}

export interface TimedEvent {
  t: number;
  event: GameEvent;
}

type HitEvent = Extract<GameEvent, { type: 'hit' }>;
type PointEvent = Extract<GameEvent, { type: 'point' }>;

function evalSegment(s: BallSegment, dt: number, pos: Vec3, vel: Vec3): void {
  if (s.held) {
    pos.x = s.x;
    pos.y = s.y;
    pos.z = s.z;
    vel.x = 0;
    vel.y = 0;
    vel.z = 0;
    return;
  }
  if (s.rolling) {
    const speed = Math.hypot(s.vx, s.vz);
    const stop = speed / BOUNCE.rollFriction;
    const t = Math.min(dt, stop);
    const distance = speed * t - 0.5 * BOUNCE.rollFriction * t * t;
    const ux = speed > 1e-6 ? s.vx / speed : 0;
    const uz = speed > 1e-6 ? s.vz / speed : 0;
    const now = speed - BOUNCE.rollFriction * t;
    pos.x = s.x + ux * distance;
    pos.y = BALL_RADIUS;
    pos.z = s.z + uz * distance;
    vel.x = ux * now;
    vel.y = 0;
    vel.z = uz * now;
    return;
  }
  pos.x = s.x + s.vx * dt;
  pos.y = Math.max(BALL_RADIUS, s.y + s.vy * dt - 0.5 * s.g * dt * dt);
  pos.z = s.z + s.vz * dt;
  vel.x = s.vx;
  vel.y = s.vy - s.g * dt;
  vel.z = s.vz;
}

/** A finished point, ready to be watched again from any angle at any speed. */
export class ReplayClip {
  /** Larger for points worth showing again automatically. */
  readonly excitement: number;
  readonly hits: HitEvent[];
  readonly point: PointEvent;
  readonly pointTime: number;
  readonly lastBounce: { t: number; x: number; z: number; isIn: boolean } | null;

  private readonly swings: [Swing, Swing];
  private readonly incoming: [IncomingFrame, IncomingFrame];

  constructor(
    readonly start: number,
    readonly end: number,
    private readonly frameStart: number,
    private readonly frames: Float32Array,
    readonly segments: BallSegment[],
    readonly events: TimedEvent[],
  ) {
    this.hits = events.filter((e): e is TimedEvent & { event: HitEvent } => e.event.type === 'hit').map((e) => e.event);
    const pointEntry = events.find((e) => e.event.type === 'point');
    if (!pointEntry || pointEntry.event.type !== 'point') throw new Error('A replay needs a finished point');
    this.point = pointEntry.event;
    this.pointTime = pointEntry.t;

    let bounce: ReplayClip['lastBounce'] = null;
    for (const e of events) {
      if (e.t > this.pointTime + 1e-6) break;
      if (e.event.type === 'bounce' && e.event.live) {
        bounce = { t: e.t, x: e.event.x, z: e.event.z, isIn: e.event.isIn };
      }
    }
    this.lastBounce = bounce;
    this.excitement = this.score();

    const blankSwing = (): Swing => ({
      t: 0,
      armed: false,
      serve: false,
      hand: 'fore',
      approach: 0,
      releaseT: null,
      whiff: false,
      contact: null,
      timingError: 0,
      charge: 0,
      shot: null,
    });
    this.swings = [blankSwing(), blankSwing()];
    const blankIncoming = (): IncomingFrame => ({ t: 0, x: 0, y: 0, z: 0, reachable: false, bounced: false });
    this.incoming = [blankIncoming(), blankIncoming()];
  }

  get duration(): number {
    return this.end - this.start;
  }

  /** Time of each moment a slow-motion ramp should linger on. */
  keyTimes(): number[] {
    const keys: number[] = [];
    for (const e of this.events) {
      if (e.t < this.start || e.t > this.end) continue;
      if (e.event.type === 'hit' || e.event.type === 'net' || (e.event.type === 'bounce' && e.event.live)) {
        keys.push(e.t);
      }
    }
    return keys;
  }

  private score(): number {
    const { point, hits } = this;
    const last = hits[hits.length - 1];
    let score = Math.min(5, point.rally * 0.42);
    if (point.reason === 'winner') score += 2;
    if (point.reason === 'ace') score += 2.5;
    if (last?.shot === 'smash') score += 2;
    if (last) score += last.charge * 3;
    if (point.margin !== null && Math.abs(point.margin) < 0.3) score += 1.5;
    if (point.matchPoint) score += 6;
    return score;
  }

  private ballAt(t: number, out: SceneFrame): void {
    const list = this.segments;
    let index = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].t <= t) {
        index = i;
        break;
      }
    }
    const s = list[index];
    if (!s) return;
    evalSegment(s, Math.max(0, t - s.t), out.ball.pos, out.ball.vel);
    out.ball.spin = s.spin;
    out.ball.charge = s.charge;
    out.ball.held = s.held;
  }

  sample(t: number, out: SceneFrame): void {
    this.ballAt(t, out);
    const count = this.frames.length / FRAME_FIELDS;
    const exact = Math.max(0, Math.min(count - 1, (t - this.frameStart) * FRAME_RATE));
    const a = Math.min(count - 1, Math.floor(exact));
    const b = Math.min(count - 1, a + 1);
    const k = exact - a;
    for (const side of [NEAR, FAR] as const) {
      this.samplePlayer(side, a, b, k, out);
    }
    shareBallPosition(out);
  }

  private samplePlayer(side: 0 | 1, a: number, b: number, k: number, out: SceneFrame): void {
    const d = this.frames;
    const ia = a * FRAME_FIELDS + side * PLAYER_FIELDS;
    const ib = b * FRAME_FIELDS + side * PLAYER_FIELDS;
    const f = out.players[side];
    const mix = (field: number) => lerp(d[ia + field], d[ib + field], k);
    f.pos.x = mix(F.x);
    f.pos.y = mix(F.y);
    f.pos.z = mix(F.z);
    f.vel.x = mix(F.vx);
    f.vel.y = mix(F.vy);
    f.vel.z = mix(F.vz);
    f.onGround = d[ia + F.ground] > 0.5;
    f.tossTime = d[ib + F.toss] >= 0 && d[ia + F.toss] >= 0 ? mix(F.toss) : d[ia + F.toss];
    f.chargeLevel = mix(F.charge);
    f.charging = d[ia + F.charging] > 0.5;
    f.serving = d[ia + F.serving] > 0.5;
    f.celebrating = d[ia + F.celebrating] > 0.5;

    if (d[ia + F.swing] > 0.5) {
      const s = this.swings[side];
      const flags = d[ia + F.swingFlags];
      const continues = d[ib + F.swing] > 0.5 && d[ib + F.swingT] >= d[ia + F.swingT];
      s.t = continues ? mix(F.swingT) : d[ia + F.swingT] + k / FRAME_RATE;
      s.approach = continues ? mix(F.approach) : d[ia + F.approach];
      const release = d[ia + F.releaseT];
      s.releaseT = release >= 0 ? release : null;
      s.hand = HANDS[d[ia + F.hand]] ?? 'fore';
      s.armed = (flags & 1) !== 0;
      s.serve = (flags & 2) !== 0;
      s.whiff = (flags & 4) !== 0;
      s.charge = d[ia + F.swingCharge];
      s.shot = SHOTS[d[ia + F.shot]] ?? null;
      if (flags & 8) {
        s.contact = s.contact ?? { x: 0, y: 0, z: 0 };
        s.contact.x = d[ia + F.contactX];
        s.contact.y = d[ia + F.contactY];
        s.contact.z = d[ia + F.contactZ];
      } else {
        s.contact = null;
      }
      f.swing = s;
    } else {
      f.swing = null;
    }

    if (d[ia + F.incoming] > 0.5) {
      const c = this.incoming[side];
      const hasNext = d[ib + F.incoming] > 0.5;
      c.t = hasNext ? mix(F.inT) : d[ia + F.inT] - k / FRAME_RATE;
      c.x = hasNext ? mix(F.inX) : d[ia + F.inX];
      c.y = hasNext ? mix(F.inY) : d[ia + F.inY];
      c.z = hasNext ? mix(F.inZ) : d[ia + F.inZ];
      const flags = d[ia + F.inFlags];
      c.reachable = (flags & 1) !== 0;
      c.bounced = (flags & 2) !== 0;
      f.incoming = c;
    } else {
      f.incoming = null;
    }
  }
}

/** Records the current point so it can be shown again once it has finished. */
export class ReplayRecorder {
  private readonly capacity = MAX_SECONDS * FRAME_RATE;
  private readonly ring = new Float32Array(this.capacity * FRAME_FIELDS);
  private head = 0;
  private count = 0;
  private newestFrame = 0;
  private segments: BallSegment[] = [];
  private events: TimedEvent[] = [];
  private time = 0;
  private readonly checkPos: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly checkVel: Vec3 = { x: 0, y: 0, z: 0 };

  beginPoint(): void {
    this.head = 0;
    this.count = 0;
    this.segments = [];
    this.events = [];
  }

  capture(world: World): void {
    this.time = world.tick * TICK;
    this.captureBall(world.ball);
    if (world.tick % 2 === 0) this.captureFrame(world);
  }

  note(event: GameEvent): void {
    if (event.type === 'serve-ready') {
      this.beginPoint();
      return;
    }
    if (event.type === 'match-end') return;
    this.events.push({ t: this.time, event });
  }

  private captureBall(b: Ball): void {
    const last = this.segments[this.segments.length - 1];
    if (last) {
      if (last.held && b.held) return;
      if (!last.held && !b.held && last.rolling === b.rolling && last.spin === b.spin && last.charge === b.charge) {
        const { checkPos: p, checkVel: v } = this;
        evalSegment(last, this.time - last.t, p, v);
        const drift =
          Math.abs(p.x - b.pos.x) + Math.abs(p.z - b.pos.z) + Math.abs(v.x - b.vel.x) + Math.abs(v.y - b.vel.y) + Math.abs(v.z - b.vel.z);
        if (drift < 1e-3) return;
      }
    }
    this.segments.push({
      t: this.time,
      x: b.pos.x,
      y: b.pos.y,
      z: b.pos.z,
      vx: b.vel.x,
      vy: b.vel.y,
      vz: b.vel.z,
      g: b.g,
      spin: b.spin,
      charge: b.charge,
      held: b.held,
      rolling: b.rolling,
    });
  }

  private writePlayer(world: World, p: Player, at: number): void {
    const d = this.ring;
    d[at + F.x] = p.pos.x;
    d[at + F.y] = p.pos.y;
    d[at + F.z] = p.pos.z;
    d[at + F.vx] = p.vel.x;
    d[at + F.vy] = p.vel.y;
    d[at + F.vz] = p.vel.z;
    d[at + F.ground] = p.onGround ? 1 : 0;
    d[at + F.toss] = p.tossTime;
    d[at + F.charge] = p.chargeLevel;
    d[at + F.charging] = p.chargeTime >= 0 && p.tossTime < 0 ? 1 : 0;
    d[at + F.serving] = world.phase === 'ready' && world.server === p.side ? 1 : 0;
    d[at + F.celebrating] = isCelebrating(world, p.side) ? 1 : 0;

    const s = p.swing;
    d[at + F.swing] = s ? 1 : 0;
    if (s) {
      d[at + F.swingT] = s.t;
      d[at + F.approach] = s.approach;
      d[at + F.releaseT] = s.releaseT ?? -1;
      d[at + F.hand] = HANDS.indexOf(s.hand);
      d[at + F.swingFlags] = (s.armed ? 1 : 0) | (s.serve ? 2 : 0) | (s.whiff ? 4 : 0) | (s.contact ? 8 : 0);
      d[at + F.swingCharge] = s.charge;
      d[at + F.shot] = s.shot ? SHOTS.indexOf(s.shot) : -1;
      if (s.contact) {
        d[at + F.contactX] = s.contact.x;
        d[at + F.contactY] = s.contact.y;
        d[at + F.contactZ] = s.contact.z;
      }
    }

    const c = world.crossing(p.side);
    d[at + F.incoming] = c ? 1 : 0;
    if (c) {
      d[at + F.inT] = c.t;
      d[at + F.inX] = c.x;
      d[at + F.inY] = c.y;
      d[at + F.inZ] = c.z;
      d[at + F.inFlags] = (c.reachable ? 1 : 0) | (c.bounced ? 2 : 0);
    }
  }

  private captureFrame(world: World): void {
    const at = this.head * FRAME_FIELDS;
    this.writePlayer(world, world.players[NEAR], at);
    this.writePlayer(world, world.players[FAR], at + PLAYER_FIELDS);
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.capacity, this.count + 1);
    this.newestFrame = this.time;
  }

  /** Builds a clip covering the final exchange of the point just played. */
  buildClip(): ReplayClip | null {
    if (this.count < 2 || !this.events.some((e) => e.event.type === 'point')) return null;

    const hitTimes = this.events.filter((e) => e.event.type === 'hit').map((e) => e.t);
    const oldestFrame = this.newestFrame - (this.count - 1) / FRAME_RATE;
    const n = hitTimes.length;
    let start = this.newestFrame - 2;
    if (n >= 2) start = hitTimes[n - 2] - LEAD_IN;
    else if (n === 1) start = hitTimes[0] - SERVE_LEAD_IN;
    start = Math.max(start, oldestFrame, this.newestFrame - MAX_CLIP_SECONDS);

    const skip = Math.max(0, Math.floor((start - oldestFrame) * FRAME_RATE));
    const used = this.count - skip;
    if (used < 2) return null;
    const frames = new Float32Array(used * FRAME_FIELDS);
    const first = (this.head - this.count + skip + this.capacity * 2) % this.capacity;
    for (let i = 0; i < used; i++) {
      const from = ((first + i) % this.capacity) * FRAME_FIELDS;
      frames.set(this.ring.subarray(from, from + FRAME_FIELDS), i * FRAME_FIELDS);
    }
    const frameStart = oldestFrame + skip / FRAME_RATE;
    return new ReplayClip(
      frameStart,
      this.newestFrame,
      frameStart,
      frames,
      this.segments.map((s) => ({ ...s })),
      this.events.filter((e) => e.t >= frameStart - 1e-6),
    );
  }
}

/** Playback speed at a moment of the clip: slower around the shots that matter. */
export function replayRate(t: number, keys: readonly number[], lastKey: number): number {
  let closeness = 0;
  for (const key of keys) {
    const reach = key === lastKey ? 0.42 : 0.22;
    closeness = Math.max(closeness, 1 - Math.abs(t - key) / reach);
  }
  const k = clamp01(closeness);
  return lerp(0.72, 0.2, k * k * (3 - 2 * k));
}

export type { PointReason };
