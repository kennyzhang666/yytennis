import { positionAt } from './ball';
import { ARENA, COURT, PLAYER, SWING, TICK } from './constants';
import { clamp, clamp01, createRng, gaussian, lerp, type Rng } from './math';
import type { Player } from './player';
import { emptyIntent, otherSide, sideDir, type PlayerIntent, type Side, type Vec3 } from './types';
import { IDEAL_TOSS_TIME, type World } from './world';

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface AIProfile {
  reaction: number;
  speed: number;
  /** Multiplier on racket reach. */
  reach: number;
  /** Multiplier on shot pace. */
  power: number;
  timingSigma: number;
  /** Extra timing noise when rushed by a fast ball. */
  pressure: number;
  /** Chance per shot of a clearly mistimed swing. */
  blunder: number;
  /** Extra blunder chance when rushed or pulled wide. */
  pressureBlunder: number;
  predictError: number;
  /** Chance of aiming away from the opponent. */
  openCourt: number;
  maxU: number;
  minV: number;
  maxV: number;
  lobChance: number;
  /** Chance of correctly leaving a ball that is going out. */
  judgement: number;
  serveU: number;
  serveV: number;
  /** Chance of winding up a power shot when there is time for one. */
  chargeChance: number;
}

export const AI_PROFILES: Record<Difficulty, AIProfile> = {
  easy: {
    reaction: 0.36,
    speed: 0.58,
    reach: 0.62,
    power: 0.74,
    timingSigma: 0.08,
    pressure: 0.8,
    blunder: 0.15,
    pressureBlunder: 0.2,
    predictError: 0.55,
    openCourt: 0.45,
    maxU: 0.56,
    minV: 0.48,
    maxV: 0.76,
    lobChance: 0.1,
    judgement: 0.35,
    serveU: 0.3,
    serveV: 0.62,
    chargeChance: 0.05,
  },
  normal: {
    reaction: 0.25,
    speed: 0.7,
    reach: 0.72,
    power: 0.88,
    timingSigma: 0.056,
    pressure: 0.9,
    blunder: 0.09,
    pressureBlunder: 0.22,
    predictError: 0.3,
    openCourt: 0.68,
    maxU: 0.76,
    minV: 0.58,
    maxV: 0.88,
    lobChance: 0.22,
    judgement: 0.7,
    serveU: 0.55,
    serveV: 0.76,
    chargeChance: 0.13,
  },
  hard: {
    reaction: 0.16,
    speed: 0.86,
    reach: 0.85,
    power: 1,
    timingSigma: 0.036,
    pressure: 1,
    blunder: 0.04,
    pressureBlunder: 0.12,
    predictError: 0.12,
    openCourt: 0.86,
    maxU: 0.9,
    minV: 0.68,
    maxV: 0.96,
    lobChance: 0.35,
    judgement: 0.95,
    serveU: 0.78,
    serveV: 0.9,
    chargeChance: 0.24,
  },
};

export const tuningFor = (profile: AIProfile) => ({
  speedFactor: profile.speed,
  reachScale: profile.reach,
  powerScale: profile.power,
});

interface Intercept {
  x: number;
  z: number;
  t: number;
}

/** Plays through the same intent interface as a human, with human-like limits. */
export class AIController {
  readonly intent: PlayerIntent = emptyIntent();
  private readonly rng: Rng;
  private readonly at: Vec3 = { x: 0, y: 0, z: 0 };
  private seenHit = -1;
  private seenReady = -1;
  private react = 0;
  private replan = 0;
  private plannedError = 0;
  private pressedFor = -1;
  private leaveBall = false;
  private targetX = 0;
  private targetZ = 0;
  private noiseX = 0;
  private noiseZ = 0;
  private serveDelay = 1;
  private wantCharge = false;
  private charging = false;
  private chargeServe = false;

  constructor(
    readonly side: Side,
    readonly profile: AIProfile,
    seed = 7,
  ) {
    this.rng = createRng(seed + side * 101);
  }

  update(world: World): PlayerIntent {
    const intent = this.intent;
    const me = world.players[this.side];
    intent.swing = false;
    intent.held = false;
    intent.jump = false;
    intent.moveX = 0;
    intent.moveZ = 0;

    switch (world.phase) {
      case 'ready':
        this.prepareServe(world);
        if (world.server === this.side && world.phaseTime >= this.serveDelay) {
          intent.swing = true;
          intent.held = this.chargeServe;
        }
        break;
      case 'toss':
        if (world.server === this.side) {
          const due = world.tossTime >= IDEAL_TOSS_TIME + this.plannedError;
          if (this.chargeServe) intent.held = !due;
          else if (due) intent.swing = true;
        }
        break;
      case 'serve':
      case 'rally':
        this.playPoint(world, me);
        break;
      default:
        break;
    }
    return intent;
  }

  private prepareServe(world: World): void {
    if (this.seenReady === world.readyId) return;
    this.seenReady = world.readyId;
    if (world.server !== this.side) return;
    const { rng, profile, intent } = this;
    const second = world.serveNumber === 2;
    this.chargeServe = !second && rng() < profile.chargeChance;
    this.serveDelay = lerp(0.9, 1.5, rng());
    this.plannedError = gaussian(rng) * profile.timingSigma * 1.35;
    const edge = rng() < 0.5 ? -1 : 1;
    intent.aimU = edge * lerp(0.2, profile.serveU, rng()) * (second ? 0.6 : 1);
    intent.aimV = lerp(0.5, profile.serveV, rng()) * (second ? 0.85 : 1);
    intent.aimAuto = false;
    intent.lob = false;
  }

  private onNewShot(world: World): void {
    const { rng, profile } = this;
    const ball = world.ball;
    this.seenHit = world.hitId;
    this.wantCharge = rng() < profile.chargeChance;
    this.charging = false;
    // A serve is expected, so the returner is already on their toes.
    const anticipation = world.phase === 'serve' ? 0.5 : 1;
    this.react = profile.reaction * anticipation * lerp(0.85, 1.15, rng());
    this.replan = 0;
    this.noiseX = gaussian(rng) * profile.predictError;
    this.noiseZ = gaussian(rng) * profile.predictError * 1.3;

    const landing = world.predictedLanding();
    const me = world.players[this.side];
    const pace = clamp01((Math.hypot(ball.vel.x, ball.vel.z) - 16) / 12);
    const run = landing ? clamp01(Math.abs(landing.x - me.pos.x) / 6) : 0;
    const pressure = Math.max(pace, run);

    this.plannedError = gaussian(rng) * profile.timingSigma * (1 + pressure * profile.pressure);
    if (rng() < profile.blunder + profile.pressureBlunder * pressure * pressure) {
      this.plannedError = -lerp(0.18, 0.22, rng());
    }
    this.leaveBall = landing !== null && !landing.isIn && rng() < profile.judgement;
  }

  private playPoint(world: World, me: Player): void {
    const dir = sideDir(this.side);
    if (!world.isIncoming(this.side)) {
      this.moveTo(me, clamp(-me.lastAimX * 0.16, -1.5, 1.5), dir * 12.7);
      return;
    }
    if (world.hitId !== this.seenHit) this.onNewShot(world);

    this.react -= TICK;
    if (this.react > 0 || this.leaveBall) {
      this.moveTo(me, clamp(-me.lastAimX * 0.16, -1.5, 1.5), dir * 12.7);
      return;
    }

    this.replan -= TICK;
    if (this.replan <= 0) {
      this.replan = 0.08;
      const plan = this.chooseIntercept(world, me);
      if (plan) {
        const fade = Math.min(1, plan.t);
        this.targetX = plan.x + this.noiseX * fade;
        this.targetZ = plan.z + this.noiseZ * fade;
      }
    }
    this.moveTo(me, this.targetX, this.targetZ);

    const crossing = world.crossing(this.side);
    if (crossing && me.onGround && crossing.tooHigh && !crossing.tooWide) {
      const extra = crossing.y - PLAYER.reachTop;
      if (extra < 1 && crossing.t <= 0.3) this.intent.jump = true;
    }

    const onTime = crossing !== null && crossing.reachable && crossing.t <= SWING.lead - this.plannedError;
    const late = crossing === null && world.ballInReach(this.side);

    if (this.charging) {
      if (onTime || late) {
        this.charging = false;
        this.pressedFor = world.hitId;
        this.chooseShot(world, me);
      } else {
        this.intent.held = true;
      }
      return;
    }

    if (this.pressedFor === world.hitId || !world.canSwing(this.side)) return;

    if (this.wantCharge && crossing && crossing.reachable) {
      const settled = Math.hypot(this.targetX - me.pos.x, this.targetZ - me.pos.z) < 0.7;
      if (settled && crossing.t > SWING.lead + SWING.earlyWindow + 0.1) {
        this.charging = true;
        this.intent.swing = true;
        this.intent.held = true;
        return;
      }
    }

    if (onTime || late) {
      this.pressedFor = world.hitId;
      this.intent.swing = true;
      this.chooseShot(world, me);
    }
  }

  private chooseIntercept(world: World, me: Player): Intercept | null {
    const path = world.getPath();
    if (path.segments.length === 0) return null;
    const dir = sideDir(this.side);
    const speed = PLAYER.maxSpeed * me.speedFactor;
    const first = path.firstBounce;
    const end = path.segments[path.segments.length - 1].t1;
    const q = this.at;
    let best: Intercept | null = null;
    let bestScore = -Infinity;

    for (let t = 0.05; t <= end; t += 1 / 30) {
      if (!positionAt(path, t, q) || q.z * dir < 0.8) continue;
      const standZ = q.z + dir * PLAYER.contactFront;
      if (Math.abs(standZ) > ARENA.maxZ) break;
      const bounced = world.bounces > 0 || (first !== null && t > first.t);
      if (world.phase === 'serve' && !bounced) continue;
      if (!bounced && Math.abs(q.z) > 5.5 && q.y < PLAYER.reachTop - 0.4) continue;
      if (q.y < 0.25 || q.y > PLAYER.reachTop + 0.85) continue;

      const toRight = q.x >= me.pos.x ? 1 : -1;
      const standX = q.x - toRight * 0.62 * me.reachScale;
      const distance = Math.hypot(standX - me.pos.x, standZ - me.pos.z);
      const slack = t - (distance / speed + 0.1);
      const jumpCost = q.y > PLAYER.reachTop - 0.1 ? 0.8 : 0;
      const score = (slack >= 0 ? 4 : slack * 6) - Math.abs(q.y - 1.05) * 1.2 - t * 0.35 - jumpCost;
      if (score > bestScore) {
        bestScore = score;
        best = { x: standX, z: standZ, t };
      }
    }
    return best;
  }

  private chooseShot(world: World, me: Player): void {
    const { rng, profile, intent } = this;
    const opponent = world.players[otherSide(this.side)];
    let sign = opponent.pos.x >= 0 ? -1 : 1;
    if (rng() > profile.openCourt) sign = rng() < 0.5 ? -1 : 1;

    intent.aimAuto = false;
    intent.aimU = sign * lerp(0.2, profile.maxU, rng());
    intent.aimV = lerp(profile.minV, profile.maxV, rng());

    const opponentAtNet = Math.abs(opponent.pos.z) < 6.5;
    const stretched = Math.abs(world.ball.pos.x - me.pos.x) > 1.2 && Math.abs(me.pos.x) > COURT.halfWidth;
    intent.lob = (opponentAtNet && rng() < profile.lobChance) || (stretched && rng() < profile.lobChance * 0.6);
  }

  private moveTo(me: Player, x: number, z: number): void {
    const dir = sideDir(this.side);
    const tx = clamp(x, -ARENA.maxX, ARENA.maxX);
    const tz = clamp(z * dir, ARENA.minZ, ARENA.maxZ) * dir;
    const dx = tx - me.pos.x;
    const dz = tz - me.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return;
    const k = Math.min(1, d / 0.42) / d;
    this.intent.moveX = dx * k;
    this.intent.moveZ = dz * k;
  }
}
