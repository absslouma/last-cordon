// Heads-up display: DOM overlay driven from simulation state. Minimap and compass are 2D canvases;
// damage numbers are pooled DOM nodes projected from world space each frame.
import * as THREE from 'three';
import { WEAPONS, ACTOR, LOOT_INFO, ZONE_PHASES } from './sim/config.js';

const $ = (id) => document.getElementById(id);
const fmt = (s) => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

function buildStaticMap(world) {
  const S = 512, c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext('2d'), img = g.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const wx = (x + 0.5) / S * world.size - world.half, wz = (y + 0.5) / S * world.size - world.half;
      const h = world.heightAt(wx, wz);
      let r, gg, b;
      if (h < 0) { const k = Math.min(1, -h / 7); r = 22 - 10 * k; gg = 52 - 20 * k; b = 66 - 20 * k; }
      else if (h < 1.7) { r = 168; gg = 157; b = 122; }
      else { const k = Math.min(1, h / 34); r = 76 + 62 * k; gg = 92 + 44 * k; b = 62 + 40 * k; }
      const sh = 1 + (world.heightAt(wx - 2, wz - 2) - world.heightAt(wx + 2, wz + 2)) * 0.075;
      const i = (y * S + x) * 4;
      d[i] = Math.max(0, Math.min(255, r * sh)); d[i + 1] = Math.max(0, Math.min(255, gg * sh)); d[i + 2] = Math.max(0, Math.min(255, b * sh)); d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const sc = S / world.size, px = (v) => (v + world.half) * sc;
  g.strokeStyle = 'rgba(170,150,112,.75)'; g.lineWidth = 2.2; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const pts of world.paths) { g.beginPath(); g.moveTo(px(pts[0][0]), px(pts[0][1])); for (let i = 1; i < pts.length; i++) g.lineTo(px(pts[i][0]), px(pts[i][1])); g.stroke(); }
  for (const t of world.trees) { g.fillStyle = 'rgba(28,54,30,.5)'; g.fillRect(px(t.x) - 1, px(t.z) - 1, 2, 2); }
  for (const f of world.footprints) {
    g.save(); g.translate(px(f.x), px(f.z)); g.rotate(-f.yaw);
    g.fillStyle = f.kind === 'container' ? '#8a7f70' : f.kind === 'pier' ? '#8a7450' : f.kind === 'tank' ? '#b9b5ab' : '#d9d3c4';
    g.strokeStyle = 'rgba(20,22,24,.8)'; g.lineWidth = 0.8;
    if (f.kind === 'tank') { g.beginPath(); g.arc(0, 0, f.w * sc / 2, 0, 6.3); g.fill(); g.stroke(); }
    else { g.fillRect(-f.w * sc / 2, -f.d * sc / 2, f.w * sc, f.d * sc); g.strokeRect(-f.w * sc / 2, -f.d * sc / 2, f.w * sc, f.d * sc); }
    g.restore();
  }
  return c;
}

export function createHud(world) {
  const el = {};
  for (const id of ['hud', 'minimap', 'place', 'zonebox', 'zonelabel', 'zonetime', 'zonefill', 'compass', 'alive', 'kills', 'feed', 'hpnum', 'hpbar', 'arbar', 'pvest', 'phelm', 'med', 'wall', 'wname', 'wclass', 'ammo', 'reload', 'cross', 'hit', 'healring', 'healarc', 'dmgdir', 'prompt', 'toasts', 'warn', 'banner', 'bannert', 'banners', 'dropinfo', 'alt', 'vig', 'zonevig', 'scope', 'numbers', 'bigmap', 'perf', 'end', 'endtitle', 'endplace', 'endsub', 'skills', 'sdmg', 'sacc', 'shead', 'stime']) el[id] = $(id);
  const mapC = buildStaticMap(world);
  const mm = el.minimap.getContext('2d'), cp = el.compass.getContext('2d'), bm = el.bigmap.getContext('2d');
  const hpFill = el.hpbar.firstElementChild, arFill = el.arbar.firstElementChild, relFill = el.reload.firstElementChild;
  const medB = el.med.querySelector('b'), wallB = el.wall.querySelector('b');
  const slots = [...document.querySelectorAll('.wslot')];
  const crossI = { t: el.cross.querySelector('.t'), b: el.cross.querySelector('.b'), l: el.cross.querySelector('.l'), r: el.cross.querySelector('.r') };
  const last = {};
  const set = (key, node, prop, val) => { if (last[key] !== val) { last[key] = val; node[prop] = val; } };
  const style = (key, node, prop, val) => { if (last[key] !== val) { last[key] = val; node.style[prop] = val; } };
  const cls = (key, node, name, on) => { if (last[key] !== on) { last[key] = on; node.classList.toggle(name, on); } };

  // pooled damage numbers
  const nums = [];
  for (let i = 0; i < 26; i++) { const n = document.createElement('div'); n.className = 'dn'; n.style.opacity = 0; el.numbers.appendChild(n); nums.push({ n, life: 0, x: 0, y: 0, z: 0, ox: 0 }); }
  const arcs = [];
  for (let i = 0; i < 4; i++) { const a = document.createElement('div'); a.className = 'dmgarc'; el.dmgdir.appendChild(a); arcs.push({ a, life: 0, dx: 0, dz: 0 }); }
  const v3 = new THREE.Vector3();
  let hitT = 0, hitKill = false, vigT = 0, promptT = 0, bannerT = 0, mapOpen = false, perfOn = false, mapTick = 0;
  const hintCount = {}, state = { hurtOnce: false, touch: false };
  const TOUCH_KEY = { G: 'Wall', H: 'Heal', 'Right click': 'Aim', R: 'Reload' };

  function hint(id, key, text, max = 2) {
    hintCount[id] = (hintCount[id] || 0) + 1;
    if (hintCount[id] > max || promptT > 0.6) { if (promptT > 0.6) hintCount[id]--; return; }
    if (state.touch) { key = TOUCH_KEY[key] || key; text = text.replace('Hold to look', 'Tap to look'); }
    el.prompt.innerHTML = `<kbd>${key}</kbd>${text}`;
    el.prompt.style.opacity = 1; promptT = 4.2;
  }
  function banner(title, sub, dur = 3) {
    el.bannert.textContent = title; el.banners.textContent = sub || '';
    el.banner.style.opacity = 1; bannerT = dur;
  }
  function toast(text, color) {
    const t = document.createElement('div');
    t.className = 'toast cap'; t.textContent = text;
    if (color) t.style.borderLeftColor = color;
    el.toasts.appendChild(t);
    while (el.toasts.children.length > 4) el.toasts.firstElementChild.remove();
    setTimeout(() => t.remove(), 2400);
  }
  function feed(html, me) {
    const r = document.createElement('div');
    r.className = 'feedrow cap' + (me ? ' me' : ''); r.innerHTML = html;
    el.feed.appendChild(r);
    while (el.feed.children.length > 5) el.feed.firstElementChild.remove();
    setTimeout(() => r.classList.add('fade'), 6200);
    setTimeout(() => r.remove(), 6900);
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let curGame = null;
  // you are YOU; other people are highlighted; bots are plain
  const nameOf = (a) => (curGame && a === curGame.player ? '<span class="you">YOU</span>' : a.isPlayer ? `<span class="hum">${esc(a.name)}</span>` : esc(a.name));

  function onEvent(ev, game) {
    curGame = game;
    const p = game.player;
    switch (ev.type) {
      case 'damage':
        if (ev.attacker === p && ev.target !== p && !p.ai) {
          let slot = nums[0];
          for (const n of nums) { if (n.life <= 0) { slot = n; break; } if (n.life < slot.life) slot = n; }
          slot.life = 0.85; slot.x = ev.x; slot.y = ev.y; slot.z = ev.z; slot.ox = (Math.random() - 0.5) * 34;
          slot.n.textContent = Math.max(1, Math.round(ev.amount));
          slot.n.className = ev.zone === 'head' ? 'dn head' : 'dn';
          hitT = ev.killed ? 0.42 : 0.16; hitKill = ev.killed || ev.zone === 'head';
        }
        if (ev.target === p) {
          vigT = Math.min(1, vigT + 0.45 + ev.amount * 0.012);
          if (ev.attacker) {
            let arc = arcs[0];
            for (const a of arcs) if (a.life < arc.life) arc = a;
            arc.life = 1.3; arc.dx = p.hurtDirX; arc.dz = p.hurtDirZ;
            if (!state.hurtOnce && p.walls > 0) { state.hurtOnce = true; hint('wall', 'G', 'Deploy a Bulwark wall for cover'); }
          }
        }
        break;
      case 'kill': {
        const w = ev.zone ? 'CORDON' : ev.weapon >= 0 ? WEAPONS[ev.weapon].name : '';
        const me = ev.killer === p || ev.victim === p;
        if (ev.zone || !ev.killer) feed(`<span class="v">${nameOf(ev.victim)}</span><span class="w">lost to the Cordon</span>`, me);
        else feed(`<span class="k">${nameOf(ev.killer)}</span><span class="w">${w}${ev.head ? ' &middot; HEAD' : ''}</span><span class="v">${nameOf(ev.victim)}</span>`, me);
        if (ev.killer === p && !p.ai) banner(ev.head ? 'Headshot' : 'Eliminated', ev.victim.name, 1.6);
        const left = game.alive;
        if (ev.victim !== p && p.alive && (left === 10 || left === 5 || left === 3 || left === 2)) banner(left === 2 ? 'Final two' : `${left} remain`, '', 2.4);
        break;
      }
      case 'pickup':
        if (ev.actor === p && !p.ai) {
          const info = LOOT_INFO[ev.item];
          toast('+ ' + info.label + (ev.item === 'ammo' ? '  ·  ammo & 1 Bulwark' : ''), hex(info.color));
          if (ev.item === 'sr') hint('scope', 'Right click', 'Hold to look through the scope');
          if (ev.item === 'medkit' && p.hp < 60) hint('heal', 'H', 'Use a medkit');
        }
        break;
      case 'zone':
        if (ev.what === 'shrink') banner('Cordon closing', 'Get inside the marked ring', 3.2);
        else if (ev.what === 'closed') banner('Cordon collapsed', 'No safe ground left', 3.2);
        break;
      case 'land':
        if (ev.actor === p && ev.drop) {
          const poi = placeOf(p.x, p.z);
          banner(poi || 'On the ground', 'Find a weapon', 2.6);
          if (!p.ai) setTimeout(() => { if (p.cur < 0 && p.alive) hint('loot', 'Walk', 'Over glowing crates to pick them up — orange holds weapons', 1); }, 1500);
        }
        break;
    }
  }

  function placeOf(x, z) {
    let best = null, bd = 1e9;
    for (const p of world.pois) { const d = Math.hypot(p.x - x, p.z - z) - p.r; if (d < 12 && d < bd) { bd = d; best = p.name; } }
    return best;
  }

  function drawMinimap(game, a, yaw) {
    const S = 216, H = S / 2, viewR = 105, s = H / viewR, z = game.zone, time = game.time;
    mm.setTransform(1, 0, 0, 1, 0, 0);
    mm.fillStyle = '#0b1820'; mm.fillRect(0, 0, S, S);
    mm.save();
    mm.beginPath(); mm.arc(H, H, H, 0, 6.3); mm.clip();
    mm.translate(H, H); mm.rotate(yaw); mm.scale(s, s); mm.translate(-a.x, -a.z);
    mm.imageSmoothingEnabled = true;
    mm.drawImage(mapC, -world.half, -world.half, world.size, world.size);
    // outside the Cordon
    mm.fillStyle = 'rgba(35,110,255,.26)';
    mm.beginPath(); mm.rect(a.x - 400, a.z - 400, 800, 800); mm.moveTo(z.cx + Math.max(0.01, z.r), z.cz); mm.arc(z.cx, z.cz, Math.max(0.01, z.r), 0, Math.PI * 2, true); mm.fill('evenodd');
    mm.lineWidth = 2 / s; mm.strokeStyle = 'rgba(120,200,255,.95)';
    mm.beginPath(); mm.arc(z.cx, z.cz, Math.max(0.01, z.r), 0, 6.3); mm.stroke();
    if (!z.closed && z.nextR > 0.5) {
      mm.setLineDash([6 / s, 5 / s]); mm.strokeStyle = 'rgba(255,255,255,.9)'; mm.lineWidth = 1.6 / s;
      mm.beginPath(); mm.arc(z.nextX, z.nextZ, z.nextR, 0, 6.3); mm.stroke(); mm.setLineDash([]);
    }
    if (Math.hypot(a.x - z.nextX, a.z - z.nextZ) > z.nextR && !z.closed) {
      mm.strokeStyle = 'rgba(255,255,255,.5)'; mm.lineWidth = 1.2 / s;
      mm.beginPath(); mm.moveTo(a.x, a.z); mm.lineTo(z.nextX, z.nextZ); mm.stroke();
    }
    for (const l of game.loot) {
      if (!l.alive) continue;
      const dx = l.x - a.x, dz = l.z - a.z;
      if (dx * dx + dz * dz > 80 * 80) continue;
      mm.fillStyle = hex(LOOT_INFO[l.type].color);
      mm.fillRect(l.x - 1.4 / s, l.z - 1.4 / s, 2.8 / s, 2.8 / s);
    }
    for (const w of game.walls) { mm.fillStyle = 'rgba(120,220,255,.95)'; for (const b of w.segs) mm.fillRect(b.x - 0.5, b.z - 0.5, 1, 1); }
    const edge = [];
    for (const g of game.gunfire) {
      const age = time - g.t;
      if (age > 1.8 || g.id === a.id) continue;
      const dx = g.x - a.x, dz = g.z - a.z, d = Math.hypot(dx, dz);
      if (d < viewR - 4) {
        mm.strokeStyle = `rgba(255,70,50,${0.95 - age * 0.5})`; mm.lineWidth = 2 / s;
        mm.beginPath(); mm.arc(g.x, g.z, (2 + age * 9) / s * 1.0 + 1.5, 0, 6.3); mm.stroke();
        mm.fillStyle = `rgba(255,70,50,${1 - age * 0.5})`; mm.beginPath(); mm.arc(g.x, g.z, 2.2 / s, 0, 6.3); mm.fill();
      } else if (d < 260) edge.push([dx / d, dz / d, age]);
    }
    mm.restore();
    // gunfire beyond the map edge: red ticks on the rim in that direction
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    mm.save(); mm.translate(H, H);
    for (const [dx, dz, age] of edge) {
      const rx = dx * cy - dz * sy, rz = dx * sy + dz * cy;
      mm.save(); mm.rotate(Math.atan2(rz, rx) + Math.PI / 2);
      mm.fillStyle = `rgba(255,70,50,${0.95 - age * 0.45})`;
      mm.beginPath(); mm.moveTo(0, -H + 3); mm.lineTo(-7, -H + 15); mm.lineTo(7, -H + 15); mm.closePath(); mm.fill();
      mm.restore();
    }
    // north marker and the player
    mm.fillStyle = 'rgba(236,233,225,.92)'; mm.font = '600 12px Bahnschrift, Segoe UI, sans-serif'; mm.textAlign = 'center'; mm.textBaseline = 'middle';
    mm.fillText('N', Math.sin(yaw) * (H - 13), -Math.cos(yaw) * (H - 13));
    mm.fillStyle = '#f2a531'; mm.strokeStyle = 'rgba(0,0,0,.8)'; mm.lineWidth = 1.5;
    mm.beginPath(); mm.moveTo(0, -8); mm.lineTo(6, 6); mm.lineTo(0, 3); mm.lineTo(-6, 6); mm.closePath(); mm.fill(); mm.stroke();
    mm.restore();
  }

  function drawBigMap(game, a) {
    const S = 760, sc = S / world.size, px = (v) => (v + world.half) * sc, z = game.zone;
    bm.setTransform(1, 0, 0, 1, 0, 0);
    bm.drawImage(mapC, 0, 0, S, S);
    bm.fillStyle = 'rgba(35,110,255,.26)';
    bm.beginPath(); bm.rect(0, 0, S, S); bm.moveTo(px(z.cx) + Math.max(0.01, z.r * sc), px(z.cz)); bm.arc(px(z.cx), px(z.cz), Math.max(0.01, z.r * sc), 0, Math.PI * 2, true); bm.fill('evenodd');
    bm.strokeStyle = 'rgba(120,200,255,.95)'; bm.lineWidth = 2; bm.beginPath(); bm.arc(px(z.cx), px(z.cz), Math.max(0.01, z.r * sc), 0, 6.3); bm.stroke();
    if (!z.closed && z.nextR > 0.5) { bm.setLineDash([7, 6]); bm.strokeStyle = '#fff'; bm.lineWidth = 1.6; bm.beginPath(); bm.arc(px(z.nextX), px(z.nextZ), z.nextR * sc, 0, 6.3); bm.stroke(); bm.setLineDash([]); }
    bm.font = '600 12px Bahnschrift, Segoe UI, sans-serif'; bm.textAlign = 'center'; bm.textBaseline = 'middle';
    for (const p of world.pois) { bm.fillStyle = 'rgba(0,0,0,.55)'; const w = bm.measureText(p.name).width + 10; bm.fillRect(px(p.x) - w / 2, px(p.z) - p.r * sc - 19, w, 16); bm.fillStyle = '#ece9e1'; bm.fillText(p.name, px(p.x), px(p.z) - p.r * sc - 10.5); }
    for (const g of game.gunfire) { const age = game.time - g.t; if (age < 2 && g.id !== a.id) { bm.fillStyle = `rgba(255,70,50,${1 - age * 0.45})`; bm.beginPath(); bm.arc(px(g.x), px(g.z), 4, 0, 6.3); bm.fill(); } }
    bm.save(); bm.translate(px(a.x), px(a.z)); bm.rotate(-a.yaw);
    bm.fillStyle = '#f2a531'; bm.strokeStyle = '#000'; bm.lineWidth = 1.5;
    bm.beginPath(); bm.moveTo(0, -10); bm.lineTo(7, 8); bm.lineTo(0, 4); bm.lineTo(-7, 8); bm.closePath(); bm.fill(); bm.stroke();
    bm.restore();
  }

  function drawCompass(yaw) {
    const W = 440, Hc = 34;
    cp.clearRect(0, 0, W, Hc);
    const heading = ((-yaw * 180 / Math.PI) % 360 + 360) % 360, pxPerDeg = 3.4;
    cp.textAlign = 'center'; cp.textBaseline = 'top';
    const NAMES = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = Math.floor((heading - 66) / 5) * 5; d <= heading + 66; d += 5) {
      const x = W / 2 + (d - heading) * pxPerDeg, dd = ((d % 360) + 360) % 360;
      const fade = Math.max(0, 1 - Math.abs(d - heading) / 66);
      cp.fillStyle = `rgba(236,233,225,${0.85 * fade})`;
      const major = dd % 45 === 0, mid = dd % 15 === 0;
      cp.fillRect(x - 0.75, 0, 1.5, major ? 9 : mid ? 6 : 3);
      if (major) { cp.font = '600 13px Bahnschrift, Segoe UI, sans-serif'; cp.fillText(NAMES[dd], x, 13); }
      else if (mid) { cp.font = '10px Bahnschrift, Segoe UI, sans-serif'; cp.fillStyle = `rgba(236,233,225,${0.55 * fade})`; cp.fillText(String(dd), x, 15); }
    }
    cp.fillStyle = '#f2a531'; cp.beginPath(); cp.moveTo(W / 2, 11); cp.lineTo(W / 2 - 5, 2); cp.lineTo(W / 2 + 5, 2); cp.closePath(); cp.fill();
  }

  function update(game, a, dt, camera, view) {
    const p = game.player, z = game.zone;
    // vitals
    const hp = Math.max(0, Math.ceil(p.hp));
    set('hp', el.hpnum, 'textContent', String(hp));
    style('hpw', hpFill, 'width', Math.max(0, Math.min(100, p.hp)) + '%');
    cls('hplow', el.hpbar, 'low', p.hp < 35);
    style('arw', arFill, 'width', Math.max(0, Math.min(100, p.armor)) + '%');
    set('vest', el.pvest, 'textContent', p.armor > 0 ? `Vest ${Math.ceil(p.armor)}` : 'No vest'); cls('veston', el.pvest, 'on', p.armor > 0);
    set('helm', el.phelm, 'textContent', p.helmet > 0 ? `Helmet ${Math.ceil(p.helmet)}` : 'No helmet'); cls('helmon', el.phelm, 'on', p.helmet > 0);
    set('med', medB, 'textContent', String(p.medkits)); cls('mede', el.med, 'empty', p.medkits === 0);
    set('wall', wallB, 'textContent', String(p.walls)); cls('walle', el.wall, 'empty', p.walls === 0);
    // weapon panel
    const w = p.cur >= 0 ? WEAPONS[p.cur] : null, ws = p.cur >= 0 ? p.weapons[p.cur] : null;
    set('wn', el.wname, 'textContent', w ? w.name : 'Unarmed'); set('wc', el.wclass, 'textContent', w ? w.cls : 'Find a weapon');
    set('ammo', el.ammo, 'innerHTML', w ? `${ws.mag}<small>/ ${p.reserve[p.cur]}</small>` : '--<small>/ --</small>');
    cls('ammolow', el.ammo, 'low', !!w && ws.mag <= w.mag * 0.25);
    const rl = w && p.reloadT > 0;
    style('relo', el.reload, 'opacity', rl ? '1' : '0');
    if (rl) relFill.style.width = (100 * (1 - p.reloadT / w.reload)).toFixed(0) + '%';
    for (let i = 0; i < 3; i++) { cls('sh' + i, slots[i], 'have', !!p.weapons[i]); cls('sn' + i, slots[i], 'none', !p.weapons[i]); cls('sc' + i, slots[i], 'cur', p.cur === i); }
    set('alive', el.alive, 'textContent', String(game.alive)); set('kills', el.kills, 'textContent', String(p.kills));
    // zone readout
    let label, tsec, frac;
    if (z.closed) { label = 'Cordon collapsed'; tsec = 0; frac = 1; }
    else if (z.state === 'shrink') { label = 'Cordon closing'; tsec = z.timer; frac = 1 - z.timer / ZONE_PHASES[z.phase].shrink; }
    else { label = 'Cordon closes in'; tsec = z.timer; frac = 1 - z.timer / ZONE_PHASES[z.phase].wait; }
    set('zl', el.zonelabel, 'textContent', label); set('zt', el.zonetime, 'textContent', fmt(tsec));
    style('zf', el.zonefill, 'width', (100 * Math.max(0, Math.min(1, frac))).toFixed(1) + '%');
    cls('zc', el.zonebox, 'closing', z.state !== 'wait');
    set('place', el.place, 'textContent', placeOf(a.x, a.z) || 'Open ground');
    style('warn', el.warn, 'opacity', p.alive && p.outside ? '1' : '0');
    style('zv', el.zonevig, 'opacity', p.alive && p.outside ? '1' : '0');
    if (p.alive && p.outside && !p.ai) hint('zone', 'Move', 'Follow the white line on the map into the ring', 1);
    if (p.alive && p.hp < 45 && p.medkits > 0 && p.healT <= 0 && game.time - p.lastHurtT > 1.5 && !p.ai) hint('heal', 'H', 'Use a medkit');
    // crosshair
    const scoped = view.scoped, dropping = p.state === 'drop';
    style('scope', el.scope, 'opacity', scoped ? '1' : '0');
    style('crossv', el.cross, 'opacity', scoped || dropping || !p.alive ? '0' : '1');
    if (!scoped) {
      let gap = 5;
      if (w) {
        let sp = w.hipSpread + (w.adsSpread - w.hipSpread) * p.ads + p.bloom * (1 - 0.55 * p.ads) + w.moveSpread * Math.min(1, p.speed / ACTOR.SPRINT) * (1 - 0.45 * p.ads);
        if (!p.onGround) sp += 2.2;
        if (p.crouch) sp *= 0.72;
        gap = Math.round(3 + Math.tan(sp * Math.PI / 180) / Math.tan(camera.fov * Math.PI / 360) * (window.innerHeight / 2));
      }
      if (last.gap !== gap) {
        last.gap = gap;
        crossI.t.style.top = (-gap - 9) + 'px'; crossI.b.style.top = gap + 'px'; crossI.l.style.left = (-gap - 9) + 'px'; crossI.r.style.left = gap + 'px';
      }
    }
    cls('unarmed', el.cross, 'hidden', false);
    // hitmarker, vignette, heal ring
    if (hitT > 0) { hitT -= dt; el.hit.style.opacity = Math.max(0, Math.min(1, hitT * 9)); cls('hk', el.hit, 'kill', hitKill); } else if (last.hitOff !== true) { el.hit.style.opacity = 0; }
    last.hitOff = hitT <= 0;
    vigT = Math.max(0, vigT - dt * 1.6);
    const low = p.alive && p.hp < 35 ? 0.3 + 0.16 * Math.sin(performance.now() * 0.006) : 0;
    el.vig.style.opacity = Math.max(vigT, low).toFixed(3);
    const healing = p.healT > 0;
    style('hr', el.healring, 'opacity', healing ? '1' : '0');
    if (healing) el.healarc.setAttribute('stroke-dashoffset', (201 * (p.healT / ACTOR.HEAL_TIME)).toFixed(1));
    // damage direction arcs
    const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw), rx = Math.cos(a.yaw), rz = -Math.sin(a.yaw);
    for (const arc of arcs) {
      if (arc.life <= 0) continue;
      arc.life -= dt;
      const ang = Math.atan2(arc.dx * rx + arc.dz * rz, arc.dx * fx + arc.dz * fz);
      arc.a.style.transform = `rotate(${ang}rad)`;
      arc.a.style.opacity = Math.max(0, Math.min(1, arc.life * 1.4)).toFixed(2);
    }
    // floating damage numbers
    const W = window.innerWidth, Hh = window.innerHeight;
    for (const n of nums) {
      if (n.life <= 0) continue;
      n.life -= dt; n.y += dt * 1.1;
      if (n.life <= 0) { n.n.style.opacity = 0; continue; }
      v3.set(n.x, n.y, n.z).project(camera);
      if (v3.z > 1 || v3.z < -1) { n.n.style.opacity = 0; continue; }
      n.n.style.transform = `translate(${((v3.x * 0.5 + 0.5) * W + n.ox).toFixed(1)}px, ${((-v3.y * 0.5 + 0.5) * Hh).toFixed(1)}px) translate(-50%,-50%) scale(${(1 + Math.max(0, n.life - 0.7) * 3).toFixed(2)})`;
      n.n.style.opacity = Math.min(1, n.life * 3).toFixed(2);
    }
    // prompts
    if (promptT > 0) { promptT -= dt; if (promptT <= 0.5) el.prompt.style.opacity = 0; }
    if (bannerT > 0) { bannerT -= dt; if (bannerT <= 0) el.banner.style.opacity = 0; }
    cls('drop', el.dropinfo, 'hidden', !dropping);
    if (dropping) set('alt', el.alt, 'textContent', Math.max(0, Math.round(p.y - world.heightAt(p.x, p.z))) + ' m');
    // maps and compass: 30 Hz is plenty
    mapTick += dt;
    if (mapTick > 1 / 30) { mapTick = 0; drawMinimap(game, a, a.yaw); drawCompass(a.yaw); if (mapOpen) drawBigMap(game, a); }
  }

  function showPerf(text) { if (perfOn) el.perf.textContent = text; }

  function showEnd(game) {
    promptT = 0; el.prompt.style.opacity = 0; el.toasts.innerHTML = '';
    const p = game.player, win = p.alive && game.over;
    el.end.classList.remove('hidden'); el.end.classList.toggle('win', win); el.end.classList.toggle('loss', !win);
    el.endtitle.textContent = win ? 'Last operator standing' : 'Eliminated';
    el.endplace.innerHTML = `Placed <b>#${win ? 1 : p.place}</b> of ${game.total}`;
    let sub = '';
    if (win) sub = 'The Cordon is yours';
    else if (p.killerId >= 0) { const k = game.actors[p.killerId]; sub = `Taken out by ${k.name}` + (k.cur >= 0 ? ` · ${WEAPONS[k.cur].name}` : ''); }
    else sub = 'Lost to the Cordon';
    el.endsub.textContent = sub;
    el.skills.textContent = p.kills; el.sdmg.textContent = Math.round(p.dmgDealt);
    el.sacc.textContent = p.shots ? Math.round(100 * p.hits / p.shots) + '%' : '0%';
    el.shead.textContent = p.headshots; el.stime.textContent = fmt(win ? game.time : p.deathT);
  }

  function reset() {
    for (const n of nums) { n.life = 0; n.n.style.opacity = 0; }
    for (const a of arcs) { a.life = 0; a.a.style.opacity = 0; }
    el.feed.innerHTML = ''; el.toasts.innerHTML = '';
    hitT = 0; vigT = 0; promptT = 0; bannerT = 0; state.hurtOnce = false;
    for (const k of Object.keys(hintCount)) delete hintCount[k];
    for (const k of Object.keys(last)) delete last[k];
    el.prompt.style.opacity = 0; el.banner.style.opacity = 0; el.hit.style.opacity = 0; el.vig.style.opacity = 0;
    el.end.classList.add('hidden');
    mapOpen = false; el.bigmap.classList.add('hidden');
  }

  return {
    update, onEvent, reset, showEnd, showPerf, banner, hint, toast,
    setVisible(v) { el.hud.classList.toggle('hidden', !v); if (!v) { el.scope.style.opacity = 0; el.vig.style.opacity = 0; el.zonevig.style.opacity = 0; last.scope = undefined; last.zv = undefined; } },
    toggleMap(force) { mapOpen = force == null ? !mapOpen : force; el.bigmap.classList.toggle('hidden', !mapOpen); mapTick = 1; return mapOpen; },
    setTouch(on) {
      state.touch = on;
      if (on) el.dropinfo.innerHTML = '<b id="alt">150 m</b>Steer with the <span style="color:var(--amber)">left stick</span> &middot; land near buildings for gear';
      el.alt = document.getElementById('alt');
    },
    togglePerf() { perfOn = !perfOn; el.perf.classList.toggle('hidden', !perfOn); return perfOn; },
    get perfOn() { return perfOn; },
  };
}
