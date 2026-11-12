'use strict';

// Neon Pong online 1v1 — Node.js built-ins only (no npm packages required).
// A lightweight WebSocket game server keeps one authoritative ball and score per room.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const WIDTH = 900;
const HEIGHT = 520;
const PADDLE_HEIGHT = 102;
const PADDLE_WIDTH = 15;
const PADDLE_MARGIN = 34;
const BALL_RADIUS = 10;
const MAX_SCORE = 7;
const TICK_MS = 1000 / 60;
const BROADCAST_MS = 1000 / 30;
const ROOM_CAP = 200;
const rooms = new Map();
let nextClientId = 0;

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const publicDir = path.join(__dirname, 'public');
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/game.js': ['game.js', 'application/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const httpServer = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch { res.writeHead(400).end('Bad request'); return; }
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  const target = staticFiles[pathname];
  if (!target || req.method !== 'GET') { res.writeHead(404).end('Not found'); return; }
  fs.readFile(path.join(publicDir, target[0]), (error, data) => {
    if (error) { res.writeHead(500).end('File unavailable'); return; }
    res.writeHead(200, {
      'Content-Type': target[1],
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
    });
    res.end(data);
  });
});

function makeFrame(opcode, payload = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(payload);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x80 | opcode;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

class Client {
  constructor(socket) {
    this.id = ++nextClientId;
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.room = null;
    this.side = -1;
    this.closed = false;
  }
  send(data) {
    if (this.closed || !this.socket.writable) return;
    const content = Buffer.from(JSON.stringify(data), 'utf8');
    if (this.socket.writableLength < 64 * 1024) this.socket.write(makeFrame(1, content));
  }
  close(code = 1000) {
    if (this.closed) return;
    this.socket.write(makeFrame(8, Buffer.from([(code >> 8) & 255, code & 255])));
    this.socket.end();
    this.cleanup();
  }
  cleanup() {
    if (this.closed) return;
    this.closed = true;
    leaveRoom(this);
  }
  receive(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 16384) { this.close(1009); return; }
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 15;
      const fin = (first & 128) !== 0;
      const masked = (second & 128) !== 0;
      let length = second & 127;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > 4096n) { this.close(1009); return; }
        length = Number(big); offset = 10;
      }
      if (!masked || !fin || length > 4096) { this.close(1002); return; }
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4); offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      for (let i = 0; i < length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 8) { this.close(); return; }
      if (opcode === 9) { this.socket.write(makeFrame(10, payload)); continue; }
      if (opcode === 10) continue;
      if (opcode !== 1) { this.close(1003); return; }
      let packet;
      try { packet = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)); }
      catch { this.send({ type: 'error', message: 'Invalid message.' }); continue; }
      if (!packet || typeof packet !== 'object') continue;
      onMessage(this, packet);
    }
  }
}

function randomRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from(crypto.randomBytes(6), b => chars[b % chars.length]).join(''); }
  while (rooms.has(code));
  return code;
}

function newRoom(client) {
  leaveRoom(client);
  if (rooms.size >= ROOM_CAP) { client.send({ type: 'error', message: 'All rooms are busy. Try again soon.' }); return; }
  const code = randomRoomCode();
  const room = {
    code,
    players: [client, null],
    paddle: [HEIGHT / 2, HEIGHT / 2],
    targets: [HEIGHT / 2, HEIGHT / 2],
    ball: { x: WIDTH / 2, y: HEIGHT / 2, vx: 0, vy: 0 },
    scores: [0, 0],
    phase: 'waiting',
    launchAt: 0,
    direction: 1,
    winner: -1,
    speed: 360,
    restartVotes: new Set(),
  };
  rooms.set(code, room);
  client.room = room;
  client.side = 0;
  client.send({ type: 'joined', code, side: 0 });
  announce(room);
}

function joinRoom(client, code) {
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6 || !rooms.has(code)) {
    client.send({ type: 'error', message: 'Room not found. Ask your friend for a new link or code.' });
    return;
  }
  if (client.room && client.room.code === code) {
    client.send({ type: 'joined', code, side: client.side }); return;
  }
  const room = rooms.get(code);
  const side = room.players.findIndex(x => x === null);
  if (side < 0) { client.send({ type: 'error', message: 'That room already has two players.' }); return; }
  leaveRoom(client);
  room.players[side] = client;
  room.paddle[side] = HEIGHT / 2;
  room.targets[side] = HEIGHT / 2;
  client.room = room;
  client.side = side;
  client.send({ type: 'joined', code, side });
  if (room.players.every(Boolean)) resetMatch(room);
  announce(room);
}

function leaveRoom(client) {
  if (!client.room) return;
  const room = client.room;
  const side = client.side;
  client.room = null;
  client.side = -1;
  if (room.players[side] === client) room.players[side] = null;
  room.phase = 'waiting';
  room.restartVotes.clear();
  if (room.players.every(x => x === null)) rooms.delete(room.code);
  else announce(room);
}

function announce(room) {
  const status = {
    type: 'status', code: room.code,
    phase: room.phase,
    present: room.players.map(x => Boolean(x)),
    scores: [...room.scores], winner: room.winner,
  };
  for (const client of room.players) if (client) client.send(status);
}

function serve(room, direction) {
  room.ball = { x: WIDTH / 2, y: HEIGHT / 2, vx: 0, vy: 0 };
  room.speed = 360;
  room.direction = direction;
  room.launchAt = Date.now() + 850;
  room.phase = 'serving';
}

function resetMatch(room) {
  room.scores = [0, 0];
  room.paddle = [HEIGHT / 2, HEIGHT / 2];
  room.targets = [HEIGHT / 2, HEIGHT / 2];
  room.winner = -1;
  room.restartVotes.clear();
  serve(room, Math.random() < 0.5 ? 1 : -1);
}

function onMessage(client, msg) {
  const type = String(msg.type || '');
  if (type === 'create') { newRoom(client); return; }
  if (type === 'join') { joinRoom(client, msg.code); return; }
  if (type === 'leave') { leaveRoom(client); client.send({ type: 'left' }); return; }
  const room = client.room;
  if (!room) return;
  if (type === 'input') {
    if (typeof msg.y !== 'number' || !Number.isFinite(msg.y)) return;
    room.targets[client.side] = clamp(msg.y, PADDLE_HEIGHT / 2, HEIGHT - PADDLE_HEIGHT / 2);
  } else if (type === 'restart' && room.phase === 'finished' && room.players.every(Boolean)) {
    room.restartVotes.add(client.side);
    if (room.restartVotes.size === 2) { resetMatch(room); announce(room); }
    else client.send({ type: 'notice', message: 'Rematch requested. Waiting for your opponent…' });
  }
}

function hitPaddle(room, side) {
  const offset = clamp((room.ball.y - room.paddle[side]) / (PADDLE_HEIGHT / 2), -1, 1);
  room.speed = Math.min(825, room.speed * 1.065);
  const angle = offset * 0.97;
  const direction = side === 0 ? 1 : -1;
  room.ball.vx = Math.cos(angle) * room.speed * direction;
  room.ball.vy = Math.sin(angle) * room.speed;
  room.ball.x = side === 0 ? PADDLE_MARGIN + PADDLE_WIDTH + BALL_RADIUS : WIDTH - PADDLE_MARGIN - PADDLE_WIDTH - BALL_RADIUS;
}

function scorePoint(room, side) {
  room.scores[side]++;
  if (room.scores[side] >= MAX_SCORE) {
    room.phase = 'finished';
    room.winner = side;
    announce(room);
  } else {
    serve(room, side === 0 ? -1 : 1);
  }
}

function gameTick(dt) {
  for (const room of rooms.values()) {
    if (room.phase !== 'serving' && room.phase !== 'playing') continue;
    if (!room.players.every(Boolean)) { room.phase = 'waiting'; continue; }
    for (let i = 0; i < 2; i++) {
      const delta = room.targets[i] - room.paddle[i];
      room.paddle[i] = clamp(room.paddle[i] + clamp(delta, -1100 * dt, 1100 * dt), PADDLE_HEIGHT / 2, HEIGHT - PADDLE_HEIGHT / 2);
    }
    if (room.phase === 'serving') {
      if (Date.now() < room.launchAt) continue;
      const theta = (Math.random() * 2 - 1) * 0.47;
      room.ball.vx = Math.cos(theta) * room.speed * room.direction;
      room.ball.vy = Math.sin(theta) * room.speed;
      room.phase = 'playing';
    }
    const b = room.ball;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.y - BALL_RADIUS < 0 && b.vy < 0) { b.y = BALL_RADIUS; b.vy *= -1; }
    if (b.y + BALL_RADIUS > HEIGHT && b.vy > 0) { b.y = HEIGHT - BALL_RADIUS; b.vy *= -1; }
    const leftX = PADDLE_MARGIN;
    const rightX = WIDTH - PADDLE_MARGIN - PADDLE_WIDTH;
    if (b.vx < 0 && b.x - BALL_RADIUS <= leftX + PADDLE_WIDTH && b.x >= leftX - BALL_RADIUS && Math.abs(b.y - room.paddle[0]) <= PADDLE_HEIGHT / 2 + BALL_RADIUS) hitPaddle(room, 0);
    else if (b.vx > 0 && b.x + BALL_RADIUS >= rightX && b.x <= rightX + PADDLE_WIDTH + BALL_RADIUS && Math.abs(b.y - room.paddle[1]) <= PADDLE_HEIGHT / 2 + BALL_RADIUS) hitPaddle(room, 1);
    if (b.x < -BALL_RADIUS) scorePoint(room, 1);
    else if (b.x > WIDTH + BALL_RADIUS) scorePoint(room, 0);
  }
}

httpServer.on('upgrade', (request, socket, head) => {
  const key = request.headers['sec-websocket-key'];
  if (request.url !== '/ws' || request.headers.upgrade?.toLowerCase() !== 'websocket' || request.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy(); return;
  }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const client = new Client(socket);
  socket.on('data', buf => client.receive(buf));
  socket.on('close', () => client.cleanup());
  socket.on('end', () => client.cleanup());
  socket.on('error', () => client.cleanup());
  if (head.length) client.receive(head);
  client.send({ type: 'hello', message: 'Connected to Neon Pong multiplayer server.' });
});

let lastTick = Date.now();
const tickTimer = setInterval(() => {
  const now = Date.now();
  const dt = clamp((now - lastTick) / 1000, 0, 0.04);
  lastTick = now;
  gameTick(dt);
}, TICK_MS);
tickTimer.unref();

const broadcastTimer = setInterval(() => {
  for (const room of rooms.values()) {
    const msg = {
      type: 'state', phase: room.phase,
      paddles: room.paddle.map(v => Math.round(v * 10) / 10),
      ball: { x: Math.round(room.ball.x * 10) / 10, y: Math.round(room.ball.y * 10) / 10 },
      scores: [...room.scores], winner: room.winner,
      present: room.players.map(Boolean),
    };
    for (const client of room.players) if (client) client.send(msg);
  }
}, BROADCAST_MS);
broadcastTimer.unref();

if (require.main === module) {
  httpServer.listen(PORT, HOST, () => console.log(`Neon Pong multiplayer listening on http://${HOST}:${PORT}`));
}
module.exports = { httpServer, rooms, WIDTH, HEIGHT, gameTick };
