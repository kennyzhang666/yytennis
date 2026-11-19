import { clamp } from '../sim/math';
import { emptyIntent, type PlayerIntent } from '../sim/types';
import { TouchControls } from './TouchControls';

export type InputMode = 'mouse' | 'touch';

const MOVE_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

/** Turns keyboard, mouse and touch into the one intent the simulation understands. */
export class InputManager {
  mode: InputMode;
  enabled = false;
  onModeChange: ((mode: InputMode) => void) | null = null;
  onPauseKey: (() => void) | null = null;

  readonly touch: TouchControls;
  private readonly intent = emptyIntent();
  private readonly keys = new Set<string>();
  private swingQueued = false;
  private jumpQueued = false;
  private rightClickLob = false;
  private aimU = 0;
  private aimV = 0.72;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
  ) {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    this.mode = coarse ? 'touch' : 'mouse';
    this.touch = new TouchControls(uiRoot);
    this.touch.onSwing = () => this.queueSwing();
    this.touch.onJump = () => {
      if (this.enabled) this.jumpQueued = true;
    };
    this.touch.onForeignPointer = (e) => {
      this.setMode('mouse');
      this.onMouseDown(e);
    };

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.clearHeld);
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    canvas.addEventListener('pointerdown', this.onCanvasDown);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.clearHeld();
    this.touch.setVisible(enabled && this.mode === 'touch');
    this.canvas.classList.toggle('is-playing', enabled && this.mode === 'mouse');
  }

  private setMode(mode: InputMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.touch.setVisible(this.enabled && mode === 'touch');
    this.canvas.classList.toggle('is-playing', this.enabled && mode === 'mouse');
    this.onModeChange?.(mode);
  }

  private queueSwing(): void {
    if (this.enabled) this.swingQueued = true;
  }

  private readonly clearHeld = (): void => {
    this.keys.clear();
    this.swingQueued = false;
    this.jumpQueued = false;
    this.touch.reset();
  };

  // KeyboardEvent.code is the physical key, so WASD keeps working while a
  // Chinese input method is active or on non-QWERTY layouts.
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (!e.repeat) this.onPauseKey?.();
      return;
    }
    if (!this.enabled) return;
    if (e.code === 'Space' || MOVE_KEYS.has(e.code)) {
      e.preventDefault();
      this.setMode('mouse');
    }
    if (e.code === 'Space' && !e.repeat) this.jumpQueued = true;
    this.keys.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = 1 - (e.clientY / window.innerHeight) * 2;
    // The whole window acts as an aiming pad for the opponent's court.
    this.aimU = clamp(nx * 1.25, -1, 1);
    this.aimV = clamp((ny + 0.72) / 1.44, 0, 1);
  };

  private readonly onCanvasDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') {
      this.onMouseDown(e);
    } else if (this.enabled) {
      this.setMode('touch');
      this.touch.acceptPointer(e);
    }
  };

  private onMouseDown(e: PointerEvent): void {
    if (!this.enabled || (e.button !== 0 && e.button !== 2)) return;
    e.preventDefault();
    this.setMode('mouse');
    this.rightClickLob = e.button === 2;
    this.queueSwing();
  }

  /** Reads the current input. Button presses are delivered exactly once. */
  sample(): PlayerIntent {
    const i = this.intent;
    i.swing = this.swingQueued;
    i.jump = this.jumpQueued;
    this.swingQueued = false;
    this.jumpQueued = false;

    if (!this.enabled) {
      i.moveX = 0;
      i.moveZ = 0;
      return i;
    }

    if (this.mode === 'touch') {
      const t = this.touch;
      i.moveX = t.moveX;
      i.moveZ = t.moveY;
      i.aimU = t.aimU;
      i.aimV = t.aimV;
      i.aimAuto = t.aimAuto;
      i.lob = t.lob;
      return i;
    }

    const k = this.keys;
    i.moveX =
      (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    i.moveZ = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    i.aimU = this.aimU;
    i.aimV = this.aimV;
    i.aimAuto = false;
    i.lob = this.rightClickLob || k.has('ShiftLeft') || k.has('ShiftRight');
    return i;
  }
}
