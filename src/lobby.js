// Multiplayer lobby screens: pick a name, see the rooms open on this network, create or join
// one, and (host) choose settings and start the match.
import { createNet } from './net/client.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DIFF = [['0.7', 'Recruit'], ['1', 'Regular'], ['1.35', 'Veteran']];

export function createLobby({ audio, onStart, onClosed, inMatch }) {
  let view = 'off';          // off | browse | room
  let room = null, rooms = [];
  let savedName = '';
  try { savedName = localStorage.getItem('lc.name') || ''; } catch (e) { /* storage blocked */ }
  if (!savedName) savedName = 'Operator ' + (100 + Math.floor(Math.random() * 900));
  $('mpname').value = savedName;

  const status = (text, bad) => { const s = $('mpstatus'); s.textContent = text; s.classList.toggle('bad', !!bad); };
  const roomStatus = (text, bad) => { const s = $('roomstatus'); s.textContent = text; s.classList.toggle('bad', !!bad); };

  const net = createNet({
    hello(m) { status(`Connected as ${m.name}`); $('mpname').value = m.name; },
    rooms(list) { rooms = list; renderRooms(); },
    room(r) {
      room = r;
      if (!r) { if (view === 'room') show('browse'); return; }
      if (view !== 'off' || !inMatch()) show('room');
      renderRoom();
    },
    start(msg) { show('off'); onStart(msg); },
    error(msg) { if (view === 'room') roomStatus(msg, true); else status(msg, true); },
    closed() {
      room = null;
      status('Disconnected from the game server. Is it still running?', true);
      if (view === 'room') show('browse');
      onClosed();
    },
  });

  function show(v) {
    view = v;
    $('mp').classList.toggle('hidden', v !== 'browse');
    $('room').classList.toggle('hidden', v !== 'room');
  }

  function renderRooms() {
    const box = $('mplist');
    if (!rooms.length) { box.innerHTML = '<div class="mpempty">No rooms yet. Create one and your friends will see it here.</div>'; return; }
    box.innerHTML = rooms.map((r) => {
      const full = r.n >= r.max;
      const st = r.state === 'playing' ? `In match &middot; ${r.alive} alive` : 'Waiting';
      return `<div class="mproom"><div><b>${esc(r.name)}</b><span>Host ${esc(r.host)} &middot; ${st}</span></div>
        <div class="mpn">${r.n}/${r.max}</div><button class="btn ghost" data-join="${r.id}" ${full ? 'disabled' : ''}>${full ? 'Full' : 'Join'}</button></div>`;
    }).join('');
  }

  function renderRoom() {
    if (!room) return;
    const host = room.hostId === net.id;
    $('roomname').textContent = room.name;
    $('roomplayers').innerHTML = room.players.map((p) => `<div class="rp${p.id === net.id ? ' me' : ''}"><span>${esc(p.name)}</span>${p.id === room.hostId ? '<i>Host</i>' : ''}${p.id === net.id ? '<i>You</i>' : ''}${p.inMatch && room.state === 'playing' ? '<i>Playing</i>' : ''}</div>`).join('')
      + `<div class="rpcount cap">${room.players.length} / 20 players</div>`;
    const s = room.settings;
    $('roomsettings').innerHTML = `
      <div class="opt"><span class="cap">Fill empty slots with bots</span><div>${[[true, 'On'], [false, 'Off']].map(([v, l]) => `<button class="btn ghost${s.bots === v ? ' on' : ''}" data-bots="${v}" ${host ? '' : 'disabled'}>${l}</button>`).join('')}</div></div>
      <div class="opt"><span class="cap">Bot skill</span><div>${DIFF.map(([v, l]) => `<button class="btn ghost${String(s.diff) === v ? ' on' : ''}" data-diff="${v}" ${host && s.bots ? '' : 'disabled'}>${l}</button>`).join('')}</div></div>`;
    const playing = room.state === 'playing';
    $('roomstart').classList.toggle('hidden', !host);
    $('roomstart').disabled = playing;
    const total = s.bots ? 20 : room.players.length;
    if (playing) roomStatus(`Match in progress · ${room.alive} alive. You will play the next one.`);
    else if (host) roomStatus(`${room.players.length} player${room.players.length === 1 ? '' : 's'}${s.bots ? ` + ${20 - room.players.length} bots` : ''} · ${total} operators drop. Start when everyone is in.`);
    else roomStatus(`Waiting for ${room.players.find((p) => p.id === room.hostId)?.name || 'the host'} to start the match.`);
  }

  function saveName() {
    const n = $('mpname').value.trim().slice(0, 16) || savedName;
    try { localStorage.setItem('lc.name', n); } catch (e) { /* storage blocked */ }
    return n;
  }

  // ---------------------------------------------------------------- wiring
  $('mplist').addEventListener('click', (e) => {
    const b = e.target.closest('[data-join]');
    if (!b) return;
    audio.ui('tick');
    net.send({ t: 'join', id: Number(b.dataset.join) });
  });
  $('mpcreate').addEventListener('click', () => {
    audio.ui('tick');
    if (!net.connected) return status('Not connected to the game server.', true);
    const nm = saveName();
    if (nm !== net.name) net.send({ t: 'hello', name: nm });
    net.send({ t: 'create', name: $('mproomname').value.trim() || `${nm}'s room` });
  });
  $('mpname').addEventListener('change', () => { const n = saveName(); if (net.connected) net.send({ t: 'hello', name: n }); });
  $('mpback').addEventListener('click', () => { audio.ui('tick'); close(); });
  $('roomleave').addEventListener('click', () => { audio.ui('tick'); net.send({ t: 'leave' }); show('browse'); });
  $('roomstart').addEventListener('click', () => { audio.resume(); audio.ui('go'); roomStatus('Starting…'); net.send({ t: 'start' }); });
  $('roomsettings').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    audio.ui('tick');
    if (b.dataset.bots) net.send({ t: 'set', bots: b.dataset.bots === 'true' });
    if (b.dataset.diff) net.send({ t: 'set', diff: Number(b.dataset.diff) });
  });

  function open() {
    $('menu').classList.add('hidden');
    show(room ? 'room' : 'browse');
    if (!net.connected) { status('Connecting to the game server…'); net.connect(saveName()); }
    else net.send({ t: 'list' });
    renderRooms();
  }
  function close() {
    if (room) net.send({ t: 'leave' });
    room = null;
    net.close();
    show('off');
    $('menu').classList.remove('hidden');
  }

  return {
    net, open, close,
    showRoom() { if (room) { show('room'); renderRoom(); } else show('browse'); },
    leave() { if (room) net.send({ t: 'leave' }); room = null; show('off'); },
    get view() { return view; },
    get room() { return room; },
    get rooms() { return rooms; },
  };
}
