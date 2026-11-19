import type { InputMode } from '../input/InputManager';
import type { Difficulty } from '../sim/ai';

export const DIFFICULTY_NAMES: Record<Difficulty, string> = {
  easy: '轻松',
  normal: '标准',
  hard: '高手',
};

export interface MatchSummary {
  won: boolean;
  points: readonly [number, number];
  difficulty: Difficulty;
  rows: { label: string; me: string; foe: string }[];
}

export interface MenuHandlers {
  onStart(difficulty: Difficulty): void;
  onResume(): void;
  onRestart(): void;
  onHome(): void;
  onToggleSound(): boolean;
  onClick(): void;
}

const CONTROLS: Record<InputMode, [string, string][]> = {
  mouse: [
    ['WASD', '移动'],
    ['空格', '跳跃'],
    ['鼠标', '选落点'],
    ['左键', '击球 / 发球'],
    ['右键', '放高球'],
  ],
  touch: [
    ['左摇杆', '移动'],
    ['右侧轻点', '击球'],
    ['右侧滑动', '选方向'],
    ['右侧下滑', '高球'],
    ['箭头', '跳跃'],
  ],
};

function readDifficulty(): Difficulty {
  try {
    const saved = localStorage.getItem('yy.difficulty');
    if (saved === 'easy' || saved === 'normal' || saved === 'hard') return saved;
  } catch {
    // Private browsing can block storage. The default is fine.
  }
  return 'normal';
}

export class Menus {
  readonly root: HTMLDivElement;
  private difficulty: Difficulty = readDifficulty();
  private mode: InputMode = 'mouse';
  private readonly home: HTMLElement;
  private readonly pause: HTMLElement;
  private readonly result: HTMLElement;
  private readonly controls: HTMLElement;
  private readonly soundBtn: HTMLButtonElement;

  constructor(
    parent: HTMLElement,
    private readonly handlers: MenuHandlers,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'menus';
    this.root.innerHTML = `
      <section class="screen screen-home">
        <div class="panel home-panel">
          <div class="brand">
            <span class="brand-ball" aria-hidden="true"></span>
            <h1>YY TENNIS</h1>
          </div>
          <p class="tagline">三分钟一局的 3D 网球</p>
          <div class="field">
            <span class="field-label">对手水平</span>
            <div class="segmented" role="radiogroup" aria-label="对手水平">
              ${(Object.keys(DIFFICULTY_NAMES) as Difficulty[])
                .map(
                  (d) =>
                    `<button type="button" role="radio" data-difficulty="${d}">${DIFFICULTY_NAMES[d]}</button>`,
                )
                .join('')}
            </div>
          </div>
          <button class="btn btn-primary" type="button" data-action="start">开始比赛</button>
          <dl class="controls"></dl>
        </div>
      </section>
      <section class="screen screen-center screen-pause" hidden>
        <div class="panel small-panel">
          <h2>已暂停</h2>
          <button class="btn btn-primary" type="button" data-action="resume">继续比赛</button>
          <button class="btn" type="button" data-action="restart">重新开始</button>
          <button class="btn" type="button" data-action="sound"></button>
          <button class="btn btn-quiet" type="button" data-action="home">回到主菜单</button>
        </div>
      </section>
      <section class="screen screen-center screen-result" hidden>
        <div class="panel small-panel result-panel"></div>
      </section>`;
    parent.appendChild(this.root);

    this.home = this.root.querySelector('.screen-home') as HTMLElement;
    this.pause = this.root.querySelector('.screen-pause') as HTMLElement;
    this.result = this.root.querySelector('.screen-result') as HTMLElement;
    this.controls = this.root.querySelector('.controls') as HTMLElement;
    this.soundBtn = this.root.querySelector('[data-action="sound"]') as HTMLButtonElement;
    this.root.addEventListener('click', this.onClick);
    this.renderDifficulty();
    this.renderControls();
  }

  private readonly onClick = (e: MouseEvent): void => {
    const target = (e.target as HTMLElement).closest('button');
    if (!target) return;
    this.handlers.onClick();
    target.blur();
    const picked = target.dataset.difficulty as Difficulty | undefined;
    if (picked) {
      this.difficulty = picked;
      try {
        localStorage.setItem('yy.difficulty', picked);
      } catch {
        // The choice still applies to this session.
      }
      this.renderDifficulty();
      return;
    }
    switch (target.dataset.action) {
      case 'start':
        this.handlers.onStart(this.difficulty);
        break;
      case 'resume':
        this.handlers.onResume();
        break;
      case 'restart':
        this.handlers.onRestart();
        break;
      case 'home':
        this.handlers.onHome();
        break;
      case 'sound':
        this.setSoundLabel(this.handlers.onToggleSound());
        break;
      default:
        break;
    }
  };

  private renderDifficulty(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((b) => {
      const on = b.dataset.difficulty === this.difficulty;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }

  private renderControls(): void {
    this.controls.innerHTML = CONTROLS[this.mode]
      .map(([key, action]) => `<div><dt>${key}</dt><dd>${action}</dd></div>`)
      .join('');
  }

  private setSoundLabel(muted: boolean): void {
    this.soundBtn.textContent = muted ? '声音：关' : '声音：开';
    this.soundBtn.setAttribute('aria-pressed', String(!muted));
  }

  setInputMode(mode: InputMode): void {
    this.mode = mode;
    this.renderControls();
  }

  hide(): void {
    this.home.hidden = true;
    this.pause.hidden = true;
    this.result.hidden = true;
    this.root.classList.remove('is-open');
  }

  showHome(): void {
    this.hide();
    this.home.hidden = false;
    this.root.classList.add('is-open');
  }

  showPause(muted: boolean): void {
    this.hide();
    this.setSoundLabel(muted);
    this.pause.hidden = false;
    this.root.classList.add('is-open');
  }

  showResult(summary: MatchSummary): void {
    this.hide();
    const panel = this.result.querySelector('.result-panel') as HTMLElement;
    const rows = summary.rows
      .map((r) => `<tr><td>${r.me}</td><th scope="row">${r.label}</th><td>${r.foe}</td></tr>`)
      .join('');
    panel.innerHTML = `
      <p class="result-kicker">${DIFFICULTY_NAMES[summary.difficulty]}难度</p>
      <h2 class="${summary.won ? 'is-win' : ''}">${summary.won ? '你赢了！' : '差一点'}</h2>
      <div class="final-score">
        <b>${summary.points[0]}</b><i>:</i><b>${summary.points[1]}</b>
      </div>
      <table class="stats">
        <thead><tr><th scope="col">你</th><th scope="col"></th><th scope="col">电脑</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <button class="btn btn-primary" type="button" data-action="restart">再来一局</button>
      <button class="btn btn-quiet" type="button" data-action="home">回到主菜单</button>`;
    this.result.hidden = false;
    this.root.classList.add('is-open');
  }
}
