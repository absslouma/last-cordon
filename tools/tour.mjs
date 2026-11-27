// Art review: teleports the (invulnerable) player to a set of viewpoints, stages a firefight and
// saves a screenshot plus the measured frame cost at each stop.
// Usage: node tools/tour.mjs [outDir] [quality]
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || path.join(ROOT, 'shots'));
const quality = process.argv[3] || 'auto';
fs.mkdirSync(outDir, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5500 + Math.floor(Math.random() * 300);
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((res) => server.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/localhost:\d+\//); if (m) res(m[0]); }));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--headless=new', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--mute-audio'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
const problems = [];
page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warn' || t === 'warning') problems.push(`[console.${t}] ${m.text().slice(0, 500)}`); });
page.on('pageerror', (e) => problems.push(`[pageerror] ${String(e.stack || e).slice(0, 800)}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { await page.screenshot({ path: path.join(outDir, name + '.png') }); };

try {
  const t0 = Date.now();
  await page.goto(`${url}?test=1&q=${quality}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__lc', { timeout: 120000 });
  console.log('boot', Date.now() - t0, 'ms');
  await page.evaluate(() => {
    const L = window.__lc;
    L.start({ seed: 11, god: true });
    window.tp = (x, z, yaw, pitch, weapon) => {
      const g = L.game, p = g.player;
      p.state = 'ground'; p.x = x; p.z = z; p.y = g.world.heightAt(x, z) + 0.3; p.px = p.x; p.py = p.y; p.pz = p.z;
      p.vx = p.vy = p.vz = 0; p.yaw = yaw; p.pitch = pitch || 0; p.onGround = false;
      if (weapon != null && !p.weapons[weapon]) g.give(p, ['ar', 'smg', 'sr'][weapon]);
      if (weapon != null) p.cur = weapon;
    };
  });
  const stops = [
    ['10-beach', -128, 196, 0.9, -0.02, 0],
    ['11-meridian', -14, 22, -0.55, 0.12, 0],
    ['12-freight', 166, 44, 1.2, 0.02, 0],
    ['13-jungle', -62, 58, -2.3, 0.02, 1],
    ['14-ridge', -128, -132, -2.35, -0.12, 2],
    ['15-village', -84, 150, 2.6, 0.0, 0],
  ];
  for (const [name, x, z, yaw, pitch, w] of stops) {
    await page.evaluate((a) => window.tp(...a), [x, z, yaw, pitch, w]);
    await sleep(1400);
    await shot(name);
    const b = await page.evaluate(() => window.__lc.bench(30));
    console.log(name.padEnd(12), `median ${b.median.toFixed(1)} ms  p90 ${b.p90.toFixed(1)}  calls ${b.calls}  tris ${(b.tris / 1000).toFixed(0)}k  scale ${b.scale}  ${b.w}x${b.h}`);
  }
  // staged firefight: an enemy across a courtyard, a Bulwark thrown down, sustained fire
  await page.evaluate(() => {
    const L = window.__lc, g = L.game;
    window.tp(-6, 30, 0, 0.0, 0);
    const b = g.actors[3];
    b.state = 'ground'; b.x = -4; b.z = 12; b.y = g.world.heightAt(b.x, b.z); b.px = b.x; b.py = b.y; b.pz = b.z; b.onGround = true; b.yaw = Math.PI;
    g.give(b, 'ar'); b.hp = 100; b.armor = 100;
    const c = g.actors[4];
    c.state = 'ground'; c.x = 6; c.z = 14; c.y = g.world.heightAt(c.x, c.z); c.px = c.x; c.py = c.y; c.pz = c.z; c.onGround = true; c.yaw = Math.PI;
    g.give(c, 'smg');
    L.input.edges.add('KeyG');
  });
  await sleep(700);
  await page.mouse.move(800, 450);
  await page.mouse.down();
  await sleep(450);
  await shot('16-firefight');
  await sleep(500);
  await shot('17-firefight2');
  await page.mouse.up();
  const b = await page.evaluate(() => window.__lc.bench(30));
  console.log('firefight   ', `median ${b.median.toFixed(1)} ms  p90 ${b.p90.toFixed(1)}  calls ${b.calls}  tris ${(b.tris / 1000).toFixed(0)}k  scale ${b.scale}`);
  await page.evaluate(() => { window.tp(-6, 30, 0, 0.0, 2); window.__lc.input.rmb = true; });
  await sleep(900);
  await shot('18-scope');
  await page.evaluate(() => { window.__lc.input.rmb = false; window.__lc.hud.toggleMap(true); });
  await sleep(400);
  await shot('19-map');
} catch (e) { problems.push('[harness] ' + String(e.stack || e)); }
console.log(`${problems.length} problem(s)`);
for (const p of problems.slice(0, 30)) console.log(p);
await browser.close();
server.kill();
process.exit(problems.length ? 1 : 0);
