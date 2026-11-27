// Headless match simulator: plays full 20-operator matches (the player on autopilot) across seeds
// and checks the invariants the game depends on: bounded match length, exactly one winner,
// no NaN positions, nobody permanently wedged.
// Usage: node tools/simtest.mjs [seeds=12] [firstSeed=1] [--verbose]
import { generateWorld } from '../src/sim/world.js';
import { Game } from '../src/sim/game.js';
import { TICK, TOTAL_ACTORS } from '../src/sim/config.js';

const nSeeds = Number(process.argv[2] || 12), first = Number(process.argv[3] || 1);
const verbose = process.argv.includes('--verbose');
const t0 = performance.now();
const world = generateWorld();
console.log(`world generated in ${(performance.now() - t0).toFixed(0)} ms`);

const results = [];
let failures = 0;
for (let s = first; s < first + nSeeds; s++) {
  const g = new Game(world, { seed: s, autopilot: true, collectEvents: false, god: process.argv.includes('--god') });
  const tStart = performance.now();
  const timeline = [];
  const stuck = new Map();
  let nan = false, maxStuck = 0, wallsDeployed = 0, lastWalls = 0, firstKill = -1, pickups = 0;
  const startLoot = g.loot.filter((l) => l.alive).length;
  const modes = {};
  let tickMax = 0, slowTicks = 0;
  while (!g.over && g.time < 600) {
    const ts = performance.now();
    g.step(TICK);
    const te = performance.now() - ts;
    if (te > tickMax) tickMax = te;
    if (te > 4) slowTicks++;
    if (g.tickN % 60 === 0) {
      if (g.tickN % 1800 === 0) timeline.push(g.alive);
      if (g.alive < TOTAL_ACTORS && firstKill < 0) firstKill = g.time;
      for (const a of g.actors) {
        if (!Number.isFinite(a.x + a.y + a.z + a.yaw + a.pitch + a.hp)) nan = true;
        if (!a.alive) continue;
        if (a.ai) modes[a.ai.mode] = (modes[a.ai.mode] || 0) + 1;
        const st = stuck.get(a.id) || { x: a.x, z: a.z, t: 0 };
        if (Math.hypot(a.x - st.x, a.z - st.z) < 0.5 && a.state !== 'drop' && a.ai && a.ai.wantMove) st.t += 1; else { st.t = 0; st.x = a.x; st.z = a.z; }
        if (st.t > maxStuck) maxStuck = st.t;
        stuck.set(a.id, st);
      }
    }
    if (g.walls.length > lastWalls) wallsDeployed += g.walls.length - lastWalls;
    lastWalls = g.walls.length;
  }
  const ms = performance.now() - tStart;
  const winners = g.actors.filter((a) => a.alive).length;
  const p = g.actors[0];
  const kills = g.actors.map((a) => a.kills).sort((a, b) => b - a);
  const zoneDeaths = g.actors.filter((a) => !a.alive && a.killerId < 0).length;
  const looted = startLoot - g.loot.filter((l) => l.alive && !l.dropped).length;
  const armedCount = g.actors.filter((a) => a.weapons.some(Boolean)).length;
  const r = { seed: s, dur: g.time, winners, winner: g.winner ? g.winner.name : '-', playerPlace: p.place || (p.alive ? 1 : 0), playerKills: p.kills, topKills: kills[0], zoneDeaths, wallsDeployed, maxStuck, firstKill, looted, armedCount, nan, ms, timeline };
  results.push(r);
  const bad = nan || winners !== 1 || g.time > 470 || !g.over;
  if (bad) failures++;
  console.log(
    `seed ${String(s).padStart(3)}  ${(g.time / 60 | 0)}:${String(Math.floor(g.time % 60)).padStart(2, '0')}  winner ${r.winner.padEnd(8)} player #${String(r.playerPlace).padStart(2)} (${r.playerKills}k)  top ${r.topKills}k  zone-deaths ${zoneDeaths}  walls ${String(wallsDeployed).padStart(2)}  looted ${looted}  armed ${armedCount}  firstKill ${firstKill.toFixed(0)}s  maxStuck ${maxStuck}s  saves ${g.pacedSaves}  ${ms.toFixed(0)}ms  alive/30s [${timeline.join(',')}]${bad ? '  <-- FAIL' : ''}`,
  );
  if (verbose) console.log('   modes', JSON.stringify(modes));
  if (verbose) console.log(`   ticks: worst ${tickMax.toFixed(1)} ms, ${slowTicks} over 4 ms;  paths: ${g.pathCalls} calls, ${g.pathFails} failed, ${g.pathMs.toFixed(0)} ms total, worst ${g.pathMaxMs.toFixed(1)} ms`);
  r.tickMax = tickMax; r.slowTicks = slowTicks; r.pathMax = g.pathMaxMs; r.pathMs = g.pathMs; r.pathFails = g.pathFails;
}
{ // mean alive count every 30 s across seeds, to compare against ALIVE_CURVE
  const maxLen = Math.max(...results.map((r) => r.timeline.length));
  const row = [];
  for (let i = 0; i < maxLen; i++) {
    let s = 0;
    for (const r of results) s += i < r.timeline.length ? r.timeline[i] : 1;
    row.push((s / results.length).toFixed(1));
  }
  console.log(`\nmean alive every 30s: ${row.join(' ')}`);
}
const durs = results.map((r) => r.dur).sort((a, b) => a - b);
const avg = durs.reduce((s, v) => s + v, 0) / durs.length;
const in58 = results.filter((r) => r.dur >= 300 && r.dur <= 480).length;
const places = results.map((r) => r.playerPlace);
console.log(`\nmatches ${results.length}  duration min ${durs[0].toFixed(0)}s  avg ${avg.toFixed(0)}s  max ${durs[durs.length - 1].toFixed(0)}s  within 5-8 min: ${in58}/${results.length}`);
console.log(`autopilot player: avg place ${(places.reduce((s, v) => s + v, 0) / places.length).toFixed(1)}  wins ${places.filter((p) => p === 1).length}  avg kills ${(results.reduce((s, r) => s + r.playerKills, 0) / results.length).toFixed(1)}`);
console.log(`avg sim cost ${(results.reduce((s, r) => s + r.ms, 0) / results.length).toFixed(0)} ms per match;  failures ${failures}`);
console.log(`worst single tick ${Math.max(...results.map((r) => r.tickMax)).toFixed(1)} ms; ticks over 4 ms per match: avg ${(results.reduce((s, r) => s + r.slowTicks, 0) / results.length).toFixed(1)}; worst path search ${Math.max(...results.map((r) => r.pathMax)).toFixed(1)} ms; failed searches per match: avg ${(results.reduce((s, r) => s + r.pathFails, 0) / results.length).toFixed(0)}`);
process.exit(failures ? 1 : 0);
