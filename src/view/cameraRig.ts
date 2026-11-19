import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { clamp, clamp01, lerp } from '../sim/math';

const HUD_PIXELS = 58;

const NEAR_POINTS: [number, number, number][] = [
  [-5.2, 0, 14.2],
  [5.2, 0, 14.2],
];
const FAR_POINTS: [number, number, number][] = [
  [-4.8, 0, -12.6],
  [4.8, 0, -12.6],
  [0, 2.2, -13.4],
];

/**
 * Fits the whole court into any window shape: the camera is pulled back only as
 * far as needed, so a phone in portrait and a wide monitor both frame it well.
 */
export class CameraRig {
  readonly camera = new PerspectiveCamera(40, 1, 1, 460);
  private readonly basePos = new Vector3();
  private readonly baseTarget = new Vector3();
  private readonly look = new Vector3();
  private readonly probe = new Vector3();
  private follow = 0.42;
  private offsetX = 0;
  private offsetZ = 0;
  private trauma = 0;
  private time = 0;

  private project(x: number, y: number, z: number): Vector3 {
    return this.probe.set(x, y, z).project(this.camera);
  }

  private place(distance: number, pitch: number, targetZ: number): void {
    const c = this.camera;
    c.position.set(0, 0.6 + distance * Math.sin(pitch), targetZ + distance * Math.cos(pitch));
    c.lookAt(0, 0.6, targetZ);
    c.updateMatrixWorld(true);
  }

  private centerAndCheck(distance: number, pitch: number, top: number, bottom: number): { z: number; fits: boolean } {
    const desired = (top + bottom) / 2;
    let z = 0;
    for (let i = 0; i < 10; i++) {
      this.place(distance, pitch, z);
      const low = this.project(0, 0, 14.2).y;
      const high = this.project(0, 2.2, -13.4).y;
      z -= ((low + high) / 2 - desired) * distance * 0.42;
    }
    this.place(distance, pitch, z);
    let fits = true;
    for (const [x, y, zz] of NEAR_POINTS) {
      const p = this.project(x, y, zz);
      if (Math.abs(p.x) > 0.97 || p.y < bottom) fits = false;
    }
    for (const [x, y, zz] of FAR_POINTS) {
      const p = this.project(x, y, zz);
      if (Math.abs(p.x) > 0.97 || p.y > top) fits = false;
    }
    return { z, fits };
  }

  fit(width: number, height: number): void {
    const aspect = width / height;
    const t = clamp01((aspect - 0.55) / (1.7 - 0.55));
    const c = this.camera;
    c.aspect = aspect;
    c.fov = lerp(46, 34, t);
    c.updateProjectionMatrix();
    const pitch = MathUtils.degToRad(lerp(39, 25, t));
    // Keep the far player below the scoreboard, which matters on short screens.
    const top = Math.min(lerp(0.68, 0.82, t), 1 - (2 * HUD_PIXELS) / height);
    const bottom = lerp(-0.5, -0.9, t);
    this.follow = lerp(0.16, 0.42, t);

    let lo = 12;
    let hi = 120;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (this.centerAndCheck(mid, pitch, top, bottom).fits) hi = mid;
      else lo = mid;
    }
    const { z } = this.centerAndCheck(hi, pitch, top, bottom);
    this.place(hi, pitch, z);
    this.basePos.copy(c.position);
    this.baseTarget.set(0, 0.6, z);
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Follows the human player gently, so the court itself stays readable. */
  update(focusX: number, focusZ: number, dt: number, sway: number): void {
    this.time += dt;
    const depth = focusZ - 12.6;
    const targetZ = depth > 0 ? depth : clamp(depth * 0.18, -2.2, 0);
    this.offsetX += (focusX * this.follow + sway - this.offsetX) * (1 - Math.exp(-5 * dt));
    // Retreating players move out of frame quickly, so depth tracks faster.
    this.offsetZ += (targetZ - this.offsetZ) * (1 - Math.exp(-9 * dt));

    this.trauma = Math.max(0, this.trauma - dt * 2.4);
    const shake = this.trauma * this.trauma;
    const sx = Math.sin(this.time * 47) * shake * 0.34;
    const sy = Math.sin(this.time * 61 + 1.3) * shake * 0.26;

    const c = this.camera;
    c.position.set(this.basePos.x + this.offsetX + sx, this.basePos.y + sy, this.basePos.z + this.offsetZ);
    this.look.set(this.baseTarget.x + this.offsetX * 0.7, this.baseTarget.y, this.baseTarget.z + this.offsetZ * 0.6);
    c.lookAt(this.look);
    c.updateMatrixWorld(true);
  }
}
