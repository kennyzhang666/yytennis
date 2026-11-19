import { AI_PROFILES, AIController, tuningFor, type AIProfile, type Difficulty } from '../src/sim/ai';
import { TICK } from '../src/sim/constants';
import { FAR, NEAR, type PlayerIntent } from '../src/sim/types';
import { World, type GameEvent } from '../src/sim/world';

export interface MatchResult {
  world: World;
  events: GameEvent[];
  seconds: number;
}

export function playProfiles(near: AIProfile, far: AIProfile, seed: number, maxSeconds = 1800): MatchResult {
  const world = new World({ seed, firstServer: seed % 2 === 0 ? NEAR : FAR });
  const nearAI = new AIController(NEAR, near, seed * 3 + 1);
  const farAI = new AIController(FAR, far, seed * 5 + 2);
  world.tunePlayer(NEAR, tuningFor(near));
  world.tunePlayer(FAR, tuningFor(far));

  const events: GameEvent[] = [];
  const intents: [PlayerIntent, PlayerIntent] = [nearAI.intent, farAI.intent];
  const maxTicks = Math.round(maxSeconds / TICK);
  let ticks = 0;
  while (world.phase !== 'over' && ticks < maxTicks) {
    intents[NEAR] = nearAI.update(world);
    intents[FAR] = farAI.update(world);
    world.step(intents);
    events.push(...world.drainEvents());
    ticks++;
  }
  return { world, events, seconds: ticks * TICK };
}

export function playMatch(near: Difficulty, far: Difficulty, seed: number, maxSeconds = 1800): MatchResult {
  return playProfiles(AI_PROFILES[near], AI_PROFILES[far], seed, maxSeconds);
}

export interface Summary {
  nearWinRate: number;
  avgRally: number;
  avgMatchMinutes: number;
  unfinished: number;
  reasons: Record<string, number>;
}

export function summarize(near: AIProfile, far: AIProfile, matches: number): Summary {
  let nearWins = 0;
  let points = 0;
  let shots = 0;
  let seconds = 0;
  let unfinished = 0;
  const reasons: Record<string, number> = {};
  for (let i = 0; i < matches; i++) {
    const result = playProfiles(near, far, 1000 + i);
    if (result.world.winner === null) unfinished++;
    if (result.world.winner === NEAR) nearWins++;
    seconds += result.seconds;
    for (const e of result.events) {
      if (e.type === 'point') {
        points++;
        shots += e.rally;
        const who = e.winner === NEAR ? 'near' : 'far';
        const key = `${who}:${e.reason}`;
        reasons[key] = (reasons[key] ?? 0) + 1;
      }
    }
  }
  return {
    nearWinRate: nearWins / matches,
    avgRally: shots / points,
    avgMatchMinutes: seconds / matches / 60,
    unfinished,
    reasons,
  };
}
