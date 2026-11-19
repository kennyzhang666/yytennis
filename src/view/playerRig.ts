import { Color, Euler, Group, Matrix4, Quaternion, Vector3 } from 'three';
import { PLAYER, SMASH } from '../sim/constants';
import type { PlayerFrame } from '../sim/frame';
import { clamp, clamp01, lerp, smoothstep } from '../sim/math';
import type { Swing } from '../sim/player';
import type { Vec3 } from '../sim/types';
import { IDEAL_TOSS_TIME } from '../sim/world';
import {
  BIND,
  BONE,
  buildPlayerModel,
  FOREARM,
  RACKET_SWEET_SPOT,
  SHIN,
  THIGH,
  UPPER_ARM,
  type PlayerLook,
  type PlayerModel,
} from './playerModel';
import { copyPose, createPose, evalStroke, mixPose, PH, type Pose, type StrokeName } from './strokes';

const ARM_REACH = (UPPER_ARM + FOREARM) * 0.965;
const FULL_REACH = ARM_REACH + RACKET_SWEET_SPOT;
const REST_RIM = 0.26;

const COLD = new Color(0xbfe4ff);
const HOT = new Color(0xffa23a);
const FULL = new Color(0xfff06a);

function wrapAngle(a: number): number {
  let v = a;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return v;
}

const damp = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

interface FootState {
  pos: Vector3;
  yaw: number;
  pitch: number;
}

/**
 * Turns the simulation's plain state into body motion. Hands and feet are placed
 * first and the joints are solved to reach them, so every stroke can bend to meet
 * the real ball and every foot can plant on the court.
 */
export class PlayerRig {
  readonly root = new Group();
  private readonly model: PlayerModel;
  private readonly global: Quaternion[] = BIND.map(() => new Quaternion());
  private readonly point: Vector3[] = BIND.map((b) => new Vector3(b.at[0], b.at[1], b.at[2]));

  private readonly sweet = new Vector3();
  private readonly baseYaw: number;
  private readonly facing: 1 | -1;
  private yaw: number;
  private time = Math.random() * 10;
  private strideClock = Math.random();

  private stroke: StrokeName | null = null;
  private ph = 0;
  private weight = 0;
  private crossfade = 1;
  private splitT = 1;
  private landT = 1;
  private wasGrounded = true;
  private cheer = 0;
  private lastForehand = true;

  private readonly snapshot = createPose();
  private readonly keyPose = createPose();
  private readonly strokePose = createPose();
  private readonly loco = createPose();
  private readonly finalPose = createPose();
  private readonly ready = createPose();
  private readonly lunge = new Vector3();
  private readonly lungeNow = new Vector3();

  private readonly footR: FootState = { pos: new Vector3(), yaw: 0, pitch: 0 };
  private readonly footL: FootState = { pos: new Vector3(), yaw: 0, pitch: 0 };

  private readonly v = Array.from({ length: 12 }, () => new Vector3());
  private readonly q = Array.from({ length: 5 }, () => new Quaternion());
  private readonly matrix = new Matrix4();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');

  constructor(side: 0 | 1, look: PlayerLook, detailed: boolean) {
    this.baseYaw = side === 0 ? 0 : Math.PI;
    this.facing = side === 0 ? 1 : -1;
    this.yaw = this.baseYaw;
    this.model = buildPlayerModel(look, detailed);
    this.root.add(this.model.group);
    evalStroke('fore', 0, this.ready);
  }

  /** World position of the middle of the strings, for effects. */
  racketHead(out: Vec3): void {
    out.x = this.sweet.x;
    out.y = this.sweet.y;
    out.z = this.sweet.z;
  }

  /** A small hop as the opponent strikes the ball, like a real split step. */
  splitStep(): void {
    this.splitT = 0;
  }

  private rigFromWorld(x: number, y: number, z: number, base: Vec3, out: Vector3): Vector3 {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const dx = x - base.x;
    const dz = z - base.z;
    return out.set(dx * c - dz * s, y - base.y, dx * s + dz * c);
  }

  private predictStroke(p: PlayerFrame): StrokeName | null {
    const incoming = p.incoming;
    if (!incoming) return null;
    if (incoming.y - p.pos.y >= SMASH.standHeight) return 'smash';
    const side = (incoming.x - p.pos.x) * this.facing;
    if (Math.abs(side) > 0.22) this.lastForehand = side > 0;
    const volley = !incoming.bounced && Math.abs(incoming.z) < 7.5;
    if (volley) return this.lastForehand ? 'volleyFore' : 'volleyBack';
    return this.lastForehand ? 'fore' : 'back';
  }

  private strokeForSwing(s: Swing, p: PlayerFrame): StrokeName {
    if (s.serve) return 'serve';
    if (s.hand === 'over' || s.shot === 'smash') return 'smash';
    const volley = s.shot ? s.shot === 'volley' : p.incoming ? !p.incoming.bounced : false;
    if (s.hand === 'back') return volley ? 'volleyBack' : 'back';
    return volley ? 'volleyFore' : 'fore';
  }

  private chooseStroke(p: PlayerFrame, dt: number): void {
    const s = p.swing;
    let name: StrokeName | null = null;
    let target = 0;
    let rate = 11;
    let exact = false;

    if (s) {
      name = this.strokeForSwing(s, p);
      if (s.releaseT === null) {
        // The forward swing is tied to the ball's arrival so the two meet exactly.
        const toContact = s.serve ? 0.05 * (1 - s.approach) : p.incoming ? p.incoming.t : (1 - s.approach) * 0.075;
        target = PH.loaded + (PH.contact - PH.loaded) * clamp01(1 - toContact / 0.13);
        exact = !s.whiff && toContact < 0.13;
        rate = 75;
      } else {
        const f = clamp01((s.t - s.releaseT) / 0.36);
        target = PH.contact + (PH.finish - PH.contact) * (1 - (1 - f) * (1 - f));
        exact = true;
      }
    } else if (p.tossTime >= 0) {
      name = 'serve';
      const toss = p.tossTime;
      const drop = smoothstep(IDEAL_TOSS_TIME - 0.13, IDEAL_TOSS_TIME - 0.01, toss);
      const back = smoothstep(IDEAL_TOSS_TIME + 0.14, IDEAL_TOSS_TIME + 0.34, toss);
      target = PH.loaded * smoothstep(0, 0.42, toss) + (PH.drop + 0.02 - PH.loaded) * drop * (1 - back);
      rate = 26;
    } else if (p.serving) {
      name = 'serve';
    } else if (p.charging) {
      name = this.predictStroke(p) ?? this.stroke ?? 'fore';
      target = PH.loaded;
      rate = 16;
    } else if (p.incoming && p.incoming.t < 0.82) {
      name = this.predictStroke(p);
      target = PH.loaded * (1 - smoothstep(0.42, 0.82, p.incoming.t));
      rate = 10;
    }

    if (name) {
      const restart = name !== this.stroke || (this.ph > PH.contact + 0.02 && target < PH.contact);
      if (restart) {
        if (this.weight > 0.02) {
          copyPose(this.snapshot, this.strokePose);
          this.crossfade = 0;
        } else {
          this.crossfade = 1;
        }
        this.stroke = name;
        this.ph = exact ? target : Math.min(target, 0.08);
      }
      this.ph = exact ? target : this.ph + (target - this.ph) * damp(rate, dt);
      this.weight += (1 - this.weight) * damp(16, dt);
    } else {
      if (this.ph > PH.contact) this.ph += (PH.finish - this.ph) * damp(12, dt);
      else this.ph += (0 - this.ph) * damp(7, dt);
      this.weight += (0 - this.weight) * damp(6.5, dt);
      if (this.weight < 0.01) {
        this.weight = 0;
        this.ph = 0;
        this.stroke = null;
      }
    }
    this.crossfade = Math.min(1, this.crossfade + dt / 0.09);
  }

  /** Bends the authored stroke so the middle of the strings meets the actual ball. */
  private fitStrokeToBall(p: PlayerFrame): void {
    const pose = this.strokePose;
    const s = p.swing;
    const C = this.v[0];
    let wanted = false;
    if (s?.contact) {
      this.rigFromWorld(s.contact.x, s.contact.y, s.contact.z, p.pos, C);
      wanted = true;
    } else if (s?.serve || p.tossTime >= 0) {
      this.rigFromWorld(p.frameBallX, Math.max(p.frameBallY, 2.6), p.frameBallZ, p.pos, C);
      wanted = true;
    } else if (p.incoming && (s || p.charging || p.incoming.t < 0.62)) {
      this.rigFromWorld(p.incoming.x, p.incoming.y, p.incoming.z, p.pos, C);
      wanted = true;
    }

    if (!wanted || !this.stroke) {
      this.lunge.multiplyScalar(0.8);
      return;
    }

    evalStroke(this.stroke, PH.contact, this.keyPose);
    const key = this.keyPose;
    const cosT = Math.cos(key.torso);
    const sinT = Math.sin(key.torso);
    const S = this.v[1].set(0.205 * cosT, 1.47 - key.crouch + key.lift, -0.205 * sinT);

    const toBall = this.v[2].subVectors(C, S);
    const distance = toBall.length();
    const excess = Math.max(0, distance - FULL_REACH * 0.985);
    this.lunge.copy(toBall).multiplyScalar(excess / Math.max(1e-4, distance));
    if (this.lunge.length() > 0.95) this.lunge.setLength(0.95);
    S.addScaledVector(this.lunge, 0.86);

    const H = this.v[3];
    const pole = this.v[4].subVectors(key.hand, S);
    this.solveTwoBone(S, C, ARM_REACH, RACKET_SWEET_SPOT, pole, H, this.v[5], this.v[6], this.v[7]);
    const dirC = this.v[8].subVectors(C, H).normalize();

    const w =
      this.ph <= PH.contact
        ? smoothstep(0.26, PH.contact, this.ph)
        : lerp(1, 0.22, smoothstep(PH.contact, PH.finish, this.ph));
    const delta = this.v[9].subVectors(H, key.hand);
    pose.hand.addScaledVector(delta, w);
    const rotate = this.q[0].setFromUnitVectors(key.dir, dirC);
    const partial = this.q[1].identity().slerp(rotate, w);
    pose.dir.applyQuaternion(partial);
    pose.face.applyQuaternion(partial);
    this.lunge.multiplyScalar(w);

    if (s?.shot === 'lob') {
      const k = smoothstep(PH.contact, 0.86, this.ph);
      pose.hand.y += 0.16 * k;
      pose.dir.y += 0.5 * k;
      pose.dir.normalize();
    }
  }

  private buildStrokePose(p: PlayerFrame): void {
    if (!this.stroke) return;
    evalStroke(this.stroke, this.ph, this.strokePose);
    this.fitStrokeToBall(p);

    const pose = this.strokePose;
    if (p.chargeLevel > 0) {
      const level = p.chargeLevel;
      const shake = level * level * 0.007;
      pose.torso *= 1 + 0.16 * level;
      pose.crouch += 0.05 * level;
      pose.hand.x += Math.sin(this.time * 61) * shake;
      pose.hand.y += Math.sin(this.time * 73) * shake;
    }
    if (this.stroke === 'smash' && this.ph < PH.contact && p.incoming) {
      // The free arm tracks the falling ball, as it does in a real overhead.
      const aim = this.v[10];
      this.rigFromWorld(p.incoming.x, p.incoming.y, p.incoming.z, p.pos, aim);
      const shoulder = this.v[11].set(-0.2, 1.47, 0);
      aim.sub(shoulder).setLength(0.5).add(shoulder);
      pose.left.lerp(aim, smoothstep(0.1, PH.loaded, this.ph));
    }
    if (this.crossfade < 1) {
      mixPose(pose, this.snapshot, pose, this.crossfade * this.crossfade * (3 - 2 * this.crossfade));
    }
  }

  private computeLocomotion(p: PlayerFrame, lx: number, lz: number, speed: number, dt: number): void {
    const runK = smoothstep(0.5, 2.8, speed);
    const pace = clamp01(speed / PLAYER.maxSpeed);
    const stride = lerp(1.25, 2.9, pace);
    this.strideClock = (this.strideClock + (speed * dt) / stride) % 1;

    const dirX = speed > 0.05 ? lx / speed : 0;
    const dirZ = speed > 0.05 ? lz / speed : -1;
    const amplitude = lerp(0.14, 0.43, pace) * (1 - 0.42 * Math.abs(dirX));
    const lift = lerp(0.08, 0.2, pace);
    const hipsYaw = this.weight * (this.stroke ? this.strokePose.hips : 0);

    const place = (foot: FootState, side: 1 | -1, offset: number) => {
      const c = Math.cos(hipsYaw * 0.55);
      const s = Math.sin(hipsYaw * 0.55);
      const wide = lerp(0.2, 0.16, this.weight * 0.3);
      const sx = side * wide;
      const sz = side * 0.05;
      let x = sx * c + sz * s;
      let z = -sx * s + sz * c;
      let y = 0.07;
      let pitch = 0;
      let yaw = hipsYaw * 0.6 + side * 0.16;

      if (runK > 0) {
        const u = (this.strideClock + offset) % 1;
        const stance = 0.42;
        let along: number;
        let up = 0;
        let footPitch: number;
        if (u < stance) {
          const k = u / stance;
          along = amplitude * (1 - 2 * k);
          footPitch = -0.72 * k * k * k + 0.12 * (1 - k) * (1 - k);
        } else {
          const k = (u - stance) / (1 - stance);
          along = -amplitude * Math.cos(Math.PI * k);
          up = lift * Math.sin(Math.PI * k) ** 0.8;
          footPitch = lerp(-0.72, 0.26, k);
        }
        const rx = side * 0.1 + dirX * along;
        const rz = dirZ * along;
        x = lerp(x, rx, runK);
        z = lerp(z, rz, runK);
        y += up * runK;
        pitch = footPitch * runK;
        const forward = dirZ <= 0 ? 1 : -1;
        const runYaw = Math.abs(dirX) < 0.85 ? clamp(Math.atan2(-dirX * forward, -dirZ * forward), -0.7, 0.7) : 0;
        yaw = lerp(yaw, runYaw, runK);
      }

      if (!p.onGround) {
        x = side * 0.12;
        z = side * 0.07;
        y = side === 1 ? 0.2 : 0.11;
        pitch = -0.45;
      }
      foot.pos.set(x, y, z);
      foot.pitch = pitch;
      foot.yaw = yaw;
    };
    place(this.footR, 1, 0);
    place(this.footL, -1, 0.5);

    // Upper body while no stroke is under way.
    const loco = this.loco;
    copyPose(loco, this.ready);
    const swingArm = Math.sin((this.strideClock + 0.5) * Math.PI * 2);
    loco.hand.set(lerp(0.13, 0.26, runK), lerp(1.03, 1.02, runK) + Math.abs(swingArm) * 0.03 * runK, lerp(-0.3, -0.16, runK));
    loco.dir.set(lerp(-0.18, 0.14, runK), lerp(0.33, 0.6, runK), lerp(-0.93, -0.78, runK)).normalize();
    loco.left.set(lerp(-0.1, -0.25, runK), lerp(1.08, 1.04, runK), lerp(-0.4, -0.04 + swingArm * 0.2, runK));
    loco.grip = 1 - runK;
    loco.pitch = -0.12 - pace * 0.2 * Math.max(0.15, -dirZ);
    loco.roll = -dirX * pace * 0.12;
    loco.crouch = lerp(0.07 + Math.sin(this.time * 3.2) * 0.008, 0.055, runK);
    loco.crouch += Math.abs(Math.cos(this.strideClock * Math.PI * 2)) * 0.022 * runK;
  }

  update(p: PlayerFrame, dt: number): void {
    this.time += dt;
    const speed = Math.hypot(p.vel.x, p.vel.z);
    if (p.onGround && !this.wasGrounded) this.landT = 0;
    this.wasGrounded = p.onGround;
    this.landT = Math.min(1, this.landT + dt / 0.2);
    this.splitT = Math.min(1, this.splitT + dt / 0.24);

    let yawTarget = this.baseYaw;
    if (speed > 0.6 && this.weight < 0.65) {
      let relative = wrapAngle(Math.atan2(-p.vel.x, -p.vel.z) - this.baseYaw);
      if (Math.abs(relative) > Math.PI / 2) relative = wrapAngle(relative - Math.PI * Math.sign(relative));
      yawTarget += clamp(relative, -1.05, 1.05) * clamp01(speed / 3);
    }
    this.yaw += wrapAngle(yawTarget - this.yaw) * damp(11, dt);

    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const lx = p.vel.x * c - p.vel.z * s;
    const lz = p.vel.x * s + p.vel.z * c;

    this.chooseStroke(p, dt);
    this.buildStrokePose(p);
    this.computeLocomotion(p, lx, lz, speed, dt);

    const pose = this.finalPose;
    if (this.stroke) mixPose(pose, this.loco, this.strokePose, this.weight * this.weight * (3 - 2 * this.weight));
    else copyPose(pose, this.loco);

    this.cheer += ((p.celebrating ? 1 : 0) - this.cheer) * damp(10, dt);
    if (this.cheer > 0.01) this.applyCelebration(pose);

    const lungeTarget = this.weight > 0.05 && this.stroke ? this.lunge : this.v[0].set(0, 0, 0);
    this.lungeNow.lerp(lungeTarget, damp(this.ph > PH.contact ? 8 : 24, dt));

    this.solvePose(p, pose);
  }

  private applyCelebration(pose: Pose): void {
    const k = this.cheer;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 8);
    pose.hand.lerp(this.v[0].set(0.3, 1.96 + pulse * 0.05, -0.12), k);
    pose.dir.lerp(this.v[1].set(0.12, 0.95, -0.1), k).normalize();
    pose.left.lerp(this.v[2].set(-0.32, 1.86 + pulse * 0.06, -0.08), k);
    pose.grip *= 1 - k;
    pose.pitch = lerp(pose.pitch, 0.04, k);
    pose.torso = lerp(pose.torso, 0, k);
    pose.hips = lerp(pose.hips, 0, k);
    pose.lift += k * pulse * 0.07;
    pose.elbow.lerp(this.v[3].set(0.8, -0.2, 0.5), k).normalize();
  }

  /** Two-bone inverse kinematics: finds the joint between a root and a target. */
  private solveTwoBone(
    root: Vector3,
    target: Vector3,
    l1: number,
    l2: number,
    pole: Vector3,
    joint: Vector3,
    end: Vector3,
    axis: Vector3,
    perp: Vector3,
  ): void {
    axis.subVectors(target, root);
    const raw = axis.length();
    const d = clamp(raw, Math.abs(l1 - l2) + 0.001, l1 + l2 - 0.002);
    if (raw > 1e-5) axis.multiplyScalar(1 / raw);
    else axis.set(0, -1, 0);
    perp.copy(pole).addScaledVector(axis, -pole.dot(axis));
    if (perp.lengthSq() < 1e-6) {
      perp.set(axis.y, -axis.x, 0.3).addScaledVector(axis, -axis.z * 0.3);
    }
    perp.normalize();
    const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    joint.copy(root).addScaledVector(axis, a).addScaledVector(perp, h);
    end.copy(root).addScaledVector(axis, d);
  }

  private frame(out: Quaternion, xAxis: Vector3, yAxis: Vector3): Quaternion {
    const z = this.v[11].crossVectors(xAxis, yAxis).normalize();
    this.matrix.makeBasis(xAxis, yAxis, z);
    return out.setFromRotationMatrix(this.matrix);
  }

  private yawPitchRoll(out: Quaternion, yaw: number, pitch: number, roll: number): Quaternion {
    this.euler.set(pitch, yaw, roll, 'YXZ');
    return out.setFromEuler(this.euler);
  }

  /** Places a child bone's joint from its parent's position and rotation. */
  private place(bone: number): void {
    const bind = BIND[bone];
    const parent = BIND[bind.parent];
    this.point[bone]
      .set(bind.at[0] - parent.at[0], bind.at[1] - parent.at[1], bind.at[2] - parent.at[2])
      .applyQuaternion(this.global[bind.parent])
      .add(this.point[bind.parent]);
  }

  private solveArm(bones: { clav: number; arm: number; fore: number; hand: number }, target: Vector3, pole: Vector3): void {
    const G = this.global;
    const P = this.point;
    this.place(bones.clav);
    G[bones.clav].copy(G[BONE.chest]);
    this.place(bones.arm);
    const shoulder = P[bones.arm];
    const elbow = P[bones.fore];
    const wrist = P[bones.hand];
    const e = this.v[4];
    const perp = this.v[5];
    this.solveTwoBone(shoulder, target, UPPER_ARM, FOREARM, pole, elbow, wrist, e, perp);
    const x = this.v[6].crossVectors(perp, e).normalize();
    const y = this.v[7].subVectors(shoulder, elbow).normalize();
    this.frame(G[bones.arm], x, y);
    y.subVectors(elbow, wrist).normalize();
    this.frame(G[bones.fore], x, y);
  }

  private solveLeg(thigh: number, shin: number, foot: number, toe: number, state: FootState, side: 1 | -1): void {
    const G = this.global;
    const P = this.point;
    this.place(thigh);
    const hip = P[thigh];
    const knee = P[shin];
    const ankle = P[foot];
    const c = Math.cos(state.yaw);
    const s = Math.sin(state.yaw);
    const pole = this.v[3].set(-s + side * 0.14 * c, 0.05, -c - side * 0.14 * s);
    const e = this.v[4];
    const perp = this.v[5];
    this.solveTwoBone(hip, state.pos, THIGH, SHIN, pole, knee, ankle, e, perp);
    const x = this.v[6].crossVectors(e, perp).normalize();
    const y = this.v[7].subVectors(hip, knee).normalize();
    this.frame(G[thigh], x, y);
    y.subVectors(knee, ankle).normalize();
    this.frame(G[shin], x, y);
    this.yawPitchRoll(G[foot], state.yaw, state.pitch, 0);
    G[toe].copy(G[foot]).multiply(this.q[2].setFromAxisAngle(this.v[8].set(1, 0, 0), -state.pitch * 0.85));
  }

  private solvePose(p: PlayerFrame, pose: Pose): void {
    const G = this.global;
    const P = this.point;
    const L = this.lungeNow;

    // Hips drop for the stance and for low balls, and travel towards the shot.
    const split = this.splitT < 1 ? Math.sin(Math.PI * this.splitT) : 0;
    const land = this.landT < 1 ? Math.sin(Math.PI * this.landT) * 0.08 : 0;
    const lowReach = Math.max(0, -L.y);
    const crouch = pose.crouch + land + lowReach * 0.8;
    const hipsY = p.onGround ? clamp(0.955 - crouch, 0.62, 0.955) : 0.94;
    P[BONE.hips].set(L.x * 0.26, hipsY, L.z * 0.26);

    this.yawPitchRoll(G[BONE.hips], pose.hips, pose.pitch * 0.3, pose.roll * 0.3);
    this.yawPitchRoll(G[BONE.spine], lerp(pose.hips, pose.torso, 0.5), pose.pitch * 0.65, pose.roll * 0.65);
    this.yawPitchRoll(G[BONE.chest], pose.torso, pose.pitch, pose.roll);
    G[BONE.neck].copy(G[BONE.chest]);
    this.place(BONE.spine);
    this.place(BONE.chest);
    this.place(BONE.neck);
    this.place(BONE.head);

    // The racket hand leads. The left hand follows the racket or moves freely.
    const dir = pose.dir;
    const face = this.v[8].copy(pose.face).addScaledVector(dir, -pose.face.dot(dir));
    if (face.lengthSq() < 1e-5) face.set(0, 0, 1).addScaledVector(dir, -dir.z);
    face.normalize();

    this.solveArm({ clav: BONE.clavR, arm: BONE.armR, fore: BONE.foreR, hand: BONE.handR }, pose.hand, pose.elbow);
    const wristR = P[BONE.handR];
    const yHand = this.v[9].copy(dir).negate();
    const xHand = this.v[10].crossVectors(yHand, face).normalize();
    this.matrix.makeBasis(xHand, yHand, face);
    G[BONE.handR].setFromRotationMatrix(this.matrix);

    const onRacket = this.v[2].copy(wristR).addScaledVector(dir, pose.gripAt);
    const leftTarget = this.v[1].lerpVectors(pose.left, onRacket, pose.grip);
    const leftPole = this.v[0].set(-0.55, -0.6, 0.35);
    this.solveArm({ clav: BONE.clavL, arm: BONE.armL, fore: BONE.foreL, hand: BONE.handL }, leftTarget, leftPole);
    if (pose.grip > 0.5) {
      this.matrix.makeBasis(xHand, yHand, face);
      G[BONE.handL].setFromRotationMatrix(this.matrix);
    } else {
      G[BONE.handL].copy(G[BONE.foreL]);
    }

    // Head turns to watch the ball, within what a neck can do.
    const toBall = this.rigFromWorld(p.frameBallX, p.frameBallY, p.frameBallZ, p.pos, this.v[3]).sub(P[BONE.head]);
    const lookYaw = clamp(wrapAngle(Math.atan2(-toBall.x, -toBall.z) - pose.torso), -1.15, 1.15) + pose.torso;
    const lookPitch = clamp(Math.atan2(toBall.y - 0.1, Math.hypot(toBall.x, toBall.z)), -0.55, 0.85);
    this.yawPitchRoll(G[BONE.head], lookYaw, lookPitch, 0);
    G[BONE.neck].copy(G[BONE.chest]).slerp(G[BONE.head], 0.5);

    // Feet: the leading foot steps out to help reach wide balls.
    const leadRight = this.stroke !== 'back' && this.stroke !== 'volleyBack';
    const stepWeight = 0.74;
    this.footR.pos.addScaledVector(L, leadRight ? stepWeight : 0.2);
    this.footL.pos.addScaledVector(L, leadRight ? 0.2 : stepWeight);
    this.footR.pos.y = Math.max(0.07, this.footR.pos.y - (leadRight ? L.y * stepWeight : L.y * 0.2));
    this.footL.pos.y = Math.max(0.07, this.footL.pos.y - (leadRight ? L.y * 0.2 : L.y * stepWeight));
    this.solveLeg(BONE.thighR, BONE.shinR, BONE.footR, BONE.toeR, this.footR, 1);
    this.solveLeg(BONE.thighL, BONE.shinL, BONE.footL, BONE.toeL, this.footL, -1);

    // Copy the solved rotations into the skeleton.
    const bones = this.model.bones;
    bones[BONE.hips].position.copy(P[BONE.hips]);
    bones[BONE.hips].quaternion.copy(G[BONE.hips]);
    for (let i = 1; i < BIND.length; i++) {
      const parent = BIND[i].parent;
      bones[i].quaternion.copy(this.q[3].copy(G[parent]).invert()).multiply(G[i]);
    }

    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    const ox = L.x * 0.5;
    const oz = L.z * 0.5;
    const rootX = p.pos.x + ox * c + oz * s;
    const rootZ = p.pos.z - ox * s + oz * c;
    const extraLift = Math.max(0, L.y) * 0.92 + pose.lift + split * 0.055;
    const rootY = p.pos.y + extraLift;
    this.root.position.set(rootX, rootY, rootZ);
    this.root.rotation.y = this.yaw;

    const hx = wristR.x + dir.x * RACKET_SWEET_SPOT;
    const hz = wristR.z + dir.z * RACKET_SWEET_SPOT;
    this.sweet.set(rootX + hx * c + hz * s, rootY + wristR.y + dir.y * RACKET_SWEET_SPOT, rootZ - hx * s + hz * c);

    this.applyGlow(p.chargeLevel);
  }

  private applyGlow(level: number): void {
    const rim = this.model.rim;
    const color = rim.uRimColor.value;
    if (level <= 0) {
      color.copy(COLD);
      rim.uRimAmount.value = REST_RIM;
      return;
    }
    if (level >= 1) color.copy(FULL);
    else color.copy(COLD).lerp(HOT, Math.min(1, level * 1.5));
    const pulse = level >= 1 ? 0.3 + 0.2 * Math.sin(this.time * 18) : 0;
    rim.uRimAmount.value = REST_RIM + level * 1.1 + pulse;
  }
}
