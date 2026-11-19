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
  Sprite,
  SpriteMaterial,
  Vector3,
  type Camera,
  type Texture,
} from 'three';
import { BALL_RADIUS } from '../sim/constants';
import type { BallFrame } from '../sim/frame';
import { clamp01, lerp, smoothstep } from '../sim/math';
import type { GroundBlob } from './markers';
import { ballTexture } from './textures';

const TRAIL_POINTS = 18;
const NORMAL_HEAD = new Color(0xe9ff7a);
const NORMAL_TAIL = new Color(0xc8ff9a);
const POWER_HEAD = new Color(0xfff2a8);
const POWER_TAIL = new Color(0xff4a1c);

export class BallView {
  readonly group = new Group();
  private readonly mesh: Mesh;
  private readonly glow: Sprite;
  private readonly shadow: GroundBlob;
  private readonly trail: Mesh;
  private readonly trailMaterial: ShaderMaterial;
  private readonly positions = new Float32Array(TRAIL_POINTS * 2 * 3);
  private readonly fades = new Float32Array(TRAIL_POINTS * 2);
  private readonly along = new Float32Array(TRAIL_POINTS * 2);
  private readonly history: Vector3[] = [];
  private readonly axis = new Vector3();
  private readonly spinStep = new Quaternion();
  private readonly viewDir = new Vector3();
  private readonly segment = new Vector3();
  private readonly sideVec = new Vector3();
  private readonly accent = new Color(0xe9ff7a);
  private strength = 0;
  private power = 0;
  private time = 0;

  constructor(blob: GroundBlob, glowMap: Texture) {
    this.shadow = blob;
    this.mesh = new Mesh(
      new SphereGeometry(BALL_RADIUS, 18, 12),
      new MeshLambertMaterial({ map: ballTexture(), emissive: 0x59660c, emissiveIntensity: 0.9 }),
    );
    this.glow = new Sprite(
      new SpriteMaterial({ map: glowMap, blending: AdditiveBlending, depthWrite: false, transparent: true, color: 0xffa040 }),
    );
    this.glow.visible = false;
    this.glow.renderOrder = 7;
    for (let i = 0; i < TRAIL_POINTS; i++) {
      this.history.push(new Vector3());
      this.along[i * 2] = i / (TRAIL_POINTS - 1);
      this.along[i * 2 + 1] = i / (TRAIL_POINTS - 1);
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
    geometry.setAttribute('aFade', new BufferAttribute(this.fades, 1).setUsage(DynamicDrawUsage));
    geometry.setAttribute('aAlong', new BufferAttribute(this.along, 1));
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
      uniforms: { uHead: { value: new Color(NORMAL_HEAD) }, uTail: { value: new Color(NORMAL_TAIL) } },
      vertexShader: `
        attribute float aFade;
        attribute float aAlong;
        varying float vFade;
        varying float vAlong;
        void main() {
          vFade = aFade;
          vAlong = aAlong;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uHead;
        uniform vec3 uTail;
        varying float vFade;
        varying float vAlong;
        void main() {
          gl_FragColor = vec4(mix(uHead, uTail, vAlong), vFade);
          #include <colorspace_fragment>
        }`,
    });
    this.trail = new Mesh(geometry, this.trailMaterial);
    this.trail.frustumCulled = false;
    this.trail.renderOrder = 6;
    this.group.add(this.mesh, this.glow, this.trail);
  }

  setTrailColor(color: number): void {
    this.accent.setHex(color);
  }

  resetTrail(x: number, y: number, z: number): void {
    for (const p of this.history) p.set(x, y, z);
  }

  update(ball: BallFrame, camera: Camera, dt: number): void {
    const { pos, vel } = ball;
    this.time += dt;
    this.mesh.position.set(pos.x, pos.y, pos.z);

    // True to size up close, and enlarged with distance so it never shrinks to a dot.
    const distance = camera.position.distanceTo(this.mesh.position);
    const scale = lerp(0.5, 1, smoothstep(4, 15, distance)) * (1 + clamp01((distance - 16) / 34) * 0.85);
    this.mesh.scale.setScalar(scale);

    if (ball.spin !== 0 && !ball.held) {
      this.axis.set(vel.z, 0, -vel.x);
      if (this.axis.lengthSq() > 0.01) {
        this.axis.normalize();
        this.spinStep.setFromAxisAngle(this.axis, Math.sign(vel.z || 1) * ball.spin * dt * 0.5);
        this.mesh.quaternion.premultiply(this.spinStep);
      }
    }

    const height = Math.max(0, pos.y - BALL_RADIUS);
    const spread = 1 + height * 0.16;
    this.shadow.place(pos.x + height * 0.1, pos.z - height * 0.06, 0.2 * spread, 0.2 * spread, 0.5 / (1 + height * 0.3));

    const speed = Math.hypot(vel.x, vel.y, vel.z);
    const target = ball.held ? 0 : clamp01((speed - 7) / 18);
    const blend = 1 - Math.exp(-16 * dt);
    this.strength += (target - this.strength) * blend;
    this.power += ((ball.held ? 0 : ball.charge) - this.power) * blend;

    const flicker = 0.86 + 0.14 * Math.sin(this.time * 47);
    this.glow.visible = this.power > 0.04;
    if (this.glow.visible) {
      this.glow.position.copy(this.mesh.position);
      this.glow.scale.setScalar((0.55 + this.power * 1.25) * scale * flicker);
      this.glow.material.opacity = Math.min(1, this.power * 1.2);
    }

    const uniforms = this.trailMaterial.uniforms;
    const k = clamp01(this.power * 1.5);
    (uniforms.uHead.value as Color).copy(this.accent).lerp(POWER_HEAD, k);
    (uniforms.uTail.value as Color).copy(NORMAL_TAIL).lerp(POWER_TAIL, k);

    for (let i = TRAIL_POINTS - 1; i > 0; i--) this.history[i].copy(this.history[i - 1]);
    this.history[0].set(pos.x, pos.y, pos.z);
    this.updateRibbon(camera);
  }

  private updateRibbon(camera: Camera): void {
    const { history, positions, fades, viewDir, segment, sideVec } = this;
    const widthScale = 1.15 + this.power * 1.9;
    const brightness = 0.62 + this.power * 0.38;
    const strength = Math.max(this.strength, this.power);
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
      const width = BALL_RADIUS * widthScale * k;
      const a = i * 6;
      positions[a] = p.x + sideVec.x * width;
      positions[a + 1] = p.y + sideVec.y * width;
      positions[a + 2] = p.z + sideVec.z * width;
      positions[a + 3] = p.x - sideVec.x * width;
      positions[a + 4] = p.y - sideVec.y * width;
      positions[a + 5] = p.z - sideVec.z * width;
      const fade = k * k * brightness * strength;
      fades[i * 2] = fade;
      fades[i * 2 + 1] = fade;
    }
    const geometry = this.trail.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aFade.needsUpdate = true;
  }
}
