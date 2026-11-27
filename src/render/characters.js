// Operators: twenty soldiers drawn with a handful of instanced meshes. Each body is a set of
// rigid parts posed procedurally every frame (two-bone IK for arms and legs, weapon-driven hands,
// stride cycle from the sim, crouch, parachute, swim and death poses). No skinning, no assets.
import * as THREE from 'three';
import { Buf } from './world3d.js';
import { WEAPONS } from '../sim/config.js';

const V = () => new THREE.Vector3();
const F = V(), R = V(), U = V(), P = V(), Tu = V(), Tf = V(), Nk = V(), Af = V(), Au = V(), Ar = V();
const gun = V(), handR = V(), handL = V(), sh = V(), hip = V(), foot = V(), elbow = V(), knee = V(), pole = V(), D = V();
const t0 = V(), t1 = V(), t2 = V(), X = V(), Y = V(), Z = V();
const M = new THREE.Matrix4(), ZERO = new THREE.Matrix4().makeScale(0, 0, 0), COL = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

function basis(m, pos, x, y, z) {
  m.set(x.x, y.x, z.x, pos.x, x.y, y.y, z.y, pos.y, x.z, y.z, z.z, pos.z, 0, 0, 0, 1);
  return m;
}
// Part extends along local -Y from a to b; local -Z is kept as close to `fwd` as possible.
function segment(m, a, b, fwd) {
  Y.subVectors(a, b);
  if (Y.lengthSq() < 1e-8) Y.set(0, 1, 0);
  Y.normalize();
  Z.copy(fwd).multiplyScalar(-1);
  Z.addScaledVector(Y, -Z.dot(Y));
  if (Z.lengthSq() < 1e-6) { Z.set(1, 0, 0); Z.addScaledVector(Y, -Z.dot(Y)); }
  Z.normalize();
  X.crossVectors(Y, Z);
  return basis(m, a, X, Y, Z);
}
// Two-bone IK: joint position for a chain root->target with lengths l1,l2, bending toward `pl`.
function ik(out, root, target, l1, l2, pl) {
  t0.subVectors(target, root);
  let d = t0.length();
  const max = l1 + l2 - 0.004, min = Math.abs(l1 - l2) + 0.004;
  if (d > max) { t0.multiplyScalar(max / d); d = max; target.copy(root).add(t0); }
  else if (d < min) d = min;
  t0.normalize();
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  t1.copy(pl).addScaledVector(t0, -pl.dot(t0));
  if (t1.lengthSq() < 1e-6) t1.set(0, 0, 1).addScaledVector(t0, -t0.z);
  t1.normalize();
  return out.copy(root).addScaledVector(t0, a).addScaledVector(t1, h);
}

// ---------------------------------------------------------------------------- part geometry
const C = (r, g, b) => ({ r, g, b });
const GREY = C(1, 1, 1);
function box(buf, sx, sy, sz, x, y, z, col, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  M.makeRotationFromEuler(new THREE.Euler(rx, ry, rz)).setPosition(x, y, z);
  buf.add(g, M, col, 1, 1);
  g.dispose();
}
function cylZ(buf, r, len, x, y, z, col, r2) {
  const g = new THREE.CylinderGeometry(r2 == null ? r : r2, r, len, 8, 1);
  M.makeRotationX(Math.PI / 2).setPosition(x, y, z);
  buf.add(g, M, col, 1, 1);
  g.dispose();
}
function capsule(buf, r, len, x, y, z, col, sx = 1, sz = 1) {
  const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), 3, 7);
  M.makeScale(sx, 1, sz).setPosition(x, y, z);
  buf.add(g, M, col, 2, 2);
  g.dispose();
}

function makeParts() {
  const p = {};
  let b = new Buf();
  capsule(b, 0.165, 0.5, 0, 0.26, 0, GREY, 1.16, 0.8);            // torso cloth
  box(b, 0.33, 0.14, 0.2, 0, 0.02, 0, C(0.9, 0.9, 0.9));
  p.torso = b.build();

  b = new Buf();                                                    // plate carrier, pouches, pack
  const gd = C(0.82, 0.82, 0.82), gk = C(0.5, 0.5, 0.5);
  box(b, 0.31, 0.33, 0.075, 0, 0.345, -0.125, gd, -0.06);
  box(b, 0.31, 0.35, 0.065, 0, 0.345, 0.125, gd, 0.04);
  box(b, 0.385, 0.15, 0.27, 0, 0.2, 0, gk);
  for (let i = -1; i <= 1; i++) box(b, 0.078, 0.135, 0.055, i * 0.095, 0.2, -0.175, gd);
  box(b, 0.07, 0.1, 0.05, -0.2, 0.2, -0.06, gk); box(b, 0.06, 0.13, 0.045, 0.2, 0.2, 0.02, gk);
  box(b, 0.27, 0.37, 0.15, 0, 0.36, 0.225, gd); box(b, 0.2, 0.16, 0.07, 0, 0.3, 0.32, gk);
  box(b, 0.37, 0.06, 0.24, 0, 0.03, 0, C(0.3, 0.3, 0.3));
  box(b, 0.055, 0.03, 0.26, -0.11, 0.515, 0, gk); box(b, 0.055, 0.03, 0.26, 0.11, 0.515, 0, gk);
  box(b, 0.09, 0.05, 0.05, 0.1, 0.44, -0.165, C(0.25, 0.25, 0.25));
  p.torsoGear = b.build();

  b = new Buf();                                                    // head: balaclava, helmet, goggles, ear pro
  capsule(b, 0.05, 0.12, 0, 0.04, 0, C(0.24, 0.24, 0.24));
  { const g = new THREE.SphereGeometry(0.105, 9, 7); M.makeScale(0.94, 1.08, 1.0).setPosition(0, 0.165, -0.005); b.add(g, M, C(0.26, 0.25, 0.24), 1, 1); g.dispose(); }
  { const g = new THREE.SphereGeometry(0.128, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.56); M.makeScale(1.0, 0.92, 1.1).setPosition(0, 0.19, 0.004); b.add(g, M, C(0.86, 0.86, 0.86), 2, 2); g.dispose(); }
  box(b, 0.2, 0.052, 0.05, 0, 0.163, -0.092, C(0.1, 0.1, 0.11));
  box(b, 0.05, 0.045, 0.06, 0, 0.275, -0.115, C(0.2, 0.2, 0.2));
  for (const s of [-1, 1]) { const g = new THREE.CylinderGeometry(0.04, 0.04, 0.035, 8); M.makeRotationZ(Math.PI / 2).setPosition(s * 0.112, 0.16, 0.012); b.add(g, M, C(0.3, 0.3, 0.3), 1, 1); g.dispose(); }
  p.head = b.build();

  b = new Buf(); capsule(b, 0.054, 0.31, 0, -0.145, 0, GREY); box(b, 0.1, 0.07, 0.11, 0, -0.03, 0, C(0.72, 0.72, 0.72)); p.upperArm = b.build();
  b = new Buf(); capsule(b, 0.046, 0.28, 0, -0.135, 0, GREY); box(b, 0.082, 0.1, 0.095, 0, -0.3, -0.01, C(0.2, 0.2, 0.2)); p.lowerArm = b.build();
  b = new Buf(); capsule(b, 0.084, 0.46, 0, -0.22, 0, GREY, 1.0, 1.05); box(b, 0.1, 0.13, 0.06, 0.07, -0.2, 0, C(0.5, 0.5, 0.5)); p.upperLeg = b.build();
  b = new Buf();
  capsule(b, 0.063, 0.42, 0, -0.2, 0, GREY);
  box(b, 0.105, 0.115, 0.275, 0, -0.455, -0.055, C(0.16, 0.15, 0.14));        // boot
  box(b, 0.11, 0.1, 0.11, 0, -0.34, 0.005, C(0.17, 0.16, 0.15));
  box(b, 0.1, 0.12, 0.05, 0, -0.03, -0.06, C(0.3, 0.3, 0.3));                // knee pad
  p.lowerLeg = b.build();

  // weapons: origin at the grip, barrel toward -Z
  const dk = C(0.2, 0.2, 0.21), md = C(0.34, 0.34, 0.35), tn = C(0.55, 0.47, 0.36);
  b = new Buf();                                                    // assault rifle
  box(b, 0.05, 0.075, 0.24, 0, 0.01, -0.03, dk); box(b, 0.048, 0.058, 0.27, 0, 0.012, -0.28, tn);
  cylZ(b, 0.0115, 0.2, 0, 0.012, -0.5, md); cylZ(b, 0.017, 0.055, 0, 0.012, -0.615, dk);
  box(b, 0.042, 0.068, 0.2, 0, -0.005, 0.19, dk); box(b, 0.046, 0.11, 0.03, 0, -0.012, 0.3, md);
  box(b, 0.036, 0.105, 0.046, 0, -0.075, 0.035, dk, 0.25); box(b, 0.03, 0.17, 0.062, 0, -0.115, -0.085, md, -0.16);
  box(b, 0.03, 0.012, 0.46, 0, 0.052, -0.13, dk); box(b, 0.042, 0.048, 0.075, 0, 0.082, -0.06, dk);
  box(b, 0.03, 0.04, 0.02, 0, 0.07, -0.39, dk); box(b, 0.03, 0.09, 0.035, 0, -0.06, -0.25, dk);
  p.ar = b.build();
  b = new Buf();                                                    // submachine gun
  box(b, 0.052, 0.085, 0.22, 0, 0.012, -0.04, dk); cylZ(b, 0.023, 0.13, 0, 0.015, -0.21, md);
  cylZ(b, 0.011, 0.05, 0, 0.015, -0.3, dk); box(b, 0.034, 0.1, 0.044, 0, -0.075, 0.03, dk, 0.22);
  box(b, 0.028, 0.21, 0.046, 0, -0.14, -0.09, md); box(b, 0.022, 0.03, 0.2, 0, 0.02, 0.17, md);
  box(b, 0.04, 0.085, 0.022, 0, 0.0, 0.275, dk); box(b, 0.03, 0.012, 0.2, 0, 0.06, -0.04, dk);
  box(b, 0.034, 0.036, 0.05, 0, 0.082, -0.02, dk); box(b, 0.028, 0.075, 0.03, 0, -0.05, -0.19, dk);
  p.smg = b.build();
  b = new Buf();                                                    // sniper rifle
  box(b, 0.052, 0.07, 0.32, 0, 0.01, -0.06, dk); cylZ(b, 0.0125, 0.62, 0, 0.018, -0.53, md);
  box(b, 0.034, 0.04, 0.075, 0, 0.018, -0.87, dk); box(b, 0.046, 0.058, 0.3, 0, 0.004, -0.33, tn);
  box(b, 0.046, 0.095, 0.3, 0, -0.012, 0.25, tn); box(b, 0.04, 0.03, 0.14, 0, 0.055, 0.22, dk);
  box(b, 0.05, 0.12, 0.03, 0, -0.012, 0.41, dk); box(b, 0.036, 0.1, 0.046, 0, -0.075, 0.05, dk, 0.2);
  box(b, 0.03, 0.09, 0.07, 0, -0.07, -0.06, md);
  cylZ(b, 0.027, 0.3, 0, 0.092, -0.08, dk); cylZ(b, 0.036, 0.07, 0, 0.092, -0.265, dk, 0.027); cylZ(b, 0.031, 0.05, 0, 0.092, 0.095, dk);
  box(b, 0.02, 0.03, 0.03, 0, 0.06, -0.15, dk); box(b, 0.02, 0.03, 0.03, 0, 0.06, -0.01, dk);
  box(b, 0.014, 0.014, 0.24, -0.03, -0.03, -0.42, md); box(b, 0.014, 0.014, 0.24, 0.03, -0.03, -0.42, md);
  p.sr = b.build();

  // parachute: canopy with alternating gores plus suspension lines, origin at the harness
  b = new Buf();
  {
    const segs = 14, rad = 3.3, top = 5.6, rim = 4.35;
    const cA = C(0.36, 0.4, 0.3), cB = C(0.2, 0.22, 0.2);
    const apex = () => 0;
    void apex;
    for (let k = 0; k < segs; k++) {
      const a0 = (k / segs) * Math.PI * 2, a1 = ((k + 1) / segs) * Math.PI * 2, col = k % 2 ? cA : cB;
      const ring = (a, t) => { const r = rad * Math.sin(t * Math.PI * 0.5), y = rim + (top - rim) * Math.cos(t * Math.PI * 0.5); return [Math.cos(a) * r, y, Math.sin(a) * r]; };
      for (let s = 0; s < 4; s++) {
        const ta = s / 4, tb = (s + 1) / 4;
        const p0 = ring(a0, ta), p1 = ring(a1, ta), p2 = ring(a1, tb), p3 = ring(a0, tb);
        const ids = [p0, p1, p2, p3].map((q) => b.vert(q[0], q[1], q[2], q[0] / rad, 0.6, q[2] / rad, 0, 0, col.r, col.g, col.b));
        b.quad(ids[0], ids[3], ids[2], ids[1]);
      }
      if (k % 2 === 0) { // line from the rim down to a riser
        const e = [Math.cos(a0) * rad, rim, Math.sin(a0) * rad], s2 = [Math.cos(a0) * 0.22, 1.62, Math.sin(a0) * 0.1], w = 0.012;
        const ids = [b.vert(e[0] - w, e[1], e[2], 0, 0, 1, 0, 0, 0.6, 0.6, 0.55), b.vert(e[0] + w, e[1], e[2], 0, 0, 1, 0, 0, 0.6, 0.6, 0.55), b.vert(s2[0] + w, s2[1], s2[2], 0, 0, 1, 0, 0, 0.6, 0.6, 0.55), b.vert(s2[0] - w, s2[1], s2[2], 0, 0, 1, 0, 0, 0.6, 0.6, 0.55)];
        b.quad(ids[0], ids[1], ids[2], ids[3]);
      }
    }
  }
  p.chute = b.build();
  return p;
}

const UNIFORMS = [[0.62, 0.72, 0.45], [1.0, 0.86, 0.62], [0.7, 0.72, 0.76], [0.4, 0.44, 0.52], [0.55, 0.58, 0.36], [0.3, 0.31, 0.33], [0.78, 0.7, 0.5], [0.5, 0.62, 0.5]];
const GEARS = [[0.6, 0.5, 0.36], [0.36, 0.42, 0.3], [0.17, 0.17, 0.18], [0.42, 0.43, 0.45], [0.5, 0.44, 0.34]];
const MUZZLE_LEN = [0.66, 0.34, 0.92];
const LEFT_GRIP = [0.3, 0.19, 0.36];

export function createCharacters(core, T, count) {
  const parts = makeParts();
  const camo = new THREE.MeshStandardMaterial({ map: T.camo.map, normalMap: T.camo.normalMap, roughness: 0.92, metalness: 0, vertexColors: true });
  const gear = new THREE.MeshStandardMaterial({ map: T.canvas.map, normalMap: T.canvas.normalMap, roughness: 0.82, metalness: 0.05, vertexColors: true });
  const steel = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.8, vertexColors: true });
  const silk = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, vertexColors: true, side: THREE.DoubleSide });
  const group = new THREE.Group();
  const mk = (geo, mat, n, cast = true) => {
    const im = new THREE.InstancedMesh(geo, mat, n);
    im.frustumCulled = false; im.castShadow = cast; im.receiveShadow = true;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < n; i++) { im.setMatrixAt(i, ZERO); im.setColorAt(i, COL.setRGB(1, 1, 1)); }
    group.add(im);
    return im;
  };
  const im = {
    torso: mk(parts.torso, camo, count), torsoGear: mk(parts.torsoGear, gear, count, false), head: mk(parts.head, gear, count),
    upperArm: mk(parts.upperArm, camo, count * 2, false), lowerArm: mk(parts.lowerArm, camo, count * 2, false),
    upperLeg: mk(parts.upperLeg, camo, count * 2), lowerLeg: mk(parts.lowerLeg, camo, count * 2),
    w: [mk(parts.ar, steel, count, false), mk(parts.smg, steel, count, false), mk(parts.sr, steel, count, false)],
    chute: mk(parts.chute, silk, count),
  };
  // weapons and canopies are packed into the first N instance slots so unused ones cost nothing
  const wN = [0, 0, 0];
  let cN = 0;
  const views = [];
  for (let i = 0; i < count; i++) {
    const u = i === 0 ? [0.72, 0.74, 0.6] : UNIFORMS[(i * 5 + 1) % UNIFORMS.length], g = i === 0 ? [0.5, 0.43, 0.31] : GEARS[(i * 3) % GEARS.length];
    COL.setRGB(u[0], u[1], u[2]);
    im.torso.setColorAt(i, COL);
    for (const m of [im.upperArm, im.lowerArm, im.upperLeg, im.lowerLeg]) { m.setColorAt(i * 2, COL); m.setColorAt(i * 2 + 1, COL); }
    COL.setRGB(g[0], g[1], g[2]);
    im.torsoGear.setColorAt(i, COL); im.head.setColorAt(i, COL);
    views.push({ crouch: 0, dead: 0, flinch: 0, lean: 0, vf: 0, vr: 0, air: 0, chute: 1, kick: 0, lastShots: 0, lastHp: 100, muzzle: new THREE.Vector3(), head: new THREE.Vector3(), seed: (i * 0.618) % 1, sprint: 0 });
  }
  for (const k of Object.keys(im)) for (const m of Array.isArray(im[k]) ? im[k] : [im[k]]) if (m.instanceColor) m.instanceColor.needsUpdate = true;

  function hideActor(i) {
    im.torso.setMatrixAt(i, ZERO); im.torsoGear.setMatrixAt(i, ZERO); im.head.setMatrixAt(i, ZERO);
    for (const m of [im.upperArm, im.lowerArm, im.upperLeg, im.lowerLeg]) { m.setMatrixAt(i * 2, ZERO); m.setMatrixAt(i * 2 + 1, ZERO); }
  }

  function pose(a, i, x, y, z, time, dt, hide) {
    const v = views[i];
    const dead = !a.alive;
    const k = Math.min(1, dt * 10);
    v.crouch += ((a.crouch ? 1 : 0) - v.crouch) * k;
    v.dead += ((dead ? 1 : 0) - v.dead) * Math.min(1, dt * 4.2);
    v.air += (((!a.onGround && a.state !== 'drop') ? 1 : 0) - v.air) * k;
    v.sprint += ((a.sprinting ? 1 : 0) - v.sprint) * Math.min(1, dt * 7);
    v.chute += ((a.state === 'drop' ? 1 : 0) - v.chute) * Math.min(1, dt * 6);
    if (a.shots !== v.lastShots) { v.kick = 1; v.lastShots = a.shots; }
    v.kick = Math.max(0, v.kick - dt * 11);
    if (a.hp < v.lastHp - 0.5) v.flinch = 1;
    v.lastHp = a.hp; v.flinch = Math.max(0, v.flinch - dt * 5);
    if (hide) { hideActor(i); v.muzzle.set(x, y + 1.45, z); v.head.set(x, y + 1.6, z); return; }

    const sy = Math.sin(a.yaw), cy = Math.cos(a.yaw);
    F.set(-sy, 0, -cy); R.set(cy, 0, -sy); U.set(0, 1, 0);
    const drop = v.chute, swim = a.swimming ? 1 : 0;
    // velocity in the body frame, smoothed
    const vf = a.vx * F.x + a.vz * F.z, vr = a.vx * R.x + a.vz * R.z;
    v.vf += (vf - v.vf) * k; v.vr += (vr - v.vr) * k;
    const sp = Math.hypot(v.vf, v.vr), run = Math.min(1, sp / 7);
    // falling over: tip the whole frame backwards about the feet
    let rootY = y;
    if (v.dead > 0.001) {
      const e = v.dead * v.dead * (3 - 2 * v.dead), th = e * 1.5;
      const c = Math.cos(th), s = Math.sin(th);
      t0.copy(U); U.set(-F.x * s, c, -F.z * s); F.set(F.x * c, s, F.z * c);
      rootY += 0.14 * s;
    } else if (drop > 0.01) { // swing under the canopy
      const tilt = Math.min(0.5, sp * 0.03) * drop;
      if (sp > 0.5) { D.set(a.vx / sp, 0, a.vz / sp); U.addScaledVector(D, tilt).normalize(); F.addScaledVector(U, -F.dot(U)).normalize(); R.crossVectors(F, U); }
    }
    const ph = a.animPhase, idle = Math.sin(time * 1.6 + v.seed * 6.28);
    const moving = sp > 0.4 && !dead && a.onGround ? 1 : 0;
    const hipH = (0.93 - 0.33 * v.crouch) * (1 - 0.0 * v.dead) + moving * Math.abs(Math.sin(ph)) * 0.035 * (0.5 + run) + idle * 0.004 - v.flinch * 0.03;
    const lean = (0.06 + 0.2 * run * (v.vf > 0 ? 1 : -0.4) + 0.22 * v.crouch + 0.16 * v.sprint) * (1 - v.dead) + swim * 0.5 - drop * 0.12;
    const pitch = dead ? 0 : Math.max(-1.1, Math.min(1.1, a.pitch));
    const tl = lean - pitch * 0.42 * (1 - drop) - v.flinch * 0.12;
    P.set(x, rootY, z).addScaledVector(U, hipH).addScaledVector(R, moving * Math.sin(ph) * 0.012);
    Tu.copy(U).multiplyScalar(Math.cos(tl)).addScaledVector(F, Math.sin(tl));
    Tf.copy(F).multiplyScalar(Math.cos(tl)).addScaledVector(U, -Math.sin(tl));
    // twist the torso a little into strafes
    const roll = Math.max(-0.14, Math.min(0.14, v.vr * 0.025));
    Ar.copy(R).multiplyScalar(Math.cos(roll)).addScaledVector(Tu, -Math.sin(roll));
    t2.copy(Tu).multiplyScalar(Math.cos(roll)).addScaledVector(R, Math.sin(roll));
    Tu.copy(t2);
    Z.copy(Tf).multiplyScalar(-1);
    im.torso.setMatrixAt(i, basis(M, P, Ar, Tu, Z));
    im.torsoGear.setMatrixAt(i, M);
    Nk.copy(P).addScaledVector(Tu, 0.555);
    // head follows the aim
    const hp = dead ? -0.3 : pitch * 0.55 - lean * 0.5;
    t0.copy(F).multiplyScalar(Math.cos(hp)).addScaledVector(U, Math.sin(hp));
    t1.copy(U).multiplyScalar(Math.cos(hp)).addScaledVector(F, -Math.sin(hp));
    Z.copy(t0).multiplyScalar(-1);
    im.head.setMatrixAt(i, basis(M, Nk, R, t1, Z));
    v.head.copy(Nk).addScaledVector(t1, 0.17);

    // legs
    if (sp > 0.3) D.copy(F).multiplyScalar(v.vf / sp).addScaledVector(R, v.vr / sp); else D.copy(F);
    const stride = Math.min(0.5, sp * 0.078) * moving, lift = Math.min(0.2, sp * 0.032) * moving;
    for (let s = 0; s < 2; s++) {
      const sd = s === 0 ? 1 : -1, pp = ph + (s === 0 ? 0 : Math.PI);
      hip.copy(P).addScaledVector(Ar, sd * 0.098).addScaledVector(Tu, -0.03);
      foot.set(x, rootY, z).addScaledVector(R, sd * (0.115 + 0.05 * v.crouch)).addScaledVector(U, 0.1);
      if (dead) foot.addScaledVector(F, -0.05 * sd).addScaledVector(R, sd * 0.12);
      else if (drop > 0.5) { foot.copy(hip).addScaledVector(U, -0.78).addScaledVector(F, 0.16 + sd * 0.06 + Math.sin(time * 2 + s) * 0.03); }
      else if (swim) { foot.copy(hip).addScaledVector(U, -0.6).addScaledVector(F, -0.45 + Math.sin(time * 5 + s * 3.14) * 0.22); }
      else if (v.air > 0.5) { foot.copy(hip).addScaledVector(U, -0.62).addScaledVector(F, sd * 0.14 - 0.05); }
      else {
        foot.addScaledVector(D, Math.sin(pp) * stride + sd * 0.07 * v.crouch).addScaledVector(U, Math.max(0, Math.cos(pp)) * lift);
        foot.addScaledVector(F, -0.03 + 0.1 * lean);
      }
      pole.copy(F).addScaledVector(R, sd * 0.25).addScaledVector(U, 0.2);
      ik(knee, hip, foot, 0.445, 0.44, pole);
      im.upperLeg.setMatrixAt(i * 2 + s, segment(M, hip, knee, F));
      im.lowerLeg.setMatrixAt(i * 2 + s, segment(M, knee, foot, F));
    }

    // weapon and arms
    const wi = a.cur, armed = wi >= 0 && !dead && drop < 0.5;
    const ads = a.ads || 0;
    const ap = pitch * (1 - 0.75 * v.sprint) - 0.5 * v.sprint * (1 - ads);
    Af.copy(F).multiplyScalar(Math.cos(ap)).addScaledVector(U, Math.sin(ap));
    Au.copy(U).multiplyScalar(Math.cos(ap)).addScaledVector(F, -Math.sin(ap));
    const yawOff = -0.55 * v.sprint * (1 - ads);
    if (Math.abs(yawOff) > 0.001) { t0.copy(Af).multiplyScalar(Math.cos(yawOff)).addScaledVector(R, Math.sin(yawOff)); Af.copy(t0).normalize(); }
    Ar.crossVectors(Af, Au).normalize();
    const rel = a.reloadT > 0 && wi >= 0 ? Math.sin(Math.min(1, 1 - a.reloadT / WEAPONS[wi].reload) * Math.PI) : 0;
    const heal = a.healT > 0 ? 1 : 0;
    for (let s = 0; s < 2; s++) { // shoulders (s=0 right)
      const sd = s === 0 ? 1 : -1;
      sh.copy(P).addScaledVector(Tu, 0.475).addScaledVector(R, sd * 0.195);
      if (s === 0) handR.copy(sh); else handL.copy(sh);
    }
    if (armed) {
      t0.copy(P).addScaledVector(Tu, 0.4).addScaledVector(R, 0.13).addScaledVector(Af, 0.3).addScaledVector(Au, -0.02 - 0.08 * heal);
      t1.copy(Nk).addScaledVector(Au, 0.105).addScaledVector(R, 0.055).addScaledVector(Af, 0.27);
      gun.copy(t0).lerp(t1, ads).addScaledVector(Af, -0.045 * v.kick).addScaledVector(Au, 0.012 * v.kick - 0.05 * rel);
      const rl = 0.35 * rel + 0.25 * heal;
      X.copy(Ar).multiplyScalar(Math.cos(rl)).addScaledVector(Au, Math.sin(rl));
      Y.copy(Au).multiplyScalar(Math.cos(rl)).addScaledVector(Ar, -Math.sin(rl));
      Z.copy(Af).multiplyScalar(-1);
      im.w[wi].setMatrixAt(wN[wi]++, basis(M, gun, X, Y, Z));
      v.muzzle.copy(gun).addScaledVector(Af, MUZZLE_LEN[wi]).addScaledVector(Au, 0.015);
      handR.copy(gun).addScaledVector(Au, -0.055).addScaledVector(Af, -0.03);
      handL.copy(gun).addScaledVector(Af, LEFT_GRIP[wi]).addScaledVector(Au, -0.035);
      if (rel > 0) handL.lerp(t0.copy(gun).addScaledVector(Au, -0.2).addScaledVector(Af, 0.05), rel);
      if (heal) handL.copy(P).addScaledVector(Tu, 0.3).addScaledVector(F, 0.2).addScaledVector(R, -0.05);
    } else {
      v.muzzle.copy(Nk).addScaledVector(F, 0.4);
      for (let s = 0; s < 2; s++) {
        const sd = s === 0 ? 1 : -1, hnd = s === 0 ? handR : handL;
        if (drop > 0.5) hnd.addScaledVector(U, 0.36).addScaledVector(R, sd * 0.1).addScaledVector(F, 0.06);
        else if (dead) hnd.addScaledVector(U, -0.1).addScaledVector(R, sd * 0.42).addScaledVector(F, 0.08);
        else if (swim) hnd.addScaledVector(F, 0.4 + Math.sin(time * 5 + s * 3.14) * 0.15).addScaledVector(R, sd * 0.2).addScaledVector(U, -0.12);
        else hnd.addScaledVector(U, -0.5).addScaledVector(R, sd * 0.07).addScaledVector(D, -sd * Math.sin(ph) * stride * 0.7 + 0.06);
      }
    }
    for (let s = 0; s < 2; s++) {
      const sd = s === 0 ? 1 : -1, hnd = s === 0 ? handR : handL;
      sh.copy(P).addScaledVector(Tu, 0.475).addScaledVector(R, sd * 0.195);
      pole.copy(U).multiplyScalar(-1).addScaledVector(R, sd * 0.7).addScaledVector(F, -0.2);
      ik(elbow, sh, hnd, 0.3, 0.29, pole);
      im.upperArm.setMatrixAt(i * 2 + s, segment(M, sh, elbow, F));
      im.lowerArm.setMatrixAt(i * 2 + s, segment(M, elbow, hnd, F));
    }
    // canopy
    if (v.chute > 0.02 && !dead) {
      const c = v.chute, wob = Math.sin(time * 1.3 + v.seed * 9) * 0.04;
      t0.set(x, y, z);
      X.copy(R).multiplyScalar(c); Y.copy(U).addScaledVector(R, wob).normalize().multiplyScalar(0.4 + 0.6 * c); Z.copy(F).multiplyScalar(-c);
      im.chute.setMatrixAt(cN++, basis(M, t0, X, Y, Z));
    }
  }

  function update(game, alpha, time, dt, hideId) {
    const actors = game.actors;
    wN[0] = wN[1] = wN[2] = 0; cN = 0;
    for (let i = 0; i < actors.length && i < count; i++) {
      const a = actors[i];
      const x = a.px + (a.x - a.px) * alpha, y = a.py + (a.y - a.py) * alpha, z = a.pz + (a.z - a.pz) * alpha;
      pose(a, i, x, y, z, time, dt, a.id === hideId);
    }
    for (let w = 0; w < 3; w++) im.w[w].count = wN[w];
    im.chute.count = cN;
    for (const k of Object.keys(im)) for (const m of Array.isArray(im[k]) ? im[k] : [im[k]]) m.instanceMatrix.needsUpdate = true;
  }

  function reset() {
    for (const v of views) { v.crouch = 0; v.dead = 0; v.flinch = 0; v.chute = 1; v.kick = 0; v.lastShots = 0; v.lastHp = 100; v.vf = 0; v.vr = 0; v.air = 0; v.sprint = 0; }
  }

  return { group, update, reset, views };
}
