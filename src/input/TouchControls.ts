import { clamp } from '../sim/math';

const STICK_RADIUS = 54;
const DEAD_ZONE = 0.12;
/** Finger travel needed before a tap becomes an aimed swipe. */
const AIM_THRESHOLD = 12;

/**
 * Two-thumb layout. Left half: a floating joystick. Right half: pressing swings
 * immediately, and the finger's movement in the following moments aims the shot.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  moveX = 0;
  moveY = 0;
  aimU = 0;
  aimV = 0.72;
  aimAuto = true;
  lob = false;
  onSwing: (() => void) | null = null;
  onJump: (() => void) | null = null;
  onForeignPointer: ((event: PointerEvent) => void) | null = null;

  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly jump: HTMLButtonElement;
  private readonly swingPad: HTMLDivElement;
  private readonly swingMark: HTMLDivElement;
  private stickId = -1;
  private swingId = -1;
  private originX = 0;
  private originY = 0;
  private swingX = 0;
  private swingY = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'touch-layer';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="stick-base"><div class="stick-knob"></div></div>
      <div class="swing-pad" aria-hidden="true"><span>击球</span></div>
      <div class="swing-mark"></div>
      <button class="jump-btn" type="button" aria-label="跳跃">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l7 8h-4.5v8h-5v-8H5z"/></svg>
      </button>`;
    parent.appendChild(this.root);
    this.base = this.root.querySelector('.stick-base') as HTMLDivElement;
    this.knob = this.root.querySelector('.stick-knob') as HTMLDivElement;
    this.jump = this.root.querySelector('.jump-btn') as HTMLButtonElement;
    this.swingPad = this.root.querySelector('.swing-pad') as HTMLDivElement;
    this.swingMark = this.root.querySelector('.swing-mark') as HTMLDivElement;

    this.root.addEventListener('pointerdown', this.onDown);
    this.root.addEventListener('pointermove', this.onMove);
    this.root.addEventListener('pointerup', this.onUp);
    this.root.addEventListener('pointercancel', this.onUp);
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.jump.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.jump.classList.add('is-down');
      this.onJump?.();
    });
    const release = () => this.jump.classList.remove('is-down');
    this.jump.addEventListener('pointerup', release);
    this.jump.addEventListener('pointercancel', release);
    this.jump.addEventListener('pointerleave', release);
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    if (!visible) this.reset();
  }

  /** Accepts a touch that landed before the layer was shown. */
  acceptPointer(event: PointerEvent): void {
    this.onDown(event);
  }

  /** True while a finger rests on the swing side of the screen. */
  get swingHeld(): boolean {
    return this.swingId !== -1;
  }

  reset(): void {
    this.stickId = -1;
    this.swingId = -1;
    this.moveX = 0;
    this.moveY = 0;
    this.aimAuto = true;
    this.lob = false;
    this.base.classList.remove('is-active');
    this.base.style.removeProperty('transform');
    this.knob.style.removeProperty('transform');
    this.swingMark.classList.remove('is-active');
    this.swingPad.classList.remove('is-down');
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') {
      this.onForeignPointer?.(e);
      return;
    }
    e.preventDefault();
    this.capture(e);
    const leftSide = e.clientX < window.innerWidth / 2;
    if (leftSide && this.stickId === -1) {
      this.stickId = e.pointerId;
      this.originX = clamp(e.clientX, 70, window.innerWidth / 2 - 10);
      this.originY = clamp(e.clientY, 80, window.innerHeight - 70);
      const rect = this.base.getBoundingClientRect();
      const restX = rect.left + rect.width / 2;
      const restY = rect.top + rect.height / 2;
      this.base.style.transform = `translate(${this.originX - restX}px, ${this.originY - restY}px)`;
      this.base.classList.add('is-active');
      this.updateStick(e.clientX, e.clientY);
    } else if (!leftSide && this.swingId === -1) {
      this.swingId = e.pointerId;
      this.swingX = e.clientX;
      this.swingY = e.clientY;
      this.aimAuto = true;
      this.lob = false;
      this.swingPad.classList.add('is-down');
      this.swingMark.style.left = `${e.clientX}px`;
      this.swingMark.style.top = `${e.clientY}px`;
      this.swingMark.style.setProperty('--r', '0deg');
      this.swingMark.style.setProperty('--l', '0px');
      this.swingMark.classList.add('is-active');
      this.onSwing?.();
    }
  };

  private capture(e: PointerEvent): void {
    try {
      this.root.setPointerCapture(e.pointerId);
    } catch {
      // Capture is only a convenience: tracking still works without it.
    }
  }

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerId === this.stickId) {
      e.preventDefault();
      this.updateStick(e.clientX, e.clientY);
    } else if (e.pointerId === this.swingId) {
      e.preventDefault();
      this.updateSwipe(e.clientX, e.clientY);
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.stickId) {
      this.stickId = -1;
      this.moveX = 0;
      this.moveY = 0;
      this.base.classList.remove('is-active');
      this.base.style.removeProperty('transform');
      this.knob.style.removeProperty('transform');
    } else if (e.pointerId === this.swingId) {
      this.swingId = -1;
      this.aimAuto = true;
      this.swingPad.classList.remove('is-down');
      this.swingMark.classList.remove('is-active');
    }
  };

  private updateStick(x: number, y: number): void {
    let dx = x - this.originX;
    let dy = y - this.originY;
    const d = Math.hypot(dx, dy);
    if (d > STICK_RADIUS) {
      dx = (dx / d) * STICK_RADIUS;
      dy = (dy / d) * STICK_RADIUS;
    }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const nx = dx / STICK_RADIUS;
    const ny = dy / STICK_RADIUS;
    const m = Math.hypot(nx, ny);
    if (m < DEAD_ZONE) {
      this.moveX = 0;
      this.moveY = 0;
      return;
    }
    // Remap so that movement ramps up from zero just outside the dead zone.
    const scaled = Math.min(1, (m - DEAD_ZONE) / (0.82 - DEAD_ZONE));
    this.moveX = (nx / m) * scaled;
    this.moveY = (ny / m) * scaled;
  }

  private updateSwipe(x: number, y: number): void {
    const dx = x - this.swingX;
    const dy = y - this.swingY;
    const distance = Math.hypot(dx, dy);
    this.swingMark.style.setProperty('--r', `${Math.atan2(dx, -dy)}rad`);
    this.swingMark.style.setProperty('--l', `${Math.min(70, distance)}px`);
    if (distance < AIM_THRESHOLD) return;
    this.lob = dy > 16 && dy > Math.abs(dx) * 0.8;
    this.aimAuto = false;
    this.aimU = clamp(dx / 62, -1, 1);
    // A quick flick covers more ground before contact, so it sends the ball deeper.
    this.aimV = this.lob ? 0.82 : clamp(0.4 + -dy / 95, 0.1, 1);
  }
}
