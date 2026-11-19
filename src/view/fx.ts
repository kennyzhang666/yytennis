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
  Sprite,
  SpriteMaterial,
  type Texture,
} from 'three';
import { clamp01 } from '../sim/math';
import type { Vec3 } from '../sim/types';
import { groundMaterial } from './markers';
import { shockwaveTexture, starTexture } from './textures';

const MAX_PARTICLES = 260;

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

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, gravity: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.col[i * 4] = this.color.r;
    this.col[i * 4 + 1] = this.color.g;
    this.col[i * 4 + 2] = this.color.b;
    this.siz[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grav[i] = gravity;
  }

  burst(x: number, y: number, z: number, o: BurstOptions): void {
    this.color.setHex(o.color);
    for (let n = 0; n < o.count; n++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = o.speed * (0.35 + Math.random() * 0.65);
      this.spawn(
        x,
        y,
        z,
        Math.cos(angle) * speed,
        o.up * (0.3 + Math.random() * 0.7),
        Math.sin(angle) * speed,
        o.size * (0.6 + Math.random() * 0.6),
        o.life * (0.6 + Math.random() * 0.4),
        o.gravity ?? 6,
      );
    }
  }

  /** Sparks that gather from around a point into it. */
  converge(x: number, y: number, z: number, count: number, radius: number, size: number, life: number, color: number): void {
    this.color.setHex(color);
    for (let n = 0; n < count; n++) {
      const a = Math.random() * Math.PI * 2;
      const b = Math.acos(2 * Math.random() - 1);
      const dx = Math.sin(b) * Math.cos(a);
      const dy = Math.cos(b);
      const dz = Math.sin(b) * Math.sin(a);
      const r = radius * (0.7 + Math.random() * 0.3);
      this.spawn(x + dx * r, y + dy * r, z + dz * r, (-dx * r) / life, (-dy * r) / life, (-dz * r) / life, size, life, 0);
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
      this.col[i * 4 + 3] = Math.max(0, this.life[i] / this.maxLife[i]) * 0.95;
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

interface FlashSprite {
  sprite: Sprite;
  age: number;
  life: number;
  size: number;
  growth: number;
}

interface ChargeAura {
  mesh: Mesh;
  material: ShaderMaterial;
  glow: Sprite;
  sparks: number;
}

const LOW_CHARGE = new Color(0xd9f84a);
const MID_CHARGE = new Color(0xffb02e);
const FULL_CHARGE = new Color(0xff5a2a);

function chargeColor(level: number, out: Color): Color {
  if (level < 0.6) return out.copy(LOW_CHARGE).lerp(MID_CHARGE, level / 0.6);
  return out.copy(MID_CHARGE).lerp(FULL_CHARGE, (level - 0.6) / 0.4);
}

function createAura(glowMap: Texture): ChargeAura {
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
    uniforms: {
      uLevel: { value: 0 },
      uTime: { value: 0 },
      uColor: { value: new Color(0xd9f84a) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uLevel;
      uniform float uTime;
      uniform vec3 uColor;
      varying vec2 vUv;
      const float PI = 3.14159265;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float a = atan(p.x, p.y);
        float fill = step(fract(a / (2.0 * PI) + 1.0), uLevel);
        float track = smoothstep(0.03, 0.0, abs(r - 0.62));
        float swirl = pow(0.5 + 0.5 * sin(a * 5.0 - uTime * 6.0 + r * 11.0), 3.0);
        swirl *= smoothstep(0.98, 0.45, r) * smoothstep(0.1, 0.42, r);
        float ready = step(0.999, uLevel) * (0.5 + 0.5 * sin(uTime * 15.0));
        float alpha = track * (0.16 + fill * 0.84) + swirl * uLevel * 0.42 + ready * smoothstep(0.86, 0.5, r) * 0.2;
        gl_FragColor = vec4(uColor * (1.0 + ready * 0.5), alpha * smoothstep(1.0, 0.92, r));
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new Mesh(new PlaneGeometry(3, 3).rotateX(-Math.PI / 2), material);
  mesh.position.y = 0.024;
  mesh.renderOrder = 3;
  mesh.visible = false;
  const glow = new Sprite(
    new SpriteMaterial({ map: glowMap, blending: AdditiveBlending, depthWrite: false, transparent: true }),
  );
  glow.renderOrder = 8;
  glow.visible = false;
  return { mesh, material, glow, sparks: 0 };
}

export class Effects {
  readonly group = new Group();
  private readonly particles = new Particles();
  private readonly pulses: Pulse[] = [];
  private readonly scuffs: Scuff[] = [];
  private readonly flashes: FlashSprite[] = [];
  private readonly shocks: FlashSprite[] = [];
  private readonly auras: [ChargeAura, ChargeAura];
  private readonly tint = new Color();
  private pulseCursor = 0;
  private scuffCursor = 0;
  private flashCursor = 0;
  private shockCursor = 0;
  private time = 0;

  constructor(blob: Texture, glowMap: Texture) {
    this.group.add(this.particles.points);
    const ring = new RingGeometry(0.72, 1, 48).rotateX(-Math.PI / 2);
    for (let i = 0; i < 7; i++) {
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

    const star = starTexture();
    const shock = shockwaveTexture();
    const sprite = (map: Texture) => {
      const s = new Sprite(
        new SpriteMaterial({ map, blending: AdditiveBlending, depthWrite: false, depthTest: false, transparent: true }),
      );
      s.visible = false;
      s.renderOrder = 9;
      this.group.add(s);
      return s;
    };
    for (let i = 0; i < 3; i++) {
      this.flashes.push({ sprite: sprite(star), age: 1, life: 1, size: 1, growth: 1 });
      this.shocks.push({ sprite: sprite(shock), age: 1, life: 1, size: 1, growth: 1 });
    }

    this.auras = [createAura(glowMap), createAura(glowMap)];
    for (const aura of this.auras) this.group.add(aura.mesh, aura.glow);
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
  scuff(x: number, z: number, vx: number, vz: number, color: number, size = 1, opacity = 0.62): void {
    const s = this.scuffs[this.scuffCursor];
    this.scuffCursor = (this.scuffCursor + 1) % this.scuffs.length;
    s.mesh.position.x = x;
    s.mesh.position.z = z;
    s.mesh.rotation.y = Math.atan2(vx, vz);
    s.mesh.scale.set(0.11 * size, 1, 0.26 * size);
    s.mesh.visible = true;
    s.material.color.setHex(color);
    s.material.opacity = opacity;
  }

  clearScuffs(): void {
    for (const s of this.scuffs) {
      s.mesh.visible = false;
      s.material.opacity = 0;
    }
  }

  private launchSprite(pool: FlashSprite[], cursor: number, x: number, y: number, z: number, size: number, growth: number, life: number, color: Color): void {
    const f = pool[cursor];
    f.sprite.position.set(x, y, z);
    f.sprite.visible = true;
    f.sprite.material.color.copy(color);
    f.age = 0;
    f.life = life;
    f.size = size;
    f.growth = growth;
  }

  /**
   * The burst of light and the shockwave when a charged shot is struck. `scale`
   * shrinks the effect for close replay cameras so it never hides the player.
   */
  powerHit(x: number, y: number, z: number, level: number, scale: number): void {
    chargeColor(level, this.tint);
    this.launchSprite(this.flashes, this.flashCursor, x, y, z, (2.2 + level * 2.4) * scale, 0.5 * scale, 0.24, this.tint);
    this.flashCursor = (this.flashCursor + 1) % this.flashes.length;
    this.launchSprite(this.shocks, this.shockCursor, x, y, z, 0.5 * scale, (4 + level * 4.5) * scale, 0.38, this.tint);
    this.shockCursor = (this.shockCursor + 1) % this.shocks.length;
    const hex = this.tint.getHex();
    this.particles.burst(x, y, z, { count: Math.round(22 + level * 30), speed: 5 + level * 6, up: 5 + level * 3, size: 0.13 * Math.sqrt(scale), life: 0.5, color: hex, gravity: 9 });
    this.particles.burst(x, y, z, { count: 12, speed: 3, up: 3, size: 0.2 * Math.sqrt(scale), life: 0.3, color: 0xfff6d0, gravity: 4 });
  }

  /** A charged ball punches a ring into the court where it lands. */
  powerBounce(x: number, z: number, vx: number, vz: number, level: number): void {
    chargeColor(level, this.tint);
    const hex = this.tint.getHex();
    this.pulse(x, z, hex, 1.4 + level * 1.5, 0.48);
    this.pulse(x, z, 0xffffff, 0.8 + level, 0.3);
    this.particles.burst(x, 0.08, z, { count: Math.round(14 + level * 24), speed: 3.6, up: 3.2, size: 0.12, life: 0.45, color: hex, gravity: 8 });
    this.scuff(x, z, vx, vz, 0x241006, 2.1, 0.5 + level * 0.3);
  }

  /** Sparks shed by a charged ball in flight. */
  ember(pos: Vec3, level: number): void {
    chargeColor(level, this.tint);
    this.particles.burst(pos.x, pos.y, pos.z, { count: 1, speed: 0.5, up: 0.6, size: 0.12, life: 0.3, color: this.tint.getHex(), gravity: 1.5 });
  }

  chargeReady(side: 0 | 1, x: number, z: number, racket: Vec3): void {
    void side;
    this.pulse(x, z, 0xfff2a0, 1.6, 0.42);
    this.particles.burst(racket.x, racket.y, racket.z, { count: 18, speed: 2.4, up: 2.6, size: 0.1, life: 0.4, color: 0xfff2a0, gravity: 3 });
  }

  /** Keeps the aura under a charging player and the glow on their racket up to date. */
  setCharge(side: 0 | 1, x: number, z: number, level: number, racket: Vec3, dt: number): void {
    const aura = this.auras[side];
    const on = level > 0.001;
    aura.mesh.visible = on;
    aura.glow.visible = on;
    if (!on) return;
    chargeColor(level, this.tint);
    aura.mesh.position.x = x;
    aura.mesh.position.z = z;
    const u = aura.material.uniforms;
    u.uLevel.value = level;
    u.uTime.value = this.time;
    (u.uColor.value as Color).copy(this.tint);

    const full = level >= 1;
    const flicker = 1 + Math.sin(this.time * 31) * 0.08 + (full ? Math.sin(this.time * 13) * 0.14 : 0);
    aura.glow.position.set(racket.x, racket.y, racket.z);
    aura.glow.scale.setScalar((0.35 + level * 1.15) * flicker);
    aura.glow.material.color.copy(this.tint);
    aura.glow.material.opacity = 0.45 + level * 0.55;

    aura.sparks += dt * (10 + level * 46);
    const hex = this.tint.getHex();
    while (aura.sparks >= 1) {
      aura.sparks -= 1;
      this.particles.converge(racket.x, racket.y, racket.z, 1, 0.65 + level * 0.65, 0.08 + level * 0.05, 0.26, hex);
    }
  }

  update(dt: number): void {
    this.time += dt;
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
    const stepSprites = (pool: FlashSprite[]) => {
      for (const f of pool) {
        if (!f.sprite.visible) continue;
        f.age += dt;
        const k = clamp01(f.age / f.life);
        if (k >= 1) {
          f.sprite.visible = false;
          continue;
        }
        f.sprite.scale.setScalar(f.size + f.growth * (1 - (1 - k) * (1 - k)));
        f.sprite.material.opacity = (1 - k) * (1 - k);
      }
    };
    stepSprites(this.flashes);
    stepSprites(this.shocks);
  }
}
