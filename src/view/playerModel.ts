import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  NotEqualStencilFunc,
  PlaneGeometry,
  ReplaceStencilOp,
  Skeleton,
  SkinnedMesh,
  TubeGeometry,
  Uint16BufferAttribute,
  Vector2,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { clamp01 } from '../sim/math';
import { merge } from './geometry';
import { shirtPrintTexture, stringsTexture } from './textures';

export const BONE = {
  hips: 0,
  spine: 1,
  chest: 2,
  neck: 3,
  head: 4,
  clavR: 5,
  armR: 6,
  foreR: 7,
  handR: 8,
  clavL: 9,
  armL: 10,
  foreL: 11,
  handL: 12,
  thighR: 13,
  shinR: 14,
  footR: 15,
  toeR: 16,
  thighL: 17,
  shinL: 18,
  footL: 19,
  toeL: 20,
} as const;

/** Parent of each bone, and its position when the player stands with arms down. */
export const BIND: readonly { parent: number; at: readonly [number, number, number] }[] = [
  { parent: -1, at: [0, 0.96, 0] },
  { parent: BONE.hips, at: [0, 1.08, 0] },
  { parent: BONE.spine, at: [0, 1.3, 0] },
  { parent: BONE.chest, at: [0, 1.52, 0] },
  { parent: BONE.neck, at: [0, 1.61, 0] },
  { parent: BONE.chest, at: [0.05, 1.47, 0] },
  { parent: BONE.clavR, at: [0.205, 1.47, 0] },
  { parent: BONE.armR, at: [0.205, 1.17, 0] },
  { parent: BONE.foreR, at: [0.205, 0.905, 0] },
  { parent: BONE.chest, at: [-0.05, 1.47, 0] },
  { parent: BONE.clavL, at: [-0.205, 1.47, 0] },
  { parent: BONE.armL, at: [-0.205, 1.17, 0] },
  { parent: BONE.foreL, at: [-0.205, 0.905, 0] },
  { parent: BONE.hips, at: [0.095, 0.93, 0] },
  { parent: BONE.thighR, at: [0.095, 0.5, 0] },
  { parent: BONE.shinR, at: [0.095, 0.07, 0] },
  { parent: BONE.footR, at: [0.095, 0.03, -0.1] },
  { parent: BONE.hips, at: [-0.095, 0.93, 0] },
  { parent: BONE.thighL, at: [-0.095, 0.5, 0] },
  { parent: BONE.shinL, at: [-0.095, 0.07, 0] },
  { parent: BONE.footL, at: [-0.095, 0.03, -0.1] },
];

export const UPPER_ARM = 0.3;
export const FOREARM = 0.265;
export const THIGH = 0.43;
export const SHIN = 0.43;
/** Distance from the hand to the middle of the strings. */
export const RACKET_SWEET_SPOT = 0.46;

export interface PlayerLook {
  skin: number;
  hair: number;
  shirt: number;
  shirtTrim: number;
  shorts: number;
  shortsTrim: number;
  socks: number;
  sockBand: number;
  shoe: number;
  shoeAccent: number;
  sole: number;
  headwear: 'cap' | 'headband';
  headwearColor: number;
  wristband: number;
  racketFrame: number;
  racketAccent: number;
  racketGrip: number;
  print: string;
  printColor: string;
}

export const LOOK_NEAR: PlayerLook = {
  skin: 0xf0bf98,
  hair: 0x3a2a22,
  shirt: 0xff5546,
  shirtTrim: 0xffffff,
  shorts: 0xf7f5ef,
  shortsTrim: 0xff5546,
  socks: 0xffffff,
  sockBand: 0xff5546,
  shoe: 0xfafafa,
  shoeAccent: 0xff5546,
  sole: 0xd8dde3,
  headwear: 'cap',
  headwearColor: 0xffffff,
  wristband: 0xffffff,
  racketFrame: 0x18233a,
  racketAccent: 0xd9f84a,
  racketGrip: 0xf4f4f0,
  print: 'YY',
  printColor: '#ffffff',
};

export const LOOK_FAR: PlayerLook = {
  skin: 0xc98f68,
  hair: 0x1c1a20,
  shirt: 0x7a55f2,
  shirtTrim: 0xffd166,
  shorts: 0x20264a,
  shortsTrim: 0xffd166,
  socks: 0xf2f2f2,
  sockBand: 0x7a55f2,
  shoe: 0x1f2340,
  shoeAccent: 0xffd166,
  sole: 0xf2f2f2,
  headwear: 'headband',
  headwearColor: 0xffd166,
  wristband: 0xffd166,
  racketFrame: 0xf5f5f5,
  racketAccent: 0xffb703,
  racketGrip: 0x20264a,
  print: 'AI',
  printColor: '#ffd166',
};

type Skin = readonly [a: number, b: number, weight: number];
type Paint = Color | ((ring: number, angle: number) => Color);

interface Ring {
  /** Position along the tube's axis. */
  at: number;
  ra: number;
  rb: number;
  ca?: number;
  cb?: number;
  skin: Skin;
}

/** Collects lofted body parts into one mesh, so a whole player is a single draw call. */
class BodyBuilder {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];
  readonly skinIndex: number[] = [];
  readonly skinWeight: number[] = [];

  /** Rings must be listed with `at` increasing. */
  tube(rings: readonly Ring[], segments: number, paint: Paint, axis: 'y' | 'z' = 'y'): void {
    const base = this.positions.length / 3;
    rings.forEach((ring, r) => {
      for (let s = 0; s <= segments; s++) {
        const angle = (s / segments) * Math.PI * 2;
        const a = (ring.ca ?? 0) + ring.ra * Math.cos(angle);
        const b = (ring.cb ?? 0) + ring.rb * Math.sin(angle);
        if (axis === 'y') this.positions.push(a, ring.at, b);
        else this.positions.push(a, b, ring.at);
        const color = paint instanceof Color ? paint : paint(r, angle);
        this.colors.push(color.r, color.g, color.b);
        this.skinIndex.push(ring.skin[0], ring.skin[1], 0, 0);
        this.skinWeight.push(1 - ring.skin[2], ring.skin[2], 0, 0);
      }
    });
    const stride = segments + 1;
    for (let r = 0; r < rings.length - 1; r++) {
      for (let s = 0; s < segments; s++) {
        const A = base + r * stride + s;
        const B = A + 1;
        const C = A + stride;
        const D = C + 1;
        if (axis === 'y') this.indices.push(A, C, B, B, C, D);
        else this.indices.push(A, B, C, B, D, C);
      }
    }
  }

  blob(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, skin: Skin, color: Color, segments = 10, stacks = 7): void {
    const rings: Ring[] = [];
    for (let i = 0; i <= stacks; i++) {
      const phi = -Math.PI / 2 + (Math.PI * i) / stacks;
      const c = Math.max(0.001, Math.cos(phi));
      rings.push({ at: cy + ry * Math.sin(phi), ra: rx * c, rb: rz * c, ca: cx, cb: cz, skin });
    }
    this.tube(rings, segments, color);
  }

  build(): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(this.skinIndex, 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(this.skinWeight, 4));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    return geometry;
  }
}

const solid = (bone: number): Skin => [bone, bone, 0];

function spineSkin(y: number): Skin {
  if (y < 1.02) return solid(BONE.hips);
  if (y < 1.16) return [BONE.hips, BONE.spine, (y - 1.02) / 0.14];
  if (y < 1.26) return solid(BONE.spine);
  if (y < 1.38) return [BONE.spine, BONE.chest, (y - 1.26) / 0.12];
  return solid(BONE.chest);
}

function buildTorso(b: BodyBuilder, look: Colors): void {
  const shirt: [number, number, number, number][] = [
    [1.0, 0.152, 0.108, 0],
    [1.06, 0.148, 0.104, 0],
    [1.12, 0.143, 0.1, 0],
    [1.2, 0.15, 0.106, -0.003],
    [1.28, 0.166, 0.116, -0.006],
    [1.36, 0.182, 0.122, -0.006],
    [1.42, 0.192, 0.118, -0.002],
    [1.47, 0.19, 0.106, 0.002],
    [1.505, 0.15, 0.088, 0.004],
    [1.535, 0.09, 0.07, 0.006],
    [1.55, 0.06, 0.058, 0.006],
  ];
  b.tube(
    shirt.map(([y, rx, rz, cz]) => ({ at: y, ra: rx, rb: rz, cb: cz, skin: spineSkin(y) })),
    20,
    (ring, angle) => (ring > 0 && ring < 8 && Math.abs(Math.cos(angle)) > 0.965 ? look.shirtTrim : look.shirt),
  );
  // Waistband and hem details.
  b.tube(
    [
      { at: 1.0, ra: 0.155, rb: 0.111, skin: solid(BONE.hips) },
      { at: 1.018, ra: 0.155, rb: 0.111, skin: solid(BONE.hips) },
    ],
    20,
    look.shirtTrim,
  );
  b.tube(
    [
      { at: 1.515, ra: 0.074, rb: 0.068, cb: 0.004, skin: solid(BONE.chest) },
      { at: 1.555, ra: 0.062, rb: 0.06, cb: 0.004, skin: solid(BONE.chest) },
    ],
    14,
    look.shirtTrim,
  );

  const pelvis: [number, number, number][] = [
    [0.8, 0.02, 0.02],
    [0.84, 0.13, 0.095],
    [0.9, 0.158, 0.112],
    [0.97, 0.166, 0.116],
    [1.04, 0.152, 0.108],
  ];
  b.tube(
    pelvis.map(([y, rx, rz]) => ({ at: y, ra: rx, rb: rz, skin: solid(BONE.hips) })),
    18,
    look.shorts,
  );

  const neck: [number, Skin][] = [
    [1.49, solid(BONE.chest)],
    [1.53, [BONE.chest, BONE.neck, 0.5]],
    [1.57, solid(BONE.neck)],
    [1.62, [BONE.neck, BONE.head, 0.6]],
    [1.66, solid(BONE.head)],
  ];
  b.tube(
    neck.map(([y, skin], i) => ({ at: y, ra: 0.053 - i * 0.001, rb: 0.056 - i * 0.001, cb: 0.005, skin })),
    12,
    look.skin,
  );
}

function buildHead(b: BodyBuilder, look: Colors, cfg: PlayerLook): void {
  const pivot = 1.61;
  const skin = solid(BONE.head);
  const shape: [number, number, number, number][] = [
    [0.012, 0.012, 0.012, -0.03],
    [0.022, 0.036, 0.04, -0.032],
    [0.05, 0.058, 0.07, -0.018],
    [0.08, 0.07, 0.085, -0.01],
    [0.115, 0.078, 0.094, -0.004],
    [0.15, 0.08, 0.097, 0],
    [0.185, 0.075, 0.092, 0.004],
    [0.212, 0.056, 0.072, 0.006],
    [0.23, 0.026, 0.036, 0.007],
    [0.236, 0.003, 0.004, 0.007],
  ];
  b.tube(
    shape.map(([y, rx, rz, cz]) => ({ at: pivot + y, ra: rx, rb: rz, cb: cz, skin })),
    18,
    look.skin,
  );

  // Hair sits a little outside the skull and leaves the face clear.
  const hair: [number, number, number, number][] = [
    [0.09, 0.076, 0.09, 0.022],
    [0.13, 0.085, 0.097, 0.012],
    [0.17, 0.085, 0.102, 0.006],
    [0.205, 0.072, 0.09, 0.006],
    [0.232, 0.044, 0.056, 0.007],
    [0.246, 0.004, 0.005, 0.007],
  ];
  b.tube(
    hair.map(([y, rx, rz, cz]) => ({ at: pivot + y, ra: rx, rb: rz, cb: cz, skin })),
    18,
    (_r, angle) => (Math.sin(angle) < -0.72 ? look.skin : look.hair),
  );

  for (const s of [-1, 1]) {
    b.blob(s * 0.082, pivot + 0.112, 0.008, 0.01, 0.024, 0.016, skin, look.skin, 8, 5);
    b.blob(s * 0.032, pivot + 0.128, -0.087, 0.0105, 0.0072, 0.0045, skin, look.eye, 8, 4);
    b.tube(
      [
        { at: pivot + 0.143, ra: 0.014, rb: 0.004, ca: s * 0.033, cb: -0.09, skin },
        { at: pivot + 0.148, ra: 0.016, rb: 0.004, ca: s * 0.033, cb: -0.09, skin },
      ],
      6,
      look.hair,
    );
  }
  b.blob(0, pivot + 0.095, -0.098, 0.0115, 0.022, 0.016, skin, look.skin, 8, 5);
  b.blob(0, pivot + 0.056, -0.083, 0.021, 0.0042, 0.006, skin, look.mouth, 8, 4);

  if (cfg.headwear === 'cap') {
    const cap: [number, number, number, number][] = [
      [0.15, 0.088, 0.104, 0.004],
      [0.18, 0.086, 0.103, 0.004],
      [0.215, 0.07, 0.086, 0.006],
      [0.24, 0.042, 0.052, 0.007],
      [0.25, 0.004, 0.005, 0.007],
    ];
    b.tube(
      cap.map(([y, rx, rz, cz]) => ({ at: pivot + y, ra: rx, rb: rz, cb: cz, skin })),
      18,
      look.headwear,
    );
    b.blob(0, pivot + 0.153, -0.118, 0.074, 0.0065, 0.062, skin, look.headwear, 14, 4);
    b.blob(0, pivot + 0.19, -0.097, 0.018, 0.012, 0.004, skin, look.shortsTrim, 8, 4);
  } else {
    b.tube(
      [
        { at: pivot + 0.145, ra: 0.086, rb: 0.103, cb: 0.003, skin },
        { at: pivot + 0.178, ra: 0.087, rb: 0.104, cb: 0.003, skin },
      ],
      18,
      look.headwear,
    );
  }
}

function buildArm(b: BodyBuilder, look: Colors, side: 1 | -1): void {
  const right = side === 1;
  const clav = right ? BONE.clavR : BONE.clavL;
  const arm = right ? BONE.armR : BONE.armL;
  const fore = right ? BONE.foreR : BONE.foreL;
  const hand = right ? BONE.handR : BONE.handL;
  const x = side * 0.205;

  const skinAt = (y: number): Skin => {
    if (y > 1.43) return [arm, clav, clamp01((y - 1.43) / 0.07) * 0.6];
    if (y > 1.2) return solid(arm);
    if (y > 1.13) return [arm, fore, (1.2 - y) / 0.07];
    if (y > 0.93) return solid(fore);
    return [fore, hand, clamp01((0.93 - y) / 0.04)];
  };

  const limb: [number, number, number][] = [
    [0.905, 0.026, 0.024],
    [0.95, 0.03, 0.027],
    [1.04, 0.039, 0.035],
    [1.11, 0.044, 0.042],
    [1.17, 0.038, 0.04],
    [1.23, 0.042, 0.043],
    [1.32, 0.048, 0.05],
    [1.42, 0.052, 0.054],
    [1.49, 0.04, 0.042],
    [1.51, 0.004, 0.004],
  ];
  b.tube(
    limb.map(([y, rx, rz]) => ({ at: y, ra: rx, rb: rz, ca: x, skin: skinAt(y) })),
    12,
    look.skin,
  );

  const sleeve: [number, number, number][] = [
    [1.3, 0.059, 0.06],
    [1.36, 0.062, 0.064],
    [1.43, 0.067, 0.069],
    [1.485, 0.058, 0.062],
    [1.525, 0.01, 0.01],
  ];
  b.tube(
    sleeve.map(([y, rx, rz]) => ({ at: y, ra: rx, rb: rz, ca: x, skin: skinAt(y) })),
    12,
    (ring) => (ring === 0 ? look.shirtTrim : look.shirt),
  );
  b.tube(
    [
      { at: 1.3, ra: 0.0605, rb: 0.0615, ca: x, skin: solid(arm) },
      { at: 1.318, ra: 0.0605, rb: 0.0615, ca: x, skin: solid(arm) },
    ],
    12,
    look.shirtTrim,
  );

  b.tube(
    [
      { at: 0.925, ra: 0.033, rb: 0.03, ca: x, skin: solid(fore) },
      { at: 0.965, ra: 0.036, rb: 0.033, ca: x, skin: solid(fore) },
    ],
    10,
    look.wristband,
  );

  b.blob(x, 0.868, 0, 0.033, 0.047, 0.039, solid(hand), look.skin, 10, 6);
  b.blob(x - side * 0.03, 0.872, -0.018, 0.012, 0.028, 0.012, solid(hand), look.skin, 6, 4);
}

function buildLeg(b: BodyBuilder, look: Colors, side: 1 | -1): void {
  const right = side === 1;
  const thigh = right ? BONE.thighR : BONE.thighL;
  const shin = right ? BONE.shinR : BONE.shinL;
  const foot = right ? BONE.footR : BONE.footL;
  const toe = right ? BONE.toeR : BONE.toeL;
  const x = side * 0.095;

  const skinAt = (y: number): Skin => {
    if (y > 0.86) return [thigh, BONE.hips, clamp01((y - 0.86) / 0.1) * 0.7];
    if (y > 0.56) return solid(thigh);
    if (y > 0.46) return [thigh, shin, (0.56 - y) / 0.1];
    if (y > 0.12) return solid(shin);
    return [shin, foot, clamp01((0.12 - y) / 0.05)];
  };

  const limb: [number, number, number, number][] = [
    [0.075, 0.03, 0.034, 0.002],
    [0.12, 0.032, 0.036, 0.004],
    [0.2, 0.04, 0.044, 0.008],
    [0.3, 0.05, 0.058, 0.012],
    [0.38, 0.054, 0.064, 0.012],
    [0.46, 0.054, 0.058, 0.004],
    [0.51, 0.056, 0.058, -0.004],
    [0.58, 0.064, 0.068, -0.004],
    [0.7, 0.078, 0.084, -0.004],
    [0.82, 0.088, 0.094, 0],
    [0.92, 0.082, 0.088, 0],
  ];
  b.tube(
    limb.map(([y, rx, rz, cz]) => ({ at: y, ra: rx, rb: rz, ca: x, cb: cz, skin: skinAt(y) })),
    12,
    look.skin,
  );

  const shortsLeg: [number, number, number][] = [
    [0.655, 0.1, 0.104],
    [0.74, 0.098, 0.103],
    [0.84, 0.101, 0.106],
    [0.94, 0.104, 0.108],
  ];
  b.tube(
    shortsLeg.map(([y, rx, rz]) => ({ at: y, ra: rx, rb: rz, ca: x, skin: skinAt(y) })),
    14,
    (_ring, angle) => (Math.cos(angle) * side > 0.93 ? look.shortsTrim : look.shorts),
  );

  const sock: [number, number, number, number][] = [
    [0.075, 0.034, 0.038, 0.002],
    [0.12, 0.036, 0.04, 0.004],
    [0.2, 0.044, 0.048, 0.008],
    [0.27, 0.05, 0.057, 0.011],
    [0.295, 0.0515, 0.059, 0.012],
  ];
  b.tube(
    sock.map(([y, rx, rz, cz]) => ({ at: y, ra: rx, rb: rz, ca: x, cb: cz, skin: skinAt(y) })),
    12,
    (ring) => (ring === 4 ? look.sockBand : look.socks),
  );

  const skinZ = (z: number): Skin => [foot, toe, clamp01((-0.07 - z) / 0.05)];
  const upper: [number, number, number, number][] = [
    [-0.2, 0.008, 0.008, 0.026],
    [-0.188, 0.034, 0.02, 0.03],
    [-0.15, 0.048, 0.03, 0.036],
    [-0.09, 0.052, 0.04, 0.046],
    [-0.03, 0.05, 0.054, 0.062],
    [0.03, 0.046, 0.058, 0.066],
    [0.072, 0.04, 0.046, 0.058],
    [0.09, 0.006, 0.008, 0.054],
  ];
  b.tube(
    upper.map(([z, rx, ry, cy]) => ({ at: z, ra: rx, rb: ry, ca: x, cb: cy, skin: skinZ(z) })),
    12,
    (ring, angle) => (ring >= 2 && ring <= 4 && Math.cos(angle) * side > 0.6 && Math.sin(angle) > -0.1 ? look.shoeAccent : look.shoe),
    'z',
  );
  const sole: [number, number, number][] = [
    [-0.208, 0.006, 0.012],
    [-0.195, 0.038, 0.014],
    [-0.1, 0.057, 0.015],
    [0.02, 0.052, 0.015],
    [0.084, 0.044, 0.016],
    [0.098, 0.006, 0.014],
  ];
  b.tube(
    sole.map(([z, rx, cy]) => ({ at: z, ra: rx, rb: 0.015, ca: x, cb: cy, skin: skinZ(z) })),
    12,
    look.sole,
    'z',
  );
}

interface Colors {
  skin: Color;
  hair: Color;
  eye: Color;
  mouth: Color;
  shirt: Color;
  shirtTrim: Color;
  shorts: Color;
  shortsTrim: Color;
  socks: Color;
  sockBand: Color;
  shoe: Color;
  shoeAccent: Color;
  sole: Color;
  headwear: Color;
  wristband: Color;
}

function paintGeometry(geometry: BufferGeometry, color: (x: number, y: number, z: number) => Color): BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const p = g.getAttribute('position');
  const colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const c = color(p.getX(i), p.getY(i), p.getZ(i));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new BufferAttribute(colors, 3));
  return g;
}

function buildRacketGeometry(look: PlayerLook): BufferGeometry {
  const frame = new Color(look.racketFrame);
  const accent = new Color(look.racketAccent);
  const grip = new Color(look.racketGrip);
  const beam = (x0: number, y0: number, x1: number, y1: number, radius: number) => {
    const length = Math.hypot(x1 - x0, y1 - y0);
    return new CylinderGeometry(radius, radius, length, 6)
      .rotateZ(-Math.atan2(x1 - x0, y1 - y0))
      .translate((x0 + x1) / 2, (y0 + y1) / 2, 0);
  };
  const a = 0.118;
  const b = 0.158;
  const ring: Vector3[] = [];
  for (let i = 0; i < 40; i++) {
    const t = (i / 40) * Math.PI * 2;
    ring.push(new Vector3(a * Math.cos(t), -0.46 + b * Math.sin(t), 0));
  }
  const head = new TubeGeometry(new CatmullRomCurve3(ring, true), 64, 0.0095, 6, true).scale(1, 1, 1.4);
  return merge([
    paintGeometry(new CylinderGeometry(0.0175, 0.0175, 0.2, 8).translate(0, -0.045, 0), () => grip),
    paintGeometry(new CylinderGeometry(0.022, 0.0195, 0.014, 8).translate(0, 0.06, 0), () => accent),
    paintGeometry(new CylinderGeometry(0.0195, 0.018, 0.026, 8).translate(0, -0.15, 0), () => accent),
    paintGeometry(beam(-0.006, -0.16, -0.088, -0.325, 0.0085), () => frame),
    paintGeometry(beam(0.006, -0.16, 0.088, -0.325, 0.0085), () => frame),
    paintGeometry(beam(-0.078, -0.312, 0.078, -0.312, 0.0062), () => frame),
    paintGeometry(head, (x, y) => (y < -0.565 || (Math.abs(x) > 0.1 && y < -0.5) ? accent : frame)),
  ]);
}

/** Flattens any mesh onto the court along the sunlight, for a true player silhouette. */
function createShadowMaterial(): MeshBasicMaterial {
  const material = new MeshBasicMaterial({
    color: 0x061524,
    transparent: true,
    opacity: 0.36,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: NotEqualStencilFunc,
    stencilZPass: ReplaceStencilOp,
    side: DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uShadowDir = { value: new Vector2(14 / 26, -12 / 26) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uShadowDir;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
         vec4 flatPos = modelMatrix * vec4(transformed, 1.0);
         flatPos.xz += uShadowDir * max(flatPos.y, 0.0);
         flatPos.y = 0.016;
         gl_Position = projectionMatrix * viewMatrix * flatPos;`,
      );
  };
  return material;
}

export interface PlayerModel {
  group: Group;
  bones: Bone[];
  rim: { uRimColor: { value: Color }; uRimAmount: { value: number } };
}

export function buildPlayerModel(look: PlayerLook, detailed: boolean): PlayerModel {
  const colors: Colors = {
    skin: new Color(look.skin),
    hair: new Color(look.hair),
    eye: new Color(0x17120f),
    mouth: new Color(look.skin).multiplyScalar(0.62),
    shirt: new Color(look.shirt),
    shirtTrim: new Color(look.shirtTrim),
    shorts: new Color(look.shorts),
    shortsTrim: new Color(look.shortsTrim),
    socks: new Color(look.socks),
    sockBand: new Color(look.sockBand),
    shoe: new Color(look.shoe),
    shoeAccent: new Color(look.shoeAccent),
    sole: new Color(look.sole),
    headwear: new Color(look.headwearColor),
    wristband: new Color(look.wristband),
  };

  const builder = new BodyBuilder();
  buildTorso(builder, colors);
  buildHead(builder, colors, look);
  buildArm(builder, colors, 1);
  buildArm(builder, colors, -1);
  buildLeg(builder, colors, 1);
  buildLeg(builder, colors, -1);
  const geometry = builder.build();

  const bones = BIND.map(() => new Bone());
  BIND.forEach((bind, i) => {
    const parent = bind.parent >= 0 ? BIND[bind.parent].at : ([0, 0, 0] as const);
    bones[i].position.set(bind.at[0] - parent[0], bind.at[1] - parent[1], bind.at[2] - parent[2]);
    if (bind.parent >= 0) bones[bind.parent].add(bones[i]);
  });

  const rim = {
    uRimColor: { value: new Color(0xbfe4ff) },
    uRimAmount: { value: 0.26 },
  };
  const material: Material = detailed
    ? new MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0 })
    : new MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = rim.uRimColor;
    shader.uniforms.uRimAmount = rim.uRimAmount;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRimColor;\nuniform float uRimAmount;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         float rimLight = pow(1.0 - saturate(dot(normalize(vViewPosition), normal)), 2.6);
         totalEmissiveRadiance += uRimColor * rimLight * uRimAmount;`,
      );
  };

  const group = new Group();
  const mesh = new SkinnedMesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.add(bones[BONE.hips]);
  const skeleton = new Skeleton(bones);
  mesh.bind(skeleton);
  group.add(mesh);

  const shadowMaterial = createShadowMaterial();
  const shadow = new SkinnedMesh(geometry, shadowMaterial);
  shadow.frustumCulled = false;
  shadow.renderOrder = 1;
  shadow.bind(skeleton, mesh.bindMatrix);
  group.add(shadow);

  const hand = bones[BONE.handR];
  hand.add(buildRacket(look, shadowMaterial));

  const print = new Mesh(
    new PlaneGeometry(0.17, 0.128),
    new MeshBasicMaterial({ map: shirtPrintTexture(look.print, look.printColor), transparent: true, depthWrite: false }),
  );
  print.position.set(0, 0.075, 0.123);
  bones[BONE.chest].add(print);

  return { group, bones, rim };
}

function buildRacket(look: PlayerLook, shadowMaterial: Material): Object3D {
  const racket = new Group();
  const frameGeometry = buildRacketGeometry(look);
  const frame = new Mesh(frameGeometry, new MeshLambertMaterial({ vertexColors: true }));
  frame.frustumCulled = false;
  racket.add(frame);

  const stringBed = new CircleGeometry(1, 32).scale(0.112, 0.152, 1).translate(0, -0.46, 0);
  const strings = new Mesh(
    stringBed,
    new MeshBasicMaterial({ map: stringsTexture(), transparent: true, opacity: 0.86, side: DoubleSide, depthWrite: false }),
  );
  strings.frustumCulled = false;
  strings.renderOrder = 4;
  racket.add(strings);

  const shadowFrame = new Mesh(frameGeometry, shadowMaterial);
  const shadowBed = new Mesh(stringBed, shadowMaterial);
  for (const m of [shadowFrame, shadowBed]) {
    m.frustumCulled = false;
    m.renderOrder = 1;
    racket.add(m);
  }
  return racket;
}
