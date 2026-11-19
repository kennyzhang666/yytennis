/** Simulation runs at a fixed rate, independent of the display refresh rate. */
export const TICK = 1 / 120;
export const GRAVITY = 9.81;

/** Drawn and simulated larger than a real ball so it stays readable on phones. */
export const BALL_RADIUS = 0.075;

/** Standard court dimensions, in metres. */
export const COURT = {
  halfLength: 11.885,
  halfWidth: 4.115,
  doublesHalfWidth: 5.485,
  serviceLine: 6.4,
  netHalfSpan: 6.4,
  netCenterHeight: 0.914,
  netPostHeight: 1.07,
  lineTolerance: 0.05,
} as const;

/** The space players can run in, and where a live ball counts as gone. */
export const ARENA = {
  maxX: 8.8,
  minZ: 0.7,
  maxZ: 16.2,
  passX: 9.3,
  passZ: 17.6,
  wallX: 9.5,
  wallZ: 17.9,
  wallHeight: 1.3,
} as const;

export const BOUNCE = {
  restitution: 0.72,
  retention: 0.7,
  rollSpeed: 0.7,
  rollFriction: 2.6,
} as const;

export const PLAYER = {
  maxSpeed: 6.7,
  accel: 38,
  brake: 54,
  airAccel: 5,
  gravity: 17,
  jumpSpeed: 6.4,
  /** Half-width of the area the racket can cover. */
  reachX: 1.62,
  reachFront: 1.3,
  reachBack: 0.85,
  reachTop: 2.5,
  reachBottom: 0.05,
  /** Ideal contact happens this far in front of the player. */
  contactFront: 0.35,
} as const;

export const SWING = {
  /** The perfect press comes this long before the ball reaches the contact point. */
  lead: 0.09,
  earlyWindow: 0.22,
  perfectError: 0.02,
  zeroError: 0.23,
  followThrough: 0.34,
  rearmAfter: 0.16,
  mouseDelay: 0.012,
  touchDelay: 0.07,
  slowFor: 0.22,
  slowFactor: 0.6,
} as const;

export const SMASH = {
  standHeight: 2.15,
  airHeight: 1.85,
} as const;

export const SERVE = {
  baselineZ: 12.25,
  centerOffset: 1.35,
  minX: 0.35,
  maxX: 3.9,
  receiveZ: 12.9,
  receiveX: 2.2,
  handHeight: 1.35,
  tossApex: 2.95,
  minHitHeight: 1.75,
  cancelHeight: 1.05,
  idealAfterApex: 0.02,
  timingScale: 1.65,
} as const;

export const TIMERS = {
  pointEnd: 1.7,
  faultPause: 1.05,
  resetMax: 1.8,
} as const;

export function netHeight(x: number): number {
  const k = Math.min(1, Math.abs(x) / COURT.netHalfSpan);
  return COURT.netCenterHeight + (COURT.netPostHeight - COURT.netCenterHeight) * k * k;
}

export function hitsNet(x: number, y: number): boolean {
  return Math.abs(x) <= COURT.netHalfSpan && y - BALL_RADIUS < netHeight(x);
}
