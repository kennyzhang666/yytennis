import { lerp } from './math';
import type { Swing } from './player';
import { FAR, NEAR, type Side, type Vec3 } from './types';
import type { World } from './world';

/** Where the next ball will meet this player's contact point. */
export interface IncomingFrame {
  t: number;
  x: number;
  y: number;
  z: number;
  reachable: boolean;
  bounced: boolean;
}

export interface PlayerFrame {
  side: Side;
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  swing: Swing | null;
  tossTime: number;
  chargeLevel: number;
  charging: boolean;
  serving: boolean;
  celebrating: boolean;
  incoming: IncomingFrame | null;
  /** Where the ball is right now, so the player can watch it. */
  frameBallX: number;
  frameBallY: number;
  frameBallZ: number;
}

export interface BallFrame {
  pos: Vec3;
  vel: Vec3;
  spin: number;
  charge: number;
  held: boolean;
}

/** Everything the 3D view needs for one moment, live or from a replay. */
export interface SceneFrame {
  ball: BallFrame;
  players: [PlayerFrame, PlayerFrame];
}

const vec = (): Vec3 => ({ x: 0, y: 0, z: 0 });

function createPlayerFrame(side: Side): PlayerFrame {
  return {
    side,
    pos: vec(),
    vel: vec(),
    onGround: true,
    swing: null,
    tossTime: -1,
    chargeLevel: 0,
    charging: false,
    serving: false,
    celebrating: false,
    incoming: null,
    frameBallX: 0,
    frameBallY: 1,
    frameBallZ: 0,
  };
}

/** Lets each player's frame see the ball position once the frame is complete. */
export function shareBallPosition(frame: SceneFrame): void {
  for (const p of frame.players) {
    p.frameBallX = frame.ball.pos.x;
    p.frameBallY = frame.ball.pos.y;
    p.frameBallZ = frame.ball.pos.z;
  }
}

export function createSceneFrame(): SceneFrame {
  return {
    ball: { pos: vec(), vel: vec(), spin: 0, charge: 0, held: true },
    players: [createPlayerFrame(NEAR), createPlayerFrame(FAR)],
  };
}

export function isCelebrating(world: World, side: Side): boolean {
  return (
    (world.phase === 'dead' && world.lastPointWinner === side && world.phaseTime > 0.25 && world.phaseTime < 1.45) ||
    (world.phase === 'over' && world.winner === side)
  );
}

const pooledIncoming = (out: PlayerFrame): IncomingFrame =>
  out.incoming ?? { t: 0, x: 0, y: 0, z: 0, reachable: false, bounced: false };

/** Copies the live match into a frame, blending between simulation ticks. */
export function readWorldFrame(world: World, alpha: number, out: SceneFrame): void {
  const b = world.ball;
  out.ball.pos.x = lerp(b.prevPos.x, b.pos.x, alpha);
  out.ball.pos.y = lerp(b.prevPos.y, b.pos.y, alpha);
  out.ball.pos.z = lerp(b.prevPos.z, b.pos.z, alpha);
  out.ball.vel.x = b.vel.x;
  out.ball.vel.y = b.vel.y;
  out.ball.vel.z = b.vel.z;
  out.ball.spin = b.spin;
  out.ball.charge = b.charge;
  out.ball.held = b.held;

  for (const side of [NEAR, FAR] as const) {
    const p = world.players[side];
    const f = out.players[side];
    f.pos.x = lerp(p.prevPos.x, p.pos.x, alpha);
    f.pos.y = lerp(p.prevPos.y, p.pos.y, alpha);
    f.pos.z = lerp(p.prevPos.z, p.pos.z, alpha);
    f.vel.x = p.vel.x;
    f.vel.y = p.vel.y;
    f.vel.z = p.vel.z;
    f.onGround = p.onGround;
    f.swing = p.swing;
    f.tossTime = p.tossTime;
    f.chargeLevel = p.chargeLevel;
    f.charging = p.chargeTime >= 0 && p.tossTime < 0;
    f.serving = world.phase === 'ready' && world.server === side;
    f.celebrating = isCelebrating(world, side);

    const crossing = world.crossing(side);
    if (crossing) {
      const incoming = pooledIncoming(f);
      incoming.t = crossing.t;
      incoming.x = crossing.x;
      incoming.y = crossing.y;
      incoming.z = crossing.z;
      incoming.reachable = crossing.reachable;
      incoming.bounced = crossing.bounced;
      f.incoming = incoming;
    } else {
      f.incoming = null;
    }
  }
  shareBallPosition(out);
}
