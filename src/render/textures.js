// Procedural textures for LAST CORDON. Everything is synthesised at load time: tileable
// albedo / normal / roughness-metalness sets from layered noise, plus a few canvas-drawn sheets
// (foliage, icons, particles). No image files anywhere.
import * as THREE from 'three';
import { mulberry32 } from '../sim/rng.js';

function lattice(n, rng) {
  const a = new Float32Array(n * n);
  for (let i = 0; i < a.length; i++) a[i] = rng();
  return a;
}
function sampleLattice(a, n, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const i0 = ((x0 % n) + n) % n, i1 = (i0 + 1) % n, j0 = ((y0 % n) + n) % n, j1 = (j0 + 1) % n;
  const a00 = a[j0 * n + i0], a10 = a[j0 * n + i1], a01 = a[j1 * n + i0], a11 = a[j1 * n + i1];
  return a00 + (a10 - a00) * sx + (a01 - a00) * sy + (a00 - a10 - a01 + a11) * sx * sy;
}
// Tileable fractal noise over the unit square, returns [0,1].
export function makeFbm(baseFreq, octaves, seed, gain = 0.5) {
  const rng = mulberry32(seed);
  const layers = [];
  let f = baseFreq, norm = 0, amp = 1;
  for (let o = 0; o < octaves; o++) {
    const n = Math.max(1, Math.round(f));
    layers.push({ a: lattice(n, rng), n, amp });
    norm += amp; amp *= gain; f *= 2;
  }
  return (u, v) => {
    let s = 0;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      s += L.amp * sampleLattice(L.a, L.n, u * L.n, v * L.n);
    }
    return s / norm;
  };
}
// Anisotropic variant: independent frequencies on each axis (wood grain, streaks).
export function makeStreak(fx, fy, octaves, seed) {
  const rng = mulberry32(seed);
  const layers = [];
  let ax = fx, ay = fy, amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const nx = Math.max(1, Math.round(ax)), ny = Math.max(1, Math.round(ay));
    const a = new Float32Array(nx * ny);
    for (let i = 0; i < a.length; i++) a[i] = rng();
    layers.push({ a, nx, ny, amp });
    norm += amp; amp *= 0.5; ax *= 2; ay *= 2;
  }
  return (u, v) => {
    let s = 0;
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      const x = u * L.nx, y = v * L.ny;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx2 = x - x0, fy2 = y - y0;
      const sx = fx2 * fx2 * (3 - 2 * fx2), sy = fy2 * fy2 * (3 - 2 * fy2);
      const i0 = ((x0 % L.nx) + L.nx) % L.nx, i1 = (i0 + 1) % L.nx, j0 = ((y0 % L.ny) + L.ny) % L.ny, j1 = (j0 + 1) % L.ny;
      const a00 = L.a[j0 * L.nx + i0], a10 = L.a[j0 * L.nx + i1], a01 = L.a[j1 * L.nx + i0], a11 = L.a[j1 * L.nx + i1];
      s += L.amp * (a00 + (a10 - a00) * sx + (a01 - a00) * sy + (a00 - a10 - a01 + a11) * sx * sy);
    }
    return s / norm;
  };
}

const sat = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
const sstep = (e0, e1, x) => { const t = sat((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const toByte = (v) => Math.round(sat(v) * 255);

function finishTex(tex, srgb, aniso) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = aniso;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Build {map, normalMap, ormMap} from a per-pixel function writing o.r,o.g,o.b (sRGB 0..1),
// o.h (height 0..1), o.rough, o.metal.
export function genSet(size, pixelFn, opts = {}) {
  const n = size * size;
  const alb = new Uint8Array(n * 4), nrm = new Uint8Array(n * 4), orm = new Uint8Array(n * 4);
  const hgt = new Float32Array(n);
  const o = { r: 0.5, g: 0.5, b: 0.5, h: 0.5, rough: 0.9, metal: 0 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      o.rough = 0.9; o.metal = 0; o.h = 0.5;
      pixelFn((x + 0.5) / size, (y + 0.5) / size, o);
      alb[i * 4] = toByte(o.r); alb[i * 4 + 1] = toByte(o.g); alb[i * 4 + 2] = toByte(o.b); alb[i * 4 + 3] = 255;
      orm[i * 4] = 255; orm[i * 4 + 1] = toByte(o.rough); orm[i * 4 + 2] = toByte(o.metal); orm[i * 4 + 3] = 255;
      hgt[i] = o.h;
    }
  }
  const strength = (opts.bump == null ? 2.0 : opts.bump) * (size / 256);
  for (let y = 0; y < size; y++) {
    const yu = (y + 1) % size, yd = (y + size - 1) % size;
    for (let x = 0; x < size; x++) {
      const xr = (x + 1) % size, xl = (x + size - 1) % size;
      const dx = (hgt[y * size + xr] - hgt[y * size + xl]) * strength;
      const dy = (hgt[yu * size + x] - hgt[yd * size + x]) * strength;
      const l = Math.hypot(dx, dy, 1), i = (y * size + x) * 4;
      nrm[i] = toByte(-dx / l * 0.5 + 0.5); nrm[i + 1] = toByte(-dy / l * 0.5 + 0.5); nrm[i + 2] = toByte(1 / l * 0.5 + 0.5); nrm[i + 3] = 255;
    }
  }
  const aniso = opts.aniso || 4;
  return {
    map: finishTex(new THREE.DataTexture(alb, size, size, THREE.RGBAFormat), true, aniso),
    normalMap: finishTex(new THREE.DataTexture(nrm, size, size, THREE.RGBAFormat), false, aniso),
    ormMap: finishTex(new THREE.DataTexture(orm, size, size, THREE.RGBAFormat), false, aniso),
  };
}

function canvasTex(w, h, draw, opts = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.anisotropy = opts.aniso || 4;
  if (opts.repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  t.userData.canvas = c;
  return t;
}

// ---------------------------------------------------------------------------- material sets
export function buildTextures(aniso = 4) {
  const T = {};
  const A = { aniso };

  { // grass: clumpy olive turf with dry flecks
    const big = makeFbm(3, 4, 11), mid = makeFbm(9, 4, 12), fine = makeFbm(48, 3, 13), blade = makeStreak(90, 28, 2, 14);
    T.grass = genSet(512, (u, v, o) => {
      const b = big(u, v), m = mid(u, v), f = fine(u, v), bl = blade(u, v);
      const t = sat(b * 0.55 + m * 0.45);
      let r = mix(0.15, 0.3, t), g = mix(0.22, 0.37, t), bb = mix(0.075, 0.13, t);
      const dry = sstep(0.62, 0.8, m * 0.6 + f * 0.4);
      r = mix(r, 0.36, dry * 0.55); g = mix(g, 0.33, dry * 0.55); bb = mix(bb, 0.15, dry * 0.55);
      const k = 0.72 + bl * 0.42 + (f - 0.5) * 0.3;
      o.r = r * k; o.g = g * k; o.b = bb * k;
      o.h = bl * 0.6 + f * 0.4; o.rough = 0.86 + f * 0.1;
    }, { bump: 2.4, aniso });
  }
  { // sand
    const big = makeFbm(3, 3, 21), fine = makeFbm(64, 3, 22), rip = makeStreak(5, 40, 3, 23);
    T.sand = genSet(256, (u, v, o) => {
      const b = big(u, v), f = fine(u, v), rp = rip(u, v);
      const k = 0.84 + b * 0.2 + (f - 0.5) * 0.16;
      o.r = 0.69 * k; o.g = 0.615 * k; o.b = 0.455 * k;
      o.h = rp * 0.5 + f * 0.5; o.rough = 0.93;
    }, { bump: 1.6, aniso });
  }
  { // rock: fractured grey stone
    const big = makeFbm(3, 5, 31, 0.55), crack = makeFbm(7, 4, 32), fine = makeFbm(40, 3, 33);
    T.rock = genSet(512, (u, v, o) => {
      const b = big(u, v), c = crack(u, v), f = fine(u, v);
      const ridge = 1 - Math.abs(c * 2 - 1);
      const fiss = sstep(0.93, 1.0, ridge);
      const k = 0.6 + b * 0.6 + (f - 0.5) * 0.25 - fiss * 0.42;
      o.r = 0.34 * k; o.g = 0.325 * k; o.b = 0.3 * k;
      const moss = sstep(0.6, 0.78, b) * 0.35;
      o.r = mix(o.r, 0.16, moss); o.g = mix(o.g, 0.21, moss); o.b = mix(o.b, 0.09, moss);
      o.h = b * 0.6 + f * 0.25 - fiss * 0.5 + 0.2; o.rough = 0.88;
    }, { bump: 3.2, aniso });
  }
  { // dirt track
    const big = makeFbm(4, 4, 41), fine = makeFbm(50, 3, 42), peb = makeFbm(26, 2, 43);
    T.dirt = genSet(256, (u, v, o) => {
      const b = big(u, v), f = fine(u, v), p = sstep(0.72, 0.8, peb(u, v));
      const k = 0.72 + b * 0.4 + (f - 0.5) * 0.3;
      o.r = mix(0.3 * k, 0.42, p * 0.6); o.g = mix(0.235 * k, 0.4, p * 0.6); o.b = mix(0.16 * k, 0.36, p * 0.6);
      o.h = f * 0.5 + b * 0.3 + p * 0.4; o.rough = 0.95;
    }, { bump: 2.2, aniso });
  }
  { // concrete: stained, pitted, with pour seams
    const big = makeFbm(2, 4, 51), stain = makeStreak(14, 3, 3, 52), fine = makeFbm(70, 2, 53), pit = makeFbm(34, 2, 54);
    T.concrete = genSet(512, (u, v, o) => {
      const b = big(u, v), s = stain(u, v), f = fine(u, v);
      const pt = sstep(0.8, 0.86, pit(u, v));
      const seam = Math.min(Math.abs(((v * 2.0) % 1) - 0.5), 0.5);
      const sm = 1 - sstep(0.0, 0.008, 0.5 - seam);
      let k = 0.78 + b * 0.22 + (f - 0.5) * 0.09 - sstep(0.55, 0.85, s) * 0.16 - pt * 0.07 - sm * 0.1;
      o.r = 0.7 * k; o.g = 0.685 * k; o.b = 0.655 * k;
      o.h = 0.6 + (f - 0.5) * 0.2 - pt * 0.3 - sm * 0.3; o.rough = 0.9 - sstep(0.6, 0.9, s) * 0.12;
    }, { bump: 1.8, aniso });
  }
  { // corrugated galvanised sheet
    const spang = makeFbm(22, 3, 61), rust = makeFbm(5, 4, 62), fine = makeFbm(60, 2, 63);
    T.metal = genSet(256, (u, v, o) => {
      const rib = Math.sin(u * Math.PI * 2 * 9) * 0.5 + 0.5;
      const sp = spang(u, v), ru = sstep(0.6, 0.78, rust(u, v) + (fine(u, v) - 0.5) * 0.25);
      const k = 0.62 + rib * 0.22 + (sp - 0.5) * 0.22;
      o.r = mix(0.6 * k, 0.36, ru); o.g = mix(0.61 * k, 0.2, ru); o.b = mix(0.6 * k, 0.11, ru);
      o.h = rib * 0.9 + sp * 0.06; o.rough = mix(0.42, 0.9, ru) + sp * 0.1; o.metal = mix(0.85, 0.15, ru);
    }, { bump: 2.6, aniso });
  }
  { // weathered planks
    const grain = makeStreak(4, 90, 3, 71), big = makeFbm(3, 3, 72), tone = mulberry32(73);
    const tones = []; for (let i = 0; i < 8; i++) tones.push(0.78 + tone() * 0.36);
    T.wood = genSet(512, (u, v, o) => {
      const px = u * 8, pi = Math.floor(px) % 8, pf = px - Math.floor(px);
      const gap = sstep(0.0, 0.045, Math.min(pf, 1 - pf));
      const g = grain(u + pi * 0.37, v), b = big(u, v);
      const k = (0.5 + g * 0.6) * tones[pi] * (0.85 + b * 0.25) * (0.35 + gap * 0.65);
      o.r = 0.52 * k; o.g = 0.41 * k; o.b = 0.29 * k;
      o.h = gap * 0.7 + g * 0.3; o.rough = 0.88;
    }, { bump: 2.4, aniso });
  }
  { // stucco
    const big = makeFbm(2, 4, 81), fine = makeFbm(90, 2, 82), stain = makeStreak(18, 2, 3, 83), crack = makeFbm(6, 3, 84);
    T.plaster = genSet(256, (u, v, o) => {
      const b = big(u, v), f = fine(u, v), s = sstep(0.6, 0.9, stain(u, v));
      const patch = sstep(0.62, 0.7, crack(u, v)) * 0.07;   // faint repaired patches instead of hard cracks
      const k = 0.84 + b * 0.14 + (f - 0.5) * 0.1 - s * 0.14 - patch;
      o.r = 0.92 * k; o.g = 0.9 * k; o.b = 0.86 * k;
      o.h = 0.5 + (f - 0.5) * 0.5 - patch; o.rough = 0.93;
    }, { bump: 1.5, aniso });
  }
  { // clay roof tiles
    const big = makeFbm(3, 3, 91), fine = makeFbm(50, 2, 92), tone = mulberry32(93);
    const tones = []; for (let i = 0; i < 64; i++) tones.push(0.72 + tone() * 0.5);
    T.rooftile = genSet(256, (u, v, o) => {
      const rows = 6, cols = 8;
      const ry = v * rows, ri = Math.floor(ry), rf = ry - ri;
      const cx = u * cols + (ri % 2) * 0.5, ci = Math.floor(cx) % cols, cf = cx - Math.floor(cx);
      const arch = Math.sin(cf * Math.PI);
      const lip = sstep(0.0, 0.14, rf);
      const k = tones[(ri * cols + ci) % 64] * (0.55 + arch * 0.4) * (0.5 + lip * 0.5) * (0.85 + big(u, v) * 0.3 + (fine(u, v) - 0.5) * 0.2);
      o.r = 0.5 * k; o.g = 0.25 * k; o.b = 0.17 * k;
      o.h = arch * 0.6 + rf * 0.4; o.rough = 0.86;
    }, { bump: 3.0, aniso });
  }
  { // container steel: trapezoid ribs, chipped paint, rust runs
    const rust = makeFbm(6, 4, 101), fine = makeFbm(64, 2, 102), run = makeStreak(26, 3, 3, 103);
    T.container = genSet(256, (u, v, o) => {
      const p = (u * 10) % 1;
      const rib = sstep(0.08, 0.22, p) - sstep(0.58, 0.72, p);
      const ru = sstep(0.66, 0.8, rust(u, v) * 0.75 + run(u, v) * 0.35 + (fine(u, v) - 0.5) * 0.2);
      const k = 0.7 + rib * 0.2 + (fine(u, v) - 0.5) * 0.08;
      o.r = mix(0.9 * k, 0.3, ru); o.g = mix(0.9 * k, 0.16, ru); o.b = mix(0.9 * k, 0.09, ru);
      o.h = rib * 0.85 + fine(u, v) * 0.05; o.rough = mix(0.5, 0.92, ru); o.metal = mix(0.35, 0.1, ru);
    }, { bump: 2.8, aniso });
  }
  { // sandbags
    const weave = makeFbm(110, 2, 111), big = makeFbm(4, 3, 112), tone = mulberry32(113);
    const tones = []; for (let i = 0; i < 32; i++) tones.push(0.8 + tone() * 0.34);
    T.sandbag = genSet(256, (u, v, o) => {
      const rows = 4, cols = 3;
      const ry = v * rows, ri = Math.floor(ry), rf = ry - ri;
      const cx = u * cols + (ri % 2) * 0.5, ci = Math.floor(cx) % cols, cf = cx - Math.floor(cx);
      const bulge = Math.pow(Math.sin(cf * Math.PI), 0.35) * Math.pow(Math.sin(rf * Math.PI), 0.45);
      const k = tones[(ri * cols + ci) % 32] * (0.35 + bulge * 0.7) * (0.85 + (weave(u, v) - 0.5) * 0.3 + big(u, v) * 0.15);
      o.r = 0.6 * k; o.g = 0.53 * k; o.b = 0.38 * k;
      o.h = bulge * 0.85 + weave(u, v) * 0.15; o.rough = 0.96;
    }, { bump: 3.4, aniso });
  }
  { // supply crate face
    const grain = makeStreak(3, 60, 3, 121), fine = makeFbm(60, 2, 122);
    T.crate = genSet(256, (u, v, o) => {
      const edge = Math.min(u, 1 - u, v, 1 - v);
      const frame = 1 - sstep(0.085, 0.1, edge);
      const pf = (v * 5) % 1, gap = sstep(0.0, 0.05, Math.min(pf, 1 - pf));
      const g = frame > 0.5 ? grain(v, u) : grain(u, v);
      const k = (0.62 + g * 0.5) * (frame > 0.5 ? 0.82 : 0.4 + gap * 0.6) * (0.92 + (fine(u, v) - 0.5) * 0.16);
      o.r = 0.86 * k; o.g = 0.82 * k; o.b = 0.74 * k;
      o.h = frame * 0.5 + gap * 0.35 + g * 0.15; o.rough = 0.85;
    }, { bump: 2.6, aniso });
  }
  { // rusted painted steel
    const big = makeFbm(4, 5, 131, 0.6), fine = makeFbm(56, 3, 132), run = makeStreak(30, 2, 3, 133);
    T.rusty = genSet(256, (u, v, o) => {
      const b = big(u, v), f = fine(u, v);
      const ru = sstep(0.45, 0.68, b * 0.7 + run(u, v) * 0.4 + (f - 0.5) * 0.3);
      const k = 0.78 + (f - 0.5) * 0.2;
      o.r = mix(0.82 * k, 0.4 * k, ru); o.g = mix(0.8 * k, 0.21 * k, ru); o.b = mix(0.76 * k, 0.11 * k, ru);
      o.h = 0.5 + (f - 0.5) * 0.3 + ru * 0.15; o.rough = mix(0.5, 0.9, ru); o.metal = mix(0.5, 0.15, ru);
    }, { bump: 1.8, aniso });
  }
  { // painted panel
    const fine = makeFbm(70, 2, 141), big = makeFbm(3, 3, 142), chip = makeFbm(18, 3, 143);
    T.paint = genSet(256, (u, v, o) => {
      const ch = sstep(0.74, 0.8, chip(u, v));
      const k = 0.82 + big(u, v) * 0.16 + (fine(u, v) - 0.5) * 0.08;
      o.r = mix(0.9 * k, 0.28, ch); o.g = mix(0.9 * k, 0.24, ch); o.b = mix(0.9 * k, 0.2, ch);
      o.h = 0.5 - ch * 0.3; o.rough = mix(0.5, 0.8, ch); o.metal = 0.25;
    }, { bump: 1.2, aniso });
  }
  { // canvas / cordura weave
    const weave = makeFbm(120, 2, 151), big = makeFbm(4, 3, 152);
    T.canvas = genSet(256, (u, v, o) => {
      const wv = (Math.sin(u * 400) * Math.sin(v * 400)) * 0.5 + 0.5;
      const k = 0.78 + big(u, v) * 0.24 + (weave(u, v) - 0.5) * 0.14 + wv * 0.06;
      o.r = 0.9 * k; o.g = 0.9 * k; o.b = 0.86 * k;
      o.h = wv * 0.6 + weave(u, v) * 0.4; o.rough = 0.95;
    }, { bump: 1.6, aniso });
  }
  { // camouflage fabric: an original four-tone blotch pattern, kept neutral so per-operator tints work
    const a = makeFbm(5, 4, 161), b = makeFbm(7, 4, 162), c = makeFbm(11, 3, 163), weave = makeFbm(120, 2, 164);
    T.camo = genSet(256, (u, v, o) => {
      let r = 0.62, g = 0.6, bb = 0.5;
      if (a(u, v) > 0.52) { r = 0.42; g = 0.45; bb = 0.33; }
      if (b(u, v) > 0.58) { r = 0.3; g = 0.27; bb = 0.21; }
      if (c(u, v) > 0.66) { r = 0.13; g = 0.14; bb = 0.12; }
      const wv = (Math.sin(u * 500) * Math.sin(v * 500)) * 0.5 + 0.5;
      const k = 0.88 + (weave(u, v) - 0.5) * 0.2 + wv * 0.08;
      o.r = r * k; o.g = g * k; o.b = bb * k;
      o.h = wv * 0.5 + weave(u, v) * 0.5; o.rough = 0.94;
    }, { bump: 1.4, aniso });
  }
  { // bark (ringed for palms, ridged for hardwoods via uv scale)
    const ridge = makeStreak(26, 4, 3, 171), big = makeFbm(4, 3, 172), ring = makeStreak(3, 30, 2, 173);
    T.bark = genSet(256, (u, v, o) => {
      const rd = ridge(u, v), rg = ring(u, v);
      const k = 0.5 + rd * 0.5 + big(u, v) * 0.25 + rg * 0.2;
      o.r = 0.36 * k; o.g = 0.3 * k; o.b = 0.23 * k;
      o.h = rd * 0.6 + rg * 0.4; o.rough = 0.95;
    }, { bump: 3.0, aniso });
  }
  { // small-scale ripples for the sea
    const a = makeFbm(6, 5, 181, 0.6), b = makeFbm(13, 3, 182);
    T.water = genSet(256, (u, v, o) => { o.r = o.g = o.b = 0.5; o.h = a(u, v) * 0.7 + b(u, v) * 0.3; }, { bump: 5.0, aniso });
  }

  // foliage sheet: 2x2 cells = palm frond, broadleaf cluster, grass tuft, fern
  T.foliage = canvasTex(1024, 1024, (g, W, Hh) => {
    const rng = mulberry32(900), S = W / 2;
    g.clearRect(0, 0, W, Hh);
    // palm frond (cell 0,0): leaflets off a central rib, rib runs bottom->top of the cell
    g.save(); g.translate(0, 0);
    for (let i = 0; i < 46; i++) {
      const t = i / 45, y = S * (0.97 - t * 0.93);
      const len = S * (0.17 + 0.22 * Math.sin(Math.PI * Math.min(1, t * 1.25 + 0.08))) * (0.9 + rng() * 0.2);
      for (const side of [-1, 1]) {
        const hue = 78 + rng() * 22, lig = 30 + rng() * 16;
        g.fillStyle = `hsl(${hue},${44 + rng() * 16}%,${lig}%)`;
        g.beginPath();
        g.moveTo(S / 2, y);
        g.quadraticCurveTo(S / 2 + side * len * 0.5, y - S * 0.035, S / 2 + side * len, y - S * (0.05 + rng() * 0.05));
        g.quadraticCurveTo(S / 2 + side * len * 0.5, y + S * 0.016, S / 2, y + S * 0.014);
        g.fill();
      }
    }
    g.strokeStyle = '#5b5a2a'; g.lineWidth = S * 0.014; g.beginPath(); g.moveTo(S / 2, S * 0.99); g.lineTo(S / 2, S * 0.03); g.stroke();
    g.restore();
    // broadleaf cluster (cell 1,0)
    g.save(); g.translate(S, 0);
    for (let i = 0; i < 170; i++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * S * 0.44;
      const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r, sz = S * (0.05 + rng() * 0.06), rot = rng() * 6.28;
      g.fillStyle = `hsl(${84 + rng() * 30},${42 + rng() * 18}%,${24 + rng() * 20}%)`;
      g.save(); g.translate(x, y); g.rotate(rot);
      g.beginPath(); g.moveTo(-sz, 0); g.quadraticCurveTo(0, -sz * 0.62, sz, 0); g.quadraticCurveTo(0, sz * 0.62, -sz, 0); g.fill();
      g.restore();
    }
    g.restore();
    // grass tuft (cell 0,1)
    g.save(); g.translate(0, S);
    for (let i = 0; i < 44; i++) {
      const x0 = S * (0.18 + rng() * 0.64), lean = (rng() - 0.5) * S * 0.5, hgt = S * (0.4 + rng() * 0.55), wd = S * (0.012 + rng() * 0.014);
      g.fillStyle = `hsl(${66 + rng() * 30},${38 + rng() * 20}%,${28 + rng() * 22}%)`;
      g.beginPath(); g.moveTo(x0 - wd, S); g.quadraticCurveTo(x0 + lean * 0.3, S - hgt * 0.6, x0 + lean, S - hgt);
      g.quadraticCurveTo(x0 + lean * 0.4, S - hgt * 0.55, x0 + wd, S); g.fill();
    }
    g.restore();
    // fern / shrub leaves (cell 1,1)
    g.save(); g.translate(S, S);
    for (let k = 0; k < 9; k++) {
      const a = -Math.PI / 2 + (k - 4) * 0.34 + (rng() - 0.5) * 0.12, len = S * (0.55 + rng() * 0.38);
      g.save(); g.translate(S / 2, S * 0.98); g.rotate(a + Math.PI / 2);
      for (let i = 0; i < 20; i++) {
        const t = i / 19, y = -len * t, l2 = S * 0.13 * Math.sin(Math.PI * Math.min(1, t + 0.12));
        g.fillStyle = `hsl(${90 + rng() * 26},${44 + rng() * 16}%,${24 + rng() * 18}%)`;
        for (const sd of [-1, 1]) { g.beginPath(); g.moveTo(0, y); g.quadraticCurveTo(sd * l2 * 0.6, y - S * 0.03, sd * l2, y - S * 0.018); g.quadraticCurveTo(sd * l2 * 0.5, y + S * 0.014, 0, y + S * 0.01); g.fill(); }
      }
      g.restore();
    }
    g.restore();
  }, { aniso });
  T.foliage.wrapS = T.foliage.wrapT = THREE.ClampToEdgeWrapping;

  // particle sheet: 2x2 cells = soft blob, smoke, flash star, ring
  T.particles = canvasTex(256, 256, (g) => {
    const S = 128, rng = mulberry32(77);
    let gr = g.createRadialGradient(64, 64, 0, 64, 64, 62);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 26; i++) {
      const x = S + 64 + (rng() - 0.5) * 60, y = 64 + (rng() - 0.5) * 60, r = 16 + rng() * 26;
      gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.22)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(S, 0, S, S);
    }
    g.save(); g.translate(64, S + 64);
    for (let i = 0; i < 9; i++) {
      g.rotate(Math.PI * 2 / 9 + rng() * 0.3);
      const L = 30 + rng() * 30;
      gr = g.createLinearGradient(0, 0, L, 0);
      gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.moveTo(0, -7); g.lineTo(L, 0); g.lineTo(0, 7); g.fill();
    }
    gr = g.createRadialGradient(0, 0, 0, 0, 0, 30);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 30, 0, 6.3); g.fill();
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 7; g.beginPath(); g.arc(S + 64, S + 64, 50, 0, 6.3); g.stroke();
  }, { linear: true });

  // loot icons: one row of 7 cells, order = ar, smg, sr, ammo, vest, helmet, medkit
  T.icons = canvasTex(7 * 96, 96, (g) => {
    g.clearRect(0, 0, 7 * 96, 96);
    g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
    const cell = (i, fn) => { g.save(); g.translate(i * 96, 0); fn(); g.restore(); };
    cell(0, () => { g.fillRect(14, 40, 58, 9); g.fillRect(68, 42, 18, 4); g.fillRect(8, 38, 14, 16); g.fillRect(44, 49, 9, 20); g.fillRect(30, 49, 7, 12); g.fillRect(38, 33, 16, 6); });
    cell(1, () => { g.fillRect(22, 40, 44, 11); g.fillRect(64, 43, 12, 5); g.fillRect(40, 51, 8, 24); g.fillRect(26, 51, 8, 12); g.fillRect(12, 42, 12, 5); });
    cell(2, () => { g.fillRect(8, 43, 70, 6); g.fillRect(76, 44, 14, 3); g.fillRect(6, 41, 18, 14); g.fillRect(34, 32, 26, 7); g.fillRect(40, 49, 6, 12); });
    cell(3, () => { for (let k = 0; k < 4; k++) { g.fillRect(22 + k * 14, 36, 9, 34); g.beginPath(); g.arc(26.5 + k * 14, 36, 4.5, Math.PI, 0); g.fill(); } });
    cell(4, () => { g.beginPath(); g.moveTo(26, 22); g.lineTo(38, 22); g.lineTo(48, 30); g.lineTo(58, 22); g.lineTo(70, 22); g.lineTo(74, 44); g.lineTo(70, 76); g.lineTo(26, 76); g.lineTo(22, 44); g.closePath(); g.fill(); });
    cell(5, () => { g.beginPath(); g.arc(48, 52, 28, Math.PI, 0); g.lineTo(80, 60); g.lineTo(16, 60); g.closePath(); g.fill(); g.fillRect(14, 60, 68, 7); });
    cell(6, () => { g.fillRect(38, 20, 20, 56); g.fillRect(20, 38, 56, 20); });
  }, { linear: true });

  T.clock = canvasTex(256, 256, (g) => {
    g.fillStyle = '#efe6cf'; g.beginPath(); g.arc(128, 128, 126, 0, 6.3); g.fill();
    g.strokeStyle = '#2a2622'; g.lineWidth = 9; g.beginPath(); g.arc(128, 128, 120, 0, 6.3); g.stroke();
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2, r0 = i % 5 === 0 ? 92 : 104, lw = i % 5 === 0 ? 7 : 2.5;
      g.lineWidth = lw; g.beginPath(); g.moveTo(128 + Math.cos(a) * r0, 128 + Math.sin(a) * r0); g.lineTo(128 + Math.cos(a) * 112, 128 + Math.sin(a) * 112); g.stroke();
    }
    g.lineCap = 'round';
    g.lineWidth = 9; g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + Math.cos(-2.2) * 58, 128 + Math.sin(-2.2) * 58); g.stroke();
    g.lineWidth = 6; g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + Math.cos(0.5) * 88, 128 + Math.sin(0.5) * 88); g.stroke();
    g.fillStyle = '#2a2622'; g.beginPath(); g.arc(128, 128, 9, 0, 6.3); g.fill();
  });

  T.helipad = canvasTex(256, 256, (g) => {
    g.fillStyle = '#55585a'; g.beginPath(); g.arc(128, 128, 127, 0, 6.3); g.fill();
    g.strokeStyle = '#d9c95a'; g.lineWidth = 9; g.beginPath(); g.arc(128, 128, 108, 0, 6.3); g.stroke();
    g.strokeStyle = '#e8e6de'; g.lineWidth = 15; g.lineCap = 'butt';
    g.beginPath(); g.moveTo(92, 78); g.lineTo(92, 178); g.moveTo(164, 78); g.lineTo(164, 178); g.moveTo(92, 128); g.lineTo(164, 128); g.stroke();
    const rng = mulberry32(5);
    for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${rng() * 0.12})`; g.fillRect(rng() * 256, rng() * 256, 2 + rng() * 5, 2 + rng() * 5); }
  });

  return T;
}

// Terrain control map: R = dirt tracks / worn ground, G = paved aprons, B = macro variation.
export function buildSplat(world, aniso) {
  const S = 512;
  const tex = canvasTex(S, S, (g) => {
    const half = world.half, sc = S / world.size;
    const px = (x) => (x + half) * sc, pz = (z) => (z + half) * sc;
    g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'lighter';
    // paved aprons (green)
    g.fillStyle = 'rgb(0,255,0)';
    for (const p of world.pois) {
      if (p.id === 'meridian') g.fillRect(px(p.x - 39), pz(p.z - 39), 78 * sc, 78 * sc);
      else if (p.id === 'freight') { g.beginPath(); g.ellipse(px(p.x), pz(p.z), 52 * sc, 50 * sc, 0, 0, 6.3); g.fill(); }
      else if (p.id === 'depot') { g.beginPath(); g.arc(px(p.x), pz(p.z), 27 * sc, 0, 6.3); g.fill(); }
      else if (p.id === 'radar') { g.beginPath(); g.arc(px(p.x), pz(p.z), 17 * sc, 0, 6.3); g.fill(); }
    }
    // tracks and worn ground (red)
    g.strokeStyle = 'rgb(255,0,0)'; g.lineCap = 'round'; g.lineJoin = 'round'; g.lineWidth = 4.6 * sc;
    for (const pts of world.paths) {
      g.beginPath(); g.moveTo(px(pts[0][0]), pz(pts[0][1]));
      for (let i = 1; i < pts.length; i++) g.lineTo(px(pts[i][0]), pz(pts[i][1]));
      g.stroke();
    }
    g.fillStyle = 'rgb(200,0,0)';
    for (const f of world.footprints) {
      if (f.kind === 'container' || f.kind === 'pier') continue;
      g.beginPath(); g.arc(px(f.x), pz(f.z), (Math.max(f.w, f.d) * 0.5 + 2.6) * sc, 0, 6.3); g.fill();
    }
    for (const p of world.pois) {
      if (p.id === 'tidewater' || p.id.includes('camp') || p.id === 'northfield' || p.id === 'sentinel') { g.beginPath(); g.arc(px(p.x), pz(p.z), p.r * 0.5 * sc, 0, 6.3); g.fill(); }
    }
    g.globalCompositeOperation = 'source-over';
  }, { linear: true });
  // soften edges, then add the macro-noise channel
  const c = tex.userData.canvas, g = c.getContext('2d');
  const blur = document.createElement('canvas'); blur.width = S; blur.height = S;
  const bg = blur.getContext('2d');
  bg.filter = 'blur(1.6px)'; bg.drawImage(c, 0, 0);
  const img = bg.getImageData(0, 0, S, S), d = img.data;
  const macro = makeFbm(5, 5, 4242, 0.55), edge = makeFbm(40, 3, 4243);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4, u = x / S, v = y / S;
      const e = (edge(u, v) - 0.5) * 90;
      d[i] = Math.max(0, Math.min(255, d[i] + (d[i] > 8 && d[i] < 247 ? e : 0)));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + (d[i + 1] > 8 && d[i + 1] < 247 ? e : 0)));
      d[i + 2] = Math.round(macro(u, v) * 255);
      d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  tex.flipY = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = aniso || 4;
  tex.needsUpdate = true;
  return tex;
}

// Terrain heights as a half-float texture (for water depth, grass placement, the barrier glow).
export function buildHeightTex(world) {
  const n = world.n, data = new Uint16Array(n * n);
  for (let i = 0; i < n * n; i++) data[i] = THREE.DataUtils.toHalfFloat(world.heights[i]);
  const t = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
