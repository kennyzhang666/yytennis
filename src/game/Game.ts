import { AudioEngine } from '../audio/AudioEngine';
import { InputManager, type InputMode } from '../input/InputManager';
import { AI_PROFILES, AIController, tuningFor, type Difficulty } from '../sim/ai';
import { PLAYER, SWING, TICK } from '../sim/constants';
import { createSceneFrame, readWorldFrame } from '../sim/frame';
import { clamp01 } from '../sim/math';
import { ReplayRecorder, replayRate, type ReplayClip } from '../sim/replay';
import { FAR, NEAR, type PlayerIntent } from '../sim/types';
import { World, type GameEvent, type PointReason } from '../sim/world';
import { Hud, type PopupTone } from '../ui/Hud';
import { DIFFICULTY_NAMES, Menus, type MatchSummary } from '../ui/Menus';
import { ReplayDirector } from '../view/replayDirector';
import { detectTier, SceneView } from '../view/SceneView';

type Mode = 'menu' | 'playing' | 'paused' | 'finished' | 'replay';
type AfterReplay = 'play' | 'pause' | 'result';

interface ReplaySession {
  clip: ReplayClip;
  director: ReplayDirector;
  time: number;
  nextEvent: number;
  keys: number[];
  after: AfterReplay;
}

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

/** How long play continues behind the result before the replay cuts in. */
const REPLAY_DELAY = 0.92;
const AUTO_REPLAY_SCORE = 5.2;

/** The sim's ball is slower than a real one, so shown speeds are scaled to feel right. */
const speedKmh = (metersPerSecond: number) => Math.round(metersPerSecond * 3.6 * 1.7);

function loadFlag(key: string, fallback = false): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === '1';
  } catch {
    return fallback;
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
  private readonly frameState = createSceneFrame();
  private readonly recorder = new ReplayRecorder();

  private world: World;
  private ais: [AIController, AIController];
  private mode: Mode = 'menu';
  private difficulty: Difficulty = 'normal';
  private seed = (Date.now() & 0xffff) + 1;
  private accumulator = 0;
  private lastFrame = 0;
  private hitStop = 0;
  private tutorialDone = loadFlag('yy.tutorial');
  private autoReplay = loadFlag('yy.autoReplay', true);

  private pointPending = false;
  private lastClip: ReplayClip | null = null;
  private bestClip: ReplayClip | null = null;
  private pointsSinceReplay = 99;
  private replay: ReplaySession | null = null;
  private summary: MatchSummary | null = null;

  private readonly stepClock: [number, number] = [0, 0];
  private readonly lastVel = [
    { x: 0, z: 0 },
    { x: 0, z: 0 },
  ];
  private squeakCooldown = 0;

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
    if (this.reducedMotion) this.view.rig.motion = 0;
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
      onToggleAutoReplay: () => {
        this.autoReplay = !this.autoReplay;
        saveFlag('yy.autoReplay', this.autoReplay);
        return this.autoReplay;
      },
      onReplayLast: () => {
        if (this.lastClip) this.startReplay(this.lastClip, 'pause');
      },
      onHighlight: () => {
        if (this.bestClip) this.startReplay(this.bestClip, 'result');
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
    this.hud.onReplay = () => this.replayCurrentPoint();
    this.hud.onSkipReplay = () => this.finishReplay();
    this.input.onPauseKey = () => {
      if (this.mode === 'replay') this.finishReplay();
      else if (this.mode === 'playing') this.pause();
      else if (this.mode === 'paused') this.resume();
    };
    this.input.onModeChange = (mode) => this.onInputMode(mode);

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (this.mode === 'replay' && (e.code === 'Space' || e.code === 'Enter')) {
        e.preventDefault();
        this.finishReplay();
      } else if (this.mode === 'playing' && e.code === 'KeyR' && this.world.phase === 'dead') {
        this.replayCurrentPoint();
      }
    });
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
    readWorldFrame(this.world, 1, this.frameState);
    this.view.resetCourt(this.frameState);
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
    this.closeReplay();
    this.difficulty = difficulty;
    this.seed = (this.seed + 7919) & 0xfffff;
    this.world = new World({ seed: this.seed, firstServer: NEAR });
    this.ais = [
      new AIController(NEAR, AI_PROFILES.hard, this.seed + 3),
      new AIController(FAR, AI_PROFILES[difficulty], this.seed + 5),
    ];
    this.world.tunePlayer(FAR, tuningFor(AI_PROFILES[difficulty]));
    this.applyHumanTuning();
    readWorldFrame(this.world, 1, this.frameState);
    this.view.resetCourt(this.frameState);
    this.recorder.beginPoint();
    this.pointPending = false;
    this.lastClip = null;
    this.bestClip = null;
    this.summary = null;
    this.pointsSinceReplay = 99;
    this.accumulator = 0;
    this.hitStop = 0;
    this.mode = 'playing';
    this.menus.hide();
    this.hud.clearTransient();
    this.hud.setOpponent(DIFFICULTY_NAMES[difficulty]);
    this.hud.setVisible(true);
    this.audio.setCrowdMood('hushed');
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
    this.audio.setCharge(0);
    this.hud.setChargeLevel(0);
    this.menus.showPause(this.audio.muted, this.autoReplay, this.lastClip !== null);
  }

  private resume(): void {
    if (this.mode !== 'paused') return;
    this.mode = 'playing';
    this.menus.hide();
    this.lastFrame = 0;
    this.input.setEnabled(true);
  }

  private goHome(): void {
    this.closeReplay();
    this.mode = 'menu';
    this.input.setEnabled(false);
    this.audio.setCharge(0);
    this.audio.setCrowdMood('idle');
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
    this.hud.setChargeLevel(0);
    this.hud.setReplayButton(false);
    this.audio.setCharge(0);
    this.audio.setCrowdMood('idle');
    this.tutorialDone = true;
    saveFlag('yy.tutorial', true);
    const w = this.world;
    const [me, foe] = w.stats;
    const percent = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : '–');
    this.summary = {
      won: winner === NEAR,
      points: w.points,
      difficulty: this.difficulty,
      hasHighlight: this.bestClip !== null,
      rows: [
        { label: '完美击球', me: percent(me.perfects, me.hits), foe: percent(foe.perfects, foe.hits) },
        { label: '蓄力球', me: String(me.chargedHits), foe: String(foe.chargedHits) },
        { label: '制胜分', me: String(me.winners), foe: String(foe.winners) },
        { label: 'ACE', me: String(me.aces), foe: String(foe.aces) },
        { label: '失误', me: String(me.errors + me.doubleFaults), foe: String(foe.errors + foe.doubleFaults) },
        {
          label: '最快球速',
          me: me.topSpeed ? `${speedKmh(me.topSpeed)}` : '–',
          foe: foe.topSpeed ? `${speedKmh(foe.topSpeed)}` : '–',
        },
      ],
    };
    window.setTimeout(() => {
      if (this.mode !== 'finished' || !this.summary) return;
      this.hud.setVisible(false);
      this.menus.showResult(this.summary);
    }, 900);
  }

  // ---------------------------------------------------------------------------
  // Replays
  // ---------------------------------------------------------------------------

  private storeClip(clip: ReplayClip): void {
    this.lastClip = clip;
    if (!this.bestClip || clip.excitement >= this.bestClip.excitement) this.bestClip = clip;
  }

  private buildPendingClip(): ReplayClip | null {
    if (!this.pointPending) return this.lastClip;
    this.pointPending = false;
    const clip = this.recorder.buildClip();
    if (clip) this.storeClip(clip);
    return clip;
  }

  private replayCurrentPoint(): void {
    if (this.mode !== 'playing') return;
    const clip = this.buildPendingClip();
    if (clip) this.startReplay(clip, 'play');
  }

  private startReplay(clip: ReplayClip, after: AfterReplay): void {
    this.closeReplay();
    const director = new ReplayDirector(clip);
    this.replay = { clip, director, time: clip.start, nextEvent: 0, keys: clip.keyTimes(), after };
    while (
      this.replay.nextEvent < clip.events.length &&
      clip.events[this.replay.nextEvent].t < clip.start
    ) {
      this.replay.nextEvent++;
    }
    this.mode = 'replay';
    this.pointsSinceReplay = 0;
    this.input.setEnabled(false);
    this.menus.hide();
    this.hud.setVisible(false);
    this.hud.setChargeLevel(0);
    this.hud.setReplayButton(false);
    this.hud.showReplay(director.lineCall);
    this.audio.setCharge(0);
    this.audio.setSlowMotion(true);
    this.audio.setCrowdMood('silent');
    this.view.setReplayMode(true);

    // Let the bodies settle into the first pose before the picture appears.
    clip.sample(clip.start, this.frameState);
    this.view.resetTrail(this.frameState);
    for (let i = 0; i < 12; i++) this.view.updateScene(this.frameState, 1 / 60);
  }

  private closeReplay(): void {
    if (!this.replay) return;
    this.replay = null;
    this.hud.hideReplay();
    this.audio.setSlowMotion(false);
    this.view.setReplayMode(false);
  }

  private finishReplay(): void {
    const session = this.replay;
    if (!session) return;
    this.closeReplay();
    readWorldFrame(this.world, 1, this.frameState);
    this.view.resetTrail(this.frameState);
    this.lastFrame = 0;
    switch (session.after) {
      case 'play':
        this.world.skipPointDelay();
        this.mode = 'playing';
        this.hud.setVisible(true);
        this.audio.setCrowdMood('idle');
        this.input.setEnabled(true);
        break;
      case 'pause':
        this.mode = 'paused';
        this.hud.setVisible(true);
        this.menus.showPause(this.audio.muted, this.autoReplay, this.lastClip !== null);
        break;
      case 'result':
        this.mode = 'finished';
        this.audio.setCrowdMood('idle');
        if (this.summary) this.menus.showResult(this.summary);
        break;
    }
  }

  private advanceReplay(dt: number, draw: boolean): void {
    const session = this.replay;
    if (!session) return;
    const { clip } = session;
    const lastKey = session.keys[session.keys.length - 1] ?? clip.end;
    const rate = this.reducedMotion ? 0.6 : replayRate(session.time, session.keys, lastKey);
    const step = dt * rate;
    session.time += step;

    while (session.nextEvent < clip.events.length && clip.events[session.nextEvent].t <= session.time) {
      this.playReplayEvent(clip.events[session.nextEvent].event, rate);
      session.nextEvent++;
    }

    clip.sample(Math.min(session.time, clip.end), this.frameState);
    this.view.updateScene(this.frameState, step);
    this.view.updateReplayCamera(session.director, session.time, this.frameState, dt);
    this.hud.setReplayProgress(clamp01((session.time - clip.start) / clip.duration));
    if (draw) this.view.render();
    if (session.time >= clip.end) this.finishReplay();
  }

  private playReplayEvent(event: GameEvent, rate: number): void {
    this.view.onEvent(event, null);
    const pitch = 0.55 + rate * 0.5;
    switch (event.type) {
      case 'hit':
        this.audio.hit({
          shot: event.shot,
          quality: event.quality,
          speed: event.speed,
          x: event.x,
          z: 8,
          charge: event.charge,
          rate: pitch,
        });
        break;
      case 'bounce':
        this.audio.bounce(event.speed, event.x, 8, pitch);
        break;
      case 'net':
        this.audio.net(pitch);
        break;
      case 'swing':
        this.audio.swing(0.8, 0, 8, pitch);
        break;
      default:
        break;
    }
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
    if (this.mode === 'replay') {
      this.advanceReplay(dt, draw);
      return;
    }
    const running = this.mode !== 'paused';
    let simDt = 0;
    if (running) {
      let scale = 1;
      if (this.hitStop > 0) {
        this.hitStop -= dt;
        scale = 0.07;
      }
      simDt = dt * scale;
      this.accumulator += simDt;
      while (this.accumulator >= TICK) {
        this.accumulator -= TICK;
        this.tick();
        // A replay can begin in the middle of a batch of ticks.
        if ((this.mode as Mode) === 'replay') return;
      }
    }

    readWorldFrame(this.world, this.accumulator / TICK, this.frameState);
    if (running) this.view.footDust(this.frameState);
    this.view.updateScene(this.frameState, running ? simDt : 0);
    if (this.mode === 'menu') this.view.updateAttractCamera(dt);
    else this.view.updateLiveCamera(this.world, this.frameState, NEAR, dt);

    if (this.mode === 'playing') {
      this.updateHint();
      this.updateCharging();
      this.updateFootsteps(simDt);
      this.maybeStartReplay();
    }
    if (draw) this.view.render();
  }

  private updateCharging(): void {
    const level = this.frameState.players[NEAR].chargeLevel;
    this.audio.setCharge(level);
    this.hud.setChargeLevel(level);
  }

  private updateFootsteps(dt: number): void {
    this.squeakCooldown -= dt;
    if (dt <= 0) return;
    for (const side of [NEAR, FAR] as const) {
      const p = this.frameState.players[side];
      const speed = Math.hypot(p.vel.x, p.vel.z);
      const level = side === NEAR ? 1 : 0.55;
      if (p.onGround && speed > 1.5) {
        this.stepClock[side] += (speed * dt) / 1.45;
        if (this.stepClock[side] >= 1) {
          this.stepClock[side] -= 1;
          this.audio.step(p.pos.x, p.pos.z, level);
        }
      }
      const last = this.lastVel[side];
      const accel = Math.hypot(p.vel.x - last.x, p.vel.z - last.z) / dt;
      last.x = p.vel.x;
      last.z = p.vel.z;
      if (p.onGround && accel > 30 && speed > 2 && this.squeakCooldown <= 0 && Math.random() < 0.3) {
        this.squeakCooldown = 0.5;
        this.audio.squeak(p.pos.x, p.pos.z, level * clamp01(speed / 5));
      }
    }
  }

  private maybeStartReplay(): void {
    const w = this.world;
    if (!this.pointPending || w.phase !== 'dead' || w.phaseTime < REPLAY_DELAY) return;
    const clip = this.buildPendingClip();
    this.hud.setReplayButton(clip !== null);
    if (!clip) return;
    this.pointsSinceReplay++;
    const special = clip.point.matchPoint;
    const worthy = clip.excitement >= AUTO_REPLAY_SCORE && this.pointsSinceReplay >= 2;
    if (this.autoReplay && (special || worthy)) this.startReplay(clip, 'play');
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
    const recording = this.mode === 'playing';
    if (recording) this.recorder.capture(w);
    for (const event of w.drainEvents()) {
      if (recording) this.recorder.note(event);
      this.handleEvent(event);
    }
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
    const me = w.players[NEAR];
    const serving = w.server === NEAR;
    let hint: string | null = null;
    if (w.phase === 'ready' && serving) {
      if (touch) hint = this.tutorialDone ? '点右半屏抛球' : '点右半屏抛球，按住可蓄力';
      else hint = this.tutorialDone ? '点击抛球' : '移动鼠标选落点，点击抛球，按住可蓄力';
    } else if (w.phase === 'toss' && serving) {
      if (me.chargeTime >= 0) hint = touch ? '光环收拢时松手发球' : '光环收拢时松开发球';
      else hint = touch ? '光环收拢时点右半屏发球' : '光环收拢时点击发球';
    } else if (me.chargeLevel > 0) {
      hint = me.chargeLevel >= 1 ? '蓄力已满，收拢时松开' : '蓄力中，收拢时松开';
    } else if (!this.tutorialDone) {
      if (w.phase === 'ready') hint = '准备接发球';
      else if (w.isIncoming(NEAR)) {
        hint = touch ? '跑到黄圈附近，光环收拢时点右半屏' : 'WASD 跑到黄圈附近，光环收拢时点击';
        const coming = w.crossing(NEAR);
        if (coming && coming.t > 0.62 && w.rally >= 3) {
          hint = touch ? '来得及时，提前按住右侧可蓄力' : '来得及时，提前按住左键可蓄力';
        }
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

  private popupAt(text: string, x: number, y: number, z: number, tone: PopupTone): void {
    const p = this.view.toScreen(x, y, z);
    this.hud.popup(text, p.x, p.y, tone);
  }

  private handleEvent(event: GameEvent): void {
    const w = this.world;
    const playing = this.mode === 'playing';
    const human = this.mode === 'menu' ? null : NEAR;
    this.view.onEvent(event, human);

    switch (event.type) {
      case 'hit': {
        const perfect = event.timing === 'perfect';
        this.audio.hit({
          shot: event.shot,
          quality: event.quality,
          speed: event.speed,
          x: event.x,
          z: event.z,
          charge: event.charge,
        });
        if (playing) this.audio.setCrowdMood('silent');
        if (!this.reducedMotion) {
          if (event.charge > 0.2) this.hitStop = 0.08 + event.charge * 0.06;
          else if (event.shot === 'smash') this.hitStop = 0.09;
          else if (perfect && event.side === NEAR && playing) this.hitStop = 0.05;
        }
        if (!playing) break;
        this.hud.setRally(event.rally);
        if (event.side === NEAR) {
          const tone = perfect ? 'perfect' : event.timing === 'good' ? 'good' : 'miss';
          this.popupAt(TIMING_TEXT[event.timing], event.x, event.y + 0.45, event.z, tone);
        }
        if (event.charge > 0.2) {
          const label = event.charge >= 1 ? '满蓄力！' : '蓄力球！';
          this.popupAt(label, event.x, event.y + 1.05, event.z, 'power');
        } else if (event.shot === 'serve' || event.shot === 'smash') {
          this.popupAt(`${speedKmh(event.speed)} km/h`, event.x, event.y + 0.95, event.z, 'speed');
        }
        break;
      }
      case 'swing': {
        const p = w.players[event.side];
        if (this.mode !== 'menu') this.audio.swing(event.side === NEAR ? 1 : 0.6, p.pos.x, p.pos.z);
        break;
      }
      case 'whiff':
        if (event.side === NEAR && playing) {
          const p = w.players[NEAR].pos;
          this.popupAt('挥空', p.x, 2.25, p.z, 'miss');
        }
        break;
      case 'toss':
        this.audio.toss();
        if (playing) this.audio.setCrowdMood('silent');
        break;
      case 'jump':
        if (playing) this.audio.step(event.x, event.z, 1.2);
        break;
      case 'land':
        if (playing) this.audio.step(event.x, event.z, 1.6);
        break;
      case 'charge-full':
        if (event.side === NEAR && playing) this.audio.chargeReady();
        break;
      case 'bounce':
        this.audio.bounce(event.speed, event.x, event.z);
        if (playing && event.live && event.isIn && event.margin < 0.22) this.audio.ooh(0.5);
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
          this.hud.setReplayButton(false);
          this.pointPending = false;
          this.audio.setCrowdMood('hushed');
          this.refreshScore();
        }
        readWorldFrame(w, 1, this.frameState);
        this.view.resetCourt(this.frameState);
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
    const humanWon = event.winner === NEAR;
    if (this.mode === 'menu') {
      this.audio.applause(great ? 0.42 : 0.26);
      return;
    }
    this.audio.setCrowdMood('idle');
    this.audio.applause(great ? (humanWon ? 0.95 : 0.7) : humanWon ? 0.5 : 0.34);
    if (great && humanWon) this.audio.cheer(event.matchPoint ? 1 : 0.75);
    else if (!great && !humanWon && event.rally >= 4) this.audio.groan(0.5);
    if (this.mode !== 'playing') return;

    this.pointPending = true;
    this.hud.setReplayButton(true);
    this.refreshScore();
    const sub = event.rally >= 6 ? `${event.rally} 拍回合` : '';
    this.hud.flash(humanWon ? WIN_TEXT[event.reason] : LOSE_TEXT[event.reason], humanWon ? 'win' : 'lose', sub);
  }

  private onMatchEnd(winner: 0 | 1): void {
    this.audio.cheer(winner === NEAR ? 1 : 0.5);
    this.audio.applause(1);
    if (this.mode === 'playing') this.finishMatch(winner);
  }

  /** Read-only view of the match for automated checks in development builds. */
  get debugState() {
    return {
      mode: this.mode,
      world: this.world,
      input: this.input,
      frame: this.frameState,
      lastClip: this.lastClip,
      bestClip: this.bestClip,
      replay: this.replay,
      audio: this.audio,
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
