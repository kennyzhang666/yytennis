import { Vector3 } from 'three';
import { ARENA } from '../sim/constants';
import type { SceneFrame } from '../sim/frame';
import { clamp, lerp } from '../sim/math';
import type { ReplayClip } from '../sim/replay';
import { sideDir, type Side } from '../sim/types';
import type { CameraRig } from './cameraRig';

type ShotKind = 'rail' | 'hitter' | 'landing' | 'line' | 'net' | 'winner';

interface CameraShot {
  kind: ShotKind;
  until: number;
}

const INNER_X = ARENA.wallX - 0.3;
const INNER_Z = ARENA.wallZ - 0.4;

/** Chooses broadcast-style camera angles for a replayed point. */
export class ReplayDirector {
  private readonly shots: CameraShot[] = [];
  private readonly pos = new Vector3();
  private readonly target = new Vector3();
  private readonly wantPos = new Vector3();
  private readonly wantTarget = new Vector3();
  private index = -1;
  private fov = 36;

  private readonly hitX: number = 0;
  private readonly hitY: number = 1;
  private readonly hitZ: number = 0;
  private readonly hitter: Side = 0;
  private readonly isServe: boolean = false;
  private readonly travelX: number = 0;
  private readonly travelZ: number = 1;
  private readonly netX: number = 0;

  constructor(private readonly clip: ReplayClip) {
    const entries = clip.events.filter((e) => e.event.type === 'hit');
    const last = entries[entries.length - 1];
    const lastHit = last?.event.type === 'hit' ? last.event : null;
    const lastT = last?.t ?? clip.start;
    if (lastHit) {
      this.hitX = lastHit.x;
      this.hitY = lastHit.y;
      this.hitZ = lastHit.z;
      this.hitter = lastHit.side;
      this.isServe = lastHit.shot === 'serve';
      const speed = Math.max(0.1, Math.hypot(lastHit.vx, lastHit.vz));
      this.travelX = lastHit.vx / speed;
      this.travelZ = lastHit.vz / speed;
    }
    const netEntry = clip.events.find((e) => e.t >= lastT && e.event.type === 'net');
    if (netEntry?.event.type === 'net') this.netX = netEntry.event.x;

    if (entries.length >= 2 && lastT - 0.34 > clip.start + 0.3) {
      this.shots.push({ kind: 'rail', until: lastT - 0.34 });
    }
    this.shots.push({ kind: 'hitter', until: lastT + 0.2 });

    const closeCall = clip.point.margin !== null && clip.point.margin < 0 && clip.point.margin > -0.5;
    const bounce = clip.lastBounce && clip.lastBounce.t >= lastT ? clip.lastBounce : null;
    // Always leave a moment at the end for the winner's reaction.
    const flightEnd = Math.min(clip.end - 0.42, bounce ? bounce.t + 0.55 : clip.pointTime + 0.45);
    if (netEntry) this.shots.push({ kind: 'net', until: flightEnd });
    else this.shots.push({ kind: closeCall ? 'line' : 'landing', until: flightEnd });
    this.shots.push({ kind: 'winner', until: Infinity });
  }

  /** Text for the overlay when the replay settles a close line call. */
  get lineCall(): string | null {
    const { margin, reason } = this.clip.point;
    if (margin === null || margin >= 0 || margin < -0.5) return null;
    if (reason !== 'out' && reason !== 'double-fault') return null;
    return `出界 ${Math.max(1, Math.round(-margin * 100))} 厘米`;
  }

  private frameShot(kind: ShotKind, frame: SceneFrame, aspect: number): void {
    const ball = frame.ball.pos;
    const p = this.wantPos;
    const t = this.wantTarget;
    const clip = this.clip;
    switch (kind) {
      case 'rail':
        p.set(9.05, 2.9, clamp(ball.z * 0.72, -13, 13));
        t.set(ball.x * 0.3, 0.72 + clamp(ball.y, 0, 3) * 0.14, ball.z * 0.94);
        this.fov = 47;
        break;
      case 'hitter': {
        const dir = sideDir(this.hitter);
        const body = frame.players[this.hitter].pos;
        const racketSide = (this.hitX >= body.x ? 1 : -1) || 1;
        const low = this.isServe ? 0.82 : 1.05;
        const midX = lerp(body.x, this.hitX, 0.5);
        const midZ = lerp(body.z, this.hitZ, 0.5);
        p.set(midX + racketSide * 2.3, low, midZ - dir * 2.5);
        t.set(midX, lerp(1.15, this.hitY, this.isServe ? 0.72 : 0.42), midZ + dir * 0.2);
        this.fov = this.isServe ? 44 : 34;
        break;
      }
      case 'landing': {
        const b = clip.lastBounce;
        const lx = b?.x ?? ball.x;
        const lz = b?.z ?? ball.z;
        p.set(lx + this.travelX * 3.3 - this.travelZ * 1.35, 0.46, lz + this.travelZ * 3.3 + this.travelX * 1.35);
        t.set(lerp(lx, ball.x, 0.5), clamp(ball.y, 0.2, 1.3), lerp(lz, ball.z, 0.5));
        this.fov = 40;
        break;
      }
      case 'line': {
        const b = clip.lastBounce;
        const lx = b?.x ?? ball.x;
        const lz = b?.z ?? ball.z;
        p.set(lx + 0.5, 2.2, lz + Math.sign(lz || 1) * 1.15);
        t.set(lx, 0.05, lz);
        this.fov = 34;
        break;
      }
      case 'net':
        p.set(this.netX + 2.3, 1, sideDir(this.hitter) * 2.8);
        t.set(this.netX, 0.75, 0);
        this.fov = 38;
        break;
      case 'winner': {
        const winner = frame.players[clip.point.winner];
        const dir = sideDir(clip.point.winner);
        p.set(winner.pos.x + 1.2, 1.5, winner.pos.z - dir * 3.5);
        t.set(winner.pos.x, 1.32 + winner.pos.y, winner.pos.z);
        this.fov = 30;
        break;
      }
    }
    // Narrow screens need more distance to keep the same subject in frame.
    const zoomOut = clamp(1.3 / aspect, 1, 2.3);
    if (kind !== 'rail' && zoomOut > 1) p.sub(t).multiplyScalar(zoomOut).add(t);
    p.x = clamp(p.x, -INNER_X, INNER_X);
    p.z = clamp(p.z, -INNER_Z, INNER_Z);
    // Stay on the near side of the net from the subject, so the net never blocks the view.
    if (kind !== 'net' && kind !== 'rail' && Math.abs(p.z) < 0.9) p.z = Math.sign(t.z || 1) * 0.9;
  }

  apply(time: number, frame: SceneFrame, rig: CameraRig, dt: number): void {
    let i = 0;
    while (i < this.shots.length - 1 && time >= this.shots[i].until) i++;
    const shot = this.shots[i];
    this.frameShot(shot.kind, frame, rig.camera.aspect);
    if (i !== this.index) {
      this.index = i;
      this.pos.copy(this.wantPos);
      this.target.copy(this.wantTarget);
    } else {
      this.pos.lerp(this.wantPos, 1 - Math.exp(-7 * dt));
      this.target.lerp(this.wantTarget, 1 - Math.exp(-13 * dt));
    }
    rig.setDirected(this.pos.x, this.pos.y, this.pos.z, this.target.x, this.target.y, this.target.z, this.fov);
  }
}
