import type { Side } from '../sim/types';

export type FlashTone = 'win' | 'lose' | 'info';
export type PopupTone = 'perfect' | 'good' | 'miss' | 'speed';

export class Hud {
  readonly root: HTMLDivElement;
  onPause: (() => void) | null = null;

  private readonly points: [HTMLElement, HTMLElement];
  private readonly dots: [HTMLElement, HTMLElement];
  private readonly foeName: HTMLElement;
  private readonly tag: HTMLElement;
  private readonly rally: HTMLElement;
  private readonly flashEl: HTMLElement;
  private readonly flashMain: HTMLElement;
  private readonly flashSub: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly popups: HTMLElement;
  private flashTimer = 0;
  private hintText: string | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="scoreboard">
        <div class="score-side is-me">
          <i class="serve-dot"></i><span class="score-name">你</span><b class="score-pts">0</b>
        </div>
        <span class="score-tag">抢七</span>
        <div class="score-side is-foe">
          <b class="score-pts">0</b><span class="score-name">电脑</span><i class="serve-dot"></i>
        </div>
      </div>
      <button class="icon-btn pause-btn" type="button" aria-label="暂停">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>
      </button>
      <div class="rally-count" aria-hidden="true"></div>
      <div class="flash" role="status"><strong></strong><span></span></div>
      <div class="hint"></div>
      <div class="popups" aria-hidden="true"></div>`;
    parent.appendChild(this.root);

    const pts = this.root.querySelectorAll<HTMLElement>('.score-pts');
    const dots = this.root.querySelectorAll<HTMLElement>('.serve-dot');
    this.points = [pts[0], pts[1]];
    this.dots = [dots[0], dots[1]];
    this.foeName = this.root.querySelector('.is-foe .score-name') as HTMLElement;
    this.tag = this.root.querySelector('.score-tag') as HTMLElement;
    this.rally = this.root.querySelector('.rally-count') as HTMLElement;
    this.flashEl = this.root.querySelector('.flash') as HTMLElement;
    this.flashMain = this.flashEl.querySelector('strong') as HTMLElement;
    this.flashSub = this.flashEl.querySelector('span') as HTMLElement;
    this.hint = this.root.querySelector('.hint') as HTMLElement;
    this.popups = this.root.querySelector('.popups') as HTMLElement;
    this.root.querySelector('.pause-btn')?.addEventListener('click', () => this.onPause?.());
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  setOpponent(level: string): void {
    this.foeName.innerHTML = `电脑<small>·${level}</small>`;
  }

  setScore(points: readonly [number, number], server: Side, tag: string): void {
    for (const side of [0, 1] as const) {
      const text = String(points[side]);
      if (this.points[side].textContent !== text) {
        this.points[side].textContent = text;
        this.points[side].classList.remove('bump');
        void this.points[side].offsetWidth;
        this.points[side].classList.add('bump');
      }
      this.dots[side].classList.toggle('is-on', side === server);
    }
    this.tag.textContent = tag;
    this.tag.classList.toggle('is-hot', tag !== '抢七');
  }

  setRally(count: number): void {
    this.rally.textContent = count >= 4 ? `${count} 拍回合` : '';
  }

  setHint(text: string | null): void {
    if (text === this.hintText) return;
    this.hintText = text;
    if (text) this.hint.textContent = text;
    this.hint.classList.toggle('is-on', Boolean(text));
  }

  flash(main: string, tone: FlashTone, sub = '', duration = 1300): void {
    window.clearTimeout(this.flashTimer);
    this.flashMain.textContent = main;
    this.flashSub.textContent = sub;
    this.flashEl.dataset.tone = tone;
    this.flashEl.classList.remove('is-on');
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add('is-on');
    this.flashTimer = window.setTimeout(() => this.flashEl.classList.remove('is-on'), duration);
  }

  clearTransient(): void {
    window.clearTimeout(this.flashTimer);
    this.flashEl.classList.remove('is-on');
    this.popups.replaceChildren();
    this.setHint(null);
    this.setRally(0);
  }

  popup(text: string, x: number, y: number, tone: PopupTone): void {
    const el = document.createElement('div');
    el.className = `popup is-${tone}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.popups.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
    window.setTimeout(() => el.remove(), 1400);
  }
}
