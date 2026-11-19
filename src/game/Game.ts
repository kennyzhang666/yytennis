import { AudioEngine } from '../audio/AudioEngine';
import { InputManager, type InputMode } from '../input/InputManager';
import { AI_PROFILES, AIController, tuningFor, type Difficulty } from '../sim/ai';
import { PLAYER, SWING, TICK } from '../sim/constants';
import { clamp01 } from '../sim/math';
import { FAR, NEAR, type PlayerIntent } from '../sim/types';
import { World, type GameEvent, type PointReason } from '../sim/world';
import { Hud } from '../ui/Hud';
import { DIFFICULTY_NAMES, Menus } from '../ui/Menus';
import { detectTier, SceneView } from '../view/SceneView';

type Mode = 'menu' | 'playing' | 'paused' | 'finished';

const WIN_TEXT: Record<PointReason, string> = {
  winner: '漂亮的制胜分',
  ace: 'ACE！',
  out: '对手出界',
  net: '对手下网',
  'double-fault': '对手双发失误',
};

const LOSE_TEXT: Record<PointReason, string> = {
  winner: '没接到',
  ace: '被 ACE 了',
  out: '出界了',
  net: '下网了',
  'double-fault': '双发失误',
};

const TIMING_TEXT = { perfect: '完美！', good: '不错', early: '早了', late: '晚了' } as const;

/** How much higher a jump lets the racket reach. */
const JUMP_REACH = (PLAYER.jumpSpeed * PLAYER.jumpSpeed) / (2 * PLAYER.gravity);

/** The sim's ball is slower than a real one, so shown speeds are scaled to feel right. */
const speedKmh = (metersPerSecond: number) => Math.round(metersPerSecond * 3.6 * 1.7);

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function saveFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch {
    // Settings simply won't persist in this browser session.
  }
}

export class Game {
  private readonly view: SceneView;
  private readonly input: InputManager;
  private readonly audio = new AudioEngine();
  private readonly hud: Hud;
  private readonly menus: Menus;
  private readonly reducedMotion: boolean;

  private world: World;
  private ais: [AIController, AIController];
  private mode: Mode = 'menu';
  private difficulty: Difficulty = 'normal';
  private seed = (Date.now() & 0xffff) + 1;
  private accumulator = 0;
  private lastFrame = 0;
  private hitStop = 0;
  private tutorialDone = loadFlag('yy.tutorial');
  /** Development only: lets automated checks play the human's side. */
  autopilot = false;
  /** Development only: holds the game still between scripted steps. */
  debugFrozen = false;

  constructor(root: HTMLElement) {
    const canvas = root.querySelector<HTMLCanvasElement>('#game');
    const ui = root.querySelector<HTMLElement>('#ui');
    if (!canvas || !ui) throw new Error('Game markup is missing');

    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.audio.muted = loadFlag('yy.muted');
    this.view = new SceneView(canvas, detectTier());
    this.input = new InputManager(canvas, ui);
    this.hud = new Hud(ui);
    this.menus = new Menus(ui, {
      onStart: (difficulty) => this.startMatch(difficulty),
      onResume: () => this.resume(),
      onRestart: () => this.startMatch(this.difficulty),
      onHome: () => this.goHome(),
      onToggleSound: () => {
        this.audio.setMuted(!this.audio.muted);
        saveFlag('yy.muted', this.audio.muted);
        return this.audio.muted;
      },
      onClick: () => {
        this.audio.unlock();
        this.audio.click();
      },
    });
    this.menus.setInputMode(this.input.mode);

    this.world = new World({ seed: this.seed });
    this.ais = this.createAttractAIs();
    this.applyAttractTuning();

    this.hud.onPause = () => this.pause();
    this.input.onPauseKey = () => {
      if (this.mode === 'playing') this.pause();
      else if (this.mode === 'paused') this.resume();
    };
    this.input.onModeChange = (mode) => this.onInputMode(mode);

    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
    window.visualViewport?.addEventListener('resize', this.onResize);
    window.addEventListener('pointerdown', () => this.audio.unlock(), { passive: true });
    window.addEventListener('blur', () => this.pauseIfPlaying());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.pauseIfPlaying();
        this.audio.suspend();
      }
    });
    // Stops iOS rubber-banding and pinch zoom from moving the game around,
    // while still letting a menu scroll if it doesn't fit on a small screen.
    document.addEventListener(
      'touchmove',
      (e) => {
        if (!(e.target instanceof Element && e.target.closest('.screen'))) e.preventDefault();
      },
      { passive: false },
    );
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.pauseIfPlaying();
    });

    this.menus.showHome();
    requestAnimationFrame(this.frame);
  }

  private createAttractAIs(): [AIController, AIController] {
    return [
      new AIController(NEAR, AI_PROFILES.hard, this.seed + 11),
      new AIController(FAR, AI_PROFILES.hard, this.seed + 29),
    ];
  }

  private applyAttractTuning(): void {
    this.world.tunePlayer(NEAR, tuningFor(AI_PROFILES.hard));
    this.world.tunePlayer(FAR, tuningFor(AI_PROFILES.hard));
  }

  /** The AI-versus-AI match that plays behind the main menu. */
  private startAttractMatch(): void {
    this.world = new World({ seed: this.seed });
    this.ais = this.createAttractAIs();
    this.applyAttractTuning();
    this.view.resetForNewMatch(this.world);
  }

  private readonly onResize = (): void => {
    this.view.resize();
  };

  private onInputMode(mode: InputMode): void {
    this.menus.setInputMode(mode);
    if (this.mode === 'playing' || this.mode === 'paused') this.applyHumanTuning();
  }

  /** Touch has more input lag and a thumb in the way, so it gets a wider margin. */
  private applyHumanTuning(): void {
    const touch = this.input.mode === 'touch';
    this.world.tunePlayer(NEAR, {
      speedFactor: 1,
      powerScale: 1,
      reachScale: touch ? 1.14 : 1,
      timingScale: touch ? 1.35 : 1,
      contactDelay: touch ? SWING.touchDelay : SWING.mouseDelay,
    });
  }

  private startMatch(difficulty: Difficulty): void {
    this.difficulty = difficulty;
    this.seed = (this.seed + 7919) & 0xfffff;
    this.world = new World({ seed: this.seed, firstServer: NEAR });
    this.ais = [
      new AIController(NEAR, AI_PROFILES.hard, this.seed + 3),
      new AIController(FAR, AI_PROFILES[difficulty], this.seed + 5),
    ];
    this.world.tunePlayer(FAR, tuningFor(AI_PROFILES[difficulty]));
    this.applyHumanTuning();
    this.view.resetForNewMatch(this.world);
    this.accumulator = 0;
    this.hitStop = 0;
    this.mode = 'playing';
    this.menus.hide();
    this.hud.clearTransient();
    this.hud.setOpponent(DIFFICULTY_NAMES[difficulty]);
    this.hud.setVisible(true);
    this.refreshScore();
    this.input.setEnabled(true);
  }

  private pauseIfPlaying(): void {
    if (this.mode === 'playing') this.pause();
  }

  private pause(): void {
    if (this.mode !== 'playing') return;
    this.mode = 'paused';
    this.input.setEnabled(false);
    this.menus.showPause(this.audio.muted);
  }

  private resume(): void {
    if (this.mode !== 'paused') return;
    this.mode = 'playing';
    this.menus.hide();
    this.lastFrame = 0;
    this.input.setEnabled(true);
  }

  private goHome(): void {
    this.mode = 'menu';
    this.input.setEnabled(false);
    this.hud.setVisible(false);
    this.hud.clearTransient();
    this.seed = (this.seed + 104729) & 0xfffff;
    this.startAttractMatch();
    this.menus.showHome();
  }

  private finishMatch(winner: 0 | 1): void {
    this.mode = 'finished';
    this.input.setEnabled(false);
    this.hud.setHint(null);
    this.tutorialDone = true;
    saveFlag('yy.tutorial', true);
    const w = this.world;
    const [me, foe] = w.stats;
    const percent = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '–');
    const rows = [
      { label: '完美击球', me: percent(me.perfects, me.hits), foe: percent(foe.perfects, foe.hits) },
      { label: '制胜分', me: String(me.winners), foe: String(foe.winners) },
      { label: 'ACE', me: String(me.aces), foe: String(foe.aces) },
      { label: '失误', me: String(me.errors + me.doubleFaults), foe: String(foe.errors + foe.doubleFaults) },
      {
        label: '最快球速',
        me: me.topSpeed ? `${speedKmh(me.topSpeed)}` : '–',
        foe: foe.topSpeed ? `${speedKmh(foe.topSpeed)}` : '–',
      },
    ];
    window.setTimeout(() => {
      if (this.mode !== 'finished') return;
      this.hud.setVisible(false);
      this.menus.showResult({
        won: winner === NEAR,
        points: w.points,
        difficulty: this.difficulty,
        rows,
      });
    }, 900);
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const elapsed = this.lastFrame ? (now - this.lastFrame) / 1000 : 1 / 60;
    const dt = Math.min(0.1, elapsed);
    this.lastFrame = now;
    // A long gap means the tab was in the background, not that the device is slow.
    if (elapsed < 0.5) this.view.noteFrameTime(elapsed);
    if (this.debugFrozen) this.view.render();
    else this.advance(dt, true);
  };

  private advance(dt: number, draw: boolean): void {
    const running = this.mode !== 'paused';
    if (running) {
      let scale = 1;
      if (this.hitStop > 0) {
        this.hitStop -= dt;
        scale = 0.07;
      }
      this.accumulator += dt * scale;
      while (this.accumulator >= TICK) {
        this.accumulator -= TICK;
        this.tick();
      }
      this.view.footDust(this.world);
    }

    const human = this.mode === 'menu' ? null : NEAR;
    this.view.update(this.world, this.accumulator / TICK, running ? dt : 0, human);
    if (this.mode === 'playing') this.updateHint();
    if (draw) this.view.render();
  }

  private nearIntent(): PlayerIntent {
    if (this.mode === 'menu' || (this.autopilot && this.mode === 'playing')) {
      return this.ais[NEAR].update(this.world);
    }
    return this.input.sample();
  }

  private tick(): void {
    const w = this.world;
    if (this.mode === 'menu' && w.phase === 'over') {
      this.seed = (this.seed + 31) & 0xfffff;
      this.startAttractMatch();
      return;
    }
    const near = this.nearIntent();
    const far = this.ais[FAR].update(w);
    w.step([near, far]);
    for (const event of w.drainEvents()) this.handleEvent(event);
  }

  private refreshScore(): void {
    const w = this.world;
    const target = w.targetPoints;
    const [a, b] = w.points;
    const matchPoint = (mine: number, theirs: number) => mine >= target - 1 && mine > theirs;
    let tag = '抢七';
    if (matchPoint(a, b) || matchPoint(b, a)) tag = '赛点';
    else if (w.serveNumber === 2 && w.phase === 'ready') tag = '二发';
    this.hud.setScore(w.points, w.server, tag);
  }

  private updateHint(): void {
    const w = this.world;
    const touch = this.input.mode === 'touch';
    let hint: string | null = null;
    const serving = w.server === NEAR;
    if (w.phase === 'ready' && serving) {
      if (touch) hint = '点右半屏抛球';
      else hint = this.tutorialDone ? '点击抛球' : '移动鼠标选落点，点击抛球';
    } else if (w.phase === 'toss' && serving) {
      hint = touch ? '光环收拢时点右半屏发球' : '光环收拢时点击发球';
    } else if (!this.tutorialDone) {
      if (w.phase === 'ready') hint = '准备接发球';
      else if (w.isIncoming(NEAR)) {
        hint = touch ? '跑到黄圈附近，光环收拢时点右半屏' : 'WASD 跑到黄圈附近，光环收拢时点击';
      }
    }
    const crossing = w.crossing(NEAR);
    if (
      crossing &&
      crossing.tooHigh &&
      !crossing.tooWide &&
      crossing.t < 1 &&
      crossing.y < PLAYER.reachTop + JUMP_REACH
    ) {
      hint = touch ? '高球！点箭头起跳扣杀' : '高球！按空格起跳扣杀';
    }
    this.hud.setHint(hint);
  }

  // ---------------------------------------------------------------------------
  // Reacting to what happened on court
  // ---------------------------------------------------------------------------

  private popupAt(text: string, x: number, y: number, z: number, tone: 'perfect' | 'good' | 'miss' | 'speed'): void {
    const p = this.view.toScreen(x, y, z);
    this.hud.popup(text, p.x, p.y, tone);
  }

  private handleEvent(event: GameEvent): void {
    const w = this.world;
    const playing = this.mode === 'playing';
    const human = this.mode === 'menu' ? null : NEAR;
    this.view.onEvent(event, w, human);

    switch (event.type) {
      case 'hit': {
        const power = clamp01((event.speed - 12) / 24);
        const perfect = event.timing === 'perfect';
        this.audio.hit(power, event.x, event.z, perfect);
        if (!this.reducedMotion) {
          if (event.shot === 'smash') this.hitStop = 0.09;
          else if (perfect && event.side === NEAR && playing) this.hitStop = 0.05;
        }
        if (!playing) break;
        this.hud.setRally(event.rally);
        if (event.side === NEAR) {
          const tone = perfect ? 'perfect' : event.timing === 'good' ? 'good' : 'miss';
          this.popupAt(TIMING_TEXT[event.timing], event.x, event.y + 0.45, event.z, tone);
        }
        if (event.shot === 'serve' || event.shot === 'smash') {
          const label = `${speedKmh(event.speed)} km/h`;
          this.popupAt(label, event.x, event.y + 0.95, event.z, 'speed');
        }
        break;
      }
      case 'swing':
        if (event.side === NEAR && this.mode !== 'menu') this.audio.swing();
        break;
      case 'whiff':
        if (event.side === NEAR && playing) {
          const p = w.players[NEAR].pos;
          this.popupAt('挥空', p.x, 2.25, p.z, 'miss');
        }
        break;
      case 'toss':
        this.audio.toss();
        break;
      case 'jump':
        if (event.side === NEAR && playing) this.audio.jump();
        break;
      case 'bounce':
        this.audio.bounce(event.speed, event.x, event.z);
        break;
      case 'net':
        this.audio.net();
        break;
      case 'fault':
        this.audio.fault();
        if (playing) {
          const what = event.reason === 'net' ? '发球下网' : '发球出界';
          const next = event.serveNumber === 1 ? '还有一次机会' : '';
          this.hud.flash(what, event.side === NEAR ? 'lose' : 'info', next, 950);
        }
        break;
      case 'point':
        this.onPoint(event);
        break;
      case 'serve-ready':
        if (playing) {
          this.hud.setRally(0);
          this.refreshScore();
        }
        break;
      case 'match-end':
        if (this.mode !== 'menu') this.onMatchEnd(event.winner);
        break;
      default:
        break;
    }
  }

  private onPoint(event: Extract<GameEvent, { type: 'point' }>): void {
    const great = event.reason === 'winner' || event.reason === 'ace' || event.rally >= 8;
    this.audio.cheer(great ? 0.9 : 0.45);
    if (this.mode !== 'playing') return;
    this.refreshScore();
    const won = event.winner === NEAR;
    if (won) this.audio.pointWon();
    else this.audio.pointLost();
    const sub = event.rally >= 6 ? `${event.rally} 拍回合` : '';
    this.hud.flash(won ? WIN_TEXT[event.reason] : LOSE_TEXT[event.reason], won ? 'win' : 'lose', sub);
  }

  private onMatchEnd(winner: 0 | 1): void {
    if (winner === NEAR) this.audio.matchWon();
    else this.audio.matchLost();
    this.audio.cheer(1);
    if (this.mode === 'playing') this.finishMatch(winner);
  }

  /** Read-only view of the match for automated checks in development builds. */
  get debugState() {
    return {
      mode: this.mode,
      world: this.world,
      input: this.input,
    };
  }

  debugStart(difficulty: Difficulty): void {
    this.startMatch(difficulty);
  }

  /** Runs the game forward without waiting for display frames. */
  debugAdvance(seconds: number, until?: (world: World) => boolean): void {
    const step = 1 / 60;
    for (let t = 0; t < seconds; t += step) {
      this.advance(step, false);
      if (until?.(this.world)) break;
    }
    this.advance(step, true);
  }
}
