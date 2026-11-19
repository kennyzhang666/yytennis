import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Camera,
} from 'three';
import type { Ball } from '../sim/ball';
import { BALL_RADIUS } from '../sim/constants';
import { clamp01 } from '../sim/math';
import type { Vec3 } from '../sim/types';
import { ballTexture } from './textures';
import { GroundBlob } from './markers';

const TRAIL_POINTS = 16;

export class BallView {
  readonly group = new Group();
  private readonly mesh: Mesh;
  private readonly shadow: GroundBlob;
  private readonly trail: Mesh;
  private readonly trailMaterial: ShaderMaterial;
  private readonly positions = new Float32Array(TRAIL_POINTS * 2 * 3);
  private readonly fades = new Float32Array(TRAIL_POINTS * 2);
  private readonly history: Vector3[] = [];
  private readonly axis = new Vector3();
  private readonly spinStep = new Quaternion();
  private readonly viewDir = new Vector3();
  private readonly segment = new Vector3();
  private readonly sideVec = new Vector3();
  private strength = 0;

  constructor(blob: GroundBlob) {
    this.shadow = blob;
    this.mesh = new Mesh(
      new SphereGeometry(BALL_RADIUS, 18, 12),
      new MeshLambertMaterial({ map: ballTexture(), emissive: 0x59660c, emissiveIntensity: 0.9 }),
    );
    for (let i = 0; i < TRAIL_POINTS; i++) this.history.push(new Vector3());

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
    geometry.setAttribute('aFade', new BufferAttribute(this.fades, 1).setUsage(DynamicDrawUsage));
    const indices: number[] = [];
    for (let i = 0; i < TRAIL_POINTS - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(indices);
    this.trailMaterial = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uColor: { value: new Color(0xe9ff7a) } },
      vertexShader: `
        attribute float aFade;
        varying float vFade;
        void main() {
          vFade = aFade;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vFade;
        void main() {
          gl_FragColor = vec4(uColor, vFade);
          #include <colorspace_fragment>
        }`,
    });
    this.trail = new Mesh(geometry, this.trailMaterial);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 6;
    this.group.add(this.mesh, this.trail);
  }

  setTrailColor(color: number): void {
    (this.trailMaterial.uniforms.uColor.value as Color).setHex(color);
  }

  resetTrail(x: number, y: number, z: number): void {
    for (const p of this.history) p.set(x, y, z);
  }

  update(ball: Ball, pos: Vec3, camera: Camera, dt: number): void {
    this.mesh.position.set(pos.x, pos.y, pos.z);

    // Far-away balls are drawn a little larger so they never shrink to a dot.
    const distance = camera.position.distanceTo(this.mesh.position);
    this.mesh.scale.setScalar(1 + clamp01((distance - 16) / 34) * 0.85);

    if (ball.spin !== 0 && !ball.held) {
      this.axis.set(ball.vel.z, 0, -ball.vel.x);
      if (this.axis.lengthSq() > 0.01) {
        this.axis.normalize();
        this.spinStep.setFromAxisAngle(this.axis, Math.sign(ball.vel.z || 1) * ball.spin * dt * 0.5);
        this.mesh.quaternion.premultiply(this.spinStep);
      }
    }

    const height = Math.max(0, pos.y - BALL_RADIUS);
    const spread = 1 + height * 0.16;
    this.shadow.place(pos.x + height * 0.1, pos.z - height * 0.06, 0.2 * spread, 0.2 * spread, 0.5 / (1 + height * 0.3));

    const speed = Math.hypot(ball.vel.x, ball.vel.y, ball.vel.z);
    const target = ball.held ? 0 : clamp01((speed - 7) / 18);
    this.strength += (target - this.strength) * (1 - Math.exp(-16 * dt));

    for (let i = TRAIL_POINTS - 1; i > 0; i--) this.history[i].copy(this.history[i - 1]);
    this.history[0].set(pos.x, pos.y, pos.z);
    this.updateRibbon(camera);
  }

  private updateRibbon(camera: Camera): void {
    const { history, positions, fades, viewDir, segment, sideVec } = this;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      const p = history[i];
      const next = history[Math.min(i + 1, TRAIL_POINTS - 1)];
      const prev = history[Math.max(i - 1, 0)];
      segment.subVectors(prev, next);
      viewDir.subVectors(camera.position, p);
      sideVec.crossVectors(segment, viewDir);
      const len = sideVec.length();
      if (len > 1e-5) sideVec.multiplyScalar(1 / len);
      else sideVec.set(0, 0, 0);

      const k = 1 - i / (TRAIL_POINTS - 1);
      const width = BALL_RADIUS * 1.15 * k;
      const a = i * 6;
      positions[a] = p.x + sideVec.x * width;
      positions[a + 1] = p.y + sideVec.y * width;
      positions[a + 2] = p.z + sideVec.z * width;
      positions[a + 3] = p.x - sideVec.x * width;
      positions[a + 4] = p.y - sideVec.y * width;
      positions[a + 5] = p.z - sideVec.z * width;
      const fade = k * k * 0.62 * this.strength;
      fades[i * 2] = fade;
      fades[i * 2 + 1] = fade;
    }
    const geometry = this.trail.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aFade.needsUpdate = true;
  }
}
