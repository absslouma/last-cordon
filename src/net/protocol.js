// Wire format shared by the room server (Node) and the browser client.
// Messages are JSON over one WebSocket at /ws. Numbers are rounded to keep snapshots small.

export const MAX_PLAYERS = 20;
export const SNAP_HZ = 30;
export const INTERP = 0.1;                 // seconds remote operators are drawn behind the server
export const LOOT_TYPES = ['ar', 'smg', 'sr', 'ammo', 'vest', 'helmet', 'medkit'];

// held buttons and one-shot actions packed into one integer per input
export const B = { fire: 1, ads: 2, jump: 4, crouch: 8, sprint: 16, reload: 32, heal: 64, wall: 128 };

// per-actor snapshot layout
export const A_FIELDS = 20;
export const F = { alive: 1, ground: 2, crouch: 4, sprint: 8, swim: 16, drop: 32, outside: 64, human: 128 };

export const r1 = (v) => Math.round(v * 10) / 10;
export const r2 = (v) => Math.round(v * 100) / 100;
export const r3 = (v) => Math.round(v * 1000) / 1000;

export function cleanName(s, fallback) {
  const t = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return t || fallback;
}

const REF_ACTOR = new Set(['actor', 'target', 'attacker', 'victim', 'killer', 'winner']);

// Simulation event -> plain JSON (object references become ids).
export function serEvent(ev) {
  const o = { k: ev.type };
  for (const key in ev) {
    if (key === 'type' || key === 'time') continue;
    const v = ev[key];
    if (REF_ACTOR.has(key)) o[key] = v ? v.id : -1;
    else if (key === 'wall') o.wall = [v.id, r2(v.x), r2(v.y), r2(v.z), r3(v.yaw), v.owner];
    else if (key === 'loot') o.loot = [v.id, LOOT_TYPES.indexOf(v.type), r2(v.x), r2(v.y), r2(v.z)];
    else if (typeof v === 'number') o[key] = r3(v);
    else o[key] = v;
  }
  return o;
}

// Plain JSON -> event with live references into the client's mirror of the match.
export function deserEvent(o, game, wallById, makeWall) {
  const ev = { type: o.k, time: game.time };
  for (const key in o) {
    if (key === 'k') continue;
    const v = o[key];
    if (REF_ACTOR.has(key)) ev[key] = v >= 0 ? game.actors[v] || null : null;
    else if (key === 'wall') ev.wall = wallById(v[0]) || makeWall(v);
    else if (key === 'loot') ev.loot = { id: v[0], type: LOOT_TYPES[v[1]], x: v[2], y: v[3], z: v[4], alive: true, dropped: true, born: game.time };
    else ev[key] = v;
  }
  return ev;
}
