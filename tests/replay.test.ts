import { describe, expect, it } from 'vitest';
import { AI_PROFILES, AIController, tuningFor } from '../src/sim/ai';
import { BALL_RADIUS } from '../src/sim/constants';
import { createSceneFrame } from '../src/sim/frame';
import { ReplayRecorder, replayRate, type ReplayClip } from '../src/sim/replay';
import { FAR, NEAR, type PlayerIntent } from '../src/sim/types';
import { World } from '../src/sim/world';

function playPoints(seed: number, minRally: number, maxRally = Infinity): { clip: ReplayClip; world: World } {
  for (let attempt = 0; attempt < 30; attempt++) {
    const found = searchMatch(seed + attempt, minRally, maxRally);
    if (found) return found;
  }
  throw new Error('No suitable point was played');
}

function searchMatch(seed: number, minRally: number, maxRally: number): { clip: ReplayClip; world: World } | null {
  const world = new World({ seed });
  const near = new AIController(NEAR, AI_PROFILES.hard, seed + 1);
  const far = new AIController(FAR, AI_PROFILES.hard, seed + 2);
  world.tunePlayer(NEAR, tuningFor(AI_PROFILES.hard));
  world.tunePlayer(FAR, tuningFor(AI_PROFILES.hard));
  const recorder = new ReplayRecorder();
  const intents: [PlayerIntent, PlayerIntent] = [near.intent, far.intent];
  let pointAt = -1;
  let wanted = false;

  for (let tick = 0; tick < 120 * 600 && world.phase !== 'over'; tick++) {
    intents[NEAR] = near.update(world);
    intents[FAR] = far.update(world);
    world.step(intents);
    recorder.capture(world);
    for (const event of world.drainEvents()) {
      recorder.note(event);
      if (event.type === 'point') {
        pointAt = tick;
        wanted = event.rally >= minRally && event.rally <= maxRally && !event.matchPoint;
      }
    }
    if (pointAt >= 0 && tick - pointAt === 108) {
      if (wanted) {
        const clip = recorder.buildClip();
        if (clip) return { clip, world };
      }
      pointAt = -1;
    }
  }
  return null;
}

describe('replay clips', () => {
  const { clip } = playPoints(77, 3);

  it('covers the final exchange and the moments after it', () => {
    const hits = clip.events.filter((e) => e.event.type === 'hit');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(clip.pointTime).toBeGreaterThan(clip.start);
    expect(clip.end).toBeCloseTo(clip.pointTime + 0.9, 1);
    expect(clip.duration).toBeLessThanOrEqual(9.01);
  });

  it('puts the ball exactly where each recorded event happened', () => {
    const frame = createSceneFrame();
    for (const { t, event } of clip.events) {
      if (event.type === 'hit') {
        clip.sample(t, frame);
        expect(Math.hypot(frame.ball.pos.x - event.x, frame.ball.pos.z - event.z)).toBeLessThan(0.12);
        expect(Math.abs(frame.ball.pos.y - event.y)).toBeLessThan(0.12);
      }
      if (event.type === 'bounce') {
        clip.sample(t, frame);
        expect(Math.hypot(frame.ball.pos.x - event.x, frame.ball.pos.z - event.z)).toBeLessThan(0.2);
        expect(frame.ball.pos.y).toBeLessThan(BALL_RADIUS + 0.12);
      }
    }
  });

  it('restores swings so the players can be animated again', () => {
    const frame = createSceneFrame();
    const hit = clip.events.find((e) => e.event.type === 'hit');
    if (!hit || hit.event.type !== 'hit') throw new Error('Clip has no hit');
    clip.sample(hit.t + 0.05, frame);
    const swing = frame.players[hit.event.side].swing;
    expect(swing).not.toBeNull();
    expect(swing?.releaseT).not.toBeNull();
    expect(swing?.contact?.y).toBeCloseTo(hit.event.y, 1);
    expect(swing?.shot).toBe(hit.event.shot);
  });

  it('moves players smoothly between recorded frames', () => {
    const frame = createSceneFrame();
    let previous: number | null = null;
    let largest = 0;
    for (let t = clip.start; t < clip.end; t += 1 / 240) {
      clip.sample(t, frame);
      if (previous !== null) largest = Math.max(largest, Math.abs(frame.players[NEAR].pos.x - previous));
      previous = frame.players[NEAR].pos.x;
    }
    expect(largest).toBeLessThan(0.08);
  });

  it('scores longer rallies as more exciting', () => {
    expect(clip.excitement).toBeGreaterThanOrEqual(Math.min(5, clip.point.rally * 0.42));
    const longer = playPoints(21, 10).clip;
    const shorter = playPoints(21, 1, 3).clip;
    expect(longer.point.rally).toBeGreaterThan(shorter.point.rally);
    expect(longer.excitement).toBeGreaterThan(Math.min(5, shorter.point.rally * 0.42));
  });
});

describe('replay speed', () => {
  it('slows down around key moments and recovers between them', () => {
    const keys = [1, 2.5];
    expect(replayRate(2.5, keys, 2.5)).toBeCloseTo(0.2, 5);
    expect(replayRate(1, keys, 2.5)).toBeCloseTo(0.2, 5);
    expect(replayRate(1.75, keys, 2.5)).toBeCloseTo(0.72, 5);
    expect(replayRate(2.3, keys, 2.5)).toBeLessThan(replayRate(1.9, keys, 2.5));
  });
});
