// Browser side of LAN multiplayer.
//  - createNet(): the WebSocket connection, lobby and room messages.
//  - NetMatch: a mirror of the server's match that the renderer, HUD and audio read exactly like a
//    local Game. The own operator is predicted locally (same movement code as the server) and
//    corrected against the server's state; everyone else is drawn 100 ms in the past,
//    interpolated between snapshots, which is also how far the server rewinds them for your shots.
import { Game, makeActor, wallSegments } from '../sim/game.js';
import { TICK, WALL, WEAPONS } from '../sim/config.js';
import { LOOT_TYPES, B, F, INTERP, deserEvent } from './protocol.js';

export function createNet(on) {
  let ws = null, id = 0, name = '', rtt = 0.05, pingT = null, wantOpen = false;
  const api = {
    get connected() { return !!ws && ws.readyState === 1; },
    get id() { return id; },
    get name() { return name; },
    get rtt() { return rtt; },
    connect(nm) {
      name = nm;
      if (ws && ws.readyState <= 1) { api.send({ t: 'hello', name: nm }); return; }
      wantOpen = true;
      const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
      try { ws = new WebSocket(url); } catch (e) { on.error('Could not reach the game server.'); return; }
      ws.onopen = () => {
        api.send({ t: 'hello', name: nm });
        clearInterval(pingT);
        pingT = setInterval(() => api.send({ t: 'ping', c: performance.now() }), 1000);
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        switch (m.t) {
          case 'hi': id = m.id; name = m.name; on.hello(m); break;
          case 'rooms': on.rooms(m.list); break;
          case 'room': on.room(m.room); break;
          case 'start': on.start(m); break;
          case 's': if (api.match) api.match.onSnapshot(m); break;
          case 'pong': { const r = (performance.now() - m.c) / 1000; rtt = rtt * 0.7 + r * 0.3; break; }
          case 'err': on.error(m.msg); break;
          case 'dbg': if (on.debug) on.debug(m); break;
        }
      };
      ws.onclose = () => {
        clearInterval(pingT);
        const was = wantOpen;
        ws = null;
        if (was) on.closed();
      };
      ws.onerror = () => {};
    },
    close() { wantOpen = false; if (ws) ws.close(); ws = null; },
    send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    match: null,
  };
  return api;
}

const lerpA = (a, b, t) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2; return a + d * t; };

export class NetMatch {
  constructor(world, msg, net) {
    this.net = net;
    const g = this.game = new Game(world, { seed: msg.seed, humans: msg.humans, total: msg.total, difficulty: msg.diff, focus: false, collectEvents: true });
    g.net = true;
    g.loot = msg.loot.map(([lid, t, x, y, z]) => ({ id: lid, type: LOOT_TYPES[t], x, y, z, alive: true, dropped: false, born: 0 }));
    g.flight = msg.flight;
    for (const a of g.actors) a.ai = null;          // no brains here: the server decides
    this.me = g.actors[msg.you];
    g.player = this.me; g.focus = null;
    this.room = msg.room;
    // prediction runs on a private copy of the own operator; the visible one gets smoothed results
    this.pred = makeActor(this.me.id, this.me.name, true);
    this._copyMove(this.me, this.pred);
    this.off = { x: 0, y: 0, z: 0 };
    this.seq = 0; this.pending = []; this.outbox = [];
    this.snaps = []; this.offset = null; this.lastSnapAt = 0; this.latest = null;
    this.recoilP = 0; this.lastShot = -9;
    this.sent = 0;
  }

  _copyMove(src, dst) {
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'onGround', 'crouch', 'swimming', 'state', 'cur', 'ads', 'reloadT', 'healT', 'switchT', 'yaw', 'animPhase', 'stepAcc']) dst[k] = src[k];
    dst.weapons = src.weapons; dst.alive = src.alive;
  }

  // one fixed 60 Hz step of the own operator: record the input, predict, queue it for the server
  tick() {
    const me = this.me, c = me.cmd;
    const bits = (c.fire ? B.fire : 0) | (c.ads ? B.ads : 0) | (c.jump ? B.jump : 0) | (c.crouch ? B.crouch : 0) | (c.sprint ? B.sprint : 0)
      | (c.reload ? B.reload : 0) | (c.heal ? B.heal : 0) | (c.wall ? B.wall : 0);
    const inp = [++this.seq, Math.round(c.mx * 1000) / 1000, Math.round(c.mz * 1000) / 1000, Math.round(me.yaw * 10000) / 10000, Math.round(me.pitch * 10000) / 10000, bits, c.sw];
    this.outbox.push(inp);
    if (!me.alive || this.game.over) return;
    this.pending.push(inp);
    this._predict(inp, true);
  }

  _predict(inp, live) {
    const g = this.game, p = this.pred, c = p.cmd;
    c.mx = inp[1]; c.mz = inp[2]; p.yaw = inp[3];
    c.fire = !!(inp[5] & B.fire); c.ads = !!(inp[5] & B.ads); c.jump = !!(inp[5] & B.jump); c.crouch = !!(inp[5] & B.crouch); c.sprint = !!(inp[5] & B.sprint);
    const n0 = g.events.length;
    g.collectEvents = live;
    if (p.state === 'drop') g._updateDrop(p, TICK);
    else if (p.state === 'ground') g._move(p, TICK);
    g.collectEvents = true;
    for (let i = n0; i < g.events.length; i++) if (g.events[i].actor === p) g.events[i].actor = this.me; // own footsteps, jumps, landings
  }

  onSnapshot(s) {
    const now = performance.now() / 1000;
    // server clock estimate that favours the fastest arrivals
    const target = s.st - now;
    if (this.offset == null || target > this.offset) this.offset = target; else this.offset += (target - this.offset) * 0.02;
    this.snaps.push({ t: s.st, a: s.a });
    if (this.snaps.length > 40) this.snaps.shift();
    this.latest = s;
    this._applyShared(s);
    this._applyEvents(s.e);
    this._applyMe(s.me);
  }

  _applyShared(s) {
    const g = this.game, z = g.zone, Z = s.z;
    g.time = s.st; g.alive = s.al;
    z.cx = Z[0]; z.cz = Z[1]; z.r = Z[2]; z.nextX = Z[3]; z.nextZ = Z[4]; z.nextR = Z[5];
    z.state = ['wait', 'shrink', 'closed'][Z[6]] || 'wait'; z.timer = Z[7]; z.phase = Math.min(Z[8], 5); z.closed = !!Z[9];
    if (s.ov && !g.over) { g.over = true; g.winner = s.wn >= 0 ? g.actors[s.wn] : null; }
    // walls: create, update, drop
    const seen = new Set();
    for (const w of s.w) {
      seen.add(w[0]);
      let wl = this._wall(w[0]);
      if (!wl) wl = this._makeWall([w[0], w[1], w[2], w[3], w[4], w[8]]);
      wl.hp = w[5]; wl.age = w[6]; wl.life = w[7];
    }
    g.walls = g.walls.filter((wl) => seen.has(wl.id));
  }

  _wall(wid) { return this.game.walls.find((w) => w.id === wid); }
  _makeWall(v) {
    const [wid, x, y, z, yaw, owner] = v;
    const wl = { id: wid, owner, x, y, z, yaw, hp: WALL.HP, life: WALL.LIFE, age: 0, hitT: -9, segs: wallSegments(x, z, y, yaw), cells: [] };
    this.game.walls.push(wl);
    return wl;
  }

  _applyEvents(list) {
    const g = this.game;
    for (const o of list) {
      const ev = deserEvent(o, g, (wid) => this._wall(wid), (v) => this._makeWall(v));
      switch (ev.type) {
        case 'shot':
          if (ev.actor) g.gunfire.push({ x: ev.actor.x, z: ev.actor.z, t: g.time, id: ev.actor.id });
          if (ev.actor === this.me && ev.kp) { // recoil: the server says how hard it kicked
            this.me.pitch = Math.min(1.35, this.me.pitch + ev.kp); this.me.yaw += ev.ky || 0;
            this.recoilP = Math.min(0.11, this.recoilP + ev.kp * 0.6); this.lastShot = performance.now() / 1000;
          }
          break;
        case 'pickup': { const l = g.loot.find((q) => q.id === ev.lootId); if (l) l.alive = false; break; }
        case 'lootDrop': g.loot.push(ev.loot); break;
        case 'wallBreak': g.walls = g.walls.filter((w) => w !== ev.wall); break;
        case 'kill':
          if (ev.victim) { ev.victim.alive = false; ev.victim.state = 'dead'; }
          if (ev.victim === this.me || ev.victim === g.focus) {
            let f = ev.killer && ev.killer.alive && ev.killer !== this.me ? ev.killer : null;
            if (!f) { let bd = 1e9; for (const a of g.actors) if (a.alive && a !== this.me) { const d = Math.hypot(a.x - ev.victim.x, a.z - ev.victim.z); if (d < bd) { bd = d; f = a; } } }
            g.focus = f;
          }
          break;
        case 'matchEnd': g.over = true; g.winner = ev.winner; break;
      }
      g.events.push(ev);
    }
    while (g.gunfire.length && g.time - g.gunfire[0].t > 6) g.gunfire.shift();
  }

  _applyMe(m) {
    const me = this.me, p = this.pred;
    me.hp = m.hp; me.armor = m.ar; me.helmet = m.he; me.medkits = m.med; me.walls = m.wl;
    me.cur = m.cur; me.reserve = m.res;
    for (let i = 0; i < 3; i++) me.weapons[i] = m.mags[i] >= 0 ? { mag: m.mags[i] } : null;
    me.ads = m.ads; me.reloadT = m.rl; me.healT = m.ht; me.switchT = m.swt; me.bloom = m.bl;
    me.kills = m.kills; me.shots = m.shots; me.hits = m.hits; me.headshots = m.hs; me.dmgDealt = m.dmg;
    if (m.lht > me.lastHurtT) { me.lastHurtT = m.lht; me.hurtDirX = m.hdx; me.hurtDirZ = m.hdz; }
    me.place = m.place; me.killerId = m.kid; me.deathT = m.dt; me.outside = !!m.out;
    if (me.alive && m.hp <= 0) me.alive = false;
    // reconcile: take the server's movement state, replay the inputs it has not seen yet
    const bx = p.x + this.off.x, by = p.y + this.off.y, bz = p.z + this.off.z;
    const wasDrop = p.state === 'drop';
    p.x = m.x; p.y = m.y; p.z = m.z; p.vx = m.vx; p.vy = m.vy; p.vz = m.vz;
    p.onGround = !!m.og; p.crouch = !!m.cr; p.swimming = !!m.sw; p.state = m.st === 'dead' ? 'dead' : m.st;
    p.cur = m.cur; p.weapons = me.weapons; p.ads = m.ads; p.reloadT = m.rl; p.healT = m.ht; p.switchT = m.swt;
    while (this.pending.length && this.pending[0][0] <= m.ack) this.pending.shift();
    if (wasDrop && p.state !== 'drop' && me.state === 'drop') me.landT = this.game.time;
    for (const inp of this.pending) this._predict(inp, false);
    const ex = bx - p.x, ey = by - p.y, ez = bz - p.z;
    if (ex * ex + ey * ey + ez * ez < 16) { this.off.x = ex; this.off.y = ey; this.off.z = ez; }
    else { this.off.x = this.off.y = this.off.z = 0; }
  }

  // every rendered frame: send inputs, place everyone, settle recoil
  update(dt) {
    const g = this.game, me = this.me, now = performance.now() / 1000;
    if (this.outbox.length) {
      const lag = Math.round((this.net.rtt + INTERP) * 60);
      this.net.send({ t: 'in', i: this.outbox, lag });
      this.sent += this.outbox.length;
      this.outbox = [];
    }
    // recoil settles back like it does offline
    if (this.recoilP > 0 && now - this.lastShot > 0.11) { const r = Math.min(this.recoilP, dt * 0.42); me.pitch -= r; this.recoilP -= r; }
    // own operator: predicted state plus a correction that fades out
    const k = Math.exp(-dt * 12);
    this.off.x *= k; this.off.y *= k; this.off.z *= k;
    const p = this.pred;
    if (me.alive) {
      me.x = p.x + this.off.x; me.y = p.y + this.off.y; me.z = p.z + this.off.z;
      me.vx = p.vx; me.vy = p.vy; me.vz = p.vz; me.onGround = p.onGround; me.crouch = p.crouch; me.swimming = p.swimming;
      me.state = p.state; me.animPhase = p.animPhase; me.speed = Math.hypot(p.vx, p.vz); me.sprinting = p.sprinting;
    }
    me.px = me.x; me.py = me.y; me.pz = me.z;
    // everyone else: interpolated INTERP seconds behind the server
    if (this.offset == null || !this.snaps.length) return;
    const rt = now + this.offset - INTERP;
    const S = this.snaps;
    let i = S.length - 1;
    while (i > 0 && S[i - 1].t > rt) i--;
    const s1 = S[i], s0 = i > 0 ? S[i - 1] : s1;
    const t = s1.t > s0.t ? Math.max(0, Math.min(1, (rt - s0.t) / (s1.t - s0.t))) : 1;
    const A0 = s0.a, A1 = s1.a;
    for (const a of g.actors) {
      if (a === me && me.alive) continue;
      const q = a.id * 20;
      if (q + 19 >= A1.length) continue;
      const f = A1[q + 8];
      a.x = A0[q] + (A1[q] - A0[q]) * t; a.y = A0[q + 1] + (A1[q + 1] - A0[q + 1]) * t; a.z = A0[q + 2] + (A1[q + 2] - A0[q + 2]) * t;
      a.yaw = lerpA(A0[q + 3], A1[q + 3], t); a.pitch = A0[q + 4] + (A1[q + 4] - A0[q + 4]) * t;
      a.vx = A1[q + 5]; a.vy = A1[q + 6]; a.vz = A1[q + 7];
      a.alive = !!(f & F.alive); a.onGround = !!(f & F.ground); a.crouch = !!(f & F.crouch); a.sprinting = !!(f & F.sprint);
      a.swimming = !!(f & F.swim); a.outside = !!(f & F.outside); a.isPlayer = !!(f & F.human);
      a.state = !a.alive ? 'dead' : (f & F.drop) ? 'drop' : 'ground';
      a.hp = A1[q + 9]; a.armor = A1[q + 10]; a.helmet = A1[q + 11]; a.cur = A1[q + 12]; a.ads = A1[q + 13];
      a.reloadT = A1[q + 14]; a.healT = A1[q + 15]; a.animPhase = A0[q + 16] + (A1[q + 16] - A0[q + 16]) * t; a.speed = A1[q + 17];
      a.shots = A1[q + 18]; a.kills = A1[q + 19];
      if (a.cur >= 0 && !a.weapons[a.cur]) a.weapons[a.cur] = { mag: WEAPONS[a.cur].mag };
      a.px = a.x; a.py = a.y; a.pz = a.z;
    }
  }
}
