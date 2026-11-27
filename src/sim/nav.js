// Grid A* over the 1 m navigation grid, with door portals and string-pulled output paths.
import { WORLD } from './config.js';

const NN = WORLD.NAV_N, HALF = WORLD.HALF;
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
const COST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

export function createPathfinder(world) {
  const size = NN * NN;
  const gScore = new Float32Array(size);
  const parent = new Int32Array(size);
  const via = new Int32Array(size);        // portal edge index used to reach the cell, or -1
  const seen = new Uint32Array(size);      // generation when gScore became valid
  const closed = new Uint32Array(size);
  let heapCell = new Int32Array(8192), heapF = new Float32Array(8192), heapN = 0;
  let gen = 0;

  const edges = [];
  for (const list of world.portals.values()) for (const e of list) { e.idx = edges.length; edges.push(e); }

  const nav = world.nav, dyn = world.navDyn;
  const isBlocked = (c) => nav[c] !== 0 || dyn[c] !== 0;

  function push(cell, f) {
    if (heapN >= heapCell.length) {
      const nc = new Int32Array(heapCell.length * 2); nc.set(heapCell); heapCell = nc;
      const nf = new Float32Array(heapF.length * 2); nf.set(heapF); heapF = nf;
    }
    let i = heapN++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= f) break;
      heapCell[i] = heapCell[p]; heapF[i] = heapF[p]; i = p;
    }
    heapCell[i] = cell; heapF[i] = f;
  }
  function pop() {
    const top = heapCell[0];
    heapN--;
    if (heapN > 0) {
      const cell = heapCell[heapN], f = heapF[heapN];
      let i = 0;
      for (;;) {
        let l = i * 2 + 1;
        if (l >= heapN) break;
        if (l + 1 < heapN && heapF[l + 1] < heapF[l]) l++;
        if (heapF[l] >= f) break;
        heapCell[i] = heapCell[l]; heapF[i] = heapF[l]; i = l;
      }
      heapCell[i] = cell; heapF[i] = f;
    }
    return top;
  }

  // Walkability along a straight segment (sampled).
  function clear(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    const n = Math.max(1, Math.ceil(len / 0.45));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = ax + dx * t, z = az + dz * t;
      const ix = Math.floor(x + HALF), iz = Math.floor(z + HALF);
      if (ix < 0 || iz < 0 || ix >= NN || iz >= NN) return false;
      if (isBlocked(iz * NN + ix)) return false;
    }
    return true;
  }

  // Returns [{x,z}, ...] from near (sx,sz) to near (tx,tz), or null when no route exists.
  function find(sx, sz, tx, tz, maxExpand) {
    const start = world.navFree(sx, sz, 5), goal = world.navFree(tx, tz, 7);
    if (start < 0 || goal < 0) return null;
    const gx = goal % NN, gz = (goal / NN) | 0;
    if (start === goal) return [{ x: tx, z: tz }];
    gen++;
    heapN = 0;
    const limit = maxExpand || 9000;   // bounds the worst search to a few milliseconds; beyond it a partial path is returned
    gScore[start] = 0; parent[start] = -1; via[start] = -1; seen[start] = gen;
    const h0 = Math.hypot((start % NN) - gx, ((start / NN) | 0) - gz);
    push(start, h0 * 1.12);
    let found = false, expanded = 0, bestCell = start, bestH = h0;
    while (heapN > 0) {
      const c = pop();
      if (closed[c] === gen) continue;
      closed[c] = gen;
      if (c === goal) { found = true; break; }
      if (++expanded > limit) break;
      const cx = c % NN, cz = (c / NN) | 0, gc = gScore[c];
      for (let k = 0; k < 8; k++) {
        const nx = cx + DX[k], nz = cz + DZ[k];
        if (nx < 0 || nz < 0 || nx >= NN || nz >= NN) continue;
        const n = nz * NN + nx;
        if (closed[n] === gen || isBlocked(n)) continue;
        if (k >= 4 && (isBlocked(cz * NN + nx) || isBlocked(nz * NN + cx))) continue; // no corner cutting
        const ng = gc + COST[k];
        if (seen[n] === gen && gScore[n] <= ng) continue;
        gScore[n] = ng; parent[n] = c; via[n] = -1; seen[n] = gen;
        const ax = Math.abs(nx - gx), az = Math.abs(nz - gz);
        const h = (ax > az ? ax + az * 0.4142 : az + ax * 0.4142);
        if (h < bestH) { bestH = h; bestCell = n; }
        push(n, ng + h * 1.12);
      }
      const pl = world.portals.get(c);
      if (pl) {
        for (let k = 0; k < pl.length; k++) {
          const e = pl[k], n = e.to;
          if (closed[n] === gen || isBlocked(n)) continue;
          const ng = gc + e.cost;
          if (seen[n] === gen && gScore[n] <= ng) continue;
          gScore[n] = ng; parent[n] = c; via[n] = e.idx; seen[n] = gen;
          const ax = Math.abs((n % NN) - gx), az = Math.abs(((n / NN) | 0) - gz);
          push(n, ng + (ax > az ? ax + az * 0.4142 : az + ax * 0.4142) * 1.12);
        }
      }
    }
    let end = found ? goal : bestCell;
    if (!found && bestH > h0 - 2) return null; // made no real progress
    // rebuild (goal -> start), inserting exact door points for portal hops
    const raw = [];
    if (found) raw.push({ x: tx, z: tz, hard: false });
    let c = end;
    while (c !== -1) {
      if (via[c] >= 0) {
        const e = edges[via[c]];
        raw.push({ x: e.bx, z: e.bz, hard: true });
        raw.push({ x: e.ax, z: e.az, hard: true });
      } else if (!(found && c === goal && raw.length === 1 && Math.hypot(raw[0].x - ((c % NN) - HALF + 0.5), raw[0].z - (((c / NN) | 0) - HALF + 0.5)) < 1.5)) {
        raw.push({ x: (c % NN) - HALF + 0.5, z: ((c / NN) | 0) - HALF + 0.5, hard: false });
      }
      c = parent[c];
    }
    raw.reverse();
    // string pulling: skip waypoints while the straight line stays walkable; never skip door points
    const out = [];
    let i = 0;
    let curX = sx, curZ = sz;
    while (i < raw.length) {
      let j = i;
      while (j + 1 < raw.length && !raw[j].hard && clear(curX, curZ, raw[j + 1].x, raw[j + 1].z)) j++;
      out.push({ x: raw[j].x, z: raw[j].z });
      curX = raw[j].x; curZ = raw[j].z;
      i = j + 1;
    }
    out.partial = !found;
    return out;
  }

  return { find, clear, isBlocked };
}
