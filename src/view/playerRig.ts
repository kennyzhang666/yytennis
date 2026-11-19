import {
  BoxGeometry,
  CapsuleGeometry,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  RepeatWrapping,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { clamp, clamp01, lerp, smoothstep } from '../sim/math';
import type { Player, Swing } from '../sim/player';
import type { Vec3 } from '../sim/types';
import { merge } from './geometry';
import { stringsTexture } from './textures';

export interface RigColors {
  shirt: number;
  trim: number;
  shorts: number;
  skin: number;
  hat: number;
  shoe: number;
  racket: number;
}

const DOWN = new Vector3(0, -1, 0);
const THIGH = 0.44;
const SHIN = 0.44;
const FOOT = 0.05;
const SHOULDER_Y = 0.46;
const SHOULDER_X = 0.245;

const piecewise = (ph: number, a: number, b: number, c: number) =>
  ph < 0.36 ? lerp(0, a, ph / 0.36) : ph < 0.52 ? lerp(a, b, (ph - 0.36) / 0.16) : lerp(b, c, (ph - 0.52) / 0.48);

function polar(yaw: number, elevation: number, out: Vector3): Vector3 {
  const c = Math.cos(elevation);
  return out.set(c * Math.cos(yaw), Math.sin(elevation), -c * Math.sin(yaw));
}

function wrapAngle(a: number): number {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}

function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

interface Limb {
  pivot: Group;
  joint: Group;
}

export class PlayerRig {
  readonly root = new Group();
  private readonly body = new Group();
  private readonly upper = new Group();
  private readonly head = new Group();
  private readonly armR: Limb;
  private readonly armL: Limb;
  private readonly legR: Limb;
  private readonly legL: Limb;
  private readonly dirR = new Vector3(0.3, -0.7, -0.65).normalize();
  private readonly dirL = new Vector3(-0.1, -0.6, -0.8).normalize();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly baseYaw: number;
  private yaw: number;
  private stride = Math.random() * 6;
  private bendR = 1.2;
  private bendL = 1.5;
  private leanX = 0;
  private leanZ = 0;
  private time = Math.random() * 10;

  constructor(side: 0 | 1, colors: RigColors) {
    this.baseYaw = side === 0 ? 0 : Math.PI;
    this.yaw = this.baseYaw;
    const shirt = new MeshLambertMaterial({ color: colors.shirt });
    const trim = new MeshLambertMaterial({ color: colors.trim });
    const shorts = new MeshLambertMaterial({ color: colors.shorts });
    const skin = new MeshLambertMaterial({ color: colors.skin });
    const hat = new MeshLambertMaterial({ color: colors.hat });
    const shoe = new MeshLambertMaterial({ color: colors.shoe });

    this.root.add(this.body);
    this.body.add(this.upper);
    this.upper.position.y = 0.04;

    const pelvis = new Mesh(new CapsuleGeometry(0.15, 0.1, 3, 10).scale(1.08, 1, 0.8), shorts);
    this.body.add(pelvis);

    const torso = new Mesh(new CapsuleGeometry(0.165, 0.3, 4, 12).scale(1.1, 1, 0.72).translate(0, 0.25, 0), shirt);
    this.upper.add(torso);
    const collar = new Mesh(new CylinderGeometry(0.075, 0.1, 0.05, 10).translate(0, 0.51, 0), trim);
    this.upper.add(collar);

    this.head.position.y = 0.67;
    this.head.add(new Mesh(new SphereGeometry(0.122, 14, 10), skin));
    const cap = merge([
      new SphereGeometry(0.128, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.52).translate(0, 0.012, 0),
      new CylinderGeometry(0.1, 0.1, 0.014, 12).scale(1, 1, 0.8).translate(0, 0.022, -0.125),
    ]);
    this.head.add(new Mesh(cap, hat));
    this.upper.add(this.head);

    const neck = new Mesh(new CylinderGeometry(0.05, 0.055, 0.1, 8).translate(0, 0.565, 0), skin);
    this.upper.add(neck);

    this.armR = this.buildArm(1, shirt, skin);
    this.armL = this.buildArm(-1, shirt, skin);
    this.armR.joint.add(this.buildRacket(colors));

    this.legR = this.buildLeg(1, shorts, skin, shoe);
    this.legL = this.buildLeg(-1, shorts, skin, shoe);
  }

  private buildArm(sign: number, sleeve: MeshLambertMaterial, skin: MeshLambertMaterial): Limb {
    const pivot = new Group();
    pivot.position.set(sign * SHOULDER_X, SHOULDER_Y, 0);
    pivot.add(new Mesh(new CapsuleGeometry(0.058, 0.13, 3, 8).translate(0, -0.09, 0), sleeve));
    pivot.add(new Mesh(new CapsuleGeometry(0.046, 0.14, 3, 8).translate(0, -0.2, 0), skin));
    const joint = new Group();
    joint.position.y = -0.3;
    joint.add(new Mesh(new CapsuleGeometry(0.04, 0.2, 3, 8).translate(0, -0.13, 0), skin));
    joint.add(new Mesh(new SphereGeometry(0.052, 8, 6).translate(0, -0.27, 0), skin));
    pivot.add(joint);
    this.upper.add(pivot);
    return { pivot, joint };
  }

  private buildRacket(colors: RigColors): Group {
    const racket = new Group();
    racket.position.y = -0.27;
    const frameMat = new MeshLambertMaterial({ color: colors.racket });
    const frame = merge([
      new CylinderGeometry(0.017, 0.02, 0.2, 8).translate(0, -0.08, 0),
      new CylinderGeometry(0.011, 0.016, 0.16, 6)
        .rotateZ(0.32)
        .translate(0.024, -0.235, 0),
      new CylinderGeometry(0.011, 0.016, 0.16, 6)
        .rotateZ(-0.32)
        .translate(-0.024, -0.235, 0),
      new TorusGeometry(0.115, 0.012, 6, 22).scale(1, 1.26, 1).translate(0, -0.45, 0),
    ]);
    racket.add(new Mesh(frame, frameMat));
    const texture = stringsTexture();
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    const strings = new Mesh(
      new CircleGeometry(0.112, 20).scale(1, 1.26, 1).translate(0, -0.45, 0),
      new MeshBasicMaterial({ map: texture, transparent: true, side: DoubleSide, depthWrite: false, opacity: 0.8 }),
    );
    racket.add(strings);
    return racket;
  }

  private buildLeg(
    sign: number,
    shorts: MeshLambertMaterial,
    skin: MeshLambertMaterial,
    shoe: MeshLambertMaterial,
  ): Limb {
    const pivot = new Group();
    pivot.position.set(sign * 0.105, -0.04, 0);
    pivot.add(new Mesh(new CapsuleGeometry(0.086, 0.16, 3, 8).translate(0, -0.13, 0), shorts));
    pivot.add(new Mesh(new CapsuleGeometry(0.066, 0.2, 3, 8).translate(0, -0.27, 0), skin));
    const joint = new Group();
    joint.position.y = -THIGH;
    joint.add(new Mesh(new CapsuleGeometry(0.056, 0.28, 3, 8).translate(0, -0.2, 0), skin));
    joint.add(new Mesh(new BoxGeometry(0.1, 0.075, 0.25).translate(0, -SHIN - 0.008, -0.055), shoe));
    pivot.add(joint);
    this.body.add(pivot);
    return { pivot, joint };
  }

  update(p: Player, x: number, y: number, z: number, ball: Vec3, dt: number, celebrate: boolean): void {
    this.time += dt;
    this.root.position.set(x, y, z);
    const speed = Math.hypot(p.vel.x, p.vel.z);

    // Face the net, turning into the direction of travel but backpedalling when retreating.
    let targetYaw = this.baseYaw;
    if (speed > 0.6) {
      let relative = wrapAngle(Math.atan2(-p.vel.x, -p.vel.z) - this.baseYaw);
      if (Math.abs(relative) > Math.PI / 2) relative = wrapAngle(relative - Math.PI * Math.sign(relative));
      targetYaw += clamp(relative, -1.15, 1.15) * clamp01(speed / 3);
    }
    this.yaw += wrapAngle(targetYaw - this.yaw) * (1 - Math.exp(-11 * dt));
    this.root.rotation.y = this.yaw;

    // Legs.
    const run = clamp01(speed / 5.5);
    this.stride += speed * dt * 2.35;
    let thighR: number;
    let thighL: number;
    let kneeR: number;
    let kneeL: number;
    if (!p.onGround) {
      thighR = 0.85;
      kneeR = 1.25;
      thighL = 0.35;
      kneeL = 0.75;
    } else {
      const breathe = Math.sin(this.time * 3) * 0.03;
      const crouch = lerp(0.44 + breathe, 0.2, run);
      const swingAmp = lerp(0, 0.92, run);
      const s = Math.sin(this.stride);
      thighR = crouch + s * swingAmp;
      thighL = crouch - s * swingAmp;
      const c = Math.cos(this.stride);
      kneeR = crouch * 1.75 + Math.max(0, c) * 1.25 * run;
      kneeL = crouch * 1.75 + Math.max(0, -c) * 1.25 * run;
    }
    this.legR.pivot.rotation.x = thighR;
    this.legR.joint.rotation.x = -kneeR;
    this.legL.pivot.rotation.x = thighL;
    this.legL.joint.rotation.x = -kneeL;

    const reachR = THIGH * Math.cos(thighR) + SHIN * Math.cos(thighR - kneeR);
    const reachL = THIGH * Math.cos(thighL) + SHIN * Math.cos(thighL - kneeL);
    const hip = p.onGround ? Math.max(reachR, reachL) + FOOT + 0.04 : 0.92;
    this.body.position.y = hip;

    // Arms and torso.
    const swing = p.swing;
    let twist = 0;
    let targetLeanZ = 0;
    const forwardLean = clamp(speed * 0.045, 0, 0.26);
    let targetLeanX = -forwardLean - 0.1;
    const toBall = this.localToShoulder(ball);

    const readyR = this.tmpA.set(0.36, -0.68, -0.64).normalize();
    let targetBendR = 1.28;
    const readyL = this.tmpB.set(-0.02, -0.56, -0.83).normalize();
    let targetBendL = 1.72;

    if (run > 0.25 && !swing) {
      const pump = Math.sin(this.stride) * run * 0.75;
      readyL.set(-0.2, -0.86, pump).normalize();
      targetBendL = 1.45;
    }

    if (p.tossTime >= 0 && p.tossTime < 1.1) {
      const up = smoothstep(0, 0.2, p.tossTime) * (1 - smoothstep(0.7, 1, p.tossTime));
      readyL.lerp(this.tmpB.clone().set(-0.12, 0.97, -0.2), up).normalize();
      targetBendL = lerp(1.2, 0.1, up);
      readyR.set(0.78, 0.2, 0.58).normalize();
      targetBendR = 1.9;
      targetLeanX = 0.08;
      twist = -0.42 * up;
    }

    this.dirR.lerp(readyR, 1 - Math.exp(-14 * dt)).normalize();
    this.dirL.lerp(readyL, 1 - Math.exp(-14 * dt)).normalize();
    this.bendR = damp(this.bendR, targetBendR, 14, dt);
    this.bendL = damp(this.bendL, targetBendL, 14, dt);

    if (swing) {
      const result = this.poseSwing(swing, toBall, x, z);
      twist = result.twist;
      targetLeanZ = result.leanZ;
      targetLeanX = result.leanX;
      this.dirL.set(-0.55 * result.side, -0.45, 0.42 * result.side).normalize();
      this.bendL = 0.9;
    }

    if (celebrate) {
      const pulse = 0.5 + Math.sin(this.time * 9) * 0.5;
      this.dirR.set(0.32, 0.94, -0.1 * pulse).normalize();
      this.bendR = 0.25 + pulse * 0.35;
      this.dirL.set(-0.42, 0.9, -0.1).normalize();
      this.bendL = 0.3;
      targetLeanX = 0.05;
    }

    this.armR.pivot.quaternion.setFromUnitVectors(DOWN, this.dirR);
    this.armR.joint.rotation.x = this.bendR;
    this.armL.pivot.quaternion.setFromUnitVectors(DOWN, this.dirL);
    this.armL.joint.rotation.x = this.bendL;

    this.upper.rotation.y = damp(this.upper.rotation.y, twist, 30, dt);
    this.leanX = damp(this.leanX, targetLeanX, 12, dt);
    this.leanZ = damp(this.leanZ, targetLeanZ, 18, dt);
    this.body.rotation.x = this.leanX;
    this.body.rotation.z = this.leanZ;

    // Keep an eye on the ball.
    const look = Math.atan2(-toBall.x, -toBall.z);
    const pitch = Math.atan2(toBall.y, Math.hypot(toBall.x, toBall.z));
    this.head.rotation.y = damp(this.head.rotation.y, clamp(look - this.upper.rotation.y, -1, 1), 10, dt);
    this.head.rotation.x = damp(this.head.rotation.x, clamp(pitch, -0.5, 0.75), 10, dt);
  }

  /** Vector from the right shoulder to a world point, in the player's local frame. */
  private localToShoulder(point: Vec3): Vector3 {
    const dx = point.x - this.root.position.x;
    const dz = point.z - this.root.position.z;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const lx = dx * c - dz * s;
    const lz = dx * s + dz * c;
    return new Vector3(
      lx - SHOULDER_X,
      point.y - this.root.position.y - this.body.position.y - 0.04 - SHOULDER_Y,
      lz,
    );
  }

  private poseSwing(swing: Swing, toBall: Vector3, x: number, z: number) {
    let ph: number;
    if (swing.releaseT === null) {
      const wind = smoothstep(0, 0.09, swing.t);
      ph = wind * 0.36 + swing.approach * 0.16;
    } else {
      const f = clamp01((swing.t - swing.releaseT) / 0.3);
      ph = 0.52 + (1 - (1 - f) * (1 - f)) * 0.48;
    }
    const weight = smoothstep(0, 0.12, ph);

    const over = swing.hand === 'over';
    const sign = swing.hand === 'back' ? -1 : 1;
    let v = toBall;
    if (swing.contact) v = this.localToShoulder(swing.contact);
    const near = v.length() < 2.8;
    const yawC = near ? Math.atan2(-v.z, v.x) : sign > 0 ? 0.55 : 2.6;
    const elevC = near ? clamp(Math.atan2(v.y, Math.hypot(v.x, v.z)), -1.1, 1.35) : -0.2;

    const target = this.tmpA;
    if (over) {
      const e = piecewise(ph, 2.55, Math.max(1.05, elevC), -0.75);
      const blend = ph < 0.36 ? weight : 1;
      polar(Math.PI / 2 - 0.25, ph < 0.36 ? lerp(1.2, e, blend) : e, target);
    } else {
      const offset = piecewise(ph, -1.95, 0, 2.3) * sign;
      const elevation = lerp(elevC, 0.15, smoothstep(0.55, 1, ph) * 0.8);
      polar(yawC + offset, ph < 0.52 ? lerp(-0.1, elevC, ph / 0.52) : elevation, target);
    }
    this.dirR.lerp(target, weight).normalize();
    const bend = piecewise(ph, 0.85, 0.12, 0.72);
    this.bendR = lerp(this.bendR, bend, weight);

    let leanZ = 0;
    if (swing.contact) {
      const dx = swing.contact.x - x;
      const dz = swing.contact.z - z;
      const c = Math.cos(this.yaw);
      const s = Math.sin(this.yaw);
      leanZ = clamp(-(dx * c - dz * s) * 0.2, -0.36, 0.36);
    }
    return {
      twist: piecewise(ph, -0.72, 0, 0.8) * (over ? 0.45 : sign),
      leanZ,
      leanX: over ? piecewise(ph, 0.2, -0.05, -0.42) : -0.16,
      side: sign,
    };
  }
}
