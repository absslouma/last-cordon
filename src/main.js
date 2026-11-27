// LAST CORDON entry point: boots the procedural world, runs the fixed-timestep simulation,
// feeds the renderer / HUD / audio from sim state and events, and owns menu, pause and end flow.
import { generateWorld } from './sim/world.js';
import { Game, computeCamera } from './sim/game.js';
import { TICK, WEAPONS } from './sim/config.js';
import { buildTextures, buildSplat, buildHeightTex } from './render/textures.js';
import { createCore } from './render/core.js';
import { buildWorld3D } from './render/world3d.js';
import { createCharacters } from './render/characters.js';
import { createEffects } from './render/effects.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import { createInput } from './input.js';
import { createTouch, isTouchDevice } from './touch.js';
import { createLobby } from './lobby.js';
import { NetMatch } from './net/client.js';
import * as THREE from 'three';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TEST = params.has('test');
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message || e.error)));
window.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + String(e.reason)));

const next = () => new Promise((r) => setTimeout(r, 0));
function progress(pct, msg) { $('loadfill').style.width = pct + '%'; $('loadmsg').textContent = msg; }

async function boot() {
  const canvas = $('view');
  const bootTimes = [];
  let markT = performance.now();
  const mark = (name) => { const t = performance.now(); bootTimes.push([name, Math.round(t - markT)]); markT = t; };
  progress(8, 'Raising the island');
  await next();
  const world = generateWorld();
  mark('island');
  progress(24, 'Mixing concrete, rust and sand');
  await next();
  const core = createCore(canvas, { dpr: Number(params.get('dpr')) || 1 });
  const aniso = Math.min(8, core.renderer.capabilities.getMaxAnisotropy());
  mark('renderer');
  const T = buildTextures(aniso);
  mark('textures');
  progress(52, 'Surveying the ground');
  await next();
  const splat = buildSplat(world, aniso), heightTex = buildHeightTex(world);
  const glow = (() => { // soft dot for lamp halos
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.3, 'rgba(255,255,255,.4)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  progress(62, 'Building compounds and planting palms');
  await next();
  mark('ground maps');
  const world3d = buildWorld3D(world, T, core, splat, heightTex, glow);
  core.scene.add(world3d);
  mark('meshes');
  progress(80, 'Briefing twenty operators');
  await next();
  const chars = createCharacters(core, T, 20);
  core.scene.add(chars.group);
  const effects = createEffects(core, T, world, heightTex);
  core.scene.add(effects.group);
  const hud = createHud(world);
  const audio = createAudio();

  let game = new Game(world, { seed: 1 });
  let state = 'menu', paused = false, difficulty = 1, matchN = 0;
  let endAt = 0, endShown = false, crouch = false, simTime = 0, shake = 0;
  const pending = { reload: false, heal: false, wall: false, sw: -1 };
  let netMatch = null;                 // set while playing a multiplayer match
  const evCount = {};
  const CAM = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, back: 0, scoped: false };
  const speed = Number(params.get('speed') || 1);

  const input = createInput(canvas, (locked) => {
    if (state !== 'playing' || input.free) return;
    if (!locked && !endShown) { paused = true; $('pause').classList.remove('hidden'); audio.silence(); }
    else if (locked) { paused = false; $('pause').classList.add('hidden'); }
  });
  const touchMode = isTouchDevice(params);
  input.free = TEST || touchMode;      // phones have no pointer lock: the game is live whenever it is on screen
  input.touchMode = touchMode;
  let touch = null;
  if (touchMode) {
    document.body.classList.add('touch');
    hud.setTouch(true);
    touch = createTouch(input, { pause: () => pauseGame(), map: () => hud.toggleMap() });
    try { const sv = Number(localStorage.getItem('lc.sens')); if (sv > 0) { touch.setSens(sv); for (const b of $('sens').children) b.classList.toggle('on', Number(b.dataset.v) === sv); } } catch (e) { /* storage blocked */ }
  }
  function pauseGame() {
    if (state !== 'playing' || endShown || paused) return;
    paused = true; $('pause').classList.remove('hidden'); audio.silence();
    if (touch) touch.release();
    input.unlock();
  }
  function resumeGame() { paused = false; $('pause').classList.add('hidden'); }
  // phones and tablets: going fullscreen and landscape needs a tap, so it rides on Deploy
  function goFullscreen() {
    if (!touchMode || document.fullscreenElement) return;
    const el = document.documentElement;
    if (!el.requestFullscreen) return;
    el.requestFullscreen({ navigationUI: 'hide' }).then(() => {
      if (screen.orientation && screen.orientation.lock) return screen.orientation.lock('landscape');
    }).catch(() => { /* not allowed here: play in the browser window */ });
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && input.free && !TEST) pauseGame(); });

  core.setQuality(params.get('q') || 'auto');
  const resize = () => core.resize(window.innerWidth, window.innerHeight);
  window.addEventListener('resize', resize);
  resize();

  // ---------------------------------------------------------------- match flow
  function startMatch(opts = {}) {
    matchN++;
    const seed = opts.seed != null ? opts.seed : (params.has('seed') && matchN === 1 ? Number(params.get('seed')) : (Date.now() % 100000) + matchN * 7);
    game = new Game(world, { seed, difficulty, autopilot: opts.autopilot != null ? opts.autopilot : params.has('auto'), god: !!opts.god });
    chars.reset(); effects.reset(); hud.reset(); input.clear();
    crouch = false; endAt = 0; endShown = false; paused = false; simTime = 0; shake = 0;
    pending.reload = pending.heal = pending.wall = false; pending.sw = -1;
    state = 'playing';
    $('menu').classList.add('hidden'); $('end').classList.add('hidden'); $('pause').classList.add('hidden');
    hud.setVisible(true); chars.group.visible = true;
    input.capture = true;
    audio.plane();
    const p = game.player;
    p.pitch = -0.5;
    return seed;
  }
  // ---- multiplayer: the server says go
  function startNetMatch(msg) {
    netMatch = new NetMatch(world, msg, lobby.net);
    lobby.net.match = netMatch;
    game = netMatch.game;
    chars.reset(); effects.reset(); hud.reset(); input.clear();
    crouch = false; endAt = 0; endShown = false; paused = false; simTime = 0; shake = 0; acc = 0;
    pending.reload = pending.heal = pending.wall = false; pending.sw = -1;
    state = 'playing';
    $('menu').classList.add('hidden'); $('end').classList.add('hidden'); $('pause').classList.add('hidden');
    $('again').textContent = 'Back to room'; $('tomenu').textContent = 'Leave room';
    hud.setVisible(true); chars.group.visible = true;
    input.capture = true;
    audio.resume(); audio.plane();
    game.player.pitch = -0.5;
    hud.banner(msg.room, `${msg.humans.length} player${msg.humans.length === 1 ? '' : 's'} · ${msg.total} operators`, 3);
    input.lock();
  }
  // leave the match view: back to the room screen, or out of the room to the main menu
  function endNetView(toRoom) {
    netMatch = null; lobby.net.match = null;
    state = 'menu'; paused = false; endShown = false;
    hud.setVisible(false); chars.group.visible = false;
    $('end').classList.add('hidden'); $('pause').classList.add('hidden');
    $('again').textContent = 'Redeploy'; $('tomenu').textContent = 'Main menu';
    input.capture = false; input.unlock(); audio.silence();
    if (toRoom) lobby.showRoom();
    else { lobby.leave(); $('menu').classList.remove('hidden'); }
  }

  function toMenu() {
    state = 'menu'; paused = false; endShown = false;
    hud.setVisible(false); chars.group.visible = false;
    $('menu').classList.remove('hidden'); $('end').classList.add('hidden'); $('pause').classList.add('hidden');
    input.capture = false; input.unlock(); audio.silence();
  }
  function showEnd() {
    if (endShown) return;
    endShown = true;
    hud.showEnd(game);
    audio.sting(game.player.alive && game.over);
    input.unlock(); input.capture = false;
    $('pause').classList.add('hidden'); paused = false;
  }

  $('deploy').addEventListener('click', () => { goFullscreen(); audio.resume(); audio.ui('go'); startMatch(); input.lock(); });
  $('again').addEventListener('click', () => { if (netMatch) { audio.ui('tick'); endNetView(true); return; } goFullscreen(); audio.resume(); audio.ui('go'); startMatch(); input.lock(); });
  $('tomenu').addEventListener('click', () => { audio.resume(); audio.ui('tick'); if (netMatch) endNetView(false); else toMenu(); });
  const lobby = createLobby({
    audio, onStart: (msg) => startNetMatch(msg), inMatch: () => !!netMatch,
    onClosed: () => { if (netMatch) { endNetView(false); hud.toast('Lost connection to the game server'); } },
  });
  $('multi').addEventListener('click', () => { goFullscreen(); audio.resume(); audio.ui('tick'); lobby.open(); });
  $('pause').addEventListener('click', () => { audio.resume(); if (input.free) resumeGame(); else input.lock(); });
  canvas.addEventListener('click', () => { if (state === 'playing' && !input.active && !endShown) input.lock(); });
  const group = (id, fn) => {
    const box = $(id);
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      for (const o of box.children) o.classList.toggle('on', o === b);
      audio.resume(); audio.ui('tick'); fn(b.dataset.v);
    });
  };
  group('diff', (v) => { difficulty = Number(v); });
  group('qual', (v) => core.setQuality(v));
  group('sens', (v) => { if (touch) touch.setSens(Number(v)); try { localStorage.setItem('lc.sens', v); } catch (e) { /* storage blocked */ } });

  // ---------------------------------------------------------------- input -> commands
  function frameInput() {
    const p = game.player, e = input.edges;
    if (state === 'playing') {
      if (endShown) {
        if (netMatch) { if (e.has('Enter') || e.has('NumpadEnter')) endNetView(true); else if (e.has('Escape')) endNetView(false); }
        else if (e.has('Enter') || e.has('NumpadEnter')) { audio.resume(); startMatch(); input.lock(); }
        else if (e.has('Escape')) toMenu();
      } else if (!paused) {
        if (e.has('KeyR')) pending.reload = true;
        if (e.has('KeyH')) pending.heal = true;
        if (e.has('KeyG')) pending.wall = true;
        if (e.has('Digit1') || e.has('Numpad1')) pending.sw = 0;
        if (e.has('Digit2') || e.has('Numpad2')) pending.sw = 1;
        if (e.has('Digit3') || e.has('Numpad3')) pending.sw = 2;
        if (e.has('KeyC')) crouch = !crouch;
        if (e.has('KeyM') || e.has('Tab')) hud.toggleMap();
        if (input.wheel !== 0 && p.alive) { // cycle through owned weapons
          for (let k = 1; k <= 3; k++) { const i = (((p.cur < 0 ? 0 : p.cur) + Math.sign(input.wheel) * k) % 3 + 3) % 3; if (p.weapons[i] && i !== p.cur) { pending.sw = i; break; } }
        }
        // mouse look goes straight onto the operator so the view never lags a tick
        if (p.alive && !p.ai && input.active) {
          const sens = 0.0023 * (core.camera.fov / 62);
          p.yaw -= input.mdx * sens;
          p.pitch = Math.max(-1.35, Math.min(1.35, p.pitch - input.mdy * sens));
        }
      }
    } else if (state === 'menu' && !$('menu').classList.contains('hidden') && (e.has('Enter') || e.has('NumpadEnter'))) { audio.resume(); audio.ui('go'); startMatch(); input.lock(); }
    if (e.has('F3')) hud.togglePerf();
    input.mdx = 0; input.mdy = 0; input.wheel = 0; e.clear();
  }
  function applyInput() {
    const p = game.player, c = p.cmd;
    if (p.ai || !p.alive) return;
    const k = input.keys, live = input.active && !paused;
    let f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let r = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const st = input.stick;
    let stickSprint = false;
    if (st.active) { // analog: a small push walks slowly, a full push forward sprints
      let sx = st.x, sz = st.y;
      const m = Math.hypot(sx, sz);
      if (m < 0.12) { sx = 0; sz = 0; } else if (m > 1) { sx /= m; sz /= m; }
      f = -sz; r = sx;
      stickSprint = m > 0.92 && -st.y / m > 0.6;
    }
    const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
    c.mx = live ? -sy * f + cy * r : 0; c.mz = live ? -cy * f - sy * r : 0;
    c.sprint = live && (k.has('ShiftLeft') || k.has('ShiftRight') || stickSprint);
    c.jump = live && k.has('Space');
    if (c.jump || (c.sprint && (f || r))) crouch = false;
    c.crouch = crouch;
    c.fire = live && input.lmb; c.ads = live && input.rmb;
    c.reload = pending.reload; c.heal = pending.heal; c.wall = pending.wall; c.sw = pending.sw;
    pending.reload = pending.heal = pending.wall = false; pending.sw = -1;
  }

  // ---------------------------------------------------------------- sim events -> sound, fx, HUD
  function dispatch() {
    const evs = game.events, p = game.player, cam = core.camera.position;
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      evCount[ev.type] = (evCount[ev.type] || 0) + 1;
      if (ev.type === 'wallDeploy' && ev.actor !== p) evCount.botWalls = (evCount.botWalls || 0) + 1;
      effects.onEvent(ev, chars.views, cam);
      hud.onEvent(ev, game);
      switch (ev.type) {
        case 'shot': {
          const own = ev.actor === p && p.alive;
          audio.gunshot(ev.weapon, ev.actor.x, ev.actor.z, own);
          if (ev.hit === 'world') audio.impact(ev.hx, ev.hz, ev.kind);
          if (own) shake = Math.min(1, shake + (ev.weapon === 2 ? 0.7 : 0.16));
          else if (p.alive) { // near miss: crack past the ear
            const ax = ev.mx, az = ev.mz, bx = ev.hx - ax, bz = ev.hz - az, l2 = bx * bx + bz * bz;
            if (l2 > 16) { const t = Math.max(0, Math.min(1, ((p.x - ax) * bx + (p.z - az) * bz) / l2)); if (t > 0.1 && Math.hypot(ax + bx * t - p.x, az + bz * t - p.z) < 2.2 && Math.random() < 0.6) audio.whiz(ax + bx * t, az + bz * t); }
          }
          break;
        }
        case 'damage':
          if (ev.target === p) { audio.hurt(ev.amount); shake = Math.min(1, shake + 0.35); }
          if (ev.attacker === p && ev.target !== p) audio.hitmarker(ev.killed, ev.zone === 'head');
          break;
        case 'step': audio.step(ev.actor.x, ev.actor.z, ev.actor === p, ev.actor.sprinting, ev.actor.y < -0.2); break;
        case 'land': audio.land(ev.actor.x, ev.actor.z, ev.actor === p, ev.drop); if (ev.actor === p) shake = Math.min(1, shake + 0.3); break;
        case 'reload': if (ev.actor === p) audio.reload(ev.weapon, WEAPONS[ev.weapon].reload); break;
        case 'dry': if (ev.actor === p) audio.dry(); break;
        case 'switch': if (ev.actor === p) audio.swap(); break;
        case 'wallDeploy': audio.wallDeploy(ev.wall.x, ev.wall.z); break;
        case 'wallHit': audio.wallHit(ev.x, ev.z); break;
        case 'wallBreak': if (!ev.expired) audio.wallBreak(ev.wall.x, ev.wall.z); break;
        case 'pickup': if (ev.actor === p) audio.pickup(ev.item); break;
        case 'heal': if (ev.actor === p) audio.heal(false); break;
        case 'healDone': if (ev.actor === p) audio.heal(true); break;
        case 'zone': audio.zoneAlert(); break;
        case 'kill': if (ev.victim === p && !endAt) endAt = simTime + 1.7; break;
        case 'matchEnd': if (!endAt) endAt = simTime + 1.6; break;
      }
    }
    evs.length = 0;
  }

  // ---------------------------------------------------------------- camera
  function updateCamera(alpha, time, dt) {
    const cam = core.camera, p = game.player;
    let fov = 62;
    if (state === 'menu') {
      const a = time * 0.035 + 0.6;
      cam.position.set(Math.sin(a) * 118, 34, Math.cos(a) * 118);
      cam.lookAt(0, 13, 0);
      CAM.scoped = false;
    } else if (p.alive) {
      const x = p.px + (p.x - p.px) * alpha, y = p.py + (p.y - p.py) * alpha, z = p.pz + (p.z - p.pz) * alpha;
      computeCamera(game, p, x, y, z, CAM);
      const sh = shake * shake * 0.012;
      cam.position.set(CAM.x, CAM.y, CAM.z);
      cam.rotation.set(p.pitch + (Math.random() - 0.5) * sh, p.yaw + (Math.random() - 0.5) * sh, 0, 'YXZ');
      const w = p.cur >= 0 ? WEAPONS[p.cur] : null;
      fov = p.state === 'drop' ? 70 : 62 + (w ? (w.adsFov - 62) * p.ads * p.ads : 0) + (p.sprinting ? 4 : 0);
    } else { // spectate whoever the director is following
      const f = game.focus && game.focus.alive ? game.focus : p;
      const a = time * 0.22;
      cam.position.set(f.x + Math.sin(a) * 7.5, Math.max(f.y, world.heightAt(f.x + Math.sin(a) * 7.5, f.z + Math.cos(a) * 7.5)) + 3.6, f.z + Math.cos(a) * 7.5);
      cam.lookAt(f.x, f.y + 1.2, f.z);
      CAM.scoped = false;
    }
    shake = Math.max(0, shake - dt * 4.5);
    if (Math.abs(cam.fov - fov) > 0.01) { cam.fov += (fov - cam.fov) * Math.min(1, dt * 14); cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
  }

  // ---------------------------------------------------------------- frame loop
  let last = performance.now(), acc = 0, fps = 60, fpsN = 0, fpsT = 0, renderTime = 0;
  const fwd = new THREE.Vector3(), frameLog = [];
  // Video capture: the page runs on a virtual clock advanced exactly one frame per step, so the
  // recording is perfectly smooth however long each frame takes to render and save. Sound calls
  // are logged with their video time and rendered offline afterwards, in sync.
  const capture = { on: false, t: 0, vms: 0, tid: 0, timers: [], log: [] };
  const worst = { frame: 0, sim: 0, render: 0, long: 0 };   // since the last resetFrameLog()
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (capture.on) return;              // video capture steps frames itself
    if (dt > 0.1) dt = 0.1;
    tick(dt);
  }
  function tick(dt) {
    frameLog.push(dt * 1000); if (frameLog.length > 600) frameLog.shift();
    if (dt * 1000 > worst.frame) worst.frame = dt * 1000;
    if (dt > 0.05) worst.long++;
    const tA = performance.now();
    frameInput();
    if (state === 'playing' && netMatch) {
      // multiplayer: the server runs the match; we send inputs, predict ourselves, mirror the rest
      acc += dt;
      let steps = 0;
      while (acc >= TICK && steps < 8) { applyInput(); netMatch.tick(); acc -= TICK; steps++; }
      if (acc > TICK * 3) acc = 0;
      simTime += dt;
      netMatch.update(dt);
      dispatch();
      if (endAt && simTime >= endAt) showEnd();
    } else if (state === 'playing' && !paused) {
      acc += dt * speed;
      let steps = 0;
      while (acc >= TICK && steps < 5 * Math.max(1, speed)) {
        applyInput();
        game.step(TICK);
        simTime += TICK;
        dispatch();
        acc -= TICK; steps++;
      }
      if (acc > TICK * 3) acc = 0;
      if (endAt && simTime >= endAt) showEnd();
    }
    const tB = performance.now();
    if (tB - tA > worst.sim) worst.sim = tB - tA;
    const frozen = paused && !netMatch;   // a multiplayer match keeps going while you are paused
    const alpha = netMatch ? 1 : state === 'playing' && !paused ? Math.min(1, acc / TICK) : 1;
    renderTime += frozen ? 0 : dt;
    updateCamera(alpha, renderTime, dt);
    const cam = core.camera, p = game.player;
    chars.update(game, alpha, renderTime, frozen ? 0 : dt, CAM.scoped && p.alive ? p.id : -1);
    effects.update(game, renderTime, frozen ? 0 : dt, cam.position);
    world3d.userData.update(renderTime, cam.position);
    cam.getWorldDirection(fwd);
    const sr = core.shadowRange * 0.5;
    const hl = Math.hypot(fwd.x, fwd.z) || 1;
    core.updateShadow(cam.position.x + (fwd.x / hl) * sr, state === 'menu' ? 10 : p.y, cam.position.z + (fwd.z / hl) * sr);
    if (state === 'playing') hud.update(game, p.alive ? p : (game.focus || p), dt, cam, CAM);
    if (touch) touch.update(game, state === 'playing' && !paused && !endShown && p.alive);
    const zd = Math.abs(Math.hypot(p.x - game.zone.cx, p.z - game.zone.cz) - game.zone.r);
    audio.update(dt, { x: cam.position.x, y: cam.position.y, z: cam.position.z, rx: Math.cos(cam.rotation.y), rz: -Math.sin(cam.rotation.y) },
      { active: state === 'playing' && !paused && !endShown, drop: state === 'playing' && p.state === 'drop' && p.alive, outside: p.alive && p.outside, zoneDist: state === 'playing' ? zd : 999 });
    core.render(renderTime, dt);
    core.adapt(dt * 1000, dt);
    const tC = performance.now();
    if (tC - tB > worst.render) worst.render = tC - tB;
    fpsN++; fpsT += dt;
    if (fpsT >= 0.5) {
      fps = fpsN / fpsT; fpsN = 0; fpsT = 0;
      if (hud.perfOn) {
        const inf = core.renderer.info.render;
        hud.showPerf(`${fps.toFixed(0)} fps  ${core.frameMs.toFixed(1)} ms${core.gpuMs ? '  gpu ' + core.gpuMs.toFixed(1) + ' ms' : ''}\ncalls ${inf.calls}  tris ${(inf.triangles / 1000).toFixed(0)}k\nscale ${core.renderScale.toFixed(2)}  ${core.quality}\nalive ${game.alive}  t ${game.time.toFixed(0)}s`);
      }
    }
  }

  // warm every shader before the menu appears, so the first shot does not hitch
  mark('actors, effects, HUD');
  progress(92, 'Zeroing sights');
  await next();
  effects.prewarm();
  chars.group.visible = true;
  updateCamera(1, 0, 0.016);
  chars.update(game, 1, 0, 0.016, -1);
  effects.update(game, 0, 0.016, core.camera.position);
  world3d.userData.update(0, core.camera.position);
  core.updateShadow(0, 10, 0);
  try { await core.renderer.compileAsync(core.scene, core.camera); } catch (e) { /* non-fatal: programs compile on first use instead */ }
  core.render(0, 0.016);
  chars.group.visible = false;
  hud.setVisible(false);
  mark('shader warm-up');
  progress(100, 'Ready');
  await next();
  $('loading').classList.add('hidden');
  $('menu').classList.remove('hidden');

  // hooks for automated verification
  window.__lc = {
    get game() { return game; }, get state() { return state; }, get paused() { return paused; }, get endShown() { return endShown; },
    core, hud, input, world, audio, errors, chars, effects, world3d, bootTimes, lobby, get netMatch() { return netMatch; },
    start: (o) => startMatch(o), menu: toMenu,
    stats() {
      const inf = core.renderer.info.render, sorted = frameLog.slice().sort((a, b) => a - b);
      return { fps, frameMs: core.frameMs, p50: sorted[Math.floor(sorted.length * 0.5)] || 0, p95: sorted[Math.floor(sorted.length * 0.95)] || 0, calls: inf.calls, tris: inf.triangles, scale: core.renderScale, quality: core.quality, programs: core.renderer.info.programs ? core.renderer.info.programs.length : 0, audio: audio.state, gpuTimer: core.gpuTimer, gpuMs: core.gpuMs };
    },
    captureBegin() {
      if (capture.on) return;
      capture.on = true; capture.t = 0; capture.log = [];
      capture.vms = performance.now();
      performance.now = () => capture.vms;
      window.setTimeout = (fn, ms, ...a) => { const id = ++capture.tid; capture.timers.push({ id, at: capture.vms + (ms || 0), fn, a }); return id; };
      window.clearTimeout = (id) => { capture.timers = capture.timers.filter((x) => x.id !== id); };
      for (const k of Object.keys(audio)) {
        if (k === 'init' || k === 'resume' || k === 'setTime' || typeof audio[k] !== 'function') continue;
        audio[k] = (...args) => { capture.log.push([Math.round(capture.t * 10000) / 10000, k, JSON.parse(JSON.stringify(args))]); };
      }
    },
    captureStep(dt) {
      capture.t += dt; capture.vms += dt * 1000;
      for (;;) {
        capture.timers.sort((a, b) => a.at - b.at);
        if (!capture.timers.length || capture.timers[0].at > capture.vms) break;
        const tm = capture.timers.shift();
        try { tm.fn(...tm.a); } catch (e) { errors.push(String(e)); }
      }
      for (const an of document.getAnimations()) { an.pause(); an.currentTime = (Number(an.currentTime) || 0) + dt * 1000; }
      tick(dt);
      return capture.t;
    },
    get captureLog() { return capture.log; },
    get captureTime() { return capture.t; },
    resetFrameLog() { frameLog.length = 0; worst.frame = worst.sim = worst.render = 0; worst.long = 0; },
    get worst() { return { frames: frameLog.length, frameMs: +worst.frame.toFixed(1), simMs: +worst.sim.toFixed(1), renderMs: +worst.render.toFixed(1), over50ms: worst.long }; },
    evCount,
    // fast-forward the simulation (events still reach effects, HUD and audio)
    ff(sec) { const n = Math.round(sec / TICK); for (let i = 0; i < n && !game.over; i++) { applyInput(); game.step(TICK); simTime += TICK; dispatch(); } return game.time; },
    // turn the player so the crosshair (not the body) points at a world position
    aimAt(x, y, z) {
      const p = game.player;
      for (let i = 0; i < 8; i++) {
        computeCamera(game, p, p.x, p.y, p.z, CAM);
        const dx = x - CAM.x, dy = y - CAM.y, dz = z - CAM.z, l = Math.hypot(dx, dy, dz) || 1;
        p.yaw = Math.atan2(-dx, -dz); p.pitch = Math.asin(Math.max(-1, Math.min(1, dy / l)));
      }
      return { yaw: p.yaw, pitch: p.pitch };
    },
    // True cost of a frame: render, then force the GPU to finish by reading one pixel back.
    bench(n = 40) {
      const gl = core.renderer.getContext(), px = new Uint8Array(4), times = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        chars.update(game, 1, renderTime, 0.016, -1);
        effects.update(game, renderTime, 0.016, core.camera.position);
        core.render(renderTime, 0.016);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const inf = core.renderer.info.render;
      return { median: times[n >> 1], p90: times[Math.floor(n * 0.9)], min: times[0], calls: inf.calls, tris: inf.triangles, scale: core.renderScale, w: core.post.w, h: core.post.h };
    },
  };
  if (params.has('nomenu')) startMatch();
  requestAnimationFrame(frame);
}

boot().catch((e) => {
  console.error(e);
  errors.push(String(e && e.stack || e));
  $('loadmsg').textContent = 'Could not start: ' + (e && e.message ? e.message : e);
});
