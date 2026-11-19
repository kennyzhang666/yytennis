import type { Side } from '../sim/types';

export type FlashTone = 'win' | 'lose' | 'info';
export type PopupTone = 'perfect' | 'good' | 'miss' | 'speed' | 'power';

export class Hud {
  readonly root: HTMLDivElement;
  onPause: (() => void) | null = null;
  onReplay: (() => void) | null = null;
  onSkipReplay: (() => void) | null = null;

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
  private readonly replayBtn: HTMLButtonElement;
  private readonly vignette: HTMLElement;
  private readonly replay: HTMLElement;
  private readonly replayCall: HTMLElement;
  private readonly replayBar: HTMLElement;
  private flashTimer = 0;
  private hintText: string | null = null;
  private vignetteLevel = -1;

  constructor(parent: HTMLElement) {
    this.vignette = document.createElement('div');
    this.vignette.className = 'charge-vignette';
    parent.appendChild(this.vignette);

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
      <button class="replay-btn" type="button" hidden>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2L7 6.5 12 11V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>
        看回放
      </button>
      <div class="hint"></div>
      <div class="popups" aria-hidden="true"></div>`;
    parent.appendChild(this.root);

    this.replay = document.createElement('div');
    this.replay.className = 'replay-overlay';
    this.replay.hidden = true;
    this.replay.innerHTML = `
      <div class="replay-bar is-top"></div>
      <div class="replay-bar is-bottom"></div>
      <div class="replay-badge"><i></i>慢动作回放</div>
      <div class="replay-call"></div>
      <div class="replay-progress"><span></span></div>
      <div class="replay-skip">点击屏幕跳过</div>`;
    parent.appendChild(this.replay);

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
    this.replayBtn = this.root.querySelector('.replay-btn') as HTMLButtonElement;
    this.replayCall = this.replay.querySelector('.replay-call') as HTMLElement;
    this.replayBar = this.replay.querySelector('.replay-progress span') as HTMLElement;
    this.root.querySelector('.pause-btn')?.addEventListener('click', () => this.onPause?.());
    this.replayBtn.addEventListener('click', () => this.onReplay?.());
    this.replay.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this.onSkipReplay?.();
    });
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

  setReplayButton(visible: boolean): void {
    this.replayBtn.hidden = !visible;
  }

  /** Warms the screen edges as the player's shot charges. */
  setChargeLevel(level: number): void {
    const rounded = Math.round(level * 40) / 40;
    if (rounded === this.vignetteLevel) return;
    this.vignetteLevel = rounded;
    this.vignette.style.opacity = String(rounded * 0.9);
    this.vignette.classList.toggle('is-full', rounded >= 1);
  }

  showReplay(call: string | null): void {
    this.replay.hidden = false;
    this.replayCall.textContent = call ?? '';
    this.replayCall.hidden = !call;
    this.replayBar.style.transform = 'scaleX(0)';
    void this.replay.offsetWidth;
    this.replay.classList.add('is-on');
  }

  setReplayProgress(k: number): void {
    this.replayBar.style.transform = `scaleX(${k.toFixed(3)})`;
  }

  hideReplay(): void {
    this.replay.classList.remove('is-on');
    this.replay.hidden = true;
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
    this.setReplayButton(false);
    this.setChargeLevel(0);
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
