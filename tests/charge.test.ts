import { describe, expect, it } from 'vitest';
import { CHARGE, GRAVITY, PLAYER, SWING, TICK } from '../src/sim/constants';
import { emptyIntent, FAR, NEAR, type PlayerIntent } from '../src/sim/types';
import { IDEAL_TOSS_TIME, World, type GameEvent } from '../src/sim/world';
import { playMatch } from './helpers';

type Hit = Extract<GameEvent, { type: 'hit' }>;

interface Scene {
  world: World;
  intents: [PlayerIntent, PlayerIntent];
  events: GameEvent[];
  step(ticks?: number): void;
  crossingIn(): number;
}

/** A live rally with the far player's ball arriving at the near player after `arrival` seconds. */
function incomingBall(arrival: number): Scene {
  const world = new World({ seed: 9 });
  const intents: [PlayerIntent, PlayerIntent] = [emptyIntent(), emptyIntent()];
  const events: GameEvent[] = [];
  const me = world.players[NEAR];
  me.pos.x = 0;
  me.pos.z = 12.8;
  world.phase = 'rally';
  world.lastHitter = FAR;
  world.rally = 1;
  world.bounces = 1;

  const b = world.ball;
  const speed = 14;
  const plane = me.pos.z - PLAYER.contactFront;
  b.held = false;
  b.g = GRAVITY;
  b.pos.x = 0.6;
  b.pos.y = 1.3;
  b.pos.z = plane - speed * arrival;
  b.vel.x = 0;
  b.vel.y = (1 - b.pos.y + 0.5 * GRAVITY * arrival * arrival) / arrival;
  b.vel.z = speed;

  const step = (ticks = 1) => {
    for (let i = 0; i < ticks; i++) {
      world.step(intents);
      intents[NEAR].swing = false;
      events.push(...world.drainEvents());
    }
  };
  return { world, intents, events, step, crossingIn: () => world.crossing(NEAR)?.t ?? -1 };
}

const hitsIn = (events: GameEvent[]): Hit[] => events.filter((e): e is Hit => e.type === 'hit');

function press(scene: Scene, held: boolean): void {
  scene.intents[NEAR].swing = true;
  scene.intents[NEAR].held = held;
}

function untilIdeal(scene: Scene): void {
  while (scene.crossingIn() > SWING.lead + TICK) scene.step();
}

describe('charged shots', () => {
  it('still treats an early tap as a swing at nothing', () => {
    const s = incomingBall(1.2);
    press(s, false);
    s.step(2);
    expect(s.events.some((e) => e.type === 'whiff')).toBe(true);
    expect(s.world.players[NEAR].chargeTime).toBe(-1);
  });

  it('swings at once when pressed inside the timing window, even if held', () => {
    const s = incomingBall(0.5);
    untilIdeal(s);
    press(s, true);
    s.step(30);
    const [hit] = hitsIn(s.events);
    expect(hit).toBeDefined();
    expect(hit.charge).toBe(0);
    expect(hit.timing).toBe('perfect');
  });

  it('builds power while held and fires a faster ball on release', () => {
    const plain = incomingBall(1.2);
    untilIdeal(plain);
    press(plain, false);
    plain.step(30);
    const normal = hitsIn(plain.events)[0];

    const s = incomingBall(1.2);
    press(s, true);
    s.step(Math.round(CHARGE.fullAfter / TICK) + 2);
    const me = s.world.players[NEAR];
    expect(me.chargeLevel).toBe(1);
    expect(s.events.some((e) => e.type === 'charge-full')).toBe(true);
    untilIdeal(s);
    s.intents[NEAR].held = false;
    s.step(30);
    const charged = hitsIn(s.events)[0];

    expect(charged.charge).toBe(1);
    expect(charged.timing).toBe('perfect');
    expect(charged.speed).toBeGreaterThan(normal.speed * 1.2);
    expect(s.world.stats[NEAR].chargedHits).toBe(1);
    expect(s.world.ball.charge).toBe(1);
  });

  it('slows the player down while winding up', () => {
    const s = incomingBall(1.4);
    s.intents[NEAR].moveX = 1;
    s.step(10);
    press(s, true);
    s.step(60);
    expect(Math.abs(s.world.players[NEAR].vel.x)).toBeCloseTo(PLAYER.maxSpeed * CHARGE.moveFactor, 1);
  });

  it('fires late on its own when the button is held too long', () => {
    const s = incomingBall(1.1);
    press(s, true);
    s.step(150);
    const [hit] = hitsIn(s.events);
    expect(hit).toBeDefined();
    expect(hit.charge).toBeGreaterThan(0.9);
    expect(hit.timing).toBe('late');
  });

  it('makes a heavy ball harder to return well', () => {
    const light = incomingBall(0.6);
    untilIdeal(light);
    press(light, false);
    light.step(30);

    const heavy = incomingBall(0.6);
    heavy.world.ball.charge = 1;
    untilIdeal(heavy);
    press(heavy, false);
    heavy.step(30);
    expect(hitsIn(heavy.events)[0].quality).toBeLessThan(hitsIn(light.events)[0].quality);
  });
});

describe('charged serves', () => {
  function serveScene() {
    const world = new World({ seed: 4 });
    const intents: [PlayerIntent, PlayerIntent] = [emptyIntent(), emptyIntent()];
    const events: GameEvent[] = [];
    const step = (ticks = 1) => {
      for (let i = 0; i < ticks; i++) {
        world.step(intents);
        intents[NEAR].swing = false;
        events.push(...world.drainEvents());
      }
    };
    return { world, intents, events, step };
  }

  it('keeps tap-toss then tap-hit working', () => {
    const s = serveScene();
    s.intents[NEAR].swing = true;
    s.step(2);
    expect(s.world.phase).toBe('toss');
    s.step(Math.round(IDEAL_TOSS_TIME / TICK) - 3);
    s.intents[NEAR].swing = true;
    s.step(4);
    const [hit] = hitsIn(s.events);
    expect(hit.shot).toBe('serve');
    expect(hit.charge).toBe(0);
  });

  it('does not serve when a toss click is only slightly long', () => {
    const s = serveScene();
    s.intents[NEAR].swing = true;
    s.intents[NEAR].held = true;
    s.step(Math.round(0.2 / TICK));
    s.intents[NEAR].held = false;
    s.step(4);
    expect(s.world.phase).toBe('toss');
    expect(hitsIn(s.events)).toHaveLength(0);
  });

  it('serves harder when the toss press is held to the top', () => {
    const plain = serveScene();
    plain.intents[NEAR].swing = true;
    plain.step(1);
    plain.step(Math.round(IDEAL_TOSS_TIME / TICK) - 2);
    plain.intents[NEAR].swing = true;
    plain.step(4);

    const s = serveScene();
    s.intents[NEAR].swing = true;
    s.intents[NEAR].held = true;
    s.step(Math.round(IDEAL_TOSS_TIME / TICK) - 1);
    s.intents[NEAR].held = false;
    s.step(4);
    const [charged] = hitsIn(s.events);
    expect(charged.charge).toBeGreaterThan(0.5);
    expect(charged.speed).toBeGreaterThan(hitsIn(plain.events)[0].speed * 1.08);
  });
});

describe('AI power shots', () => {
  it('uses charged shots during a match and still finishes it', () => {
    let charged = 0;
    for (let seed = 0; seed < 6; seed++) {
      const result = playMatch('hard', 'hard', 300 + seed);
      expect(result.world.winner).not.toBeNull();
      charged += hitsIn(result.events).filter((e) => e.charge > 0.3).length;
    }
    expect(charged).toBeGreaterThan(5);
  });
});
