// Transient and gameplay visuals: particles, tracers, muzzle flashes, the Bulwark energy walls,
// loot beacons, the Cordon barrier and the drop plane. All instanced, all shader-driven.
import * as THREE from 'three';
import { Buf } from './world3d.js';
import { ATMO_GLSL, NOISE_GLSL } from './core.js';
import { WALL, LOOT_INFO, ZONE_PHASES } from '../sim/config.js';

const MAX_P = 720, MAX_T = 72, MAX_W = WALL.MAX_ACTIVE + 4, MAX_L = 340;
const LOOT_ORDER = ['ar', 'smg', 'sr', 'ammo', 'vest', 'helmet', 'medkit'];
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

function instQuad(count, attrs) {
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index; g.setAttribute('position', base.attributes.position); g.setAttribute('uv', base.attributes.uv);
  const out = {};
  for (const [name, size] of attrs) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, a); out[name] = a;
  }
  g.instanceCount = 0;
  return { g, a: out };
}

export function createEffects(core, T, world, heightTex) {
  const group = new THREE.Group();
  const rand = Math.random;

  // ------------------------------------------------------------------ particles
  const pVert = /* glsl */`
    attribute vec3 aPos; attribute vec4 aSR; attribute vec4 aCol;
    varying vec2 vUv; varying vec4 vCol; varying vec3 vW;
    void main() {
      vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
      vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      float c = cos(aSR.y), s = sin(aSR.y);
      vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * aSR.x;
      vec3 w = aPos + right * q.x + up * q.y;
      vW = w; vCol = aCol;
      float cell = aSR.z;
      vUv = vec2((uv.x + mod(cell, 2.0)) * 0.5, (uv.y + 1.0 - floor(cell * 0.5)) * 0.5);
      gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
    }`;
  const pFrag = (add) => /* glsl */`
    varying vec2 vUv; varying vec4 vCol; varying vec3 vW;
    uniform sampler2D tMap;
    ${ATMO_GLSL}
    void main() {
      float a = texture2D(tMap, vUv).a * vCol.a;
      float fog = atmoFogAmount(cameraPosition, vW);
      ${add ? 'gl_FragColor = vec4(vCol.rgb * a * (1.0 - fog), 1.0);' : 'gl_FragColor = vec4(mix(vCol.rgb, atmoFogColor(normalize(vW - cameraPosition)), fog), a);'}
    }`;
  const mkLayer = (add) => {
    const q = instQuad(MAX_P, [['aPos', 3], ['aSR', 4], ['aCol', 4]]);
    const mat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: T.particles } }, vertexShader: pVert, fragmentShader: pFrag(add),
      transparent: true, depthWrite: false, fog: false,
      blending: add ? THREE.CustomBlending : THREE.NormalBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    });
    const m = new THREE.Mesh(q.g, mat);
    m.frustumCulled = false; m.renderOrder = add ? 8 : 7;
    group.add(m);
    return { q, n: 0 };
  };
  const layerAdd = mkLayer(true), layerAlpha = mkLayer(false);
  const parts = [];
  function spawn(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, cell, add, grav, drag) {
    if (parts.length >= MAX_P * 2 - 4) return;
    parts.push({ x, y, z, vx, vy, vz, life, max: life, s0, s1, r, g, b, a, cell, add, grav: grav || 0, drag: drag || 0, rot: rand() * 6.28, rv: (rand() - 0.5) * 2 });
  }
  function updateParticles(dt) {
    let na = 0, nb = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life -= dt;
      if (p.life <= 0) { parts[i] = parts[parts.length - 1]; parts.pop(); continue; }
      p.vy -= p.grav * dt;
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d; p.vy *= d; p.vz *= d;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.rot += p.rv * dt;
      const t = 1 - p.life / p.max, L = p.add ? layerAdd : layerAlpha, k = p.add ? na : nb;
      if (k >= MAX_P) continue;
      const A = L.q.a, fade = p.add ? (1 - t) : Math.min(1, t * 8) * (1 - t) * (1 - t);
      A.aPos.setXYZ(k, p.x, p.y, p.z);
      A.aSR.setXYZW(k, p.s0 + (p.s1 - p.s0) * t, p.rot, p.cell, 0);
      A.aCol.setXYZW(k, p.r, p.g, p.b, p.a * fade);
      if (p.add) na++; else nb++;
    }
    for (const [L, n] of [[layerAdd, na], [layerAlpha, nb]]) {
      L.q.g.instanceCount = n;
      L.q.a.aPos.needsUpdate = true; L.q.a.aSR.needsUpdate = true; L.q.a.aCol.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------ tracers
  const tq = instQuad(MAX_T, [['aA', 3], ['aB', 3], ['aCol', 4]]);
  const tracerMat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */`
      attribute vec3 aA; attribute vec3 aB; attribute vec4 aCol;
      varying vec2 vUv; varying vec4 vCol;
      void main() {
        vec3 p = mix(aA, aB, uv.x);
        vec3 dir = normalize(aB - aA);
        vec3 side = normalize(cross(dir, cameraPosition - p));
        float dist = length(cameraPosition - p);
        vec3 w = p + side * (uv.y - 0.5) * (0.05 + dist * 0.0022);
        vUv = uv; vCol = aCol;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv; varying vec4 vCol;
      void main() {
        float e = 1.0 - abs(vUv.y * 2.0 - 1.0);
        float k = e * e * mix(0.15, 1.0, vUv.x * vUv.x);
        gl_FragColor = vec4(vCol.rgb * k * vCol.a, 1.0);
      }`,
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const tracerMesh = new THREE.Mesh(tq.g, tracerMat);
  tracerMesh.frustumCulled = false; tracerMesh.renderOrder = 9;
  group.add(tracerMesh);
  const tracers = [];
  function updateTracers(dt) {
    let n = 0;
    for (let i = tracers.length - 1; i >= 0; i--) {
      const t = tracers[i];
      t.t += dt / t.dur;
      if (t.t >= 1.35) { tracers[i] = tracers[tracers.length - 1]; tracers.pop(); continue; }
      if (n >= MAX_T) continue;
      const head = Math.min(1, t.t), tail = Math.max(0, t.t - 0.35);
      tq.a.aA.setXYZ(n, t.ax + (t.bx - t.ax) * tail, t.ay + (t.by - t.ay) * tail, t.az + (t.bz - t.az) * tail);
      tq.a.aB.setXYZ(n, t.ax + (t.bx - t.ax) * head, t.ay + (t.by - t.ay) * head, t.az + (t.bz - t.az) * head);
      tq.a.aCol.setXYZW(n, t.r, t.g, t.b, 1);
      n++;
    }
    tq.g.instanceCount = n;
    tq.a.aA.needsUpdate = true; tq.a.aB.needsUpdate = true; tq.a.aCol.needsUpdate = true;
  }

  // ------------------------------------------------------------------ Bulwark walls
  const wallGeo = (() => {
    const A = WALL.ARC_ANGLE, R = WALL.ARC_RADIUS, H = WALL.HEIGHT, nu = 28, nv = 10;
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const u = i / nu, v = j / nv, phi = (u - 0.5) * A;
        pos.push(R * Math.sin(phi), v * H, R - R * Math.cos(phi)); uv.push(u, v);
      }
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1; idx.push(a, b, c, b, d, c); }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  })();
  const wXf = new THREE.InstancedBufferAttribute(new Float32Array(MAX_W * 4), 4), wPr = new THREE.InstancedBufferAttribute(new Float32Array(MAX_W * 4), 4), wHit = new THREE.InstancedBufferAttribute(new Float32Array(MAX_W * 3), 3);
  for (const a of [wXf, wPr, wHit]) a.setUsage(THREE.DynamicDrawUsage);
  wallGeo.setAttribute('aXf', wXf); wallGeo.setAttribute('aPr', wPr); wallGeo.setAttribute('aHit', wHit);
  wallGeo.instanceCount = 0;
  const wallMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec4 aXf; attribute vec4 aPr; attribute vec3 aHit;
      varying vec2 vUv; varying vec4 vPr; varying vec3 vHit; varying vec3 vW; varying vec3 vN;
      void main() {
        float grow = smoothstep(0.0, 0.16, aPr.y);
        float over = 1.0 + 0.12 * sin(min(aPr.y, 0.32) / 0.32 * 3.14159);
        vec3 lp = position; lp.y *= grow * over;
        float c = cos(aXf.w), s = sin(aXf.w);
        vec3 w = vec3(aXf.x + lp.x * c + lp.z * s, aXf.y + lp.y - 0.05, aXf.z - lp.x * s + lp.z * c);
        float phi = (uv.x - 0.5) * ${WALL.ARC_ANGLE.toFixed(3)};
        vec3 ln = vec3(sin(phi), 0.0, -cos(phi));
        vN = vec3(ln.x * c + ln.z * s, 0.0, -ln.x * s + ln.z * c);
        vUv = uv; vPr = aPr; vHit = aHit; vW = w;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv; varying vec4 vPr; varying vec3 vHit; varying vec3 vW; varying vec3 vN;
      uniform float uTime;
      ${ATMO_GLSL}
      ${NOISE_GLSL}
      float hexLine(vec2 p) {
        p.x *= 1.1547; p.y += mod(floor(p.x), 2.0) * 0.5;
        vec2 f = abs(fract(p) - 0.5);
        return smoothstep(0.42, 0.5, max(f.x * 1.5 + f.y, f.y * 2.0));
      }
      void main() {
        float hp = vPr.x, age = vPr.y, life = vPr.w;
        vec2 m = vec2(vUv.x * ${(WALL.ARC_ANGLE * WALL.ARC_RADIUS).toFixed(3)}, vUv.y * ${WALL.HEIGHT.toFixed(3)});
        vec3 V = normalize(cameraPosition - vW);
        float rim = pow(1.0 - abs(dot(normalize(vN), V)), 2.0);
        float hx = hexLine(m * 3.2);
        float frost = fbm4(m * 2.6 + 3.0);
        float edge = max(smoothstep(0.05, 0.0, vUv.x), smoothstep(0.95, 1.0, vUv.x));
        edge = max(edge, smoothstep(0.955, 1.0, vUv.y));
        // fractures spread as the wall is shot
        float dmg = 1.0 - hp;
        float cr = fbm4(m * 3.8 + 11.0);
        float crack = smoothstep(0.035 + 0.02 * dmg, 0.0, abs(cr - 0.5)) * smoothstep(0.08, 0.55, dmg + (frost - 0.5) * 0.5);
        // impact ripple
        float hd = length((vUv - vHit.xy) * vec2(${(WALL.ARC_ANGLE * WALL.ARC_RADIUS).toFixed(3)}, ${WALL.HEIGHT.toFixed(3)}));
        float rip = vHit.z < 0.5 ? smoothstep(0.14, 0.0, abs(hd - vHit.z * 2.6)) * (1.0 - vHit.z * 2.0) : 0.0;
        float flick = 0.86 + 0.14 * sin(uTime * 31.0 + vUv.y * 40.0) * dmg;
        float scan = 0.5 + 0.5 * sin(vUv.y * 46.0 - uTime * 3.0);
        vec3 ice = mix(vec3(0.16, 0.50, 0.78), vec3(0.50, 0.88, 1.0), frost);
        vec3 col = ice * (0.42 + 0.2 * scan) + vec3(0.5, 0.9, 1.0) * (hx * 0.5 + rim * 0.7 + edge * 1.8 + rip * 3.2);
        col = mix(col, vec3(0.86, 0.95, 1.0) * 1.3, crack);
        col *= flick * (1.0 + 2.2 * smoothstep(0.3, 0.0, age));
        float alpha = clamp(0.44 + 0.2 * frost + hx * 0.2 + rim * 0.25 + edge + crack * 0.4 + rip, 0.0, 0.94);
        // emitter rail along the ground
        float rail = smoothstep(0.075, 0.06, vUv.y);
        float node = smoothstep(0.06, 0.02, abs(fract(vUv.x * 7.0) - 0.5)) * smoothstep(0.02, 0.05, vUv.y);
        col = mix(col, vec3(0.03, 0.04, 0.05) + vec3(0.3, 1.2, 2.0) * node, rail);
        alpha = mix(alpha, 1.0, rail);
        // dissolve at end of life
        float gone = smoothstep(1.1, 0.0, life);
        if (frost + vUv.y * 0.35 < gone * 1.4) discard;
        alpha *= smoothstep(0.0, 0.12, age);
        col = atmoApply(col, cameraPosition, vW);
        gl_FragColor = vec4(col, alpha);
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const wallMesh = new THREE.Mesh(wallGeo, wallMat);
  wallMesh.frustumCulled = false; wallMesh.renderOrder = 6;
  group.add(wallMesh);

  // ------------------------------------------------------------------ loot crates
  const caseGeo = (() => {
    const b = new Buf(), m = new THREE.Matrix4();
    const add = (sx, sy, sz, x, y, z, c) => { const g = new THREE.BoxGeometry(sx, sy, sz); m.makeTranslation(x, y, z); b.add(g, m, { r: c, g: c * 1.03, b: c * 0.9 }, 1, 1); g.dispose(); };
    add(0.64, 0.2, 0.42, 0, 0.1, 0, 0.3); add(0.66, 0.12, 0.44, 0, 0.27, 0, 0.36);
    add(0.06, 0.1, 0.02, -0.2, 0.2, 0.225, 0.75); add(0.06, 0.1, 0.02, 0.2, 0.2, 0.225, 0.75);
    add(0.2, 0.03, 0.05, 0, 0.345, 0, 0.14); add(0.7, 0.03, 0.03, 0, 0.02, 0.2, 0.18); add(0.7, 0.03, 0.03, 0, 0.02, -0.2, 0.18);
    return b.build();
  })();
  const caseMesh = new THREE.InstancedMesh(caseGeo, new THREE.MeshStandardMaterial({ map: T.paint.map, normalMap: T.paint.normalMap, roughness: 0.6, metalness: 0.3, vertexColors: true, color: 0x7d8468 }), MAX_L);
  const stripMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.665, 0.028, 0.445), new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }), MAX_L);
  for (const im of [caseMesh, stripMesh]) { im.frustumCulled = false; im.count = 0; group.add(im); }
  caseMesh.castShadow = true; caseMesh.receiveShadow = true;
  const lq = instQuad(MAX_L, [['aPos', 3], ['aCol', 4]]);
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec3 aPos; attribute vec4 aCol;
      varying vec2 vUv; varying vec4 vCol; varying float vFade;
      void main() {
        vec3 toCam = cameraPosition - aPos;
        float dist = length(toCam);
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
        vec3 w = aPos + right * position.x * 0.62 + vec3(0.0, (position.y + 0.5) * 5.2, 0.0);
        vUv = uv; vCol = aCol;
        vFade = smoothstep(2.0, 7.0, dist) * (1.0 - smoothstep(110.0, 170.0, dist));
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv; varying vec4 vCol; varying float vFade; uniform float uTime;
      void main() {
        float x = 1.0 - abs(vUv.x * 2.0 - 1.0);
        float k = pow(x, 2.2) * pow(1.0 - vUv.y, 1.6) * (0.75 + 0.25 * sin(uTime * 3.0 + vUv.y * 9.0));
        gl_FragColor = vec4(vCol.rgb * k * vFade * vCol.a, 1.0);
      }`,
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
  });
  const beamMesh = new THREE.Mesh(lq.g, beamMat);
  beamMesh.frustumCulled = false; beamMesh.renderOrder = 8; group.add(beamMesh);
  const iq = instQuad(MAX_L, [['aPos', 3], ['aCol', 4]]);
  const iconMat = new THREE.ShaderMaterial({
    uniforms: { tMap: { value: T.icons }, uTime: { value: 0 } },
    vertexShader: /* glsl */`
      attribute vec3 aPos; attribute vec4 aCol;
      varying vec2 vUv; varying vec4 vCol; varying float vFade;
      uniform float uTime;
      void main() {
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        float dist = length(cameraPosition - aPos);
        float sz = 0.46 + dist * 0.012;
        vec3 w = aPos + vec3(0.0, 0.95 + sin(uTime * 2.0 + aPos.x) * 0.06, 0.0) + right * position.x * sz + up * position.y * sz;
        vUv = vec2((uv.x + aCol.a) / 7.0, uv.y); vCol = aCol;
        vFade = smoothstep(1.2, 2.6, dist) * (1.0 - smoothstep(26.0, 36.0, dist));
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec2 vUv; varying vec4 vCol; varying float vFade; uniform sampler2D tMap;
      void main() {
        float a = texture2D(tMap, vUv).a * vFade;
        if (a < 0.02) discard;
        gl_FragColor = vec4(mix(vCol.rgb, vec3(1.0), 0.55) * 1.5, a * 0.95);
      }`,
    transparent: true, depthWrite: false, depthTest: true, fog: false,
  });
  const iconMesh = new THREE.Mesh(iq.g, iconMat);
  iconMesh.frustumCulled = false; iconMesh.renderOrder = 10; group.add(iconMesh);
  const lootCols = {};
  for (const k of LOOT_ORDER) lootCols[k] = new THREE.Color().setHex(LOOT_INFO[k].color, THREE.SRGBColorSpace);
  let lootSig = -1;
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  function syncLoot(game) {
    let alive = 0, sig = game.loot.length * 7919;
    for (const l of game.loot) if (l.alive) { alive++; sig += l.id; }
    if (sig === lootSig) return;
    lootSig = sig;
    let n = 0;
    for (const l of game.loot) {
      if (!l.alive || n >= MAX_L) continue;
      m4.makeRotationY((l.id * 2.39) % 6.28).setPosition(l.x, l.y, l.z);
      caseMesh.setMatrixAt(n, m4);
      m4.setPosition(l.x, l.y + 0.205, l.z); stripMesh.setMatrixAt(n, m4);
      const c = lootCols[l.type];
      stripMesh.setColorAt(n, col.setRGB(c.r * 4.2, c.g * 4.2, c.b * 4.2));
      lq.a.aPos.setXYZ(n, l.x, l.y + 0.3, l.z); lq.a.aCol.setXYZW(n, c.r * 1.25, c.g * 1.25, c.b * 1.25, l.type === 'ammo' ? 0.55 : 1);
      iq.a.aPos.setXYZ(n, l.x, l.y, l.z); iq.a.aCol.setXYZW(n, c.r, c.g, c.b, LOOT_ORDER.indexOf(l.type));
      n++;
    }
    caseMesh.count = n; stripMesh.count = n; lq.g.instanceCount = n; iq.g.instanceCount = n;
    caseMesh.instanceMatrix.needsUpdate = true; stripMesh.instanceMatrix.needsUpdate = true;
    if (stripMesh.instanceColor) stripMesh.instanceColor.needsUpdate = true;
    lq.a.aPos.needsUpdate = true; lq.a.aCol.needsUpdate = true; iq.a.aPos.needsUpdate = true; iq.a.aCol.needsUpdate = true;
    void alive;
  }

  // ------------------------------------------------------------------ the Cordon barrier
  const zoneGeo = new THREE.CylinderGeometry(1, 1, 1, 160, 1, true);
  zoneGeo.translate(0, 0.5, 0);
  const zoneMat = new THREE.ShaderMaterial({
    uniforms: { uC: { value: new THREE.Vector2() }, uR: { value: 300 }, uTime: { value: 0 }, tHeight: { value: heightTex } },
    vertexShader: /* glsl */`
      uniform vec2 uC; uniform float uR;
      varying vec3 vW; varying vec3 vL;
      void main() {
        vL = position;
        vec3 w = vec3(uC.x + position.x * uR, position.y * 125.0 - 14.0, uC.y + position.z * uR);
        vW = w;
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uR; uniform float uTime; uniform sampler2D tHeight;
      varying vec3 vW; varying vec3 vL;
      ${ATMO_GLSL}
      ${NOISE_GLSL}
      void main() {
        vec2 huv = vW.xz / 640.0 + 0.5;
        float ground = max(texture2D(tHeight, clamp(huv, 0.0, 1.0)).r, 0.0);
        float hA = vW.y - ground;
        if (hA < -0.6) discard;
        float h = max(hA, 0.0);
        float base = exp(-h * 0.05);
        float seam = exp(-h * 0.8);                                   // bright line where it meets the ground
        float arc = atan(vL.z, vL.x) * uR;                            // metres along the ring
        float curtain = smoothstep(0.3, 0.85, vnoise(vec2(arc * 0.09, uTime * 0.22)));
        float fine = vnoise(vec2(arc * 1.7, h * 0.16 - uTime * 1.5));
        float scan = 0.5 + 0.5 * sin(h * 1.1 - uTime * 2.6);
        float colId = floor(arc * 0.45), tick = floor(uTime * 8.0);
        float bolt = step(0.986, hash21(vec2(colId, tick))) * smoothstep(0.5, 0.05, abs(fract(arc * 0.45) - 0.5)) * step(h, 5.0 + 14.0 * hash21(vec2(tick, colId)));
        float dist = length(cameraPosition - vW);
        float a = base * (0.07 + 0.16 * curtain + 0.09 * fine * scan) + seam * 0.5 + bolt * 0.75;
        a *= smoothstep(0.4, 5.0, dist) * (1.0 - smoothstep(34.0, 78.0, h));
        float fog = atmoFogAmount(cameraPosition, vW);
        float hot = clamp(bolt + seam * 0.7, 0.0, 1.0);
        vec3 c = mix(vec3(0.07, 0.30, 1.0), vec3(0.42, 0.76, 1.0), hot) * (1.5 + hot * 1.8);
        gl_FragColor = vec4(c * (1.0 - fog * 0.6), clamp(a, 0.0, 0.85) * (1.0 - fog * 0.6));
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const zoneMesh = new THREE.Mesh(zoneGeo, zoneMat);
  zoneMesh.frustumCulled = false; zoneMesh.renderOrder = 4;
  group.add(zoneMesh);

  // ------------------------------------------------------------------ drop plane
  const plane = (() => {
    const b = new Buf(), m = new THREE.Matrix4(), g1 = { r: 0.3, g: 0.32, b: 0.33 }, g2 = { r: 0.17, g: 0.18, b: 0.19 };
    let g = new THREE.CylinderGeometry(2.2, 1.9, 26, 12); m.makeRotationX(Math.PI / 2); b.add(g, m, g1, 1, 1);
    g = new THREE.SphereGeometry(2.2, 12, 8); m.makeScale(1, 1, 1.9).setPosition(0, 0, -13); b.add(g, m, g1, 1, 1);
    g = new THREE.ConeGeometry(1.9, 9, 12); m.makeRotationX(Math.PI / 2).setPosition(0, 0.6, 17); b.add(g, m, g1, 1, 1);
    g = new THREE.BoxGeometry(38, 0.5, 5.2); m.makeTranslation(0, 2.0, -2); b.add(g, m, g1, 1, 1);
    g = new THREE.BoxGeometry(14, 0.4, 3.2); m.makeTranslation(0, 4.2, 19); b.add(g, m, g1, 1, 1);
    g = new THREE.BoxGeometry(0.5, 6.5, 4.4); m.makeTranslation(0, 3.2, 18.5); b.add(g, m, g1, 1, 1);
    for (const x of [-12.5, -6.5, 6.5, 12.5]) {
      g = new THREE.CylinderGeometry(0.85, 0.7, 4.6, 8); m.makeRotationX(Math.PI / 2).setPosition(x, 1.5, -3.5); b.add(g, m, g2, 1, 1);
      g = new THREE.CylinderGeometry(2.0, 2.0, 0.08, 14); m.makeRotationX(Math.PI / 2).setPosition(x, 1.5, -6.0); b.add(g, m, { r: 0.1, g: 0.1, b: 0.1 }, 1, 1);
    }
    const mesh = new THREE.Mesh(b.build(), new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.6, vertexColors: true }));
    mesh.visible = false; mesh.castShadow = false;
    group.add(mesh);
    return mesh;
  })();

  // ------------------------------------------------------------------ event-driven bursts
  const W_FLASH = [0.75, 0.55, 1.15];
  function impact(x, y, z, nx, ny, nz, kind) {
    const metal = kind === 'container' || kind === 'tank' || kind === 'vehicle' || kind === 'prop';
    const dust = kind === 'terrain' ? [0.52, 0.45, 0.34] : kind === 'tree' ? [0.36, 0.27, 0.17] : [0.55, 0.54, 0.52];
    const nd = metal ? 1 : 3;
    for (let i = 0; i < nd; i++) spawn(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, nx * (0.6 + rand()) + (rand() - 0.5) * 0.8, ny * (0.6 + rand()) + 0.5 + rand() * 0.6, nz * (0.6 + rand()) + (rand() - 0.5) * 0.8, 0.5 + rand() * 0.5, 0.12, 0.7 + rand() * 0.5, dust[0], dust[1], dust[2], 0.5, 1, false, 0.6, 1.5);
    const ns = metal ? 7 : 3;
    for (let i = 0; i < ns; i++) spawn(x, y, z, nx * 3 + (rand() - 0.5) * 5, ny * 3 + rand() * 3, nz * 3 + (rand() - 0.5) * 5, 0.14 + rand() * 0.2, 0.07, 0.01, 3.2, 2.0, 0.8, 1, 0, true, 9, 1);
    spawn(x + nx * 0.04, y + ny * 0.04, z + nz * 0.04, 0, 0, 0, 0.06, 0.28, 0.1, 2.6, 1.9, 1.0, 1, 2, true, 0, 0);
  }
  function onEvent(ev, views, cam) {
    switch (ev.type) {
      case 'shot': {
        const v = views[ev.actor.id];
        const dx = ev.actor.x - cam.x, dz = ev.actor.z - cam.z, d2 = dx * dx + dz * dz;
        const mx = v ? v.muzzle.x : ev.mx, my = v ? v.muzzle.y : ev.my, mz = v ? v.muzzle.z : ev.mz;
        if (d2 < 230 * 230) {
          const len = Math.hypot(ev.hx - mx, ev.hy - my, ev.hz - mz);
          if (len > 2.5) tracers.push({ ax: mx, ay: my, az: mz, bx: ev.hx, by: ev.hy, bz: ev.hz, t: 0, dur: Math.min(0.16, Math.max(0.035, len / 420)), r: 2.6, g: 1.75, b: 0.75 });
          const s = W_FLASH[ev.weapon] || 0.7;
          spawn(mx, my, mz, 0, 0, 0, 0.045, s, s * 1.5, 3.6, 2.5, 1.1, 1, 2, true, 0, 0);
          spawn(mx, my, mz, 0, 0, 0, 0.06, s * 0.5, s * 0.9, 4.5, 3.6, 2.2, 1, 0, true, 0, 0);
          if (d2 < 60 * 60) spawn(mx, my, mz, (rand() - 0.5) * 0.5, 0.5 + rand() * 0.4, (rand() - 0.5) * 0.5, 0.7, 0.15, 0.7, 0.62, 0.62, 0.62, 0.22, 1, false, -0.2, 1.2);
          if (d2 < 45 * 45) core.flash(mx, my, mz, 9 + s * 9);
        }
        if (ev.hit === 'world' && d2 < 200 * 200) impact(ev.hx, ev.hy, ev.hz, ev.nx, ev.ny, ev.nz, ev.kind);
        break;
      }
      case 'damage':
        if (ev.zone !== 'zone') for (let i = 0; i < 4; i++) spawn(ev.x + (rand() - 0.5) * 0.2, ev.y - 0.35 + (rand() - 0.5) * 0.3, ev.z + (rand() - 0.5) * 0.2, (rand() - 0.5) * 1.6, rand() * 1.2, (rand() - 0.5) * 1.6, 0.3 + rand() * 0.2, 0.08, 0.34, 0.34, 0.035, 0.03, 0.75, 1, false, 4, 2);
        break;
      case 'wallHit': {
        const wl = ev.wall, c = Math.cos(wl.yaw), s = Math.sin(wl.yaw);
        const px = ev.x - wl.x, pz = ev.z - wl.z;
        const lx = px * c - pz * s, lz = px * s + pz * c;
        wl.hitU = Math.atan2(lx, WALL.ARC_RADIUS - lz) / WALL.ARC_ANGLE + 0.5; wl.hitV = (ev.y - wl.y) / WALL.HEIGHT; wl.viewHitT = performance.now();
        for (let i = 0; i < 5; i++) spawn(ev.x, ev.y, ev.z, (rand() - 0.5) * 4, rand() * 2.5, (rand() - 0.5) * 4, 0.2 + rand() * 0.25, 0.09, 0.01, 1.0, 2.6, 3.6, 1, 0, true, 7, 1);
        spawn(ev.x, ev.y, ev.z, 0, 0, 0, 0.09, 0.2, 0.7, 0.8, 2.2, 3.0, 1, 3, true, 0, 0);
        break;
      }
      case 'wallDeploy': {
        const wl = ev.wall;
        for (const b of wl.segs) for (let i = 0; i < 5; i++) spawn(b.x + (rand() - 0.5) * 0.6, wl.y + rand() * 0.4, b.z + (rand() - 0.5) * 0.6, (rand() - 0.5) * 2, 2.5 + rand() * 4, (rand() - 0.5) * 2, 0.35 + rand() * 0.3, 0.1, 0.01, 0.9, 2.4, 3.4, 1, 0, true, 5, 0.8);
        spawn(wl.x, wl.y + 1.1, wl.z, 0, 0, 0, 0.22, 1.2, 5.5, 0.5, 1.5, 2.2, 0.8, 3, true, 0, 0);
        for (let i = 0; i < 6; i++) spawn(wl.x + (rand() - 0.5) * 3.5, wl.y + 0.1, wl.z + (rand() - 0.5) * 3.5, (rand() - 0.5) * 1.5, 0.4 + rand() * 0.5, (rand() - 0.5) * 1.5, 0.8, 0.3, 1.3, 0.55, 0.52, 0.45, 0.35, 1, false, 0, 1.5);
        break;
      }
      case 'wallBreak': {
        const wl = ev.wall;
        if (ev.expired) break;
        for (const b of wl.segs) for (let i = 0; i < 9; i++) spawn(b.x + (rand() - 0.5) * 0.8, wl.y + rand() * WALL.HEIGHT, b.z + (rand() - 0.5) * 0.8, (rand() - 0.5) * 5, rand() * 3, (rand() - 0.5) * 5, 0.5 + rand() * 0.5, 0.16, 0.02, 0.9, 2.3, 3.2, 1, 0, true, 9, 0.6);
        spawn(wl.x, wl.y + 1.2, wl.z, 0, 0, 0, 0.16, 2.5, 6.5, 0.9, 2.2, 3.0, 0.9, 0, true, 0, 0);
        break;
      }
      case 'pickup': {
        const c = lootCols[ev.item] || lootCols.ammo;
        spawn(ev.x, ev.y + 0.4, ev.z, 0, 0.6, 0, 0.35, 0.4, 2.2, c.r * 2.2, c.g * 2.2, c.b * 2.2, 0.9, 3, true, 0, 0);
        for (let i = 0; i < 6; i++) spawn(ev.x, ev.y + 0.3, ev.z, (rand() - 0.5) * 2.4, 1 + rand() * 2.2, (rand() - 0.5) * 2.4, 0.4 + rand() * 0.3, 0.08, 0.01, c.r * 3, c.g * 3, c.b * 3, 1, 0, true, 3, 1);
        break;
      }
      case 'land': {
        const a = ev.actor, n = ev.drop ? 9 : 4;
        for (let i = 0; i < n; i++) spawn(a.x + (rand() - 0.5) * 0.6, a.y + 0.1, a.z + (rand() - 0.5) * 0.6, (rand() - 0.5) * 2.5, 0.3 + rand() * 0.6, (rand() - 0.5) * 2.5, 0.7 + rand() * 0.5, 0.25, 1.3, 0.55, 0.5, 0.4, 0.38, 1, false, 0, 2.0);
        break;
      }
      case 'kill': {
        const a = ev.victim;
        for (let i = 0; i < 6; i++) spawn(a.x + (rand() - 0.5) * 0.5, a.y + 0.6 + rand() * 0.6, a.z + (rand() - 0.5) * 0.5, (rand() - 0.5) * 1.5, 0.4 + rand() * 0.8, (rand() - 0.5) * 1.5, 0.9, 0.3, 1.5, 0.45, 0.42, 0.38, 0.3, 1, false, 0, 1.6);
        break;
      }
    }
  }

  function update(game, time, dt, camPos) {
    updateParticles(dt);
    updateTracers(dt);
    // walls
    const walls = game.walls, now = performance.now();
    let n = 0;
    for (let i = 0; i < walls.length && n < MAX_W; i++) {
      const wl = walls[i];
      wXf.setXYZW(n, wl.x, wl.y, wl.z, wl.yaw);
      wPr.setXYZW(n, Math.max(0, wl.hp / WALL.HP), wl.age, 0, wl.life);
      const ha = wl.viewHitT ? (now - wl.viewHitT) / 1000 : 9;
      wHit.setXYZ(n, wl.hitU || 0.5, wl.hitV || 0.5, Math.min(ha, 1));
      n++;
    }
    wallGeo.instanceCount = n;
    wXf.needsUpdate = true; wPr.needsUpdate = true; wHit.needsUpdate = true;
    wallMat.uniforms.uTime.value = time;
    // loot
    syncLoot(game);
    beamMat.uniforms.uTime.value = time; iconMat.uniforms.uTime.value = time;
    // zone
    const z = game.zone;
    zoneMesh.visible = z.r > 0.6;
    zoneMat.uniforms.uC.value.set(z.cx, z.cz); zoneMat.uniforms.uR.value = z.r; zoneMat.uniforms.uTime.value = time;
    // plane
    const f = game.flight, pt = game.time / 11;
    if (f && pt < 1.25) {
      plane.visible = true;
      plane.position.set(f.x0 + (f.x1 - f.x0) * pt, f.y, f.z0 + (f.z1 - f.z0) * pt);
      plane.rotation.y = Math.atan2(-f.dx, -f.dz);
    } else plane.visible = false;
    void camPos;
  }

  function reset() { parts.length = 0; tracers.length = 0; lootSig = -1; }

  // one invisible burst of every effect type so shaders are compiled before the first firefight
  function prewarm() {
    spawn(0, -400, 0, 0, 0, 0, 0.2, 1, 1, 1, 1, 1, 1, 0, true, 0, 0);
    spawn(0, -400, 0, 0, 0, 0, 0.2, 1, 1, 1, 1, 1, 1, 1, false, 0, 0);
    tracers.push({ ax: 0, ay: -400, az: 0, bx: 5, by: -400, bz: 0, t: 0, dur: 0.1, r: 1, g: 1, b: 1 });
  }

  return { group, update, onEvent, reset, prewarm, impact, spawn };
}

export { ZERO, ZONE_PHASES };
