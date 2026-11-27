// LAN multiplayer check. Starts the server in test mode, opens three real game clients (two
// desktop browsers and one emulated phone) plus 17 lightweight network clients so the room is
// full, and plays through: create, list, join, room cap, settings, start, movement prediction,
// shooting each other, walls between players, looting, lag-compensated hits on a moving target,
// a disconnect, the end of the match on every client, and a rematch.
// Usage: node tools/mptest.mjs
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 7600 + Math.floor(Math.random() * 300);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
}
const info = (m) => console.log('      ' + m);

const serverLog = [];
const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), String(PORT), '--test'], { stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (d) => serverLog.push('ERR ' + d));
const url = await new Promise((res) => server.stdout.on('data', (d) => { serverLog.push(String(d)); const m = String(d).match(/http:\/\/localhost:\d+\//); if (m) res(m[0]); }));
const WS = url.replace('http', 'ws') + 'ws';

const LAUNCH = {
  executablePath: CHROME, headless: true, protocolTimeout: 90000,
  args: ['--headless=new', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
};
const browsers = [];   // one browser per player, like separate devices

async function openClient(label, opts) {
  const br = await puppeteer.launch(LAUNCH);
  browsers.push(br);
  const page = (await br.pages())[0] || await br.newPage();
  if (opts.phone) {
    await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36');
    await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true });
  } else await page.setViewport({ width: 1100, height: 620 });
  const problems = [];
  page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warn' || t === 'warning') problems.push(`${label} console.${t}: ${m.text().slice(0, 300)}`); });
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${String(e.stack || e).slice(0, 500)}`));
  const tOpen = Date.now();
  await page.goto(url + '?test=1&q=low' + (opts.phone ? '&touch=1' : ''), { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('window.__lc', { timeout: 120000 });
  info(`${label} ready in ${((Date.now() - tOpen) / 1000).toFixed(1)} s`);
  return { page, problems, label, L: (fn, arg) => page.evaluate(fn, arg) };
}
const clickSel = async (c, sel) => { await c.page.click(sel); await sleep(250); };

// lightweight protocol-level clients
function rawClient(name) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS);
    const c = { ws, name, msgs: [], last: {}, snaps: 0 };
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 's') c.snaps++; else { c.msgs.push(m); c.last[m.t] = m; } };
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', name })); res(c); };
    ws.onerror = rej;
  });
}

try {
  // ------------------------------------------------------------------ lobby
  console.log('\n== Lobby: create, list, join, cap, settings');
  const A = await openClient('Alpha', {}), B = await openClient('Bravo', { phone: true }), C = await openClient('Charlie', {});
  const setName = (c, n) => c.L((nm) => { const i = document.getElementById('mpname'); i.value = nm; i.dispatchEvent(new Event('change')); }, n);
  for (const [c, n] of [[A, 'Alpha'], [B, 'Bravo'], [C, 'Charlie']]) { await clickSel(c, '#multi'); await setName(c, n); }
  await sleep(600);
  check('the multiplayer screen connects to the server', (await A.L(() => document.getElementById('mpstatus').textContent)).includes('Connected'));
  await A.L(() => { document.getElementById('mproomname').value = 'Night Ops'; });
  await clickSel(A, '#mpcreate');
  await sleep(500);
  const aRoom = await A.L(() => ({ view: window.__lc.lobby.view, name: document.getElementById('roomname').textContent, start: !document.getElementById('roomstart').classList.contains('hidden') }));
  check('creating a room puts the creator in it as host', aRoom.view === 'room' && aRoom.name === 'Night Ops' && aRoom.start, JSON.stringify(aRoom));
  const listed = await B.L(() => window.__lc.lobby.rooms.map((r) => `${r.name} ${r.n}/${r.max}`));
  check('other players see the room in their list without refreshing', listed.includes('Night Ops 1/20'), listed.join(', '));
  await B.page.screenshot({ path: path.join(SHOTS, 'mp-01-room-list-phone.png') });
  await clickSel(B, '[data-join]');
  await clickSel(C, '[data-join]');
  await sleep(500);
  const roster = await C.L(() => [...document.querySelectorAll('#roomplayers .rp span')].map((s) => s.textContent));
  check('joining shows everyone in the room', ['Alpha', 'Bravo', 'Charlie'].every((n) => roster.includes(n)), roster.join(', '));
  check('only the host gets the Start button', await B.L(() => document.getElementById('roomstart').classList.contains('hidden')) && !(await A.L(() => document.getElementById('roomstart').classList.contains('hidden'))));
  // host toggles bots off and on, others see it
  await A.L(() => document.querySelector('[data-bots="false"]').click()); await sleep(300);
  const seenOff = await C.L(() => window.__lc.lobby.room.settings.bots);
  await A.L(() => document.querySelector('[data-bots="true"]').click()); await sleep(300);
  check('room settings changed by the host reach everyone', seenOff === false && (await C.L(() => window.__lc.lobby.room.settings.bots)) === true);
  // fill the room to 20 with network clients, then try a 21st
  const raws = [];
  for (let i = 0; i < 18; i++) raws.push(await rawClient(`Net${i + 1}`));
  await sleep(300);
  const roomId = await A.L(() => window.__lc.lobby.room.id);
  for (let i = 0; i < 17; i++) raws[i].ws.send(JSON.stringify({ t: 'join', id: roomId }));
  await sleep(600);
  raws[17].ws.send(JSON.stringify({ t: 'join', id: roomId }));
  await sleep(400);
  const nInRoom = await A.L(() => window.__lc.lobby.room.players.length);
  check('a room holds 20 players and turns the 21st away', nInRoom === 20 && raws[17].last.err && /full/i.test(raws[17].last.err.msg), `${nInRoom} in room; 21st got "${raws[17].last.err && raws[17].last.err.msg}"`);
  await A.page.screenshot({ path: path.join(SHOTS, 'mp-02-room-full.png') });
  raws[17].ws.close();

  // ------------------------------------------------------------------ match start
  console.log('\n== Match: 20 people in one game');
  await clickSel(A, '#roomstart');
  await Promise.all([A, B, C].map((c) => c.page.waitForFunction('window.__lc.netMatch && window.__lc.state === "playing"', { timeout: 15000 })));
  const views = await Promise.all([A, B, C].map((c) => c.L(() => { const g = window.__lc.game; return { me: g.player.name, total: g.total, humans: g.actors.filter((a) => a.isPlayer).length, names: g.actors.map((a) => a.name) }; })));
  check('every client enters the same match as itself', views[0].me === 'Alpha' && views[1].me === 'Bravo' && views[2].me === 'Charlie', views.map((v) => v.me).join(', '));
  check('the match holds all 20 players (no bot slots left)', views.every((v) => v.total === 20 && v.humans === 20), `${views[0].humans} humans of ${views[0].total}`);
  check('every client agrees on who is in the match', JSON.stringify(views[0].names) === JSON.stringify(views[2].names));
  await sleep(1500);
  const drop = await A.L(() => { const p = window.__lc.game.player; return { st: p.state, y: p.y }; });
  check('players start in the parachute drop', drop.st === 'drop' && drop.y > 90, `altitude ${drop.y.toFixed(0)}`);
  await A.page.screenshot({ path: path.join(SHOTS, 'mp-03-drop.png') });

  // put Alpha and Charlie face to face on open beach, Bravo nearby by some crates
  const dbg = (c, o) => c.L((m) => window.__lc.lobby.net.send(Object.assign({ t: 'dbg' }, m)), o);
  await dbg(A, { op: 'god', v: true });
  await dbg(A, { op: 'tp', x: -128, z: 196 });
  await dbg(C, { op: 'tp', x: -128 + 18 * Math.sin(0.9), z: 196 + 18 * Math.cos(0.9) });
  for (const c of [A, C]) await dbg(c, { op: 'give', item: 'ar' });
  await sleep(800);
  await A.L(() => { const p = window.__lc.game.player; p.yaw = 0.9 + Math.PI; p.pitch = 0; });
  await C.L(() => { const p = window.__lc.game.player; p.yaw = 0.9; p.pitch = 0; });
  await sleep(500);
  const posA = () => A.L(() => { const p = window.__lc.game.player; return { x: p.x, z: p.z }; });
  const aOnC = () => C.L(() => { const g = window.__lc.game, a = g.actors.find((x) => x.name === 'Alpha'); return { x: a.x, z: a.z, alive: a.alive, hp: a.hp }; });
  const a0 = await posA(), c0 = await aOnC();
  check('teleports and positions agree across clients', Math.hypot(a0.x - c0.x, a0.z - c0.z) < 0.6, `Alpha at (${a0.x.toFixed(1)}, ${a0.z.toFixed(1)}) on own screen, (${c0.x.toFixed(1)}, ${c0.z.toFixed(1)}) on Charlie's`);

  // movement: instant on your own screen, shortly after on everyone else's
  await A.page.keyboard.down('KeyD');
  await sleep(80);
  const aEarly = await posA(), cEarly = await aOnC();
  await sleep(900);
  await A.page.keyboard.up('KeyD');
  await sleep(450);
  const a1 = await posA(), c1 = await aOnC();
  check('your own movement starts immediately (predicted locally)', Math.hypot(aEarly.x - a0.x, aEarly.z - a0.z) > 0.08, `${Math.hypot(aEarly.x - a0.x, aEarly.z - a0.z).toFixed(2)} m after 80 ms; seen by Charlie: ${Math.hypot(cEarly.x - c0.x, cEarly.z - c0.z).toFixed(2)} m`);
  check('others see you move to the same place', Math.hypot(a1.x - a0.x, a1.z - a0.z) > 3 && Math.hypot(a1.x - c1.x, a1.z - c1.z) < 0.5, `moved ${Math.hypot(a1.x - a0.x, a1.z - a0.z).toFixed(1)} m; own vs Charlie's view differ by ${Math.hypot(a1.x - c1.x, a1.z - c1.z).toFixed(2)} m`);

  // a wall between players stops bullets (on open ground: the test first checks nothing else is in the way)
  await dbg(A, { op: 'tp', x: -122, z: 194 });
  await sleep(700);
  const clear = await C.L(() => { const g = window.__lc.game, p = g.player, a = g.actors.find((x) => x.name === 'Alpha'); return !g.world.blocked(p.x, p.y + 1.5, p.z, a.x, a.y + 1.2, a.z); });
  check('test setup: clear line of fire between the two players', clear);
  await A.L(() => { const g = window.__lc.game, p = g.player, o = g.actors.find((x) => x.name === 'Charlie'); p.yaw = Math.atan2(-(o.x - p.x), -(o.z - p.z)); });
  await sleep(200);
  await A.page.keyboard.press('KeyG');
  await sleep(600);
  const wallOnC = await C.L(() => window.__lc.game.walls.filter((w) => w.owner === window.__lc.game.actors.find((x) => x.name === 'Alpha').id).length);
  check("Alpha's Bulwark appears in Charlie's game", wallOnC === 1);
  await dbg(A, { op: 'god', v: false });
  const hp0 = (await aOnC()).hp;
  await C.L(() => { const g = window.__lc.game, a = g.actors.find((x) => x.name === 'Alpha'); window.__lc.aimAt(a.x, a.y + 1.15, a.z); });
  await C.page.mouse.down(); await sleep(700); await C.page.mouse.up();   // no mouse move: in-game the mouse turns the view
  await sleep(400);
  const blocked = await C.L(() => ({ hits: window.__lc.evCount.wallHit || 0, shots: window.__lc.game.player.shots, cur: window.__lc.game.player.cur, st: window.__lc.game.player.state, lmb: window.__lc.input.lmb, mag: window.__lc.game.player.weapons.map((w) => w && w.mag), walls: window.__lc.game.walls.map((w) => [w.x.toFixed(1), w.z.toFixed(1)]), me: [window.__lc.game.player.x.toFixed(1), window.__lc.game.player.z.toFixed(1)], a: (() => { const a = window.__lc.game.actors.find((x) => x.name === 'Alpha'); return [a.x.toFixed(1), a.z.toFixed(1)]; })() }));
  info('wall phase: ' + JSON.stringify(blocked));
  const hp1 = (await aOnC()).hp;
  await C.page.screenshot({ path: path.join(SHOTS, 'mp-04-wall-between-players.png') });
  check("the wall stops Charlie's bullets", blocked.hits >= 3 && hp1 >= hp0 - 0.01, `${blocked.hits} wall hits, Alpha hp ${hp0} -> ${hp1}`);

  // shooting each other: Alpha steps out and strafes, Charlie tracks what he sees
  await dbg(A, { op: 'tp', x: -128 + 6, z: 196 - 2 });
  await sleep(700);
  await A.L(() => { const p = window.__lc.game.player; p.hp = 100; });
  const aHud0 = await A.L(() => Number(document.getElementById('hpnum').textContent));
  await A.page.keyboard.down('KeyA');
  await C.page.mouse.down();
  let hm = 0;
  for (let i = 0; i < 28; i++) {
    await C.L(() => { const g = window.__lc.game, a = g.actors.find((x) => x.name === 'Alpha'); if (a.alive) window.__lc.aimAt(a.x, a.y + 1.15, a.z); });
    hm = Math.max(hm, await C.L(() => Number(document.getElementById('hit').style.opacity) || 0));
    await sleep(45);
  }
  await C.page.mouse.up();
  await A.page.keyboard.up('KeyA');
  await sleep(500);
  const hitStats = await C.L(() => ({ shots: window.__lc.game.player.shots, hits: window.__lc.game.player.hits }));
  const aSide = await A.L(() => ({ hp: window.__lc.game.player.hp, hud: Number(document.getElementById('hpnum').textContent), alive: window.__lc.game.player.alive, arcs: [...document.querySelectorAll('.dmgarc')].some((x) => Number(x.style.opacity) > 0) }));
  check('shooting a moving player registers hits (lag compensation)', hitStats.hits >= 4, `${hitStats.hits} hits from ${hitStats.shots} rounds`);
  check('the shooter sees hitmarkers', hm > 0.3);
  check("the victim's own health and HUD drop", !aSide.alive || (aSide.hp < aHud0 && aSide.hud < aHud0), JSON.stringify(aSide));
  // finish the fight
  if (aSide.alive) {
    await C.page.mouse.down();
    for (let i = 0; i < 40 && (await aOnC()).alive; i++) { await C.L(() => { const g = window.__lc.game, a = g.actors.find((x) => x.name === 'Alpha'); if (a.alive) window.__lc.aimAt(a.x, a.y + 1.15, a.z); }); await sleep(60); }
    await C.page.mouse.up();
  }
  await sleep(2400);
  const aEnd = await A.L(() => ({ end: window.__lc.endShown, title: document.getElementById('endtitle').textContent, sub: document.getElementById('endsub').textContent, btn: document.getElementById('again').textContent }));
  const feedB = await B.L(() => document.getElementById('feed').textContent);
  check('the eliminated player gets their end screen naming the killer', aEnd.end && /eliminated/i.test(aEnd.title) && /charlie/i.test(aEnd.sub) && /back to room/i.test(aEnd.btn), `${aEnd.title} / ${aEnd.sub}`);
  check('a bystander sees the kill in the feed', /charlie/i.test(feedB) && /alpha/i.test(feedB), feedB.slice(0, 80));
  await A.page.screenshot({ path: path.join(SHOTS, 'mp-05-eliminated.png') });
  await C.page.screenshot({ path: path.join(SHOTS, 'mp-06-shooter.png') });
  const cKills = await C.L(() => ({ k: window.__lc.game.player.kills, hud: document.getElementById('kills').textContent }));
  check('the kill is credited to the shooter', cKills.k >= 1 && cKills.hud === String(cKills.k));

  // looting is shared: the phone player walks onto a crate
  const crate = await B.L(() => { const g = window.__lc.game, w = g.world; const l = g.loot.find((q) => q.alive && q.type === 'medkit' && !q.dropped && Math.abs(w.heightAt(q.x, q.z) - q.y) < 0.3 && !w.boxNear(q.x, q.z, 3.5) && !w.boxNear(q.x, q.z + 3, 1.2)); return l && { id: l.id, x: l.x, z: l.z }; });
  await dbg(B, { op: 'tp', x: crate.x, z: crate.z + 3, yaw: 0 });
  await sleep(700);
  await B.L(() => { window.__lc.game.player.yaw = 0; });
  const cdp = await B.page.target().createCDPSession();
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
  await touch('touchStart', [{ x: 150, y: 300, id: 1 }]);
  for (let k = 1; k <= 4; k++) { await touch('touchMove', [{ x: 150, y: 300 - k * 8, id: 1 }]); await sleep(16); }
  let gotIt = false;
  for (let i = 0; i < 30 && !gotIt; i++) { await sleep(100); gotIt = await A.L((id) => !window.__lc.game.loot.find((l) => l.id === id).alive, crate.id); }
  await touch('touchEnd', []);
  const bMed = await B.L(() => window.__lc.game.player.medkits);
  info('loot phase: ' + JSON.stringify(await B.L((c) => { const g = window.__lc.game, p = g.player; return { crate: [c.x.toFixed(1), c.z.toFixed(1)], me: [p.x.toFixed(1), p.y.toFixed(1), p.z.toFixed(1)], st: p.state, alive: p.alive, stick: window.__lc.input.stick, tc: !document.getElementById('tc').classList.contains('hidden') }; }, crate)));
  check("the phone player's pickup disappears from everyone's world", gotIt && bMed >= 1, `Bravo has ${bMed} medkit(s)`);
  await B.page.screenshot({ path: path.join(SHOTS, 'mp-07-phone-in-match.png') });

  // a player disconnecting hands their operator to a bot
  const r0 = raws[0];
  r0.ws.close();
  await sleep(1500);
  const left = await C.L(() => { const a = window.__lc.game.actors.find((x) => x.name === 'Net1'); return { alive: a.alive, human: a.isPlayer }; });
  check('a player who disconnects is replaced by a bot in the match', left.human === false, JSON.stringify(left));

  // server load with 19 connected players
  const statsP = new Promise((res) => { A.page.once('console', () => {}); res(); });
  await statsP;
  const stats = await new Promise((res) => {
    const c = raws[1];
    const before = c.msgs.length;
    c.ws.send(JSON.stringify({ t: 'dbg', op: 'stats' }));
    const iv = setInterval(() => { const m = c.msgs.slice(before).find((q) => q.t === 'dbg'); if (m) { clearInterval(iv); res(m.stats); } }, 50);
  });
  if (stats) {
    const kbps = stats.bytes / Math.max(1, stats.time) / 19 / 1024;
    info(`server: ${stats.tickMsAvg.toFixed(2)} ms per 60 Hz tick on average (worst ${stats.tickMax.toFixed(1)} ms), about ${kbps.toFixed(0)} KB/s sent to each player`);
    check('the server keeps up with 19 players at 60 ticks a second', stats.tickMsAvg < 4, `${stats.tickMsAvg.toFixed(2)} ms average tick`);
  }

  // ------------------------------------------------------------------ end of match
  console.log('\n== End of match and rematch');
  await dbg(A, { op: 'speed', v: 16 });
  await Promise.all([B, C].map((c) => c.page.waitForFunction('window.__lc.game.over', { timeout: 90000 })));
  await sleep(2600);
  const ends = await Promise.all([A, B, C].map((c) => c.L(() => ({ over: window.__lc.game.over, winner: window.__lc.game.winner && window.__lc.game.winner.name, end: window.__lc.endShown, title: document.getElementById('endtitle').textContent, place: document.getElementById('endplace').textContent }))));
  info(ends.map((e, i) => `${['Alpha', 'Bravo', 'Charlie'][i]}: ${e.title} ${e.place}`).join(' | '));
  check('the match ends with the same winner on every client', ends.every((e) => e.over && e.winner && e.winner === ends[1].winner), `winner ${ends[1].winner}`);
  check('everyone gets an end screen', ends.every((e) => e.end && e.title));
  await B.page.screenshot({ path: path.join(SHOTS, 'mp-08-end-phone.png') });
  await A.page.waitForFunction('window.__lc.lobby.room && window.__lc.lobby.room.state === "lobby"', { timeout: 15000 });
  for (const c of [A, B, C]) await c.L(() => document.getElementById('again').click());
  await sleep(500);
  const back = await Promise.all([A, B, C].map((c) => c.L(() => ({ view: window.__lc.lobby.view, state: window.__lc.lobby.room && window.__lc.lobby.room.state }))));
  check('Back to room returns everyone to the room, ready for the next match', back.every((b) => b.view === 'room' && b.state === 'lobby'), JSON.stringify(back));
  await clickSel(A, '#roomstart');
  const again = await Promise.all([A, B, C].map((c) => c.page.waitForFunction('window.__lc.netMatch && window.__lc.state === "playing" && window.__lc.game.time < 10', { timeout: 15000 }).then(() => true, () => false)));
  check('the host can start a rematch', again.every(Boolean));
  // host hands over when leaving
  await A.L(() => document.getElementById('tomenu').click());
  await A.L(() => window.__lc.lobby.leave());
  await sleep(800);
  const newHost = await C.L(() => { const r = window.__lc.lobby.room; return r && r.players.find((p) => p.id === r.hostId)?.name; });
  check('when the host leaves, someone else becomes host', newHost && newHost !== 'Alpha', `new host ${newHost}`);
  for (const c of [A, B, C]) check(`no console or runtime errors (${c.label})`, c.problems.length === 0, c.problems.slice(0, 2).join(' | '));
  const serverErrors = serverLog.filter((l) => /ERR|error/i.test(l));
  check('no server errors', serverErrors.length === 0, serverErrors.slice(0, 2).join(' | '));
  for (const r of raws) try { r.ws.close(); } catch (e) { /* already closed */ }
} catch (e) {
  check('harness completed', false, String(e.stack || e).slice(0, 800));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} multiplayer checks passed`);
for (const f of failed) console.log(`  - ${f.name}  [${f.detail}]`);
console.log('\nserver log:\n' + serverLog.join('').split('\n').filter((l) => l.includes('[rooms]')).slice(-8).join('\n'));
for (const br of browsers) await br.close().catch(() => {});
server.kill();
process.exit(failed.length ? 1 : 0);
