// Turns the simulation's island data into meshes: splat-shaded terrain, sea, merged buildings
// and props, instanced palms / trees / shrubs / rocks, and a camera-following grass field.
import * as THREE from 'three';
import { MAT, MAT_COUNT } from '../sim/world.js';
import { mulberry32, hash2 } from '../sim/rng.js';
import { ATMO_GLSL } from './core.js';

// ---------------------------------------------------------------------------- tiny geometry buffer
export class Buf {
  constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; this.i = []; this.count = 0; }
  vert(x, y, z, nx, ny, nz, u, v, r, g, b) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u, v); this.c.push(r, g, b);
    return this.count++;
  }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }
  tri(a, b, c) { this.i.push(a, b, c); }
  // append a three.js geometry transformed by m, tinted, with uv scale
  add(geo, m, tint, su, sv, shade, uvConst) {
    const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv, col = geo.attributes.color;
    const nm = new THREE.Matrix3().getNormalMatrix(m), v = new THREE.Vector3(), base = this.count;
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k).applyMatrix4(m);
      const px = v.x, py = v.y, pz = v.z;
      v.fromBufferAttribute(nor, k).applyMatrix3(nm).normalize();
      const s = shade ? shade(py) : 1;
      const cr = col ? col.getX(k) : 1, cg = col ? col.getY(k) : 1, cb = col ? col.getZ(k) : 1;
      const tu = uvConst ? uvConst[0] : (uv ? uv.getX(k) * su : 0), tv = uvConst ? uvConst[1] : (uv ? uv.getY(k) * sv : 0);
      this.vert(px, py, pz, v.x, v.y, v.z, tu, tv, tint.r * s * cr, tint.g * s * cg, tint.b * s * cb);
    }
    const idx = geo.index;
    if (idx) for (let k = 0; k < idx.count; k++) this.i.push(base + idx.getX(k));
    else for (let k = 0; k < pos.count; k++) this.i.push(base + k);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}
const _c = new THREE.Color();
export function tintOf(hex) { _c.setHex(hex, THREE.SRGBColorSpace); return { r: _c.r, g: _c.g, b: _c.b }; }

// ---------------------------------------------------------------------------- terrain
const TERRAIN_FRAG = /* glsl */`
{
  vec2 wuv = vTPos.xz;
  vec4 ctl = texture2D(tSplat, wuv / 640.0 + 0.5);
  float mac = ctl.b;
  float hgt = vTPos.y;
  float slope = 1.0 - normalize(vTNrm).y;
  vec2 dxW = dFdx(wuv), dyW = dFdy(wuv);
  vec2 uvA = wuv * 0.23;
  vec3 gA = texture2D(tGrass, uvA).rgb, gB = texture2D(tGrass, wuv * 0.051 + 0.37).rgb;
  vec3 col = mix(gA, gB, 0.45) * mix(0.74, 1.22, mac);
  col *= mix(vec3(1.08, 1.0, 0.84), vec3(0.9, 1.03, 1.0), smoothstep(0.3, 0.7, mac));
  vec2 nacc = (texture2D(tGrassN, uvA).xy * 2.0 - 1.0) * 0.5;
  float rough = 0.9;
  float wDirt = clamp(ctl.r * 1.3 + smoothstep(0.64, 0.82, mac) * 0.3, 0.0, 1.0);
  if (wDirt > 0.01) {
    vec3 d = textureGrad(tDirt, uvA, dxW * 0.23, dyW * 0.23).rgb * mix(0.82, 1.1, mac);
    col = mix(col, d, wDirt);
    nacc = mix(nacc, textureGrad(tDirtN, uvA, dxW * 0.23, dyW * 0.23).xy * 2.0 - 1.0, wDirt);
    rough = mix(rough, 0.96, wDirt);
  }
  float wPave = ctl.g;
  if (wPave > 0.01) {
    vec2 uvP = wuv * 0.21;
    vec3 pv = textureGrad(tPave, uvP, dxW * 0.21, dyW * 0.21).rgb * mix(0.4, 0.54, mac);
    col = mix(col, pv, wPave);
    nacc = mix(nacc, textureGrad(tPaveN, uvP, dxW * 0.21, dyW * 0.21).xy * 2.0 - 1.0, wPave);
    rough = mix(rough, 0.86, wPave);
  }
  float wRock = smoothstep(0.17, 0.36, slope + (mac - 0.5) * 0.1);
  if (wRock > 0.01) {
    vec2 uvR = wuv * 0.12;
    vec3 rk = textureGrad(tRock, uvR, dxW * 0.12, dyW * 0.12).rgb * 1.05;
    col = mix(col, rk, wRock);
    nacc = mix(nacc, (textureGrad(tRockN, uvR, dxW * 0.12, dyW * 0.12).xy * 2.0 - 1.0) * 1.4, wRock);
    rough = mix(rough, 0.84, wRock);
  }
  float wSand = smoothstep(2.7, 1.35, hgt + (mac - 0.5) * 1.5);
  if (wSand > 0.01) {
    vec2 uvS = wuv * 0.31;
    float wet = smoothstep(0.6, 0.02, hgt);
    vec3 sd = textureGrad(tSand, uvS, dxW * 0.31, dyW * 0.31).rgb * mix(1.0, 0.5, wet) * mix(0.9, 1.08, mac);
    col = mix(col, sd, wSand);
    nacc = mix(nacc, (textureGrad(tSandN, uvS, dxW * 0.31, dyW * 0.31).xy * 2.0 - 1.0) * 0.6, wSand);
    rough = mix(rough, mix(0.94, 0.3, wet), wSand);
  }
  diffuseColor.rgb *= col;
  tNrmAcc = nacc; tRoughAcc = rough;
}`;

function buildTerrain(world, T, splat) {
  const N = world.n, CELL = world.cell, HALF = world.half, H = world.heights;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      tGrass: { value: T.grass.map }, tGrassN: { value: T.grass.normalMap }, tSand: { value: T.sand.map }, tSandN: { value: T.sand.normalMap },
      tRock: { value: T.rock.map }, tRockN: { value: T.rock.normalMap }, tDirt: { value: T.dirt.map }, tDirtN: { value: T.dirt.normalMap },
      tPave: { value: T.concrete.map }, tPaveN: { value: T.concrete.normalMap }, tSplat: { value: splat },
    });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTPos;\nvarying vec3 vTNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTPos = transformed;\nvTNrm = objectNormal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>
        varying vec3 vTPos; varying vec3 vTNrm;
        uniform sampler2D tGrass; uniform sampler2D tGrassN; uniform sampler2D tSand; uniform sampler2D tSandN;
        uniform sampler2D tRock; uniform sampler2D tRockN; uniform sampler2D tDirt; uniform sampler2D tDirtN;
        uniform sampler2D tPave; uniform sampler2D tPaveN; uniform sampler2D tSplat;
        vec2 tNrmAcc; float tRoughAcc;`)
      .replace('#include <map_fragment>', TERRAIN_FRAG)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRoughAcc;')
      .replace('#include <normal_fragment_maps>', `{
        vec3 nW = normalize(vTNrm);
        nW = normalize(nW + vec3(tNrmAcc.x, 0.0, tNrmAcc.y) * 0.85);
        normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
      }`);
  };
  mat.customProgramCacheKey = () => 'terrain';
  const group = new THREE.Group();
  const CH = 64, hAt = (i, j) => H[Math.min(N - 1, Math.max(0, j)) * N + Math.min(N - 1, Math.max(0, i))];
  for (let cj = 0; cj < (N - 1) / CH; cj++) {
    for (let ci = 0; ci < (N - 1) / CH; ci++) {
      const vn = CH + 1, pos = new Float32Array(vn * vn * 3), nor = new Float32Array(vn * vn * 3), idx = [];
      let hi = -1e9;
      for (let j = 0; j < vn; j++) {
        for (let i = 0; i < vn; i++) {
          const gi = ci * CH + i, gj = cj * CH + j, k = (j * vn + i) * 3;
          const h = hAt(gi, gj);
          pos[k] = -HALF + gi * CELL; pos[k + 1] = h; pos[k + 2] = -HALF + gj * CELL;
          if (h > hi) hi = h;
          const nx = hAt(gi - 1, gj) - hAt(gi + 1, gj), nz = hAt(gi, gj - 1) - hAt(gi, gj + 1), ny = 2 * CELL;
          const l = Math.hypot(nx, ny, nz);
          nor[k] = nx / l; nor[k + 1] = ny / l; nor[k + 2] = nz / l;
        }
      }
      if (hi < -6.5) continue; // open sea: the water surface hides the seabed
      for (let j = 0; j < CH; j++) {
        for (let i = 0; i < CH; i++) {
          const a = j * vn + i, b = a + 1, c = a + vn, d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setIndex(idx);
      g.computeBoundingSphere(); g.computeBoundingBox();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true; m.castShadow = false;
      m.matrixAutoUpdate = false;
      group.add(m);
    }
  }
  return group;
}

function buildWater(T, heightTex) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { tHeight: { value: heightTex }, tNrm: { value: T.water.normalMap }, uTime: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */`
      varying vec3 vW;
      uniform sampler2D tHeight; uniform sampler2D tNrm; uniform float uTime;
      ${ATMO_GLSL}
      void main() {
        vec2 p = vW.xz;
        vec2 huv = p / 640.0 + 0.5;
        float inMap = step(0.0, huv.x) * step(huv.x, 1.0) * step(0.0, huv.y) * step(huv.y, 1.0);
        float depth = mix(14.0, -texture2D(tHeight, huv).r, inMap);
        vec3 toCam = cameraPosition - vW;
        float dist = length(toCam);
        vec3 V = toCam / dist;
        vec2 n1 = texture2D(tNrm, p * 0.045 + uTime * vec2(0.012, 0.008)).xy * 2.0 - 1.0;
        vec2 n2 = texture2D(tNrm, p * 0.11 - uTime * vec2(0.017, -0.011)).xy * 2.0 - 1.0;
        vec2 n3 = texture2D(tNrm, p * 0.011 + uTime * vec2(-0.004, 0.006)).xy * 2.0 - 1.0;
        float fade = 1.0 / (1.0 + dist * 0.014);
        vec2 nn = (n1 * 0.55 + n2 * 0.4) * mix(0.22, 1.0, fade) + n3 * 0.32;
        nn *= mix(0.3, 1.0, smoothstep(0.0, 2.5, depth));
        vec3 N = normalize(vec3(nn.x * 0.5, 1.0, nn.y * 0.5));
        float ndv = max(dot(N, V), 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
        vec3 R = reflect(-V, N); R.y = abs(R.y) + 0.02; R = normalize(R);
        vec3 refl = atmoSky(R);
        refl += ATMO_SUN_COL * pow(max(dot(R, ATMO_SUN_DIR), 0.0), 420.0) * 16.0;
        vec3 body = mix(vec3(0.060, 0.26, 0.235), vec3(0.010, 0.060, 0.095), smoothstep(0.0, 5.5, depth));
        vec3 col = mix(body, refl, fres);
        float lap = sin(uTime * 0.9 + p.x * 0.17 + p.y * 0.12) * 0.13;
        float fo = smoothstep(0.5, 0.0, depth + (n1.x + n2.y) * 0.2 + lap) * inMap;
        col = mix(col, vec3(0.80, 0.82, 0.79), fo * 0.7);
        float alpha = clamp(smoothstep(-0.05, 1.5, depth) * 0.88 + fres * 0.6 + fo * 0.5, 0.0, 1.0);
        col = atmoApply(col, cameraPosition, vW);
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true, depthWrite: false, fog: false,
  });
  const geo = new THREE.PlaneGeometry(7000, 7000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false; m.renderOrder = 2;
  return m;
}

// ---------------------------------------------------------------------------- buildings & props
const UV_TILE = [3.0, 2.0, 2.0, 3.0, 2.4, 1, 2.2, 1.2, 0, 2.5, 1, 2.0, 1.6]; // metres per texture tile (0 = fit to face)

function pushBox(buf, p, ground, tile) {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw), hx = p.sx / 2, hy = p.sy / 2, hz = p.sz / 2;
  const t = tintOf(p.tint);
  const grounded = p.y - hy < ground + 0.35;
  const lowAO = grounded ? (p.sy < 1.6 ? 0.66 : 0.76) : 0.92;
  const off = tile ? hash2(Math.round(p.x * 7), Math.round(p.z * 7), 5) * 3.1 : 0;
  const face = (nx, ny, nz, corners, uLen, vLen, sideFace) => {
    const wnx = nx * c + nz * s, wnz = -nx * s + nz * c;
    const ids = [];
    for (let k = 0; k < 4; k++) {
      const [lx, ly, lz, cu, cv] = corners[k];
      const wx = p.x + lx * c + lz * s, wz = p.z - lx * s + lz * c, wy = p.y + ly;
      let ao = 1;
      if (sideFace) ao = ly < 0 ? lowAO : 1; else if (ny < 0) ao = 0.5;
      const u = tile ? (cu * uLen) / tile + off : cu, v = tile ? (cv * vLen) / tile + off * 0.7 : cv;
      ids.push(buf.vert(wx, wy, wz, wnx, ny, wnz, u, v, t.r * ao, t.g * ao, t.b * ao));
    }
    buf.quad(ids[0], ids[1], ids[2], ids[3]);
  };
  face(1, 0, 0, [[hx, -hy, hz, 0, 0], [hx, -hy, -hz, 1, 0], [hx, hy, -hz, 1, 1], [hx, hy, hz, 0, 1]], p.sz, p.sy, true);
  face(-1, 0, 0, [[-hx, -hy, -hz, 0, 0], [-hx, -hy, hz, 1, 0], [-hx, hy, hz, 1, 1], [-hx, hy, -hz, 0, 1]], p.sz, p.sy, true);
  face(0, 0, 1, [[-hx, -hy, hz, 0, 0], [hx, -hy, hz, 1, 0], [hx, hy, hz, 1, 1], [-hx, hy, hz, 0, 1]], p.sx, p.sy, true);
  face(0, 0, -1, [[hx, -hy, -hz, 0, 0], [-hx, -hy, -hz, 1, 0], [-hx, hy, -hz, 1, 1], [hx, hy, -hz, 0, 1]], p.sx, p.sy, true);
  face(0, 1, 0, [[-hx, hy, hz, 0, 0], [hx, hy, hz, 1, 0], [hx, hy, -hz, 1, 1], [-hx, hy, -hz, 0, 1]], p.sx, p.sz, false);
  face(0, -1, 0, [[-hx, -hy, -hz, 0, 0], [hx, -hy, -hz, 1, 0], [hx, -hy, hz, 1, 1], [-hx, -hy, hz, 0, 1]], p.sx, p.sz, false);
}

function buildStructures(world, T, glow) {
  const bufs = [];
  for (let i = 0; i <= MAT_COUNT; i++) bufs.push(new Buf());
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v3 = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  for (const p of world.parts) {
    const tile = UV_TILE[p.mat];
    if (p.shape === 'box') {
      let mi = p.mat;
      if (mi === MAT.GLASS && hash2(Math.round(p.x * 3), Math.round(p.z * 3), 9) < 0.2) mi = MAT_COUNT; // lit window
      pushBox(bufs[mi], p, world.heightAt(p.x, p.z), tile);
    } else if (p.shape === 'cyl') {
      const g = new THREE.CylinderGeometry(p.r2, p.r, p.h, p.r > 2 ? 28 : 12, 1, false);
      e.set(p.axis === 'z' ? Math.PI / 2 : 0, p.yaw, p.axis === 'x' ? Math.PI / 2 : 0, 'YXZ');
      m4.compose(v3.set(p.x, p.y, p.z), q.setFromEuler(e), one);
      const base = p.y - p.h / 2;
      bufs[p.mat].add(g, m4, tintOf(p.tint), (Math.PI * 2 * p.r) / (tile || 2), p.h / (tile || 2), p.axis === 'y' ? (y) => 0.72 + 0.28 * Math.min(1, (y - base) / 1.2) : null);
      g.dispose();
    } else if (p.shape === 'dome') {
      const g = new THREE.SphereGeometry(p.r, 28, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      m4.compose(v3.set(p.x, p.y, p.z), q.identity(), new THREE.Vector3(1, p.h / p.r, 1));
      bufs[p.mat].add(g, m4, tintOf(p.tint), 6, 1);
      g.dispose();
    } else if (p.shape === 'dish') {
      const g = new THREE.SphereGeometry(p.r, 20, 6, 0, Math.PI * 2, 0, 0.95);
      e.set(-2.2, p.yaw, 0, 'YXZ');
      m4.compose(v3.set(p.x, p.y, p.z), q.setFromEuler(e), new THREE.Vector3(1, 0.55, 1));
      bufs[p.mat].add(g, m4, tintOf(p.tint), 3, 1);
      const g2 = g.clone(); // inside face
      g2.index.array.reverse(); g2.attributes.normal.array.forEach((val, k, arr) => { arr[k] = -val; });
      bufs[p.mat].add(g2, m4, tintOf(0x8a8f8c), 3, 1);
      g.dispose(); g2.dispose();
    } else if (p.shape === 'gable' || p.shape === 'pyramid') {
      const b = bufs[p.mat], t = tintOf(p.tint), c = Math.cos(p.yaw), s = Math.sin(p.yaw);
      const hx = p.sx / 2, hz = p.sz / 2, tl = tile || 2;
      const W = (lx, ly, lz) => [p.x + lx * c + lz * s, p.y + ly, p.z - lx * s + lz * c];
      const N = (nx, ny, nz) => { const l = Math.hypot(nx, ny, nz); return [(nx * c + nz * s) / l, ny / l, (-nx * s + nz * c) / l]; };
      const V = (pt, n, u, v, k) => b.vert(pt[0], pt[1], pt[2], n[0], n[1], n[2], u / tl, v / tl, t.r * k, t.g * k, t.b * k);
      if (p.shape === 'gable') {
        const sl = Math.hypot(hz, p.sy);
        for (const sg of [1, -1]) {
          const n = N(0, hz, sg * p.sy);
          const a = V(W(-hx * sg, 0, sg * hz), n, 0, 0, 0.82), bb = V(W(hx * sg, 0, sg * hz), n, p.sx, 0, 0.82);
          const cc = V(W(hx * sg, p.sy, 0), n, p.sx, sl, 1), d = V(W(-hx * sg, p.sy, 0), n, 0, sl, 1);
          b.quad(a, bb, cc, d);
          const ne = N(sg, 0, 0);
          const e0 = V(W(sg * hx, 0, sg * hz), ne, 0, 0, 0.7), e1 = V(W(sg * hx, 0, -sg * hz), ne, p.sz, 0, 0.7), e2 = V(W(sg * hx, p.sy, 0), ne, p.sz / 2, p.sy, 0.85);
          b.tri(e0, e1, e2);
        }
      } else {
        const corners = [[-hx, hz], [hx, hz], [hx, -hz], [-hx, -hz]];
        for (let k = 0; k < 4; k++) {
          const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) % 4];
          const mx = (ax + bx) / 2, mz = (az + bz) / 2;
          const n = N(mx * p.sy, mx * mx + mz * mz, mz * p.sy);
          const sl = Math.hypot(Math.hypot(mx, mz), p.sy);
          const a = V(W(ax, 0, az), n, 0, 0, 0.8), bb = V(W(bx, 0, bz), n, p.sx, 0, 0.8), cc = V(W(0, p.sy, 0), n, p.sx / 2, sl, 1);
          b.tri(a, bb, cc);
        }
      }
    }
  }
  const std = (set, o) => new THREE.MeshStandardMaterial(Object.assign({
    map: set.map, normalMap: set.normalMap, roughnessMap: set.ormMap, metalnessMap: set.ormMap, roughness: 1, metalness: 1, vertexColors: true,
  }, o));
  const mats = [];
  mats[MAT.CONCRETE] = std(T.concrete); mats[MAT.METAL] = std(T.metal, { side: THREE.DoubleSide }); mats[MAT.WOOD] = std(T.wood);
  mats[MAT.PLASTER] = std(T.plaster); mats[MAT.ROOFTILE] = std(T.rooftile, { side: THREE.DoubleSide });
  mats[MAT.GLASS] = new THREE.MeshStandardMaterial({ color: 0x0a1116, roughness: 0.05, metalness: 0.0, envMapIntensity: 1.7 });
  mats[MAT.CONTAINER] = std(T.container); mats[MAT.SANDBAG] = std(T.sandbag); mats[MAT.CRATE] = std(T.crate);
  mats[MAT.RUSTY] = std(T.rusty); mats[MAT.DARK] = new THREE.MeshStandardMaterial({ color: 0x1b1d1f, roughness: 0.55, metalness: 0.7, vertexColors: true });
  mats[MAT.PAINT] = std(T.paint, { side: THREE.DoubleSide }); mats[MAT.CANVAS] = std(T.canvas);
  mats[MAT_COUNT] = new THREE.MeshStandardMaterial({ color: 0x1a1208, emissive: new THREE.Color(1.0, 0.62, 0.28), emissiveIntensity: 2.4, roughness: 0.3 });
  const group = new THREE.Group();
  let tris = 0;
  for (let i = 0; i <= MAT_COUNT; i++) {
    if (!bufs[i].count) continue;
    const mesh = new THREE.Mesh(bufs[i].build(), mats[i]);
    mesh.castShadow = i !== MAT.GLASS && i !== MAT_COUNT; mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    tris += bufs[i].i.length / 3;
    group.add(mesh);
  }
  group.userData.tris = tris;

  // clock faces, helipad, lamps
  const clockMat = new THREE.MeshStandardMaterial({ map: T.clock, emissiveMap: T.clock, emissive: new THREE.Color(1.0, 0.9, 0.7), emissiveIntensity: 0.9, roughness: 0.6 });
  for (const ck of world.clocks) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(ck.r, 40), clockMat);
    m.position.set(ck.x, ck.y, ck.z); m.rotation.y = ck.yaw;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(ck.r, 0.13, 6, 40), mats[MAT.DARK]);
    m.add(rim);
    group.add(m);
  }
  for (const d of world.decals) {
    const m = new THREE.Mesh(new THREE.CircleGeometry(d.r, 44), new THREE.MeshStandardMaterial({ map: T.helipad, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.rotation.x = -Math.PI / 2; m.position.set(d.x, d.y, d.z); m.receiveShadow = true;
    group.add(m);
  }
  if (world.lamps.length) {
    const lampGeo = new THREE.BoxGeometry(0.22, 0.12, 0.22);
    const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(5.0, 3.4, 1.7), fog: false });
    const redMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6.0, 0.4, 0.3), fog: false });
    const im = new THREE.InstancedMesh(lampGeo, lampMat, world.lamps.length);
    const pos = [], col = [];
    world.lamps.forEach((l, k) => {
      m4.makeTranslation(l.x, l.y, l.z); im.setMatrixAt(k, m4);
      pos.push(l.x, l.y - 0.05, l.z);
      if (l.red) { col.push(1.0, 0.1, 0.06); const rm = new THREE.Mesh(lampGeo, redMat); rm.position.set(l.x, l.y, l.z); rm.scale.setScalar(1.3); group.add(rm); }
      else col.push(1.0, 0.7, 0.36);
    });
    im.frustumCulled = false; group.add(im);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    pg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const pts = new THREE.Points(pg, new THREE.PointsMaterial({ map: glow, size: 3.4, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true, fog: false, opacity: 0.55 }));
    pts.frustumCulled = false; pts.renderOrder = 5;
    group.add(pts);
  }
  return group;
}

// ---------------------------------------------------------------------------- vegetation
function frondStrip(buf, len, width, elev, yaw, droop, base, vBase, segs) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const rows = [];
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    const out = Math.cos(elev) * len * t * (1 - 0.1 * t), up = Math.sin(elev) * len * t - droop * t * t * len * 0.6;
    const w = width * 0.5 * Math.sin(Math.PI * Math.min(1, t * 0.9 + 0.1)) * (1 - 0.3 * t) + 0.02;
    const lift = w * 0.32;
    const k2 = 0.7 + 0.3 * t;
    const mk = (side, u) => {
      const lx = side * w, lz = out, ly = up + Math.abs(side) * lift;
      return buf.vert(base.x + lx * cy + lz * sy, base.y + ly, base.z - lx * sy + lz * cy, 0, 1, 0, u, vBase + 0.5 * t, k2, k2, k2);
    };
    rows.push([mk(-1, 0.02), mk(0, 0.25), mk(1, 0.48)]);
  }
  for (let k = 0; k < segs; k++) {
    const a = rows[k], b = rows[k + 1];
    buf.quad(a[0], a[1], b[1], b[0]); buf.quad(a[1], a[2], b[2], b[1]);
  }
}

const LEAF_UV = [0.75, 0.75]; // an opaque leafy texel: far trunks reuse the leaf material, tinted brown

// Each species comes in two detail levels: a full model near the camera and a cut-down one for
// distant groves (a third of the triangles or less, trunk and crown merged into one draw call).
function makeTreeGeos(lo) {
  const rng = mulberry32(4711), one = new THREE.Vector3(1, 1, 1), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  const white = { r: 1, g: 1, b: 1 };
  const out = [];
  { // palm
    const crown = new Buf(), trunk = lo ? crown : new Buf();   // far models are one mesh, one draw call
    const H = 8.6, bend = 1.5;
    const g = new THREE.CylinderGeometry(0.15, 0.27, H, lo ? 4 : 6, lo ? 3 : 6, true);
    g.translate(0, H / 2, 0);
    const pa = g.attributes.position;
    for (let k = 0; k < pa.count; k++) { const t = pa.getY(k) / H; pa.setX(k, pa.getX(k) + bend * t * t); }
    g.computeVertexNormals();
    if (lo) trunk.add(g, m4.identity(), { r: 3.6, g: 1.0, b: 3.6 }, 1, 1, null, LEAF_UV);
    else trunk.add(g, m4.identity(), { r: 0.8, g: 0.76, b: 0.66 }, 2, 7, (y) => 0.7 + 0.3 * Math.min(1, y / 2));
    const top = { x: bend, y: H - 0.05, z: 0 };
    const nf = lo ? 7 : 11;
    for (let i = 0; i < nf; i++) {
      const yaw = (i / nf) * Math.PI * 2 + rng() * 0.3;
      const up = i % 5 < 2;
      frondStrip(crown, 3.6 + rng() * 1.0, lo ? 1.6 : 1.3, up ? 0.55 + rng() * 0.5 : 0.05 + rng() * 0.3, yaw, up ? 0.55 : 0.95, top, 0.5, lo ? 2 : 4);
    }
    if (!lo) for (let i = 0; i < 3; i++) {
      const cg = new THREE.SphereGeometry(0.13, 5, 4);
      m4.makeTranslation(bend + Math.cos(i * 2.1) * 0.2, H - 0.35, Math.sin(i * 2.1) * 0.2);
      trunk.add(cg, m4, { r: 0.42, g: 0.34, b: 0.2 }, 1, 1);
    }
    const cgeo = crown.build(); cgeo.computeVertexNormals();
    out.push({ trunk: lo ? null : trunk.build(), crown: cgeo, shadowCount: 6 * 4 * 12 });
  }
  for (const tall of [false, true]) { // broadleaf and tall jungle tree
    const crown = new Buf(), trunk = lo ? crown : new Buf();
    const TH = tall ? 9.5 : 4.4, cyy = tall ? 11.2 : 5.9, rx = tall ? 4.3 : 3.3, ry = tall ? 2.7 : 2.2;
    const g = new THREE.CylinderGeometry(tall ? 0.24 : 0.2, tall ? 0.5 : 0.38, TH, lo ? 4 : 6, lo ? 1 : 3, true);
    g.translate(0, TH / 2, 0);
    const pa = g.attributes.position;
    for (let k = 0; k < pa.count; k++) { const y = pa.getY(k); if (y < 0.8) { const f = 1 + (0.8 - y) * 0.5; pa.setX(k, pa.getX(k) * f); pa.setZ(k, pa.getZ(k) * f); } }
    g.computeVertexNormals();
    if (lo) trunk.add(g, m4.identity(), { r: 2.6, g: 0.7, b: 2.6 }, 1, 1, null, LEAF_UV);
    else trunk.add(g, m4.identity(), white, 2, tall ? 5 : 3, (y) => 0.68 + 0.32 * Math.min(1, y / 2));
    if (!lo) for (let i = 0; i < 3; i++) {
      const bg = new THREE.CylinderGeometry(0.06, 0.13, tall ? 3.6 : 2.8, 4, 1, true);
      bg.translate(0, (tall ? 3.6 : 2.8) / 2, 0);
      e.set(0.75 + rng() * 0.35, i * 2.1 + rng() * 0.6, 0, 'YXZ');
      m4.compose(new THREE.Vector3(0, TH - 0.6 - rng() * 0.8, 0), q.setFromEuler(e), one);
      trunk.add(bg, m4, white, 1, 2);
    }
    const cards = lo ? (tall ? 16 : 13) : (tall ? 46 : 38);
    for (let i = 0; i < cards; i++) {
      const u = rng() * 2 - 1, th = rng() * Math.PI * 2, rr = Math.sqrt(1 - u * u), rad = 0.5 + rng() * 0.5;
      const dx = rr * Math.cos(th), dy = u, dz = rr * Math.sin(th);
      const px = dx * rx * rad, py = cyy + dy * ry * rad, pz = dz * rx * rad;
      const sz = (tall ? 2.7 : 2.3) * (0.8 + rng() * 0.5) * (lo ? 1.55 : 1);
      // quad basis: roughly facing outward, with random spin
      const n = new THREE.Vector3(dx, dy * 0.6 + 0.35, dz).normalize();
      const t1 = new THREE.Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).cross(n).normalize(), t2 = new THREE.Vector3().crossVectors(n, t1);
      const shade = 0.52 + 0.48 * Math.min(1, Math.max(0, (dy + 0.75) / 1.5)) * (0.55 + 0.45 * rad);
      const sn = new THREE.Vector3(dx, dy + 0.45, dz).normalize();
      const ids = [];
      for (const [a, b, uu, vv] of [[-1, -1, 0.52, 0.52], [1, -1, 0.98, 0.52], [1, 1, 0.98, 0.98], [-1, 1, 0.52, 0.98]]) {
        ids.push(crown.vert(px + (t1.x * a + t2.x * b) * sz * 0.5, py + (t1.y * a + t2.y * b) * sz * 0.5, pz + (t1.z * a + t2.z * b) * sz * 0.5, sn.x, sn.y, sn.z, uu, vv, shade, shade, shade));
      }
      crown.quad(ids[0], ids[1], ids[2], ids[3]);
    }
    out.push({ trunk: lo ? null : trunk.build(), crown: crown.build(), shadowCount: 18 * 6 });
  }
  return out;
}

function buildVegetation(world, T, core, heightTex, splat) {
  const group = new THREE.Group();
  const uTime = { value: 0 };
  const wind = (mat, amp) => {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            float wPh = instanceMatrix[3].x * 0.31 + instanceMatrix[3].z * 0.27;
          #else
            float wPh = 0.0;
          #endif
          float wAmt = ${amp.toFixed(3)} * max(transformed.y, 0.0);
          transformed.x += sin(uTime * 1.25 + wPh + transformed.y * 0.35) * wAmt;
          transformed.z += cos(uTime * 0.95 + wPh * 1.3 + transformed.x * 0.4) * wAmt * 0.7;`);
    };
    mat.customProgramCacheKey = () => 'wind' + amp;
    return mat;
  };
  const leafMat = wind(new THREE.MeshStandardMaterial({ map: T.foliage, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.78, metalness: 0, vertexColors: true, color: 0xe6ecd6 }), 0.013);
  const barkMat = new THREE.MeshStandardMaterial({ map: T.bark.map, normalMap: T.bark.normalMap, roughness: 0.95, metalness: 0, vertexColors: true });
  const geoHi = makeTreeGeos(false), geoLo = makeTreeGeos(true);
  // Groves are split into 80 m cells. Near cells draw instanced full models (one crown and one
  // trunk call per species); far cells draw every tree in the cell as a single pre-merged mesh.
  const leafFar = new THREE.MeshStandardMaterial({ map: T.foliage, alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.78, metalness: 0, vertexColors: true, color: 0xe6ecd6 });
  const CS = 80, cells = new Map(), lods = [];
  for (const t of world.trees) {
    const key = `${Math.floor((t.x + 320) / CS)}|${Math.floor((t.z + 320) / CS)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(t);
  }
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
  const rng = mulberry32(99);
  for (const list of cells.values()) {
    const far = new Buf(), byType = [[], [], []];
    let cx = 0, cz = 0;
    for (const t of list) {
      const type = t.type;
      e.set(type === 0 ? 0 : (rng() - 0.5) * 0.08, t.rot, type === 0 ? (rng() - 0.5) * 0.14 : (rng() - 0.5) * 0.08, 'YXZ');
      const sy = t.s * (0.9 + rng() * 0.25);
      const mat = new THREE.Matrix4().compose(p.set(t.x, t.y - 0.15, t.z), q.setFromEuler(e), s.set(t.s, sy, t.s));
      const v = 0.8 + rng() * 0.38;
      const c = new THREE.Color(v * (0.92 + rng() * 0.16), v, v * (0.8 + rng() * 0.25));
      byType[type].push({ mat, c });
      far.add(geoLo[type].crown, mat, c, 1, 1);
      cx += t.x; cz += t.z;
    }
    const rec = { x: cx / list.length, z: cz / list.length, hi: [], lo: null };
    for (let type = 0; type < 3; type++) {
      const items = byType[type];
      if (!items.length) continue;
      const G = geoHi[type];
      const cm = new THREE.InstancedMesh(G.crown, leafMat, items.length), tm = new THREE.InstancedMesh(G.trunk, barkMat, items.length);
      for (const im of [cm, tm]) {
        for (let k = 0; k < items.length; k++) im.setMatrixAt(k, items[k].mat);
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere(); im.computeBoundingBox();
        // leaf cards only cast: self-shadowing them costs fill and shows acne, and their shading is baked
        im.castShadow = true; im.receiveShadow = im === tm;
        im.matrixAutoUpdate = false;
        group.add(im); rec.hi.push(im);
      }
      for (let k = 0; k < items.length; k++) cm.setColorAt(k, items[k].c);
      if (cm.instanceColor) cm.instanceColor.needsUpdate = true;
      // shadows are cast by a thinned-out crown: a third of the alpha-tested fill
      const geo = G.crown, n = G.shadowCount;
      cm.onBeforeShadow = () => geo.setDrawRange(0, n);
      cm.onAfterShadow = () => geo.setDrawRange(0, Infinity);
    }
    const lo = new THREE.Mesh(far.build(), leafFar);
    lo.castShadow = false; lo.receiveShadow = false; lo.matrixAutoUpdate = false;
    group.add(lo); rec.lo = lo;
    lods.push(rec);
  }
  void m4;

  // shrubs and ferns: three crossed cards each
  if (world.bushes.length) {
    const b = new Buf();
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI, cx = Math.cos(a), sz = Math.sin(a), w = 0.85, h = 1.25;
      const i0 = b.vert(-cx * w, 0, -sz * w, 0, 1, 0, 0.52, 0.02, 0.6, 0.6, 0.6), i1 = b.vert(cx * w, 0, sz * w, 0, 1, 0, 0.98, 0.02, 0.6, 0.6, 0.6);
      const i2 = b.vert(cx * w, h, sz * w, 0, 1, 0, 0.98, 0.48, 1, 1, 1), i3 = b.vert(-cx * w, h, -sz * w, 0, 1, 0, 0.52, 0.48, 1, 1, 1);
      b.quad(i0, i1, i2, i3);
    }
    const bm = new THREE.InstancedMesh(b.build(), leafMat, world.bushes.length);
    world.bushes.forEach((bu, k) => {
      e.set(0, bu.rot, 0);
      m4.compose(p.set(bu.x, bu.y - 0.05, bu.z), q.setFromEuler(e), s.set(bu.s, bu.s * (0.8 + (k % 5) * 0.08), bu.s));
      bm.setMatrixAt(k, m4);
      const v = 0.7 + ((k * 37) % 50) / 100;
      col.setRGB(v, v * 1.02, v * 0.85); bm.setColorAt(k, col);
    });
    bm.frustumCulled = false; bm.receiveShadow = false; bm.castShadow = false;
    group.add(bm);
  }

  // rocks
  if (world.rocks.length) {
    const rg = new THREE.IcosahedronGeometry(1, 2);
    const pa = rg.attributes.position, nrng = mulberry32(31);
    const bumps = []; for (let i = 0; i < 9; i++) bumps.push([nrng() * 2 - 1, nrng() * 2 - 1, nrng() * 2 - 1, 0.12 + nrng() * 0.2]);
    for (let k = 0; k < pa.count; k++) {
      const x = pa.getX(k), y = pa.getY(k), z = pa.getZ(k);
      let d = 1;
      for (const [bx, by, bz, amp] of bumps) d += amp * Math.max(0, x * bx + y * by + z * bz) - amp * 0.3;
      pa.setXYZ(k, x * d, y * d * 0.9, z * d);
    }
    rg.computeVertexNormals();
    const uv = rg.attributes.uv; for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 3, uv.getY(k) * 2);
    const rm = new THREE.InstancedMesh(rg, new THREE.MeshStandardMaterial({ map: T.rock.map, normalMap: T.rock.normalMap, roughness: 0.9, metalness: 0 }), world.rocks.length);
    world.rocks.forEach((r, k) => {
      e.set(0.2 * Math.sin(r.seed), r.rot, 0.2 * Math.cos(r.seed));
      m4.compose(p.set(r.x, r.y + r.s * r.sy * 0.25, r.z), q.setFromEuler(e), s.set(r.s, r.s * r.sy, r.s * (0.85 + (r.seed % 7) * 0.04)));
      rm.setMatrixAt(k, m4);
    });
    rm.frustumCulled = false; rm.castShadow = true; rm.receiveShadow = true;
    group.add(rm);
  }

  // grass: a square field of tufts that wraps around the camera
  const L = 84, COUNT = 6200;
  const gb = new Buf();
  for (let k = 0; k < 2; k++) {
    const a = k * Math.PI / 2 + 0.4, cx = Math.cos(a), sz = Math.sin(a), w = 0.55, h = 0.72;
    const i0 = gb.vert(-cx * w, 0, -sz * w, 0, 1, 0, 0.02, 0.02, 1, 1, 1), i1 = gb.vert(cx * w, 0, sz * w, 0, 1, 0, 0.48, 0.02, 1, 1, 1);
    const i2 = gb.vert(cx * w, h, sz * w, 0, 1, 0, 0.48, 0.48, 1, 1, 1), i3 = gb.vert(-cx * w, h, -sz * w, 0, 1, 0, 0.02, 0.48, 1, 1, 1);
    gb.quad(i0, i1, i2, i3);
  }
  const base = gb.build();
  const ig = new THREE.InstancedBufferGeometry();
  ig.index = base.index;
  for (const k of ['position', 'normal', 'uv']) ig.setAttribute(k, base.attributes[k]);
  const off = new Float32Array(COUNT * 2), rnd = new Float32Array(COUNT * 4), grng = mulberry32(7), side = Math.ceil(Math.sqrt(COUNT));
  for (let i = 0; i < COUNT; i++) {
    off[i * 2] = ((i % side) + grng()) / side * L; off[i * 2 + 1] = (Math.floor(i / side) + grng()) / side * L;
    rnd[i * 4] = grng() * 6.283; rnd[i * 4 + 1] = 0.65 + grng() * 0.8; rnd[i * 4 + 2] = 0.72 + grng() * 0.5; rnd[i * 4 + 3] = grng() * 6.283;
  }
  ig.setAttribute('aOff', new THREE.InstancedBufferAttribute(off, 2));
  ig.setAttribute('aRnd', new THREE.InstancedBufferAttribute(rnd, 4));
  ig.instanceCount = COUNT;
  const gUni = { uCam: { value: new THREE.Vector3() }, uL: { value: L }, tHeight: { value: heightTex }, tSplat: { value: splat } };
  const grassMat = new THREE.MeshStandardMaterial({ map: T.foliage, alphaTest: 0.38, side: THREE.DoubleSide, roughness: 0.85, metalness: 0, color: 0x9aa873 });
  grassMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime; Object.assign(sh.uniforms, gUni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aOff; attribute vec4 aRnd;
        uniform float uTime; uniform vec3 uCam; uniform float uL; uniform sampler2D tHeight; uniform sampler2D tSplat;
        varying float vTint;`)
      .replace('#include <begin_vertex>', `
        vec2 gBase = aOff + floor((uCam.xz - aOff) / uL + 0.5) * uL;
        vec2 gUv = gBase / 640.0 + 0.5;
        float gH = texture2D(tHeight, gUv).r;
        vec4 gCtl = texture2D(tSplat, gUv);
        float gOk = step(2.0, gH) * (1.0 - smoothstep(0.2, 0.45, max(gCtl.r, gCtl.g)));
        float gD = length(gBase - uCam.xz);
        float gS = gOk * (1.0 - smoothstep(uL * 0.34, uL * 0.47, gD)) * aRnd.y;
        float gc = cos(aRnd.x), gs = sin(aRnd.x);
        vec3 gp = position;
        gp.xz = vec2(gc * gp.x - gs * gp.z, gs * gp.x + gc * gp.z);
        gp *= gS;
        gp.x += sin(uTime * 1.7 + gBase.x * 0.45 + aRnd.w) * 0.09 * uv.y * 2.0 * gS;
        vec3 transformed = vec3(gBase.x + gp.x, gH + gp.y - 0.03, gBase.y + gp.z);
        vTint = aRnd.z * mix(0.55, 1.0, uv.y * 2.0);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vTint;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vTint;');
  };
  grassMat.customProgramCacheKey = () => 'grass';
  const grass = new THREE.Mesh(ig, grassMat);
  grass.frustumCulled = false; grass.receiveShadow = true; grass.castShadow = false;
  group.add(grass);

  group.userData.update = (time, cam) => {
    uTime.value = time;
    gUni.uCam.value.copy(cam);
    const nearD = 125 * (core.detailFar || 1) + Math.max(0, cam.y - 20) * 0.6;
    for (let i = 0; i < lods.length; i++) {
      const c = lods[i], near = Math.hypot(c.x - cam.x, c.z - cam.z) < nearD;
      for (let k = 0; k < c.hi.length; k++) c.hi[k].visible = near;
      c.lo.visible = !near;
    }
    grass.visible = core.grassDensity > 0.01;
    ig.instanceCount = Math.floor(COUNT * Math.min(1, core.grassDensity || 0));
  };
  return group;
}

export function buildWorld3D(world, T, core, splat, heightTex, glow) {
  const root = new THREE.Group();
  const terrain = buildTerrain(world, T, splat);
  const water = buildWater(T, heightTex);
  const structures = buildStructures(world, T, glow);
  const veg = buildVegetation(world, T, core, heightTex, splat);
  root.add(terrain, structures, veg, water);
  root.userData.update = (time, camPos) => {
    water.material.uniforms.uTime.value = time;
    veg.userData.update(time, camPos);
  };
  return root;
}
