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
  const { canvas, ctx } = makeCanvas(64, 64);
  ctx.strokeStyle = 'rgba(245,245,235,0.85)';
  ctx.lineWidth = 1.4;
  for (let i = 4; i < 64; i += 7) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 64);
    ctx.moveTo(0, i);
    ctx.lineTo(64, i);
    ctx.stroke();
  }
  return new CanvasTexture(canvas);
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
