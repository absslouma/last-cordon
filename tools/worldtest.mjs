// Generates the island and writes a top-down debug map (heights, nav grid, colliders, loot).
import { generateWorld } from '../src/sim/world.js';
import { writePNG } from './png.mjs';
import path from 'node:path';

const out = process.argv[2] || 'world-debug.png';
const t0 = performance.now();
const w = generateWorld();
const ms = performance.now() - t0;

const NN = 640;
let blocked = 0, water = 0;
for (let i = 0; i < NN * NN; i++) if (w.nav[i]) blocked++;
for (let i = 0; i < w.heights.length; i++) if (w.heights[i] < 0) water++;
console.log(`generated in ${ms.toFixed(0)} ms`);
console.log(`parts ${w.parts.length}  boxes ${w.boxes.length}  cyls ${w.cyls.length}  trees ${w.trees.length}  rocks ${w.rocks.length}  bushes ${w.bushes.length}`);
console.log(`doors ${w.doors.length}  portals ${w.portals.size}  loot points ${w.lootPoints.length}  footprints ${w.footprints.length}`);
console.log(`max height ${w.maxHeight.toFixed(1)}  water verts ${(100 * water / w.heights.length).toFixed(0)}%  nav blocked ${(100 * blocked / (NN * NN)).toFixed(0)}%`);
for (const p of w.pois) console.log(`  ${p.name.padEnd(14)} (${p.x}, ${p.z}) r${p.r}  h=${p.h.toFixed(1)}  ground=${w.heightAt(p.x, p.z).toFixed(1)}`);

// raycast sanity + timing
let hits = 0;
const t1 = performance.now();
const o = { t: 0 };
for (let i = 0; i < 20000; i++) {
  const a = i * 0.7137, r = (i % 200) + 5;
  const ox = Math.cos(a * 0.37) * 150, oz = Math.sin(a * 0.91) * 150;
  const oy = w.heightAt(ox, oz) + 1.5;
  const dx = Math.cos(a), dz = Math.sin(a);
  if (w.raycast(ox, oy, oz, dx, 0, dz, r, o) >= 0) hits++;
}
console.log(`20000 rays: ${(performance.now() - t1).toFixed(0)} ms, ${hits} hits`);

const SC = 2, W = NN * SC;
const img = new Uint8Array(W * W * 4);
function px(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const i = (y * W + x) * 4; img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
}
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const wx = (x + 0.5) / SC - 320, wz = (y + 0.5) / SC - 320;
    const h = w.heightAt(wx, wz);
    let r, g, b;
    if (h < 0) { const d = Math.min(1, -h / 8); r = 30 - 20 * d; g = 90 - 40 * d; b = 130 - 40 * d; }
    else if (h < 1.5) { r = 200; g = 190; b = 140; }
    else { const s = Math.min(1, h / 30); r = 60 + 110 * s; g = 110 + 60 * s; b = 50 + 60 * s; }
    const shade = 1 + (w.heightAt(wx - 1.5, wz - 1.5) - w.heightAt(wx + 1.5, wz + 1.5)) * 0.12;
    r = Math.max(0, Math.min(255, r * shade)); g = Math.max(0, Math.min(255, g * shade)); b = Math.max(0, Math.min(255, b * shade));
    if (h >= -0.85 && w.nav[Math.floor(wz + 320) * NN + Math.floor(wx + 320)]) { r = r * 0.45 + 90; g *= 0.45; b *= 0.45; }
    px(x, y, r, g, b);
  }
}
for (const t of w.trees) { const x = Math.round((t.x + 320) * SC), y = Math.round((t.z + 320) * SC); const c = t.type === 0 ? [20, 90, 30] : [10, 60, 20]; px(x, y, ...c); px(x + 1, y, ...c); px(x, y + 1, ...c); px(x + 1, y + 1, ...c); }
for (const pts of w.paths) for (let k = 0; k < pts.length - 1; k++) for (let t = 0; t <= 1; t += 0.004) px(Math.round((pts[k][0] + (pts[k + 1][0] - pts[k][0]) * t + 320) * SC), Math.round((pts[k][1] + (pts[k + 1][1] - pts[k][1]) * t + 320) * SC), 150, 120, 80);
for (const l of w.lootPoints) { const x = Math.round((l.x + 320) * SC), y = Math.round((l.z + 320) * SC); for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) px(x + a, y + b, 255, l.indoor ? 220 : 120, 0); }
for (const d of w.doors) { const x = Math.round((d.x + 320) * SC), y = Math.round((d.z + 320) * SC); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) px(x + a, y + b, 0, 255, 255); }
writePNG(path.resolve(out), W, W, img);
console.log('wrote', path.resolve(out));
