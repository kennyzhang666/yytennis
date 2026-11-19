export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface CourtPoint {
  x: number;
  z: number;
}

/** NEAR plays on the +z half (closest to the camera), FAR on the -z half. */
export type Side = 0 | 1;
export const NEAR: Side = 0;
export const FAR: Side = 1;

/** +1 for NEAR, -1 for FAR. The net is always towards -dir from a player. */
export const sideDir = (side: Side): 1 | -1 => (side === NEAR ? 1 : -1);
export const otherSide = (side: Side): Side => (side === NEAR ? FAR : NEAR);

/**
 * What a player wants to do this tick. Keyboard, touch and the AI all produce
 * this same structure, so the simulation never knows who is in control.
 */
export interface PlayerIntent {
  /** World-axis movement, magnitude 0..1. */
  moveX: number;
  moveZ: number;
  /** Edge-triggered: true only on the tick the button was pressed. */
  jump: boolean;
  swing: boolean;
  /** True while the swing button is down. Pressing early and holding charges a shot. */
  held: boolean;
  /** Hit a lob instead of a drive. Read at the moment of contact. */
  lob: boolean;
  /** -1 (towards -x) .. 1 (towards +x). */
  aimU: number;
  /** 0 (short) .. 1 (deep). */
  aimV: number;
  /** Let the game choose a sensible target (used by tap-to-hit). */
  aimAuto: boolean;
}

export const emptyIntent = (): PlayerIntent => ({
  moveX: 0,
  moveZ: 0,
  jump: false,
  swing: false,
  held: false,
  lob: false,
  aimU: 0,
  aimV: 0.7,
  aimAuto: false,
});
