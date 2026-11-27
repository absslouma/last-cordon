// Tiny zero-dependency static file server for LAST CORDON.
// Usage: node server.mjs [port] [--open]
//   port    default 5173; if it is busy the next free port is used
//   --open  open the game in the default browser once the server is listening
// Listens on every network interface so a phone on the same Wi-Fi can join; the address to type
// on the phone is printed at start-up.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { attachRooms } from './src/net/rooms.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

// Local network addresses, home Wi-Fi first; VPN, WSL and virtual-machine adapters last.
function lanAddresses() {
  const virtual = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|OpenVPN|TAP|Tailscale|ZeroTier|docker|vpn/i;
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
  }
  const rank = (a) => (virtual.test(a.name) ? 10 : 0) + (a.ip.startsWith('192.168.') ? 0 : a.ip.startsWith('10.') ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b));
}

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  if (urlPath === '/') urlPath = '/index.html';
  // The page ships its icon inline; answer stray favicon probes without a 404 in the console.
  if (urlPath === '/favicon.ico') { res.writeHead(204); return res.end(); }

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found: ' + urlPath);
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(filePath).pipe(res);
  });
});

const args = process.argv.slice(2);
const wantOpen = args.includes('--open');
// multiplayer rooms share this server's port (WebSocket at /ws)
attachRooms(server, { test: args.includes('--test'), log: (m) => console.log(`[rooms] ${m}`) });
let port = Number(args.find((a) => /^\d+$/.test(a)) || process.env.PORT || 5173);
const maxPort = port + 20;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < maxPort) { port += 1; server.listen(port, '0.0.0.0'); }
  else { console.error(e.message); process.exit(1); }
});
server.on('listening', () => {
  const local = `http://localhost:${port}/`;
  const lan = lanAddresses();
  console.log('LAST CORDON is running');
  console.log(`  On this PC:     ${local}`);
  if (lan.length) {
    console.log(`  On your phone:  http://${lan[0].ip}:${port}/   (phone on the same Wi-Fi)`);
    for (const a of lan.slice(1)) console.log(`  also reachable: http://${a.ip}:${port}/   (${a.name})`);
  }
  if (wantOpen) {
    const url = lan.length ? `http://${lan[0].ip}:${port}/` : local;
    console.log('Opening your browser. Keep this window open while you play; close it to stop the server.');
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
server.listen(port, '0.0.0.0');
