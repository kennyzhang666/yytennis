import { describe, expect, it } from 'vitest';
import { AI_PROFILES, type AIProfile } from '../src/sim/ai';
import { FAR, NEAR } from '../src/sim/types';
import { playMatch, summarize } from './helpers';

/** Rough stand-ins for people: full movement and reach, human timing and choices. */
const CASUAL_PLAYER: AIProfile = {
  reaction: 0.32,
  speed: 0.84,
  reach: 1,
  power: 1,
  timingSigma: 0.085,
  pressure: 1,
  blunder: 0.06,
  pressureBlunder: 0.15,
  predictError: 0.5,
  openCourt: 0.5,
  maxU: 0.62,
  minV: 0.45,
  maxV: 0.8,
  lobChance: 0.05,
  judgement: 0.3,
  serveU: 0.35,
  serveV: 0.62,
};

const SKILLED_PLAYER: AIProfile = {
  reaction: 0.22,
  speed: 0.95,
  reach: 1,
  power: 1,
  timingSigma: 0.05,
  pressure: 0.8,
  blunder: 0.025,
  pressureBlunder: 0.08,
  predictError: 0.2,
  openCourt: 0.85,
  maxU: 0.88,
  minV: 0.6,
  maxV: 0.95,
  lobChance: 0.15,
  judgement: 0.8,
  serveU: 0.7,
  serveV: 0.85,
};

describe('AI matches', () => {
  it('always finishes a match', () => {
    const result = playMatch('normal', 'normal', 42);
    expect(result.world.winner === NEAR || result.world.winner === FAR).toBe(true);
    expect(result.seconds).toBeLessThan(900);
  });

  it('is replayable from the same seed', () => {
    const a = playMatch('normal', 'hard', 7);
    const b = playMatch('normal', 'hard', 7);
    expect(a.world.points).toEqual(b.world.points);
    expect(a.seconds).toBe(b.seconds);
  });

  it('keeps matches short and difficulty levels in order', () => {
    const { easy, normal, hard } = AI_PROFILES;
    const same = summarize(normal, normal, 40);
    const easyVsNormal = summarize(easy, normal, 40);
    const normalVsHard = summarize(normal, hard, 40);

    expect(same.unfinished).toBe(0);
    expect(same.avgRally).toBeGreaterThan(3);
    expect(same.avgRally).toBeLessThan(14);
    expect(same.avgMatchMinutes).toBeLessThan(6);
    expect(easyVsNormal.nearWinRate).toBeLessThan(0.3);
    expect(normalVsHard.nearWinRate).toBeLessThan(0.35);
  }, 120_000);

  it('gives each kind of player a fitting challenge', () => {
    const { easy, normal, hard } = AI_PROFILES;
    const table = {
      casualVsEasy: summarize(CASUAL_PLAYER, easy, 60),
      casualVsNormal: summarize(CASUAL_PLAYER, normal, 60),
      casualVsHard: summarize(CASUAL_PLAYER, hard, 60),
      skilledVsEasy: summarize(SKILLED_PLAYER, easy, 60),
      skilledVsNormal: summarize(SKILLED_PLAYER, normal, 60),
      skilledVsHard: summarize(SKILLED_PLAYER, hard, 60),
    };
    for (const [name, s] of Object.entries(table)) {
      console.log(
        name.padEnd(16),
        `win ${(s.nearWinRate * 100).toFixed(0)}%`.padEnd(9),
        `rally ${s.avgRally.toFixed(1)}`.padEnd(11),
        `${s.avgMatchMinutes.toFixed(1)} min`.padEnd(9),
        JSON.stringify(s.reasons),
      );
    }
    expect(table.casualVsEasy.nearWinRate).toBeGreaterThan(0.6);
    expect(table.casualVsHard.nearWinRate).toBeLessThan(0.3);
    expect(table.skilledVsEasy.nearWinRate).toBeGreaterThan(0.9);
    expect(table.skilledVsNormal.nearWinRate).toBeGreaterThan(0.55);
    expect(table.skilledVsHard.nearWinRate).toBeGreaterThan(0.15);
    expect(table.skilledVsHard.nearWinRate).toBeLessThan(0.8);
  }, 180_000);
});
