// Keyboard, mouse and pointer-lock handling. The game reads this state object; tests can write to
// it directly or drive it with real DOM events.
export function createInput(canvas, onLockChange) {
  const st = {
    keys: new Set(), edges: new Set(), mdx: 0, mdy: 0, lmb: false, rmb: false, wheel: 0,
    stick: { x: 0, y: 0, active: false },   // analog move stick (touch controls)
    touchMode: false,                      // on phones: mouse events are synthetic, ignore them
    locked: false, free: false, capture: false,
    get active() { return st.locked || st.free; },
    clear() { st.keys.clear(); st.edges.clear(); st.lmb = false; st.rmb = false; st.mdx = 0; st.mdy = 0; st.wheel = 0; st.stick.active = false; st.stick.x = 0; st.stick.y = 0; },
    lock() {
      if (st.free || document.pointerLockElement === canvas) return;
      try {
        const r = canvas.requestPointerLock();
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch (e) { /* pointer lock unavailable: the pause overlay stays up */ }
    },
    unlock() { if (document.pointerLockElement === canvas) document.exitPointerLock(); },
  };
  const GAME_KEYS = new Set(['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F3', 'KeyM']);
  window.addEventListener('keydown', (e) => {
    if (st.capture && GAME_KEYS.has(e.code) && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault();
    if (e.repeat) return;
    st.keys.add(e.code); st.edges.add(e.code);
  });
  window.addEventListener('keyup', (e) => { st.keys.delete(e.code); });
  document.addEventListener('mousemove', (e) => {
    if (!st.active || st.touchMode) return;
    st.mdx += e.movementX || 0; st.mdy += e.movementY || 0;
  });
  canvas.addEventListener('mousedown', (e) => {
    if (st.touchMode) return;
    if (e.button === 0) st.lmb = true; else if (e.button === 2) st.rmb = true;
    if (st.capture) e.preventDefault();
  });
  window.addEventListener('mouseup', (e) => { if (st.touchMode) return; if (e.button === 0) st.lmb = false; else if (e.button === 2) st.rmb = false; });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('wheel', (e) => { if (st.active) st.wheel += Math.sign(e.deltaY); }, { passive: true });
  document.addEventListener('pointerlockchange', () => {
    st.locked = document.pointerLockElement === canvas;
    if (!st.locked) { st.keys.clear(); st.lmb = false; st.rmb = false; }
    if (onLockChange) onLockChange(st.locked);
  });
  document.addEventListener('pointerlockerror', () => { if (onLockChange) onLockChange(false); });
  window.addEventListener('blur', () => { st.keys.clear(); st.lmb = false; st.rmb = false; });
  return st;
}
