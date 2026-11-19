import { Vector3 } from 'three';

export type StrokeName = 'fore' | 'back' | 'volleyFore' | 'volleyBack' | 'serve' | 'smash';

/** Landmarks on a stroke's 0..1 timeline. */
export const PH = {
  ready: 0,
  loaded: 0.4,
  drop: 0.5,
  contact: 0.62,
  finish: 1,
} as const;

type V = readonly [number, number, number];

interface Key {
  ph: number;
  /** Right hand position, in the player's space (+x right, -z towards the net). */
  hand: V;
  /** Direction from the hand to the racket head. */
  dir: V;
  /** Direction the strings face. */
  face: V;
  /** Left hand when it is off the racket. */
  left: V;
  /** 0..1, how much the left hand holds the racket. */
  grip: number;
  gripAt: number;
  torso: number;
  hips: number;
  pitch: number;
  roll: number;
  crouch: number;
  lift: number;
  /** Direction the right elbow points. */
  elbow: V;
}

export interface Pose {
  hand: Vector3;
  dir: Vector3;
  face: Vector3;
  left: Vector3;
  grip: number;
  gripAt: number;
  torso: number;
  hips: number;
  pitch: number;
  roll: number;
  crouch: number;
  lift: number;
  elbow: Vector3;
}

export const createPose = (): Pose => ({
  hand: new Vector3(0.13, 1.03, -0.3),
  dir: new Vector3(-0.18, 0.33, -0.93).normalize(),
  face: new Vector3(0.95, 0.1, -0.15).normalize(),
  left: new Vector3(-0.1, 1.08, -0.4),
  grip: 1,
  gripAt: 0.24,
  torso: 0,
  hips: 0,
  pitch: -0.12,
  roll: 0,
  crouch: 0.07,
  lift: 0,
  elbow: new Vector3(0.55, -0.65, 0.4).normalize(),
});

export function copyPose(out: Pose, a: Pose): void {
  out.hand.copy(a.hand);
  out.dir.copy(a.dir);
  out.face.copy(a.face);
  out.left.copy(a.left);
  out.elbow.copy(a.elbow);
  out.grip = a.grip;
  out.gripAt = a.gripAt;
  out.torso = a.torso;
  out.hips = a.hips;
  out.pitch = a.pitch;
  out.roll = a.roll;
  out.crouch = a.crouch;
  out.lift = a.lift;
}

export function mixPose(out: Pose, a: Pose, b: Pose, t: number): void {
  const m = (x: number, y: number) => x + (y - x) * t;
  out.hand.lerpVectors(a.hand, b.hand, t);
  out.dir.lerpVectors(a.dir, b.dir, t).normalize();
  out.face.lerpVectors(a.face, b.face, t).normalize();
  out.left.lerpVectors(a.left, b.left, t);
  out.elbow.lerpVectors(a.elbow, b.elbow, t).normalize();
  out.grip = m(a.grip, b.grip);
  out.gripAt = m(a.gripAt, b.gripAt);
  out.torso = m(a.torso, b.torso);
  out.hips = m(a.hips, b.hips);
  out.pitch = m(a.pitch, b.pitch);
  out.roll = m(a.roll, b.roll);
  out.crouch = m(a.crouch, b.crouch);
  out.lift = m(a.lift, b.lift);
}

const READY: Omit<Key, 'ph'> = {
  hand: [0.13, 1.03, -0.3],
  dir: [-0.18, 0.33, -0.93],
  face: [0.95, 0.1, -0.15],
  left: [-0.1, 1.08, -0.4],
  grip: 1,
  gripAt: 0.24,
  torso: 0,
  hips: 0,
  pitch: -0.12,
  roll: 0,
  crouch: 0.07,
  lift: 0,
  elbow: [0.55, -0.65, 0.4],
};

const key = (ph: number, k: Partial<Omit<Key, 'ph'>>): Key => ({ ...READY, ph, ...k });

/** Modern forehand: unit turn, racket drops into the slot, whips low to high. */
const FORE: Key[] = [
  key(0, {}),
  key(0.18, {
    hand: [0.34, 1.13, -0.12],
    dir: [0.28, 0.62, -0.73],
    face: [0.85, -0.45, 0.25],
    left: [0.02, 1.2, -0.42],
    grip: 0.35,
    torso: -0.5,
    hips: -0.25,
    roll: 0.02,
    crouch: 0.08,
    elbow: [0.75, -0.35, 0.5],
  }),
  key(0.4, {
    hand: [0.5, 1.16, 0.28],
    dir: [0.22, 0.7, 0.68],
    face: [0.92, -0.1, -0.35],
    left: [-0.12, 1.3, -0.5],
    grip: 0,
    torso: -1.15,
    hips: -0.6,
    pitch: -0.1,
    roll: 0.1,
    crouch: 0.1,
    elbow: [0.7, 0.25, 0.65],
  }),
  key(0.5, {
    hand: [0.5, 0.98, 0.1],
    dir: [0.22, -0.62, 0.75],
    face: [-0.1, -0.75, -0.65],
    left: [-0.16, 1.22, -0.42],
    grip: 0,
    torso: -0.7,
    hips: -0.2,
    roll: 0.08,
    crouch: 0.1,
    elbow: [0.7, -0.4, 0.55],
  }),
  key(0.62, {
    hand: [0.46, 1.06, -0.33],
    dir: [0.86, 0.1, -0.5],
    face: [-0.45, -0.1, -0.88],
    left: [-0.3, 1.16, -0.2],
    grip: 0,
    torso: 0.15,
    hips: 0.25,
    pitch: -0.16,
    crouch: 0.05,
    elbow: [0.55, -0.8, 0.1],
  }),
  key(0.74, {
    hand: [0.26, 1.32, -0.62],
    dir: [-0.25, 0.7, -0.66],
    face: [-0.9, 0.1, 0.35],
    left: [-0.34, 1.12, -0.08],
    grip: 0,
    torso: 0.7,
    hips: 0.45,
    roll: -0.05,
    crouch: 0.04,
    elbow: [0.6, -0.45, -0.6],
  }),
  key(0.88, {
    hand: [-0.16, 1.46, -0.46],
    dir: [-0.72, 0.35, 0.6],
    face: [-0.3, -0.85, -0.4],
    left: [-0.36, 1.14, 0.02],
    grip: 0,
    torso: 1,
    hips: 0.55,
    pitch: -0.1,
    roll: -0.04,
    crouch: 0.05,
    elbow: [0.5, 0.2, -0.85],
  }),
  key(1, {
    hand: [-0.26, 1.4, -0.2],
    dir: [-0.3, 0.22, 0.93],
    face: [0.1, -0.96, 0.2],
    left: [-0.3, 1.18, -0.12],
    grip: 0,
    torso: 1.1,
    hips: 0.6,
    pitch: -0.08,
    crouch: 0.06,
    elbow: [0.35, 0.45, -0.8],
  }),
];

/** Two-handed backhand: both hands stay on the grip and the shoulders drive through. */
const BACK: Key[] = [
  key(0, {}),
  key(0.18, {
    hand: [-0.12, 1.14, -0.28],
    dir: [-0.35, 0.6, -0.72],
    face: [-0.85, -0.4, 0.2],
    grip: 1,
    gripAt: 0.1,
    torso: 0.55,
    hips: 0.25,
    crouch: 0.08,
    elbow: [0.35, -0.75, 0.2],
  }),
  key(0.4, {
    hand: [-0.3, 1.16, 0.04],
    dir: [-0.22, 0.72, 0.66],
    face: [-0.92, -0.1, -0.35],
    grip: 1,
    gripAt: 0.1,
    torso: 1.25,
    hips: 0.65,
    pitch: -0.1,
    roll: -0.1,
    crouch: 0.1,
    elbow: [0.1, -0.6, 0.75],
  }),
  key(0.5, {
    hand: [-0.26, 1.02, -0.04],
    dir: [-0.2, -0.6, 0.77],
    face: [0.1, -0.75, -0.65],
    grip: 1,
    gripAt: 0.1,
    torso: 0.9,
    hips: 0.35,
    roll: -0.08,
    crouch: 0.1,
    elbow: [0.15, -0.85, 0.45],
  }),
  key(0.62, {
    hand: [-0.08, 1.12, -0.38],
    dir: [-0.86, 0.1, -0.5],
    face: [0.45, -0.1, -0.88],
    grip: 1,
    gripAt: 0.1,
    torso: 0.3,
    hips: -0.1,
    pitch: -0.16,
    crouch: 0.05,
    elbow: [0.25, -0.9, -0.1],
  }),
  key(0.74, {
    hand: [0.06, 1.3, -0.46],
    dir: [0.3, 0.68, -0.66],
    face: [0.9, 0.1, 0.35],
    grip: 1,
    gripAt: 0.1,
    torso: -0.3,
    hips: -0.35,
    roll: 0.04,
    crouch: 0.04,
    elbow: [0.45, -0.7, -0.45],
  }),
  key(0.88, {
    hand: [0.26, 1.44, -0.26],
    dir: [0.72, 0.35, 0.6],
    face: [0.3, -0.85, -0.4],
    grip: 0.85,
    gripAt: 0.1,
    torso: -0.85,
    hips: -0.5,
    pitch: -0.1,
    crouch: 0.05,
    elbow: [0.7, -0.2, -0.65],
  }),
  key(1, {
    hand: [0.34, 1.38, -0.06],
    dir: [0.32, 0.22, 0.92],
    face: [-0.1, -0.96, 0.2],
    grip: 0.7,
    gripAt: 0.1,
    torso: -1.05,
    hips: -0.58,
    pitch: -0.08,
    crouch: 0.06,
    elbow: [0.8, 0.05, -0.55],
  }),
];

const VOLLEY_FORE: Key[] = [
  key(0, {}),
  key(0.4, {
    hand: [0.36, 1.26, -0.2],
    dir: [0.35, 0.78, -0.52],
    face: [0.2, -0.5, -0.85],
    left: [-0.18, 1.24, -0.42],
    grip: 0.2,
    torso: -0.45,
    hips: -0.25,
    crouch: 0.1,
    elbow: [0.75, -0.55, 0.3],
  }),
  key(0.62, {
    hand: [0.4, 1.2, -0.4],
    dir: [0.72, 0.32, -0.62],
    face: [-0.35, -0.2, -0.9],
    left: [-0.24, 1.18, -0.3],
    grip: 0,
    torso: 0.02,
    crouch: 0.07,
    elbow: [0.65, -0.75, 0.1],
  }),
  key(1, {
    hand: [0.3, 1.12, -0.52],
    dir: [0.6, 0.18, -0.78],
    face: [-0.55, -0.25, -0.8],
    left: [-0.22, 1.12, -0.3],
    grip: 0,
    torso: 0.26,
    hips: 0.14,
    crouch: 0.07,
    elbow: [0.6, -0.8, 0],
  }),
];

const VOLLEY_BACK: Key[] = [
  key(0, {}),
  key(0.4, {
    hand: [-0.12, 1.24, -0.2],
    dir: [-0.35, 0.78, -0.52],
    face: [-0.2, -0.5, -0.85],
    grip: 1,
    gripAt: 0.12,
    torso: 0.55,
    hips: 0.28,
    crouch: 0.1,
    elbow: [0.35, -0.85, 0.1],
  }),
  key(0.62, {
    hand: [-0.06, 1.2, -0.38],
    dir: [-0.72, 0.32, -0.62],
    face: [0.35, -0.2, -0.9],
    grip: 0.9,
    gripAt: 0.12,
    torso: 0.2,
    crouch: 0.07,
    elbow: [0.3, -0.9, -0.1],
  }),
  key(1, {
    hand: [0.02, 1.12, -0.48],
    dir: [-0.5, 0.18, -0.85],
    face: [0.55, -0.25, -0.8],
    grip: 0.8,
    gripAt: 0.12,
    torso: -0.04,
    hips: -0.1,
    crouch: 0.07,
    elbow: [0.35, -0.9, -0.15],
  }),
];

const OVERHEAD_COMMON: Key[] = [
  key(0.2, {
    hand: [0.4, 0.98, 0.02],
    dir: [0.22, -0.35, 0.91],
    face: [0.9, 0.3, -0.1],
    left: [-0.02, 1.5, -0.34],
    grip: 0,
    torso: -0.55,
    hips: -0.42,
    pitch: -0.02,
    crouch: 0.09,
    elbow: [0.6, -0.5, 0.6],
  }),
  key(0.4, {
    hand: [0.3, 1.56, 0.3],
    dir: [0.3, 0.72, 0.62],
    face: [0.82, -0.05, -0.55],
    left: [0.02, 1.98, -0.3],
    grip: 0,
    torso: -1.1,
    hips: -0.75,
    pitch: 0.2,
    roll: -0.16,
    crouch: 0.14,
    elbow: [0.75, 0.55, 0.35],
  }),
  key(0.52, {
    hand: [0.24, 1.72, 0.1],
    dir: [0.15, -0.85, 0.5],
    face: [0.95, 0.2, -0.2],
    left: [-0.05, 1.56, -0.3],
    grip: 0,
    torso: -0.6,
    hips: -0.35,
    pitch: 0.06,
    roll: -0.05,
    crouch: 0.05,
    lift: 0.05,
    elbow: [0.65, 0.72, 0.25],
  }),
  key(0.62, {
    hand: [0.2, 2.02, -0.2],
    dir: [0.06, 0.9, -0.43],
    face: [0.02, 0.43, -0.9],
    left: [-0.18, 1.3, -0.22],
    grip: 0,
    torso: 0,
    hips: 0.1,
    pitch: -0.04,
    crouch: 0,
    lift: 0.12,
    elbow: [0.7, 0.2, 0.68],
  }),
  key(0.74, {
    hand: [0.08, 1.62, -0.46],
    dir: [-0.2, -0.2, -0.96],
    face: [-0.75, -0.65, 0.1],
    left: [-0.26, 1.1, -0.06],
    grip: 0,
    torso: 0.5,
    hips: 0.3,
    pitch: -0.35,
    crouch: 0.03,
    lift: 0.05,
    elbow: [0.6, 0.1, -0.8],
  }),
  key(0.88, {
    hand: [-0.22, 1.12, -0.42],
    dir: [-0.5, -0.78, 0.35],
    face: [-0.55, 0.55, 0.6],
    left: [-0.3, 1.14, 0.08],
    grip: 0,
    torso: 0.85,
    hips: 0.5,
    pitch: -0.3,
    crouch: 0.08,
    elbow: [0.45, 0.3, -0.85],
  }),
  key(1, {
    hand: [-0.32, 0.98, -0.18],
    dir: [-0.3, -0.75, 0.58],
    face: [-0.4, 0.65, 0.65],
    left: [-0.32, 1.12, 0.02],
    grip: 0,
    torso: 1,
    hips: 0.55,
    pitch: -0.2,
    crouch: 0.1,
    elbow: [0.3, 0.2, -0.93],
  }),
];

/** Toss, trophy position, racket drop, full extension, pronation and landing. */
const SERVE: Key[] = [
  key(0, {
    hand: [0.22, 1.06, -0.24],
    dir: [-0.1, 0.45, -0.89],
    face: [0.95, 0.1, -0.1],
    left: [-0.27, 1.02, -0.34],
    grip: 0,
    torso: -0.25,
    hips: -0.25,
    pitch: -0.05,
    crouch: 0.05,
  }),
  ...OVERHEAD_COMMON,
];

const SMASH: Key[] = [key(0, {}), ...OVERHEAD_COMMON];

export const STROKES: Record<StrokeName, Key[]> = {
  fore: FORE,
  back: BACK,
  volleyFore: VOLLEY_FORE,
  volleyBack: VOLLEY_BACK,
  serve: SERVE,
  smash: SMASH,
};

function spline(a: number, b: number, c: number, d: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
}

function splineV(out: Vector3, a: V, b: V, c: V, d: V, t: number): Vector3 {
  return out.set(
    spline(a[0], b[0], c[0], d[0], t),
    spline(a[1], b[1], c[1], d[1], t),
    spline(a[2], b[2], c[2], d[2], t),
  );
}

/** Samples a stroke at a point on its timeline. */
export function evalStroke(name: StrokeName, ph: number, out: Pose): void {
  const keys = STROKES[name];
  const p = Math.min(1, Math.max(0, ph));
  let i = 0;
  while (i < keys.length - 2 && p > keys[i + 1].ph) i++;
  const b = keys[i];
  const c = keys[i + 1];
  const a = keys[Math.max(0, i - 1)];
  const d = keys[Math.min(keys.length - 1, i + 2)];
  const t = (p - b.ph) / (c.ph - b.ph);
  const s = (fa: number, fb: number, fc: number, fd: number) => spline(fa, fb, fc, fd, t);

  splineV(out.hand, a.hand, b.hand, c.hand, d.hand, t);
  splineV(out.dir, a.dir, b.dir, c.dir, d.dir, t).normalize();
  splineV(out.face, a.face, b.face, c.face, d.face, t).normalize();
  splineV(out.left, a.left, b.left, c.left, d.left, t);
  splineV(out.elbow, a.elbow, b.elbow, c.elbow, d.elbow, t).normalize();
  out.grip = Math.min(1, Math.max(0, s(a.grip, b.grip, c.grip, d.grip)));
  out.gripAt = b.gripAt + (c.gripAt - b.gripAt) * t;
  out.torso = s(a.torso, b.torso, c.torso, d.torso);
  out.hips = s(a.hips, b.hips, c.hips, d.hips);
  out.pitch = s(a.pitch, b.pitch, c.pitch, d.pitch);
  out.roll = s(a.roll, b.roll, c.roll, d.roll);
  out.crouch = Math.max(0, s(a.crouch, b.crouch, c.crouch, d.crouch));
  out.lift = Math.max(0, s(a.lift, b.lift, c.lift, d.lift));
}
