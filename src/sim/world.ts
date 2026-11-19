import {
  createBall,
  positionAt,
  predictPath,
  stepBall,
  timeToPlane,
  type Ball,
  type BallEvent,
  type BallPath,
} from './ball';
import {
  ARENA,
  BOUNCE,
  COURT,
  GRAVITY,
  netHeight,
  PLAYER,
  SERVE,
  SMASH,
  SWING,
  TICK,
  TIMERS,
} from './constants';
import { clamp, clamp01, createRng, lerp, type Rng } from './math';
import { createPlayer, FREE_MOVEMENT, inReach, movePlayer, type MoveLimits, type Player, type Swing } from './player';
import {
  applyShotError,
  SHOT_PROFILES,
  solveIntoNet,
  solveShot,
  timingLabel,
  timingQuality,
  type ShotKind,
  type TimingLabel,
} from './shot';
import {
  FAR,
  NEAR,
  otherSide,
  sideDir,
  type CourtPoint,
  type PlayerIntent,
  type Side,
  type Vec3,
} from './types';

export type Phase = 'ready' | 'toss' | 'serve' | 'rally' | 'fault' | 'dead' | 'reset' | 'over';
export type PointReason = 'winner' | 'ace' | 'out' | 'net' | 'double-fault';
export type FaultReason = 'net' | 'out';

export type GameEvent =
  | {
      type: 'hit';
      side: Side;
      shot: ShotKind;
      quality: number;
      timing: TimingLabel;
      x: number;
      y: number;
      z: number;
      speed: number;
      rally: number;
    }
  | { type: 'swing'; side: Side }
  | { type: 'whiff'; side: Side }
  | { type: 'toss'; side: Side }
  | { type: 'jump'; side: Side }
  | { type: 'land'; side: Side }
  | { type: 'bounce'; x: number; z: number; speed: number; live: boolean; isIn: boolean }
  | { type: 'net'; x: number; y: number; speed: number }
  | { type: 'fault'; side: Side; reason: FaultReason; serveNumber: 1 | 2 }
  | { type: 'point'; winner: Side; reason: PointReason; loserOfRally: Side; rally: number; points: [number, number] }
  | { type: 'serve-ready'; server: Side; serveNumber: 1 | 2; deuce: boolean }
  | { type: 'match-end'; winner: Side };

export interface PlayerStats {
  hits: number;
  perfects: number;
  winners: number;
  aces: number;
  errors: number;
  doubleFaults: number;
  topSpeed: number;
}

export interface ServiceBox {
  deuce: boolean;
  serverX: number;
  minX: number;
  maxX: number;
  zSign: 1 | -1;
}

export interface Crossing {
  /** Seconds until the ball reaches this player's contact plane. */
  t: number;
  x: number;
  y: number;
  z: number;
  tooWide: boolean;
  tooHigh: boolean;
  tooLow: boolean;
  reachable: boolean;
  bounced: boolean;
}

export interface Landing extends CourtPoint {
  t: number;
  isIn: boolean;
}

export interface PlayerTuning {
  speedFactor?: number;
  powerScale?: number;
  reachScale?: number;
  timingScale?: number;
  contactDelay?: number;
}

export interface WorldOptions {
  seed?: number;
  targetPoints?: number;
  firstServer?: Side;
}

const newStats = (): PlayerStats => ({
  hits: 0,
  perfects: 0,
  winners: 0,
  aces: 0,
  errors: 0,
  doubleFaults: 0,
  topSpeed: 0,
});

const TOSS_SPEED = Math.sqrt(2 * GRAVITY * (SERVE.tossApex - SERVE.handHeight));
export const IDEAL_TOSS_TIME = TOSS_SPEED / GRAVITY + SERVE.idealAfterApex;

/** Tie-break rotation: A serves once, then each player serves twice in turn. */
export function serverForPoint(pointIndex: number, first: Side): Side {
  return ((pointIndex + 1) >> 1) % 2 === 0 ? first : otherSide(first);
}

export function serviceBoxFor(server: Side, pointIndex: number): ServiceBox {
  const deuce = pointIndex % 2 === 0;
  const dir = sideDir(server);
  const serverX = (deuce ? 1 : -1) * dir;
  const boxSign = -serverX;
  return {
    deuce,
    serverX,
    minX: boxSign > 0 ? 0 : -COURT.halfWidth,
    maxX: boxSign > 0 ? COURT.halfWidth : 0,
    zSign: dir === 1 ? -1 : 1,
  };
}

export class World {
  readonly ball: Ball = createBall();
  readonly players: [Player, Player] = [createPlayer(NEAR), createPlayer(FAR)];
  readonly stats: [PlayerStats, PlayerStats] = [newStats(), newStats()];
  readonly aim: [CourtPoint, CourtPoint] = [
    { x: 0, z: -8 },
    { x: 0, z: 8 },
  ];
  readonly targetPoints: number;
  readonly firstServer: Side;
  readonly rng: Rng;

  phase: Phase = 'ready';
  phaseTime = 0;
  tick = 0;
  events: GameEvent[] = [];

  points: [number, number] = [0, 0];
  server: Side;
  serveNumber: 1 | 2 = 1;
  pointIndex = 0;
  winner: Side | null = null;
  lastPointWinner: Side | null = null;
  /** Increments every time the server gets ready, so controllers can react once. */
  readyId = 0;

  lastHitter: Side | null = null;
  hitId = 0;
  bounces = 0;
  rally = 0;
  longestRally = 0;
  tossTime = 0;

  private path: BallPath = { segments: [], hitsNet: false, firstBounce: null };
  private pathTick = -1;
  private readonly ballEvents: BallEvent[] = [];
  private readonly scratch: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly homes: [CourtPoint, CourtPoint] = [
    { x: 0, z: 0 },
    { x: 0, z: 0 },
  ];

  constructor(options: WorldOptions = {}) {
    this.rng = createRng(options.seed ?? 1);
    this.targetPoints = options.targetPoints ?? 7;
    this.firstServer = options.firstServer ?? NEAR;
    this.server = this.firstServer;
    this.computeHomes();
    for (const side of [NEAR, FAR] as const) {
      const p = this.players[side];
      p.pos.x = this.homes[side].x;
      p.pos.z = this.homes[side].z;
      p.prevPos.x = p.pos.x;
      p.prevPos.z = p.pos.z;
    }
    this.enterReady();
    this.events.length = 0;
  }

  tunePlayer(side: Side, tuning: PlayerTuning): void {
    Object.assign(this.players[side], tuning);
  }

  // ---------------------------------------------------------------------------
  // Queries used by the AI, the camera and the on-court markers
  // ---------------------------------------------------------------------------

  getPath(): BallPath {
    if (this.pathTick !== this.tick) {
      this.path = predictPath(this.ball);
      this.pathTick = this.tick;
    }
    return this.path;
  }

  get serviceBox(): ServiceBox {
    return serviceBoxFor(this.server, this.pointIndex);
  }

  isServing(side: Side): boolean {
    return side === this.server && (this.phase === 'ready' || this.phase === 'toss');
  }

  /** True while the ball is travelling towards this player and is still live. */
  isIncoming(side: Side): boolean {
    if (this.phase !== 'rally' && this.phase !== 'serve') return false;
    return this.lastHitter !== null && this.lastHitter !== side && !this.getPath().hitsNet;
  }

  crossing(side: Side): Crossing | null {
    if (!this.isIncoming(side)) return null;
    const p = this.players[side];
    const dir = sideDir(side);
    const path = this.getPath();
    const t = timeToPlane(path, p.pos.z - dir * PLAYER.contactFront);
    if (t === null) return null;
    const at = this.scratch;
    if (!positionAt(path, t, at)) return null;

    const feet = p.onGround ? 0 : Math.max(0, p.pos.y + p.vel.y * t - 0.5 * PLAYER.gravity * t * t);
    const height = at.y - feet;
    const tooWide = Math.abs(at.x - p.pos.x) > PLAYER.reachX * p.reachScale;
    const tooHigh = height > PLAYER.reachTop;
    const tooLow = height < PLAYER.reachBottom;
    const firstBounce = path.firstBounce;
    const bounced = this.bounces > 0 || (firstBounce !== null && t > firstBounce.t);
    return {
      t,
      x: at.x,
      y: at.y,
      z: at.z,
      tooWide,
      tooHigh,
      tooLow,
      reachable: !tooWide && !tooHigh && !tooLow && (this.phase === 'rally' || bounced),
      bounced,
    };
  }

  /** Where the ball will first touch the ground, while that is still ahead. */
  predictedLanding(): Landing | null {
    if ((this.phase !== 'rally' && this.phase !== 'serve') || this.bounces > 0) return null;
    const path = this.getPath();
    if (!path.firstBounce || path.hitsNet || this.lastHitter === null) return null;
    const { t, x, z } = path.firstBounce;
    const isIn = this.phase === 'serve' ? this.inServiceBox(x, z) : this.inCourtOf(otherSide(this.lastHitter), x, z);
    return { t, x, z, isIn };
  }

  ballInReach(side: Side): boolean {
    return this.canHitBall(this.players[side]) && inReach(this.players[side], this.ball.pos);
  }

  canSwing(side: Side): boolean {
    const swing = this.players[side].swing;
    if (!swing) return true;
    if (swing.armed) return false;
    return swing.t - (swing.releaseT ?? swing.t) >= SWING.rearmAfter;
  }

  /** Maps a normalised aim onto the court area this player is currently aiming at. */
  aimToCourt(side: Side, u: number, v: number): CourtPoint {
    const dir = -sideDir(side);
    if (this.isServing(side)) {
      const box = this.serviceBox;
      const margin = 0.16;
      return {
        x: lerp(box.minX + margin, box.maxX - margin, clamp01((u + 1) / 2)),
        z: dir * lerp(2.0, COURT.serviceLine - margin, clamp01(v)),
      };
    }
    return {
      x: clamp(u, -1, 1) * (COURT.halfWidth - 0.16),
      z: dir * lerp(1.9, COURT.halfLength - 0.35, clamp01(v)),
    };
  }

  // ---------------------------------------------------------------------------
  // Simulation step
  // ---------------------------------------------------------------------------

  step(intents: readonly [PlayerIntent, PlayerIntent]): void {
    this.tick++;
    this.phaseTime += TICK;
    const b = this.ball;
    b.prevPos.x = b.pos.x;
    b.prevPos.y = b.pos.y;
    b.prevPos.z = b.pos.z;

    this.updateAim(NEAR, intents[NEAR]);
    this.updateAim(FAR, intents[FAR]);
    this.updatePlayer(this.players[NEAR], intents[NEAR]);
    this.updatePlayer(this.players[FAR], intents[FAR]);
    this.updateBall();
    this.updateSwing(this.players[NEAR], intents[NEAR]);
    this.updateSwing(this.players[FAR], intents[FAR]);
    this.updatePhase();
  }

  drainEvents(): GameEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  private emit(event: GameEvent): void {
    this.events.push(event);
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseTime = 0;
  }

  private updateAim(side: Side, intent: PlayerIntent): void {
    let u = intent.aimU;
    let v = intent.aimV;
    if (intent.aimAuto) {
      const auto = this.autoAim(side);
      u = auto.u;
      v = auto.v;
    }
    const target = this.aimToCourt(side, u, v);
    this.aim[side].x = target.x;
    this.aim[side].z = target.z;
  }

  /** Aims away from the opponent, which is what a tap-to-hit player usually wants. */
  private autoAim(side: Side): { u: number; v: number } {
    const me = this.players[side];
    const opponent = this.players[otherSide(side)];
    if (this.isServing(side)) {
      const box = this.serviceBox;
      const middle = (box.minX + box.maxX) / 2;
      return { u: opponent.pos.x > middle ? -0.45 : 0.45, v: 0.72 };
    }
    let sign = -Math.sign(opponent.pos.x);
    if (Math.abs(opponent.pos.x) < 0.4) sign = -Math.sign(me.pos.x) || 1;
    return { u: sign * 0.66, v: 0.78 };
  }

  private updatePlayer(p: Player, intent: PlayerIntent): void {
    p.prevPos.x = p.pos.x;
    p.prevPos.y = p.pos.y;
    p.prevPos.z = p.pos.z;
    if (p.tossTime >= 0) p.tossTime += TICK;

    const wasGrounded = p.onGround;
    const serving = p.side === this.server;
    let moveX = intent.moveX;
    let moveZ = intent.moveZ;
    let scale = 1;
    let limits: MoveLimits = FREE_MOVEMENT;

    if (this.phase === 'reset') {
      const home = this.homes[p.side];
      const dx = home.x - p.pos.x;
      const dz = home.z - p.pos.z;
      const d = Math.hypot(dx, dz);
      const k = d > 0.001 ? Math.min(1, d / 0.5) / d : 0;
      moveX = dx * k;
      moveZ = dz * k;
      scale = 1.4 / p.speedFactor;
    } else if (this.phase === 'over') {
      moveX = 0;
      moveZ = 0;
    } else if (serving && this.phase === 'ready') {
      const sign = this.serviceBox.serverX;
      limits = {
        minX: sign > 0 ? SERVE.minX : -SERVE.maxX,
        maxX: sign > 0 ? SERVE.maxX : -SERVE.minX,
        minAbsZ: SERVE.baselineZ,
        maxAbsZ: SERVE.baselineZ,
      };
      moveZ = 0;
      scale = 0.55;
    } else if (serving && this.phase === 'toss') {
      moveX = 0;
      moveZ = 0;
    }

    if (p.swing && p.swing.t < SWING.slowFor) scale *= SWING.slowFactor;

    const canJump = this.phase === 'serve' || this.phase === 'rally' || this.phase === 'dead' || !serving;
    if (intent.jump && p.onGround && canJump && this.phase !== 'reset' && this.phase !== 'over') {
      p.onGround = false;
      p.vel.y = PLAYER.jumpSpeed;
      this.emit({ type: 'jump', side: p.side });
    }

    movePlayer(p, moveX, moveZ, scale, limits, TICK);
    if (!wasGrounded && p.onGround) this.emit({ type: 'land', side: p.side });
  }

  private updateBall(): void {
    const b = this.ball;
    if (b.held) {
      this.placeBallInHand();
      return;
    }
    this.ballEvents.length = 0;
    stepBall(b, TICK, this.ballEvents);
    for (const event of this.ballEvents) {
      if (event.type === 'bounce') this.onBounce(event.x, event.z, event.speed);
      else this.onNet(event.x, event.y, event.speed);
    }
    this.containBall();
  }

  /** A dead ball rebounds off the perimeter wall instead of passing through it. */
  private containBall(): void {
    const b = this.ball;
    if (b.pos.y > ARENA.wallHeight) return;
    if (Math.abs(b.pos.x) > ARENA.wallX && b.pos.x * b.vel.x > 0) {
      b.pos.x = Math.sign(b.pos.x) * ARENA.wallX;
      b.vel.x *= -0.35;
    }
    if (Math.abs(b.pos.z) > ARENA.wallZ && b.pos.z * b.vel.z > 0) {
      b.pos.z = Math.sign(b.pos.z) * ARENA.wallZ;
      b.vel.z *= -0.35;
    }
  }

  private placeBallInHand(): void {
    const p = this.players[this.server];
    const dir = sideDir(this.server);
    const b = this.ball;
    b.pos.x = p.pos.x - 0.27 * dir;
    b.pos.y = 1.02;
    b.pos.z = p.pos.z - 0.34 * dir;
    b.vel.x = 0;
    b.vel.y = 0;
    b.vel.z = 0;
    b.spin = 0;
  }

  private inServiceBox(x: number, z: number): boolean {
    const box = this.serviceBox;
    const tol = COURT.lineTolerance;
    return (
      z * box.zSign > -tol &&
      Math.abs(z) <= COURT.serviceLine + tol &&
      x >= box.minX - tol &&
      x <= box.maxX + tol
    );
  }

  private inCourtOf(side: Side, x: number, z: number): boolean {
    const tol = COURT.lineTolerance;
    return z * sideDir(side) > 0 && Math.abs(x) <= COURT.halfWidth + tol && Math.abs(z) <= COURT.halfLength + tol;
  }

  private onBounce(x: number, z: number, speed: number): void {
    let live = false;
    let isIn = false;
    if (this.phase === 'serve') {
      live = true;
      this.bounces = 1;
      isIn = this.inServiceBox(x, z);
      this.emit({ type: 'bounce', x, z, speed, live, isIn });
      if (isIn) this.setPhase('rally');
      else this.fault('out');
      return;
    }
    if (this.phase === 'rally' && this.lastHitter !== null) {
      live = true;
      this.bounces++;
      const hitter = this.lastHitter;
      const receiver = otherSide(hitter);
      if (this.bounces === 1) {
        isIn = this.inCourtOf(receiver, x, z);
        this.emit({ type: 'bounce', x, z, speed, live, isIn });
        if (!isIn) this.endPoint(receiver, 'out');
      } else {
        isIn = true;
        this.emit({ type: 'bounce', x, z, speed, live, isIn });
        this.endPoint(hitter, this.rally === 1 ? 'ace' : 'winner');
      }
      return;
    }
    this.emit({ type: 'bounce', x, z, speed, live, isIn });
  }

  private onNet(x: number, y: number, speed: number): void {
    this.emit({ type: 'net', x, y, speed });
    if (this.phase === 'serve') this.fault('net');
    else if (this.phase === 'rally' && this.lastHitter !== null) {
      this.endPoint(otherSide(this.lastHitter), 'net');
    }
  }

  private fault(reason: FaultReason): void {
    this.emit({ type: 'fault', side: this.server, reason, serveNumber: this.serveNumber });
    if (this.serveNumber === 1) {
      this.serveNumber = 2;
      this.setPhase('fault');
    } else {
      this.endPoint(otherSide(this.server), 'double-fault');
    }
  }

  private endPoint(winner: Side, reason: PointReason): void {
    const loser = otherSide(winner);
    this.points[winner]++;
    this.lastPointWinner = winner;
    this.longestRally = Math.max(this.longestRally, this.rally);
    if (reason === 'winner') this.stats[winner].winners++;
    if (reason === 'ace') {
      this.stats[winner].aces++;
      this.stats[winner].winners++;
    }
    if (reason === 'out' || reason === 'net') this.stats[loser].errors++;
    if (reason === 'double-fault') this.stats[loser].doubleFaults++;
    if (this.points[winner] >= this.targetPoints && this.points[winner] - this.points[loser] >= 2) {
      this.winner = winner;
    }
    this.setPhase('dead');
    this.emit({
      type: 'point',
      winner,
      reason,
      loserOfRally: loser,
      rally: this.rally,
      points: [this.points[0], this.points[1]],
    });
  }

  private updatePhase(): void {
    const b = this.ball;
    switch (this.phase) {
      case 'toss':
        this.tossTime += TICK;
        if (b.vel.y < 0 && b.pos.y < SERVE.cancelHeight) {
          this.players[this.server].tossTime = -1;
          this.enterReady();
        }
        break;
      case 'rally':
        if (
          this.bounces > 0 &&
          this.lastHitter !== null &&
          (Math.abs(b.pos.z) > ARENA.passZ || Math.abs(b.pos.x) > ARENA.passX)
        ) {
          this.endPoint(this.lastHitter, this.rally === 1 ? 'ace' : 'winner');
        }
        break;
      case 'fault':
        if (this.phaseTime >= TIMERS.faultPause) this.beginReset();
        break;
      case 'dead':
        if (this.phaseTime >= TIMERS.pointEnd) {
          if (this.winner !== null) {
            this.setPhase('over');
            this.emit({ type: 'match-end', winner: this.winner });
          } else {
            this.pointIndex = this.points[0] + this.points[1];
            this.server = serverForPoint(this.pointIndex, this.firstServer);
            this.serveNumber = 1;
            this.beginReset();
          }
        }
        break;
      case 'reset': {
        const arrived = this.players.every((p) => {
          const home = this.homes[p.side];
          return Math.hypot(home.x - p.pos.x, home.z - p.pos.z) < 0.08 && p.onGround;
        });
        if (arrived || this.phaseTime >= TIMERS.resetMax) this.enterReady();
        break;
      }
      default:
        break;
    }
  }

  private computeHomes(): void {
    const box = this.serviceBox;
    const receiver = otherSide(this.server);
    this.homes[this.server].x = box.serverX * SERVE.centerOffset;
    this.homes[this.server].z = sideDir(this.server) * SERVE.baselineZ;
    this.homes[receiver].x = -box.serverX * SERVE.receiveX;
    this.homes[receiver].z = sideDir(receiver) * SERVE.receiveZ;
  }

  private beginReset(): void {
    this.computeHomes();
    this.holdBall();
    this.setPhase('reset');
  }

  private holdBall(): void {
    const b = this.ball;
    b.held = true;
    b.rolling = false;
    b.g = GRAVITY;
    b.restitution = BOUNCE.restitution;
    b.retention = BOUNCE.retention;
    this.lastHitter = null;
    this.bounces = 0;
    this.rally = 0;
    this.placeBallInHand();
    b.prevPos.x = b.pos.x;
    b.prevPos.y = b.pos.y;
    b.prevPos.z = b.pos.z;
  }

  private enterReady(): void {
    this.computeHomes();
    const server = this.players[this.server];
    server.pos.x = this.homes[this.server].x;
    server.pos.z = this.homes[this.server].z;
    server.vel.x = 0;
    server.vel.z = 0;
    server.tossTime = -1;
    this.holdBall();
    this.tossTime = 0;
    this.readyId++;
    this.setPhase('ready');
    this.emit({
      type: 'serve-ready',
      server: this.server,
      serveNumber: this.serveNumber,
      deuce: this.serviceBox.deuce,
    });
  }

  // ---------------------------------------------------------------------------
  // Swings and contact
  // ---------------------------------------------------------------------------

  private canHitBall(p: Player): boolean {
    return (
      this.phase === 'rally' &&
      this.lastHitter !== null &&
      this.lastHitter !== p.side &&
      !this.ball.held &&
      this.ball.pos.z * sideDir(p.side) > 0
    );
  }

  private startSwing(p: Player, serve: boolean): Swing {
    const dx = this.ball.pos.x - p.pos.x;
    const swing: Swing = {
      t: 0,
      armed: true,
      serve,
      hand: serve ? 'over' : dx * sideDir(p.side) >= 0 ? 'fore' : 'back',
      approach: 0,
      releaseT: null,
      whiff: false,
      contact: null,
      timingError: 0,
    };
    p.swing = swing;
    this.emit({ type: 'swing', side: p.side });
    return swing;
  }

  private disarm(p: Player, swing: Swing): void {
    swing.armed = false;
    swing.whiff = true;
    swing.releaseT = swing.t;
    this.emit({ type: 'whiff', side: p.side });
  }

  private startToss(): void {
    const p = this.players[this.server];
    const dir = sideDir(this.server);
    const b = this.ball;
    b.held = false;
    b.rolling = false;
    b.g = GRAVITY;
    b.pos.x = p.pos.x + 0.12 * dir;
    b.pos.y = SERVE.handHeight;
    b.pos.z = p.pos.z - 0.32 * dir;
    b.prevPos.x = b.pos.x;
    b.prevPos.y = b.pos.y;
    b.prevPos.z = b.pos.z;
    b.vel.x = 0;
    b.vel.y = TOSS_SPEED;
    b.vel.z = 0;
    p.tossTime = 0;
    this.tossTime = 0;
    this.setPhase('toss');
    this.emit({ type: 'toss', side: this.server });
  }

  private onSwingPressed(p: Player): void {
    const side = p.side;
    if (this.phase === 'ready') {
      if (side === this.server) this.startToss();
      return;
    }
    if (this.phase === 'toss') {
      if (side !== this.server || this.ball.pos.y < SERVE.minHitHeight || !this.canSwing(side)) return;
      const swing = this.startSwing(p, true);
      swing.timingError = this.tossTime - IDEAL_TOSS_TIME;
      return;
    }
    if ((this.phase !== 'rally' && this.phase !== 'serve') || !this.canSwing(side)) return;

    const swing = this.startSwing(p, false);
    const crossing = this.crossing(side);
    if (crossing) {
      swing.hand = (crossing.x - p.pos.x) * sideDir(side) >= 0 ? 'fore' : 'back';
      if (crossing.t > SWING.lead + SWING.earlyWindow) this.disarm(p, swing);
    } else if (!this.ballInReach(side)) {
      this.disarm(p, swing);
    }
  }

  private updateSwing(p: Player, intent: PlayerIntent): void {
    if (p.swing) p.swing.t += TICK;
    if (intent.swing) this.onSwingPressed(p);
    const swing = p.swing;
    if (!swing) return;

    if (swing.armed) {
      if (swing.serve) {
        swing.approach = clamp01(swing.t / Math.max(TICK, p.contactDelay));
        if (this.phase !== 'toss') this.disarm(p, swing);
        else if (swing.t >= p.contactDelay) this.executeServe(p, swing);
      } else {
        this.tryContact(p, swing, intent);
      }
    }
    if (!swing.armed && swing.releaseT !== null && swing.t - swing.releaseT > SWING.followThrough) {
      p.swing = null;
    }
  }

  private tryContact(p: Player, swing: Swing, intent: PlayerIntent): void {
    const armLimit = SWING.lead + SWING.earlyWindow;
    if (!this.canHitBall(p)) {
      if (swing.t >= armLimit) this.disarm(p, swing);
      return;
    }
    const b = this.ball;
    const dir = sideDir(p.side);
    const plane = p.pos.z - dir * PLAYER.contactFront;
    const past = (b.pos.z - plane) * dir;
    const speed = Math.max(1, Math.abs(b.vel.z));
    swing.approach = clamp01(1 + past / speed / 0.075);
    if (swing.t < p.contactDelay) return;

    const reach = inReach(p, b.pos);
    if (past >= 0 && reach) {
      this.executeHit(p, swing, intent, past / speed);
    } else if (past > PLAYER.reachBack + PLAYER.contactFront) {
      this.disarm(p, swing);
    } else if (swing.t >= armLimit) {
      if (reach) this.executeHit(p, swing, intent, past / speed);
      else this.disarm(p, swing);
    }
  }

  private launch(p: Player, swing: Swing, kind: ShotKind, quality: number, timing: number): void {
    const b = this.ball;
    swing.armed = false;
    swing.approach = 1;
    swing.releaseT = swing.t;
    swing.contact = { x: b.pos.x, y: b.pos.y, z: b.pos.z };
    b.spin = SHOT_PROFILES[kind].spin;
    b.rolling = false;
    this.lastHitter = p.side;
    this.hitId++;
    this.bounces = 0;
    this.rally++;

    const label = timingLabel(quality, timing);
    const speed = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
    const stats = this.stats[p.side];
    stats.hits++;
    stats.topSpeed = Math.max(stats.topSpeed, speed);
    if (label === 'perfect') stats.perfects++;
    this.emit({
      type: 'hit',
      side: p.side,
      shot: kind,
      quality,
      timing: label,
      x: b.pos.x,
      y: b.pos.y,
      z: b.pos.z,
      speed,
      rally: this.rally,
    });
  }

  private setBallFlight(kind: ShotKind, vx: number, vy: number, vz: number, g: number): void {
    const b = this.ball;
    const profile = SHOT_PROFILES[kind];
    b.vel.x = vx;
    b.vel.y = vy;
    b.vel.z = vz;
    b.g = g;
    b.restitution = profile.restitution;
    b.retention = profile.retention;
  }

  private executeHit(p: Player, swing: Swing, intent: PlayerIntent, sinceCrossing: number): void {
    const b = this.ball;
    const dx = b.pos.x - p.pos.x;
    const timing = SWING.lead - swing.t + sinceCrossing;
    const height = b.pos.y;

    let kind: ShotKind = 'drive';
    if (intent.lob) kind = 'lob';
    else if (height >= SMASH.standHeight || (!p.onGround && height >= SMASH.airHeight)) kind = 'smash';
    else if (this.bounces === 0) kind = 'volley';
    swing.hand = kind === 'smash' ? 'over' : dx * sideDir(p.side) >= 0 ? 'fore' : 'back';

    const profile = SHOT_PROFILES[kind];
    const stretch = clamp01((Math.abs(dx) / (PLAYER.reachX * p.reachScale) - 0.58) / 0.42);
    const quality = timingQuality(timing, p.timingScale) * (1 - 0.6 * stretch * stretch);

    const targetDir = -sideDir(p.side) as 1 | -1;
    const aim = this.aim[p.side];
    const result = applyShotError({
      target: aim,
      kind,
      quality,
      timingError: timing,
      ballSide: Math.sign(dx) || 1,
      scatter: 1,
      targetDir,
      rng: this.rng,
    });
    p.lastAimX = result.x;

    const speed = lerp(profile.minSpeed, profile.maxSpeed, quality ** 1.15) * (1 - 0.2 * stretch) * p.powerScale;
    const shot = this.solveWithMishit(b.pos, result, profile.g, speed, profile.clearance, kind, quality);
    this.setBallFlight(kind, shot.vx, shot.vy, shot.vz, profile.g);
    this.launch(p, swing, kind, quality, timing);
  }

  private solveWithMishit(
    from: Vec3,
    target: { x: number; z: number; mishit: string },
    g: number,
    speed: number,
    clearance: number,
    kind: ShotKind,
    quality: number,
  ) {
    if (target.mishit === 'net') {
      const k = Math.abs(from.z) / Math.max(1e-6, Math.abs(target.z - from.z));
      const height = netHeight(from.x + (target.x - from.x) * k) * lerp(0.4, 0.85, this.rng());
      return solveIntoNet(from, target.x, target.z, g, speed, height);
    }
    return solveShot({
      from,
      targetX: target.x,
      targetZ: target.z,
      g,
      speed,
      clearance,
      apex: kind === 'lob' ? lerp(4.4, 6.6, quality) : undefined,
    });
  }

  private executeServe(p: Player, swing: Swing): void {
    const b = this.ball;
    const second = this.serveNumber === 2;
    const profile = SHOT_PROFILES.serve;
    const quality = timingQuality(swing.timingError, SERVE.timingScale * p.timingScale);
    const targetDir = this.serviceBox.zSign;
    const result = applyShotError({
      target: this.aim[p.side],
      kind: 'serve',
      quality,
      timingError: swing.timingError,
      ballSide: 1,
      scatter: second ? 0.5 : 1,
      targetDir,
      rng: this.rng,
    });
    p.lastAimX = result.x;
    p.tossTime = -1;

    const speed = lerp(profile.minSpeed, profile.maxSpeed, quality ** 1.1) * (second ? 0.74 : 1) * p.powerScale;
    const g = second ? 14 : profile.g;
    const clearance = second ? 0.42 : profile.clearance;
    const shot = this.solveWithMishit(b.pos, result, g, speed, clearance, 'serve', quality);
    this.setBallFlight('serve', shot.vx, shot.vy, shot.vz, g);
    swing.hand = 'over';
    this.launch(p, swing, 'serve', quality, swing.timingError);
    this.setPhase('serve');
  }
}
