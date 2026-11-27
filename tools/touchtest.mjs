// Phone controls check: emulates a phone in landscape in headless Chrome and drives the on-screen
// controls with real multi-touch input (DevTools Input.dispatchTouchEvent).
// Usage: node tools/touchtest.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 7100 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHONE = { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true };
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((res) => server.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/localhost:\d+\//); if (m) res(m[0]); }));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--headless=new', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});

async function openPhone(query) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport(PHONE);
  const problems = [];
  page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warn' || t === 'warning') problems.push(`console.${t}: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e.stack || e).slice(0, 500)}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.url()}`); });
  await page.goto(url + query, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__lc', { timeout: 120000 });
  return { page, problems };
}

// multi-touch driver: every event lists all fingers currently on the glass
function touchDriver(cdp) {
  const fingers = new Map();
  const send = (type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [...fingers.values()] });
  return {
    async down(id, x, y) { fingers.set(id, { x, y, id, radiusX: 8, radiusY: 8, force: 1 }); await send('touchStart'); },
    async move(id, x, y, steps = 6) {
      const f = fingers.get(id), x0 = f.x, y0 = f.y;
      for (let i = 1; i <= steps; i++) { f.x = x0 + (x - x0) * i / steps; f.y = y0 + (y - y0) * i / steps; await send('touchMove'); await sleep(16); }
    },
    async up(id) { fingers.delete(id); await send(fingers.size ? 'touchMove' : 'touchEnd'); },
    async tap(x, y, id = 9) { await this.down(id, x, y); await sleep(60); await this.up(id); },
  };
}
const center = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, vis: getComputedStyle(e).display !== 'none' && r.width > 0 }; });

try {
  // ---------------------------------------------------------------- detection
  {
    const { page, problems } = await openPhone('');
    const d = await page.evaluate(() => ({ touch: document.body.classList.contains('touch'), coarse: matchMedia('(pointer: coarse)').matches, pts: navigator.maxTouchPoints }));
    check('a phone is detected without any URL flag', d.touch, JSON.stringify(d));
    check('phone page boots without errors', problems.length === 0, problems[0] || '');
    await page.close();
  }
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 800 });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction('window.__lc', { timeout: 120000 });
    check('a desktop browser stays on mouse and keyboard', await page.evaluate(() => !document.body.classList.contains('touch') && !document.getElementById('tc')));
    await page.close();
  }

  // ---------------------------------------------------------------- full control run
  const { page, problems } = await openPhone('?test=1&touch=1&seed=7');
  const cdp = await page.target().createCDPSession();
  const T = touchDriver(cdp);
  const L = (fn, arg) => page.evaluate(fn, arg);
  await sleep(600);
  check('menu shows touch instructions and a look-speed setting', (await center(page, '#touchkeys')).vis && (await center(page, '#sensopt')).vis && !(await center(page, '#keys')).vis);
  await page.screenshot({ path: path.join(SHOTS, 'phone-01-menu.png') });

  await page.setViewport({ ...PHONE, width: 390, height: 844, isLandscape: false });
  await sleep(300);
  check('portrait shows the rotate-your-phone prompt', (await center(page, '#rotate')).vis);
  await page.setViewport(PHONE);
  await sleep(300);
  check('landscape hides it again', !(await center(page, '#rotate')).vis);

  const dep = await center(page, '#deploy');
  await T.tap(dep.x, dep.y);
  await sleep(700);
  const st0 = await L(() => ({ state: window.__lc.state, tc: !document.getElementById('tc').classList.contains('hidden'), drop: document.getElementById('tc').classList.contains('drop'), lmb: window.__lc.input.lmb }));
  check('tapping Deploy starts the match and shows the controls', st0.state === 'playing' && st0.tc && st0.drop, JSON.stringify(st0));
  check('a tap never leaks into a stuck fire button', st0.lmb === false);
  await L(() => { window.__lc.game.god = true; });

  // steer the parachute with the stick
  const pos = () => L(() => { const p = window.__lc.game.player; return { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, crouch: p.crouch, ads: p.ads, state: p.state, sprint: p.sprinting }; });
  let a = await pos();
  await T.down(1, 150, 300);
  await T.move(1, 230, 300, 5);
  await sleep(1200);
  let b = await pos();
  await page.screenshot({ path: path.join(SHOTS, 'phone-02-drop.png') });
  await T.up(1);
  check('the left stick steers the parachute', Math.hypot(b.x - a.x, b.z - a.z) > 8, `drifted ${Math.hypot(b.x - a.x, b.z - a.z).toFixed(1)} m`);

  // land on open beach, armed
  await L(() => { const g = window.__lc.game, p = g.player; p.x = -128; p.z = 196; p.y = g.world.heightAt(p.x, p.z) + 3; });
  await page.waitForFunction('window.__lc.game.player.state === "ground"', { timeout: 6000 });
  const tp = () => L(() => { const g = window.__lc.game, p = g.player; p.x = -128; p.z = 196; p.y = g.world.heightAt(p.x, p.z); p.px = p.x; p.py = p.y; p.pz = p.z; p.vx = p.vz = 0; p.yaw = 0.9; p.pitch = 0; for (const t of ['ar', 'smg', 'sr']) if (!p.weapons[['ar', 'smg', 'sr'].indexOf(t)]) g.give(p, t); p.cur = 0; p.medkits = 2; p.walls = 3; });
  await tp(); await sleep(400);
  check('on the ground the full button cluster appears', !(await L(() => document.getElementById('tc').classList.contains('drop'))) && (await center(page, '#tc-fire')).vis);

  // walk, then sprint by pushing the stick all the way
  a = await pos();
  await T.down(1, 150, 300); await T.move(1, 150, 270, 4);
  await sleep(1000);
  b = await pos();
  await T.up(1);
  const walk = Math.hypot(b.x - a.x, b.z - a.z);
  await tp(); await sleep(200);
  a = await pos();
  await T.down(1, 150, 300); await T.move(1, 150, 220, 4);
  await sleep(250);
  const spr = (await pos()).sprint;
  await sleep(750);
  b = await pos();
  await T.up(1);
  const run = Math.hypot(b.x - a.x, b.z - a.z);
  check('a half push walks, a full forward push sprints', walk > 1.5 && run > walk * 1.3 && spr, `half ${walk.toFixed(1)} m/s-ish, full ${run.toFixed(1)}, sprinting ${spr}`);
  const facing = await L(() => { const p = window.__lc.game.player; return { dx: Math.sin(p.yaw), dz: Math.cos(p.yaw) }; });
  check('pushing up moves the operator forward, the way the camera faces', (b.x - a.x) * -facing.dx + (b.z - a.z) * -facing.dz > run * 0.8);

  // look by dragging on the right half
  await tp(); await sleep(200);
  a = await pos();
  await T.down(2, 560, 130); await T.move(2, 640, 160, 8); await T.up(2);
  b = await pos();
  check('dragging the right side turns the view', Math.abs(b.yaw - a.yaw) > 0.3 && Math.abs(b.pitch - a.pitch) > 0.05, `yaw ${(b.yaw - a.yaw).toFixed(2)} rad, pitch ${(b.pitch - a.pitch).toFixed(2)} rad`);

  // fire, and keep aiming by sliding the fire button, while walking with the other thumb
  await tp(); await sleep(200);
  const fire = await center(page, '#tc-fire');
  const s0 = await L(() => window.__lc.game.player.shots);
  a = await pos();
  await T.down(1, 150, 300); await T.move(1, 150, 260, 3);
  await T.down(3, fire.x, fire.y);
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, 'phone-03-firing.png') });
  await T.move(3, fire.x - 40, fire.y - 10, 6);
  await sleep(300);
  b = await pos();
  const s1 = await L(() => ({ shots: window.__lc.game.player.shots, lmb: window.__lc.input.lmb }));
  await T.up(3); await T.up(1);
  await sleep(100);
  const s2 = await L(() => ({ shots: window.__lc.game.player.shots, lmb: window.__lc.input.lmb }));
  check('holding Fire shoots on full auto', s1.shots - s0 >= 5 && s1.lmb, `${s1.shots - s0} rounds`);
  check('sliding the Fire button aims while shooting', Math.abs(b.yaw - a.yaw) > 0.2, `yaw ${(b.yaw - a.yaw).toFixed(2)} rad`);
  check('two thumbs at once: walking continued while firing', Math.hypot(b.x - a.x, b.z - a.z) > 1);
  check('lifting the thumb stops firing', !s2.lmb && s2.shots - s1.shots <= 2);

  const press = async (sel, hold = 70) => { const c = await center(page, sel); await T.down(4, c.x, c.y); await sleep(hold); await T.up(4); await sleep(120); };
  // aim toggle
  await press('#tc .tcb[data-a="aim"]'); await sleep(350);
  const ad1 = (await pos()).ads;
  await press('#tc .tcb[data-a="aim"]'); await sleep(350);
  const ad2 = (await pos()).ads;
  check('Aim toggles the sights on and off', ad1 > 0.9 && ad2 < 0.1, `${ad1.toFixed(2)} -> ${ad2.toFixed(2)}`);
  // crouch, jump
  await press('#tc .tcb[data-a="crouch"]');
  const cr = (await pos()).crouch;
  await press('#tc .tcb[data-a="crouch"]');
  check('Crouch toggles', cr && !(await pos()).crouch);
  a = await pos();
  const jb = await center(page, '#tc .tcb[data-a="jump"]');
  await T.down(4, jb.x, jb.y);
  let top = a.y;
  for (let i = 0; i < 10; i++) { await sleep(40); top = Math.max(top, (await pos()).y); }
  await T.up(4);
  check('Jump jumps', top > a.y + 0.6, `rose ${(top - a.y).toFixed(2)} m`);
  await sleep(700);
  // weapon slots
  const slot2 = await center(page, '#tc .tcw[data-s="1"]');
  await T.tap(slot2.x, slot2.y); await sleep(450);
  const w1 = await L(() => window.__lc.game.player.cur);
  const slot3 = await center(page, '#tc .tcw[data-s="2"]');
  await T.tap(slot3.x, slot3.y); await sleep(450);
  check('tapping a weapon name switches weapon', w1 === 1 && (await L(() => window.__lc.game.player.cur)) === 2);
  // reload
  await L(() => { const p = window.__lc.game.player; p.cur = 0; p.weapons[0].mag = 5; p.reserve[0] = 60; });
  await sleep(450);
  await press('#tc .tcb[data-a="reload"]');
  await page.waitForFunction('window.__lc.game.player.reloadT <= 0 && window.__lc.game.player.weapons[0].mag === 30', { timeout: 12000 }).then(() => true, () => false)
    .then((ok) => check('Reload reloads', ok));
  // wall
  const wc = await L(() => ({ n: window.__lc.game.walls.length, c: window.__lc.game.player.walls }));
  await press('#tc .tcb[data-a="wall"]');
  const wd = await L(() => ({ n: window.__lc.game.walls.length, c: window.__lc.game.player.walls, label: document.querySelector('#tc .tcb[data-a="wall"] b').textContent }));
  check('Wall deploys a Bulwark and the button count drops', wd.n === wc.n + 1 && wd.c === wc.c - 1, `${wc.c} -> ${wd.c} charges`);
  await sleep(300);
  await page.screenshot({ path: path.join(SHOTS, 'phone-04-bulwark.png') });
  check('the button shows the remaining charges', Number(wd.label) === wd.c || Number(await L(() => document.querySelector('#tc .tcb[data-a="wall"] b').textContent)) === wd.c);
  // heal
  await L(() => { window.__lc.game.player.hp = 40; });
  await press('#tc .tcb[data-a="heal"]');
  await page.waitForFunction('window.__lc.game.player.hp >= 99', { timeout: 15000 }).then(() => true, () => false)
    .then((ok) => check('Heal uses a medkit', ok));
  // map
  const mm = await center(page, '#minimap');
  await T.tap(mm.x, mm.y); await sleep(300);
  const open = await L(() => !document.getElementById('bigmap').classList.contains('hidden') && document.getElementById('tc').classList.contains('mapopen'));
  await page.screenshot({ path: path.join(SHOTS, 'phone-05-map.png') });
  const bm = await center(page, '#bigmap');
  await T.tap(bm.x, bm.y); await sleep(300);
  check('tapping the minimap opens the full map, tapping it closes it', open && await L(() => document.getElementById('bigmap').classList.contains('hidden')));
  // pause and resume
  const pb = await center(page, '#tc .tcs[data-a="pause"]');
  await T.tap(pb.x, pb.y); await sleep(300);
  const pz = await L(() => ({ paused: window.__lc.paused, overlay: !document.getElementById('pause').classList.contains('hidden'), t: window.__lc.game.time }));
  await sleep(500);
  const frozen = (await L(() => window.__lc.game.time)) === pz.t;
  await T.tap(422, 195); await sleep(300);
  check('the pause button pauses, a tap resumes', pz.paused && pz.overlay && frozen && !(await L(() => window.__lc.paused)));
  // performance at phone resolution
  await tp(); await sleep(1500);
  await L(() => window.__lc.resetFrameLog());
  await sleep(2500);
  const perf = await L(() => window.__lc.stats());
  console.log(`      phone viewport ${PHONE.width}x${PHONE.height}: ${perf.fps.toFixed(0)} fps, render scale ${perf.scale}, ${perf.calls} draw calls`);
  await page.screenshot({ path: path.join(SHOTS, 'phone-06-ground.png') });
  // end screen buttons are tappable
  await L(() => { const g = window.__lc.game, p = g.player; g.god = false; const k = g.actors[4]; k.state = 'ground'; g.give(k, 'ar'); g.applyDamage(p, 500, 'body', k, 0); });
  await page.waitForFunction('window.__lc.endShown', { timeout: 8000 });
  await sleep(300);
  check('controls hide when you are eliminated', await L(() => document.getElementById('tc').classList.contains('hidden')));
  await page.screenshot({ path: path.join(SHOTS, 'phone-07-end.png') });
  const mb = await center(page, '#tomenu');
  await T.tap(mb.x, mb.y); await sleep(400);
  check('Main menu button on the end screen works by touch', await L(() => window.__lc.state === 'menu'));
  check('no console or runtime errors on the phone', problems.length === 0, problems.slice(0, 3).join(' | '));
  await page.close();
} catch (e) {
  check('harness completed', false, String(e.stack || e).slice(0, 600));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} phone checks passed`);
for (const f of failed) console.log(`  - ${f.name}  [${f.detail}]`);
await browser.close();
server.kill();
process.exit(failed.length ? 1 : 0);
