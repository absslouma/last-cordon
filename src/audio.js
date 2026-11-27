// Procedural audio for LAST CORDON. Every sound is synthesised with the Web Audio API: filtered
// noise bursts and oscillators for gunfire, steps, impacts, the Bulwark, the Cordon hum and the UI.
// Gunshots are layered (crack / body / thump), low-passed and delayed by distance, with a
// generated-impulse reverb tail. Safe to call before the context exists or while it is suspended.

export function createAudio() {
  let ctx = null, master = null, wet = null, noise = null, ready = false;
  let humGain = null, humFilter = null, windGain = null, ambGain = null, crackleT = 0, birdT = 4;
  const lis = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };
  let voices = 0;

  function init() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { return false; }
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 18; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.18;
    master = ctx.createGain(); master.gain.value = 0.85;
    master.connect(comp); comp.connect(ctx.destination);
    // 2 s of white noise shared by everything
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    // generated impulse response: decaying, progressively duller noise = open-air slapback
    const irLen = Math.floor(ctx.sampleRate * 2.4), ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen, k = 0.5 - t * 0.42;
        lp += (Math.random() * 2 - 1 - lp) * k;
        d[i] = lp * Math.pow(1 - t, 2.6) * (i < 400 ? i / 400 : 1);
      }
      for (const [at, g] of [[0.11, 0.5], [0.23, 0.32], [0.41, 0.2]]) { const o = Math.floor(at * ctx.sampleRate * (1 + c * 0.07)); for (let i = 0; i < 300 && o + i < irLen; i++) d[o + i] += (Math.random() * 2 - 1) * g * (1 - i / 300); }
    }
    const conv = ctx.createConvolver(); conv.buffer = ir;
    wet = ctx.createGain(); wet.gain.value = 0.55;
    wet.connect(conv); conv.connect(master);
    // continuous beds
    const loop = (freq, q, type) => { const s = ctx.createBufferSource(); s.buffer = noise; s.loop = true; const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; s.connect(f); f.connect(g); g.connect(master); s.start(); return { g, f }; };
    const amb = loop(420, 0.4, 'lowpass'); ambGain = amb.g;
    const wnd = loop(700, 0.7, 'bandpass'); windGain = wnd.g;
    humFilter = ctx.createBiquadFilter(); humFilter.type = 'lowpass'; humFilter.frequency.value = 320;
    humGain = ctx.createGain(); humGain.gain.value = 0;
    for (const [f, type, g] of [[54, 'sawtooth', 0.5], [54.7, 'sawtooth', 0.5], [108.5, 'square', 0.16], [163, 'sine', 0.2]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; const og = ctx.createGain(); og.gain.value = g; o.connect(og); og.connect(humFilter); o.start();
    }
    humFilter.connect(humGain); humGain.connect(master);
    ready = true;
    return true;
  }
  function resume() { if (!init()) return; if (ctx.state === 'suspended') ctx.resume().catch(() => {}); }
  const ok = () => ready && ctx.state === 'running' && voices < 70;

  function out(pan) {
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0));
    p.connect(master);
    return p;
  }
  function burst(o) { // filtered noise with an exponential envelope
    const t = o.when || ctx.currentTime, s = ctx.createBufferSource(); s.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = o.type || 'bandpass'; f.frequency.value = o.freq; f.Q.value = o.q || 0.8;
    if (o.freq2) f.frequency.exponentialRampToValueAtTime(Math.max(30, o.freq2), t + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t + (o.attack || 0.002)); g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    s.connect(f); f.connect(g); g.connect(o.dest);
    if (o.send && o.send > 0) { const sg = ctx.createGain(); sg.gain.value = o.send; g.connect(sg); sg.connect(wet); }
    voices++; s.onended = () => { voices--; };
    s.start(t, Math.random() * 1.5); s.stop(t + o.dur + 0.03);
  }
  function tone(o) {
    const t = o.when || ctx.currentTime, osc = ctx.createOscillator(); osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.freq2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freq2), t + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), t + (o.attack || 0.004)); g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(g); g.connect(o.dest);
    if (o.send) { const sg = ctx.createGain(); sg.gain.value = o.send; g.connect(sg); sg.connect(wet); }
    voices++; osc.onended = () => { voices--; };
    osc.start(t); osc.stop(t + o.dur + 0.03);
  }
  // distance and pan of a world position relative to the listener
  function place(x, z) {
    const dx = x - lis.x, dz = z - lis.z, d = Math.hypot(dx, dz);
    return { d, pan: d > 0.5 ? ((dx * lis.rx + dz * lis.rz) / d) * Math.min(1, d / 6) * 0.85 : 0 };
  }

  const GUN = [
    { crack: 2600, body: 620, thump: 150, len: 0.24, gain: 0.95, tail: 0.5 },   // assault rifle
    { crack: 3400, body: 900, thump: 190, len: 0.15, gain: 0.72, tail: 0.3 },   // SMG
    { crack: 1900, body: 380, thump: 95, len: 0.55, gain: 1.35, tail: 0.95 },   // sniper
  ];
  function gunshot(weapon, x, z, own) {
    if (!ok()) return;
    const g = GUN[weapon] || GUN[0], pl = own ? { d: 0, pan: 0.12 } : place(x, z);
    if (pl.d > 300) return;
    const att = own ? 1 : 1 / (1 + pl.d * 0.055 + pl.d * pl.d * 0.00035);
    const when = ctx.currentTime + Math.min(0.75, pl.d / 343);
    const dest = out(pl.pan), far = Math.min(1, pl.d / 170), vol = g.gain * att;
    const j = 0.92 + Math.random() * 0.16;
    if (far < 0.85) burst({ dest, when, type: 'highpass', freq: g.crack * j * (1 - far * 0.6), q: 0.7, gain: vol * 0.75 * (1 - far), dur: 0.05 + g.len * 0.25, send: g.tail * 0.5 });
    burst({ dest, when, type: 'lowpass', freq: g.body * j * (1.6 - far), freq2: g.body * 0.3, q: 0.9, gain: vol * 0.9, dur: g.len * (1 + far * 0.8), send: g.tail * (0.5 + far) });
    tone({ dest, when, freq: g.thump * j, freq2: g.thump * 0.36, gain: vol * 0.95, dur: g.len * 0.55 + 0.05 });
    if (own) burst({ dest, when: when + 0.035, type: 'bandpass', freq: 5200, q: 2, gain: 0.07, dur: 0.05 }); // action cycling
  }
  function impact(x, z, kind) {
    if (!ok()) return;
    const pl = place(x, z);
    if (pl.d > 55) return;
    const att = 0.5 / (1 + pl.d * 0.12), dest = out(pl.pan);
    if (kind === 'container' || kind === 'tank' || kind === 'vehicle' || kind === 'prop') { tone({ dest, freq: 1900 + Math.random() * 1400, freq2: 900, gain: att * 0.5, dur: 0.12, type: 'triangle' }); burst({ dest, freq: 4200, q: 3, gain: att * 0.5, dur: 0.05 }); }
    else burst({ dest, type: 'bandpass', freq: 900 + Math.random() * 700, q: 0.9, gain: att * 0.6, dur: 0.07 });
  }
  function whiz(x, z) {
    if (!ok()) return;
    const pl = place(x, z);
    burst({ dest: out(pl.pan), type: 'bandpass', freq: 2600, freq2: 900, q: 6, gain: 0.16, dur: 0.11 });
  }
  function step(x, z, own, sprint, wet2) {
    if (!ok()) return;
    const pl = own ? { d: 0, pan: (Math.random() - 0.5) * 0.25 } : place(x, z);
    if (pl.d > 34) return;
    const att = (own ? 0.11 : 0.26) / (1 + pl.d * 0.16) * (sprint ? 1.25 : 1), dest = out(pl.pan);
    burst({ dest, type: 'lowpass', freq: wet2 ? 1400 : 520 + Math.random() * 260, q: 0.7, gain: att, dur: 0.07 });
    tone({ dest, freq: 82 + Math.random() * 24, freq2: 48, gain: att * 0.8, dur: 0.06 });
  }
  function land(x, z, own, hard) {
    if (!ok()) return;
    const pl = own ? { d: 0, pan: 0 } : place(x, z);
    if (pl.d > 40) return;
    const att = (hard ? 0.5 : 0.3) / (1 + pl.d * 0.12), dest = out(pl.pan);
    tone({ dest, freq: 110, freq2: 40, gain: att, dur: 0.16 }); burst({ dest, type: 'lowpass', freq: 700, gain: att * 0.8, dur: 0.14 });
  }
  function reload(weapon, dur) {
    if (!ok()) return;
    const dest = out(0.1), t = ctx.currentTime;
    burst({ dest, when: t + 0.12, freq: 2300, q: 3, gain: 0.16, dur: 0.045 }); tone({ dest, when: t + 0.13, freq: 420, freq2: 210, gain: 0.08, dur: 0.06, type: 'square' });
    burst({ dest, when: t + dur * 0.55, freq: 1500, q: 2.5, gain: 0.2, dur: 0.05 }); tone({ dest, when: t + dur * 0.56, freq: 300, freq2: 160, gain: 0.1, dur: 0.07, type: 'square' });
    burst({ dest, when: t + dur * 0.86, freq: 3200, q: 4, gain: 0.2, dur: 0.035 }); burst({ dest, when: t + dur * 0.9, freq: 1100, q: 2, gain: 0.22, dur: 0.06 });
  }
  function dry() { if (ok()) burst({ dest: out(0.1), freq: 3000, q: 5, gain: 0.12, dur: 0.03 }); }
  function swap() { if (ok()) { const dest = out(0.1); burst({ dest, freq: 1300, q: 2, gain: 0.14, dur: 0.06 }); burst({ dest, when: ctx.currentTime + 0.12, freq: 2600, q: 3, gain: 0.12, dur: 0.04 }); } }
  function wallDeploy(x, z) {
    if (!ok()) return;
    const pl = place(x, z);
    if (pl.d > 90) return;
    const att = 1 / (1 + pl.d * 0.07), dest = out(pl.pan);
    tone({ dest, freq: 180, freq2: 1500, gain: 0.3 * att, dur: 0.2, type: 'sawtooth', send: 0.3 });
    tone({ dest, freq: 720, freq2: 2900, gain: 0.16 * att, dur: 0.26, type: 'sine', send: 0.4 });
    burst({ dest, type: 'highpass', freq: 5200, gain: 0.26 * att, dur: 0.32, send: 0.5 });
    tone({ dest, when: ctx.currentTime + 0.16, freq: 95, freq2: 42, gain: 0.55 * att, dur: 0.22 });
  }
  function wallHit(x, z) {
    if (!ok()) return;
    const pl = place(x, z);
    if (pl.d > 70) return;
    const att = 0.5 / (1 + pl.d * 0.09), dest = out(pl.pan), f = 2100 + Math.random() * 1300;
    tone({ dest, freq: f, freq2: f * 0.82, gain: 0.22 * att, dur: 0.16, type: 'sine' }); tone({ dest, freq: f * 1.52, gain: 0.1 * att, dur: 0.09, type: 'sine' });
    burst({ dest, type: 'highpass', freq: 6000, gain: 0.12 * att, dur: 0.04 });
  }
  function wallBreak(x, z) {
    if (!ok()) return;
    const pl = place(x, z);
    if (pl.d > 90) return;
    const att = 1 / (1 + pl.d * 0.07), dest = out(pl.pan);
    burst({ dest, type: 'highpass', freq: 3600, freq2: 1400, gain: 0.5 * att, dur: 0.45, send: 0.5 });
    for (let i = 0; i < 5; i++) tone({ dest, when: ctx.currentTime + i * 0.035, freq: 3200 - i * 380 + Math.random() * 200, gain: 0.13 * att, dur: 0.14, type: 'sine' });
    tone({ dest, freq: 130, freq2: 45, gain: 0.4 * att, dur: 0.22 });
  }
  function pickup(kind) {
    if (!ok()) return;
    const dest = out(0), t = ctx.currentTime;
    if (kind === 'ar' || kind === 'smg' || kind === 'sr') { burst({ dest, freq: 1800, q: 2.5, gain: 0.26, dur: 0.06 }); tone({ dest, when: t + 0.07, freq: 260, freq2: 180, gain: 0.16, dur: 0.09, type: 'square' }); burst({ dest, when: t + 0.14, freq: 3000, q: 4, gain: 0.2, dur: 0.04 }); }
    else if (kind === 'medkit') { tone({ dest, freq: 660, gain: 0.14, dur: 0.1 }); tone({ dest, when: t + 0.09, freq: 880, gain: 0.14, dur: 0.14 }); }
    else if (kind === 'vest' || kind === 'helmet') { burst({ dest, type: 'lowpass', freq: 900, gain: 0.3, dur: 0.1 }); tone({ dest, when: t + 0.05, freq: 520, freq2: 780, gain: 0.12, dur: 0.14, type: 'triangle' }); }
    else { burst({ dest, freq: 2400, q: 3, gain: 0.18, dur: 0.04 }); burst({ dest, when: t + 0.07, freq: 2900, q: 3, gain: 0.18, dur: 0.04 }); }
  }
  function heal(done) {
    if (!ok()) return;
    const dest = out(0), t = ctx.currentTime;
    if (done) { tone({ dest, freq: 520, gain: 0.16, dur: 0.12 }); tone({ dest, when: t + 0.1, freq: 780, gain: 0.16, dur: 0.2 }); }
    else { burst({ dest, type: 'bandpass', freq: 3200, q: 1, gain: 0.14, dur: 0.3 }); burst({ dest, when: t + 0.5, freq: 1500, q: 2, gain: 0.12, dur: 0.08 }); }
  }
  function hitmarker(kill, head) {
    if (!ok()) return;
    const dest = out(0), t = ctx.currentTime;
    burst({ dest, freq: head ? 4200 : 3100, q: 5, gain: 0.2, dur: 0.035 }); tone({ dest, freq: head ? 2300 : 1700, gain: 0.09, dur: 0.05 });
    if (kill) { tone({ dest, when: t + 0.06, freq: 520, gain: 0.2, dur: 0.12, type: 'triangle' }); tone({ dest, when: t + 0.16, freq: 780, gain: 0.2, dur: 0.24, type: 'triangle', send: 0.3 }); }
  }
  function hurt(amount) {
    if (!ok()) return;
    const dest = out(0), v = Math.min(0.6, 0.2 + amount * 0.012);
    tone({ dest, freq: 150, freq2: 60, gain: v, dur: 0.14 }); burst({ dest, type: 'lowpass', freq: 1100, gain: v * 0.8, dur: 0.09 });
  }
  function ui(kind) {
    if (!ok()) return;
    const dest = out(0), t = ctx.currentTime;
    if (kind === 'go') { tone({ dest, freq: 330, gain: 0.16, dur: 0.12, type: 'triangle' }); tone({ dest, when: t + 0.1, freq: 495, gain: 0.16, dur: 0.12, type: 'triangle' }); tone({ dest, when: t + 0.2, freq: 660, gain: 0.18, dur: 0.3, type: 'triangle', send: 0.4 }); }
    else { tone({ dest, freq: 900, freq2: 640, gain: 0.1, dur: 0.05 }); burst({ dest, freq: 3600, q: 4, gain: 0.07, dur: 0.02 }); }
  }
  function sting(win) {
    if (!ok()) return;
    const dest = out(0), t = ctx.currentTime;
    const notes = win ? [262, 330, 392, 523, 659] : [196, 185, 147, 110];
    notes.forEach((f, i) => { tone({ dest, when: t + i * (win ? 0.13 : 0.22), freq: f, gain: 0.2, dur: win ? 0.7 : 0.9, type: win ? 'triangle' : 'sawtooth', send: 0.6 }); tone({ dest, when: t + i * (win ? 0.13 : 0.22), freq: f * 0.5, gain: 0.12, dur: 0.9, type: 'sine' }); });
  }
  function zoneAlert() {
    if (!ok()) return;
    const dest = out(0), t = ctx.currentTime;
    for (let i = 0; i < 3; i++) tone({ dest, when: t + i * 0.28, freq: 440, freq2: 415, gain: 0.13, dur: 0.2, type: 'square', send: 0.3 });
  }
  function plane() {
    if (!ok()) return;
    const dest = out(0), t = ctx.currentTime, g = ctx.createGain(), f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 260;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.22, t + 1.2); g.gain.exponentialRampToValueAtTime(0.0001, t + 11);
    for (const fr of [62, 93.5, 124.7]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(fr, t); o.frequency.linearRampToValueAtTime(fr * 0.86, t + 11); o.connect(f); o.start(t); o.stop(t + 11.2); }
    f.connect(g); g.connect(dest);
  }

  // per-frame: listener pose and the continuous beds
  function update(dt, cam, st) {
    lis.x = cam.x; lis.y = cam.y; lis.z = cam.z; lis.rx = cam.rx; lis.rz = cam.rz;
    if (!ready || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    ambGain.gain.setTargetAtTime(st.active ? 0.05 : 0.02, t, 0.5);
    windGain.gain.setTargetAtTime(st.drop ? 0.2 : st.active ? 0.012 + 0.012 * Math.sin(t * 0.3) : 0, t, 0.3);
    const near = Math.max(0, 1 - st.zoneDist / 34);
    humGain.gain.setTargetAtTime(st.active ? Math.max(st.outside ? 0.26 : 0, near * 0.2) : 0, t, 0.25);
    humFilter.frequency.setTargetAtTime(st.outside ? 720 : 300 + near * 240, t, 0.3);
    if (st.active && (near > 0.05 || st.outside)) {
      crackleT -= dt;
      if (crackleT <= 0) { crackleT = 0.08 + Math.random() * 0.5; if (voices < 60) burst({ dest: out((Math.random() - 0.5) * 1.4), type: 'bandpass', freq: 3000 + Math.random() * 4000, q: 6, gain: (st.outside ? 0.11 : 0.06 * near), dur: 0.03 + Math.random() * 0.05 }); }
    }
    if (st.active && !st.drop) {
      birdT -= dt;
      if (birdT <= 0) { birdT = 5 + Math.random() * 11; const dest = out((Math.random() - 0.5) * 1.6), f = 2600 + Math.random() * 1500; for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) tone({ dest, when: t + i * 0.13, freq: f, freq2: f * (1.2 + Math.random() * 0.3), gain: 0.022, dur: 0.09, send: 0.5 }); }
    }
  }
  function silence() { if (ready) { const t = ctx.currentTime; humGain.gain.setTargetAtTime(0, t, 0.1); windGain.gain.setTargetAtTime(0, t, 0.1); } }

  return { init, resume, update, silence, gunshot, impact, whiz, step, land, reload, dry, swap, wallDeploy, wallHit, wallBreak, pickup, heal, hitmarker, hurt, ui, sting, zoneAlert, plane, get state() { return ctx ? ctx.state : 'none'; } };
}
