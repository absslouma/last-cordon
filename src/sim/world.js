// Island generation for LAST CORDON: terrain heightmap, points of interest, buildings, props,
// vegetation, collision volumes, spatial index and navigation grid.
// Pure data + math (no DOM, no three.js) so the same world drives the sim in Node and the renderer.
import { mulberry32, fbm, ridged, clamp, lerp, smoothstep } from './rng.js';
import { WORLD } from './config.js';

export const MAT = {
  CONCRETE: 0, METAL: 1, WOOD: 2, PLASTER: 3, ROOFTILE: 4, GLASS: 5, CONTAINER: 6,
  SANDBAG: 7, CRATE: 8, RUSTY: 9, DARK: 10, PAINT: 11, CANVAS: 12,
};
export const MAT_COUNT = 13;

const GC = 8;                      // spatial grid cell (m)
const GN = WORLD.SIZE / GC;        // 80 cells per side

const POI_DEFS = [
  { id: 'meridian', name: 'MERIDIAN', x: 0, z: 0, r: 48, h: 4.2 },
  { id: 'freight', name: 'FREIGHT YARD', x: 150, z: 22, r: 56, h: 2.6 },
  { id: 'tidewater', name: 'TIDEWATER', x: -95, z: 160, r: 40, h: 2.1 },
  { id: 'radar', name: 'RADAR RIDGE', x: -125, z: -120, r: 25, h: null },
  { id: 'depot', name: 'FUEL DEPOT', x: 95, z: -150, r: 33, h: 3.0 },
  { id: 'westcamp', name: 'WEST CAMP', x: -176, z: 26, r: 20, h: null },
  { id: 'southcamp', name: 'SOUTH CAMP', x: 36, z: 150, r: 22, h: null },
  { id: 'northfield', name: 'NORTHFIELD', x: 14, z: -98, r: 22, h: null },
  { id: 'sentinel', name: 'SENTINEL HILL', x: 118, z: 128, r: 15, h: null },
];

const LONE_SHACKS = [
  [-62, -44, 0.6], [72, -62, 2.2], [-44, 84, 4.1], [84, 78, 1.1], [-205, -48, 0.2],
  [196, -72, 3.0], [-34, -188, 5.2], [176, 150, 2.6], [-146, 92, 1.7], [58, -214, 0.9],
  [-92, 22, 3.6], [62, 28, 5.6], [-18, 62, 2.0], [108, -62, 4.4],
];

const CONTAINER_TINTS = [0x8c3b2e, 0x2f5d7c, 0x3f6b45, 0x8a7a3a, 0x6f7376, 0x9b4d2a, 0x34495e];
const PLASTER_TINTS = [0xd9cfb8, 0xcfc4a6, 0xbfc9c2, 0xd8bfa5, 0xc9c0b0, 0xb9b3a2];
const WOOD_TINTS = [0x8d6e4c, 0x7a5c3e, 0x96785a, 0x6e5540];

function gauss(dx, dz, sigma) { return Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma)); }

export function generateWorld(seed = WORLD.SEED) {
  const rng = mulberry32(seed);
  const S = seed % 9973;
  const N = WORLD.GRID_N, CELL = WORLD.CELL, HALF = WORLD.HALF;
  const heights = new Float32Array(N * N);

  const world = {
    seed, heights, n: N, cell: CELL, half: HALF, size: WORLD.SIZE,
    parts: [], boxes: [], cyls: [], trees: [], rocks: [], bushes: [],
    pois: [], doors: [], footprints: [], lootPoints: [], paths: [], pads: [],
    clocks: [], lamps: [], decals: [],
    maxHeight: 0,
  };

  // ---------------------------------------------------------------- terrain
  function natural(x, z) {
    const r = Math.hypot(x, z);
    const ang = Math.atan2(z, x);
    const cn = fbm(Math.cos(ang) * 1.4 + 7.3, Math.sin(ang) * 1.4 + 2.1, S + 11, 3);
    const cn2 = fbm(Math.cos(ang) * 4.2 + 1.9, Math.sin(ang) * 4.2 + 5.5, S + 17, 2);
    const coastR = 280 + 46 * (cn - 0.5) * 2 + 16 * (cn2 - 0.5) * 2;
    const d = r / coastR;
    const inlandFade = smoothstep(1.0, 0.62, d);
    const hills = Math.pow(fbm(x * 0.007 + 3.1, z * 0.007 + 1.7, S, 5), 1.7) * 24 * inlandFade;
    const patch = smoothstep(0.25, 0.7, fbm(x * 0.004 + 1.3, z * 0.004 + 8.8, S + 21, 2));
    const rid = ridged(x * 0.011 + 9, z * 0.011 + 4, S + 5, 3) * 5 * patch * inlandFade;
    const bump = (fbm(x * 0.06, z * 0.06, S + 31, 3) - 0.5) * 1.3;
    let inland = 2.3 + hills + rid + bump;
    inland += 22 * gauss(x + 125, z + 120, 58) + 15 * gauss(x - 118, z - 128, 46);
    const t = clamp((1 - d) / 0.3, 0, 1);
    const land = t * t * (3 - 2 * t);
    let h = -5.5 + (inland + 5.5) * land;
    if (d > 1) h -= 9 * smoothstep(1, 1.35, d);
    return h;
  }

  // Flattened pads under settlements and buildings.
  for (const p of POI_DEFS) {
    const h = p.h == null ? Math.max(2.2, natural(p.x, p.z)) : p.h;
    const poi = { id: p.id, name: p.name, x: p.x, z: p.z, r: p.r, h };
    world.pois.push(poi);
    world.pads.push({ x: p.x, z: p.z, r: p.r, m: Math.max(20, p.r * 0.75), h, poi: true });
  }
  const loneShacks = [];
  for (const [x, z, yaw] of LONE_SHACKS) {
    const h = natural(x, z);
    if (h < 2.2) continue;
    let clash = false;
    for (const p of world.pois) if (Math.hypot(p.x - x, p.z - z) < p.r + 16) clash = true;
    if (clash) continue;
    loneShacks.push({ x, z, yaw, h });
    world.pads.push({ x, z, r: 6.5, m: 8, h });
  }

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -HALF + i * CELL, z = -HALF + j * CELL;
      let h = natural(x, z);
      for (const p of world.pads) {
        const dd = Math.hypot(x - p.x, z - p.z);
        if (dd < p.r + p.m) h = lerp(h, p.h, smoothstep(p.r + p.m, p.r, dd));
      }
      heights[j * N + i] = h;
      if (h > world.maxHeight) world.maxHeight = h;
    }
  }

  // Triangle-accurate height lookup (matches the render mesh, which splits each cell on the b-c diagonal).
  function heightAt(x, z) {
    let gx = (x + HALF) / CELL, gz = (z + HALF) / CELL;
    if (gx < 0) gx = 0; else if (gx > N - 1.0001) gx = N - 1.0001;
    if (gz < 0) gz = 0; else if (gz > N - 1.0001) gz = N - 1.0001;
    const i = gx | 0, j = gz | 0;
    const u = gx - i, v = gz - j;
    const k = j * N + i;
    const hb = heights[k + 1], hc = heights[k + N];
    if (u + v <= 1) {
      const ha = heights[k];
      return ha + (hb - ha) * u + (hc - ha) * v;
    }
    const hd = heights[k + N + 1];
    return hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - v);
  }
  world.heightAt = heightAt;
  world.normalAt = function (x, z, out) {
    const e = 1.25;
    const nx = heightAt(x - e, z) - heightAt(x + e, z);
    const nz = heightAt(x, z - e) - heightAt(x, z + e);
    const ny = 2 * e;
    const l = Math.hypot(nx, ny, nz) || 1;
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
    return out;
  };

  // ---------------------------------------------------------------- part helpers
  function addBox(x, y, z, sx, sy, sz, yaw, mat, o) {
    o = o || {};
    if (!o.noRender) world.parts.push({ shape: 'box', x, y, z, sx, sy, sz, yaw, mat, tint: o.tint == null ? 0xffffff : o.tint });
    if (o.solid !== false) {
      world.boxes.push({
        x, z, hx: sx / 2, hz: sz / 2, c: Math.cos(yaw), s: Math.sin(yaw),
        y0: y - sy / 2, y1: y + sy / 2, walk: !!o.walk, rise: o.rise || 0, slide: !!o.slide, kind: o.kind || 'wall',
      });
    }
  }
  function addCyl(x, y, z, r, h, mat, o) {
    o = o || {};
    if (!o.noRender) world.parts.push({ shape: 'cyl', x, y, z, r, h, r2: o.r2 == null ? r : o.r2, axis: o.axis || 'y', yaw: o.yaw || 0, mat, tint: o.tint == null ? 0xffffff : o.tint });
    if (o.solid !== false) world.cyls.push({ x, z, r: o.cr || r, y0: y - h / 2, y1: y + h / 2, kind: o.kind || 'prop' });
  }

  function builder(x, z, yaw, baseY) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const B = {
      x, z, yaw, y: baseY, c, s,
      wx: (lx, lz) => x + lx * c + lz * s,
      wz: (lx, lz) => z - lx * s + lz * c,
      box(lx, ly, lz, sx, sy, sz, mat, o) { addBox(B.wx(lx, lz), baseY + ly, B.wz(lx, lz), sx, sy, sz, yaw + ((o && o.yaw) || 0), mat, o); },
      cyl(lx, ly, lz, r, h, mat, o) { addCyl(B.wx(lx, lz), baseY + ly, B.wz(lx, lz), r, h, mat, Object.assign({}, o, { yaw: yaw + ((o && o.yaw) || 0) })); },
      door(lx, lz, nlx, nlz, width) {
        world.doors.push({ x: B.wx(lx, lz), z: B.wz(lx, lz), y: baseY, nx: nlx * c + nlz * s, nz: -nlx * s + nlz * c, width });
      },
      loot(lx, lz, ly, indoor) {
        world.lootPoints.push({ x: B.wx(lx, lz), y: baseY + (ly || 0), z: B.wz(lx, lz), indoor: !!indoor, poi: B.poi == null ? -1 : B.poi });
      },
      lamp(lx, ly, lz) { world.lamps.push({ x: B.wx(lx, lz), y: baseY + ly, z: B.wz(lx, lz) }); },
    };
    return B;
  }

  // Highest ground under a footprint, so floors never sink into a slope.
  function siteBase(x, z, w, d, yaw) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let hi = -1e9, lo = 1e9;
    for (const [lx, lz] of [[0, 0], [-w / 2, -d / 2], [w / 2, -d / 2], [-w / 2, d / 2], [w / 2, d / 2]]) {
      const h = heightAt(x + lx * c + lz * s, z - lx * s + lz * c);
      if (h > hi) hi = h;
      if (h < lo) lo = h;
    }
    return { base: hi, drop: hi - lo };
  }

  // Four walls with door gaps. doors: [{side:'N'|'S'|'E'|'W', off, width, height}]
  function room(B, w, d, h, t, mat, doors, o) {
    const sides = [
      { id: 'N', len: w, ax: 'x', px: 0, pz: -d / 2 + t / 2, nx: 0, nz: -1 },
      { id: 'S', len: w, ax: 'x', px: 0, pz: d / 2 - t / 2, nx: 0, nz: 1 },
      { id: 'W', len: d - 2 * t, ax: 'z', px: -w / 2 + t / 2, pz: 0, nx: -1, nz: 0 },
      { id: 'E', len: d - 2 * t, ax: 'z', px: w / 2 - t / 2, pz: 0, nx: 1, nz: 0 },
    ];
    for (const sd of sides) {
      if (o && o.open === sd.id) continue;
      const gaps = doors.filter((g) => g.side === sd.id)
        .map((g) => ({ a: g.off - g.width / 2, b: g.off + g.width / 2, g }))
        .sort((p, q) => p.a - q.a);
      let cur = -sd.len / 2;
      const segs = [];
      for (const gp of gaps) { if (gp.a > cur + 0.05) segs.push([cur, gp.a]); cur = gp.b; }
      if (cur < sd.len / 2 - 0.05) segs.push([cur, sd.len / 2]);
      for (const [a, b] of segs) {
        const mid = (a + b) / 2, len = b - a;
        if (sd.ax === 'x') B.box(sd.px + mid, h / 2, sd.pz, len, h, t, mat, o);
        else B.box(sd.px, h / 2, sd.pz + mid, t, h, len, mat, o);
      }
      for (const gp of gaps) {
        const g = gp.g, dh = g.height || 2.25;
        if (dh < h - 0.05) {
          if (sd.ax === 'x') B.box(sd.px + g.off, (dh + h) / 2, sd.pz, g.width, h - dh, t, mat, o);
          else B.box(sd.px, (dh + h) / 2, sd.pz + g.off, t, h - dh, g.width, mat, o);
        }
        const lx = sd.ax === 'x' ? sd.px + g.off : sd.px;
        const lz = sd.ax === 'x' ? sd.pz : sd.pz + g.off;
        B.door(lx, lz, sd.nx, sd.nz, g.width);
        // door frame trim (visual)
        const ft = 0.09;
        if (sd.ax === 'x') {
          B.box(lx - g.width / 2 + ft / 2, dh / 2, sd.pz, ft, dh, t + 0.06, MAT.DARK, { solid: false });
          B.box(lx + g.width / 2 - ft / 2, dh / 2, sd.pz, ft, dh, t + 0.06, MAT.DARK, { solid: false });
          B.box(lx, dh - ft / 2, sd.pz, g.width, ft, t + 0.06, MAT.DARK, { solid: false });
        } else {
          B.box(sd.px, dh / 2, lz - g.width / 2 + ft / 2, t + 0.06, dh, ft, MAT.DARK, { solid: false });
          B.box(sd.px, dh / 2, lz + g.width / 2 - ft / 2, t + 0.06, dh, ft, MAT.DARK, { solid: false });
          B.box(sd.px, dh - ft / 2, lz, t + 0.06, ft, g.width, MAT.DARK, { solid: false });
        }
      }
    }
  }

  // Window panes on the outside faces of the given sides (visual only).
  function windows(B, w, d, t, sideIds, doors, o) {
    o = o || {};
    const y = o.y || 1.6, ww = o.w || 1.15, wh = o.h || 1.0, gap = o.gap || 3.0;
    for (const id of sideIds) {
      const alongX = id === 'N' || id === 'S';
      const len = alongX ? w : d;
      const count = Math.max(1, Math.floor((len - 1.6) / gap));
      for (let k = 0; k < count; k++) {
        const off = (k - (count - 1) / 2) * gap;
        let blocked = false;
        for (const g of doors) if (g.side === id && Math.abs(g.off - off) < g.width / 2 + ww / 2 + 0.25) blocked = true;
        if (blocked) continue;
        const sgn = id === 'S' || id === 'E' ? 1 : -1;
        if (alongX) {
          const pz = sgn * (d / 2 + 0.012);
          B.box(off, y, pz, ww + 0.16, wh + 0.16, 0.05, MAT.DARK, { solid: false });
          B.box(off, y, pz + sgn * 0.02, ww, wh, 0.05, MAT.GLASS, { solid: false });
          B.box(off, y - wh / 2 - 0.1, pz + sgn * 0.05, ww + 0.3, 0.08, 0.16, MAT.CONCRETE, { solid: false });
        } else {
          const px = sgn * (w / 2 + 0.012);
          B.box(px, y, off, 0.05, wh + 0.16, ww + 0.16, MAT.DARK, { solid: false });
          B.box(px + sgn * 0.02, y, off, 0.05, wh, ww, MAT.GLASS, { solid: false });
          B.box(px + sgn * 0.05, y - wh / 2 - 0.1, off, 0.16, 0.08, ww + 0.3, MAT.CONCRETE, { solid: false });
        }
      }
    }
  }

  function slab(B, w, d, drop) {
    const fd = Math.max(0.6, drop + 0.5);
    B.box(0, (0.12 - fd) / 2, 0, w + 0.4, 0.12 + fd, d + 0.4, MAT.CONCRETE, { walk: true, kind: 'floor' });
  }

  function footprint(x, z, w, d, yaw, kind) { world.footprints.push({ x, z, w, d, yaw, kind }); }

  // ---------------------------------------------------------------- buildings
  function shack(x, z, yaw, poi) {
    const w = 5.4, d = 4.4, h = 2.5, t = 0.16;
    const site = siteBase(x, z, w, d, yaw);
    const B = builder(x, z, yaw, site.base); B.poi = poi;
    const tint = rng.pick(WOOD_TINTS);
    const doors = [{ side: 'S', off: rng.range(-1, 1), width: 1.8, height: 2.1 }];
    slab(B, w, d, site.drop);
    room(B, w, d, h, t, MAT.WOOD, doors, { tint });
    windows(B, w, d, t, ['E', 'W'], doors, { w: 0.9, h: 0.8, y: 1.5 });
    B.box(0, h + 0.07, 0.25, w + 0.9, 0.14, d + 1.5, MAT.METAL, { kind: 'roof', tint: 0xb9b2a4 });
    // porch posts
    B.box(-w / 2 + 0.2, h / 2, d / 2 + 0.75, 0.14, h, 0.14, MAT.WOOD, { solid: false, tint });
    B.box(w / 2 - 0.2, h / 2, d / 2 + 0.75, 0.14, h, 0.14, MAT.WOOD, { solid: false, tint });
    B.loot(rng.range(-1.4, 1.4), rng.range(-1.2, 0.2), 0.12, true);
    if (rng.chance(0.55)) B.loot(rng.range(-1.6, 1.6), d / 2 + 2.2, 0, false);
    footprint(x, z, w, d, yaw, 'shack');
  }

  function house(x, z, yaw, poi) {
    const w = 9.2, d = 6.6, h = 3.0, t = 0.24;
    const site = siteBase(x, z, w, d, yaw);
    const B = builder(x, z, yaw, site.base); B.poi = poi;
    const tint = rng.pick(PLASTER_TINTS);
    const doors = [
      { side: 'S', off: -1.8, width: 1.8, height: 2.2 },
      { side: 'N', off: 2.2, width: 1.8, height: 2.2 },
    ];
    slab(B, w, d, site.drop);
    room(B, w, d, h, t, MAT.PLASTER, doors, { tint });
    windows(B, w, d, t, ['S', 'N', 'E', 'W'], doors);
    // interior partition
    B.box(1.1, h / 2, -d / 2 + t + 1.5, 0.18, h, 3.0, MAT.PLASTER, { tint });
    if (rng.chance(0.6)) {
      B.box(0, h + 0.09, 0, w + 0.8, 0.18, d + 0.8, MAT.CONCRETE, { kind: 'roof', rise: 1.5 });
      world.parts.push({ shape: 'gable', x, y: site.base + h + 0.18, z, sx: w + 0.9, sy: 1.5, sz: d + 0.9, yaw, mat: MAT.ROOFTILE, tint: 0xffffff });
    } else {
      B.box(0, h + 0.11, 0, w + 0.5, 0.22, d + 0.5, MAT.CONCRETE, { kind: 'roof' });
      for (const [px, pz, sx, sz] of [[0, -d / 2 - 0.1, w + 0.5, 0.2], [0, d / 2 + 0.1, w + 0.5, 0.2], [-w / 2 - 0.1, 0, 0.2, d + 0.5], [w / 2 + 0.1, 0, 0.2, d + 0.5]]) {
        B.box(px, h + 0.42, pz, sx, 0.4, sz, MAT.PLASTER, { solid: false, tint });
      }
    }
    B.lamp(-1.8, 2.55, d / 2 + 0.12);
    B.loot(-2.6, -1.2, 0.12, true);
    B.loot(3.0, 1.0, 0.12, true);
    footprint(x, z, w, d, yaw, 'house');
  }

  function barracks(x, z, yaw, poi) {
    const w = 16.5, d = 6.8, h = 3.1, t = 0.28;
    const site = siteBase(x, z, w, d, yaw);
    const B = builder(x, z, yaw, site.base); B.poi = poi;
    const doors = [
      { side: 'S', off: -5, width: 1.8, height: 2.2 },
      { side: 'S', off: 5, width: 1.8, height: 2.2 },
      { side: 'N', off: 0, width: 1.8, height: 2.2 },
    ];
    slab(B, w, d, site.drop);
    room(B, w, d, h, t, MAT.CONCRETE, doors, { tint: 0xd8d2c4 });
    windows(B, w, d, t, ['S', 'N'], doors, { gap: 3.2 });
    B.box(-1.5, h / 2, 0.91, 0.2, h, 4.42, MAT.CONCRETE, { tint: 0xd8d2c4 });
    B.box(0, h + 0.12, 0, w + 0.7, 0.24, d + 0.7, MAT.CONCRETE, { kind: 'roof' });
    B.lamp(-5, 2.6, d / 2 + 0.12); B.lamp(5, 2.6, d / 2 + 0.12);
    B.loot(-6, -1.2, 0.12, true); B.loot(2.5, 1.2, 0.12, true); B.loot(6.2, -1.4, 0.12, true);
    footprint(x, z, w, d, yaw, 'house');
  }

  function bunker(x, z, yaw, poi) {
    const w = 7.2, d = 5.6, h = 2.7, t = 0.45;
    const site = siteBase(x, z, w, d, yaw);
    const B = builder(x, z, yaw, site.base); B.poi = poi;
    const doors = [{ side: 'S', off: 1.2, width: 1.8, height: 2.1 }];
    slab(B, w, d, site.drop);
    room(B, w, d, h, t, MAT.CONCRETE, doors, { tint: 0xb9b6ac });
    B.box(0, h + 0.2, 0, w + 0.5, 0.4, d + 0.5, MAT.CONCRETE, { kind: 'roof', tint: 0xaeaba2 });
    B.box(0, 1.55, -d / 2 - 0.01, 3.2, 0.34, 0.05, MAT.DARK, { solid: false }); // embrasure
    B.loot(-1.8, -0.4, 0.12, true); B.loot(1.6, -1.0, 0.12, true);
    footprint(x, z, w, d, yaw, 'bunker');
  }

  function guardPost(x, z, yaw, poi) {
    const w = 3.8, d = 3.8, h = 2.6, t = 0.2;
    const site = siteBase(x, z, w, d, yaw);
    const B = builder(x, z, yaw, site.base); B.poi = poi;
    const doors = [{ side: 'S', off: 0, width: 1.8, height: 2.15 }];
    slab(B, w, d, site.drop);
    room(B, w, d, h, t, MAT.PLASTER, doors, { tint: 0xc4c0b2 });
    windows(B, w, d, t, ['N', 'E', 'W'], doors, { w: 1.6, h: 0.9, y: 1.65 });
    B.box(0, h + 0.09, 0, w + 0.9, 0.18, d + 0.9, MAT.METAL, { kind: 'roof', tint: 0xa9b0ae });
    B.loot(0, -0.5, 0.12, true);
    footprint(x, z, w, d, yaw, 'shack');
  }

  function garage(x, z, yaw, poi) {
    const w = 11.5, d = 7, h = 3.7, t = 0.18;
    const site = siteBase(x, z, w, d, yaw);
    const B = builder(x, z, yaw, site.base); B.poi = poi;
    slab(B, w, d, site.drop);
    room(B, w, d, h, t, MAT.METAL, [], { open: 'S', tint: 0xb3b8b6 });
    B.box(0, h + 0.1, 0.3, w + 0.6, 0.2, d + 1.2, MAT.METAL, { kind: 'roof', tint: 0x9aa09d });
    B.box(-w / 4, h / 2, d / 2 - 0.15, 0.22, h, 0.22, MAT.DARK, {});
    B.box(w / 4, h / 2, d / 2 - 0.15, 0.22, h, 0.22, MAT.DARK, {});
    crateStack(B.wx(-3.6, -2.0), B.wz(-3.6, -2.0), yaw + 0.2, 2);
    barrel(B.wx(4.2, -2.4), B.wz(4.2, -2.4)); barrel(B.wx(4.9, -1.9), B.wz(4.9, -1.9));
    B.loot(-0.5, -1.2, 0.12, true); B.loot(3.4, 0.6, 0.12, true);
    footprint(x, z, w, d, yaw, 'warehouse');
  }

  function warehouse(x, z, yaw, poi, barn) {
    const w = barn ? 15 : 24, d = barn ? 9.5 : 13, h = barn ? 4.6 : 6.2, t = 0.2;
    const mat = barn ? MAT.WOOD : MAT.METAL;
    const tint = barn ? 0x8a5a44 : rng.pick([0xb8bcb9, 0xa7b1b5, 0xbdb5a3]);
    const site = siteBase(x, z, w, d, yaw);
    const B = builder(x, z, yaw, site.base); B.poi = poi;
    const gw = barn ? 4.2 : 5.6, gh = barn ? 3.4 : 4.6;
    const doors = [
      { side: 'W', off: 0, width: gw, height: gh },
      { side: 'E', off: 0, width: gw, height: gh },
      { side: 'S', off: barn ? 3 : 6, width: 1.8, height: 2.2 },
    ];
    slab(B, w, d, site.drop);
    room(B, w, d, h, t, mat, doors, { tint });
    const rise = barn ? 2.2 : 1.7;
    B.box(0, h + 0.08, 0, w + 0.6, 0.16, d + 0.8, MAT.METAL, { kind: 'roof', rise, tint: 0x9aa3a5, noRender: true });
    world.parts.push({ shape: 'gable', x, y: site.base + h, z, sx: w + 0.7, sy: rise, sz: d + 1.0, yaw, mat: MAT.METAL, tint: barn ? 0x8f8377 : 0x8f9a9c });
    // interior cover
    if (!barn) {
      crateStack(B.wx(-6, -3.5), B.wz(-6, -3.5), yaw + 0.1, 3);
      crateStack(B.wx(5.5, 3.2), B.wz(5.5, 3.2), yaw - 0.3, 2);
      crateStack(B.wx(1, -4.2), B.wz(1, -4.2), yaw, 1);
      B.box(-2, 1.25, 3.6, 5.0, 2.5, 1.2, MAT.CRATE, { kind: 'prop', tint: 0x6f7a5a });
      B.lamp(-w / 2 - 0.12, gh + 0.5, 0); B.lamp(w / 2 + 0.12, gh + 0.5, 0);
      B.loot(-8.5, 2.5, 0.12, true); B.loot(8, -3, 0.12, true); B.loot(0, 0.2, 0.12, true); B.loot(-3, -1.5, 0.12, true);
    } else {
      crateStack(B.wx(-4, 2.2), B.wz(-4, 2.2), yaw + 0.4, 2);
      B.box(4, 0.7, -2.8, 2.6, 1.4, 1.6, MAT.CRATE, { kind: 'prop', tint: 0xc9b06a });
      B.loot(-5, -2, 0.12, true); B.loot(5, 2.2, 0.12, true); B.loot(0.5, 0, 0.12, true);
    }
    footprint(x, z, w, d, yaw, 'warehouse');
  }

  function tower(x, z, yaw, poi) {
    const w = 7.6, h0 = 4.2, t = 0.6, top = 21.5;
    const site = siteBase(x, z, w, w, yaw);
    const B = builder(x, z, yaw, site.base); B.poi = poi;
    const tint = 0xd6cdb9;
    const doors = [{ side: 'S', off: 0, width: 2.0, height: 2.7 }, { side: 'N', off: 0, width: 2.0, height: 2.7 }];
    slab(B, w + 1.6, w + 1.6, site.drop);
    B.box(0, 0.27, 0, w + 1.2, 0.3, w + 1.2, MAT.CONCRETE, { walk: true, kind: 'floor' });
    room(B, w, w, h0, t, MAT.PLASTER, doors, { tint });
    B.box(0, (h0 + top) / 2, 0, w - 0.3, top - h0, w - 0.3, MAT.PLASTER, { tint, slide: true });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      B.box(sx * (w / 2 - 0.05), top / 2, sz * (w / 2 - 0.05), 0.7, top, 0.7, MAT.CONCRETE, { solid: false, tint: 0xc9c2b2 });
    }
    B.box(0, h0 + 0.2, 0, w + 0.5, 0.4, w + 0.5, MAT.CONCRETE, { solid: false });
    B.box(0, 13.2, 0, w + 0.3, 0.35, w + 0.3, MAT.CONCRETE, { solid: false });
    B.box(0, top + 0.3, 0, w + 1.0, 0.6, w + 1.0, MAT.CONCRETE, { solid: false });
    world.parts.push({ shape: 'pyramid', x, y: site.base + top + 0.6, z, sx: w + 0.5, sy: 5.6, sz: w + 0.5, yaw, mat: MAT.ROOFTILE, tint: 0xffffff });
    B.box(0, top + 6.9, 0, 0.14, 2.2, 0.14, MAT.DARK, { solid: false });
    // four clock faces
    const cy = site.base + 17.3, off = (w - 0.3) / 2 + 0.06;
    for (let k = 0; k < 4; k++) {
      const a = yaw + k * Math.PI / 2;
      world.clocks.push({ x: x + Math.sin(a) * off, y: cy, z: z + Math.cos(a) * off, yaw: a, r: 2.35 });
    }
    // tall arched-look slots (dark insets)
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2;
      const lx = Math.sin(a) * ((w - 0.3) / 2 + 0.02), lz = Math.cos(a) * ((w - 0.3) / 2 + 0.02);
      const alongX = k % 2 === 0;
      B.box(lx, 9.5, lz, alongX ? 1.2 : 0.06, 3.4, alongX ? 0.06 : 1.2, MAT.DARK, { solid: false });
    }
    B.lamp(0, 3.3, w / 2 + 0.15); B.lamp(0, 3.3, -w / 2 - 0.15);
    B.loot(-1.6, -1.2, 0.42, true); B.loot(1.7, 1.2, 0.42, true);
    footprint(x, z, w, w, yaw, 'tower');
    world.towerTop = { x, y: site.base + top + 6.2, z };
  }

  // ---------------------------------------------------------------- props
  function container(x, z, yaw, level, tint) {
    const L = 6.06, H = 2.59, Wd = 2.44;
    const base = heightAt(x, z);
    addBox(x, base + H / 2 + level * H, z, L, H, Wd, yaw, MAT.CONTAINER, { kind: 'container', tint: tint == null ? rng.pick(CONTAINER_TINTS) : tint });
    if (level === 0) footprint(x, z, L, Wd, yaw, 'container');
  }
  function barrier(x, z, yaw) {
    const base = heightAt(x, z);
    addBox(x, base + 0.42, z, 2.5, 0.9, 0.6, yaw, MAT.CONCRETE, { kind: 'barrier', tint: 0xcfcbbf });
  }
  function sandbags(x, z, yaw, len) {
    const base = heightAt(x, z);
    addBox(x, base + 0.5, z, len || 2.8, 1.05, 0.75, yaw, MAT.SANDBAG, { kind: 'sandbag' });
  }
  function crateStack(x, z, yaw, n) {
    const base = heightAt(x, z);
    const s = 1.15;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const tintA = rng.chance(0.5) ? 0x6b7353 : 0xb89a62;
    addBox(x, base + s / 2, z, s, s, s, yaw, MAT.CRATE, { kind: 'prop', tint: tintA });
    if (n >= 2) addBox(x + c * 1.22, base + s / 2, z - sn * 1.22, s, s, s, yaw + 0.12, MAT.CRATE, { kind: 'prop', tint: 0xb89a62 });
    if (n >= 3) addBox(x + c * 0.6, base + s * 1.5, z - sn * 0.6, s, s, s, yaw - 0.2, MAT.CRATE, { kind: 'prop', tint: 0x6b7353 });
  }
  function barrel(x, z, tint) {
    const base = heightAt(x, z);
    addCyl(x, base + 0.46, z, 0.31, 0.92, MAT.RUSTY, { kind: 'prop', tint: tint == null ? rng.pick([0x7a3b2a, 0x35506b, 0x5f6b3a, 0x8a8a84]) : tint });
  }
  function truck(x, z, yaw) {
    const site = siteBase(x, z, 2.4, 6.4, yaw);
    const B = builder(x, z, yaw, site.base);
    const tint = rng.pick([0x4d5a3c, 0x5b5a48, 0x3f4a44]);
    B.box(0, 1.0, 0.4, 2.3, 0.5, 6.4, MAT.DARK, { kind: 'vehicle', noRender: true });   // chassis collider
    B.box(0, 0.78, 0.3, 2.0, 0.28, 6.3, MAT.DARK, { solid: false });
    B.box(0, 1.85, -2.2, 2.3, 1.7, 1.9, MAT.PAINT, { kind: 'vehicle', tint });           // cab
    B.box(0, 1.25, -3.45, 2.2, 0.9, 0.7, MAT.PAINT, { kind: 'vehicle', tint });          // hood
    B.box(0, 2.25, -2.7, 2.0, 0.6, 0.06, MAT.GLASS, { solid: false });                   // windscreen
    B.box(0, 1.2, 1.25, 2.35, 0.16, 4.3, MAT.PAINT, { kind: 'vehicle', tint });          // bed floor
    B.box(0, 2.05, 1.25, 2.4, 1.55, 4.3, MAT.CANVAS, { kind: 'vehicle', tint: 0x6a6f4e }); // canvas cover
    for (const [wx2, wz2] of [[-1.05, -2.6], [1.05, -2.6], [-1.05, 0.9], [1.05, 0.9], [-1.05, 2.4], [1.05, 2.4]]) {
      B.cyl(wx2, 0.5, wz2, 0.5, 0.34, MAT.DARK, { axis: 'x', solid: false });
    }
    B.loot(1.9, 3.2, 0, false);
    footprint(x, z, 2.4, 6.4, yaw, 'container');
  }
  function lampPost(x, z) {
    const base = heightAt(x, z);
    addBox(x, base + 2.6, z, 0.14, 5.2, 0.14, 0, MAT.DARK, { solid: false });
    addBox(x, base + 5.15, z + 0.35, 0.2, 0.1, 0.8, 0, MAT.DARK, { solid: false });
    world.cyls.push({ x, z, r: 0.12, y0: base, y1: base + 5.2, kind: 'prop' });
    world.lamps.push({ x, y: base + 5.05, z: z + 0.6 });
  }

  // ---------------------------------------------------------------- settlements
  const P = Object.fromEntries(world.pois.map((p, i) => [p.id, Object.assign({ idx: i }, p)]));

  { // MERIDIAN: walled compound around the clock tower
    const p = P.meridian, half = 38, wh = 2.5, wt = 0.45, gate = 7;
    const B = builder(p.x, p.z, 0, p.h); B.poi = p.idx;
    const segLen = half - gate / 2, segMid = (half + gate / 2) / 2;
    for (const sgn of [-1, 1]) {
      for (const side of [-1, 1]) {
        B.box(side * segMid, wh / 2 - 0.3, sgn * half, segLen, wh + 0.6, wt, MAT.CONCRETE, { tint: 0xcbc5b6 });
        B.box(sgn * half, wh / 2 - 0.3, side * segMid, wt, wh + 0.6, segLen, MAT.CONCRETE, { tint: 0xcbc5b6 });
        B.box(side * (gate / 2 + 0.4), 1.25, sgn * half, 0.9, 3.7, 0.9, MAT.CONCRETE, {});
        B.box(sgn * half, 1.25, side * (gate / 2 + 0.4), 0.9, 3.7, 0.9, MAT.CONCRETE, {});
        B.box(side * half, 1.25, sgn * half, 1.0, 3.7, 1.0, MAT.CONCRETE, {});
        B.lamp(side * (gate / 2 + 0.4), 3.2, sgn * (half - 0.6));
      }
    }
    tower(p.x, p.z, 0, p.idx);
    barracks(p.x - 19, p.z - 24, 0, p.idx);
    house(p.x + 24, p.z - 19, Math.PI / 2, p.idx);
    house(p.x - 23, p.z + 21, 0, p.idx);
    garage(p.x + 22, p.z + 24, Math.PI, p.idx);
    guardPost(p.x + 8.5, p.z + 33, Math.PI, p.idx);
    guardPost(p.x - 33, p.z - 8.5, Math.PI / 2, p.idx);
    for (const [bx, bz, by] of [[-9, 12, 0.3], [10, -10, 1.2], [-4, -15, 0.1], [13, 7, 2.2], [-14, -3, 1.5], [3, 17, 0.0]]) barrier(p.x + bx, p.z + bz, by);
    for (const [sx, sz, sy] of [[-5.6, 42, 0], [5.6, 42, 0], [-5.6, -42, 0], [5.6, -42, 0], [42, -5.6, Math.PI / 2], [42, 5.6, Math.PI / 2], [-42, -5.6, Math.PI / 2], [-42, 5.6, Math.PI / 2]]) sandbags(p.x + sx, p.z + sz, sy);
    crateStack(p.x - 11, p.z + 3, 0.4, 3); crateStack(p.x + 7, p.z + 15, 1.0, 2); crateStack(p.x + 16, p.z - 6, 0.2, 2);
    for (const [bx, bz] of [[-8, -8], [-7.3, -8.5], [15, 12], [5, -18], [5.7, -18.4]]) barrel(p.x + bx, p.z + bz);
    truck(p.x + 11, p.z + 3, 0.5);
    for (const [lx, lz] of [[-12, -12], [12, -12], [-12, 12], [12, 14]]) lampPost(p.x + lx, p.z + lz);
    for (const [lx, lz] of [[-6, 6], [9, -4], [-16, -13], [17, 16], [0, -26], [-28, 0]]) B.loot(lx, lz, 0, false);
  }

  { // FREIGHT YARD: warehouses and container rows
    const p = P.freight;
    const B = builder(p.x, p.z, 0, p.h); B.poi = p.idx;
    warehouse(p.x - 26, p.z - 25, 0, p.idx);
    warehouse(p.x + 9, p.z - 27, 0, p.idx);
    warehouse(p.x - 26, p.z + 24, Math.PI / 2, p.idx);
    house(p.x + 39, p.z - 3, -Math.PI / 2, p.idx);
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        if (rng.chance(0.2)) continue;
        const cx = p.x - 3 + i * 8.7, cz = p.z + 7 + j * 6.7;
        const tint = rng.pick(CONTAINER_TINTS);
        container(cx, cz, rng.range(-0.03, 0.03), 0, tint);
        if (rng.chance(0.32)) container(cx, cz, rng.range(-0.05, 0.05), 1, rng.pick(CONTAINER_TINTS));
      }
    }
    container(p.x + 37, p.z + 22, Math.PI / 2, 0); container(p.x - 2, p.z + 41, 0.3, 0); container(p.x + 30, p.z - 44, 0.1, 0);
    for (const [bx, bz, by] of [[-8, -8, 0], [-2, -8, 0], [22, 2, 1.57], [-38, 2, 0], [34, 38, 0.8], [-8, 44, 0.2], [44, 12, 1.57]]) barrier(p.x + bx, p.z + bz, by);
    for (const [bx, bz] of [[-10, 2], [-9.3, 2.6], [27, -8], [41, 30], [-36, -6]]) barrel(p.x + bx, p.z + bz);
    crateStack(p.x - 12, p.z - 6, 0.3, 3); crateStack(p.x + 26, p.z - 10, 1.2, 2); crateStack(p.x - 40, p.z + 6, 0, 2);
    truck(p.x + 31, p.z + 36, 2.0); truck(p.x - 44, p.z - 12, 0.1);
    for (const [lx, lz] of [[-8, -10], [24, -6], [-12, 8], [30, 12]]) lampPost(p.x + lx, p.z + lz);
    for (const [lx, lz] of [[1.5, 10.4], [10, 17], [19, 23.8], [27.5, 10.5], [-6, 30.5], [33, 2], [-14, -4], [40, 34]]) B.loot(lx, lz, 0, false);
  }

  { // TIDEWATER: fishing village with two piers
    const p = P.tidewater;
    const B = builder(p.x, p.z, 0, p.h); B.poi = p.idx;
    const ring = [[0.3, 24, 0], [1.1, 27, 1], [1.9, 23, 0], [2.7, 28, 1], [3.6, 24, 0], [4.4, 27, 0], [5.2, 24, 1], [5.9, 28, 0]];
    for (const [a, rr, kind] of ring) {
      const bx = p.x + Math.cos(a) * rr, bz = p.z + Math.sin(a) * rr;
      const yaw = Math.atan2(p.x - bx, p.z - bz);
      if (kind === 1) house(bx, bz, yaw, p.idx); else shack(bx, bz, yaw, p.idx);
    }
    const dl = Math.hypot(p.x, p.z), dx = p.x / dl, dz = p.z / dl;
    for (const side of [-1, 1]) {
      const ang = side * 0.32;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const px = dx * ca - dz * sa, pz = dx * sa + dz * ca;
      let s = 10;
      while (s < 120 && heightAt(p.x + px * s, p.z + pz * s) > 0.95) s += 1;
      const len = 30, start = s - 3;
      const mx = p.x + px * (start + len / 2), mz = p.z + pz * (start + len / 2);
      const yaw = Math.atan2(-pz, px);
      addBox(mx, 1.05 - 0.14, mz, len, 0.28, 3.3, yaw, MAT.WOOD, { walk: true, kind: 'floor', tint: 0x8c7352 });
      addBox(mx, -2.2, mz, len, 4.0, 3.3, yaw, MAT.WOOD, { noRender: true, kind: 'pier' });
      for (let q = 2; q < len; q += 4.5) {
        for (const lat of [-1.45, 1.45]) {
          const qx = p.x + px * (start + q) + -pz * lat, qz = p.z + pz * (start + q) + px * lat;
          addCyl(qx, -1.1, qz, 0.16, 4.6, MAT.WOOD, { solid: false, tint: 0x5e4a36 });
        }
      }
      world.lootPoints.push({ x: p.x + px * (start + len - 2.5), y: 1.05, z: p.z + pz * (start + len - 2.5), indoor: false, poi: p.idx, fixed: true });
      crateStack(p.x + px * (start + 6) - pz * 0.5, p.z + pz * (start + 6) + px * 0.5, yaw, 1);
      footprint(mx, mz, len, 3.3, yaw, 'pier');
    }
    for (const [bx, bz] of [[4, 3], [4.7, 3.5], [-6, -4], [8, -8]]) barrel(p.x + bx, p.z + bz);
    crateStack(p.x - 3, p.z + 6, 0.5, 2); crateStack(p.x + 9, p.z + 2, 1.3, 2);
    sandbags(p.x - 10, p.z - 2, 0.9); sandbags(p.x + 2, p.z - 11, 0.1);
    lampPost(p.x, p.z);
    for (const [lx, lz] of [[2, -3], [-7, 5], [10, 9]]) B.loot(lx, lz, 0, false);
  }

  { // RADAR RIDGE: hilltop listening post
    const p = P.radar;
    const B = builder(p.x, p.z, 0, p.h); B.poi = p.idx;
    bunker(p.x - 10, p.z - 6, 0.6, p.idx);
    bunker(p.x + 11, p.z + 8, -2.2, p.idx);
    B.cyl(2, 2.6, -13, 1.3, 5.2, MAT.CONCRETE, { kind: 'prop' });
    world.parts.push({ shape: 'dish', x: p.x + 2, y: p.h + 6.6, z: p.z - 13, r: 3.6, yaw: 0.8, mat: MAT.PAINT, tint: 0xc9cdc8 });
    B.box(-13, 13, 11, 0.5, 26, 0.5, MAT.DARK, {});
    for (let k = 1; k < 6; k++) B.box(-13, k * 4.3, 11, 1.5, 0.08, 1.5, MAT.DARK, { solid: false });
    world.lamps.push({ x: p.x - 13, y: p.h + 26.2, z: p.z + 11, red: true });
    world.decals.push({ kind: 'helipad', x: p.x + 13, y: p.h + 0.04, z: p.z - 10, r: 6.5 });
    for (let k = 0; k < 6; k++) {
      const a = k * Math.PI / 3 + 0.4;
      sandbags(p.x + Math.cos(a) * 21, p.z + Math.sin(a) * 21, -a + Math.PI / 2, 3.2);
    }
    crateStack(p.x + 3, p.z + 2, 0.7, 2); barrel(p.x - 3, p.z + 9); barrel(p.x - 3.6, p.z + 9.6);
    for (const [lx, lz] of [[4, 4], [-4, -14], [14, -4], [-16, 4]]) B.loot(lx, lz, 0, false);
  }

  { // FUEL DEPOT
    const p = P.depot;
    const B = builder(p.x, p.z, 0, p.h); B.poi = p.idx;
    for (const [tx, tz] of [[-8, -8], [8, -8], [-8, 8], [8, 8]]) {
      B.cyl(tx, 3.8, tz, 5, 7.6, MAT.RUSTY, { kind: 'tank', tint: 0xc9c5ba });
      world.parts.push({ shape: 'dome', x: p.x + tx, y: p.h + 7.6, z: p.z + tz, r: 5, h: 1.3, mat: MAT.RUSTY, tint: 0xc9c5ba });
      world.footprints.push({ x: p.x + tx, z: p.z + tz, w: 10, d: 10, yaw: 0, kind: 'tank' });
    }
    B.cyl(0, 0.7, -8, 0.22, 6, MAT.RUSTY, { axis: 'x', solid: false, tint: 0x9a8f7c });
    B.cyl(0, 0.7, 8, 0.22, 6, MAT.RUSTY, { axis: 'x', solid: false, tint: 0x9a8f7c });
    B.cyl(-8, 0.7, 0, 0.22, 6, MAT.RUSTY, { axis: 'z', solid: false, tint: 0x9a8f7c });
    shack(p.x - 23, p.z + 5, Math.PI / 2, p.idx);
    shack(p.x + 21, p.z - 19, -0.6, p.idx);
    guardPost(p.x + 1, p.z + 26, Math.PI, p.idx);
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4 + 0.2;
      barrier(p.x + Math.cos(a) * 19, p.z + Math.sin(a) * 19, -a + Math.PI / 2);
    }
    for (const [bx, bz] of [[0, 0], [0.7, 0.5], [-0.3, 0.8], [14, 14], [-15, -13], [-14.4, -13.7]]) barrel(p.x + bx, p.z + bz);
    crateStack(p.x + 16, p.z + 2, 0.3, 2);
    truck(p.x - 20, p.z - 17, 1.1);
    lampPost(p.x - 14, p.z + 15); lampPost(p.x + 15, p.z - 3);
    for (const [lx, lz] of [[0, 15], [15, 0], [-16, -2], [2, -18], [-12, 18]]) B.loot(lx, lz, 0, false);
  }

  { // camps
    let p = P.westcamp; let B = builder(p.x, p.z, 0, p.h); B.poi = p.idx;
    for (const [bx, bz] of [[-8, -6], [9, -4], [0, 10]]) shack(p.x + bx, p.z + bz, Math.atan2(-bx, -bz), p.idx);
    crateStack(p.x + 1, p.z - 1, 0.6, 3); sandbags(p.x - 12, p.z + 7, 1.0); sandbags(p.x + 13, p.z + 6, -0.8);
    barrel(p.x + 4, p.z + 2);
    B.loot(-2, 2, 0, false); B.loot(4, -8, 0, false);

    p = P.southcamp; B = builder(p.x, p.z, 0, p.h); B.poi = p.idx;
    house(p.x - 10, p.z - 4, Math.PI / 2, p.idx); house(p.x + 10, p.z + 5, -Math.PI / 2, p.idx);
    shack(p.x - 3, p.z + 12, Math.PI, p.idx); shack(p.x + 5, p.z - 12, 0, p.idx);
    crateStack(p.x, p.z, 0.2, 2); barrier(p.x - 2, p.z - 6, 0.4); barrier(p.x + 3, p.z + 6, 0.1);
    B.loot(1, 3, 0, false); B.loot(-4, -9, 0, false);

    p = P.northfield; B = builder(p.x, p.z, 0, p.h); B.poi = p.idx;
    warehouse(p.x, p.z, 0.4, p.idx, true);
    shack(p.x - 15, p.z + 9, 1.4, p.idx); shack(p.x + 14, p.z - 10, -1.9, p.idx);
    crateStack(p.x + 10, p.z + 8, 0.9, 2); barrel(p.x - 9, p.z - 6); barrel(p.x - 9.7, p.z - 6.4);
    truck(p.x - 4, p.z + 11, 1.9);
    B.loot(9, 6, 0, false);

    p = P.sentinel; B = builder(p.x, p.z, 0, p.h); B.poi = p.idx;
    bunker(p.x, p.z, 2.4, p.idx);
    guardPost(p.x + 8, p.z - 6, -0.8, p.idx);
    sandbags(p.x - 8, p.z + 5, 0.6, 3.2); sandbags(p.x + 2, p.z + 9, -0.2, 3.2); sandbags(p.x - 6, p.z - 8, 2.2, 3.2);
    B.loot(-4, 2, 0, false);
  }

  for (const sh of loneShacks) {
    shack(sh.x, sh.z, sh.yaw, -1);
    if (rng.chance(0.6)) crateStack(sh.x + Math.cos(sh.yaw) * 4.8, sh.z - Math.sin(sh.yaw) * 4.8, sh.yaw + 0.5, rng.int(1, 2));
    if (rng.chance(0.5)) barrel(sh.x - Math.cos(sh.yaw) * 3.6, sh.z + Math.sin(sh.yaw) * 3.6);
  }

  // dirt tracks from the Meridian gates to every settlement
  {
    const m = P.meridian;
    for (const p of world.pois) {
      if (p.id === 'meridian') continue;
      const dx = p.x - m.x, dz = p.z - m.z, dl = Math.hypot(dx, dz);
      let gx, gz;
      if (Math.abs(dx) > Math.abs(dz)) { gx = m.x + Math.sign(dx) * 40; gz = m.z; }
      else { gx = m.x; gz = m.z + Math.sign(dz) * 40; }
      const pts = [[gx, gz]];
      const steps = Math.max(3, Math.round(dl / 45));
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        const bend = Math.sin(t * Math.PI) * dl * 0.09 * (rng() - 0.5) * 2;
        pts.push([lerp(gx, p.x, t) + (-dz / dl) * bend, lerp(gz, p.z, t) + (dx / dl) * bend]);
      }
      pts.push([p.x - (dx / dl) * p.r * 0.75, p.z - (dz / dl) * p.r * 0.75]);
      world.paths.push(pts);
    }
  }
  function nearPath(x, z, dist) {
    for (const pts of world.paths) {
      for (let k = 0; k < pts.length - 1; k++) {
        const ax = pts[k][0], az = pts[k][1], bx = pts[k + 1][0], bz = pts[k + 1][1];
        const vx = bx - ax, vz = bz - az;
        const t = clamp(((x - ax) * vx + (z - az) * vz) / (vx * vx + vz * vz), 0, 1);
        if (Math.hypot(x - ax - vx * t, z - az - vz * t) < dist) return true;
      }
    }
    return false;
  }
  world.nearPath = nearPath;

  // ---------------------------------------------------------------- spatial grid (static colliders)
  const gridBoxes = new Array(GN * GN), gridCyls = new Array(GN * GN);
  for (let i = 0; i < GN * GN; i++) { gridBoxes[i] = []; gridCyls[i] = []; }
  function cellRange(x, z, ex, ez) {
    return [
      clamp(Math.floor((x - ex + HALF) / GC), 0, GN - 1), clamp(Math.floor((x + ex + HALF) / GC), 0, GN - 1),
      clamp(Math.floor((z - ez + HALF) / GC), 0, GN - 1), clamp(Math.floor((z + ez + HALF) / GC), 0, GN - 1),
    ];
  }
  function indexBox(b, idx) {
    const ex = Math.abs(b.c) * b.hx + Math.abs(b.s) * b.hz, ez = Math.abs(b.s) * b.hx + Math.abs(b.c) * b.hz;
    const [x0, x1, z0, z1] = cellRange(b.x, b.z, ex, ez);
    for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) gridBoxes[gz * GN + gx].push(idx);
  }
  function indexCyl(cy, idx) {
    const [x0, x1, z0, z1] = cellRange(cy.x, cy.z, cy.r, cy.r);
    for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) gridCyls[gz * GN + gx].push(idx);
  }
  world.boxes.forEach(indexBox);
  let indexedCyls = 0;
  function flushCyls() { for (; indexedCyls < world.cyls.length; indexedCyls++) indexCyl(world.cyls[indexedCyls], indexedCyls); }
  flushCyls();

  function boxNear(x, z, dist) {
    const [x0, x1, z0, z1] = cellRange(x, z, dist, dist);
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const list = gridBoxes[gz * GN + gx];
        for (let k = 0; k < list.length; k++) {
          const b = world.boxes[list[k]];
          const px = x - b.x, pz = z - b.z;
          const lx = px * b.c - pz * b.s, lz = px * b.s + pz * b.c;
          const ddx = Math.max(Math.abs(lx) - b.hx, 0), ddz = Math.max(Math.abs(lz) - b.hz, 0);
          if (ddx * ddx + ddz * ddz < dist * dist) return true;
        }
        const cl = gridCyls[gz * GN + gx];
        for (let k = 0; k < cl.length; k++) {
          const cy = world.cyls[cl[k]];
          if (Math.hypot(x - cy.x, z - cy.z) < dist + cy.r) return true;
        }
      }
    }
    return false;
  }
  world.boxNear = boxNear;

  // ---------------------------------------------------------------- vegetation and rocks
  function inClearZone(x, z) {
    for (const p of world.pois) {
      const dd = Math.hypot(x - p.x, z - p.z);
      const clear = (p.id === 'meridian' || p.id === 'freight' || p.id === 'depot' || p.id === 'radar') ? p.r * 0.98 : p.r * 0.35;
      if (dd < clear) return true;
    }
    return false;
  }
  {
    const step = 6.2;
    for (let gz = -HALF + 12; gz < HALF - 12; gz += step) {
      for (let gx = -HALF + 12; gx < HALF - 12; gx += step) {
        const x = gx + rng.range(-2.6, 2.6), z = gz + rng.range(-2.6, 2.6);
        const h = heightAt(x, z);
        if (h < 1.05) continue;
        const dens = fbm(x * 0.013 + 4.4, z * 0.013 + 9.1, S + 77, 3);
        const coastal = h < 4.2;
        const want = coastal ? 0.12 + dens * 0.16 : smoothstep(0.38, 0.62, dens) * 0.44 + 0.03;
        if (rng() > want) continue;
        if (inClearZone(x, z) || nearPath(x, z, 4.2) || boxNear(x, z, 3.6)) continue;
        const sl = Math.abs(heightAt(x + 1.5, z) - heightAt(x - 1.5, z)) + Math.abs(heightAt(x, z + 1.5) - heightAt(x, z - 1.5));
        if (sl > 2.6) continue;
        const palm = coastal ? rng.chance(0.85) : rng.chance(0.22);
        const type = palm ? 0 : (rng.chance(0.3) ? 2 : 1);
        const s = palm ? rng.range(0.85, 1.3) : rng.range(0.8, 1.35);
        const tr = { x, y: h, z, type, s, rot: rng.range(0, Math.PI * 2), lean: palm ? rng.range(0.05, 0.3) : 0, leanDir: rng.range(0, Math.PI * 2) };
        world.trees.push(tr);
        const r = palm ? 0.24 * s : (type === 2 ? 0.5 * s : 0.38 * s);
        const th = palm ? 8.5 * s : (type === 2 ? 12 * s : 7 * s);
        world.cyls.push({ x, z, r, y0: h - 1, y1: h + th, kind: 'tree' });
      }
    }
    flushCyls();
    // rocks, in loose clusters
    for (let k = 0; k < 34; k++) {
      const cx = rng.range(-250, 250), cz = rng.range(-250, 250);
      if (heightAt(cx, cz) < 1.2 || inClearZone(cx, cz)) continue;
      const count = rng.int(1, 4);
      for (let q = 0; q < count; q++) {
        const x = cx + rng.range(-5, 5), z = cz + rng.range(-5, 5);
        const h = heightAt(x, z);
        if (h < 0.6 || boxNear(x, z, 3.2) || nearPath(x, z, 3)) continue;
        const s = rng.range(0.9, 2.5), sy = rng.range(0.55, 0.95);
        world.rocks.push({ x, y: h, z, s, sy, rot: rng.range(0, 6.28), seed: rng.int(0, 9999) });
        world.cyls.push({ x, z, r: s * 0.78, y0: h - 1, y1: h + s * sy * 0.82, kind: 'rock' });
      }
    }
    flushCyls();
    // bushes / ferns (visual only)
    for (let k = 0; k < 2600; k++) {
      const x = rng.range(-290, 290), z = rng.range(-290, 290);
      const h = heightAt(x, z);
      if (h < 1.3) continue;
      const dens = fbm(x * 0.02 + 1.4, z * 0.02 + 3.3, S + 91, 3);
      if (rng() > dens * 1.5 - 0.2) continue;
      if (inClearZone(x, z) || nearPath(x, z, 2.6) || boxNear(x, z, 1.4)) continue;
      world.bushes.push({ x, y: h, z, s: rng.range(0.7, 1.7), rot: rng.range(0, 6.28), type: rng.int(0, 2) });
    }
    // wilderness loot
    let tries = 0;
    while (tries++ < 400 && world.lootPoints.filter((l) => l.poi === -2).length < 16) {
      const x = rng.range(-230, 230), z = rng.range(-230, 230);
      if (heightAt(x, z) < 1.8 || inClearZone(x, z) || boxNear(x, z, 1.6)) continue;
      let close = false;
      for (const l of world.lootPoints) if (Math.hypot(l.x - x, l.z - z) < 26) { close = true; break; }
      if (close) continue;
      world.lootPoints.push({ x, y: heightAt(x, z), z, indoor: false, poi: -2 });
    }
  }
  // snap outdoor loot to the ground and nudge it clear of props
  for (const l of world.lootPoints) {
    if (l.indoor || l.fixed) continue;
    let guard = 0;
    while (guard++ < 12 && boxNear(l.x, l.z, 0.8)) { l.x += rng.range(-1.2, 1.2); l.z += rng.range(-1.2, 1.2); }
    if (!(l.poi >= 0 && l.y > heightAt(l.x, l.z) + 0.5)) l.y = Math.max(l.y, heightAt(l.x, l.z));
  }

  // ---------------------------------------------------------------- ground support + collision queries
  // Height of whatever the actor would stand on at (x,z) given current feet height y.
  world.groundAt = function (x, z, y, out) {
    let g = heightAt(x, z), slide = null;
    const gx = clamp(Math.floor((x + HALF) / GC), 0, GN - 1), gz = clamp(Math.floor((z + HALF) / GC), 0, GN - 1);
    const list = gridBoxes[gz * GN + gx];
    for (let k = 0; k < list.length; k++) {
      const b = world.boxes[list[k]];
      const px = x - b.x, pz = z - b.z;
      const lx = px * b.c - pz * b.s, lz = px * b.s + pz * b.c;
      if (Math.abs(lx) > b.hx || Math.abs(lz) > b.hz) continue;
      let top = b.y1;
      if (b.rise) top += b.rise * (1 - Math.abs(lz) / b.hz);
      if (top <= y + 0.42 && top > g) { g = top; slide = b.slide ? b : null; }
    }
    if (out) out.slide = slide;
    return g;
  };

  // Push a circle (x,z,r) spanning feet y..y+h out of static colliders. Mutates and returns `p`.
  world.collide = function (p, r, y, h, step) {
    for (let iter = 0; iter < 2; iter++) {
      const [x0, x1, z0, z1] = cellRange(p.x, p.z, r, r);
      for (let gz = z0; gz <= z1; gz++) {
        for (let gx = x0; gx <= x1; gx++) {
          const ci = gz * GN + gx;
          const list = gridBoxes[ci];
          for (let k = 0; k < list.length; k++) {
            const b = world.boxes[list[k]];
            if (y + step >= b.y1 || y + h <= b.y0) continue;
            const px = p.x - b.x, pz = p.z - b.z;
            const lx = px * b.c - pz * b.s, lz = px * b.s + pz * b.c;
            const qx = clamp(lx, -b.hx, b.hx), qz = clamp(lz, -b.hz, b.hz);
            let ddx = lx - qx, ddz = lz - qz;
            const d2 = ddx * ddx + ddz * ddz;
            if (d2 >= r * r) continue;
            let nx, nz, pen;
            if (d2 > 1e-10) {
              const dd = Math.sqrt(d2); nx = ddx / dd; nz = ddz / dd; pen = r - dd;
            } else { // centre is inside the box: leave by the nearest face
              const ox = b.hx - Math.abs(lx), oz = b.hz - Math.abs(lz);
              if (ox < oz) { nx = lx < 0 ? -1 : 1; nz = 0; pen = ox + r; }
              else { nx = 0; nz = lz < 0 ? -1 : 1; pen = oz + r; }
            }
            p.x += (nx * b.c + nz * b.s) * pen;
            p.z += (-nx * b.s + nz * b.c) * pen;
            p.hit = true;
          }
          const cl = gridCyls[ci];
          for (let k = 0; k < cl.length; k++) {
            const cy = world.cyls[cl[k]];
            if (y + step >= cy.y1 || y + h <= cy.y0) continue;
            const ddx = p.x - cy.x, ddz = p.z - cy.z;
            const rr = r + cy.r, d2 = ddx * ddx + ddz * ddz;
            if (d2 >= rr * rr) continue;
            const dd = Math.sqrt(d2) || 0.0001;
            p.x += (ddx / dd) * (rr - dd); p.z += (ddz / dd) * (rr - dd);
            p.hit = true;
          }
        }
      }
    }
    return p;
  };

  // ---------------------------------------------------------------- raycast
  const boxStamp = new Uint32Array(world.boxes.length);
  const cylStamp = new Uint32Array(world.cyls.length);
  let stamp = 1;
  const H = { t: 0, nx: 0, ny: 1, nz: 0, kind: '' };

  function rayBox(b, ox, oy, oz, dx, dy, dz, maxT) {
    const px = ox - b.x, pz = oz - b.z;
    const lox = px * b.c - pz * b.s, loz = px * b.s + pz * b.c;
    const ldx = dx * b.c - dz * b.s, ldz = dx * b.s + dz * b.c;
    let tmin = 0, tmax = maxT, axis = -1, sgn = 0;
    if (Math.abs(ldx) < 1e-9) { if (lox < -b.hx || lox > b.hx) return -1; }
    else {
      const inv = 1 / ldx; let t1 = (-b.hx - lox) * inv, t2 = (b.hx - lox) * inv, sg = -1;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; sg = 1; }
      if (t1 > tmin) { tmin = t1; axis = 0; sgn = sg; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (Math.abs(dy) < 1e-9) { if (oy < b.y0 || oy > b.y1) return -1; }
    else {
      const inv = 1 / dy; let t1 = (b.y0 - oy) * inv, t2 = (b.y1 - oy) * inv, sg = -1;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; sg = 1; }
      if (t1 > tmin) { tmin = t1; axis = 1; sgn = sg; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (Math.abs(ldz) < 1e-9) { if (loz < -b.hz || loz > b.hz) return -1; }
    else {
      const inv = 1 / ldz; let t1 = (-b.hz - loz) * inv, t2 = (b.hz - loz) * inv, sg = -1;
      if (t1 > t2) { const q = t1; t1 = t2; t2 = q; sg = 1; }
      if (t1 > tmin) { tmin = t1; axis = 2; sgn = sg; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (axis === 0) { H.nx = sgn * b.c; H.ny = 0; H.nz = -sgn * b.s; }
    else if (axis === 1) { H.nx = 0; H.ny = sgn; H.nz = 0; }
    else if (axis === 2) { H.nx = sgn * b.s; H.ny = 0; H.nz = sgn * b.c; }
    else { H.nx = -dx; H.ny = -dy; H.nz = -dz; }
    return tmin;
  }
  world.rayBox = rayBox;
  world.rayHitNormal = H;

  function rayCyl(cy, ox, oy, oz, dx, dy, dz, maxT) {
    const px = ox - cy.x, pz = oz - cy.z;
    const a = dx * dx + dz * dz;
    if (a < 1e-9) return -1;
    const b = px * dx + pz * dz, c = px * px + pz * pz - cy.r * cy.r;
    const disc = b * b - a * c;
    if (disc < 0) return -1;
    let t = (-b - Math.sqrt(disc)) / a;
    if (t < 0) { if (c < 0) t = 0; else return -1; }
    if (t > maxT) return -1;
    const y = oy + dy * t;
    if (y < cy.y0 || y > cy.y1) return -1;
    H.nx = (ox + dx * t - cy.x) / cy.r; H.ny = 0; H.nz = (oz + dz * t - cy.z) / cy.r;
    return t;
  }

  // Nearest hit of a ray against terrain and static colliders. Direction must be normalised.
  // Returns t (distance) or -1, and fills `out` {t, nx, ny, nz, kind} when given.
  world.raycast = function (ox, oy, oz, dx, dy, dz, maxT, out, skipCyl) {
    let best = maxT, kind = '', bnx = 0, bny = 1, bnz = 0;
    // terrain: march, then bisect
    {
      let t = 0, prev = 0;
      const maxH = world.maxHeight + 0.5;
      let stepT = 1.0;
      if (oy > maxH && dy >= 0) t = maxT + 1; // climbing away above everything
      while (t <= maxT) {
        const y = oy + dy * t;
        if (y > maxH && dy >= 0) break;
        if (y <= maxH) {
          const hgt = heightAt(ox + dx * t, oz + dz * t);
          if (y < hgt) {
            let lo = prev, hi = t;
            for (let k = 0; k < 6; k++) {
              const mid = (lo + hi) / 2;
              if (oy + dy * mid < heightAt(ox + dx * mid, oz + dz * mid)) hi = mid; else lo = mid;
            }
            best = hi; kind = 'terrain';
            const e = 0.6, hxp = ox + dx * hi, hzp = oz + dz * hi;
            const tnx = heightAt(hxp - e, hzp) - heightAt(hxp + e, hzp), tnz = heightAt(hxp, hzp - e) - heightAt(hxp, hzp + e);
            const l = Math.hypot(tnx, 2 * e, tnz); bnx = tnx / l; bny = 2 * e / l; bnz = tnz / l;
            break;
          }
        }
        prev = t;
        stepT = t < 30 ? 0.75 : (t < 90 ? 1.5 : 2.5);
        if (y > maxH) { // skip ahead to where the ray drops under the highest peak
          const skip = (maxH - y) / dy;
          t += Math.max(stepT, skip - 0.5);
        } else t += stepT;
      }
    }
    // static colliders via 2D DDA over the spatial grid
    stamp++;
    if (stamp > 4294967000) { boxStamp.fill(0); cylStamp.fill(0); stamp = 1; }
    let cx = Math.floor((ox + HALF) / GC), cz = Math.floor((oz + HALF) / GC);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDX = Math.abs(dx) > 1e-9 ? GC / Math.abs(dx) : Infinity;
    const tDZ = Math.abs(dz) > 1e-9 ? GC / Math.abs(dz) : Infinity;
    const bx = (cx + (dx > 0 ? 1 : 0)) * GC - HALF, bz = (cz + (dz > 0 ? 1 : 0)) * GC - HALF;
    let tMX = Math.abs(dx) > 1e-9 ? (bx - ox) / dx : Infinity;
    let tMZ = Math.abs(dz) > 1e-9 ? (bz - oz) / dz : Infinity;
    let tEnter = 0, guard = 0;
    while (tEnter <= best && guard++ < 260) {
      if (cx >= 0 && cx < GN && cz >= 0 && cz < GN) {
        const ci = cz * GN + cx;
        const bl = gridBoxes[ci];
        for (let k = 0; k < bl.length; k++) {
          const id = bl[k];
          if (boxStamp[id] === stamp) continue;
          boxStamp[id] = stamp;
          const b = world.boxes[id];
          const t = rayBox(b, ox, oy, oz, dx, dy, dz, best);
          if (t >= 0 && t < best) { best = t; kind = b.kind; bnx = H.nx; bny = H.ny; bnz = H.nz; }
        }
        const cl = gridCyls[ci];
        for (let k = 0; k < cl.length; k++) {
          const id = cl[k];
          if (cylStamp[id] === stamp) continue;
          cylStamp[id] = stamp;
          const cy = world.cyls[id];
          if (skipCyl && cy.r < 1.2) continue; // camera rays pass through trunks and poles
          const t = rayCyl(cy, ox, oy, oz, dx, dy, dz, best);
          if (t >= 0 && t < best) { best = t; kind = cy.kind; bnx = H.nx; bny = H.ny; bnz = H.nz; }
        }
      } else if ((cx < 0 && stepX < 0) || (cx >= GN && stepX > 0) || (cz < 0 && stepZ < 0) || (cz >= GN && stepZ > 0)) break;
      if (tMX < tMZ) { tEnter = tMX; tMX += tDX; cx += stepX; }
      else { tEnter = tMZ; tMZ += tDZ; cz += stepZ; }
      if (tEnter === Infinity) break;
    }
    if (kind === '') return -1;
    if (out) { out.t = best; out.nx = bnx; out.ny = bny; out.nz = bnz; out.kind = kind; }
    return best;
  };

  // True if the straight segment a->b is blocked by terrain or a static collider.
  world.blocked = function (ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.05) return false;
    const t = world.raycast(ax, ay, az, dx / len, dy / len, dz / len, len - 0.05, null);
    return t >= 0;
  };

  // ---------------------------------------------------------------- navigation grid (1 m cells)
  {
    const NN = WORLD.NAV_N, nav = new Uint8Array(NN * NN);
    const R = 0.46;
    for (let iz = 0; iz < NN; iz++) {
      for (let ix = 0; ix < NN; ix++) {
        const x = ix - HALF + 0.5, z = iz - HALF + 0.5;
        if (x * x + z * z > 306 * 306 || heightAt(x, z) < -0.85) nav[iz * NN + ix] = 1;
      }
    }
    const mark = (x, z, ex, ez, test) => {
      const x0 = clamp(Math.floor(x - ex + HALF), 0, NN - 1), x1 = clamp(Math.floor(x + ex + HALF), 0, NN - 1);
      const z0 = clamp(Math.floor(z - ez + HALF), 0, NN - 1), z1 = clamp(Math.floor(z + ez + HALF), 0, NN - 1);
      for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) if (test(ix - HALF + 0.5, iz - HALF + 0.5)) nav[iz * NN + ix] = 1;
    };
    for (const b of world.boxes) {
      if (b.walk) continue;
      const g = heightAt(b.x, b.z);
      if (b.y0 > g + 1.3 || b.y1 < g + 0.42) continue;
      const ex = Math.abs(b.c) * b.hx + Math.abs(b.s) * b.hz + R, ez = Math.abs(b.s) * b.hx + Math.abs(b.c) * b.hz + R;
      mark(b.x, b.z, ex, ez, (x, z) => {
        const px = x - b.x, pz = z - b.z;
        const lx = px * b.c - pz * b.s, lz = px * b.s + pz * b.c;
        const ddx = Math.max(Math.abs(lx) - b.hx, 0), ddz = Math.max(Math.abs(lz) - b.hz, 0);
        return ddx * ddx + ddz * ddz < R * R;
      });
    }
    for (const cy of world.cyls) {
      const g = heightAt(cy.x, cy.z);
      if (cy.y0 > g + 1.3 || cy.y1 < g + 0.42) continue;
      const rr = cy.r + R;
      mark(cy.x, cy.z, rr, rr, (x, z) => (x - cy.x) * (x - cy.x) + (z - cy.z) * (z - cy.z) < rr * rr);
    }
    world.nav = nav;
    world.navDyn = new Uint8Array(NN * NN);

    const cellOf = (x, z) => clamp(Math.floor(z + HALF), 0, NN - 1) * NN + clamp(Math.floor(x + HALF), 0, NN - 1);
    world.navCell = cellOf;
    // nearest walkable cell centre to a point, searched in growing rings
    world.navFree = function (x, z, maxR) {
      const ix = clamp(Math.floor(x + HALF), 0, NN - 1), iz = clamp(Math.floor(z + HALF), 0, NN - 1);
      if (!nav[iz * NN + ix] && !world.navDyn[iz * NN + ix]) return iz * NN + ix;
      const lim = maxR || 8;
      for (let r = 1; r <= lim; r++) {
        let bestI = -1, bestD = 1e9;
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const jx = ix + dx, jz = iz + dz;
            if (jx < 0 || jz < 0 || jx >= NN || jz >= NN) continue;
            const ci = jz * NN + jx;
            if (nav[ci] || world.navDyn[ci]) continue;
            const dd = dx * dx + dz * dz;
            if (dd < bestD) { bestD = dd; bestI = ci; }
          }
        }
        if (bestI >= 0) return bestI;
      }
      return -1;
    };

    // Doors become portal edges so narrow openings are always traversable through their centre.
    const portals = new Map();
    for (const d of world.doors) {
      const reach = 1.3;
      const ox = d.x + d.nx * reach, oz = d.z + d.nz * reach, ix2 = d.x - d.nx * reach, iz2 = d.z - d.nz * reach;
      const a = world.navFree(ox, oz, 3), b = world.navFree(ix2, iz2, 3);
      if (a < 0 || b < 0 || a === b) continue;
      const e1 = { to: b, cost: reach * 2, ax: ox, az: oz, bx: ix2, bz: iz2 };
      const e2 = { to: a, cost: reach * 2, ax: ix2, az: iz2, bx: ox, bz: oz };
      if (!portals.has(a)) portals.set(a, []);
      if (!portals.has(b)) portals.set(b, []);
      portals.get(a).push(e1); portals.get(b).push(e2);
    }
    world.portals = portals;
  }

  world.gridInfo = { GC, GN };
  return world;
}
