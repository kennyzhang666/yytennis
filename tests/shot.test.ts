import { describe, expect, it } from 'vitest';
import { createBall, predictPath, stepBall, type BallEvent } from '../src/sim/ball';
import { BALL_RADIUS, COURT, netHeight, TICK } from '../src/sim/constants';
import { SHOT_PROFILES, solveIntoNet, solveShot, timingQuality } from '../src/sim/shot';
import type { Vec3 } from '../src/sim/types';

function launch(from: Vec3, vx: number, vy: number, vz: number, g: number) {
  const ball = createBall();
  ball.held = false;
  ball.pos = { ...from };
  ball.vel = { x: vx, y: vy, z: vz };
  ball.g = g;
  return ball;
}

describe('solveShot', () => {
  const cases = [
    { from: { x: 1, y: 1, z: 12.5 }, x: -3, z: -9, kind: 'drive' },
    { from: { x: -3.5, y: 0.45, z: 13.5 }, x: 3.8, z: -11.2, kind: 'drive' },
    { from: { x: 0.5, y: 1.3, z: 3 }, x: 3, z: -4, kind: 'volley' },
    { from: { x: 2, y: 3.1, z: 6 }, x: -3, z: -8, kind: 'smash' },
    { from: { x: 1.35, y: 2.9, z: 12.25 }, x: -3.5, z: -5.9, kind: 'serve' },
  ] as const;

  for (const c of cases) {
    it(`lands a ${c.kind} on its target and clears the net`, () => {
      const profile = SHOT_PROFILES[c.kind];
      const shot = solveShot({
        from: c.from,
        targetX: c.x,
        targetZ: c.z,
        g: profile.g,
        speed: profile.maxSpeed,
        clearance: profile.clearance,
      });
      const ball = launch(c.from, shot.vx, shot.vy, shot.vz, profile.g);
      const events: BallEvent[] = [];
      let lowestAtNet = Infinity;
      for (let i = 0; i < 1200 && !events.some((e) => e.type === 'bounce'); i++) {
        const before = ball.pos.z;
        stepBall(ball, TICK, events);
        if (before > 0 && ball.pos.z <= 0) lowestAtNet = ball.pos.y;
      }
      expect(events.some((e) => e.type === 'net')).toBe(false);
      const bounce = events.find((e) => e.type === 'bounce');
      expect(bounce).toBeDefined();
      if (bounce?.type === 'bounce') {
        expect(bounce.x).toBeCloseTo(c.x, 6);
        expect(bounce.z).toBeCloseTo(c.z, 6);
      }
      expect(lowestAtNet - BALL_RADIUS).toBeGreaterThan(netHeight(0));
    });
  }

  it('agrees with the closed-form path prediction', () => {
    const shot = solveShot({ from: { x: 0, y: 1, z: 12 }, targetX: 2, targetZ: -8, g: 14, speed: 20, clearance: 0.4 });
    const ball = launch({ x: 0, y: 1, z: 12 }, shot.vx, shot.vy, shot.vz, 14);
    const path = predictPath(ball);
    expect(path.hitsNet).toBe(false);
    expect(path.firstBounce?.x).toBeCloseTo(2, 8);
    expect(path.firstBounce?.z).toBeCloseTo(-8, 8);
    expect(path.firstBounce?.t).toBeCloseTo(shot.time, 8);
    expect(path.segments.length).toBe(2);
  });

  it('predicts a ball that will strike the net', () => {
    const ball = launch({ x: 0, y: 0.6, z: 6 }, 0, 1.5, -18, 12);
    expect(predictPath(ball).hitsNet).toBe(true);
    const events: BallEvent[] = [];
    for (let i = 0; i < 120; i++) stepBall(ball, TICK, events);
    expect(events[0]?.type).toBe('net');
    expect(ball.pos.z).toBeGreaterThan(0);
  });

  it('sends a net mishit into the net at normal pace', () => {
    const from = { x: 1, y: 1, z: 12.5 };
    const shot = solveIntoNet(from, -2, -9, 14, 20, 0.6);
    expect(Math.hypot(shot.vx, shot.vz)).toBeCloseTo(20, 6);
    const ball = launch(from, shot.vx, shot.vy, shot.vz, 14);
    const events: BallEvent[] = [];
    for (let i = 0; i < 240 && events.length === 0; i++) stepBall(ball, TICK, events);
    expect(events[0]?.type).toBe('net');
    if (events[0]?.type === 'net') expect(events[0].y).toBeCloseTo(0.6, 5);
  });

  it('keeps every target inside a real court in this test set', () => {
    for (const c of cases) {
      expect(Math.abs(c.x)).toBeLessThanOrEqual(COURT.halfWidth);
      expect(Math.abs(c.z)).toBeLessThanOrEqual(COURT.halfLength);
    }
  });
});

describe('timingQuality', () => {
  it('rewards accurate timing and fades to zero', () => {
    expect(timingQuality(0)).toBe(1);
    expect(timingQuality(0.04)).toBeGreaterThan(0.93);
    expect(timingQuality(0.12)).toBeLessThan(timingQuality(0.04));
    expect(timingQuality(-0.3)).toBe(0);
    expect(timingQuality(0.12, 1.5)).toBeGreaterThan(timingQuality(0.12));
  });
});
