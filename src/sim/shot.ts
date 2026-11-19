import { BALL_RADIUS, COURT, GRAVITY, netHeight, SWING } from './constants';
import { clamp, gaussian, lerp, smoothstep, type Rng } from './math';
import type { CourtPoint, Vec3 } from './types';

export type ShotKind = 'drive' | 'volley' | 'lob' | 'smash' | 'serve';
export type TimingLabel = 'perfect' | 'good' | 'early' | 'late';

export interface ShotProfile {
  g: number;
  restitution: number;
  retention: number;
  minSpeed: number;
  maxSpeed: number;
  clearance: number;
  spin: number;
}

export const SHOT_PROFILES: Record<ShotKind, ShotProfile> = {
  drive: { g: 14, restitution: 0.74, retention: 0.72, minSpeed: 15, maxSpeed: 28.5, clearance: 0.42, spin: 48 },
  volley: { g: 10.5, restitution: 0.66, retention: 0.64, minSpeed: 12, maxSpeed: 22, clearance: 0.22, spin: -18 },
  lob: { g: GRAVITY, restitution: 0.74, retention: 0.62, minSpeed: 8, maxSpeed: 12, clearance: 1.8, spin: 30 },
  smash: { g: 11, restitution: 0.82, retention: 0.84, minSpeed: 26, maxSpeed: 38, clearance: 0.12, spin: 60 },
  serve: { g: 11.5, restitution: 0.76, retention: 0.74, minSpeed: 20, maxSpeed: 31, clearance: 0.1, spin: 40 },
};

/** 1 for a perfectly timed press, falling to 0 at the edge of the timing window. */
export function timingQuality(error: number, scale = 1): number {
  return 1 - smoothstep(SWING.perfectError, SWING.zeroError, Math.abs(error) / scale);
}

export function timingLabel(quality: number, error: number): TimingLabel {
  if (quality >= 0.93) return 'perfect';
  if (quality >= 0.5) return 'good';
  return error < 0 ? 'early' : 'late';
}

/**
 * Shortest flight time for which a parabola from `from` to the target passes
 * `clearance` metres above the net. At a fraction s of the flight the ball is at
 * y = h(1-s) + r*s + g*T^2*s(1-s)/2, which can be solved directly for T.
 */
export function flightTimeToClear(from: Vec3, targetX: number, targetZ: number, g: number, clearance: number): number {
  const near = Math.abs(from.z);
  const far = Math.abs(targetZ);
  const s = near / Math.max(1e-6, near + far);
  const k = s * (1 - s);
  if (k < 1e-4) return 0;
  const netX = from.x + (targetX - from.x) * s;
  const needed = netHeight(netX) + clearance + BALL_RADIUS - from.y * (1 - s) - BALL_RADIUS * s;
  return needed <= 0 ? 0 : Math.sqrt((2 * needed) / (g * k));
}

export interface ShotRequest {
  from: Vec3;
  targetX: number;
  targetZ: number;
  g: number;
  /** Desired horizontal speed. */
  speed: number;
  clearance: number;
  /** Flight peaks at this height (used for lobs). */
  apex?: number;
}

export interface ShotSolution {
  vx: number;
  vy: number;
  vz: number;
  time: number;
}

/** The target comes first: the launch velocity is solved so the ball lands on it. */
export function solveShot(req: ShotRequest): ShotSolution {
  const { from, targetX, targetZ, g } = req;
  const dx = targetX - from.x;
  const dz = targetZ - from.z;
  const distance = Math.hypot(dx, dz);
  const clearTime = flightTimeToClear(from, targetX, targetZ, g, req.clearance);

  let time = distance / Math.max(1, req.speed);
  if (req.apex !== undefined) {
    const rise = Math.max(0.2, req.apex - from.y);
    const up = Math.sqrt(2 * g * rise);
    time = (up + Math.sqrt(up * up + 2 * g * Math.max(0, from.y - BALL_RADIUS))) / g;
  }
  time = Math.max(time, clearTime, 0.22);

  return {
    vx: dx / time,
    vy: (BALL_RADIUS - from.y + 0.5 * g * time * time) / time,
    vz: dz / time,
    time,
  };
}

/** A mishit that travels at normal pace and strikes the net at the given height. */
export function solveIntoNet(
  from: Vec3,
  targetX: number,
  targetZ: number,
  g: number,
  speed: number,
  strikeHeight: number,
): ShotSolution {
  const dx = targetX - from.x;
  const dz = targetZ - from.z;
  const toNet = Math.abs(from.z) / Math.max(1e-6, Math.abs(dz));
  const time = Math.max(0.08, (Math.hypot(dx, dz) * toNet) / Math.max(1, speed));
  return {
    vx: (dx * toNet) / time,
    vy: (strikeHeight - from.y + 0.5 * g * time * time) / time,
    vz: (dz * toNet) / time,
    time,
  };
}

export interface ErrorInput {
  target: CourtPoint;
  kind: ShotKind;
  quality: number;
  timingError: number;
  /** Which side of the player the ball is on: controls early/late pull direction. */
  ballSide: number;
  /** Multiplier on random scatter. Second serves use a smaller value. */
  scatter: number;
  /** Which way the target half lies along z. */
  targetDir: 1 | -1;
  rng: Rng;
}

export interface ErrorResult {
  x: number;
  z: number;
  mishit: 'none' | 'net' | 'long';
}

/** Turns timing into outcome: mistimed shots drift, and very poor ones go wrong. */
export function applyShotError(input: ErrorInput): ErrorResult {
  const { target, kind, quality, timingError, ballSide, scatter, targetDir, rng } = input;
  const miss = 1 - quality;
  const serving = kind === 'serve';

  const pull = serving ? 0 : clamp(ballSide * timingError * 6.5, -2.4, 2.4);
  const spreadX = (serving ? 0.03 + miss * 0.8 : 0.04 + miss * 0.42) * scatter;
  const spreadZ = (serving ? 0.05 + miss * 1.05 : 0.08 + miss * 0.75) * scatter;
  let x = target.x + pull + gaussian(rng) * spreadX;
  let z = target.z + gaussian(rng) * spreadZ * targetDir;

  let mishit: ErrorResult['mishit'] = 'none';
  const threshold = 0.28;
  if (quality < threshold && rng() < (threshold - quality) * 3.2 * scatter) {
    if (rng() < 0.5) {
      mishit = 'net';
    } else {
      mishit = 'long';
      if (rng() < 0.3) {
        x = (x >= 0 ? 1 : -1) * (COURT.halfWidth + lerp(0.3, 1.6, rng()));
      } else {
        const limit = serving ? COURT.serviceLine : COURT.halfLength;
        z = targetDir * (limit + lerp(0.4, 2, rng()));
      }
    }
  }

  // A live shot must stay on the far side of the net.
  if (z * targetDir < 0.4) z = targetDir * 0.4;
  x = clamp(x, -COURT.doublesHalfWidth - 2, COURT.doublesHalfWidth + 2);
  return { x, z, mishit };
}
