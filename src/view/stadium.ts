import {
  BackSide,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
} from 'three';
import { COURT } from '../sim/constants';
import { SURFACE } from './court';
import { merge } from './geometry';
import { colorTexture, makeCanvas } from './textures';

const WALL_HEIGHT = 1.25;
const STAND_REACH = 19.5;

function bannerTexture() {
  const { canvas, ctx } = makeCanvas(1024, 64);
  ctx.fillStyle = '#12233f';
  ctx.fillRect(0, 0, 1024, 64);
  const blocks = ['#ff5d4d', '#d9f84a', '#ffffff', '#35c2ff'];
  ctx.font = 'italic 900 40px "Arial Black", Arial, sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 4; i++) {
    const x = i * 256;
    ctx.fillStyle = blocks[i];
    ctx.beginPath();
    ctx.arc(x + 34, 32, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f4f7fb';
    ctx.fillText('YY TENNIS', x + 58, 34, 185);
  }
  const texture = colorTexture(canvas);
  texture.wrapS = RepeatWrapping;
  return texture;
}

function buildSky(): Mesh {
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      top: { value: new Color('#4aa6e6') },
      mid: { value: new Color('#a9dcf5') },
      low: { value: new Color('#ffeed8') },
    },
    vertexShader: `
      varying float vHeight;
      void main() {
        vHeight = normalize(position).y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 mid; uniform vec3 low;
      varying float vHeight;
      void main() {
        float h = clamp(vHeight, 0.0, 1.0);
        vec3 c = mix(low, mid, smoothstep(0.0, 0.16, h));
        c = mix(c, top, smoothstep(0.12, 0.62, h));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new Mesh(new SphereGeometry(320, 24, 12), material);
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  return sky;
}

function buildScenery(): Group {
  const group = new Group();

  const clouds = [];
  for (let i = 0; i < 16; i++) {
    const angle = Math.PI * (1.08 + (i / 15) * 0.84);
    const distance = 190 + (i % 3) * 34;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;
    const y = 46 + ((i * 37) % 44);
    for (let k = 0; k < 3; k++) {
      const r = 8 + ((i + k * 3) % 4) * 3;
      clouds.push(
        new IcosahedronGeometry(r, 1).scale(1.8, 0.5, 1).translate(x + (k - 1) * r * 1.6, y + (k % 2) * 2, z),
      );
    }
  }
  group.add(new Mesh(merge(clouds), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.78, depthWrite: false })));

  const hills = [];
  for (let i = 0; i < 12; i++) {
    const angle = Math.PI * (1 + i / 11);
    const r = 150 + (i % 2) * 18;
    hills.push(
      new SphereGeometry(44 + (i % 3) * 10, 12, 6)
        .scale(1.6, 0.42, 1)
        .translate(Math.cos(angle) * r, -4, Math.sin(angle) * r),
    );
  }
  group.add(new Mesh(merge(hills), new MeshBasicMaterial({ color: 0x9fcdb6 })));

  const trees = [];
  for (let i = 0; i < 46; i++) {
    const t = i / 45;
    const angle = Math.PI * (1.02 + t * 0.96);
    const r = 58 + ((i * 13) % 9) * 2;
    const h = 8 + ((i * 7) % 5);
    trees.push(new ConeGeometry(3.2, h, 6).translate(Math.cos(angle) * r, h / 2 - 0.5, Math.sin(angle) * r));
  }
  group.add(new Mesh(merge(trees), new MeshLambertMaterial({ color: 0x3f9a70, flatShading: true })));

  const ground = new Mesh(
    new PlaneGeometry(700, 700).rotateX(-Math.PI / 2).translate(0, -0.08, 0),
    new MeshLambertMaterial({ color: 0x6fb98b }),
  );
  group.add(ground);

  // On tall screens this strip sits behind the thumbs, so it stays dark and calm.
  const foreground = new Mesh(
    new PlaneGeometry(160, 70).rotateX(-Math.PI / 2).translate(0, -0.04, SURFACE.halfZ + 35),
    new MeshBasicMaterial({ color: 0x0c4f49 }),
  );
  group.add(foreground);
  return group;
}

interface Bank {
  /** Unit vector pointing away from the court. */
  ox: number;
  oz: number;
  start: number;
  length: number;
}

export class Stadium {
  readonly group = new Group();
  private readonly crowdMaterial: MeshLambertMaterial;
  private readonly uniforms = { uTime: { value: 0 }, uCheer: { value: 0.08 } };
  private cheer = 0;

  constructor(crowdSpacing: number) {
    this.group.add(buildSky(), buildScenery());
    this.buildWalls();

    const banks: Bank[] = [
      { ox: 1, oz: 0, start: SURFACE.halfX + 0.55, length: 38 },
      { ox: -1, oz: 0, start: SURFACE.halfX + 0.55, length: 38 },
      { ox: 0, oz: -1, start: SURFACE.halfZ + 0.55, length: 2 * (SURFACE.halfX + 0.55 + 7.2) },
    ];
    const steps = [];
    const rows = 8;
    const positions: { x: number; y: number; z: number; ox: number; oz: number }[] = [];
    for (const bank of banks) {
      const alongX = bank.oz !== 0;
      for (let row = 0; row < rows; row++) {
        const distance = bank.start + 0.45 + row * 0.9;
        const height = WALL_HEIGHT + 0.25 + row * 0.5;
        const w = alongX ? bank.length : 0.92;
        const d = alongX ? 0.92 : bank.length;
        steps.push(
          new BoxGeometry(w, height, d).translate(bank.ox * distance, height / 2, bank.oz * distance),
        );
        for (let s = -bank.length / 2 + 0.5; s < bank.length / 2 - 0.3; s += crowdSpacing) {
          if (Math.abs(s) * 7919 % 100 < 16 + ((row * 37) % 11)) continue;
          positions.push({
            x: bank.ox * distance + (alongX ? s : 0),
            y: height,
            z: bank.oz * distance + (alongX ? 0 : s),
            ox: bank.ox,
            oz: bank.oz,
          });
        }
      }
    }
    const standMaterial = new MeshLambertMaterial({ color: 0x2f4a6b });
    this.group.add(new Mesh(merge(steps), standMaterial));

    const person = merge([
      new BoxGeometry(0.38, 0.5, 0.28).translate(0, 0.25, 0),
      new SphereGeometry(0.135, 8, 6).translate(0, 0.66, 0),
    ]);
    this.crowdMaterial = new MeshLambertMaterial({ color: 0xffffff });
    this.crowdMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uniforms.uTime;
      shader.uniforms.uCheer = this.uniforms.uCheer;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uCheer;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float seed = instanceMatrix[3][0] * 1.7 + instanceMatrix[3][2] * 2.3;
           transformed.y += abs(sin(uTime * (3.0 + fract(seed) * 2.0) + seed)) * uCheer;`,
        );
    };
    const crowd = new InstancedMesh(person, this.crowdMaterial, positions.length);
    crowd.frustumCulled = false;
    const palette = ['#ff6b5e', '#ffd166', '#f4f1de', '#4cc9f0', '#90e0a0', '#c77dff', '#ff9f68', '#577bc1', '#e8e8f0'].map(
      (c) => new Color(c),
    );
    const matrix = new Matrix4();
    positions.forEach((p, i) => {
      const facing = Math.atan2(-p.ox, -p.oz);
      matrix.makeRotationY(facing).setPosition(p.x, p.y, p.z);
      crowd.setMatrixAt(i, matrix);
      crowd.setColorAt(i, palette[(i * 7 + (i % 5) * 3) % palette.length]);
    });
    this.group.add(crowd);

    this.buildLights();
    this.buildCourtside();
  }

  private buildWalls(): void {
    const texture = bannerTexture();
    const x = SURFACE.halfX + 0.08;
    const z = SURFACE.halfZ + 0.08;
    const panel = (length: number, repeat: number) => {
      const t = texture.clone();
      t.repeat.set(repeat, 1);
      t.needsUpdate = true;
      return new Mesh(new PlaneGeometry(length, WALL_HEIGHT), new MeshLambertMaterial({ map: t }));
    };
    const y = WALL_HEIGHT / 2;
    const left = panel(z * 2, 4);
    left.position.set(-x, y, 0);
    left.rotation.y = Math.PI / 2;
    const right = panel(z * 2, 4);
    right.position.set(x, y, 0);
    right.rotation.y = -Math.PI / 2;
    const back = panel(x * 2, 2);
    back.position.set(0, y, -z);
    const front = panel(x * 2, 2);
    front.position.set(0, y, z);
    front.rotation.y = Math.PI;
    this.group.add(left, right, back, front);
  }

  private buildLights(): void {
    const masts = [];
    const lamps = [];
    for (const sx of [-1, 1]) {
      const x = sx * STAND_REACH;
      const z = -STAND_REACH - 4;
      masts.push(new CylinderGeometry(0.18, 0.3, 22, 8).translate(x, 11, z));
      lamps.push(new BoxGeometry(3.6, 1.6, 0.3).translate(x, 22.2, z + 0.3));
    }
    this.group.add(new Mesh(merge(masts), new MeshLambertMaterial({ color: 0xdfe6ee })));
    this.group.add(new Mesh(merge(lamps), new MeshBasicMaterial({ color: 0xfff8df })));
  }

  private buildCourtside(): void {
    const x = -(COURT.doublesHalfWidth + 2.35);
    const chair = merge([
      new BoxGeometry(0.1, 2, 0.1).translate(x - 0.35, 1, -0.35),
      new BoxGeometry(0.1, 2, 0.1).translate(x + 0.35, 1, -0.35),
      new BoxGeometry(0.1, 2, 0.1).translate(x - 0.35, 1, 0.35),
      new BoxGeometry(0.1, 2, 0.1).translate(x + 0.35, 1, 0.35),
      new BoxGeometry(0.9, 0.1, 0.9).translate(x, 2, 0),
      new BoxGeometry(0.1, 0.72, 0.8).translate(x - 0.4, 2.38, 0),
    ]);
    this.group.add(new Mesh(chair, new MeshLambertMaterial({ color: 0xf1f4f7 })));

    const umpire = merge([
      new BoxGeometry(0.32, 0.56, 0.42).translate(x - 0.08, 2.34, 0),
      new SphereGeometry(0.14, 10, 8).translate(x - 0.06, 2.78, 0),
    ]);
    this.group.add(new Mesh(umpire, new MeshLambertMaterial({ color: 0x24344f })));

    const benches = [];
    for (const z of [-2.4, 2.4]) {
      const bx = COURT.doublesHalfWidth + 2.7;
      benches.push(
        new BoxGeometry(0.5, 0.08, 1.8).translate(bx, 0.48, z),
        new BoxGeometry(0.08, 0.55, 1.8).translate(bx + 0.24, 0.76, z),
        new BoxGeometry(0.4, 0.46, 0.08).translate(bx, 0.23, z - 0.8),
        new BoxGeometry(0.4, 0.46, 0.08).translate(bx, 0.23, z + 0.8),
      );
    }
    this.group.add(new Mesh(merge(benches), new MeshLambertMaterial({ color: 0xff7a59 })));
  }

  roar(amount: number): void {
    this.cheer = Math.max(this.cheer, amount);
  }

  update(dt: number): void {
    this.cheer = Math.max(0, this.cheer - dt * 0.42);
    this.uniforms.uTime.value += dt;
    this.uniforms.uCheer.value = 0.05 + this.cheer * 0.34;
  }
}
