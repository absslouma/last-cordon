// Records the 16:9 demo video of LAST CORDON.
// The game is stepped one frame at a time on a virtual clock (see captureBegin in src/main.js),
// each frame is saved as a 1920x1080 JPEG, the game's own sound calls are logged with their
// video time and rendered offline afterwards, and ffmpeg assembles an H.264/AAC MP4.
// Usage: node tools/video/record.mjs [out.mp4]
import puppeteer from 'puppeteer-core';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'video', 'last-cordon-demo.mp4'));
const WORK = path.join(ROOT, 'video', 'work');
const FRAMES = path.join(WORK, 'frames');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FPS = 30, DT = 1 / FPS;
const PORT = 8100 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const T0 = Date.now();

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), String(PORT), '--test'], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((res) => server.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/localhost:\d+\//); if (m) res(m[0]); }));
const LAUNCH = { executablePath: CHROME, headless: true, protocolTimeout: 180000,
  args: ['--headless=new', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] };

let frameNo = 0;
const audioLog = [];         // [videoTime, fn, args]
const problems = [];
async function save(page) {
  const buf = await page.screenshot({ type: 'jpeg', quality: 93, optimizeForSpeed: true });
  fs.writeFileSync(path.join(FRAMES, `f${String(frameNo++).padStart(5, '0')}.jpg`), buf);
}
const videoTime = () => frameNo / FPS;
function watch(page, label) {
  page.on('pageerror', (e) => problems.push(`${label}: ${String(e.stack || e).slice(0, 300)}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${label} console: ${m.text().slice(0, 300)}`); });
}

// ---------------------------------------------------------------- overlay (captions, cards, watermark)
const OVERLAY = `
  #vx-cap { position: fixed; left: 64px; bottom: 150px; z-index: 50; display: flex; align-items: stretch; gap: 16px; opacity: 0; pointer-events: none; }
  #vx-cap i { width: 5px; background: #f2a531; box-shadow: 0 0 18px rgba(242,165,49,.6); }
  #vx-cap div { background: rgba(6,9,12,.62); padding: 14px 22px 15px; }
  #vx-cap b { display: block; font: 600 34px/1.15 Bahnschrift, "Segoe UI", sans-serif; letter-spacing: .08em; text-transform: uppercase; color: #f1eee6; }
  #vx-cap span { display: block; margin-top: 6px; font: 400 19px/1.3 Bahnschrift, "Segoe UI", sans-serif; letter-spacing: .06em; color: rgba(241,238,230,.78); }
  #vx-card { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; opacity: 0; pointer-events: none;
    background: radial-gradient(ellipse at center, rgba(8,12,16,.97), rgba(4,6,8,1)); color: #ece9e1; font-family: Bahnschrift, "Segoe UI", sans-serif; }
  #vx-card h1 { margin: 0; font-size: 132px; letter-spacing: .14em; font-weight: 600; line-height: .95; }
  #vx-card h1 em { font-style: normal; color: #58c8ff; }
  #vx-card p { margin: 22px 0 0; font-size: 30px; letter-spacing: .1em; color: rgba(236,233,225,.86); }
  #vx-card .by { margin-top: 34px; font-size: 26px; letter-spacing: .3em; text-transform: uppercase; color: #f2a531; }
  #vx-card .small { margin-top: 14px; font-size: 21px; letter-spacing: .08em; color: rgba(236,233,225,.62); }
  #vx-card .url { margin-top: 26px; font-size: 30px; letter-spacing: .04em; color: #ece9e1; padding: 10px 22px; border: 1px solid rgba(236,233,225,.3); }
  #vx-mark { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 55; font: 500 15px Bahnschrift, "Segoe UI", sans-serif; letter-spacing: .22em; text-transform: uppercase; color: rgba(241,238,230,.55); text-shadow: 0 1px 2px #000; pointer-events: none; }
  #vx-fade { position: fixed; inset: 0; z-index: 70; background: #000; opacity: 0; pointer-events: none; }
`;
async function installOverlay(page, mark = true) {
  await page.evaluate((css, mark) => {
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    for (const id of ['vx-cap', 'vx-card', 'vx-fade'].concat(mark ? ['vx-mark'] : [])) { const d = document.createElement('div'); d.id = id; document.body.appendChild(d); }
    document.getElementById('vx-cap').innerHTML = '<i></i><div><b></b><span></span></div>';
    if (mark) document.getElementById('vx-mark').textContent = 'LAST CORDON  ·  © 2026 Slim ABASSI';
    window.vx = {
      cap(title, sub, o) { const c = document.getElementById('vx-cap'); c.querySelector('b').textContent = title || ''; c.querySelector('span').textContent = sub || ''; c.querySelector('span').style.display = sub ? 'block' : 'none'; c.style.opacity = o; c.style.transform = `translateX(${(1 - o) * -30}px)`; },
      card(html, o) { const c = document.getElementById('vx-card'); if (html != null && c.dataset.h !== html) { c.innerHTML = html; c.dataset.h = html; } c.style.opacity = o; },
      fade(o) { document.getElementById('vx-fade').style.opacity = o; },
      mark(o) { const m = document.getElementById('vx-mark'); if (m) m.style.opacity = o; },
    };
  }, OVERLAY, mark);
}
// fade envelope: 0 -> 1 over `inT`, hold, 1 -> 0 over `outT` before `dur`
const env = (t, dur, inT = 0.45, outT = 0.45) => Math.max(0, Math.min(1, t / inT, (dur - t) / outT));

// Runs `seconds` of video on a game page: per-frame hook, one game step, one saved frame.
async function scene(page, saveFrom, seconds, opts = {}) {
  const n = Math.round(seconds * FPS);
  for (let i = 0; i < n; i++) {
    const t = i / FPS;
    await page.evaluate((a) => {
      const L = window.__lc;
      if (a.cap !== undefined) window.vx.cap(a.cap, a.sub, a.cap ? a.capO : 0);
      window.vx.card(a.card === undefined ? null : a.card, a.card ? a.cardO : 0);
      window.vx.fade(a.fade || 0);
      L.captureStep(a.dt);
    }, {
      dt: DT, cap: opts.cap, sub: opts.sub, capO: opts.cap ? env(t - (opts.capDelay || 0.2), seconds - (opts.capDelay || 0.2) - 0.15, 0.35, 0.35) : 0,
      card: opts.card, cardO: opts.card ? (opts.cardEnv ? opts.cardEnv(t, seconds) : env(t, seconds, 0.5, 0.5)) : 0,
      fade: opts.fadeIn && t < 0.4 ? 1 - t / 0.4 : opts.fadeOut && t > seconds - 0.4 ? (t - (seconds - 0.4)) / 0.4 : 0,
    });
    if (opts.each) await opts.each(t, i);
    await save(saveFrom || page);
  }
}

try {
  // ================================================================ main game page
  log('opening the game');
  const br = await puppeteer.launch(LAUNCH);
  const page = (await br.pages())[0];
  watch(page, 'game');
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(url + '?test=1&q=high', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__lc', { timeout: 120000 });
  await installOverlay(page);
  await page.evaluate(() => {
    const L = window.__lc;
    document.getElementById('menu').classList.add('hidden');
    L.captureBegin();
    // helpers used by the scenes below
    window.V = {
      g: () => L.game,
      place(a, x, z, yaw) { const g = L.game; a.state = 'ground'; a.alive = true; a.x = x; a.z = z; a.y = g.world.heightAt(x, z); a.px = x; a.py = a.y; a.pz = z; a.vx = a.vy = a.vz = 0; a.onGround = true; if (yaw != null) a.yaw = yaw; },
      freezeAll() { for (const b of L.game.actors) if (b.ai) b.ai.frozen = true; },
      face(a, b) { return Math.atan2(-(b.x - a.x), -(b.z - a.z)); },
      target(idx, x, z, o = {}) {
        const g = L.game, b = g.actors[idx], p = g.player;
        this.place(b, x, z); b.hp = 100; b.armor = o.armor || 0; b.helmet = 0; b.yaw = this.face(b, p);
        if (o.weapon) { g.give(b, o.weapon); b.cur = ['ar', 'smg', 'sr'].indexOf(o.weapon); }
        if (o.live) { b.ai.frozen = false; b.ai.target = p; b.ai.lkX = p.x; b.ai.lkZ = p.z; b.ai.lkT = g.time; b.ai.seenT = g.time; b.ai.nerve = 1.6; b.walls = 0; }
        else { b.ai = null; b.cmd.fire = false; b.cmd.mx = 0; b.cmd.mz = 0; }
        return b;
      },
      aim(b, h) { L.aimAt(b.x, b.y + (h || 1.15), b.z); },
    };
  });

  // ---- 1. title over the island flyover
  log('scene 1: title');
  const TITLE = '<style>#vx-card{background:radial-gradient(ellipse at center, rgba(5,8,10,.45), rgba(5,8,10,.85))!important}</style><h1>LAST<br><em>CORDON</em></h1><p>A 3D battle royale built from one prompt with Claude</p><div class="by">by Slim ABASSI</div>';
  await scene(page, null, 5.2, { card: TITLE, cardEnv: (t, d) => Math.min(1, t / 0.8, (d - t) / 0.6), fadeIn: true, cap: '' });

  // ---- 2. parachute drop over the clock-tower compound
  log('scene 2: drop');
  await page.evaluate(() => {
    const L = window.__lc;
    L.start({ seed: 11, god: true });
    V.freezeAll();
    const p = L.game.player;
    p.x = -42; p.z = 70; p.y = 62; p.px = p.x; p.py = p.y; p.pz = p.z;
    p.yaw = Math.atan2(42, -70); p.pitch = -0.42;
    L.input.keys.add('KeyW');
  });
  await scene(page, null, 6.4, { cap: '20 operators. One island.', sub: 'Every model, texture and sound is generated in code', each: async (t) => {
    if (t > 5.0) await page.evaluate(() => window.__lc.input.keys.delete('KeyW'));
  } });

  // ---- 3. loot a weapon crate
  log('scene 3: loot');
  const crate = await page.evaluate(() => {
    const L = window.__lc, g = L.game, w = g.world, p = g.player;
    L.input.keys.clear();
    let best = null;
    for (const l of g.loot) {
      if (!l.alive || l.type !== 'ar' || Math.hypot(l.x, l.z) > 90) continue;
      if (Math.abs(w.heightAt(l.x, l.z) - l.y) > 0.3 || w.boxNear(l.x, l.z, 2.2)) continue;
      for (let k = 0; k < 16; k++) {
        const an = k * Math.PI / 8, x = l.x + Math.cos(an) * 5, z = l.z + Math.sin(an) * 5;
        if (w.nav[w.navCell(x, z)] || Math.abs(w.heightAt(x, z) - l.y) > 0.5 || w.blocked(x, l.y + 1, z, l.x, l.y + 0.6, l.z)) continue;
        best = { id: l.id, x: l.x, z: l.z, px: x, pz: z }; break;
      }
      if (best) break;
    }
    if (!best) return null;
    V.place(p, best.px, best.pz, Math.atan2(-(best.x - best.px), -(best.z - best.pz)));
    p.pitch = -0.16;
    return best;
  });
  if (!crate) throw new Error('no reachable weapon crate near the compound');
  await scene(page, null, 0.6, { cap: '' });
  await page.evaluate(() => window.__lc.input.keys.add('KeyW'));
  await scene(page, null, 4.2, { cap: 'Loot the island', sub: 'Three weapons, armour, medkits and supplies', each: async (t) => {
    if (t > 1.6) await page.evaluate(() => window.__lc.input.keys.delete('KeyW'));
  } });

  // ---- 4. firefight in the compound
  log('scene 4: firefight');
  await page.evaluate(() => {
    const L = window.__lc, g = L.game, p = g.player;
    L.input.keys.clear();
    if (!p.weapons[0]) g.give(p, 'ar');
    p.cur = 0; p.weapons[0].mag = 30; p.reserve[0] = 180;
    V.place(p, -6, 30, 0); p.pitch = 0;
    window.T1 = V.target(3, -3.5, 13.5, { armor: 60 });
    window.T2 = V.target(4, 7, 16);
    V.aim(T1);
  });
  await scene(page, null, 7.4, { cap: 'Fast hitscan gunplay', sub: 'Hitmarkers, damage numbers, headshots, a live kill feed', each: async (t) => {
    await page.evaluate((t) => {
      const L = window.__lc, p = L.game.player;
      const tg = T1.alive ? T1 : T2.alive ? T2 : null;
      // T2 strafes so the shots have to track it
      if (T2.alive) { T2.cmd.mx = Math.sin(t * 2.2) > 0 ? 1 : -1; T2.cmd.mz = 0; T2.ai = null; }
      if (tg) V.aim(tg, tg === T1 ? 1.62 : 1.2);
      const burst = (t > 0.7 && t < 1.6) || (t > 2.1 && t < 2.9) || (t > 3.4 && t < 4.6) || (t > 5.0 && t < 6.0);
      L.input.lmb = !!tg && burst;
    }, t);
  } });
  await page.evaluate(() => { window.__lc.input.lmb = false; window.__lc.input.rmb = false; });

  // ---- 5. the Bulwark under fire
  log('scene 5: bulwark');
  await page.evaluate(() => {
    const L = window.__lc, g = L.game, p = g.player;
    V.place(p, -14, 26, 0); p.pitch = 0.02; p.cur = 0; p.weapons[0].mag = 30;
    window.T3 = V.target(5, -12, 4, { weapon: 'ar', live: true, armor: 100 });
    T3.hp = 100;
    p.yaw = V.face(p, T3);
  });
  await scene(page, null, 6.6, { cap: 'The Bulwark', sub: 'Throw up an instant energy wall. Bots use it too', each: async (t, i) => {
    await page.evaluate((t) => {
      const L = window.__lc, p = L.game.player;
      if (Math.abs(t - 0.5) < 0.02) L.input.edges.add('KeyG');
      p.yaw = V.face(p, T3); p.pitch = 0.03;
      if (T3.ai) { T3.ai.frozen = false; }
    }, t);
  } });

  // ---- 6. scoped sniper headshot on the beach
  log('scene 6: sniper');
  const snipe = await page.evaluate(() => {
    const L = window.__lc, g = L.game, w = g.world, p = g.player;
    for (const b of g.walls) b.life = 0.01;
    if (!p.weapons[2]) g.give(p, 'sr');
    p.cur = 2; p.weapons[2].mag = 5;
    const px = -128, pz = 196;
    for (let k = 0; k < 24; k++) {
      const an = 0.9 + (k % 2 ? 1 : -1) * Math.floor((k + 1) / 2) * 0.12;
      const d = 62, x = px - Math.sin(an) * d, z = pz - Math.cos(an) * d;
      const h = w.heightAt(x, z);
      if (h < 0.8 || w.nav[w.navCell(x, z)]) continue;
      if (w.blocked(px, w.heightAt(px, pz) + 1.6, pz, x, h + 1.4, z) || w.blocked(px, w.heightAt(px, pz) + 1.9, pz, x, h + 1.7, z)) continue;
      V.place(p, px, pz, an); p.pitch = 0;
      window.T4 = V.target(6, x, z);
      return { an, x, z };
    }
    return null;
  });
  if (!snipe) throw new Error('no clear sniper line on the beach');
  await scene(page, null, 5.6, { cap: 'Scoped sniper', sub: 'One heavy round. Headshots count double', each: async (t) => {
    await page.evaluate((t) => {
      const L = window.__lc;
      if (T4.alive) V.aim(T4, 1.63);
      L.input.rmb = t > 0.9 && t < 4.4;
      L.input.lmb = t > 2.4 && t < 2.5;
    }, t);
  } });
  await page.evaluate(() => { window.__lc.input.lmb = false; window.__lc.input.rmb = false; });

  // ---- 7. the Cordon closing
  log('scene 7: cordon');
  await page.evaluate(() => {
    const L = window.__lc, g = L.game, w = g.world, p = g.player;
    const n0 = L.captureLog.length;
    L.ff(Math.max(0, 118 - g.time));             // into the first shrink
    L.captureLog.length = n0;                    // the fast-forward itself is silent
    g.events.length = 0;
    const z = g.zone;
    for (let k = 0; k < 72; k++) {
      const an = (k / 72) * Math.PI * 2, r = z.r + 9;
      const x = z.cx + Math.cos(an) * r, zz = z.cz + Math.sin(an) * r;
      const ix = z.cx + Math.cos(an) * (z.r - 14), iz = z.cz + Math.sin(an) * (z.r - 14);
      if (w.heightAt(x, zz) < 2 || w.heightAt(ix, iz) < 2 || w.nav[w.navCell(x, zz)] || w.blocked(x, w.heightAt(x, zz) + 1.5, zz, ix, w.heightAt(ix, iz) + 1.5, iz)) continue;
      V.place(p, x, zz, Math.atan2(-(z.cx - x), -(z.cz - zz))); p.pitch = 0.04; p.hp = 100;
      break;
    }
    L.input.keys.add('KeyW');
  });
  await scene(page, null, 6.4, { cap: 'The Cordon closes in', sub: 'Every match ends within 5 to 8 minutes', each: async (t) => {
    await page.evaluate((t) => { const p = window.__lc.game.player; p.hp = Math.max(p.hp, 60); if (t > 0.3 && t < 2.6) window.__lc.input.keys.delete('KeyW'); else if (t >= 2.6) window.__lc.input.keys.add('KeyW'); }, t);
  } });
  await page.evaluate(() => window.__lc.input.keys.clear());
  const mainBreak = await page.evaluate(() => window.__lc.captureTime);
  const videoBreak = videoTime();
  log(`main part A: ${videoBreak.toFixed(1)} s`);

  // ================================================================ phone segment
  log('scene 8: phone');
  const pb = await puppeteer.launch(LAUNCH);
  const ph = (await pb.pages())[0];
  watch(ph, 'phone');
  await ph.setViewport({ width: 960, height: 540, deviceScaleFactor: 2, hasTouch: true });
  await ph.goto(url + 'tools/video/phone.html', { waitUntil: 'load' });
  const fh = await ph.$('#game');
  const gf = await fh.contentFrame();
  await gf.waitForFunction('window.__lc', { timeout: 120000 });
  await installOverlay(ph, true);
  await ph.evaluate(() => { const c = document.getElementById('vx-cap'); c.style.left = '40px'; c.style.bottom = '22px'; c.style.transform = 'scale(.5)'; c.style.transformOrigin = 'left bottom'; });
  await gf.evaluate(() => {
    const L = window.__lc;
    L.captureBegin();
    L.start({ seed: 5, god: true });
    const g = L.game, p = g.player, w = g.world;
    for (const b of g.actors) if (b.ai) b.ai.frozen = true;
    const place = (a, x, z, yaw) => { a.state = 'ground'; a.alive = true; a.x = x; a.z = z; a.y = w.heightAt(x, z); a.px = x; a.py = a.y; a.pz = z; a.vx = a.vy = a.vz = 0; a.onGround = true; if (yaw != null) a.yaw = yaw; };
    place(p, -122, 194, 0.9); p.pitch = 0.02;
    g.give(p, 'ar'); g.give(p, 'smg'); p.cur = 0; p.medkits = 2;
    const t = g.actors[7]; place(t, -122 - Math.sin(0.9) * 16, 194 - Math.cos(0.9) * 16, 0.9 + Math.PI); t.ai = null; t.hp = 100; t.armor = 40;
    window.PT = t;
  });
  for (let k = 0; k < 4; k++) await gf.evaluate(() => window.__lc.captureStep(1 / 30));
  const box = await fh.boundingBox();           // iframe position inside the 960x540 page
  const cdp = await ph.target().createCDPSession();
  const fingers = new Map();
  const touchSend = (type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [...fingers.values()] });
  const thumb = (id, x, y, on) => ph.evaluate((a) => { const e = document.getElementById(a.id); e.style.left = a.x + 'px'; e.style.top = a.y + 'px'; e.style.opacity = a.on ? 1 : 0; }, { id: 't' + id, x, y, on });
  const fireBtn = await gf.evaluate(() => {
    if (document.getElementById('tc').classList.contains('drop') || document.getElementById('tc').classList.contains('hidden')) throw new Error('phone controls not visible yet'); const r = document.getElementById('tc-fire').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const wallBtn = await gf.evaluate(() => { const r = document.querySelector('#tc .tcb[data-a="wall"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const S = { x: box.x + 150, y: box.y + 300 };
  const phoneStart = videoTime();
  const n = Math.round(6.4 * FPS);
  for (let i = 0; i < n; i++) {
    const t = i / FPS;
    // left thumb: walk forward, then strafe; right thumb: hold fire; then tap the wall
    if (i === 8) { fingers.set(1, { id: 1, x: S.x, y: S.y }); await touchSend('touchStart'); }
    if (i > 8 && i < 140) { const f = fingers.get(1); f.x = S.x + (t > 2.6 ? 34 * Math.sin((t - 2.6) * 3) : 0); f.y = S.y - Math.min(30, (i - 8) * 3); await touchSend('touchMove'); }
    if (i === 140) { fingers.delete(1); await touchSend(fingers.size ? 'touchMove' : 'touchEnd'); }
    if (i === 30) { fingers.set(2, { id: 2, x: box.x + fireBtn.x, y: box.y + fireBtn.y }); await touchSend('touchMove'); }
    if (i === 110) { fingers.delete(2); await touchSend(fingers.size ? 'touchMove' : 'touchEnd'); }
    if (i === 150) { fingers.set(3, { id: 3, x: box.x + wallBtn.x, y: box.y + wallBtn.y }); await touchSend(fingers.size > 1 ? 'touchMove' : 'touchStart'); }
    if (i === 154) { fingers.delete(3); await touchSend(fingers.size ? 'touchMove' : 'touchEnd'); }
    const f1 = fingers.get(1), f2 = fingers.get(2), f3 = fingers.get(3);
    await thumb(1, f1 ? f1.x : 0, f1 ? f1.y : 0, !!f1);
    await thumb(2, f2 ? f2.x : f3 ? f3.x : 0, f2 ? f2.y : f3 ? f3.y : 0, !!(f2 || f3));
    await gf.evaluate(() => { const L = window.__lc; if (window.PT.alive) L.aimAt(PT.x, PT.y + 1.2, PT.z); L.captureStep(1 / 30); });
    await ph.evaluate((o) => { window.vx.cap('Plays on phones', 'Touch controls: move, aim, fire, wall, heal', o); }, env(t - 0.2, 6.2, 0.35, 0.35));
    await save(ph);
  }
  const phoneLog = await gf.evaluate(() => window.__lc.captureLog);
  for (const [t, fn, args] of phoneLog) audioLog.push([phoneStart + t, fn, args]);
  await pb.close();

  // ================================================================ multiplayer room filling up
  log('scene 9: lobby');
  const lb = await puppeteer.launch(LAUNCH);
  const lp = (await lb.pages())[0];
  watch(lp, 'lobby');
  await lp.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await lp.goto(url + '?test=1&q=high', { waitUntil: 'load' });
  await lp.waitForFunction('window.__lc', { timeout: 120000 });
  await installOverlay(lp);
  await lp.evaluate(() => { document.getElementById('menu').classList.add('hidden'); document.getElementById('multi').click(); });
  await lp.waitForFunction('document.getElementById("mpstatus").textContent.includes("Connected")', { timeout: 10000 });
  await lp.evaluate(() => {
    const i = document.getElementById('mpname'); i.value = 'Slim'; i.dispatchEvent(new Event('change'));
    document.getElementById('mproomname').value = 'Friday Night';
  });
  await sleep(200);
  await lp.evaluate(() => document.getElementById('mpcreate').click());
  await lp.waitForFunction('window.__lc.lobby.view === "room"', { timeout: 10000 });
  await lp.evaluate(() => { document.getElementById('vx-cap').style.bottom = '58px'; document.querySelector('#room .mpbox').style.marginBottom = '90px'; document.querySelector('#room .mpbox').style.transform = 'scale(1.7)'; document.querySelector('#room .mpbox').style.transformOrigin = 'center'; window.__lc.captureBegin(); });
  const roomId = await lp.evaluate(() => window.__lc.lobby.room.id);
  const TAGS = ['Raptor', 'N0va', 'Ghost_07', 'Kaiser', 'Viper', 'Echo', 'Blitz', 'Orion', 'Mirage', 'Talon', 'Frost', 'Havoc', 'Zephyr', 'Onyx', 'Rogue', 'Saber', 'Atlas', 'Jinx', 'Nomad'];
  const raws = [];
  const lobbyStart = videoTime();
  const LN = Math.round(4.8 * FPS);
  for (let i = 0; i < LN; i++) {
    if (i >= 6 && (i - 6) % 4 === 0 && raws.length < TAGS.length) {
      const ws = new WebSocket(url.replace('http', 'ws') + 'ws');
      const nm = TAGS[raws.length];
      ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', name: nm })); ws.send(JSON.stringify({ t: 'join', id: roomId })); };
      raws.push(ws);
      audioLog.push([lobbyStart + i / FPS + 0.05, 'ui', ['tick']]);
    }
    await sleep(12);
    await lp.evaluate((o) => { window.vx.cap('LAN multiplayer', 'Create a room. Up to 20 friends on the same Wi-Fi', o); window.__lc.captureStep(1 / 30); }, env(i / FPS - 0.2, 4.6, 0.35, 0.35));
    await save(lp);
  }
  for (const ws of raws) try { ws.close(); } catch (e) { /* closed */ }
  await lb.close();

  // ================================================================ back to the match: victory, end card
  log('scene 10: victory');
  await page.evaluate(() => {
    const L = window.__lc, g = L.game, p = g.player;
    V.place(p, -6, 30, 0.4); p.pitch = 0.05; p.cur = 0;
    p.kills = Math.max(p.kills, 7);
    for (const x of g.actors) if (x !== p && x.alive) g._kill(x, p, 0, x.id % 3 === 0 ? 'head' : 'body');
  });
  await scene(page, null, 5.0, { cap: '' });
  log('scene 11: end card');
  const END = `<h1>LAST<br><em>CORDON</em></h1><div class="by">Created by Slim ABASSI</div><div class="small">Built with Claude (Anthropic) in Claude Code</div><div class="url">github.com/absslouma/last-cordon</div><div class="small">© 2026 Slim ABASSI · All rights reserved</div>`;
  await page.evaluate(() => window.vx.mark(0));
  await scene(page, null, 5.6, { card: END, cardEnv: (t) => Math.min(1, t / 0.7), fadeOut: true, cap: '' });

  // game audio: part A as recorded, part B shifted past the phone and lobby segments
  const mainLog = await page.evaluate(() => window.__lc.captureLog);
  const inserted = videoTime() - videoBreak - (await page.evaluate(() => window.__lc.captureTime) - mainBreak);
  for (const [t, fn, args] of mainLog) audioLog.push([t <= mainBreak ? t : t + inserted, fn, args]);
  const duration = frameNo / FPS;
  log(`${frameNo} frames, ${duration.toFixed(1)} s of video, ${audioLog.length} sound calls`);

  // ================================================================ render the soundtrack offline
  log('rendering audio');
  const audioPage = await br.newPage();
  await audioPage.goto(url + 'index.html?test=1', { waitUntil: 'domcontentloaded' });
  const wavB64 = await audioPage.evaluate(async (entries, dur) => {
    const { createAudio } = await import('/src/audio.js');
    const SR = 48000, ctx = new OfflineAudioContext(2, Math.ceil(SR * (dur + 0.5)), SR);
    const a = createAudio({ ctx });
    a.init();
    entries.sort((x, y) => x[0] - y[0]);
    for (const [t, fn, args] of entries) {
      if (typeof a[fn] !== 'function' || fn === 'silence') continue;
      a.setTime(Math.max(0.001, t));
      try { a[fn](...args); } catch (e) { /* one bad call does not sink the track */ }
    }
    // a low trailer drone under the whole cut, swelling on the title and end cards
    const drone = ctx.createGain(); drone.connect(ctx.destination);
    drone.gain.setValueAtTime(0.0001, 0); drone.gain.exponentialRampToValueAtTime(0.09, 1.2);
    drone.gain.setValueAtTime(0.09, 4.6); drone.gain.exponentialRampToValueAtTime(0.035, 6);
    drone.gain.setValueAtTime(0.035, dur - 6.5); drone.gain.exponentialRampToValueAtTime(0.1, dur - 4.8); drone.gain.exponentialRampToValueAtTime(0.0001, dur);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420; lp.connect(drone);
    for (const [f, ty, g] of [[55, 'sawtooth', 0.45], [55.4, 'sawtooth', 0.45], [82.4, 'triangle', 0.5], [110, 'sine', 0.3]]) {
      const o = ctx.createOscillator(); o.type = ty; o.frequency.value = f; const og = ctx.createGain(); og.gain.value = g; o.connect(og); og.connect(lp); o.start(0); o.stop(dur + 0.4);
    }
    for (const t of [0.15, dur - 5.6]) { // sub hits on the cards
      const o = ctx.createOscillator(); o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(32, t + 1.4);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      o.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 1.7);
    }
    const buf = await ctx.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1), N = buf.length;
    let peak = 1e-6; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    const k = Math.min(4, 0.89 / peak);
    const out = new DataView(new ArrayBuffer(44 + N * 4));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); out.setUint32(4, 36 + N * 4, true); w(8, 'WAVE'); w(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 2, true);
    out.setUint32(24, SR, true); out.setUint32(28, SR * 4, true); out.setUint16(32, 4, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, N * 4, true);
    for (let i = 0; i < N; i++) { out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i] * k)) * 32767, true); out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i] * k)) * 32767, true); }
    const bytes = new Uint8Array(out.buffer);
    let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, audioLog, duration);
  fs.writeFileSync(path.join(WORK, 'audio.wav'), Buffer.from(wavB64, 'base64'));
  await br.close();

  // ================================================================ encode
  log('encoding MP4');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(FRAMES, 'f%05d.jpg'), '-i', path.join(WORK, 'audio.wav'),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-maxrate', '12M', '-bufsize', '24M', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1', '-r', String(FPS),
    '-af', 'loudnorm=I=-15:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-shortest', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
  log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB)`);
} catch (e) {
  problems.push('recorder: ' + String(e.stack || e).slice(0, 800));
}
if (problems.length) { console.log(`${problems.length} problem(s):`); for (const p of problems.slice(0, 20)) console.log('  ' + p); }
server.kill();
process.exit(problems.length ? 1 : 0);
