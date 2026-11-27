// LAST CORDON match simulation: actors, movement, hitscan combat, loot, deployable walls,
// the shrinking Cordon and the pacing director. Deterministic for a given (world, seed).
// No DOM and no three.js in here: the renderer, HUD and audio only read state and drain events.
import {
  ACTOR, WEAPONS, ZONE_PHASES, ZONE_START_RADIUS, ZONE_FINAL_DPS, WALL, DROP, LOOT_COUNTS,
  LOOT_PICKUP_RADIUS, BOT_NAMES, TOTAL_ACTORS, TICK, ALIVE_CURVE, WORLD,
} from './config.js';
import { mulberry32, clamp, lerp } from './rng.js';
import { createPathfinder } from './nav.js';
import { botInit, botThink, botOnHurt } from './bots.js';

const DEG = Math.PI / 180;
const NN = WORLD.NAV_N, HALF = WORLD.HALF;
const P = { x: 0, z: 0, hit: false };
const RH = { t: 0, nx: 0, ny: 1, nz: 0, kind: '' };
const GS = { slide: null };
const CAM = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1, back: 0, scoped: false };
const HIT = { t: -1, type: '', actor: null, zone: '', wall: null, nx: 0, ny: 1, nz: 0, kind: '' };
let rayZone = 'body';

function makeCmd() {
  return { mx: 0, mz: 0, fire: false, ads: false, jump: false, crouch: false, sprint: false, reload: false, heal: false, wall: false, sw: -1 };
}

export function makeActor(id, name, isPlayer) {
  return {
    id, name, isPlayer, alive: true, state: 'drop',
    x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0,
    yaw: 0, pitch: 0, onGround: false, crouch: false, sprinting: false, swimming: false,
    hp: ACTOR.MAX_HP, armor: 0, helmet: 0,
    weapons: [null, null, null], reserve: [0, 0, 0], cur: -1,
    fireCd: 0, reloadT: 0, switchT: 0, dryCd: 0,
    medkits: 0, healT: 0, walls: ACTOR.START_WALLS, wallCd: 0,
    bloom: 0, ads: 0, recoilP: 0,
    kills: 0, dmgDealt: 0, shots: 0, hits: 0, headshots: 0,
    lastHitBy: -1, lastHitT: -99, lastHurtT: -99, hurtDirX: 0, hurtDirZ: 0, lastShotT: -99,
    speed: 0, animPhase: 0, stepAcc: 0, zoneAcc: 0, outside: false,
    landT: 0, deathT: 0, killerId: -1, place: 0, deathYaw: 0,
    cmd: makeCmd(), ai: null,
  };
}

// Third-person camera for an actor standing at (x,y,z). Shared by the sim (for aiming) and the renderer.
export function computeCamera(game, a, x, y, z, out) {
  const cp = Math.cos(a.pitch), sp = Math.sin(a.pitch);
  const sy = Math.sin(a.yaw), cy = Math.cos(a.yaw);
  const fx = -sy * cp, fy = sp, fz = -cy * cp;
  const rx = cy, rz = -sy;
  const w = a.cur >= 0 ? WEAPONS[a.cur] : null;
  const scope = !!(w && w.scope);
  const ads = a.ads;
  let side, back, up;
  if (a.state === 'drop') { side = 0; back = 13.5; up = 6.2; }
  else if (scope) { side = lerp(0.62, 0.0, ads); back = lerp(3.05, -0.28, ads); up = lerp(0.3, 0.0, ads); }
  else { side = lerp(0.62, 0.4, ads); back = lerp(3.05, 1.2, ads); up = lerp(0.3, 0.15, ads); }
  const hy = y + (a.crouch ? 1.18 : 1.6) + up;
  if (side > 0.02) {
    const t = game.rayStatic(x, hy, z, rx, 0, rz, side + 0.28, null, true);
    if (t >= 0) side = Math.max(0, t - 0.28);
  }
  const px = x + rx * side, pz = z + rz * side;
  if (back > 0.05) {
    const t = game.rayStatic(px, hy, pz, -fx, -fy, -fz, back + 0.3, null, true);
    if (t >= 0) back = Math.max(0.15, t - 0.3);
  }
  out.x = px - fx * back; out.y = hy - fy * back; out.z = pz - fz * back;
  out.fx = fx; out.fy = fy; out.fz = fz; out.back = back;
  out.scoped = scope && ads > 0.9;
  return out;
}

// Collision boxes of a Bulwark wall whose middle stands at (cx, cz) facing yaw.
export function wallSegments(cx, cz, base, yaw) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const R = WALL.ARC_RADIUS, n = WALL.SEGMENTS;
  const ocx = cx - fx * R, ocz = cz - fz * R;           // centre of curvature (behind the wall)
  const a0 = Math.atan2(fz, fx), segs = [];
  for (let k = 0; k < n; k++) {
    const t0 = a0 - WALL.ARC_ANGLE / 2 + (WALL.ARC_ANGLE * k) / n, t1 = a0 - WALL.ARC_ANGLE / 2 + (WALL.ARC_ANGLE * (k + 1)) / n;
    const x0 = ocx + Math.cos(t0) * R, z0 = ocz + Math.sin(t0) * R, x1 = ocx + Math.cos(t1) * R, z1 = ocz + Math.sin(t1) * R;
    const tx = x1 - x0, tz = z1 - z0, len = Math.hypot(tx, tz);
    const sy = Math.atan2(-tz, tx);
    segs.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, hx: len / 2 + 0.03, hz: WALL.THICK / 2, c: Math.cos(sy), s: Math.sin(sy), y0: base - 0.4, y1: base + WALL.HEIGHT, kind: 'bulwark', yaw: sy });
  }
  return segs;
}

export class Game {
  constructor(world, opts = {}) {
    this.world = world;
    this.seed = opts.seed == null ? 1 : opts.seed;
    this.rng = mulberry32(this.seed * 7919 + 13);
    this.autopilot = !!opts.autopilot;
    this.difficulty = opts.difficulty == null ? 1 : opts.difficulty;
    this.collectEvents = opts.collectEvents !== false;
    this.god = !!opts.god;
    this.time = 0; this.tickN = 0;
    this.phase = 'drop';
    this.over = false; this.winner = null;
    this.actors = []; this.loot = []; this.walls = []; this.events = [];
    this.gunfire = [];                 // recent shots, for bot hearing and the minimap
    // Human slots come first (actor ids 0..humans-1); the rest of the field is bots.
    this.humans = (opts.humans && opts.humans.length) ? opts.humans.slice(0, TOTAL_ACTORS) : ['YOU'];
    this.total = Math.max(this.humans.length, Math.min(TOTAL_ACTORS, opts.total == null ? TOTAL_ACTORS : opts.total));
    this.botHumans = !!opts.botHumans;        // tests: let bot brains drive the human slots
    this.alive = this.total;
    this.director = { lethality: 1, aggro: 1, aimScale: 1, dmgScale: 1, target: this.total };
    this.watchers = null;                     // multiplayer: the actors whose surroundings must play out honestly
    this.lagComp = !!opts.lagComp;            // multiplayer: rewind targets to what the shooter saw
    this.hist = this.lagComp ? Array.from({ length: 48 }, () => new Float32Array(this.total * 4)) : null;
    this.path = createPathfinder(world);
    this.pathBudget = 0; this.pathCalls = 0; this.pacedSaves = 0;
    this.pathMs = 0; this.pathMaxMs = 0; this.pathFails = 0;
    this.pace = this.rng.range(0.9, 1.08);   // each match runs a little hotter or cooler
    this.slots = new Map();
    this.nextId = 1;
    world.navDyn.fill(0);
    this._initZone();
    this._spawnLoot();
    this._spawnActors();
    this.player = this.actors[0];
    this.focus = opts.focus === false ? null : this.actors[0];
    if (this.lagComp) this._record();
  }

  emit(type, data) {
    if (!this.collectEvents) return;
    data.type = type; data.time = this.time;
    this.events.push(data);
  }

  // ------------------------------------------------------------------ setup
  _landPoint(cx, cz, maxR, minH) {
    const w = this.world;
    for (let i = 0; i < 60; i++) {
      const a = this.rng() * Math.PI * 2, r = Math.sqrt(this.rng()) * maxR;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (w.heightAt(x, z) > (minH || 1.6) && !w.nav[w.navCell(x, z)]) return { x, z };
    }
    return { x: cx, z: cz };
  }

  _initZone() {
    const first = this._landPoint(0, 0, 105, 2);
    this.zone = {
      cx: 0, cz: 0, r: ZONE_START_RADIUS, phase: 0, state: 'wait', timer: ZONE_PHASES[0].wait,
      fromR: ZONE_START_RADIUS, fromX: 0, fromZ: 0,
      nextR: ZONE_PHASES[0].radius, nextX: first.x, nextZ: first.z,
      dps: ZONE_PHASES[0].dps, closed: false,
    };
  }

  _pickNext(phase) {
    const z = this.zone, ph = ZONE_PHASES[phase];
    if (ph.radius < 10) return { x: z.nextX, z: z.nextZ };
    const slack = Math.max(0, (z.nextR - ph.radius) * 0.85);
    return this._landPoint(z.nextX, z.nextZ, slack, 1.8);
  }

  _spawnLoot() {
    const rng = this.rng, w = this.world;
    const groups = new Map();
    for (const p of w.lootPoints) {
      if (!groups.has(p.poi)) groups.set(p.poi, []);
      groups.get(p.poi).push(p);
    }
    for (const g of groups.values()) rng.shuffle(g);
    const keys = rng.shuffle([...groups.keys()]);
    const order = [];
    for (let more = true; more;) {
      more = false;
      for (const k of keys) { const g = groups.get(k); if (g.length) { order.push(g.pop()); more = true; } }
    }
    // evenly interleaved type sequence
    const types = Object.keys(LOOT_COUNTS), left = types.map((t) => LOOT_COUNTS[t]);
    const total = left.reduce((s, v) => s + v, 0);
    const acc = types.map(() => 0);
    const seq = [];
    for (let i = 0; i < total; i++) {
      let best = -1, bv = -1e9;
      for (let k = 0; k < types.length; k++) {
        if (left[k] <= 0) continue;
        acc[k] += LOOT_COUNTS[types[k]] / total;
        if (acc[k] > bv) { bv = acc[k]; best = k; }
      }
      acc[best] -= 1; left[best]--; seq.push(types[best]);
    }
    for (let i = 0; i < seq.length && i < order.length; i++) {
      const p = order[i];
      this.loot.push({ id: this.nextId++, type: seq[i], x: p.x, y: p.y, z: p.z, alive: true, dropped: false, born: 0 });
    }
  }

  _spawnActors() {
    const rng = this.rng, w = this.world;
    const ang = rng() * Math.PI * 2;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const ox = rng.range(-45, 45), oz = rng.range(-45, 45);
    this.flight = { x0: ox - dx * 300, z0: oz - dz * 300, x1: ox + dx * 300, z1: oz + dz * 300, dx, dz, y: DROP.ALTITUDE + 22 };
    const names = rng.shuffle(BOT_NAMES.slice());
    // spread landing targets across weapon crates (farthest-point sampling) so the drop is not a brawl
    const cand = rng.shuffle(this.loot.filter((l) => l.type === 'ar' || l.type === 'smg' || l.type === 'sr').slice());
    const targets = [];
    while (targets.length < this.total && cand.length) {
      let bi = 0, bd = -1;
      for (let k = 0; k < cand.length; k++) {
        let md = 1e9;
        for (const t of targets) md = Math.min(md, Math.hypot(t.x - cand[k].x, t.z - cand[k].z));
        md += rng() * 12;
        if (md > bd) { bd = md; bi = k; }
      }
      targets.push(cand.splice(bi, 1)[0]);
    }
    const H = this.humans.length;
    for (let i = 0; i < this.total; i++) {
      const human = i < H;
      const a = makeActor(i, human ? this.humans[i] : names[(i - H) % names.length], human);
      const t = human ? (H === 1 ? rng.range(-28, 28) : rng.range(-90, 90)) : rng.range(-190, 190);
      const lat = rng.range(-22, 22);
      a.x = ox + dx * t - dz * lat; a.z = oz + dz * t + dx * lat;
      const rr = Math.hypot(a.x, a.z);
      if (rr > 250) { a.x *= 250 / rr; a.z *= 250 / rr; }
      a.y = DROP.ALTITUDE + rng.range(0, 16);
      a.px = a.x; a.py = a.y; a.pz = a.z;
      a.yaw = Math.atan2(-dx, -dz); a.pitch = -0.55;
      if (!human || (this.autopilot && i === 0) || this.botHumans) {
        botInit(this, a);
        let bi = -1, bd = 1e9;                          // nearest unclaimed landing target
        for (let k = 0; k < targets.length; k++) {
          if (targets[k].claimed === this.seed) continue;
          const d = Math.hypot(targets[k].x - a.x, targets[k].z - a.z);
          if (d < bd) { bd = d; bi = k; }
        }
        const tg = bi >= 0 ? targets[bi] : { x: 0, z: 0 };
        if (bi >= 0) tg.claimed = this.seed;
        a.ai.dropX = tg.x + rng.range(-4, 4); a.ai.dropZ = tg.z + rng.range(-4, 4);
      }
      this.actors.push(a);
    }
  }

  // ------------------------------------------------------------------ ray queries
  // Static world plus deployed walls. Returns distance or -1.
  rayStatic(ox, oy, oz, dx, dy, dz, maxT, out, skipCyl) {
    const w = this.world;
    let best = w.raycast(ox, oy, oz, dx, dy, dz, maxT, out || RH, skipCyl);
    let lim = best >= 0 ? best : maxT;
    const walls = this.walls;
    for (let i = 0; i < walls.length; i++) {
      const wl = walls[i];
      const cx = wl.x - ox, cz = wl.z - oz, cyy = wl.y + 1.2 - oy;
      const proj = cx * dx + cyy * dy + cz * dz;
      if (proj < -3 || proj > lim + 3) continue;
      const d2 = cx * cx + cyy * cyy + cz * cz - proj * proj;
      if (d2 > 9.5) continue;
      for (let k = 0; k < wl.segs.length; k++) {
        const t = w.rayBox(wl.segs[k], ox, oy, oz, dx, dy, dz, lim);
        if (t >= 0 && t < lim) {
          lim = t; best = t;
          if (out) { const n = w.rayHitNormal; out.t = t; out.nx = n.nx; out.ny = n.ny; out.nz = n.nz; out.kind = 'bulwark'; out.wall = wl; }
        }
      }
    }
    return best;
  }

  // Line of sight between two points (terrain, buildings, props, walls).
  los(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.1) return true;
    return this.rayStatic(ax, ay, az, dx / len, dy / len, dz / len, len - 0.08, null) < 0;
  }

  _rayActor(b, ox, oy, oz, dx, dy, dz, maxT) {
    const cx = b.x - ox, cyy = b.y + 0.9 - oy, cz = b.z - oz;
    const proj = cx * dx + cyy * dy + cz * dz;
    if (proj < -1.3 || proj > maxT + 1.3) return -1;
    if (cx * cx + cyy * cyy + cz * cz - proj * proj > 1.7) return -1;
    let best = -1;
    const hy = b.y + (b.crouch ? ACTOR.CROUCH_HEAD_Y : ACTOR.HEAD_Y);
    { // head sphere
      const sx = b.x - ox, syy = hy - oy, sz = b.z - oz;
      const tp = sx * dx + syy * dy + sz * dz;
      const d2 = sx * sx + syy * syy + sz * sz - tp * tp;
      const r2 = ACTOR.HEAD_R * ACTOR.HEAD_R;
      if (d2 <= r2) {
        const t = tp - Math.sqrt(r2 - d2);
        if (t >= 0 && t <= maxT) { best = t; rayZone = 'head'; }
      }
    }
    { // torso + legs: vertical cylinder
      const top = hy - 0.15, rad = 0.33;
      const px = ox - b.x, pz = oz - b.z;
      const a = dx * dx + dz * dz;
      if (a > 1e-9) {
        const bb = px * dx + pz * dz, c = px * px + pz * pz - rad * rad;
        const disc = bb * bb - a * c;
        if (disc >= 0) {
          let t = (-bb - Math.sqrt(disc)) / a;
          if (t < 0 && c < 0) t = 0;
          if (t >= 0 && t <= maxT) {
            const y = oy + dy * t;
            if (y >= b.y && y <= top && (best < 0 || t < best)) {
              best = t;
              rayZone = (y - b.y) < (b.crouch ? 0.45 : 0.78) ? 'leg' : 'body';
            }
          }
        }
      }
    }
    return best;
  }

  // Full bullet trace: world, walls and actors. Fills HIT and returns it.
  castAll(ox, oy, oz, dx, dy, dz, maxT, ignore) {
    HIT.type = ''; HIT.actor = null; HIT.wall = null; HIT.zone = ''; HIT.t = -1;
    RH.wall = null;
    let t = this.rayStatic(ox, oy, oz, dx, dy, dz, maxT, RH);
    let lim = maxT;
    if (t >= 0) {
      lim = t; HIT.t = t; HIT.nx = RH.nx; HIT.ny = RH.ny; HIT.nz = RH.nz; HIT.kind = RH.kind;
      if (RH.kind === 'bulwark') { HIT.type = 'wall'; HIT.wall = RH.wall; } else HIT.type = 'world';
    }
    const actors = this.actors;
    for (let i = 0; i < actors.length; i++) {
      const b = actors[i];
      if (!b.alive || b === ignore) continue;
      const ta = this._rayActor(b, ox, oy, oz, dx, dy, dz, lim);
      if (ta >= 0 && ta < lim) {
        lim = ta; HIT.t = ta; HIT.type = 'actor'; HIT.actor = b; HIT.zone = rayZone; HIT.wall = null;
        HIT.nx = -dx; HIT.ny = -dy; HIT.nz = -dz; HIT.kind = 'actor';
      }
    }
    return HIT;
  }

  // Attack slots: only a couple of bots may press any one human at once, so nobody gets swarmed.
  claimSlot(bot, target) {
    const key = target ? target.id : 0;
    let slots = this.slots.get(key);
    if (!slots) { slots = new Map(); this.slots.set(key, slots); }
    const time = this.time;
    for (const [id, exp] of slots) if (exp < time) slots.delete(id);
    if (slots.has(bot.id)) { slots.set(bot.id, time + 1.2); return true; }
    if (slots.size < (this.alive <= 5 ? 3 : 2)) { slots.set(bot.id, time + 1.2); return true; }
    return false;
  }

  // ---- lag compensation: positions of every actor for the last 48 ticks
  _record() {
    const h = this.hist[this.tickN % this.hist.length], A = this.actors;
    for (let i = 0; i < A.length; i++) { const a = A[i], k = i * 4; h[k] = a.x; h[k + 1] = a.y; h[k + 2] = a.z; h[k + 3] = a.crouch ? 1 : 0; }
  }
  _rewind(shooter) {
    const lag = Math.min(Math.round(shooter.lagTicks), this.hist.length - 2, this.tickN);
    if (lag <= 0) return false;
    const h = this.hist[(this.tickN - lag) % this.hist.length], A = this.actors;
    this._saved = this._saved || new Float32Array(A.length * 4);
    for (let i = 0; i < A.length; i++) {
      const a = A[i], k = i * 4;
      if (a === shooter) continue;
      this._saved[k] = a.x; this._saved[k + 1] = a.y; this._saved[k + 2] = a.z; this._saved[k + 3] = a.crouch ? 1 : 0;
      a.x = h[k]; a.y = h[k + 1]; a.z = h[k + 2]; a.crouch = h[k + 3] > 0.5;
    }
    return true;
  }
  _unrewind(shooter) {
    const A = this.actors, s = this._saved;
    for (let i = 0; i < A.length; i++) {
      const a = A[i], k = i * 4;
      if (a === shooter) continue;
      a.x = s[k]; a.y = s[k + 1]; a.z = s[k + 2]; a.crouch = s[k + 3] > 0.5;
    }
  }

  findPath(sx, sz, tx, tz) {
    if (this.pathBudget <= 0) return undefined; // try again next tick
    this.pathBudget--; this.pathCalls++;
    const t0 = performance.now();
    const r = this.path.find(sx, sz, tx, tz);
    const ms = performance.now() - t0;
    this.pathMs += ms;
    if (ms > this.pathMaxMs) this.pathMaxMs = ms;
    if (r === null) this.pathFails++;
    return r;
  }

  // ------------------------------------------------------------------ main step
  step(dt) {
    dt = dt || TICK;
    this.tickN++; this.time += dt;
    this.pathBudget = 2;
    this._updateZone(dt);
    this._updateDirector();
    const actors = this.actors;
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      if (!a.alive) continue;
      a.px = a.x; a.py = a.y; a.pz = a.z;
      if (a.ai) botThink(this, a, dt);
      if (a.state === 'drop') this._updateDrop(a, dt); else this._updateActor(a, dt);
    }
    this._separate();
    this._updateWalls(dt);
    if (this.lagComp) this._record();
    if (this.gunfire.length && this.time - this.gunfire[0].t > 6) this.gunfire.shift();
    if (this.phase === 'drop') {
      let landed = true;
      for (let i = 0; i < actors.length; i++) if (actors[i].alive && actors[i].state === 'drop') { landed = false; break; }
      if (landed) { this.phase = 'play'; this.emit('phase', { phase: 'play' }); }
    }
  }

  _updateZone(dt) {
    const z = this.zone;
    if (!z.closed) {
      z.timer -= dt;
      const ph = ZONE_PHASES[z.phase];
      if (z.state === 'wait') {
        if (z.timer <= 0) { z.state = 'shrink'; z.timer += ph.shrink; this.emit('zone', { what: 'shrink', phase: z.phase }); }
      }
      if (z.state === 'shrink') {
        const t = clamp(1 - z.timer / ph.shrink, 0, 1);
        z.r = lerp(z.fromR, z.nextR, t); z.cx = lerp(z.fromX, z.nextX, t); z.cz = lerp(z.fromZ, z.nextZ, t);
        if (z.timer <= 0) {
          z.r = z.nextR; z.cx = z.nextX; z.cz = z.nextZ;
          z.fromR = z.r; z.fromX = z.cx; z.fromZ = z.cz;
          z.phase++;
          if (z.phase >= ZONE_PHASES.length) { z.closed = true; z.dps = ZONE_FINAL_DPS; z.state = 'closed'; z.timer = 0; this.emit('zone', { what: 'closed', phase: z.phase }); }
          else {
            const np = ZONE_PHASES[z.phase], nx = this._pickNext(z.phase);
            z.nextR = np.radius; z.nextX = nx.x; z.nextZ = nx.z; z.dps = np.dps;
            z.state = 'wait'; z.timer += np.wait;
            this.emit('zone', { what: 'wait', phase: z.phase });
          }
        }
      }
    }
    // damage outside the barrier, in half-second pulses; weakest first so ties resolve cleanly
    const actors = this.actors;
    for (let i = actors.length - 1; i >= 0; i--) {
      const a = actors[i];
      if (!a.alive || a.state === 'drop') { a.outside = false; continue; }
      const out = Math.hypot(a.x - z.cx, a.z - z.cz) > z.r;
      a.outside = out;
      if (out) a.zoneAcc += dt; else a.zoneAcc = 0;
    }
    if (this.tickN % 30 === 0) {
      const hurt = [];
      for (let i = 0; i < actors.length; i++) if (actors[i].alive && actors[i].zoneAcc >= 0.5) hurt.push(actors[i]);
      hurt.sort((p, q) => (p.hp - q.hp) || (q.id - p.id));
      for (const a of hurt) {
        if (this.over) break;
        a.zoneAcc -= 0.5;
        this.applyDamage(a, z.dps * 0.5, 'zone', null, -1);
      }
    }
  }

  _updateDirector() {
    if (this.tickN % 30 !== 1) return;
    const t = this.time / this.pace;
    let target = 1;
    for (let i = 0; i < ALIVE_CURVE.length - 1; i++) {
      const [t0, v0] = ALIVE_CURVE[i], [t1, v1] = ALIVE_CURVE[i + 1];
      if (t >= t0 && t <= t1) { target = lerp(v0, v1, (t - t0) / (t1 - t0)); break; }
    }
    if (this.total !== TOTAL_ACTORS) target = 1 + (target - 1) * (this.total - 1) / (TOTAL_ACTORS - 1);
    const diff = this.alive - target;
    const d = this.director;
    d.lethality = clamp(1 + diff * 0.17, 0.3, 2.3);      // >1: too many alive, fights get deadlier
    d.aimScale = Math.pow(d.lethality, -0.85);            // multiplies bot-vs-bot aim error
    d.dmgScale = Math.pow(d.lethality, 0.6);
    d.aggro = clamp(1 + diff * 0.12, 0.5, 1.8);
    d.target = target;
  }

  // ------------------------------------------------------------------ drop phase
  _updateDrop(a, dt) {
    const c = a.cmd, w = this.world;
    const tvx = c.mx * DROP.STEER_SPEED, tvz = c.mz * DROP.STEER_SPEED;
    a.vx += clamp(tvx - a.vx, -34 * dt, 34 * dt);
    a.vz += clamp(tvz - a.vz, -34 * dt, 34 * dt);
    a.x += a.vx * dt; a.z += a.vz * dt;
    a.y -= DROP.FALL_SPEED * dt;
    a.vy = -DROP.FALL_SPEED;
    const rr = Math.hypot(a.x, a.z);
    if (rr > WORLD.BOUND_R) { a.x *= WORLD.BOUND_R / rr; a.z *= WORLD.BOUND_R / rr; }
    const g = Math.max(w.groundAt(a.x, a.z, a.y, GS), -1.3);
    if (a.y - g < 8) {
      P.x = a.x; P.z = a.z; P.hit = false;
      w.collide(P, ACTOR.RADIUS, a.y, ACTOR.HEIGHT, ACTOR.STEP);
      a.x = P.x; a.z = P.z;
    }
    a.speed = Math.hypot(a.vx, a.vz);
    if (a.y <= g + 0.02) {
      a.y = g; a.vy = 0; a.vx *= 0.25; a.vz *= 0.25;
      a.state = 'ground'; a.onGround = true; a.landT = this.time; a.pitch = a.isPlayer && !a.ai ? a.pitch : 0;
      this.emit('land', { actor: a, drop: true });
    }
  }

  // ------------------------------------------------------------------ on-foot update
  _updateActor(a, dt) {
    if (a.fireCd > 0) a.fireCd -= dt;
    if (a.wallCd > 0) a.wallCd -= dt;
    if (a.switchT > 0) a.switchT -= dt;
    if (a.dryCd > 0) a.dryCd -= dt;
    this._move(a, dt);
    this._act(a, dt);
  }

  // Stance, velocity, jumping, collision and ground contact. No randomness, no damage, no loot:
  // a multiplayer client runs exactly this for its own operator to hide network latency.
  _move(a, dt) {
    const c = a.cmd, w = this.world;
    const wpn = a.cur >= 0 ? WEAPONS[a.cur] : null;

    // stance
    const ml = Math.hypot(c.mx, c.mz);
    const moving = ml > 0.05;
    if (c.jump || !a.onGround) a.crouch = false; else a.crouch = c.crouch;
    const fwx = -Math.sin(a.yaw), fwz = -Math.cos(a.yaw);
    const fwdDot = moving ? (c.mx * fwx + c.mz * fwz) / ml : 0;
    const wantAds = c.ads && !!wpn && a.reloadT <= 0 && a.healT <= 0 && a.switchT <= 0;
    a.sprinting = c.sprint && moving && fwdDot > 0.35 && !a.crouch && !wantAds && !c.fire && a.healT <= 0 && !a.swimming;
    a.ads = clamp(a.ads + (wantAds ? dt : -dt) / 0.17, 0, 1);

    // horizontal velocity
    let speed = ACTOR.WALK;
    if (a.sprinting) speed = ACTOR.SPRINT;
    else if (a.crouch) speed = ACTOR.CROUCH;
    else if (a.ads > 0.5) speed = ACTOR.ADS_MOVE;
    if (a.healT > 0) speed = Math.min(speed, 2.6);
    if (wpn) speed *= wpn.moveMul;
    if (a.y < -0.45) speed *= 0.72;               // wading
    if (a.swimming) speed = ACTOR.SWIM;
    const tvx = moving ? (c.mx / ml) * speed * Math.min(1, ml) : 0;
    const tvz = moving ? (c.mz / ml) * speed * Math.min(1, ml) : 0;
    const acc = (a.onGround ? ACTOR.ACCEL : ACTOR.AIR_ACCEL) * dt;
    let dvx = tvx - a.vx, dvz = tvz - a.vz;
    const dvl = Math.hypot(dvx, dvz);
    if (dvl > acc) { dvx *= acc / dvl; dvz *= acc / dvl; }
    a.vx += dvx; a.vz += dvz;

    if (c.jump && a.onGround && !a.swimming && a.healT <= 0) {
      a.vy = ACTOR.JUMP_V; a.onGround = false;
      this.emit('jump', { actor: a });
    }
    if (!a.onGround) a.vy -= ACTOR.GRAVITY * dt;

    // move + collide
    const h = a.crouch ? ACTOR.CROUCH_HEIGHT : ACTOR.HEIGHT;
    P.x = a.x + a.vx * dt; P.z = a.z + a.vz * dt; P.hit = false;
    w.collide(P, ACTOR.RADIUS, a.y, h, ACTOR.STEP);
    this._collideWalls(P, a.y, h);
    const rr = Math.hypot(P.x, P.z);
    if (rr > WORLD.BOUND_R) { P.x *= WORLD.BOUND_R / rr; P.z *= WORLD.BOUND_R / rr; P.hit = true; }
    if (P.hit) { a.vx = (P.x - a.x) / dt; a.vz = (P.z - a.z) / dt; }
    a.x = P.x; a.z = P.z;

    let ground = w.groundAt(a.x, a.z, a.y, GS);
    if (GS.slide) { // nothing to stand on up here: slide off
      const sx = a.x - GS.slide.x, sz = a.z - GS.slide.z, sl = Math.hypot(sx, sz) || 1;
      a.vx += (sx / sl) * 30 * dt; a.vz += (sz / sl) * 30 * dt;
    }
    const water = ground < -1.3;
    if (water) ground = -1.3;
    a.y += a.vy * dt;
    if (a.y <= ground) {
      if (!a.onGround && a.vy < -4) this.emit('land', { actor: a, drop: false });
      a.y = ground; a.vy = 0; a.onGround = true;
    } else if (a.onGround) {
      if (a.y - ground < 0.55) a.y = ground; else a.onGround = false;
    }
    a.swimming = water && a.y <= -1.25;

    a.speed = Math.hypot(a.vx, a.vz);
    if (a.onGround && a.speed > 0.6) {
      a.animPhase += a.speed * dt * (a.crouch ? 2.6 : 1.9);
      a.stepAcc += a.speed * dt;
      const stride = a.sprinting ? 1.5 : 1.05;
      if (a.stepAcc > stride) { a.stepAcc = 0; this.emit('step', { actor: a }); }
    }
  }

  // Weapons, healing, walls and pickups: always decided by whoever owns the match.
  _act(a, dt) {
    const c = a.cmd, time = this.time;
    // weapon switching
    if (c.sw >= 0 && c.sw !== a.cur && a.weapons[c.sw]) {
      a.cur = c.sw; a.switchT = 0.32; a.reloadT = 0; a.healT = 0; a.bloom = 0;
      this.emit('switch', { actor: a });
    }
    const wp = a.cur >= 0 ? WEAPONS[a.cur] : null;
    const ws = a.cur >= 0 ? a.weapons[a.cur] : null;

    // reload
    if (a.reloadT > 0) {
      a.reloadT -= dt;
      if (a.reloadT <= 0 && wp) {
        const n = Math.min(wp.mag - ws.mag, a.reserve[a.cur]);
        ws.mag += n;
        if (!a.ai) a.reserve[a.cur] -= n;   // bots never run dry, so late fights cannot stall
        this.emit('reloadDone', { actor: a });
      }
    } else if (wp && a.switchT <= 0 && a.healT <= 0 && ws.mag < wp.mag && a.reserve[a.cur] > 0 && (c.reload || ws.mag === 0)) {
      a.reloadT = wp.reload;
      this.emit('reload', { actor: a, weapon: a.cur });
    }

    // medkit
    if (a.healT > 0) {
      if (c.fire && wp && ws.mag > 0) a.healT = 0; // firing cancels the heal
      else {
        a.healT -= dt;
        if (a.healT <= 0) {
          a.hp = Math.min(ACTOR.MAX_HP, a.hp + ACTOR.HEAL_AMOUNT); a.medkits--;
          this.emit('healDone', { actor: a });
        }
      }
    } else if (c.heal && a.medkits > 0 && a.hp < ACTOR.MAX_HP - 1 && a.reloadT <= 0) {
      a.healT = ACTOR.HEAL_TIME;
      this.emit('heal', { actor: a });
    }

    if (c.wall && a.walls > 0 && a.wallCd <= 0) this.deployWall(a);

    if (c.fire && wp && a.fireCd <= 0 && a.reloadT <= 0 && a.switchT <= 0 && a.healT <= 0) {
      if (ws.mag > 0) this._fire(a, wp, ws);
      else if (a.dryCd <= 0) { a.dryCd = 0.35; this.emit('dry', { actor: a }); }
    }
    if (a.bloom > 0) a.bloom = Math.max(0, a.bloom - dt * 3.4);
    if (a.recoilP > 0 && time - a.lastShotT > 0.11) { // view settles back after a burst
      const r = Math.min(a.recoilP, dt * 0.42);
      a.pitch -= r; a.recoilP -= r;
    }
    if (a.recoilP > 0.11) a.recoilP = 0.11;

    this._pickup(a);
  }

  _collideWalls(p, y, h) {
    const walls = this.walls, R = ACTOR.RADIUS;
    for (let i = 0; i < walls.length; i++) {
      const wl = walls[i];
      const ddx = p.x - wl.x, ddz = p.z - wl.z;
      if (ddx * ddx + ddz * ddz > 11) continue;
      if (y + ACTOR.STEP >= wl.y + WALL.HEIGHT || y + h <= wl.y - 0.3) continue;
      for (let k = 0; k < wl.segs.length; k++) {
        const b = wl.segs[k];
        const px = p.x - b.x, pz = p.z - b.z;
        const lx = px * b.c - pz * b.s, lz = px * b.s + pz * b.c;
        const qx = clamp(lx, -b.hx, b.hx), qz = clamp(lz, -b.hz, b.hz);
        const ex = lx - qx, ez = lz - qz;
        const d2 = ex * ex + ez * ez;
        if (d2 >= R * R) continue;
        let nx, nz, pen;
        if (d2 > 1e-10) { const d = Math.sqrt(d2); nx = ex / d; nz = ez / d; pen = R - d; }
        else { nx = 0; nz = lz < 0 ? -1 : 1; pen = b.hz - Math.abs(lz) + R; }
        p.x += (nx * b.c + nz * b.s) * pen; p.z += (-nx * b.s + nz * b.c) * pen; p.hit = true;
      }
    }
  }

  _separate() {
    const actors = this.actors, min = ACTOR.RADIUS * 1.9;
    for (let i = 0; i < actors.length; i++) {
      const a = actors[i];
      if (!a.alive || a.state === 'drop') continue;
      for (let j = i + 1; j < actors.length; j++) {
        const b = actors[j];
        if (!b.alive || b.state === 'drop') continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= min * min || Math.abs(a.y - b.y) > 1.6) continue;
        const d = Math.sqrt(d2) || 0.001, push = (min - d) * 0.5;
        const nx = dx / d, nz = dz / d;
        a.x -= nx * push; a.z -= nz * push; b.x += nx * push; b.z += nz * push;
      }
    }
  }

  // ------------------------------------------------------------------ shooting
  _fire(a, wp, ws) {
    const rng = this.rng, time = this.time;
    ws.mag--; a.fireCd = wp.interval; a.shots++; a.lastShotT = time;
    let spread = lerp(wp.hipSpread, wp.adsSpread, a.ads) + a.bloom * (1 - 0.55 * a.ads);
    spread += wp.moveSpread * Math.min(1, a.speed / ACTOR.SPRINT) * (1 - 0.45 * a.ads);
    if (!a.onGround) spread += 2.2;
    if (a.crouch) spread *= 0.72;
    a.bloom = Math.min(wp.bloomMax, a.bloom + wp.bloom);

    const human = a.isPlayer && !a.ai;
    const rewound = human && this.lagComp && a.lagTicks > 0 && this._rewind(a);
    const eye = a.crouch ? ACTOR.CROUCH_EYE : ACTOR.EYE;
    let ox, oy, oz, dx, dy, dz;
    const cp = Math.cos(a.pitch), sp = Math.sin(a.pitch), sy = Math.sin(a.yaw), cy = Math.cos(a.yaw);
    let fx = -sy * cp, fy = sp, fz = -cy * cp;
    // random cone
    {
      const ang = spread * DEG * Math.sqrt(rng()), rot = rng() * Math.PI * 2;
      const rx = cy, rz = -sy;                       // right
      const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy; // up = right x forward
      const ca = Math.cos(ang), sa = Math.sin(ang), cr = Math.cos(rot) * sa, sr = Math.sin(rot) * sa;
      const nx = fx * ca + rx * cr + ux * sr, ny = fy * ca + uy * sr, nz = fz * ca + rz * cr + uz * sr;
      const l = Math.hypot(nx, ny, nz); fx = nx / l; fy = ny / l; fz = nz / l;
    }
    const mx = a.x + cy * 0.2 + fx * 0.55, my = a.y + eye - 0.1 + fy * 0.55, mz = a.z - sy * 0.2 + fz * 0.55;
    if (human) {
      // aim along the crosshair, then fire from the muzzle at whatever the crosshair found
      computeCamera(this, a, a.x, a.y, a.z, CAM);
      const t0 = Math.max(0.1, CAM.back + 0.45);
      const sx0 = CAM.x + fx * t0, sy0 = CAM.y + fy * t0, sz0 = CAM.z + fz * t0;
      const h1 = this.castAll(sx0, sy0, sz0, fx, fy, fz, wp.range, a);
      const td = h1.t >= 0 ? h1.t : wp.range;
      const ax = sx0 + fx * td, ay = sy0 + fy * td, az = sz0 + fz * td;
      ox = mx; oy = my; oz = mz;
      dx = ax - ox; dy = ay - oy; dz = az - oz;
      const l = Math.hypot(dx, dy, dz);
      if (l < 0.8) { dx = fx; dy = fy; dz = fz; } else { dx /= l; dy /= l; dz /= l; }
    } else {
      ox = a.x + fx * 0.3; oy = a.y + eye; oz = a.z + fz * 0.3;
      dx = fx; dy = fy; dz = fz;
    }
    const hit = this.castAll(ox, oy, oz, dx, dy, dz, wp.range, a);
    if (rewound) this._unrewind(a);
    const dist = hit.t >= 0 ? hit.t : wp.range;
    const hx = ox + dx * dist, hyy = oy + dy * dist, hz = oz + dz * dist;

    let kp = 0, ky = 0;
    if (human) { // recoil kicks the view
      kp = wp.recoilPitch * DEG * (1 - 0.3 * a.ads) * (a.crouch ? 0.8 : 1);
      ky = (rng() - 0.5) * 2 * wp.recoilYaw * DEG;
      a.pitch = Math.min(1.35, a.pitch + kp);
      a.yaw += ky;
      a.recoilP += wp.recoilPitch * DEG * 0.6;
    }
    this.gunfire.push({ x: a.x, z: a.z, t: time, id: a.id });
    const ev = { actor: a, weapon: a.cur, mx, my, mz, hx, hy: hyy, hz, hit: hit.type, kind: hit.kind, nx: hit.nx, ny: hit.ny, nz: hit.nz, kp, ky };

    if (hit.type === 'actor') {
      const tgt = hit.actor;
      let dmg = wp.dmg;
      if (dist > wp.falloffStart) dmg *= lerp(1, wp.falloffMin, clamp((dist - wp.falloffStart) / (wp.falloffEnd - wp.falloffStart), 0, 1));
      if (hit.zone === 'head') dmg *= wp.head; else if (hit.zone === 'leg') dmg *= wp.leg;
      if (a.ai && tgt.isPlayer) dmg *= clamp(0.45 + (time / 400) * 0.4, 0.45, 0.85) * this.difficulty; // gentler early on
      else if (a.ai && tgt.ai) dmg *= this.director.dmgScale;
      ev.target = tgt; ev.zone = hit.zone;
      this.emit('shot', ev);
      this.applyDamage(tgt, dmg, hit.zone, a, a.cur);
    } else {
      this.emit('shot', ev);
      if (hit.type === 'wall') {
        const wl = hit.wall;
        wl.hp -= wp.dmg; wl.hitT = time;
        this.emit('wallHit', { wall: wl, x: hx, y: hyy, z: hz, nx: hit.nx, nz: hit.nz });
      }
    }
  }

  applyDamage(t, dmg, zone, attacker, weapon) {
    if (!t.alive || this.over) return;
    if (this.god && t.isPlayer) return;          // test hook: invulnerable player
    let absorbed = 0;
    if (zone !== 'zone') {
      if (zone === 'head') {
        if (t.helmet > 0) { absorbed = Math.min(t.helmet, dmg * ACTOR.HELMET_ABSORB); t.helmet -= absorbed; }
      } else if (t.armor > 0) { absorbed = Math.min(t.armor, dmg * ACTOR.VEST_ABSORB); t.armor -= absorbed; }
      t.healT = 0;
    }
    let toHp = dmg - absorbed;
    // Pacing guard: while the match is ahead of its elimination curve, bot-on-bot fights that the
    // player cannot see wound but do not finish. Fights near the player always resolve honestly.
    if (attacker && attacker.ai && t.ai && t.hp - toHp < 8 && this.hold(attacker, t)) {
      toHp = Math.max(0, t.hp - 8);
      this.pacedSaves++;
    }
    t.hp -= toHp;
    t.lastHurtT = this.time;
    if (attacker) {
      t.lastHitBy = attacker.id; t.lastHitT = this.time;
      const dx = attacker.x - t.x, dz = attacker.z - t.z, dl = Math.hypot(dx, dz) || 1;
      t.hurtDirX = dx / dl; t.hurtDirZ = dz / dl;
      attacker.dmgDealt += dmg; attacker.hits++;
      if (zone === 'head') attacker.headshots++;
      if (t.ai) botOnHurt(this, t, attacker);
    }
    const killed = t.hp <= 0;
    this.emit('damage', { target: t, attacker, amount: dmg, absorbed, zone, killed, x: t.x, y: t.y + (t.crouch ? 1.2 : 1.7), z: t.z });
    if (killed) this._kill(t, attacker, weapon, zone);
  }

  // Ceasefire rule: true while the match is ahead of its elimination curve and neither bot is
  // anywhere the human player could watch. Never applies in the final collapse.
  hold(a, b) {
    if (this.zone.phase >= 5 || this.alive > Math.ceil(this.director.target)) return false;
    const near = 75;
    let seen = false;
    if (this.watchers) { // multiplayer: every human, or whoever a dead human is watching
      for (const p of this.watchers) if (p.alive && (Math.hypot(a.x - p.x, a.z - p.z) <= near || Math.hypot(b.x - p.x, b.z - p.z) <= near)) { seen = true; break; }
    } else {
      const p = this.focus;                    // whoever the camera is on: the player, or who they spectate
      if (!p || !p.alive) return true;
      seen = Math.hypot(a.x - p.x, a.z - p.z) <= near || Math.hypot(b.x - p.x, b.z - p.z) <= near;
    }
    if (!seen) return true;
    // In view of the camera fights are normally left alone; only when the match has run well
    // ahead of schedule do nearby bots stop picking fights with each other (never with the player).
    return this.director.target - this.alive >= 3;
  }

  _kill(t, attacker, weapon, zone) {
    t.alive = false; t.hp = 0; t.state = 'dead'; t.deathT = this.time; t.deathYaw = t.yaw;
    t.killerId = attacker ? attacker.id : -1;
    this.alive--;
    t.place = this.alive + 1;
    if (attacker) attacker.kills++;
    this._dropLoot(t);
    if (t === this.focus) { // camera moves on to the killer, or failing that the nearest survivor
      let nf = attacker && attacker.alive ? attacker : null, bd = 1e9;
      if (!nf) for (const o of this.actors) { if (!o.alive) continue; const d = Math.hypot(o.x - t.x, o.z - t.z); if (d < bd) { bd = d; nf = o; } }
      this.focus = nf;
    }
    this.emit('kill', { victim: t, killer: attacker, weapon, head: zone === 'head', zone: zone === 'zone' });
    if (this.alive <= 1 && !this.over) {
      this.over = true; this.phase = 'over';
      let win = null;
      for (const a of this.actors) if (a.alive) win = a;
      if (win) win.place = 1;
      this.winner = win; this.endTime = this.time;
      this.emit('matchEnd', { winner: win });
    }
  }

  _dropLoot(t) {
    const items = ['ammo'];
    if (t.medkits > 0) items.push('medkit');
    for (let i = 0; i < 3; i++) if (t.weapons[i]) items.push(WEAPONS[i].id);
    if (t.armor > 45) items.push('vest');
    const w = this.world;
    const n = Math.min(items.length, 4);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + t.id;
      const x = t.x + Math.cos(a) * 1.0, z = t.z + Math.sin(a) * 1.0;
      const y = Math.max(w.groundAt(x, z, t.y + 0.5, null), -1.2);
      const l = { id: this.nextId++, type: items[i], x, y, z, alive: true, dropped: true, born: this.time };
      this.loot.push(l);
      this.emit('lootDrop', { loot: l });
    }
    if (this.loot.length > 320) this.loot = this.loot.filter((l) => l.alive);
  }

  // ------------------------------------------------------------------ loot
  wants(a, type) {
    switch (type) {
      case 'ar': case 'smg': case 'sr': {
        const i = type === 'ar' ? 0 : type === 'smg' ? 1 : 2;
        return !a.weapons[i] || a.reserve[i] < WEAPONS[i].maxReserve - WEAPONS[i].mag;
      }
      case 'ammo':
        return a.walls < ACTOR.MAX_WALLS || a.reserve[0] < WEAPONS[0].maxReserve || a.reserve[1] < WEAPONS[1].maxReserve || a.reserve[2] < WEAPONS[2].maxReserve;
      case 'vest': return a.armor < ACTOR.MAX_ARMOR * 0.9;
      case 'helmet': return a.helmet < ACTOR.MAX_HELMET * 0.9;
      case 'medkit': return a.medkits < ACTOR.MAX_MEDKITS;
    }
    return false;
  }

  _pickup(a) {
    const loot = this.loot, r2 = LOOT_PICKUP_RADIUS * LOOT_PICKUP_RADIUS;
    for (let i = 0; i < loot.length; i++) {
      const l = loot[i];
      if (!l.alive) continue;
      const dx = l.x - a.x, dz = l.z - a.z;
      if (dx * dx + dz * dz > r2 || Math.abs(l.y - a.y) > 1.7) continue;
      if (l.dropped && this.time - l.born < 0.6) continue;
      if (!this.wants(a, l.type)) continue;
      this.give(a, l.type);
      l.alive = false;
      this.emit('pickup', { actor: a, item: l.type, x: l.x, y: l.y, z: l.z, lootId: l.id });
    }
  }

  give(a, type) {
    switch (type) {
      case 'ar': case 'smg': case 'sr': {
        const i = type === 'ar' ? 0 : type === 'smg' ? 1 : 2, wp = WEAPONS[i];
        if (!a.weapons[i]) {
          a.weapons[i] = { mag: wp.mag };
          a.reserve[i] = Math.min(wp.maxReserve, a.reserve[i] + Math.round(wp.pickupReserve * 0.5));
          if (a.cur < 0) { a.cur = i; a.switchT = 0.25; }
        } else a.reserve[i] = Math.min(wp.maxReserve, a.reserve[i] + wp.mag);
        break;
      }
      case 'ammo':
        for (let i = 0; i < 3; i++) a.reserve[i] = Math.min(WEAPONS[i].maxReserve, a.reserve[i] + WEAPONS[i].pickupReserve);
        a.walls = Math.min(ACTOR.MAX_WALLS, a.walls + 1);
        break;
      case 'vest': a.armor = ACTOR.MAX_ARMOR; break;
      case 'helmet': a.helmet = ACTOR.MAX_HELMET; break;
      case 'medkit': a.medkits = Math.min(ACTOR.MAX_MEDKITS, a.medkits + 1); break;
    }
  }

  // ------------------------------------------------------------------ deployable walls
  deployWall(a) {
    const w = this.world;
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
    const cx = a.x + fx * WALL.DIST, cz = a.z + fz * WALL.DIST;
    const base = Math.max(w.groundAt(cx, cz, a.y + 0.6, null), -1.2);
    if (Math.abs(base - a.y) > 1.7) return false;
    const wall = { id: this.nextId++, owner: a.id, x: cx, z: cz, y: base, yaw: a.yaw, hp: WALL.HP, life: WALL.LIFE, age: 0, hitT: -9, segs: wallSegments(cx, cz, base, a.yaw), cells: [] };
    // block nav cells under the wall while it stands
    const dyn = w.navDyn;
    for (const b of wall.segs) {
      const ext = b.hx + 0.6;
      for (let iz = Math.floor(b.z - ext + HALF); iz <= Math.floor(b.z + ext + HALF); iz++) {
        for (let ix = Math.floor(b.x - ext + HALF); ix <= Math.floor(b.x + ext + HALF); ix++) {
          if (ix < 0 || iz < 0 || ix >= NN || iz >= NN) continue;
          const px = ix - HALF + 0.5 - b.x, pz = iz - HALF + 0.5 - b.z;
          const lx = px * b.c - pz * b.s, lz = px * b.s + pz * b.c;
          const ex = Math.max(Math.abs(lx) - b.hx, 0), ez = Math.max(Math.abs(lz) - b.hz, 0);
          if (ex * ex + ez * ez < 0.46 * 0.46) { const ci = iz * NN + ix; if (dyn[ci] < 250) { dyn[ci]++; wall.cells.push(ci); } }
        }
      }
    }
    this.walls.push(wall);
    a.walls--; a.wallCd = WALL.COOLDOWN;
    this.emit('wallDeploy', { wall, actor: a });
    if (this.walls.length > WALL.MAX_ACTIVE) this._removeWall(0, true);
    return true;
  }

  _removeWall(i, expired) {
    const wl = this.walls[i];
    const dyn = this.world.navDyn;
    for (const ci of wl.cells) if (dyn[ci] > 0) dyn[ci]--;
    this.walls.splice(i, 1);
    this.emit('wallBreak', { wall: wl, expired });
  }

  _updateWalls(dt) {
    for (let i = this.walls.length - 1; i >= 0; i--) {
      const wl = this.walls[i];
      wl.age += dt; wl.life -= dt;
      if (wl.hp <= 0) this._removeWall(i, false);
      else if (wl.life <= 0) this._removeWall(i, true);
    }
  }
}
