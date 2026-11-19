import {
  CircleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  type Texture,
} from 'three';
import { COURT, SWING } from '../sim/constants';
import { clamp01 } from '../sim/math';
import type { Side } from '../sim/types';
import { IDEAL_TOSS_TIME, type World } from '../sim/world';
import { merge } from './geometry';

const LIFT = 0.012;

export function groundMaterial(color: number, opacity: number, map?: Texture): MeshBasicMaterial {
  return new MeshBasicMaterial({
    color,
    opacity,
    transparent: true,
    depthWrite: false,
    alphaMap: map ?? null,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/** A soft dark patch on the ground: the cheap replacement for real-time shadows. */
export class GroundBlob {
  readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;

  constructor(texture: Texture, color = 0x06121f) {
    this.material = groundMaterial(color, 0.4, texture);
    this.mesh = new Mesh(new PlaneGeometry(2, 2).rotateX(-Math.PI / 2), this.material);
    this.mesh.position.y = LIFT;
    this.mesh.renderOrder = 1;
  }

  place(x: number, z: number, sx: number, sz: number, opacity: number): void {
    this.mesh.position.x = x;
    this.mesh.position.z = z;
    this.mesh.scale.set(sx, 1, sz);
    this.material.opacity = opacity;
  }
}

function ring(inner: number, outer: number, segments = 56) {
  return new RingGeometry(inner, outer, segments).rotateX(-Math.PI / 2);
}

export class Markers {
  readonly group = new Group();
  private readonly landing = new Group();
  private readonly landingMat = groundMaterial(0xffe45c, 0.95);
  private readonly reticle = new Group();
  private readonly reticleMat = groundMaterial(0xffffff, 0.92);
  private readonly serveBox: Mesh;
  private readonly serveBoxMat = groundMaterial(0xd9f84a, 0.2);
  private readonly timing = new Group();
  private readonly timingInner: Mesh;
  private readonly timingOuter: Mesh;
  private readonly timingInnerMat = groundMaterial(0xffffff, 0.4);
  private readonly timingOuterMat = groundMaterial(0xd9f84a, 0.95);
  private readonly playerDisc: Mesh;
  private time = 0;

  constructor() {
    const landingShape = merge([ring(0.27, 0.36), new CircleGeometry(0.09, 20).rotateX(-Math.PI / 2)]);
    this.landing.add(new Mesh(landingShape, this.landingMat));
    this.landing.position.y = LIFT * 1.5;

    const ticks = [];
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      ticks.push(
        new PlaneGeometry(0.075, 0.26)
          .rotateX(-Math.PI / 2)
          .translate(0, 0, -0.5)
          .rotateY(a),
      );
    }
    this.reticle.add(new Mesh(merge([ring(0.3, 0.37), ...ticks]), this.reticleMat));
    this.reticle.position.y = LIFT * 1.5;

    this.serveBox = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.serveBoxMat);
    this.serveBox.position.y = LIFT;

    this.timingInner = new Mesh(ring(0.94, 1), this.timingInnerMat);
    this.timingOuter = new Mesh(ring(0.965, 1.035), this.timingOuterMat);
    this.timing.add(this.timingInner, this.timingOuter);
    this.timing.position.y = LIFT * 2;

    this.playerDisc = new Mesh(ring(0.42, 0.47), groundMaterial(0xffffff, 0.75));
    this.playerDisc.position.y = LIFT;

    for (const m of [this.landing, this.reticle, this.serveBox, this.timing, this.playerDisc]) {
      m.renderOrder = 2;
      m.visible = false;
      m.traverse((child) => {
        child.renderOrder = 2;
      });
      this.group.add(m);
    }
  }

  hideAll(): void {
    this.landing.visible = false;
    this.reticle.visible = false;
    this.serveBox.visible = false;
    this.timing.visible = false;
    this.playerDisc.visible = false;
  }

  update(world: World, human: Side, x: number, z: number, dt: number): void {
    this.time += dt;
    this.playerDisc.visible = true;
    this.playerDisc.position.x = x;
    this.playerDisc.position.z = z;

    this.updateLanding(world);
    this.updateAim(world, human);
    this.updateTiming(world, human, x, z);
  }

  private updateLanding(world: World): void {
    const landing = world.predictedLanding();
    this.landing.visible = landing !== null;
    if (!landing) return;
    this.landing.position.x = landing.x;
    this.landing.position.z = landing.z;
    const closing = clamp01(landing.t / 0.9);
    this.landing.scale.setScalar(1 + closing * 0.9);
    this.landingMat.color.setHex(landing.isIn ? 0xffe45c : 0xff5a4f);
    this.landingMat.opacity = 0.95 - closing * 0.3;
  }

  private updateAim(world: World, human: Side): void {
    const serving = world.isServing(human);
    const live = world.phase === 'rally' || world.phase === 'serve';
    this.reticle.visible = serving || live;
    if (this.reticle.visible) {
      const aim = world.aim[human];
      this.reticle.position.x = aim.x;
      this.reticle.position.z = aim.z;
      this.reticle.rotation.y = this.time * 0.8;
      this.reticleMat.opacity = serving || world.isIncoming(human) ? 0.95 : 0.34;
      this.reticle.scale.setScalar(1.12 + Math.sin(this.time * 5) * 0.05);
    }

    this.serveBox.visible = serving;
    if (serving) {
      const box = world.serviceBox;
      this.serveBox.position.x = (box.minX + box.maxX) / 2;
      this.serveBox.position.z = (box.zSign * COURT.serviceLine) / 2;
      this.serveBox.scale.set(box.maxX - box.minX, 1, COURT.serviceLine);
      this.serveBoxMat.opacity = 0.17 + Math.sin(this.time * 3) * 0.04;
    }
  }

  private updateTiming(world: World, human: Side, x: number, z: number): void {
    let remaining: number | null = null;
    let good = true;
    if (world.phase === 'toss' && world.server === human) {
      remaining = IDEAL_TOSS_TIME - world.tossTime;
    } else {
      const crossing = world.crossing(human);
      if (crossing) {
        remaining = crossing.t - SWING.lead;
        good = crossing.reachable;
      }
    }

    if (remaining === null || remaining < -0.12 || remaining > 0.85) {
      this.timing.visible = false;
      return;
    }
    this.timing.visible = true;
    this.timing.position.x = x;
    this.timing.position.z = z;
    const k = clamp01(remaining / 0.7);
    this.timingOuter.scale.set(1 + k * 1.5, 1, 1 + k * 1.5);
    const onBeat = Math.abs(remaining) < 0.05;
    const charging = world.players[human].chargeLevel > 0;
    this.timingOuterMat.color.setHex(!good ? 0xff9f43 : onBeat ? 0xffffff : charging ? 0xffc53d : 0xd9f84a);
    this.timingOuterMat.opacity = 0.4 + (1 - k) * 0.6;
    this.timingInnerMat.opacity = onBeat ? 0.95 : 0.42;
    this.timingInnerMat.color.setHex(good ? 0xffffff : 0xffc78a);
  }
}
