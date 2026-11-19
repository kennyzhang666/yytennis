import { describe, expect, it } from 'vitest';
import { TICK } from '../src/sim/constants';
import { emptyIntent, FAR, NEAR, type PlayerIntent } from '../src/sim/types';
import { IDEAL_TOSS_TIME, serverForPoint, serviceBoxFor, World } from '../src/sim/world';

const idle = (): [PlayerIntent, PlayerIntent] => [emptyIntent(), emptyIntent()];

function stepFor(world: World, seconds: number, intents = idle()): void {
  const ticks = Math.round(seconds / TICK);
  for (let i = 0; i < ticks; i++) world.step(intents);
}

/** Tosses and strikes a perfectly timed serve aimed by u and v. */
function serve(world: World, u: number, v: number): void {
  const intents = idle();
  const side = world.server;
  intents[side].aimU = u;
  intents[side].aimV = v;
  intents[side].swing = true;
  world.step(intents);
  intents[side].swing = false;
  const toss = Math.round(IDEAL_TOSS_TIME / TICK);
  for (let i = 1; i < toss; i++) world.step(intents);
  intents[side].swing = true;
  world.step(intents);
  intents[side].swing = false;
  for (let i = 0; i < 4; i++) world.step(intents);
}

describe('serving rotation', () => {
  it('follows the tie-break pattern', () => {
    const order = Array.from({ length: 8 }, (_, i) => serverForPoint(i, NEAR));
    expect(order).toEqual([NEAR, FAR, FAR, NEAR, NEAR, FAR, FAR, NEAR]);
  });

  it('serves diagonally from the correct court', () => {
    const nearDeuce = serviceBoxFor(NEAR, 0);
    expect(nearDeuce.serverX).toBe(1);
    expect(nearDeuce.maxX).toBe(0);
    expect(nearDeuce.zSign).toBe(-1);

    const farAd = serviceBoxFor(FAR, 1);
    expect(farAd.serverX).toBe(1);
    expect(farAd.maxX).toBe(0);
    expect(farAd.zSign).toBe(1);
  });
});

describe('point rules', () => {
  it('awards an ace when a good serve is untouched', () => {
    const world = new World({ seed: 3 });
    serve(world, 0, 0.6);
    expect(world.phase).toBe('serve');
    stepFor(world, 4);
    expect(world.points).toEqual([1, 0]);
    expect(world.stats[NEAR].aces).toBe(1);
  });

  it('gives a second serve after a fault, then loses the point on a double fault', () => {
    const world = new World({ seed: 5 });
    const force = () => {
      serve(world, 0, 0.6);
      world.ball.vel.x = -14;
      world.ball.vel.z *= 1;
    };
    force();
    stepFor(world, 1.2);
    expect(world.serveNumber).toBe(2);
    expect(world.points).toEqual([0, 0]);
    stepFor(world, 3);
    expect(world.phase).toBe('ready');
    force();
    stepFor(world, 1.2);
    expect(world.points).toEqual([0, 1]);
    expect(world.stats[NEAR].doubleFaults).toBe(1);
  });

  it('calls a shot out when its first bounce misses the court', () => {
    const world = new World({ seed: 8 });
    serve(world, 0, 0.6);
    stepFor(world, 0.45);
    // Skip to a live rally ball hit by the far player that lands long.
    world.phase = 'rally';
    world.lastHitter = FAR;
    world.rally = 2;
    world.bounces = 0;
    Object.assign(world.ball.pos, { x: 0, y: 1.2, z: -3 });
    Object.assign(world.ball.vel, { x: 0, y: 3, z: 26 });
    world.ball.g = 9.81;
    stepFor(world, 1.5);
    expect(world.points).toEqual([1, 0]);
    expect(world.stats[FAR].errors).toBe(1);
  });

  it('ends a tie-break only with a two point lead', () => {
    const world = new World({ seed: 1 });
    const award = (side: 0 | 1) => {
      world.phase = 'rally';
      world.lastHitter = side === NEAR ? FAR : NEAR;
      world.ball.held = false;
      world.ball.rolling = false;
      const z = side === NEAR ? -1 : 1;
      Object.assign(world.ball.pos, { x: 0, y: 0.5, z: z * 20 });
      Object.assign(world.ball.vel, { x: 0, y: -1, z: 0 });
      world.step(idle());
      while (world.phase === 'rally') world.step(idle());
      while (world.phase === 'dead') world.step(idle());
      while (world.phase === 'reset') world.step(idle());
    };
    for (let i = 0; i < 6; i++) {
      award(NEAR);
      award(FAR);
    }
    expect(world.points).toEqual([6, 6]);
    award(NEAR);
    expect(world.winner).toBeNull();
    award(FAR);
    expect(world.winner).toBeNull();
    award(FAR);
    expect(world.points).toEqual([7, 8]);
    expect(world.winner).toBeNull();
    award(FAR);
    expect(world.winner).toBe(FAR);
    expect(world.phase).toBe('over');
  });
});

describe('swinging', () => {
  it('needs a second press near the top of the toss, and restores the ball if missed', () => {
    const world = new World({ seed: 2 });
    const intents = idle();
    intents[NEAR].swing = true;
    world.step(intents);
    intents[NEAR].swing = false;
    expect(world.phase).toBe('toss');
    stepFor(world, 2, intents);
    expect(world.phase).toBe('ready');
    expect(world.ball.held).toBe(true);
    expect(world.points).toEqual([0, 0]);
  });
});
