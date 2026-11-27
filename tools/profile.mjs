// Frame-cost breakdown: benchmarks one viewpoint with parts of the scene switched off.
// Usage: node tools/profile.mjs [x z yaw] [quality]
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [x, z, yaw] = [Number(process.argv[2] || -14), Number(process.argv[3] || 22), Number(process.argv[4] || -0.55)];
const quality = process.argv[5] || 'high';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5800 + Math.floor(Math.random() * 300);
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
const url = await new Promise((res) => server.stdout.on('data', (d) => { const m = String(d).match(/http:\/\/localhost:\d+\//); if (m) res(m[0]); }));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--headless=new', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=1600,900', '--mute-audio'],
  defaultViewport: { width: 1600, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e.stack || e).slice(0, 500)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 400)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto(`${url}?test=1&q=${quality}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction('window.__lc', { timeout: 120000 });
await page.evaluate((a) => {
  const L = window.__lc;
  L.start({ seed: 11, god: true });
  const g = L.game, p = g.player;
  p.state = 'ground'; p.x = a[0]; p.z = a[1]; p.y = g.world.heightAt(a[0], a[1]) + 0.3; p.yaw = a[2]; p.pitch = 0.05; p.onGround = false;
}, [x, z, yaw]);
await sleep(2500);
const run = async (label, setup, teardown) => {
  if (setup) await page.evaluate(setup);
  await sleep(350);
  const b = await page.evaluate(() => window.__lc.bench(30));
  console.log(label.padEnd(30), `median ${b.median.toFixed(1).padStart(5)} ms  min ${b.min.toFixed(1).padStart(5)}  calls ${String(b.calls).padStart(3)}  tris ${(b.tris / 1000).toFixed(0).padStart(4)}k  ${b.w}x${b.h}`);
  if (teardown) await page.evaluate(teardown);
};
await run('baseline');
await run('no post (direct to screen)', () => { const c = window.__lc.core; c._r = c.post.render; c.post.render = function (s, cam) { c.renderer.setRenderTarget(null); c.renderer.render(s, cam); }; }, () => { const c = window.__lc.core; c.post.render = c._r; });
await run('no bloom', () => { window.__lc.core.post.bloomOn = false; }, () => { window.__lc.core.post.bloomOn = true; });
await run('no fxaa', () => { window.__lc.core.post.mFinal.uniforms.uFxaa.value = 0; }, () => { window.__lc.core.post.mFinal.uniforms.uFxaa.value = 1; });
await run('scale 0.5', () => { const c = window.__lc.core; c._s = c.renderScale; c.renderScale = 0.5; c.post.setSize(c.cssW * 0.5, c.cssH * 0.5); }, () => { const c = window.__lc.core; c.renderScale = c._s; c.post.setSize(c.cssW * c._s, c.cssH * c._s); });
await run('shadow map static (no update)', () => { window.__lc.core.renderer.shadowMap.autoUpdate = false; }, () => { window.__lc.core.renderer.shadowMap.autoUpdate = true; });
const kids = ['terrain', 'structures', 'vegetation', 'water'];
for (let i = 0; i < 4; i++) await run('hide ' + kids[i], `window.__lc.world3d.children[${i}].visible = false`, `window.__lc.world3d.children[${i}].visible = true`);
await run('hide characters', () => { window.__lc.chars.group.visible = false; }, () => { window.__lc.chars.group.visible = true; });
await run('hide effects', () => { window.__lc.effects.group.visible = false; }, () => { window.__lc.effects.group.visible = true; });
await run('hide sky', () => { window.__lc.core.sky.visible = false; }, () => { window.__lc.core.sky.visible = true; });
await run('everything hidden', () => { const L = window.__lc; L.world3d.visible = false; L.chars.group.visible = false; L.effects.group.visible = false; }, () => { const L = window.__lc; L.world3d.visible = true; L.chars.group.visible = true; L.effects.group.visible = true; });
await run('baseline again');
await browser.close();
server.kill();
