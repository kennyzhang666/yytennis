import { ARENA, CHARGE, PLAYER, SWING } from './constants';
import { clamp, clamp01 } from './math';
import type { ShotKind } from './shot';
import { sideDir, type Side, type Vec3 } from './types';

export type SwingHand = 'fore' | 'back' | 'over';

export interface Swing {
  /** Seconds since the swing was committed. */
  t: number;
  /** Still waiting for the ball to arrive. */
  armed: boolean;
  serve: boolean;
  hand: SwingHand;
  /** 0..1, how close the ball is to the contact point. */
  approach: number;
  /** Swing time at which contact (or the miss) happened. */
  releaseT: number | null;
  whiff: boolean;
  contact: Vec3 | null;
  timingError: number;
  /** 0..1, stored power carried into this swing. */
  charge: number;
  /** The shot that was actually played, known from contact onwards. */
  shot: ShotKind | null;
}

export interface Player {
  side: Side;
  pos: Vec3;
  prevPos: Vec3;
  vel: Vec3;
  onGround: boolean;
  swing: Swing | null;
  /** Seconds since the serve toss began, or -1. */
  tossTime: number;
  /** Seconds the swing button has been held for a charge, or -1. */
  chargeTime: number;
  chargeLevel: number;
  speedFactor: number;
  powerScale: number;
  reachScale: number;
  timingScale: number;
  contactDelay: number;
  lastAimX: number;
}

export function chargeLevelFor(heldSeconds: number): number {
  return clamp01((heldSeconds - CHARGE.startAfter) / (CHARGE.fullAfter - CHARGE.startAfter));
}

export function createPlayer(side: Side): Player {
  const z = sideDir(side) * 12.5;
  return {
    side,
    pos: { x: 0, y: 0, z },
    prevPos: { x: 0, y: 0, z },
    vel: { x: 0, y: 0, z: 0 },
    onGround: true,
    swing: null,
    tossTime: -1,
    chargeTime: -1,
    chargeLevel: 0,
    speedFactor: 1,
    powerScale: 1,
    reachScale: 1,
    timingScale: 1,
    contactDelay: SWING.mouseDelay,
    lastAimX: 0,
  };
}

export interface MoveLimits {
  minX: number;
  maxX: number;
  /** Bounds along the player's own half, measured as |z|. */
  minAbsZ: number;
  maxAbsZ: number;
}

export const FREE_MOVEMENT: MoveLimits = {
  minX: -ARENA.maxX,
  maxX: ARENA.maxX,
  minAbsZ: ARENA.minZ,
  maxAbsZ: ARENA.maxZ,
};

export function movePlayer(
  p: Player,
  moveX: number,
  moveZ: number,
  speedScale: number,
  limits: MoveLimits,
  dt: number,
): void {
  let mx = moveX;
  let mz = moveZ;
  const magnitude = Math.hypot(mx, mz);
  if (magnitude > 1) {
    mx /= magnitude;
    mz /= magnitude;
  }

  const top = PLAYER.maxSpeed * p.speedFactor * speedScale;
  const dvx = mx * top - p.vel.x;
  const dvz = mz * top - p.vel.z;
  const accel = !p.onGround ? PLAYER.airAccel : magnitude > 0.05 ? PLAYER.accel : PLAYER.brake;
  const change = Math.hypot(dvx, dvz);
  const allowed = accel * dt;
  const k = change > allowed ? allowed / change : 1;
  p.vel.x += dvx * k;
  p.vel.z += dvz * k;

  p.pos.x += p.vel.x * dt;
  p.pos.z += p.vel.z * dt;

  const dir = sideDir(p.side);
  const x = clamp(p.pos.x, limits.minX, limits.maxX);
  if (x !== p.pos.x) {
    p.pos.x = x;
    p.vel.x = 0;
  }
  const absZ = clamp(p.pos.z * dir, limits.minAbsZ, limits.maxAbsZ);
  if (absZ !== p.pos.z * dir) {
    p.pos.z = absZ * dir;
    p.vel.z = 0;
  }

  if (!p.onGround) {
    p.pos.y += p.vel.y * dt - 0.5 * PLAYER.gravity * dt * dt;
    p.vel.y -= PLAYER.gravity * dt;
    if (p.pos.y <= 0) {
      p.pos.y = 0;
      p.vel.y = 0;
      p.onGround = true;
    }
  }
}

/** The racket's reach is an ellipse on the ground plus a height band. */
export function inReach(p: Player, ball: Vec3): boolean {
  const dir = sideDir(p.side);
  const dx = ball.x - p.pos.x;
  const front = (p.pos.z - ball.z) * dir;
  const rx = PLAYER.reachX * p.reachScale;
  const centerZ = (PLAYER.reachFront - PLAYER.reachBack) / 2;
  const rz = ((PLAYER.reachFront + PLAYER.reachBack) / 2) * p.reachScale;
  const planar = (dx / rx) ** 2 + ((front - centerZ) / rz) ** 2;
  if (planar > 1) return false;
  const h = ball.y - p.pos.y;
  return h >= PLAYER.reachBottom && h <= PLAYER.reachTop;
}
