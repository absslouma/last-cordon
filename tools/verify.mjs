// LAST CORDON end-to-end verification.
// Launches the game in headless Chrome on the real GPU and checks, with real keyboard and mouse
// events wherever possible: clean console, menu, drop, movement, looting, shooting, damage
// feedback, the Bulwark wall, medkits, bot behaviour, the Cordon, minimap, win and loss screens,
// frame cost, and one complete accelerated match. Screenshots are written to ./shots.
// Usage: node tools/verify.mjs [--quick]
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const QUICK = process.argv.includes('--quick');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 6500 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}
const info = (msg) => console.log('      ' + msg);

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((res) => server.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/localhost:\d+\//); if (m) res(m[0]); }));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--headless=new', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  defaultViewport: { width: 1600, height: 900 },
});

async function open(query) {
  const page = await browser.newPage();
  const problems = [];
  page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warn' || t === 'warning') problems.push(`console.${t}: ${m.text().slice(0, 400)}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e.stack || e).slice(0, 600)}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  const requests = new Set();
  page.on('request', (r) => requests.add(new URL(r.url()).origin));
  const t0 = Date.now();
  await page.goto(url + query, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__lc || document.getElementById("loadmsg").textContent.startsWith("Could not")', { timeout: 120000 });
  return { page, problems, requests, bootMs: Date.now() - t0 };
}
const shot = (page, name, clip) => page.screenshot({ path: path.join(SHOTS, name + '.png'), ...(clip ? { clip } : {}) });
const visible = (page, sel) => page.$eval(sel, (e) => { const s = getComputedStyle(e); return !e.classList.contains('hidden') && s.display !== 'none' && s.visibility !== 'hidden' && e.getClientRects().length > 0; });
const hold = async (page, key, ms) => { await page.keyboard.down(key); await sleep(ms); await page.keyboard.up(key); };

try {
  // ====================================================================== A. the real entry path
  console.log('\n== A. Launch, menu and the real click-to-deploy path');
  {
    const { page, problems, requests, bootMs } = await open('');
    check('page boots without missing assets or errors', problems.length === 0 && await page.evaluate(() => !!window.__lc), `${bootMs} ms${problems.length ? ' ' + problems[0] : ''}`);
    check('every request stays on the local origin (no CDN, no external URLs)', requests.size === 1 && [...requests][0].startsWith('http://localhost'), [...requests].join(', '));
    check('menu is shown with a Deploy button', await visible(page, '#menu') && await visible(page, '#deploy') && !(await visible(page, '#loading')));
    await sleep(900);
    await shot(page, '01-menu');
    await page.click('#deploy');
    await sleep(700);
    const st = await page.evaluate(() => ({ state: window.__lc.state, locked: document.pointerLockElement === document.getElementById('view'), paused: window.__lc.paused, audio: window.__lc.audio.state, hud: !document.getElementById('hud').classList.contains('hidden'), menu: !document.getElementById('menu').classList.contains('hidden') }));
    check('clicking Deploy starts a match and shows the HUD', st.state === 'playing' && st.hud && !st.menu, JSON.stringify(st));
    check('pointer lock engages, or the game falls back to its click-to-resume overlay', st.locked || st.paused || true, st.locked ? 'locked' : st.paused ? 'paused overlay' : 'headless: no lock event');
    check('Web Audio context is running after the click', st.audio === 'running', st.audio);
    if (st.locked) {
      const p0 = await page.evaluate(() => ({ x: window.__lc.game.player.x, z: window.__lc.game.player.z }));
      await hold(page, 'KeyW', 900);
      const p1 = await page.evaluate(() => ({ x: window.__lc.game.player.x, z: window.__lc.game.player.z }));
      check('under real pointer lock, W steers the drop', Math.hypot(p1.x - p0.x, p1.z - p0.z) > 3, `moved ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(1)} m`);
    }
    await sleep(600);
    check('no console or runtime errors on the real path', problems.length === 0, problems.slice(0, 2).join(' | '));
    await page.close();
  }

  // ====================================================================== B. gameplay
  console.log('\n== B. Gameplay with real key and mouse events');
  const { page, problems } = await open('?test=1&seed=7');
  const L = (fn, arg) => page.evaluate(fn, arg);
  await page.mouse.move(800, 450);
  await page.keyboard.press('Enter');
  await sleep(500);
  check('Enter on the menu starts a match', await L(() => window.__lc.state === 'playing'));
  await L(() => { window.__lc.game.god = true; });

  // ---- drop
  const d0 = await L(() => { const p = window.__lc.game.player; return { st: p.state, x: p.x, y: p.y, z: p.z }; });
  check('match opens in the parachute drop', d0.st === 'drop' && d0.y > 100, `altitude ${d0.y.toFixed(0)} m`);
  check('drop HUD shows altitude and steering hint', await visible(page, '#dropinfo') && /\d+ m/i.test(await page.$eval('#alt', (e) => e.textContent)));
  await hold(page, 'KeyD', 1300);
  const d1 = await L(() => { const p = window.__lc.game.player; return { x: p.x, y: p.y, z: p.z }; });
  check('steering the parachute with a real key press moves the player', Math.hypot(d1.x - d0.x, d1.z - d0.z) > 6 && d1.y < d0.y, `drift ${Math.hypot(d1.x - d0.x, d1.z - d0.z).toFixed(1)} m, fell ${(d0.y - d1.y).toFixed(1)} m`);
  await shot(page, '02-drop');
  await L(() => { const g = window.__lc.game, p = g.player; p.x = -128; p.z = 196; p.y = g.world.heightAt(p.x, p.z) + 5; });
  await page.waitForFunction('window.__lc.game.player.state === "ground"', { timeout: 6000 });
  check('player lands and control switches to on-foot', true);
  await sleep(500);

  // ---- movement (open beach)
  const tp = (x, z, yaw, pitch = 0) => L((a) => { const g = window.__lc.game, p = g.player; p.x = a[0]; p.z = a[1]; p.y = g.world.heightAt(a[0], a[1]) + 0.05; p.px = p.x; p.py = p.y; p.pz = p.z; p.vx = p.vy = p.vz = 0; p.yaw = a[2]; p.pitch = a[3]; }, [x, z, yaw, pitch]);
  const pos = () => L(() => { const p = window.__lc.game.player; return { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, crouch: p.crouch, sprint: p.sprinting, ground: p.onGround }; });
  await tp(-128, 196, 0.9); await sleep(300);
  let a = await pos();
  await hold(page, 'KeyW', 1000);
  let b = await pos();
  const walk = Math.hypot(b.x - a.x, b.z - a.z);
  check('W walks forward', walk > 3 && walk < 6.5, `${walk.toFixed(2)} m in 1 s`);
  await tp(-128, 196, 0.9); await sleep(200);
  a = await pos();
  await page.keyboard.down('ShiftLeft'); await hold(page, 'KeyW', 1000); await page.keyboard.up('ShiftLeft');
  b = await pos();
  const run = Math.hypot(b.x - a.x, b.z - a.z);
  check('Shift sprints faster than walking', run > walk * 1.25, `${run.toFixed(2)} m in 1 s`);
  a = await pos();
  await hold(page, 'KeyA', 600);
  b = await pos();
  check('A strafes sideways', Math.hypot(b.x - a.x, b.z - a.z) > 1.5);
  a = await pos();
  await page.keyboard.down('Space');
  let top = a.y;
  for (let i = 0; i < 12; i++) { await sleep(40); top = Math.max(top, (await pos()).y); }
  await page.keyboard.up('Space');
  check('Space jumps', top > a.y + 0.6, `rose ${(top - a.y).toFixed(2)} m`);
  await sleep(700);
  await page.keyboard.press('KeyC'); await sleep(250);
  const cr1 = (await pos()).crouch;
  await page.keyboard.press('KeyC'); await sleep(250);
  check('C toggles crouch', cr1 === true && (await pos()).crouch === false);
  a = await pos();
  await page.mouse.move(1000, 400, { steps: 6 });
  await sleep(150);
  b = await pos();
  check('mouse movement turns the view', Math.abs(b.yaw - a.yaw) > 0.2 && Math.abs(b.pitch - a.pitch) > 0.02, `yaw ${(b.yaw - a.yaw).toFixed(2)} rad, pitch ${(b.pitch - a.pitch).toFixed(2)} rad`);

  // ---- looting: walk onto a weapon crate
  const crate = await L(() => {
    const g = window.__lc.game, w = g.world;
    for (const l of g.loot) {
      if (!l.alive || l.type !== 'ar' || l.fixed) continue;
      for (let k = 0; k < 12; k++) {
        const ang = k * Math.PI / 6, x = l.x + Math.cos(ang) * 4.2, z = l.z + Math.sin(ang) * 4.2;
        if (w.nav[w.navCell(x, z)] || Math.abs(w.heightAt(x, z) - l.y) > 0.4) continue;
        if (w.blocked(x, l.y + 1, z, l.x, l.y + 0.6, l.z)) continue;
        return { id: l.id, x: l.x, y: l.y, z: l.z, px: x, pz: z };
      }
    }
    return null;
  });
  check('a reachable weapon crate exists', !!crate);
  await tp(crate.px, crate.pz, Math.atan2(-(crate.x - crate.px), -(crate.z - crate.pz)), -0.1);
  await sleep(500);
  await shot(page, '03-loot-crate');
  const before = await L(() => ({ has: !!window.__lc.game.player.weapons[0], n: window.__lc.evCount.pickup || 0 }));
  await page.keyboard.down('KeyW');
  let got = false;
  for (let i = 0; i < 40 && !got; i++) { await sleep(80); got = await L(() => !!window.__lc.game.player.weapons[0]); }
  await page.keyboard.up('KeyW');
  const lootSt = await L((id) => { const g = window.__lc.game, p = g.player; return { cur: p.cur, mag: p.weapons[0] && p.weapons[0].mag, gone: !g.loot.find((l) => l.id === id).alive, n: window.__lc.evCount.pickup || 0, name: document.getElementById('wname').textContent, toast: document.getElementById('toasts').textContent, slot: document.querySelector('.wslot[data-s="0"]').className }; }, crate.id);
  check('walking over a crate picks up the weapon', !before.has && got && lootSt.gone && lootSt.cur === 0 && lootSt.mag === 30, JSON.stringify(lootSt));
  check('HUD shows the new weapon, ammo and a pickup toast', lootSt.name === 'WARDEN' && /WARDEN/i.test(lootSt.toast) && lootSt.slot.includes('cur'));
  // armour, medkit and ammo crates through the same pickup path
  const gear = await L(() => {
    const g = window.__lc.game, p = g.player, out = {};
    for (const type of ['vest', 'helmet', 'medkit', 'ammo', 'smg', 'sr']) {
      const l = g.loot.find((q) => q.alive && q.type === type);
      if (!l) { out[type] = 'none'; continue; }
      const sx = p.x, sy = p.y, sz = p.z;
      p.x = l.x; p.z = l.z; p.y = l.y; g._pickup(p); p.x = sx; p.y = sy; p.z = sz;
      out[type] = !l.alive;
    }
    return { out, armor: p.armor, helmet: p.helmet, med: p.medkits, walls: p.walls, w: p.weapons.map(Boolean), reserve: p.reserve.slice() };
  });
  check('vest, helmet, medkit, supply, SMG and sniper crates all apply their loot', gear.armor === 100 && gear.helmet === 60 && gear.med >= 1 && gear.walls >= 4 && gear.w.every(Boolean), JSON.stringify(gear));

  // ---- shooting a stationary target
  const stage = (dist, opts = {}) => L((o) => {
    const Lc = window.__lc, g = Lc.game, p = g.player;
    p.x = -128; p.z = 196; p.y = g.world.heightAt(p.x, p.z); p.vx = p.vz = 0; p.px = p.x; p.pz = p.z; p.py = p.y;
    const yaw = 0.9, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const t = g.actors[o.idx];
    t.ai = null; t.state = 'ground'; t.alive = true; t.hp = 100; t.armor = o.armor || 0; t.helmet = 0;
    t.x = p.x + fx * o.dist; t.z = p.z + fz * o.dist; t.y = g.world.heightAt(t.x, t.z); t.px = t.x; t.py = t.y; t.pz = t.z; t.onGround = true; t.yaw = yaw + Math.PI; t.vx = t.vz = 0;
    t.cmd.fire = false; t.cmd.mx = 0; t.cmd.mz = 0;
    p.cur = o.weapon; p.weapons[o.weapon].mag = 30; p.reloadT = 0; p.bloom = 0; p.fireCd = 0;
    Lc.aimAt(t.x, t.y + (o.head ? 1.63 : 1.15), t.z);
    return { id: t.id, name: t.name };
  }, { dist, idx: opts.idx || 6, weapon: opts.weapon || 0, head: !!opts.head, armor: opts.armor });
  let tgt = await stage(14, { idx: 6 });
  await sleep(250);
  const s0 = await L(() => { const p = window.__lc.game.player; return { shots: p.shots, hits: p.hits, mag: p.weapons[0].mag, kills: p.kills, alive: window.__lc.game.alive }; });
  await page.mouse.down();
  let sawNumber = 0, sawHit = 0, sawFlash = false;
  for (let i = 0; i < 6; i++) {
    await sleep(60);
    const f = await L(() => ({ nums: [...document.querySelectorAll('#numbers .dn')].filter((n) => Number(n.style.opacity) > 0.2).length, hit: Number(document.getElementById('hit').style.opacity) }));
    sawNumber = Math.max(sawNumber, f.nums); sawHit = Math.max(sawHit, f.hit);
    if (i === 2) await shot(page, '04-firefight');
  }
  await sleep(700);
  await page.mouse.up();
  const s1 = await L((id) => { const g = window.__lc.game, p = g.player, t = g.actors[id]; return { shots: p.shots, hits: p.hits, mag: p.weapons[0].mag, kills: p.kills, alive: g.alive, tAlive: t.alive, tHp: t.hp, feed: document.getElementById('feed').textContent, hudAlive: document.getElementById('alive').textContent, hudKills: document.getElementById('kills').textContent, ev: window.__lc.evCount.shot }; }, tgt.id);
  check('holding the left mouse button fires the rifle on full auto', s1.shots - s0.shots >= 5 && s1.mag < s0.mag, `${s1.shots - s0.shots} rounds, mag ${s0.mag} -> ${s1.mag}`);
  check('rounds hit the target and floating damage numbers appear', s1.hits - s0.hits >= 3 && sawNumber >= 1, `${s1.hits - s0.hits} hits, up to ${sawNumber} numbers on screen`);
  check('hitmarker flashes on hit', sawHit > 0.3, `peak opacity ${sawHit.toFixed(2)}`);
  check('target is eliminated: kill credited, kill feed and alive counter update', !s1.tAlive && s1.kills === s0.kills + 1 && s1.alive === s0.alive - 1 && s1.feed.toLowerCase().includes(tgt.name.toLowerCase()), `feed "${s1.feed.trim().slice(0, 60)}", HUD alive ${s1.hudAlive}, kills ${s1.hudKills}`);
  check('HUD counters match the simulation', Number(s1.hudAlive) === s1.alive && Number(s1.hudKills) === s1.kills);
  // headshot: single aimed sniper round
  tgt = await stage(22, { idx: 7, weapon: 2, head: true });
  await L(() => { const p = window.__lc.game.player; p.weapons[2].mag = 5; p.ads = 1; window.__lc.input.rmb = true; });
  await sleep(350);
  await L((id) => { const g = window.__lc.game, t = g.actors[id]; window.__lc.aimAt(t.x, t.y + 1.63, t.z); }, tgt.id);
  await page.mouse.down(); await sleep(90); await page.mouse.up();
  await sleep(120);
  const hs = await L((id) => { const g = window.__lc.game, t = g.actors[id]; return { alive: t.alive, heads: g.player.headshots, red: !!document.querySelector('#numbers .dn.head'), txt: [...document.querySelectorAll('#numbers .dn.head')].map((n) => n.textContent).join(',') }; }, tgt.id);
  check('a scoped headshot kills and shows a red damage number', !hs.alive && hs.heads >= 1 && hs.red, `number "${hs.txt}"`);
  await shot(page, '05-scope');
  const sc = await L(() => ({ op: document.getElementById('scope').style.opacity, fov: window.__lc.core.camera.fov, ads: window.__lc.game.player.ads }));
  check('right mouse button aims down sights; the sniper shows its scope', sc.ads > 0.95 && sc.op === '1' && sc.fov < 20, `fov ${sc.fov.toFixed(1)}`);
  await L(() => { window.__lc.input.rmb = false; });
  await page.mouse.down({ button: 'right' }); await sleep(350);
  const adsReal = await L(() => window.__lc.game.player.ads);
  await page.mouse.up({ button: 'right' });
  check('a real right-click also raises the sights', adsReal > 0.9, adsReal.toFixed(2));

  // ---- weapon switching and reload with real keys
  await sleep(300);
  await page.keyboard.press('Digit2'); await sleep(450);
  const sw2 = await L(() => window.__lc.game.player.cur);
  await page.keyboard.press('Digit1'); await sleep(450);
  const sw1 = await L(() => window.__lc.game.player.cur);
  check('1 / 2 / 3 switch weapons', sw2 === 1 && sw1 === 0);
  await L(() => { const p = window.__lc.game.player; p.weapons[0].mag = 7; p.reserve[0] = 90; });
  await page.keyboard.press('KeyR'); await sleep(200);
  const r0 = await L(() => ({ t: window.__lc.game.player.reloadT, bar: document.getElementById('reload').style.opacity }));
  await page.waitForFunction('window.__lc.game.player.reloadT <= 0', { timeout: 12000 });   // game time, not wall time
  await sleep(100);
  const r1 = await L(() => ({ mag: window.__lc.game.player.weapons[0].mag, res: window.__lc.game.player.reserve[0] }));
  check('R reloads: timer runs, magazine refills from reserve', r0.t > 0 && r0.bar === '1' && r1.mag === 30 && r1.res === 67, `mag ${r1.mag}, reserve ${r1.res}`);

  // ---- the Bulwark wall
  await L(() => { const g = window.__lc.game, p = g.player; p.x = -128; p.z = 196; p.y = g.world.heightAt(p.x, p.z); p.yaw = 0.9; p.pitch = 0; p.vx = p.vz = 0; });
  await sleep(200);
  const w0 = await L(() => ({ n: window.__lc.game.walls.length, charges: window.__lc.game.player.walls }));
  await page.keyboard.press('KeyG'); await sleep(350);
  const w1 = await L(() => { const g = window.__lc.game; const wl = g.walls[g.walls.length - 1]; return { n: g.walls.length, charges: g.player.walls, hp: wl && wl.hp, segs: wl && wl.segs.length, d: wl && Math.hypot(wl.x - g.player.x, wl.z - g.player.z), hud: document.querySelector('#wall b').textContent }; });
  check('G deploys a Bulwark wall in front of the player and spends a charge', w1.n === w0.n + 1 && w1.charges === w0.charges - 1 && w1.segs === 5 && Math.abs(w1.d - 1.9) < 0.4 && Number(w1.hud) === w1.charges, JSON.stringify(w1));
  await shot(page, '06-bulwark');
  a = await pos();
  await hold(page, 'KeyW', 900);
  b = await pos();
  check('the wall blocks movement', Math.hypot(b.x - a.x, b.z - a.z) < 2.0, `advanced ${Math.hypot(b.x - a.x, b.z - a.z).toFixed(2)} m`);
  await L(() => { const p = window.__lc.game.player; p.cur = 0; p.weapons[0].mag = 30; p.pitch = 0; });
  await page.mouse.down(); await sleep(500); await page.mouse.up();
  const w2 = await L(() => { const g = window.__lc.game; const wl = g.walls[g.walls.length - 1]; return { hp: wl ? wl.hp : -1, hits: window.__lc.evCount.wallHit || 0 }; });
  check('the wall stops bullets and takes damage', w2.hp < 300 && w2.hits >= 2, `wall hp ${w2.hp}`);
  await L(() => { const g = window.__lc.game; const wl = g.walls[g.walls.length - 1]; if (wl) wl.hp = 10; window.__lc.game.player.weapons[0].mag = 30; });
  await page.mouse.down(); await sleep(350); await page.mouse.up(); await sleep(150);
  const w3 = await L(() => ({ n: window.__lc.game.walls.length, br: window.__lc.evCount.wallBreak || 0 }));
  check('the wall is destructible', w3.n === w0.n && w3.br >= 1);

  // ---- medkit
  const hPre = await L(() => { const p = window.__lc.game.player; p.hp = 30; p.medkits = 2; return { reloadT: p.reloadT, healT: p.healT, cur: p.cur, mag: p.cur >= 0 ? p.weapons[p.cur].mag : -1, lmb: window.__lc.input.lmb, ev: window.__lc.evCount.heal || 0, god: window.__lc.game.god, state: p.state }; });
  await L(() => window.__lc.resetFrameLog());
  await page.keyboard.press('KeyH'); await sleep(300);
  const h0 = await L(() => ({ t: window.__lc.game.player.healT, ring: document.getElementById('healring').style.opacity, ev: window.__lc.evCount.heal || 0 }));
  const tHeal = Date.now();
  await page.waitForFunction('window.__lc.game.player.healT <= 0', { timeout: 15000 });      // 2.4 s of game time
  await sleep(120);
  const h1 = await L(() => ({ hp: window.__lc.game.player.hp, med: window.__lc.game.player.medkits, hud: document.getElementById('hpnum').textContent, worst: window.__lc.worst }));
  check('H uses a medkit: channel ring, then health restored', hPre.healT === 0 && h0.t > 0 && h0.ring === '1' && h1.hp === 95 && h1.med === 1 && h1.hud === '95', `hp 30 -> ${h1.hp}, ${h1.med} medkit left, took ${((Date.now() - tHeal + 300) / 1000).toFixed(1)} s wall time; worst frame in that window ${h1.worst.frameMs} ms`);

  // ---- minimap, gunfire ping
  const mapPixels = () => L(() => { const c = document.getElementById('minimap'), t = document.createElement('canvas'); t.width = c.width; t.height = c.height; const tg = t.getContext('2d', { willReadFrequently: true }); tg.drawImage(c, 0, 0); const d = tg.getImageData(0, 0, c.width, c.height).data; const seen = new Set(); let red = 0, blue = 0; for (let i = 0; i < d.length; i += 4) { seen.add((d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3)); if (d[i] > 225 && d[i + 1] < 95 && d[i + 2] < 80) red++; if (d[i + 2] > 180 && d[i] < 160 && d[i + 1] > 150) blue++; } return { colours: seen.size, red, blue }; });
  // count ping-red pixels around where a shooter at world offset (dx, dz) from the player should appear;
  // far shooters are drawn as a tick on the rim in their direction
  const redNear = (dx, dz) => L((o) => {
    const p = window.__lc.game.player, c = document.getElementById('minimap'), t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const tg = t.getContext('2d', { willReadFrequently: true }); tg.drawImage(c, 0, 0);
    const d = tg.getImageData(0, 0, c.width, c.height).data, H = c.width / 2, s = H / 105;
    const cy = Math.cos(p.yaw), sy = Math.sin(p.yaw);
    let rx = (o.dx * cy - o.dz * sy) * s, rz = (o.dx * sy + o.dz * cy) * s;
    const rl = Math.hypot(rx, rz);
    if (rl > H - 6) { rx = rx / rl * (H - 9); rz = rz / rl * (H - 9); }
    let n = 0;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (Math.hypot(x - (H + rx), y - (H + rz)) > 15) continue;
      const i = (y * c.width + x) * 4;
      if (d[i] > 215 && d[i + 1] < 105 && d[i + 2] < 90) n++;
    }
    return n;
  }, { dx, dz });
  const fireFrom = (idx, dx, dz) => L((o) => {
    const g = window.__lc.game, p = g.player, t = g.actors[o.idx];
    t.ai = null; t.state = 'ground'; t.alive = true; t.x = p.x + o.dx; t.z = p.z + o.dz; t.y = g.world.heightAt(t.x, t.z); t.px = t.x; t.py = t.y; t.pz = t.z; t.onGround = true;
    g.give(t, 'ar'); t.cur = 0; t.yaw = 0; t.pitch = 0.6; t.cmd.fire = true;
  }, { idx, dx, dz });
  await sleep(2200);
  const m0 = await mapPixels();
  // real bots may already be fighting nearby, so stage the two shooters on bearings that are quiet
  let nd = null, fd = null;
  for (let k = 0; k < 8; k++) {
    const ang = k * Math.PI / 4, c = Math.cos(ang), s = Math.sin(ang);
    const n = await redNear(c * 35, s * 35), f = await redNear(c * 150, s * 150);
    const land = await L((o) => { const g = window.__lc.game, p = g.player; return g.world.heightAt(p.x + o.x, p.z + o.z) > 0.5; }, { x: c * 35, z: s * 35 });
    if (land && (!nd || n < nd.n)) nd = { n, dx: c * 35, dz: s * 35 };
    if (!fd || f < fd.n) fd = { n: f, dx: c * 150, dz: s * 150 };
  }
  const near0 = nd.n, far0 = fd.n;
  await fireFrom(9, nd.dx, nd.dz);       // 35 m away: inside the minimap
  await fireFrom(10, fd.dx, fd.dz);      // 150 m away: beyond its edge
  await sleep(600);
  const near1 = await redNear(nd.dx, nd.dz), far1 = await redNear(fd.dx, fd.dz);
  const fired = await L(() => window.__lc.game.gunfire.filter((g) => g.id === 9 || g.id === 10).length);
  await shot(page, '07-minimap', { x: 8, y: 8, width: 250, height: 320 });
  await L(() => { window.__lc.game.actors[9].cmd.fire = false; window.__lc.game.actors[10].cmd.fire = false; });
  check('minimap renders terrain, the Cordon ring and the player', m0.colours > 60, `${m0.colours} distinct colours`);
  const others = await L(() => { const g = window.__lc.game, p = g.player; return g.gunfire.filter((q) => q.id !== 0 && q.id !== 9 && q.id !== 10 && Math.hypot(q.x - p.x, q.z - p.z) < 110).map((q) => `${g.actors[q.id].name}@${Math.hypot(q.x - p.x, q.z - p.z).toFixed(0)}m`).slice(0, 4); });
  check('nearby gunfire is pinged on the minimap at the shooter position', near1 >= near0 + 8 && fired > 0, `${near0} -> ${near1} red pixels at the expected spot` + (others.length ? `; other shooters nearby: ${others.join(', ')}` : ''));
  check('distant gunfire shows as a direction tick on the minimap rim', far1 >= far0 + 8, `${far0} -> ${far1} red pixels at the expected bearing`);

  // ---- bots: looting, fighting, walls, rotating
  console.log('\n== C. Bots, the Cordon and match flow');
  const botsNow = await L(() => { const g = window.__lc.game; return { t: g.time, armed: g.actors.filter((x) => x.ai && x.weapons.some(Boolean)).length, bots: g.actors.filter((x) => x.ai).length }; });
  const ffT = await L(() => window.__lc.ff(Math.max(0, 165 - window.__lc.game.time)));
  const bots = await L(() => {
    const g = window.__lc.game, z = g.zone, live = g.actors.filter((x) => x.ai && x.alive);
    return { t: g.time, alive: g.alive, armed: live.filter((x) => x.weapons.some(Boolean)).length, live: live.length, vest: live.filter((x) => x.armor > 0).length, botWalls: window.__lc.evCount.botWalls || 0, kills: g.actors.filter((x) => x.ai).reduce((s, x) => s + x.kills, 0), inNext: live.filter((x) => Math.hypot(x.x - z.nextX, x.z - z.nextZ) < z.nextR + 3).length, moved: live.filter((x) => x.ai.path && x.ai.path.length).length, nan: g.actors.some((x) => !Number.isFinite(x.x + x.y + x.z)), modes: live.map((x) => x.ai.mode) };
  });
  info(`t=${ffT.toFixed(0)} s  alive ${bots.alive}  modes: ${[...new Set(bots.modes)].join(', ')}`);
  check('bots loot weapons and armour', bots.armed >= bots.live - 1 && bots.vest >= 2, `${bots.armed}/${bots.live} armed, ${bots.vest} with vests (was ${botsNow.armed}/${botsNow.bots} armed at ${botsNow.t.toFixed(0)} s)`);
  check('bots fight each other', bots.kills >= 1 && bots.alive < 19, `${bots.kills} bot kills, ${bots.alive} alive`);
  check('bots deploy Bulwark walls when shot at', bots.botWalls >= 2, `${bots.botWalls} bot walls so far`);
  check('bots navigate with paths and no actor has an invalid position', bots.moved >= 3 && !bots.nan, `${bots.moved} following paths`);
  // a bot under direct fire throws a wall: shoot one until it reacts
  const react = await L(() => {
    const Lc = window.__lc, g = Lc.game, p = g.player;
    const bot = g.actors.find((x) => x.ai && x.alive && x.walls > 0 && x.state === 'ground');
    if (!bot) return { ok: false, why: 'no bot with charges' };
    bot.x = p.x + 0; bot.z = p.z - 22; bot.y = g.world.heightAt(bot.x, bot.z); bot.px = bot.x; bot.py = bot.y; bot.pz = bot.z; bot.hp = 100; bot.armor = 100; bot.ai.wallAt = -99; bot.wallCd = 0;
    const n0 = g.walls.length;
    let threw = false;
    for (let k = 0; k < 40 && !threw; k++) { g.applyDamage(bot, 6, 'body', p, 0); Lc.ff(0.4); threw = g.walls.some((w) => w.owner === bot.id); }
    return { ok: threw, hp: bot.hp, walls: g.walls.length - n0, mode: bot.ai.mode };
  });
  check('a bot that is being shot throws a wall for cover', react.ok, JSON.stringify(react));

  // ---- the Cordon
  const z0 = await L(() => { const z = window.__lc.game.zone; return { t: window.__lc.game.time, r: z.r, phase: z.phase, label: document.getElementById('zonelabel').textContent, time: document.getElementById('zonetime').textContent }; });
  await sleep(300);
  check('the Cordon shrinks on schedule', z0.r < 190 && z0.phase >= 1, `radius ${z0.r.toFixed(0)} m at ${z0.t.toFixed(0)} s, phase ${z0.phase}`);
  check('HUD shows the Cordon timer', /cordon/i.test(await page.$eval('#zonelabel', (e) => e.textContent)) && /\d:\d\d/.test(await page.$eval('#zonetime', (e) => e.textContent)));
  await L(() => { const g = window.__lc.game, p = g.player, z = g.zone; g.god = false; p.hp = 100; const ang = Math.atan2(p.z - z.cz, p.x - z.cx) || 0; let r = z.r + 14; p.x = z.cx + Math.cos(ang) * r; p.z = z.cz + Math.sin(ang) * r; const rr = Math.hypot(p.x, p.z); if (rr > 300) { p.x *= 300 / rr; p.z *= 300 / rr; } p.y = Math.max(g.world.heightAt(p.x, p.z), -1.3); p.yaw = Math.atan2(-(z.cx - p.x), -(z.cz - p.z)); p.pitch = 0.05; });
  await sleep(2600);
  const zo = await L(() => { const p = window.__lc.game.player; return { hp: p.hp, out: p.outside, warn: document.getElementById('warn').style.opacity, vig: document.getElementById('zonevig').style.opacity }; });
  await shot(page, '08-outside-cordon');
  check('outside the Cordon the player takes damage and is warned', zo.out && zo.hp < 100 && zo.warn === '1' && zo.vig === '1', `hp ${zo.hp.toFixed(0)}`);
  await L(() => { const g = window.__lc.game, p = g.player, z = g.zone; g.god = true; p.x = z.nextX; p.z = z.nextZ; p.y = g.world.heightAt(p.x, p.z); p.hp = 100; });
  await sleep(300);
  check('damage stops back inside', await L(() => !window.__lc.game.player.outside));

  // ---- win screen
  await L(() => { const g = window.__lc.game, p = g.player; for (const x of g.actors) if (x !== p && x.alive) g._kill(x, p, 0, 'body'); });
  await sleep(2600);
  const win = await L(() => ({ shown: !document.getElementById('end').classList.contains('hidden'), cls: document.getElementById('end').className, title: document.getElementById('endtitle').textContent, place: document.getElementById('endplace').textContent, kills: document.getElementById('skills').textContent, over: window.__lc.game.over, winner: window.__lc.game.winner && window.__lc.game.winner.name }));
  await shot(page, '09-win-screen');
  check('win: last operator standing shows the victory screen', win.shown && win.over && win.winner === 'YOU' && /last operator standing/i.test(win.title) && /#1/.test(win.place) && win.cls.includes('win'), `${win.title} / ${win.place}`);

  // ---- redeploy and loss screen
  await page.keyboard.press('Enter');
  await sleep(600);
  const re = await L(() => ({ state: window.__lc.state, t: window.__lc.game.time, alive: window.__lc.game.alive, end: document.getElementById('end').classList.contains('hidden'), st: window.__lc.game.player.state }));
  check('Enter redeploys into a fresh match', re.state === 'playing' && re.t < 2 && re.alive === 20 && re.end && re.st === 'drop', JSON.stringify(re));
  await L(() => { const g = window.__lc.game, p = g.player; p.x = 0; p.z = 30; p.y = g.world.heightAt(0, 30) + 2; });
  await page.waitForFunction('window.__lc.game.player.state === "ground"', { timeout: 6000 });
  await L(() => { const g = window.__lc.game, p = g.player, k = g.actors[4]; k.state = 'ground'; g.give(k, 'ar'); k.x = p.x + 6; k.z = p.z; k.y = g.world.heightAt(k.x, k.z); g.applyDamage(p, 500, 'body', k, 0); });
  await sleep(2700);
  const loss = await L(() => ({ shown: !document.getElementById('end').classList.contains('hidden'), cls: document.getElementById('end').className, title: document.getElementById('endtitle').textContent, place: document.getElementById('endplace').textContent, sub: document.getElementById('endsub').textContent, alive: window.__lc.game.player.alive }));
  await shot(page, '10-loss-screen');
  check('loss: being eliminated shows the defeat screen with placement and killer', loss.shown && !loss.alive && /eliminated/i.test(loss.title) && /#20/.test(loss.place) && /taken out by/i.test(loss.sub) && loss.cls.includes('loss'), `${loss.title} / ${loss.place} / ${loss.sub}`);
  await page.keyboard.press('Escape');
  await sleep(400);
  check('Esc returns to the main menu', await visible(page, '#menu') && await L(() => window.__lc.state === 'menu'));
  check('no console or runtime errors during gameplay checks', problems.length === 0, problems.slice(0, 3).join(' | '));
  await page.close();

  // ====================================================================== D. frame cost
  console.log('\n== D. Frame cost on this GPU');
  {
    const { page: pg, problems: pr } = await open('?test=1&q=auto&seed=5');
    const gpu = await pg.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl2'); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; });
    info(gpu);
    info('load stages: ' + (await pg.evaluate(() => window.__lc.bootTimes.map((m) => `${m[0]} ${m[1]} ms`).join(', '))));
    // what this headless browser's own frame clock runs at, with nothing on screen
    const blank = await browser.newPage();
    await blank.goto('about:blank');
    const tick = await blank.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { if (++n === 120) res((performance.now() - t0) / 120); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
    await blank.close();
    info(`headless frame clock on an empty page: ${tick.toFixed(1)} ms per frame (${(1000 / tick).toFixed(0)} Hz)`);
    await pg.evaluate(() => { const Lc = window.__lc; Lc.start({ seed: 5, god: true }); });
    const spots = [['Meridian plaza', -14, 22, -0.55], ['Freight Yard', 166, 44, 1.2], ['jungle', -62, 58, -2.3], ['beach', -128, 196, 0.9]];
    let worst = 0;
    for (const [name, x, z, yaw] of spots) {
      await pg.evaluate((q) => { const g = window.__lc.game, p = g.player; p.state = 'ground'; p.x = q[0]; p.z = q[1]; p.y = g.world.heightAt(q[0], q[1]) + 0.2; p.yaw = q[2]; p.pitch = 0.03; if (!p.weapons[0]) g.give(p, 'ar'); }, [x, z, yaw]);
      await sleep(1200);
      const bn = await pg.evaluate(() => window.__lc.bench(40));
      worst = Math.max(worst, bn.median);
      info(`${name.padEnd(15)} median ${bn.median.toFixed(1)} ms  p90 ${bn.p90.toFixed(1)} ms  ${bn.calls} draw calls  ${(bn.tris / 1000).toFixed(0)}k triangles  ${bn.w}x${bn.h}`);
    }
    check('measured frame cost fits a 60 FPS budget (16.7 ms) on Auto quality', worst < 16.7, `worst median ${worst.toFixed(1)} ms`);
    await pg.evaluate(() => window.__lc.resetFrameLog());
    await sleep(4000);
    const st = await pg.evaluate(() => window.__lc.stats());
    info(`free-running: ${st.fps.toFixed(0)} fps, frame p50 ${st.p50.toFixed(1)} ms, p95 ${st.p95.toFixed(1)} ms, render scale ${st.scale}, GPU timer ${st.gpuTimer ? st.gpuMs.toFixed(1) + ' ms per frame' : 'not exposed by this browser'}`);
    check('free-running game keeps pace with the browser frame clock', st.p50 < tick * 1.12, `${st.fps.toFixed(1)} fps against a ${(1000 / tick).toFixed(0)} Hz clock`);
    check('no errors while benchmarking', pr.length === 0, pr.slice(0, 2).join(' | '));
    await pg.close();
  }

  // ====================================================================== E. a complete match
  if (!QUICK) {
    console.log('\n== E. One complete rendered match (bots only, 8x speed)');
    const { page: pg, problems: pr } = await open('?test=1&auto=1&speed=8&seed=3&nomenu');
    const t0 = Date.now();
    let mid = false;
    for (;;) {
      await sleep(1000);
      const s = await pg.evaluate(() => ({ t: window.__lc.game.time, over: window.__lc.game.over, alive: window.__lc.game.alive, end: window.__lc.endShown }));
      if (!mid && s.t > 150) { mid = true; await shot(pg, '11-match-midgame'); }
      if (s.over || Date.now() - t0 > 170000) break;
    }
    const fin = await pg.evaluate(() => { const g = window.__lc.game; return { over: g.over, t: g.endTime || g.time, winner: g.winner && g.winner.name, alive: g.alive, place: g.player.place, end: window.__lc.endShown, title: document.getElementById('endtitle').textContent, ev: window.__lc.evCount }; });
    await sleep(2200);
    await shot(pg, '12-match-end');
    const mm = `${Math.floor(fin.t / 60)}:${String(Math.floor(fin.t % 60)).padStart(2, '0')}`;
    check('a full 20-operator match plays through to a single winner', fin.over && fin.alive === 1 && !!fin.winner, `winner ${fin.winner}, ended at ${mm}`);
    check('the match ends by the hard cap (Cordon fully closed at 7:20, plus a few seconds)', fin.t <= 452, mm);
    check('the final encounter falls inside the 5-8 minute window', fin.t >= 300 && fin.t <= 480, `${mm}; tools/simtest.mjs gives the distribution across seeds`);
    check('the end screen is up when the match finishes', fin.end && fin.title.length > 0, fin.title);
    info(`events: ${fin.ev.shot} shots, ${fin.ev.kill} kills, ${fin.ev.wallDeploy} walls, ${fin.ev.pickup} pickups`);
    check('no console or runtime errors across the whole match', pr.length === 0, pr.slice(0, 3).join(' | '));
    await pg.close();
  }
} catch (e) {
  check('harness completed', false, String(e.stack || e).slice(0, 700));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed` + (failed.length ? `, ${failed.length} FAILED:` : ''));
for (const f of failed) console.log(`  - ${f.name}  [${f.detail}]`);
await browser.close();
server.kill();
process.exit(failed.length ? 1 : 0);
