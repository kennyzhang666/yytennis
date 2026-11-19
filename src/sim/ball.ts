import { BALL_RADIUS, BOUNCE, GRAVITY, hitsNet } from './constants';
import type { Vec3 } from './types';

export interface Ball {
  pos: Vec3;
  prevPos: Vec3;
  vel: Vec3;
  /** Effective gravity of the current flight. Topspin is modelled as extra gravity. */
  g: number;
  restitution: number;
  retention: number;
  /** Visual spin in rad/s. */
  spin: number;
  held: boolean;
  rolling: boolean;
}

export type BallEvent =
  | { type: 'bounce'; x: number; z: number; speed: number }
  | { type: 'net'; x: number; y: number; speed: number };

export function createBall(): Ball {
  return {
    pos: { x: 0, y: 1, z: 0 },
    prevPos: { x: 0, y: 1, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    g: GRAVITY,
    restitution: BOUNCE.restitution,
    retention: BOUNCE.retention,
    spin: 0,
    held: true,
    rolling: false,
  };
}

export function timeToGround(y: number, vy: number, g: number): number {
  if (g <= 0) return Infinity;
  const height = Math.max(0, y - BALL_RADIUS);
  return (vy + Math.sqrt(vy * vy + 2 * g * height)) / g;
}

function advance(b: Ball, t: number): void {
  b.pos.x += b.vel.x * t;
  b.pos.z += b.vel.z * t;
  b.pos.y += b.vel.y * t - 0.5 * b.g * t * t;
  b.vel.y -= b.g * t;
}

function roll(b: Ball, dt: number): void {
  const speed = Math.hypot(b.vel.x, b.vel.z);
  if (speed < 0.02) {
    b.vel.x = 0;
    b.vel.z = 0;
    return;
  }
  const next = Math.max(0, speed - BOUNCE.rollFriction * dt);
  const k = next / speed;
  b.vel.x *= k;
  b.vel.z *= k;
  b.pos.x += b.vel.x * dt;
  b.pos.z += b.vel.z * dt;
}

/** Moves the ball exactly along its parabola, stopping at the ground and at the net. */
export function stepBall(b: Ball, dt: number, out: BallEvent[]): void {
  if (b.held) return;
  if (b.rolling) {
    roll(b, dt);
    return;
  }
  let left = dt;
  for (let guard = 0; guard < 4 && left > 1e-9; guard++) {
    const toGround = timeToGround(b.pos.y, b.vel.y, b.g);
    const toNet = b.vel.z !== 0 && b.pos.z * b.vel.z < 0 ? -b.pos.z / b.vel.z : Infinity;
    const step = Math.min(left, toGround, toNet);
    advance(b, step);
    left -= step;

    if (step === toNet && toNet <= toGround) {
      b.pos.z = 0;
      if (hitsNet(b.pos.x, b.pos.y)) {
        const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
        out.push({ type: 'net', x: b.pos.x, y: b.pos.y, speed });
        b.pos.z = -Math.sign(b.vel.z) * 0.03;
        b.vel.z *= -0.12;
        b.vel.x *= 0.35;
        b.vel.y = Math.min(b.vel.y, 0.5) * 0.25;
        b.g = GRAVITY;
        b.spin *= 0.2;
      }
    } else if (step === toGround) {
      b.pos.y = BALL_RADIUS;
      const impact = -b.vel.y;
      out.push({
        type: 'bounce',
        x: b.pos.x,
        z: b.pos.z,
        speed: Math.hypot(b.vel.x, impact, b.vel.z),
      });
      b.vel.y = impact * b.restitution;
      b.vel.x *= b.retention;
      b.vel.z *= b.retention;
      b.g = GRAVITY;
      b.restitution = BOUNCE.restitution;
      b.retention = BOUNCE.retention;
      if (b.vel.y < BOUNCE.rollSpeed) {
        b.vel.y = 0;
        b.rolling = true;
        return;
      }
    }
  }
}

export interface PathSegment {
  t0: number;
  t1: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  g: number;
}

export interface BallPath {
  segments: PathSegment[];
  hitsNet: boolean;
  firstBounce: { t: number; x: number; z: number } | null;
}

/** Closed-form prediction of the next flights, used by markers, timing and the AI. */
export function predictPath(b: Ball, bounces = 2): BallPath {
  const path: BallPath = { segments: [], hitsNet: false, firstBounce: null };
  if (b.held || b.rolling) return path;

  let t = 0;
  let { x, y, z } = b.pos;
  let { x: vx, y: vy, z: vz } = b.vel;
  let g = b.g;
  let restitution = b.restitution;
  let retention = b.retention;

  for (let i = 0; i < bounces; i++) {
    const flight = timeToGround(y, vy, g);
    if (vz !== 0 && z * vz < 0) {
      const toNet = -z / vz;
      if (toNet < flight) {
        const netY = y + vy * toNet - 0.5 * g * toNet * toNet;
        if (hitsNet(x + vx * toNet, netY)) {
          path.segments.push({ t0: t, t1: t + toNet, x, y, z, vx, vy, vz, g });
          path.hitsNet = true;
          return path;
        }
      }
    }
    path.segments.push({ t0: t, t1: t + flight, x, y, z, vx, vy, vz, g });

    x += vx * flight;
    z += vz * flight;
    t += flight;
    if (i === 0) path.firstBounce = { t, x, z };

    vy = -(vy - g * flight) * restitution;
    vx *= retention;
    vz *= retention;
    y = BALL_RADIUS;
    g = GRAVITY;
    restitution = BOUNCE.restitution;
    retention = BOUNCE.retention;
    if (vy < BOUNCE.rollSpeed) break;
  }
  return path;
}

export function positionAt(path: BallPath, t: number, out: Vec3): boolean {
  for (const s of path.segments) {
    if (t <= s.t1) {
      const dt = Math.max(0, t - s.t0);
      out.x = s.x + s.vx * dt;
      out.y = s.y + s.vy * dt - 0.5 * s.g * dt * dt;
      out.z = s.z + s.vz * dt;
      return true;
    }
  }
  return false;
}

/** First time the predicted ball reaches the plane z = planeZ, or null. */
export function timeToPlane(path: BallPath, planeZ: number): number | null {
  for (const s of path.segments) {
    if (s.vz === 0) continue;
    const dt = (planeZ - s.z) / s.vz;
    if (dt >= 0 && s.t0 + dt <= s.t1) return s.t0 + dt;
  }
  return null;
}
