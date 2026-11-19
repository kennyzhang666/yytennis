import {
  Color,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  NeutralToneMapping,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { SceneFrame } from '../sim/frame';
import { clamp, clamp01 } from '../sim/math';
import { FAR, NEAR, otherSide, type Side, type Vec3 } from '../sim/types';
import type { GameEvent, World } from '../sim/world';
import { BallView } from './ballView';
import { CameraRig } from './cameraRig';
import { buildCourt } from './court';
import { Effects } from './fx';
import { GroundBlob, Markers } from './markers';
import { LOOK_FAR, LOOK_NEAR } from './playerModel';
import { PlayerRig } from './playerRig';
import type { ReplayDirector } from './replayDirector';
import { Stadium } from './stadium';
import { blobTexture, glowTexture } from './textures';

export type QualityTier = 'high' | 'low';

export function detectTier(): QualityTier {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse || navigator.maxTouchPoints > 1 ? 'low' : 'high';
}

const RESOLUTION_STEPS = [1, 0.85, 0.72, 0.6];

export class SceneView {
  readonly renderer: WebGLRenderer;
  readonly rig = new CameraRig();
  private readonly scene = new Scene();
  private readonly stadium: Stadium;
  private readonly rigs: [PlayerRig, PlayerRig];
  private readonly contactShadows: [GroundBlob, GroundBlob];
  private readonly ball: BallView;
  private readonly markers = new Markers();
  private readonly fx: Effects;
  private readonly projected = new Vector3();
  private readonly racket: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly maxPixelRatio: number;
  private resolutionStep: number;
  private frameTime = 1 / 60;
  private frameCount = 0;
  private fastFrames = 0;
  private width = 1;
  private height = 1;
  private clock = 0;
  private emberClock = 0;

  constructor(
    canvas: HTMLCanvasElement,
    readonly tier: QualityTier,
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: true,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.setClearColor(new Color(0xa9dcf5));
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.resolutionStep = tier === 'low' ? 1 : 0;

    const hemi = new HemisphereLight(0xf3f8ff, 0x7d9c8e, 2.05);
    const sun = new DirectionalLight(0xfff0d9, 2.15);
    sun.position.set(-14, 26, 12);
    this.scene.add(hemi, sun);

    const anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.stadium = new Stadium(tier === 'low' ? 1.02 : 0.72);
    this.scene.add(this.stadium.group);
    this.scene.add(buildCourt(tier === 'low' ? 46 : 76, Math.min(anisotropy, tier === 'low' ? 6 : 12)));

    const blob = blobTexture();
    const glow = glowTexture();
    this.contactShadows = [new GroundBlob(blob), new GroundBlob(blob)];
    this.scene.add(this.contactShadows[0].mesh, this.contactShadows[1].mesh);
    const ballShadow = new GroundBlob(blob);
    this.scene.add(ballShadow.mesh);

    this.scene.add(this.markers.group);
    this.fx = new Effects(blob, glow);
    this.scene.add(this.fx.group);

    const detailed = tier === 'high';
    this.rigs = [new PlayerRig(NEAR, LOOK_NEAR, detailed), new PlayerRig(FAR, LOOK_FAR, detailed)];
    this.scene.add(this.rigs[0].root, this.rigs[1].root);

    this.ball = new BallView(ballShadow, glow);
    this.scene.add(this.ball.group);
    this.resize();
  }

  get camera() {
    return this.rig.camera;
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    this.width = Math.max(1, parent?.clientWidth ?? window.innerWidth);
    this.height = Math.max(1, parent?.clientHeight ?? window.innerHeight);
    this.rig.fit(this.width, this.height);
    this.applyResolution();
  }

  private applyResolution(): void {
    const ratio = this.maxPixelRatio * RESOLUTION_STEPS[this.resolutionStep];
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.width, this.height, false);
    this.fx.setPointScale(this.height * ratio, MathUtils.degToRad(this.rig.camera.fov));
  }

  /** Lowers the render resolution when the device can't hold a steady frame rate. */
  noteFrameTime(dt: number): void {
    this.frameTime += (dt - this.frameTime) * 0.05;
    this.frameCount++;
    if (this.frameCount < 45) return;
    if (this.frameTime > 1 / 42 && this.resolutionStep < RESOLUTION_STEPS.length - 1) {
      this.resolutionStep++;
      this.frameCount = 0;
      this.fastFrames = 0;
      this.applyResolution();
      return;
    }
    if (this.frameTime < 1 / 56) this.fastFrames++;
    else this.fastFrames = 0;
    if (this.fastFrames > 600 && this.resolutionStep > 0) {
      this.resolutionStep--;
      this.frameCount = 0;
      this.fastFrames = 0;
      this.applyResolution();
    }
  }

  /** CSS-pixel position of a world point, used to anchor on-screen text. */
  toScreen(x: number, y: number, z: number): { x: number; y: number } {
    const p = this.projected.set(x, y, z).project(this.rig.camera);
    return { x: ((p.x + 1) / 2) * this.width, y: ((1 - p.y) / 2) * this.height };
  }

  /** Poses everything on court from a live or replayed frame. */
  updateScene(frame: SceneFrame, dt: number): void {
    this.clock += dt;
    for (const side of [NEAR, FAR] as const) {
      const p = frame.players[side];
      this.rigs[side].update(p, dt);
      const lift = 1 + p.pos.y * 0.6;
      this.contactShadows[side].place(p.pos.x, p.pos.z, 0.34 * lift, 0.34 * lift, 0.26 / (1 + p.pos.y * 2));
      this.rigs[side].racketHead(this.racket);
      this.fx.setCharge(side, p.pos.x, p.pos.z, p.chargeLevel, this.racket, dt);
    }

    this.ball.update(frame.ball, this.rig.camera, dt);
    if (frame.ball.charge > 0.2 && !frame.ball.held) {
      this.emberClock += dt * (20 + frame.ball.charge * 60);
      while (this.emberClock >= 1) {
        this.emberClock -= 1;
        this.fx.ember(frame.ball.pos, frame.ball.charge);
      }
    }
    this.fx.update(dt);
    this.stadium.update(dt);
  }

  updateLiveCamera(world: World, frame: SceneFrame, human: Side, dt: number): void {
    const me = frame.players[human];
    this.markers.update(world, human, me.pos.x, me.pos.z, dt);
    this.rig.update(me.pos.x, me.pos.z, dt, 0);
  }

  updateAttractCamera(dt: number): void {
    this.markers.hideAll();
    this.rig.update(0, 12.6, dt, Math.sin(this.clock * 0.16) * 2.2);
  }

  updateReplayCamera(director: ReplayDirector, time: number, frame: SceneFrame, dt: number): void {
    this.markers.hideAll();
    director.apply(time, frame, this.rig, dt);
  }

  setReplayMode(on: boolean): void {
    this.stadium.setReplayMode(on);
    this.fx.clearScuffs();
  }

  onEvent(event: GameEvent, human: Side | null): void {
    switch (event.type) {
      case 'hit': {
        const power = clamp01((event.speed - 12) / 24);
        const perfect = event.timing === 'perfect';
        const smash = event.shot === 'smash';
        const color = smash ? 0xff8a3d : perfect ? 0xfff27a : 0xffffff;
        this.fx.burst(event.x, event.y, event.z, {
          count: Math.round(6 + power * 12 + (perfect ? 6 : 0)),
          speed: 2 + power * 5,
          up: 2 + power * 4,
          size: 0.1 + power * 0.08,
          life: 0.32,
          color,
        });
        this.ball.setTrailColor(smash ? 0xffa45c : perfect ? 0xfff58a : 0xe9ff7a);
        this.rigs[otherSide(event.side)].splitStep();
        if (event.charge > 0.2) {
          const distance = this.rig.camera.position.distanceTo(this.projected.set(event.x, event.y, event.z));
          this.fx.powerHit(event.x, event.y, event.z, event.charge, clamp(distance / 24, 0.28, 1.1));
          this.rig.shake(0.5 + event.charge * 0.5);
          this.rig.punch(event.charge);
        } else if (smash) this.rig.shake(0.72);
        else if (event.shot === 'serve' && perfect) this.rig.shake(0.34);
        else if (perfect && event.side === human) this.rig.shake(0.2);
        break;
      }
      case 'bounce': {
        const out = event.live && !event.isIn;
        this.fx.burst(event.x, 0.04, event.z, {
          count: clamp(Math.round(event.speed * 0.45), 3, 10),
          speed: 1.1,
          up: 1.1,
          size: 0.1,
          life: 0.34,
          color: out ? 0xff7a6e : 0xb9dcff,
          gravity: 3,
        });
        this.fx.pulse(event.x, event.z, out ? 0xff5a4f : 0xffffff, out ? 1.25 : 0.62, out ? 0.6 : 0.34);
        if (event.live) this.fx.scuff(event.x, event.z, event.vx, event.vz, out ? 0xff4f42 : 0xe4f1ff);
        if (event.charge > 0.2) {
          this.fx.powerBounce(event.x, event.z, event.vx, event.vz, event.charge);
          this.rig.shake(0.2 + event.charge * 0.25);
        }
        break;
      }
      case 'net':
        this.fx.burst(event.x, event.y, 0, { count: 8, speed: 1.2, up: 1.2, size: 0.07, life: 0.3, color: 0xffffff });
        this.rig.shake(0.12);
        break;
      case 'land':
      case 'jump':
        this.fx.burst(event.x, 0.05, event.z, { count: 5, speed: 0.9, up: 0.7, size: 0.12, life: 0.3, color: 0xcfe6ff, gravity: 2 });
        break;
      case 'charge-full':
        this.rigs[event.side].racketHead(this.racket);
        this.fx.chargeReady(event.side, this.rigs[event.side].root.position.x, this.rigs[event.side].root.position.z, this.racket);
        break;
      case 'point':
        this.stadium.roar(event.reason === 'winner' || event.reason === 'ace' ? 1 : 0.6);
        break;
      case 'match-end':
        this.stadium.roar(1);
        break;
      default:
        break;
    }
  }

  /** Clears marks left on court and restarts the ball's trail. */
  resetCourt(frame: SceneFrame): void {
    const { x, y, z } = frame.ball.pos;
    this.fx.clearScuffs();
    this.ball.resetTrail(x, y, z);
  }

  resetTrail(frame: SceneFrame): void {
    const { x, y, z } = frame.ball.pos;
    this.ball.resetTrail(x, y, z);
  }

  /** Small dust puffs from a sprinting player. */
  footDust(frame: SceneFrame): void {
    for (const p of frame.players) {
      const speed = Math.hypot(p.vel.x, p.vel.z);
      if (p.onGround && speed > 4.6 && Math.random() < 0.09) {
        this.fx.burst(p.pos.x, 0.05, p.pos.z, { count: 1, speed: 0.3, up: 0.35, size: 0.1, life: 0.26, color: 0xa9cbea, gravity: 1 });
      }
    }
  }

  render(): void {
    this.renderer.render(this.scene, this.rig.camera);
  }
}
