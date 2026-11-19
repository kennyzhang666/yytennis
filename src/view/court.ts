import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
} from 'three';
import { COURT, netHeight } from '../sim/constants';
import { merge } from './geometry';
import { colorTexture, makeCanvas, netTexture } from './textures';

export const SURFACE = { halfX: 9.6, halfZ: 18 } as const;

const COLORS = {
  apron: '#17896f',
  apronDark: '#127a62',
  alley: '#1c5f9e',
  court: '#2474c4',
  line: '#f8fbff',
};

function paintSurface(pixelsPerMeter: number): HTMLCanvasElement {
  const ppm = pixelsPerMeter;
  const width = Math.round(SURFACE.halfX * 2 * ppm);
  const height = Math.round(SURFACE.halfZ * 2 * ppm);
  const { canvas, ctx } = makeCanvas(width, height);
  const X = (x: number) => (x + SURFACE.halfX) * ppm;
  const Z = (z: number) => (z + SURFACE.halfZ) * ppm;
  const rect = (x0: number, z0: number, x1: number, z1: number) =>
    ctx.fillRect(X(x0), Z(z0), (x1 - x0) * ppm, (z1 - z0) * ppm);

  const { halfLength: L, halfWidth: W, doublesHalfWidth: D, serviceLine: S } = COURT;

  ctx.fillStyle = COLORS.apron;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = COLORS.apronDark;
  for (let i = -9; i < 9; i += 2) rect(i, -SURFACE.halfZ, i + 1, SURFACE.halfZ);
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = COLORS.apron;
  ctx.fillRect(0, 0, width, height);
  ctx.globalAlpha = 1;

  ctx.fillStyle = COLORS.alley;
  rect(-D, -L, D, L);
  ctx.fillStyle = COLORS.court;
  rect(-W, -L, W, L);

  // Fine grain keeps large flat areas from looking like plastic.
  const speckles = Math.round((width * height) / 90);
  for (let i = 0; i < speckles; i++) {
    const light = Math.random() < 0.5;
    ctx.fillStyle = light ? 'rgba(255,255,255,0.035)' : 'rgba(0,20,40,0.05)';
    ctx.fillRect(Math.random() * width, Math.random() * height, 1.5, 1.5);
  }

  // Worn patches where players spend the most time.
  for (const sign of [-1, 1]) {
    const cz = Z(sign * (L - 0.6));
    const gradient = ctx.createRadialGradient(X(0), cz, 0, X(0), cz, 3.6 * ppm);
    gradient.addColorStop(0, 'rgba(255,255,255,0.1)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.save();
    ctx.beginPath();
    ctx.rect(X(-W), Z(-L), (W * 2) * ppm, (L * 2) * ppm);
    ctx.clip();
    ctx.fillRect(X(-6), cz - 4 * ppm, 12 * ppm, 8 * ppm);
    ctx.restore();
  }

  ctx.fillStyle = COLORS.line;
  const thin = 0.055;
  const thick = 0.1;
  rect(-D - thin, -L - thick, -D + thin, L + thick);
  rect(D - thin, -L - thick, D + thin, L + thick);
  rect(-W - thin, -L - thick, -W + thin, L + thick);
  rect(W - thin, -L - thick, W + thin, L + thick);
  rect(-D, -L - thick, D, -L + thick);
  rect(-D, L - thick, D, L + thick);
  rect(-W, -S - thin, W, -S + thin);
  rect(-W, S - thin, W, S + thin);
  rect(-thin, -S, thin, S);
  rect(-thin, -L, thin, -L + 0.3);
  rect(-thin, L - 0.3, thin, L);

  ctx.font = `italic 900 ${1.5 * ppm}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(255,255,255,0.24)';
  ctx.fillText('YY TENNIS', X(0), Z(-15));
  return canvas;
}

function buildNet(): Group {
  const group = new Group();
  const segments = 32;
  const span = COURT.netHalfSpan;

  const strip = (bottom: (x: number) => number, top: (x: number) => number, repeat: boolean) => {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const x = -span + (i / segments) * span * 2;
      const y0 = bottom(x);
      const y1 = top(x);
      positions.push(x, y0, 0, x, y1, 0);
      const u = repeat ? (x + span) / 0.09 : i / segments;
      uvs.push(u, repeat ? y0 / 0.09 : 0, u, repeat ? y1 / 0.09 : 1);
      if (i < segments) {
        const a = i * 2;
        indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  };

  const mesh = new Mesh(
    strip(
      () => 0.03,
      (x) => netHeight(x) - 0.04,
      true,
    ),
    new MeshBasicMaterial({
      color: 0x10202e,
      alphaMap: netTexture(),
      transparent: true,
      opacity: 0.82,
      side: DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.renderOrder = 3;
  group.add(mesh);

  group.add(
    new Mesh(
      strip(
        (x) => netHeight(x) - 0.07,
        (x) => netHeight(x) + 0.005,
        false,
      ),
      new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide }),
    ),
  );

  const postGeometry = merge([
    new CylinderGeometry(0.05, 0.055, COURT.netPostHeight + 0.05, 10).translate(
      -span,
      (COURT.netPostHeight + 0.05) / 2,
      0,
    ),
    new CylinderGeometry(0.05, 0.055, COURT.netPostHeight + 0.05, 10).translate(
      span,
      (COURT.netPostHeight + 0.05) / 2,
      0,
    ),
    new BoxGeometry(0.05, COURT.netCenterHeight, 0.03).translate(0, COURT.netCenterHeight / 2, 0),
  ]);
  group.add(new Mesh(postGeometry, new MeshLambertMaterial({ color: 0xe9eef2 })));
  return group;
}

export function buildCourt(pixelsPerMeter: number, anisotropy: number): Group {
  const group = new Group();
  const texture = colorTexture(paintSurface(pixelsPerMeter));
  texture.anisotropy = anisotropy;
  texture.minFilter = LinearMipmapLinearFilter;
  const surface = new Mesh(
    new PlaneGeometry(SURFACE.halfX * 2, SURFACE.halfZ * 2).rotateX(-Math.PI / 2),
    new MeshLambertMaterial({ map: texture }),
  );
  group.add(surface, buildNet());
  return group;
}
