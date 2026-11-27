// Bot brains for LAST CORDON. Each bot perceives ~5 times a second (line-of-sight rays, loot scan,
// zone check), picks a mode, and steers/aims/fires every tick by filling the same command struct
// the human player uses. The autopilot test player runs on exactly this code.
import { ACTOR, WEAPONS } from './config.js';
import { clamp, angleDiff } from './rng.js';

const RK = { t: 0, nx: 0, ny: 0, nz: 0, kind: '', wall: null };
const PREF = [ // preferred engagement band per weapon [min, max]
  [12, 42], [5, 17], [40, 125],
];

function turnToward(cur, target, maxStep) {
  const d = angleDiff(target, cur);
  if (Math.abs(d) <= maxStep) return cur + d;
  return cur + Math.sign(d) * maxStep;
}
const hasAmmo = (a, i) => !!a.weapons[i] && (a.weapons[i].mag > 0 || a.reserve[i] > 0);
const armed = (a) => hasAmmo(a, 0) || hasAmmo(a, 1) || hasAmmo(a, 2);

function pickWeapon(a, d) {
  const ok0 = hasAmmo(a, 0), ok1 = hasAmmo(a, 1), ok2 = hasAmmo(a, 2);
  if (d > 55 && ok2) return 2;
  if (d < 17 && ok1) return 1;
  if (ok0) return 0;
  if (ok1 && d < 70) return 1;
  if (ok2) return 2;
  if (ok1) return 1;
  return -1;
}

export function botInit(game, a) {
  const rng = game.rng;
  a.ai = {
    think: rng() * 0.25, skill: rng.range(0.78, 1.22), nerve: rng.range(0.6, 1.4),
    target: null, visible: false, wallBlocked: false, aimHead: false,
    seenT: -99, lkX: 0, lkZ: 0, lkT: -99, acquireT: 0, heardT: -99,
    errYaw: 0, errPitch: 0, errT: 0, burst: 0, pause: 0, lastShots: 0, swT: -99, settleT: 0,
    mode: 'loot', urgent: false,
    goalKind: '', goalX: 0, goalZ: 0, goalItem: null, goalT: -99,
    path: null, pathI: 0, pathT: -99, pathTry: -99, pgX: 1e9, pgZ: 1e9, repath: false, pathFail: 0,
    stuckT: 0, stuckX: 0, stuckZ: 0, stuckN: 0, sideT: 0, sideX: 0, sideZ: 0, wantMove: false,
    strafe: rng.chance(0.5) ? 1 : -1, strafeT: 0, crouchT: 0, scan: rng() * 6,
    wallAt: -99, wantWall: 0, threatX: 0, threatZ: 0, threatT: -99, coverUntil: -99,
    coverT: -99, coverX: 0, coverZ: 0, hasCover: false, rotX: 0, rotZ: 0, rotT: -99, rotOk: false,
    badLoot: new Map(), dropX: 0, dropZ: 0,
  };
}

export function botOnHurt(game, a, attacker) {
  const ai = a.ai;
  if (!ai) return;
  const time = game.time;
  ai.threatX = attacker.x; ai.threatZ = attacker.z; ai.threatT = time;
  if (!ai.visible) { ai.lkX = attacker.x; ai.lkZ = attacker.z; ai.lkT = time; ai.heardT = time; }
  const d = Math.hypot(attacker.x - a.x, attacker.z - a.z);
  if (a.state !== 'drop' && a.walls > 0 && a.wallCd <= 0 && time - ai.wallAt > 7 && ai.wantWall <= 0 && d > 5) {
    const p = (a.hp < 70 ? 0.6 : 0.25) + (a.cur < 0 ? 0.3 : 0);
    if (game.rng() < p) ai.wantWall = 0.2 + game.rng() * 0.3; // reaction delay before the wall goes up
  }
}

export function botThink(game, a, dt) {
  const ai = a.ai, c = a.cmd;
  c.mx = 0; c.mz = 0; c.fire = false; c.ads = false; c.jump = false; c.sprint = false;
  c.reload = false; c.heal = false; c.wall = false; c.sw = -1; c.crouch = false;
  if (game.over || ai.frozen) return;         // frozen: test hook, the bot stands still
  if (a.state === 'drop') {
    const dx = ai.dropX - a.x, dz = ai.dropZ - a.z, d = Math.hypot(dx, dz);
    if (d > 2.5) { c.mx = dx / d; c.mz = dz / d; a.yaw = turnToward(a.yaw, Math.atan2(-dx, -dz), dt * 3); }
    return;
  }
  ai.think -= dt;
  if (ai.think <= 0) {
    ai.think = 0.17 + game.rng() * 0.08;
    perceive(game, a);
    decide(game, a);
  }
  act(game, a, dt);
}

// ---------------------------------------------------------------------- perception
function sightKind(game, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.1) return '';
  const t = game.rayStatic(ax, ay, az, dx / len, dy / len, dz / len, len - 0.08, RK);
  return t < 0 ? '' : RK.kind;
}

function perceive(game, a) {
  const ai = a.ai, time = game.time, actors = game.actors;
  const eyeY = a.y + (a.crouch ? ACTOR.CROUCH_EYE : ACTOR.EYE);
  const maxR = a.weapons[2] ? 150 : 108;
  const lethal = game.director.lethality;
  const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
  let c0 = null, c1 = null, c2 = null, s0 = 1e9, s1 = 1e9, s2 = 1e9;
  for (let i = 0; i < actors.length; i++) {
    const b = actors[i];
    if (b === a || !b.alive || b.state === 'drop') continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const d = Math.hypot(dx, dz);
    if (d > maxR) continue;
    const facing = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
    const hitMe = a.lastHitBy === b.id && time - a.lastHitT < 4;
    const notice = d < 9 || facing > 0.3 || hitMe || (time - b.lastShotT < 1.2 && d < 75);
    if (!notice) continue;
    // ahead of the pacing curve: bots stop picking long-range fights with each other
    if (b.ai && (game.hold(a, b) || (!hitMe && lethal < 0.8 && d > 22 + 40 * lethal))) continue;
    let s = d;
    if (b === ai.target) s -= 14;
    if (b.hp < 40) s -= 5;
    if (s < s0) { c2 = c1; s2 = s1; c1 = c0; s1 = s0; c0 = b; s0 = s; }
    else if (s < s1) { c2 = c1; s2 = s1; c1 = b; s1 = s; }
    else if (s < s2) { c2 = b; s2 = s; }
  }
  let found = null, head = false, wallBlocked = false;
  for (let k = 0; k < 3 && !found; k++) {
    const b = k === 0 ? c0 : k === 1 ? c1 : c2;
    if (!b) break;
    const chest = b.y + (b.crouch ? 0.8 : 1.2);
    const k1 = sightKind(game, a.x, eyeY, a.z, b.x, chest, b.z);
    if (k1 === '') { found = b; head = false; break; }
    const k2 = sightKind(game, a.x, eyeY, a.z, b.x, b.y + (b.crouch ? ACTOR.CROUCH_HEAD_Y : ACTOR.HEAD_Y), b.z);
    if (k2 === '') { found = b; head = true; break; }
    if (b === ai.target && (k1 === 'bulwark' || k2 === 'bulwark')) wallBlocked = true;
  }
  if (found && found.isPlayer) { // needs an attack slot unless defending itself or at point-blank
    const dd = Math.hypot(found.x - a.x, found.z - a.z);
    const selfDefence = a.lastHitBy === found.id && time - a.lastHitT < 4;
    if (!selfDefence && dd > 12 && !game.claimSlot(a, found)) found = null;
    else if (selfDefence || dd <= 12) game.claimSlot(a, found);
  }
  if (found) {
    if (ai.target !== found || time - ai.seenT > 1.5) ai.acquireT = time;
    ai.target = found; ai.visible = true; ai.aimHead = head; ai.wallBlocked = false;
    ai.seenT = time; ai.lkX = found.x; ai.lkZ = found.z; ai.lkT = time;
  } else {
    ai.visible = false; ai.wallBlocked = wallBlocked;
    if (ai.target && (!ai.target.alive || time - ai.seenT > 5)) ai.target = null;
    // hearing: recent gunfire nearby
    const gf = game.gunfire;
    for (let i = gf.length - 1; i >= 0 && i >= gf.length - 12; i--) {
      const g = gf[i];
      if (g.id === a.id || time - g.t > 1.0) continue;
      const d = Math.hypot(g.x - a.x, g.z - a.z);
      if (d < 90 && time - ai.lkT > 1.5) { ai.lkX = g.x; ai.lkZ = g.z; ai.lkT = time; ai.heardT = time; break; }
    }
  }
}

// ---------------------------------------------------------------------- decisions
function lootWeight(a, type) {
  const isArmed = armed(a);
  switch (type) {
    case 'ar': return !a.weapons[0] ? (isArmed ? 0.8 : 0.3) : 1.7;
    case 'smg': return !a.weapons[1] ? (isArmed ? 0.9 : 0.3) : 1.7;
    case 'sr': return !a.weapons[2] ? (isArmed ? 1.25 : 0.4) : 1.9;
    case 'ammo': {
      const cur = a.cur >= 0 ? a.reserve[a.cur] : 0;
      return cur < (a.cur >= 0 ? WEAPONS[a.cur].mag : 1) ? 0.5 : (a.walls < 2 ? 0.9 : 1.5);
    }
    case 'vest': return a.armor < 30 ? 0.7 : 1.5;
    case 'helmet': return a.helmet <= 0 ? 0.9 : 1.6;
    case 'medkit': return a.medkits === 0 ? 0.7 : (a.medkits < 2 ? 1.0 : 1.8);
  }
  return 2;
}

function chooseLoot(game, a) {
  const ai = a.ai, z = game.zone, time = game.time, loot = game.loot;
  const maxD = armed(a) ? 62 : 150;
  const soon = z.state === 'shrink' || z.timer < 16;
  let best = null, bs = 1e9;
  for (let i = 0; i < loot.length; i++) {
    const l = loot[i];
    if (!l.alive) continue;
    const dx = l.x - a.x, dz = l.z - a.z;
    const d = Math.hypot(dx, dz);
    if (d > maxD) continue;
    if (!game.wants(a, l.type)) continue;
    const bad = ai.badLoot.get(l.id);
    if (bad !== undefined && bad > time) continue;
    if (Math.hypot(l.x - z.cx, l.z - z.cz) > z.r - 4) continue;
    if (soon && Math.hypot(l.x - z.nextX, l.z - z.nextZ) > z.nextR - 2 && d > 12) continue;
    const lw = lootWeight(a, l.type);
    if (lw > 1.3 && d > 9) continue;          // bots take what they need and leave the rest for the player
    const s = (d + 4) * lw;
    if (s < bs) { bs = s; best = l; }
  }
  return best;
}

function setGoal(game, ai, kind, x, z, item) {
  if (ai.goalKind !== kind || ai.goalItem !== (item || null) || Math.hypot(ai.goalX - x, ai.goalZ - z) > 1.5) {
    ai.goalKind = kind; ai.goalX = x; ai.goalZ = z; ai.goalItem = item || null; ai.goalT = game.time;
  }
}

function pointInCircle(game, a, cx, cz, r, spread) {
  const w = game.world, rng = game.rng;
  if (r < 6) return { x: cx, z: cz };
  for (let i = 0; i < 8; i++) {
    let dx = a.x - cx, dz = a.z - cz;
    const dl = Math.hypot(dx, dz) || 1;
    const ang = Math.atan2(dz / dl, dx / dl) + (rng() - 0.5) * spread;
    const rr = r * (0.15 + rng() * 0.55);
    const x = cx + Math.cos(ang) * rr, z = cz + Math.sin(ang) * rr;
    const ci = w.navFree(x, z, 6);
    if (ci >= 0) return { x: (ci % 640) - 320 + 0.5, z: ((ci / 640) | 0) - 320 + 0.5 };
  }
  return { x: cx, z: cz };
}

function decide(game, a) {
  const ai = a.ai, time = game.time, z = game.zone, dir = game.director;
  const isArmed = armed(a);
  const dCur = Math.hypot(a.x - z.cx, a.z - z.cz);
  const outsideCur = dCur > z.r - 2.5;
  const dNext = Math.hypot(a.x - z.nextX, a.z - z.nextZ);
  const outsideNext = dNext > z.nextR - 3.5;
  let mustRotate = outsideCur;
  if (!mustRotate && outsideNext && !z.closed) {
    const need = (dNext - z.nextR) / 5.0 + 10;
    if (z.state === 'shrink' || z.timer < need) mustRotate = true;
  }
  if (z.closed || z.nextR < 1) mustRotate = dNext > 3;
  ai.urgent = outsideCur;
  if (mustRotate) {
    const toNext = outsideNext && (z.state === 'shrink' || !outsideCur || z.timer < 25);
    const cx = toNext ? z.nextX : z.cx, cz = toNext ? z.nextZ : z.cz, r = toNext ? z.nextR : z.r;
    const stale = !ai.rotOk || Math.hypot(ai.rotX - cx, ai.rotZ - cz) > Math.max(4, r * 0.75) || time - ai.rotT > 14;
    if (stale) { const p = pointInCircle(game, a, cx, cz, r, 1.1); ai.rotX = p.x; ai.rotZ = p.z; ai.rotT = time; ai.rotOk = true; }
  } else ai.rotOk = false;
  const t = ai.target;
  const dT = t ? Math.hypot(t.x - a.x, t.z - a.z) : 1e9;
  const threatened = time - a.lastHurtT < 1.6;
  let mode;

  const reach = a.cur === 2 ? 150 : a.cur === 1 ? 46 : 82;
  const inReach = dT < reach || (t && a.lastHitBy === t.id && time - a.lastHitT < 3);
  if (t && ai.visible && isArmed && inReach && !(outsideCur && dT > 28)) mode = 'fight';
  else if (mustRotate) mode = 'rotate';
  else if (t && !ai.visible && ai.wallBlocked && isArmed && time - ai.seenT < 3 && a.cur >= 0 && a.cur !== 2 && a.weapons[a.cur].mag > 4) mode = 'suppress';
  else if (a.hp < 55 && a.medkits > 0) mode = threatened && time > ai.coverUntil ? 'flee' : 'heal';
  else if (!isArmed && threatened) mode = 'flee';
  else if (t && isArmed && time - ai.seenT < 5 && ai.nerve * dir.aggro > 0.75 && a.hp > 35) mode = 'hunt';
  else {
    let item = ai.goalKind === 'loot' ? ai.goalItem : null;
    if (item && (!item.alive || !game.wants(a, item.type) || Math.hypot(item.x - z.cx, item.z - z.cz) > z.r - 3)) item = null;
    if (!item || time - ai.goalT > 3) { const better = chooseLoot(game, a); if (better) item = better; }
    if (item) { mode = 'loot'; setGoal(game, ai, 'loot', item.x, item.z, item); }
    else if (isArmed && time - ai.heardT < 5 && ai.nerve * dir.aggro > 0.85 && a.hp > 45) mode = 'hunt';
    else mode = 'roam';
  }

  if (mode === 'rotate') {
    setGoal(game, ai, 'rotate', ai.rotX, ai.rotZ, null);
  } else if (mode === 'hunt') {
    setGoal(game, ai, 'hunt', ai.lkX, ai.lkZ, null);
    if (Math.hypot(ai.lkX - a.x, ai.lkZ - a.z) < 4) { ai.target = null; ai.heardT = -99; ai.seenT = -99; }
  } else if (mode === 'roam') {
    const arrived = Math.hypot(ai.goalX - a.x, ai.goalZ - a.z) < 3;
    if (ai.goalKind !== 'roam' || arrived || time - ai.goalT > 20) {
      const p = pointInCircle(game, a, z.nextX, z.nextZ, Math.max(6, z.nextR * (dir.aggro > 1.1 ? 0.6 : 1)), 6.3);
      setGoal(game, ai, 'roam', p.x, p.z, null); ai.goalT = time;
    }
  } else if (mode === 'flee') {
    if (ai.goalKind !== 'flee' || time - ai.coverT > 2.5) {
      ai.coverT = time;
      const p = findCover(game, a, ai.threatX, ai.threatZ);
      if (p) setGoal(game, ai, 'flee', p.x, p.z, null);
      else {
        const dx = a.x - ai.threatX, dz = a.z - ai.threatZ, dl = Math.hypot(dx, dz) || 1;
        setGoal(game, ai, 'flee', a.x + (dx / dl) * 14, a.z + (dz / dl) * 14, null);
      }
    }
  }
  ai.mode = mode;
}

function findCover(game, a, tx, tz) {
  const w = game.world, rng = game.rng;
  const ty = w.heightAt(tx, tz) + 1.5;
  const base = Math.atan2(a.z - tz, a.x - tx);
  let best = null, bd = 1e9;
  for (let i = 0; i < 10; i++) {
    const ang = base + (rng() - 0.5) * 2.8, r = 4 + rng() * 12;
    const x = a.x + Math.cos(ang) * r, z = a.z + Math.sin(ang) * r;
    const ci = w.navCell(x, z);
    if (w.nav[ci] || w.navDyn[ci]) continue;
    if (game.los(tx, ty, tz, x, w.heightAt(x, z) + 1.0, z)) continue;
    if (r < bd) { bd = r; best = { x, z }; }
  }
  return best;
}

// ---------------------------------------------------------------------- acting
// Path-follow toward (x,z). Returns true once within arriveR.
function goTo(game, a, x, z, sprint, arriveR) {
  const ai = a.ai, c = a.cmd, time = game.time;
  const d = Math.hypot(x - a.x, z - a.z);
  if (d < (arriveR || 0.9)) return true;
  const moved = Math.hypot(x - ai.pgX, z - ai.pgZ);
  if ((ai.path === null && time - ai.pathT > 2.5) || (ai.path === undefined) || moved > 3.5 || ai.repath || (time - ai.pathT > 6 && moved > 0.4)) {
    if (time - ai.pathTry > 0.3) {
      const p = game.findPath(a.x, a.z, x, z);
      if (p !== undefined) {
        ai.pathTry = time; ai.path = p; ai.pathI = 0; ai.pgX = x; ai.pgZ = z; ai.pathT = time; ai.repath = false;
        ai.pathFail = p === null ? ai.pathFail + 1 : 0;
      }
    }
  }
  let tx = x, tz = z;
  const path = ai.path;
  if (path && path.length) {
    while (ai.pathI < path.length - 1 && Math.hypot(path[ai.pathI].x - a.x, path[ai.pathI].z - a.z) < 0.75) ai.pathI++;
    const wp = path[ai.pathI];
    tx = wp.x; tz = wp.z;
    if (ai.pathI === path.length - 1 && path.partial && Math.hypot(tx - a.x, tz - a.z) < 1.0) ai.repath = true;
  }
  const dx = tx - a.x, dz = tz - a.z, dl = Math.hypot(dx, dz);
  if (dl > 0.05) { c.mx = dx / dl; c.mz = dz / dl; }
  c.sprint = !!sprint && d > 5;
  ai.wantMove = true;
  return false;
}

function act(game, a, dt) {
  const ai = a.ai, c = a.cmd, time = game.time, rng = game.rng, w = game.world;
  const t = ai.target, mode = ai.mode;
  const eyeY = a.y + (a.crouch ? ACTOR.CROUCH_EYE : ACTOR.EYE);
  let faceYaw = null, facePitch = 0, turnRate = 7;
  ai.wantMove = false;

  // keep the weapon topped up when nobody is around
  if (a.cur >= 0 && a.reloadT <= 0 && mode !== 'fight' && mode !== 'suppress') {
    const ws = a.weapons[a.cur];
    if (ws.mag < WEAPONS[a.cur].mag * 0.5 && a.reserve[a.cur] > 0) c.reload = true;
  }
  if (a.cur < 0 || !hasAmmo(a, a.cur)) { const sw = pickWeapon(a, 25); if (sw >= 0 && sw !== a.cur) c.sw = sw; }

  const inCover = time < ai.coverUntil;

  if (mode === 'fight' && t) {
    const dx = t.x - a.x, dz = t.z - a.z, d = Math.hypot(dx, dz) || 0.01;
    const want = pickWeapon(a, d);
    if (want >= 0 && want !== a.cur && time - ai.swT > 1.6) { c.sw = want; ai.swT = time; }
    const wi = a.cur >= 0 ? a.cur : 0, wp = WEAPONS[wi];
    // aim error: refreshed a few times a second, wide at first contact, tighter as the bot settles
    ai.errT -= dt;
    if (ai.errT <= 0) {
      ai.errT = 0.2 + rng() * 0.08;
      let sigma = 0.026 / ai.skill;
      sigma *= 1 + Math.min(t.speed, 7) * 0.11;
      sigma *= 1 + Math.min(a.speed, 7) * 0.06;
      sigma *= 2.4 - 1.4 * clamp((time - ai.acquireT) / 1.3, 0, 1);
      if (d < 10) sigma *= 1.3;
      if (t.isPlayer) sigma *= clamp(2.3 - time / 250, 1.45, 2.3) / game.difficulty;
      else sigma *= game.director.aimScale;
      if (a.ads > 0.5) sigma *= 0.85;
      ai.errYaw = rng.gauss() * sigma; ai.errPitch = rng.gauss() * sigma * 0.7;
    }
    const ty = t.y + (ai.aimHead ? (t.crouch ? ACTOR.CROUCH_HEAD_Y : ACTOR.HEAD_Y) : (t.crouch ? 0.8 : 1.15));
    faceYaw = Math.atan2(-dx, -dz) + ai.errYaw;
    facePitch = Math.atan2(ty - eyeY, d) + ai.errPitch;
    turnRate = 9;
    c.ads = d > 22 || !!wp.scope;

    const yawOff = Math.abs(angleDiff(faceYaw, a.yaw)), pitchOff = Math.abs(facePitch - a.pitch);
    const reacted = time - ai.acquireT > (t.isPlayer ? 0.6 : 0.34) / ai.skill && time - a.landT > 3.5;
    let canFire = ai.visible && reacted && yawOff < 0.06 && pitchOff < 0.07 && !inCover;
    if (wp.scope) { // snipers need to stand still and settle the scope
      if (a.speed > 0.6 || a.ads < 0.95) ai.settleT = 0; else ai.settleT += dt;
      if (ai.settleT < 0.55 / ai.skill) canFire = false;
    }
    if (canFire) {
      if (a.shots !== ai.lastShots) { ai.burst -= a.shots - ai.lastShots; ai.lastShots = a.shots; }
      if (ai.burst <= 0) {
        ai.pause -= dt;
        if (ai.pause <= 0) {
          ai.burst = wi === 0 ? rng.int(4, 8) : wi === 1 ? rng.int(6, 13) : 1;
          ai.pause = wi === 2 ? 0 : rng.range(0.22, 0.55) / ai.skill;
        }
      }
      c.fire = ai.burst > 0;
    }

    // footwork
    const band = PREF[wi];
    if (inCover) {
      c.crouch = true;
      if (a.hp < 62 && a.medkits > 0 && a.healT <= 0) c.heal = true;
      else if (a.cur >= 0 && a.weapons[a.cur].mag < wp.mag * 0.5) c.reload = true;
    } else if (ai.urgent && ai.rotOk) {
      goTo(game, a, ai.rotX, ai.rotZ, false, 1.5);
    } else if (wp.scope && d > band[0]) {
      if (ai.crouchT < time && rng() < 0.01) ai.crouchT = time + rng.range(1.5, 4);
      c.crouch = time < ai.crouchT;
    } else if (d > band[1]) {
      goTo(game, a, t.x, t.z, d > 60, 2);
    } else {
      ai.strafeT -= dt;
      if (ai.strafeT <= 0) { ai.strafeT = rng.range(0.6, 1.8); if (rng() < 0.6) ai.strafe = -ai.strafe; }
      let mx = (-dz / d) * ai.strafe, mz = (dx / d) * ai.strafe;
      if (d < band[0]) { mx = mx * 0.5 - (dx / d); mz = mz * 0.5 - (dz / d); }
      const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
      const ci = w.navCell(a.x + mx * 1.6, a.z + mz * 1.6);
      if (w.nav[ci] || w.navDyn[ci]) { ai.strafe = -ai.strafe; ai.strafeT = rng.range(0.5, 1.2); }
      else { c.mx = mx; c.mz = mz; ai.wantMove = true; }
      if (d > 28 && time < ai.crouchT) c.crouch = true;
      else if (rng() < 0.004) ai.crouchT = time + rng.range(1, 3);
      if (d < 11 && rng() < 0.012) c.jump = true;
    }
    // hurt and exposed: wall up or break contact
    if (a.hp < 38 && !inCover && time - a.lastHurtT < 1.2 && ai.wantWall <= 0) {
      if (a.walls > 0 && a.wallCd <= 0 && time - ai.wallAt > 5) { ai.wantWall = 0.15; ai.threatX = t.x; ai.threatZ = t.z; }
    }
  } else if (mode === 'suppress' && t) {
    const dx = ai.lkX - a.x, dz = ai.lkZ - a.z, d = Math.hypot(dx, dz) || 0.01;
    faceYaw = Math.atan2(-dx, -dz);
    facePitch = Math.atan2(w.heightAt(ai.lkX, ai.lkZ) + 1.0 - eyeY, d);
    turnRate = 8;
    c.ads = d > 22;
    if (Math.abs(angleDiff(faceYaw, a.yaw)) < 0.08) {
      if (a.shots !== ai.lastShots) { ai.burst -= a.shots - ai.lastShots; ai.lastShots = a.shots; }
      if (ai.burst <= 0) { ai.pause -= dt; if (ai.pause <= 0) { ai.burst = rng.int(5, 9); ai.pause = rng.range(0.3, 0.6); } }
      c.fire = ai.burst > 0;
    }
  } else if (mode === 'heal') {
    c.crouch = true;
    if (a.healT <= 0) c.heal = true;
  } else {
    // travelling modes: rotate, loot, hunt, roam, flee
    const sprint = mode === 'rotate' || mode === 'flee' || mode === 'hunt' || (mode === 'loot' && !armed(a)) || Math.hypot(ai.goalX - a.x, ai.goalZ - a.z) > 25;
    const arrive = mode === 'loot' ? 0.5 : mode === 'hunt' ? 3.5 : 2.2;
    const arrived = goTo(game, a, ai.goalX, ai.goalZ, sprint, arrive);
    if (arrived && mode === 'loot' && ai.goalItem && ai.goalItem.alive && time - ai.goalT > 2.5) {
      ai.badLoot.set(ai.goalItem.id, time + 25); ai.goalItem = null; ai.goalKind = '';
    }
    if (mode === 'loot' && ai.pathFail >= 2 && ai.goalItem) { ai.badLoot.set(ai.goalItem.id, time + 30); ai.goalItem = null; ai.goalKind = ''; ai.pathFail = 0; }
    if (mode === 'flee' && arrived && a.hp < 60 && a.medkits > 0 && a.healT <= 0) { c.heal = true; c.crouch = true; }
    // keep shooting at a visible target while relocating
    if (t && ai.visible && armed(a) && !c.sprint) {
      const dx = t.x - a.x, dz = t.z - a.z, d = Math.hypot(dx, dz) || 0.01;
      faceYaw = Math.atan2(-dx, -dz) + ai.errYaw; facePitch = Math.atan2(t.y + 1.1 - eyeY, d);
      if (Math.abs(angleDiff(faceYaw, a.yaw)) < 0.07 && d < 60) c.fire = true;
    }
  }

  // reactive Bulwark: turn to the threat and throw the wall
  if (ai.wantWall > 0) {
    ai.wantWall -= dt;
    faceYaw = Math.atan2(-(ai.threatX - a.x), -(ai.threatZ - a.z)); facePitch = 0; turnRate = 16;
    c.fire = false;
    if (ai.wantWall <= 0) {
      if (Math.abs(angleDiff(faceYaw, a.yaw)) < 0.45 && a.walls > 0 && a.wallCd <= 0) {
        c.wall = true; ai.wallAt = time; ai.coverUntil = time + rng.range(1.8, 3.4);
      } else if (a.walls > 0) ai.wantWall = 0.06;
    }
  }

  // facing
  if (faceYaw === null) {
    if (Math.hypot(c.mx, c.mz) > 0.1) faceYaw = Math.atan2(-c.mx, -c.mz);
    else { ai.scan += dt * 0.7; faceYaw = a.yaw + Math.sin(ai.scan) * dt * 1.2; }
    facePitch = 0;
  }
  a.yaw = turnToward(a.yaw, faceYaw, dt * turnRate);
  a.pitch = clamp(a.pitch + clamp(facePitch - a.pitch, -dt * 5, dt * 5), -1.2, 1.2);

  // sidestep override when wedged
  if (ai.sideT > 0) { ai.sideT -= dt; c.mx = ai.sideX; c.mz = ai.sideZ; c.sprint = false; }

  // stuck detection
  ai.stuckT += dt;
  if (ai.stuckT > 0.8) {
    const movedD = Math.hypot(a.x - ai.stuckX, a.z - ai.stuckZ);
    if (ai.wantMove && movedD < 0.4 && a.healT <= 0) {
      ai.stuckN++;
      ai.repath = true;
      if (ai.stuckN === 1) c.jump = true;
      if (ai.stuckN >= 2) {
        const ang = rng() * Math.PI * 2;
        ai.sideX = Math.cos(ang); ai.sideZ = Math.sin(ang); ai.sideT = 0.7;
        if (ai.stuckN >= 4 && ai.goalItem) { ai.badLoot.set(ai.goalItem.id, time + 30); ai.goalItem = null; ai.goalKind = ''; ai.stuckN = 0; }
        if (ai.stuckN >= 6) { ai.goalKind = ''; ai.stuckN = 0; }
      }
    } else if (movedD >= 0.4) ai.stuckN = 0;
    ai.stuckT = 0; ai.stuckX = a.x; ai.stuckZ = a.z;
  }
}
