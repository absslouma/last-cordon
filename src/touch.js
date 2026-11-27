// On-screen controls for phones and tablets: a floating move stick under the left thumb,
// drag-to-look under the right thumb, and a button cluster around a big fire button (drag the
// fire button to keep aiming while you shoot). Everything writes into the same input state the
// keyboard and mouse use, so the game itself does not know which one is in use.

export function isTouchDevice(params) {
  if (params.get('touch') === '1') return true;
  if (params.get('touch') === '0') return false;
  return navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches;
}

const CROSS = '<svg viewBox="0 0 40 40" width="46%" height="46%"><circle cx="20" cy="20" r="11" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M20 3v9M20 28v9M3 20h9M28 20h9" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';

export function createTouch(input, hooks) {
  const root = document.createElement('div');
  root.id = 'tc';
  root.className = 'layer hidden';
  root.innerHTML = `
    <div id="tc-move" class="tcz"></div>
    <div id="tc-look" class="tcz"></div>
    <div id="tc-stick"><i></i></div>
    <div id="tc-top"><div class="tcs" data-a="map">Map</div><div class="tcs" data-a="pause">&#10073;&#10073;</div></div>
    <div id="tc-slots"><div class="tcw" data-s="0">Warden</div><div class="tcw" data-s="1">Hornet</div><div class="tcw" data-s="2">Lance</div></div>
    <div class="tcb fire" data-a="fire" id="tc-fire">${CROSS}</div>
    <div class="tcb fire" data-a="fire" id="tc-fire2">${CROSS}</div>
    <div class="tcb" data-a="jump">Jump</div>
    <div class="tcb" data-a="reload">Reload</div>
    <div class="tcb" data-a="aim">Aim</div>
    <div class="tcb" data-a="crouch">Crouch</div>
    <div class="tcb kit" data-a="wall">Wall<b>3</b></div>
    <div class="tcb kit" data-a="heal">Heal<b>0</b></div>`;
  document.body.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const btn = (a) => root.querySelector(`.tcb[data-a="${a}"]`);
  const stickEl = $('#tc-stick'), knob = stickEl.firstElementChild;
  const wallB = btn('wall').querySelector('b'), healB = btn('heal').querySelector('b');
  const slots = [...root.querySelectorAll('.tcw')];

  input.stick = input.stick || { x: 0, y: 0, active: false };
  let sens = 2.4;           // multiplier on the mouse sensitivity: one screen pixel of drag
  let scale = 1, R = 58;    // layout scale and stick radius (px)
  const move = { id: -1, cx: 0, cy: 0 };
  const look = { id: -1, x: 0, y: 0 };
  const fires = new Map();

  // A touch must never turn into scrolling, zooming or synthetic mouse clicks.
  root.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  const capture = (el, e) => { try { el.setPointerCapture(e.pointerId); } catch (err) { /* already released */ } };
  const addLook = (dx, dy) => { input.mdx += dx * sens; input.mdy += dy * sens; };

  // ---------------------------------------------------------------- move stick
  function stickAt(x, y) {
    stickEl.style.transform = `translate(${x - R}px, ${y - R}px)`;
  }
  function idleStick() {
    stickEl.classList.remove('live');
    stickAt(120 * scale, window.innerHeight - 110 * scale);
    knob.style.transform = 'translate(-50%, -50%)';
  }
  const mz = $('#tc-move');
  mz.addEventListener('pointerdown', (e) => {
    if (move.id !== -1) return;
    e.preventDefault(); capture(mz, e);
    move.id = e.pointerId; move.cx = e.clientX; move.cy = e.clientY;
    input.stick.active = true; input.stick.x = 0; input.stick.y = 0;
    stickEl.classList.add('live');
    stickAt(move.cx, move.cy);
    knob.style.transform = 'translate(-50%, -50%)';
  });
  mz.addEventListener('pointermove', (e) => {
    if (e.pointerId !== move.id) return;
    let dx = e.clientX - move.cx, dy = e.clientY - move.cy;
    const len = Math.hypot(dx, dy);
    if (len > R) { // the base follows a thumb that slides past the rim
      move.cx += (dx / len) * (len - R); move.cy += (dy / len) * (len - R);
      dx = e.clientX - move.cx; dy = e.clientY - move.cy;
      stickAt(move.cx, move.cy);
    }
    input.stick.x = dx / R; input.stick.y = dy / R;
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  });
  const endMove = (e) => {
    if (e.pointerId !== move.id) return;
    move.id = -1;
    input.stick.active = false; input.stick.x = 0; input.stick.y = 0;
    idleStick();
  };
  mz.addEventListener('pointerup', endMove);
  mz.addEventListener('pointercancel', endMove);

  // ---------------------------------------------------------------- look
  const lz = $('#tc-look');
  lz.addEventListener('pointerdown', (e) => {
    if (look.id !== -1) return;
    e.preventDefault(); capture(lz, e);
    look.id = e.pointerId; look.x = e.clientX; look.y = e.clientY;
  });
  lz.addEventListener('pointermove', (e) => {
    if (e.pointerId !== look.id) return;
    addLook(e.clientX - look.x, e.clientY - look.y);
    look.x = e.clientX; look.y = e.clientY;
  });
  const endLook = (e) => { if (e.pointerId === look.id) look.id = -1; };
  lz.addEventListener('pointerup', endLook);
  lz.addEventListener('pointercancel', endLook);

  // ---------------------------------------------------------------- buttons
  const TAP = { reload: 'KeyR', crouch: 'KeyC', wall: 'KeyG', heal: 'KeyH' };
  for (const el of root.querySelectorAll('.tcb')) {
    const a = el.dataset.a;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation(); capture(el, e);
      el.classList.add('down');
      if (a === 'fire') { fires.set(e.pointerId, { x: e.clientX, y: e.clientY }); input.lmb = true; }
      else if (a === 'jump') input.keys.add('Space');
      else if (a === 'aim') input.rmb = !input.rmb;
      else if (TAP[a]) input.edges.add(TAP[a]);
      if (navigator.vibrate && a !== 'fire') try { navigator.vibrate(8); } catch (err) { /* not allowed */ }
    });
    el.addEventListener('pointermove', (e) => {
      const f = fires.get(e.pointerId);
      if (!f) return;
      addLook(e.clientX - f.x, e.clientY - f.y);
      f.x = e.clientX; f.y = e.clientY;
    });
    const up = (e) => {
      el.classList.remove('down');
      if (a === 'fire') { fires.delete(e.pointerId); if (fires.size === 0) input.lmb = false; }
      else if (a === 'jump') input.keys.delete('Space');
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  for (const el of slots) {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); input.edges.add('Digit' + (Number(el.dataset.s) + 1)); });
  }
  for (const el of root.querySelectorAll('.tcs')) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (el.dataset.a === 'map') hooks.map(); else hooks.pause();
    });
  }
  // the minimap and the open full map are tap targets too
  for (const id of ['minimap', 'bigmap']) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('pointerdown', (e) => { e.preventDefault(); hooks.map(); });
  }

  // ---------------------------------------------------------------- layout
  function place(el, side, x, bottom, size) {
    el.style.width = el.style.height = size + 'px';
    el.style[side] = (x - size / 2) + 'px';
    el.style.bottom = (bottom - size / 2) + 'px';
  }
  function layout() {
    scale = Math.max(0.8, Math.min(1.35, Math.min(window.innerWidth, window.innerHeight) / 390));
    const s = scale;
    R = 58 * s;
    stickEl.style.width = stickEl.style.height = 2 * R + 'px';
    const fx = 82 * s, fy = 112 * s;           // fire button centre, measured from the bottom-right corner
    place($('#tc-fire'), 'right', fx, fy, 94 * s);
    const ring = (a, deg, r, size) => {
      const t = (deg * Math.PI) / 180;
      place(btn(a), 'right', fx - r * Math.cos(t), fy + r * Math.sin(t), size);
    };
    ring('jump', 95, 98 * s, 50 * s);
    ring('reload', 126, 98 * s, 50 * s);
    ring('aim', 157, 98 * s, 54 * s);
    ring('crouch', 188, 98 * s, 50 * s);
    ring('wall', 147, 166 * s, 52 * s);
    ring('heal', 178, 166 * s, 52 * s);
    // second fire button for the left thumb: up and right of the stick, clear of the minimap panel
    place($('#tc-fire2'), 'left', 212 * s, Math.max(window.innerHeight - 178 * s, 190 * s), 60 * s);
    root.style.setProperty('--tcs', s);
    if (move.id === -1) idleStick();
  }
  window.addEventListener('resize', layout);
  layout();

  // ---------------------------------------------------------------- per-frame state
  let shown = false;
  function update(game, active) {
    if (active !== shown) {
      shown = active;
      root.classList.toggle('hidden', !active);
      if (!active) release();
    }
    if (!active) return;
    const p = game.player;
    root.classList.toggle('drop', p.state === 'drop');
    root.classList.toggle('mapopen', !document.getElementById('bigmap').classList.contains('hidden'));
    btn('aim').classList.toggle('on', input.rmb);
    btn('crouch').classList.toggle('on', !!p.crouch);
    if (wallB.textContent !== String(p.walls)) wallB.textContent = p.walls;
    if (healB.textContent !== String(p.medkits)) healB.textContent = p.medkits;
    btn('wall').classList.toggle('empty', p.walls === 0);
    btn('heal').classList.toggle('empty', p.medkits === 0 || p.hp >= 99.5);
    btn('reload').classList.toggle('empty', p.cur < 0);
    for (let i = 0; i < 3; i++) {
      slots[i].classList.toggle('have', !!p.weapons[i]);
      slots[i].classList.toggle('cur', p.cur === i);
    }
  }

  // drop every held control (pause, end of match, app switched away)
  function release() {
    move.id = -1; look.id = -1; fires.clear();
    input.stick.active = false; input.stick.x = 0; input.stick.y = 0;
    input.lmb = false; input.rmb = false; input.keys.delete('Space');
    for (const el of root.querySelectorAll('.down')) el.classList.remove('down');
    idleStick();
  }

  return { root, update, release, setSens(v) { sens = v; }, get sens() { return sens; } };
}
