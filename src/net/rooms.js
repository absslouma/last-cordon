// Room server for LAN multiplayer. Runs inside server.mjs (Node).
// Players connect over a WebSocket, create or join a room (up to 20 people), and the host starts
// a match. Each match runs the normal simulation here, authoritatively, at 60 ticks a second:
// clients send inputs, the server applies them, and 30 times a second every client gets a
// snapshot of the match plus the events (shots, hits, kills, pickups...) since the last one.
import { WebSocketServer } from 'ws';
import { generateWorld } from '../sim/world.js';
import { Game } from '../sim/game.js';
import { TICK } from '../sim/config.js';
import { botInit } from '../sim/bots.js';
import { MAX_PLAYERS, SNAP_HZ, LOOT_TYPES, B, F, r2, r3, serEvent, cleanName } from './protocol.js';

const PREDICTED = new Set(['step', 'jump', 'land']); // a client makes these itself for its own operator
const ZONE_STATES = ['wait', 'shrink', 'closed'];

export function attachRooms(httpServer, { test = false, log = () => {} } = {}) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 64 * 1024 });
  const clients = new Map();
  const rooms = new Map();
  let nextClient = 1, nextRoom = 1;

  const send = (c, obj) => { if (c.ws.readyState === 1) c.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); };

  function roomSummary(r) {
    return { id: r.id, name: r.name, host: r.host ? r.host.name : '', n: r.players.length, max: MAX_PLAYERS, state: r.state, alive: r.match ? r.match.game.alive : 0 };
  }
  function roomDetail(r, you) {
    return {
      id: r.id, name: r.name, hostId: r.host ? r.host.id : 0, you: you.id, state: r.state, settings: r.settings,
      players: r.players.map((p) => ({ id: p.id, name: p.name, inMatch: !!(r.match && r.match.byClient.has(p.id)) })),
      alive: r.match ? r.match.game.alive : 0, time: r.match ? Math.round(r.match.game.time) : 0,
    };
  }
  function pushRooms() {
    const list = JSON.stringify({ t: 'rooms', list: [...rooms.values()].map(roomSummary) });
    for (const c of clients.values()) if (!c.room) send(c, list);
  }
  function pushRoom(r) { for (const p of r.players) send(p, { t: 'room', room: roomDetail(r, p) }); }

  function uniqueName(r, name) {
    const taken = new Set(r.players.map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let k = 2; ; k++) { const n = `${name.slice(0, 13)} ${k}`; if (!taken.has(n.toLowerCase())) return n; }
  }

  function leaveRoom(c) {
    const r = c.room;
    if (!r) return;
    r.players = r.players.filter((p) => p !== c);
    c.room = null;
    if (r.match) {
      const aid = r.match.byClient.get(c.id);
      if (aid != null) { // the operator keeps playing as a bot so the match stays fair
        const a = r.match.game.actors[aid];
        r.match.byClient.delete(c.id);
        if (a.alive) { a.isPlayer = false; botInit(r.match.game, a); }
      }
    }
    if (!r.players.length) { stopMatch(r); rooms.delete(r.id); log(`room "${r.name}" closed`); }
    else { if (r.host === c) r.host = r.players[0]; pushRoom(r); }
    pushRooms();
  }

  // ------------------------------------------------------------------ matches
  function startMatch(r) {
    if (!r.world) r.world = generateWorld();
    const players = r.players.slice(0, MAX_PLAYERS);
    const names = players.map((p) => p.name);
    const total = r.settings.bots ? MAX_PLAYERS : players.length;
    const seed = 1 + Math.floor(Math.random() * 1e9);
    const game = new Game(r.world, { seed, humans: names, total, difficulty: r.settings.diff, focus: false, lagComp: true, collectEvents: true });
    game.watchers = [];
    const m = { game, byClient: new Map(), seed, acc: 0, last: performance.now(), sendAcc: 0, events: [], endAt: 0, speed: 1, tickMs: 0, tickMax: 0, bytes: 0 };
    players.forEach((p, i) => {
      m.byClient.set(p.id, i);
      p.inputs = []; p.ack = 0; p.lagTicks = 6;
    });
    r.match = m; r.state = 'playing';
    const loot = game.loot.map((l) => [l.id, LOOT_TYPES.indexOf(l.type), r2(l.x), r2(l.y), r2(l.z)]);
    for (const p of players) {
      send(p, { t: 'start', seed, total, humans: names, you: m.byClient.get(p.id), diff: r.settings.diff, loot, flight: game.flight, room: r.name });
    }
    m.timer = setInterval(() => stepMatch(r), 4);
    pushRoom(r); pushRooms();
    log(`room "${r.name}": match started, ${players.length} player(s), ${total} operators`);
  }

  function stopMatch(r) {
    if (r.match) { clearInterval(r.match.timer); r.match = null; }
    r.state = 'lobby';
  }

  function applyInputs(m) {
    const g = m.game;
    for (const [cid, aid] of m.byClient) {
      const c = clients.get(cid), a = g.actors[aid];
      if (!c || !a.alive) continue;
      const q = c.inputs;
      while (q.length > 4) { // a burst after a stall: merge the oldest so no button press is lost
        const o = q.shift();
        q[0][5] |= o[5] & (B.reload | B.heal | B.wall);
        if (q[0][6] < 0) q[0][6] = o[6];
      }
      const cmd = a.cmd;
      cmd.reload = false; cmd.heal = false; cmd.wall = false; cmd.sw = -1;
      const inp = q.shift();
      if (!inp) continue;                       // nothing new: keep moving as before
      const [seq, mx, mz, yaw, pitch, bits, sw] = inp;
      c.ack = seq;
      cmd.mx = Math.max(-1.5, Math.min(1.5, +mx || 0)); cmd.mz = Math.max(-1.5, Math.min(1.5, +mz || 0));
      cmd.fire = !!(bits & B.fire); cmd.ads = !!(bits & B.ads); cmd.jump = !!(bits & B.jump);
      cmd.crouch = !!(bits & B.crouch); cmd.sprint = !!(bits & B.sprint);
      cmd.reload = !!(bits & B.reload); cmd.heal = !!(bits & B.heal); cmd.wall = !!(bits & B.wall);
      cmd.sw = sw >= 0 && sw <= 2 ? sw : -1;
      if (Number.isFinite(yaw)) a.yaw = yaw;
      if (Number.isFinite(pitch)) a.pitch = Math.max(-1.4, Math.min(1.4, pitch));
      a.lagTicks = c.lagTicks + q.length;
    }
  }

  function updateWatchers(m) {
    const g = m.game, w = [];
    for (const aid of m.byClient.values()) {
      const a = g.actors[aid];
      if (a.alive) w.push(a);
      else if (a.killerId >= 0 && g.actors[a.killerId].alive) w.push(g.actors[a.killerId]);
    }
    g.watchers = w;
  }

  function stepMatch(r) {
    const m = r.match;
    if (!m) return;
    const now = performance.now(), g = m.game;
    m.acc += Math.min(0.25, (now - m.last) / 1000) * m.speed;
    m.last = now;
    let n = 0;
    const t0 = performance.now();
    while (m.acc >= TICK && n < 12 * m.speed) {
      applyInputs(m);
      if (g.tickN % 30 === 0) updateWatchers(m);
      g.step(TICK);
      for (const ev of g.events) m.events.push({ s: JSON.stringify(serEvent(ev)), a: ev.actor ? ev.actor.id : -1, p: PREDICTED.has(ev.type) });
      g.events.length = 0;
      m.acc -= TICK; n++;
    }
    if (n) {
      const ms = performance.now() - t0;
      m.tickMs += ms; if (ms / n > m.tickMax) m.tickMax = ms / n;
    }
    m.sendAcc += (now - (m.lastSend || now)) / 1000;
    m.lastSend = now;
    if (m.sendAcc >= 1 / SNAP_HZ - 0.004 || (g.over && m.events.length)) { m.sendAcc = 0; broadcast(r); }
    if (g.over && !m.endAt) m.endAt = now + 7000;
    if (m.endAt && now > m.endAt) {
      log(`room "${r.name}": match over, winner ${g.winner ? g.winner.name : 'none'} at ${Math.round(g.time)} s`);
      stopMatch(r); pushRoom(r); pushRooms();
    }
  }

  function broadcast(r) {
    const m = r.match, g = m.game, A = g.actors;
    const a = new Array(A.length * 20);
    for (let i = 0; i < A.length; i++) {
      const x = A[i], k = i * 20;
      a[k] = r2(x.x); a[k + 1] = r2(x.y); a[k + 2] = r2(x.z); a[k + 3] = r3(x.yaw); a[k + 4] = r3(x.pitch);
      a[k + 5] = r2(x.vx); a[k + 6] = r2(x.vy); a[k + 7] = r2(x.vz);
      a[k + 8] = (x.alive ? F.alive : 0) | (x.onGround ? F.ground : 0) | (x.crouch ? F.crouch : 0) | (x.sprinting ? F.sprint : 0) | (x.swimming ? F.swim : 0) | (x.state === 'drop' ? F.drop : 0) | (x.outside ? F.outside : 0) | (x.isPlayer ? F.human : 0);
      a[k + 9] = r2(x.hp); a[k + 10] = r2(x.armor); a[k + 11] = r2(x.helmet); a[k + 12] = x.cur; a[k + 13] = r2(x.ads);
      a[k + 14] = r2(x.reloadT); a[k + 15] = r2(x.healT); a[k + 16] = r2(x.animPhase); a[k + 17] = r2(x.speed); a[k + 18] = x.shots; a[k + 19] = x.kills;
    }
    const z = g.zone;
    const zone = [r2(z.cx), r2(z.cz), r2(z.r), r2(z.nextX), r2(z.nextZ), r2(z.nextR), ZONE_STATES.indexOf(z.state), r2(z.timer), z.phase, z.closed ? 1 : 0];
    const walls = g.walls.map((w) => [w.id, r2(w.x), r2(w.y), r2(w.z), r3(w.yaw), Math.round(w.hp), r2(w.age), r2(w.life), w.owner]);
    const common = `{"t":"s","st":${r3(g.time)},"tk":${g.tickN},"al":${g.alive},"ov":${g.over ? 1 : 0},"wn":${g.winner ? g.winner.id : -1},"a":${JSON.stringify(a)},"z":${JSON.stringify(zone)},"w":${JSON.stringify(walls)}`;
    const evs = m.events;
    m.events = [];
    for (const [cid, aid] of m.byClient) {
      const c = clients.get(cid);
      if (!c) continue;
      const me = A[aid];
      let e = '';
      for (const ev of evs) if (!(ev.p && ev.a === aid)) e += (e ? ',' : '') + ev.s;
      const mine = {
        ack: c.ack, x: r3(me.x), y: r3(me.y), z: r3(me.z), vx: r3(me.vx), vy: r3(me.vy), vz: r3(me.vz),
        og: me.onGround ? 1 : 0, cr: me.crouch ? 1 : 0, sw: me.swimming ? 1 : 0, st: me.state,
        hp: r2(me.hp), ar: r2(me.armor), he: r2(me.helmet), med: me.medkits, wl: me.walls, cur: me.cur,
        mags: me.weapons.map((w) => (w ? w.mag : -1)), res: me.reserve.slice(), ads: r3(me.ads),
        rl: r3(me.reloadT), ht: r3(me.healT), swt: r3(me.switchT), bl: r3(me.bloom),
        kills: me.kills, shots: me.shots, hits: me.hits, hs: me.headshots, dmg: Math.round(me.dmgDealt),
        lht: r3(me.lastHurtT), hdx: r3(me.hurtDirX), hdz: r3(me.hurtDirZ), place: me.place, kid: me.killerId, dt: r2(me.deathT), out: me.outside ? 1 : 0,
      };
      const msg = `${common},"e":[${e}],"me":${JSON.stringify(mine)}}`;
      m.bytes += msg.length;
      send(c, msg);
    }
  }

  // ------------------------------------------------------------------ messages
  function onMessage(c, msg) {
    switch (msg.t) {
      case 'hello':
        c.name = cleanName(msg.name, `Operator ${c.id}`);
        send(c, { t: 'hi', id: c.id, name: c.name, max: MAX_PLAYERS });
        send(c, { t: 'rooms', list: [...rooms.values()].map(roomSummary) });
        break;
      case 'list': send(c, { t: 'rooms', list: [...rooms.values()].map(roomSummary) }); break;
      case 'create': {
        if (c.room) leaveRoom(c);
        const r = { id: nextRoom++, name: cleanName(msg.name, `${c.name}'s room`), host: c, players: [c], settings: { bots: true, diff: 1 }, state: 'lobby', match: null, world: null };
        rooms.set(r.id, r);
        c.room = r;
        pushRoom(r); pushRooms();
        log(`room "${r.name}" created by ${c.name}`);
        break;
      }
      case 'join': {
        const r = rooms.get(Number(msg.id));
        if (!r) return send(c, { t: 'err', msg: 'That room no longer exists.' });
        if (r === c.room) return pushRoom(r);
        if (r.players.length >= MAX_PLAYERS) return send(c, { t: 'err', msg: `That room is full (${MAX_PLAYERS} players).` });
        if (c.room) leaveRoom(c);
        c.name = uniqueName(r, c.name);
        r.players.push(c); c.room = r;
        pushRoom(r); pushRooms();
        break;
      }
      case 'leave': leaveRoom(c); send(c, { t: 'room', room: null }); send(c, { t: 'rooms', list: [...rooms.values()].map(roomSummary) }); break;
      case 'set': {
        const r = c.room;
        if (!r || r.host !== c || r.state !== 'lobby') return;
        if (typeof msg.bots === 'boolean') r.settings.bots = msg.bots;
        if ([0.7, 1, 1.35].includes(Number(msg.diff))) r.settings.diff = Number(msg.diff);
        pushRoom(r);
        break;
      }
      case 'start': {
        const r = c.room;
        if (!r || r.host !== c) return;
        if (r.state !== 'lobby') return send(c, { t: 'err', msg: 'A match is already running.' });
        if (!r.settings.bots && r.players.length < 2) return send(c, { t: 'err', msg: 'Two players are needed with bots switched off.' });
        startMatch(r);
        break;
      }
      case 'in': {
        const r = c.room;
        if (!r || !r.match || !r.match.byClient.has(c.id) || !Array.isArray(msg.i)) return;
        for (const inp of msg.i) if (Array.isArray(inp) && inp.length >= 7 && inp[0] > c.ack) c.inputs.push(inp);
        if (c.inputs.length > 30) c.inputs.splice(0, c.inputs.length - 30);
        if (Number.isFinite(msg.lag)) c.lagTicks = Math.max(0, Math.min(36, msg.lag));
        break;
      }
      case 'ping': send(c, { t: 'pong', c: msg.c }); break;
      case 'dbg': if (test) debug(c, msg); break;
    }
  }

  // test-only commands (server started with --test)
  function debug(c, msg) {
    const r = c.room, m = r && r.match;
    if (msg.op === 'stats') return send(c, { t: 'dbg', stats: m ? { tickMsAvg: m.tickMs / Math.max(1, m.game.tickN), tickMax: m.tickMax, bytes: m.bytes, ticks: m.game.tickN, time: m.game.time } : null, rooms: rooms.size, clients: clients.size });
    if (!m) return;
    const g = m.game, a = g.actors[m.byClient.get(c.id)];
    if (msg.op === 'speed') m.speed = Math.max(1, Math.min(16, Number(msg.v) || 1));
    else if (msg.op === 'god') g.god = !!msg.v;
    else if (msg.op === 'tp' && a) {
      a.state = 'ground'; a.x = msg.x; a.z = msg.z; a.y = g.world.heightAt(msg.x, msg.z); a.vx = a.vy = a.vz = 0; a.onGround = true;
      if (Number.isFinite(msg.yaw)) a.yaw = msg.yaw;
    } else if (msg.op === 'give' && a) g.give(a, msg.item);
    else if (msg.op === 'hp' && a) a.hp = Number(msg.v);
    else if (msg.op === 'bots') { for (const b of g.actors) if (b.ai && b.alive) { b.x = msg.x + (b.id % 5) * 40 - 100; b.z = msg.z + 140 + Math.floor(b.id / 5) * 30; } }
    else if (msg.op === 'freeze') { for (const b of g.actors) if (b.ai) b.ai.frozen = !!msg.v; }
  }

  wss.on('connection', (ws) => {
    const c = { id: nextClient++, ws, name: 'Operator', room: null, inputs: [], ack: 0, lagTicks: 6 };
    clients.set(c.id, c);
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      try { onMessage(c, msg); } catch (e) { log('message error: ' + (e && e.stack || e)); }
    });
    ws.on('close', () => { leaveRoom(c); clients.delete(c.id); });
    ws.on('error', () => {});
  });

  return { wss, rooms, clients };
}
