'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { WebSocketServer } = require('ws');
const { Room, CFG } = require('./room');

const PORT = process.env.PORT || 3000;
const GRACE_MS = 20000;            // how long a disconnected player keeps their seat
const MAX_ROOMS = 500;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ---------- static files ---------- */
const FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/engine.js': ['shared/engine.js', 'application/javascript; charset=utf-8']
};
const cache = {};
for (const [url, [file, type]] of Object.entries(FILES)) cache[url] = { body: fs.readFileSync(path.join(__dirname, file)), type };

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200); res.end('ok'); return; }
  const f = cache[url];
  if (!f) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  res.end(f.body);
});

/* ---------- state ---------- */
const rooms = new Map();           // code -> Room
const clients = new Map();         // token -> client (survives reconnects)
let nextId = 1;

const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>&"']/g, '').trim().slice(0, 14);
const num = v => (Number.isFinite(+v) ? Math.max(-1, Math.min(1, +v)) : 0);

function newCode() {
  for (;;) {
    let s = '';
    for (let i = 0; i < 4; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(s)) return s;
  }
}

function send(c, obj) {
  if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj));
}

function leaveRoom(c) {
  if (!c.room) return;
  c.room.leave(c.id);
  c.room = null; c.player = null;
}

function joinRoom(c, room) {
  if (c.room) leaveRoom(c);
  const p = room.join(c);
  if (!p) { send(c, { t: 'err', m: 'Room is full' }); return; }
  c.room = room; c.player = p;
}

/* ---------- message handling ---------- */
function hello(ws, m) {
  const token = String(m.token || '').replace(/[^\w-]/g, '').slice(0, 40) || crypto.randomBytes(8).toString('hex');
  let c = clients.get(token);
  if (c) {
    clearTimeout(c.grace);
    if (c.ws && c.ws !== ws) { try { c.ws.close(); } catch (e) { /* ignore */ } }
  } else {
    c = { id: nextId++, token, name: '', ws: null, room: null, player: null, grace: null, msgs: 0 };
    clients.set(token, c);
  }
  c.ws = ws;
  c.name = cleanName(m.name) || c.name || 'Player' + c.id;
  if (c.player) { c.player.connected = true; c.player.name = c.name; }
  send(c, { t: 'hi', id: c.id, name: c.name, cfg: CFG, inRoom: !!c.room });
  if (c.room) c.room.sendMeta();
  return c;
}

function handle(c, m) {
  const room = c.room;
  switch (m.t) {
    case 'i':
      if (room) room.pushInput(c.id, m.s | 0, num(m.x), num(m.y));
      break;
    case 'p':
      send(c, { t: 'p', c: m.c });
      break;
    case 'name': {
      const n = cleanName(m.name);
      if (!n) break;
      c.name = n;
      if (c.player) { c.player.name = n; room.sendMeta(); }
      break;
    }
    case 'create':
      if (rooms.size >= MAX_ROOMS) { send(c, { t: 'err', m: 'Server is busy, try again later' }); break; }
      {
        const code = newCode();
        const r = new Room(code, () => rooms.delete(code));
        rooms.set(code, r);
        joinRoom(c, r);
      }
      break;
    case 'join': {
      const r = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!r) send(c, { t: 'err', m: 'Room not found' });
      else if (r === room) room.sendMeta();
      else joinRoom(c, r);
      break;
    }
    case 'leave':
      leaveRoom(c);
      send(c, { t: 'left' });
      break;
    case 'team': {
      const err = room && room.setTeam(c.id, m.team | 0);
      if (err) send(c, { t: 'err', m: err });
      break;
    }
    case 'settings':
      if (room) room.setSettings(c.id, { timeLimit: m.timeLimit | 0, goalLimit: m.goalLimit | 0 });
      break;
    case 'start':
      if (room) room.start(c.id);
      break;
  }
}

function drop(c) {
  c.ws = null;
  if (!c.room) { clients.delete(c.token); return; }
  c.player.connected = false;
  c.room.sendMeta();
  c.grace = setTimeout(() => { leaveRoom(c); clients.delete(c.token); }, GRACE_MS);
}

/* ---------- websocket ---------- */
const wss = new WebSocketServer({ server, maxPayload: 1024, perMessageDeflate: false });

wss.on('connection', ws => {
  let client = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'hello') { client = hello(ws, m); return; }
    if (!client) return;
    if (++client.msgs > 240) return;                     // flood guard (reset every second)
    handle(client, m);
  });
  ws.on('close', () => { if (client && client.ws === ws) drop(client); });
  ws.on('error', () => {});
});

setInterval(() => { for (const c of clients.values()) c.msgs = 0; }, 1000);
setInterval(() => {                                      // keep proxies from closing idle sockets
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000);

/* ---------- fixed 60 Hz game loop ---------- */
const TICK_MS = 1000 / 60;
let last = performance.now(), acc = 0;
setInterval(() => {
  const now = performance.now();
  acc = Math.min(acc + now - last, 250);
  last = now;
  while (acc >= TICK_MS) {
    for (const r of rooms.values()) r.tick();
    acc -= TICK_MS;
  }
}, 4);

server.listen(PORT, '0.0.0.0', () => console.log('Pixel Football listening on :' + PORT));
process.on('SIGTERM', () => { wss.close(); server.close(() => process.exit(0)); });
