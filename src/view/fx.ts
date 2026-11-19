import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  RingGeometry,
  ShaderMaterial,
  type Texture,
} from 'three';
import { groundMaterial } from './markers';

const MAX_PARTICLES = 160;

export interface BurstOptions {
  count: number;
  speed: number;
  up: number;
  size: number;
  life: number;
  color: number;
  gravity?: number;
}

class Particles {
  readonly points: Points;
  private readonly pos = new Float32Array(MAX_PARTICLES * 3);
  private readonly col = new Float32Array(MAX_PARTICLES * 4);
  private readonly siz = new Float32Array(MAX_PARTICLES);
  private readonly vel = new Float32Array(MAX_PARTICLES * 3);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly grav = new Float32Array(MAX_PARTICLES);
  private cursor = 0;
  private readonly color = new Color();

  constructor() {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage));
    geometry.setAttribute('aColor', new BufferAttribute(this.col, 4).setUsage(DynamicDrawUsage));
    geometry.setAttribute('aSize', new BufferAttribute(this.siz, 1).setUsage(DynamicDrawUsage));
    const material = new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uScale: { value: 600 } },
      vertexShader: `
        attribute vec4 aColor;
        attribute float aSize;
        uniform float uScale;
        varying vec4 vColor;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec4 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.12, d) * vColor.a;
          if (a <= 0.002) discard;
          gl_FragColor = vec4(vColor.rgb, a);
          #include <colorspace_fragment>
        }`,
    });
    this.points = new Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
  }

  setScale(height: number, fovRadians: number): void {
    (this.points.material as ShaderMaterial).uniforms.uScale.value = height / (2 * Math.tan(fovRadians / 2));
  }

  burst(x: number, y: number, z: number, o: BurstOptions): void {
    this.color.setHex(o.color);
    for (let n = 0; n < o.count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      const angle = Math.random() * Math.PI * 2;
      const speed = o.speed * (0.35 + Math.random() * 0.65);
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = Math.cos(angle) * speed;
      this.vel[i * 3 + 1] = o.up * (0.3 + Math.random() * 0.7);
      this.vel[i * 3 + 2] = Math.sin(angle) * speed;
      this.col[i * 4] = this.color.r;
      this.col[i * 4 + 1] = this.color.g;
      this.col[i * 4 + 2] = this.color.b;
      this.siz[i] = o.size * (0.6 + Math.random() * 0.6);
      const life = o.life * (0.6 + Math.random() * 0.4);
      this.life[i] = life;
      this.maxLife[i] = life;
      this.grav[i] = o.gravity ?? 6;
    }
  }

  update(dt: number): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) {
        this.col[i * 4 + 3] = 0;
        continue;
      }
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] = Math.max(0.02, this.pos[i * 3 + 1] + this.vel[i * 3 + 1] * dt);
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.col[i * 4 + 3] = Math.max(0, this.life[i] / this.maxLife[i]) * 0.9;
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = true;
    a.aColor.needsUpdate = true;
    a.aSize.needsUpdate = true;
  }
}

interface Pulse {
  mesh: Mesh;
  material: MeshBasicMaterial;
  age: number;
  life: number;
  grow: number;
}

interface Scuff {
  mesh: Mesh;
  material: MeshBasicMaterial;
}

export class Effects {
  readonly group = new Group();
  private readonly particles = new Particles();
  private readonly pulses: Pulse[] = [];
  private readonly scuffs: Scuff[] = [];
  private pulseCursor = 0;
  private scuffCursor = 0;

  constructor(blob: Texture) {
    this.group.add(this.particles.points);
    const ring = new RingGeometry(0.72, 1, 40).rotateX(-Math.PI / 2);
    for (let i = 0; i < 5; i++) {
      const material = groundMaterial(0xffffff, 0);
      const mesh = new Mesh(ring, material);
      mesh.position.y = 0.02;
      mesh.visible = false;
      mesh.renderOrder = 2;
      this.pulses.push({ mesh, material, age: 1, life: 1, grow: 1 });
      this.group.add(mesh);
    }
    const plane = new PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    for (let i = 0; i < 7; i++) {
      const material = groundMaterial(0xffffff, 0, blob);
      const mesh = new Mesh(plane, material);
      mesh.position.y = 0.01;
      mesh.visible = false;
      mesh.renderOrder = 1;
      this.scuffs.push({ mesh, material });
      this.group.add(mesh);
    }
  }

  setPointScale(height: number, fovRadians: number): void {
    this.particles.setScale(height, fovRadians);
  }

  burst(x: number, y: number, z: number, options: BurstOptions): void {
    this.particles.burst(x, y, z, options);
  }

  pulse(x: number, z: number, color: number, size: number, life: number): void {
    const p = this.pulses[this.pulseCursor];
    this.pulseCursor = (this.pulseCursor + 1) % this.pulses.length;
    p.mesh.position.x = x;
    p.mesh.position.z = z;
    p.mesh.visible = true;
    p.material.color.setHex(color);
    p.age = 0;
    p.life = life;
    p.grow = size;
  }

  /** Leaves a mark on the court so players can see where a ball landed. */
  scuff(x: number, z: number, vx: number, vz: number, color: number): void {
    const s = this.scuffs[this.scuffCursor];
    this.scuffCursor = (this.scuffCursor + 1) % this.scuffs.length;
    s.mesh.position.x = x;
    s.mesh.position.z = z;
    s.mesh.rotation.y = Math.atan2(vx, vz);
    s.mesh.scale.set(0.11, 1, 0.26);
    s.mesh.visible = true;
    s.material.color.setHex(color);
    s.material.opacity = 0.62;
  }

  clearScuffs(): void {
    for (const s of this.scuffs) {
      s.mesh.visible = false;
      s.material.opacity = 0;
    }
  }

  update(dt: number): void {
    this.particles.update(dt);
    for (const p of this.pulses) {
      if (!p.mesh.visible) continue;
      p.age += dt;
      const k = p.age / p.life;
      if (k >= 1) {
        p.mesh.visible = false;
        continue;
      }
      const eased = 1 - (1 - k) * (1 - k);
      p.mesh.scale.setScalar(0.1 + eased * p.grow);
      p.material.opacity = (1 - k) * 0.85;
    }
  }
}
