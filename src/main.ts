import { Game } from './game/Game';
import './ui/styles.css';

function showFatal(message: string): void {
  const el = document.createElement('div');
  el.className = 'fatal';
  el.textContent = message;
  document.body.appendChild(el);
}

function supportsWebGL(): boolean {
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

const root = document.getElementById('app');
if (!root || !supportsWebGL()) {
  showFatal('这个浏览器不支持 WebGL2，无法运行游戏。请换用新版 Chrome、Edge 或 Safari。');
} else {
  try {
    const game = new Game(root);
    if (import.meta.env.DEV) {
      (window as unknown as { __yyTennis: Game }).__yyTennis = game;
    }
  } catch (error) {
    console.error(error);
    showFatal('游戏启动失败，请刷新页面重试。');
  }
}
