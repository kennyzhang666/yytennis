import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';

export function makeCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return { canvas, ctx };
}

export function colorTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Soft round alpha blob, used for every fake shadow. */
export function blobTexture(): CanvasTexture {
  const { canvas, ctx } = makeCanvas(128, 128);
  const gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.72)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new CanvasTexture(canvas);
}

export function netTexture(): CanvasTexture {
  const { canvas, ctx } = makeCanvas(32, 32);
  ctx.clearRect(0, 0, 32, 32);
  ctx.strokeStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, 32, 32);
  const texture = new CanvasTexture(canvas);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  return texture;
}

export function stringsTexture(): CanvasTexture {
  const { canvas, ctx } = makeCanvas(128, 128);
  ctx.strokeStyle = 'rgba(245,245,235,0.9)';
  ctx.lineWidth = 1.5;
  for (let i = 4; i < 128; i += 7) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 128);
    ctx.moveTo(0, i);
    ctx.lineTo(128, i);
    ctx.stroke();
  }
  return colorTexture(canvas);
}

/** Soft additive glow used for the racket, the ball and impact flashes. */
export function glowTexture(): CanvasTexture {
  const { canvas, ctx } = makeCanvas(128, 128);
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.22, 'rgba(255,255,255,0.72)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.16)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return colorTexture(canvas);
}

/** A four-pointed lens flare for the moment of a power hit. */
export function starTexture(): CanvasTexture {
  const { canvas, ctx } = makeCanvas(256, 256);
  ctx.translate(128, 128);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 2; i++) {
    ctx.save();
    ctx.rotate((i * Math.PI) / 2);
    const gradient = ctx.createLinearGradient(-128, 0, 128, 0);
    gradient.addColorStop(0, 'rgba(255,255,255,0)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,1)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(-128, 0);
    ctx.quadraticCurveTo(0, -9, 128, 0);
    ctx.quadraticCurveTo(0, 9, -128, 0);
    ctx.fill();
    ctx.restore();
  }
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 60);
  core.addColorStop(0, 'rgba(255,255,255,1)');
  core.addColorStop(0.3, 'rgba(255,255,255,0.45)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = core;
  ctx.fillRect(-60, -60, 120, 120);
  return colorTexture(canvas);
}

export function shockwaveTexture(): CanvasTexture {
  const { canvas, ctx } = makeCanvas(256, 256);
  const gradient = ctx.createRadialGradient(128, 128, 78, 128, 128, 127);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.72, 'rgba(255,255,255,0.3)');
  gradient.addColorStop(0.9, 'rgba(255,255,255,1)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  return colorTexture(canvas);
}

/** The small print on the back of a player's shirt. */
export function shirtPrintTexture(text: string, color: string): CanvasTexture {
  const { canvas, ctx } = makeCanvas(128, 96);
  ctx.fillStyle = color;
  ctx.font = 'italic 900 58px "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 50, 118);
  return colorTexture(canvas);
}

export function ballTexture(): CanvasTexture {
  const { canvas, ctx } = makeCanvas(128, 64);
  ctx.fillStyle = '#dcff3f';
  ctx.fillRect(0, 0, 128, 64);
  ctx.strokeStyle = '#fbffe9';
  ctx.lineWidth = 4;
  for (const offset of [0, 64]) {
    ctx.beginPath();
    for (let x = 0; x <= 128; x += 4) {
      const y = 32 + Math.sin(((x + offset) / 128) * Math.PI * 2) * 20;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return colorTexture(canvas);
}
