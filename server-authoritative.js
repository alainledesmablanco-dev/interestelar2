/*
server-authoritative.js
Versión final: servidor autoritativo para Interestelar
- Auth JWT (/auth)
- Lobby create/join/start
- Simulación autoritativa por sala (tick loop)
- Snapshots con ack (lastProcessedInputSeq), tick y serverTime
- Ping/pong para medir RTT
*/
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const TOKEN_EXPIRY = '7d';

const TICK_RATE = 20; // ticks por segundo
const SNAPSHOT_RATE = 20;
const GAME_TTL = 1000 * 60 * 60;
const CLEANUP_INTERVAL = 1000 * 60 * 5;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/auth', (req, res) => {
  try {
    const name = (req.body && req.body.name) ? String(req.body.name).trim().substring(0, 32) : `Nave-${Math.floor(Math.random()*10000)}`;
    const playerId = Math.random().toString(36).substring(2, 10);
    const payload = { playerId, name };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
    res.json({ ok: true, token, playerId, name });
  } catch (err) {
    console.error('auth error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/healthz', (_, res) => res.json({ ok: true }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

const lobbies = {};
const games = {};

function makeGameId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}
function now() { return Date.now(); }

// Socket.IO auth middleware (expect token in handshake.auth.token)
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) {
      return next(new Error('NO_TOKEN'));
    }
    const payload = jwt.verify(token, JWT_SECRET);
    socket.data.playerId = payload.playerId;
    socket.data.name = payload.name;
    return next();
  } catch (err) {
    console.warn('Socket auth failed:', err && err.message);
    return next(new Error('AUTH_FAILED'));
  }
});

class Game {
  constructor(gameId) {
    this.id = gameId;
    this.players = new Map(); // socketId -> player state
    this.inputs = new Map();  // socketId -> latest input
    this.bullets = [];
    this.lastBulletId = 1;
    this.status = 'lobby';
    this.createdAt = now();
    this.lastActive = now();
    this.tickInterval = null;
    this.snapshotInterval = null;
    this.tickCount = 0;

    // Tunables
    this.PLAYER_SPEED = 220;
    this.DASH_SPEED = 900;
    this.DASH_TIME = 0.14;
    this.BULLET_SPEED = 400;
    this.BULLET_LIFE = 2.0;
    this.PLAYER_RADIUS = 20;
    this.BULLET_RADIUS = 6;
  }

  addPlayer(socket, playerId, name) {
    const startX = 200 + Math.random() * 800;
    const startY = 150 + Math.random() * 500;
    const state = {
      socketId: socket.id,
      playerId: playerId || socket.data.playerId || socket.id,
      name: name || socket.data.name || `Nave-${Math.floor(Math.random()*1000)}`,
      x: startX, y: startY,
      vx: 0, vy: 0, angle: -Math.PI/2,
      hp: 100, maxHp: 100, r: this.PLAYER_RADIUS,
      dashTimer: 0, dashCooldown: 0, shootCooldown: 0,
      lastProcessedInputSeq: 0
    };
    this.players.set(socket.id, state);
    this.inputs.set(socket.id, null);
    socket.join(this.id);
    socket.data.joinedGame = this.id;
    this.lastActive = now();
  }

  removePlayer(socket) {
    this.players.delete(socket.id);
    this.inputs.delete(socket.id);
    try { socket.leave(this.id); } catch(e) {}
    socket.data.joinedGame = null;
    this.lastActive = now();
  }

  start() {
    if (this.status === 'playing') return;
    this.status = 'playing';
    this.lastTick = now();
    const tickMs = 1000 / TICK_RATE;
    this.tickInterval = setInterval(() => this.tick(1 / TICK_RATE), tickMs);
    this.snapshotInterval = setInterval(() => this.broadcastSnapshot(), 1000 / SNAPSHOT_RATE);
    this.lastActive = now();
    console.log(`Game ${this.id} started (players: ${this.players.size})`);
  }

  stop() {
    this.status = 'ended';
    clearInterval(this.tickInterval);
    clearInterval(this.snapshotInterval);
    io.to(this.id).emit('game_ended', { reason: 'stopped_by_server' });
  }

  handleInput(socketId, input) {
    if (!this.players.has(socketId)) return;
    if (input && typeof input.mx === 'number' && typeof input.my === 'number') {
      input.mx = Math.max(-1, Math.min(1, input.mx));
      input.my = Math.max(-1, Math.min(1, input.my));
      this.inputs.set(socketId, input);
      this.lastActive = now();
    }
  }

  spawnBullet(owner, angle) {
    const id = ++this.lastBulletId;
    const bx = owner.x + Math.cos(angle) * (owner.r + 10);
    const by = owner.y + Math.sin(angle) * (owner.r + 10);
    const vx = Math.cos(angle) * this.BULLET_SPEED;
    const vy = Math.sin(angle) * this.BULLET_SPEED;
    this.bullets.push({ id, x: bx, y: by, vx, vy, ownerId: owner.playerId, life: this.BULLET_LIFE });
  }

  tick(dt) {
    this.tickCount++;

    // Apply inputs and ack seq
    for (const [socketId, player] of this.players.entries()) {
      const input = this.inputs.get(socketId);
      let mx = 0, my = 0, shoot = false, dash = false, seq = 0;
      if (input) {
        mx = input.mx || 0; my = input.my || 0;
        shoot = !!input.shoot; dash = !!input.dash;
        seq = input.seq || 0;
      }

      if (seq && seq > (player.lastProcessedInputSeq || 0)) {
        player.lastProcessedInputSeq = seq;
      }

      // dash
      if (dash && player.dashCooldown <= 0 && player.dashTimer <= 0) {
        player.dashTimer = this.DASH_TIME;
        player.dashCooldown = 3.0;
      }

      if (player.dashTimer > 0) {
        const dirAngle = (Math.hypot(mx, my) > 0.1) ? Math.atan2(my, mx) : player.angle;
        player.vx = Math.cos(dirAngle) * this.DASH_SPEED;
        player.vy = Math.sin(dirAngle) * this.DASH_SPEED;
      } else {
        const mag = Math.hypot(mx, my);
        if (mag > 0.01) {
          const nx = mx / mag, ny = my / mag;
          player.vx = nx * this.PLAYER_SPEED;
          player.vy = ny * this.PLAYER_SPEED;
          player.angle = Math.atan2(ny, nx);
        } else {
          player.vx *= 0.8;
          player.vy *= 0.8;
        }
      }

      if (shoot && player.shootCooldown <= 0) {
        this.spawnBullet(player, player.angle);
        player.shootCooldown = 0.25;
      }

      if (player.dashTimer > 0) player.dashTimer = Math.max(0, player.dashTimer - dt);
      if (player.dashCooldown > 0) player.dashCooldown = Math.max(0, player.dashCooldown - dt);
      if (player.shootCooldown > 0) player.shootCooldown = Math.max(0, player.shootCooldown - dt);
    }

    // Move players
    for (const player of this.players.values()) {
      player.x += player.vx * dt;
      player.y += player.vy * dt;
      player.x = Math.max(player.r, Math.min(1600 - player.r, player.x));
      player.y = Math.max(player.r, Math.min(900 - player.r, player.y));
    }

    // Move bullets + collisions
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      let removed = false;

      for (const player of this.players.values()) {
        if (player.playerId === b.ownerId) continue;
        const dx = b.x - player.x, dy = b.y - player.y;
        const dist = Math.hypot(dx, dy);
        if (dist < (player.r + this.BULLET_RADIUS)) {
          player.hp -= 20;
          this.bullets.splice(i, 1);
          removed = true;
          io.to(this.id).emit('hit', { playerId: player.playerId, hp: player.hp });
          break;
        }
      }

      if (removed) continue;
      if (b.life <= 0 || b.x < -100 || b.x > 1700 || b.y < -100 || b.y > 1000) {
        this.bullets.splice(i, 1);
      }
    }

    // Respawn dead players
    for (const [sid, player] of this.players.entries()) {
      if (player.hp <= 0) {
        player.hp = player.maxHp;
        player.x = 200 + Math.random() * 800;
        player.y = 150 + Math.random() * 500;
        player.vx = 0; player.vy = 0;
        io.to(this.id).emit('player_respawn', { playerId: player.playerId });
      }
    }

    this.lastActive = now();
  }

  broadcastSnapshot() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        socketId: p.socketId,
        playerId: p.playerId,
        name: p.name,
        x: p.x,
        y: p.y,
        angle: p.angle,
        hp: p.hp,
        r: p.r,
        lastProcessedInputSeq: p.lastProcessedInputSeq || 0
      });
    }
    const bullets = this.bullets.map(b => ({ id: b.id, x: b.x, y: b.y, ownerId: b.ownerId }));
    const snapshot = { time: now(), tick: this.tickCount, players, bullets, serverTime: now() };
    io.to(this.id).emit('state', snapshot);
  }
}

// Socket handlers
io.on('connection', (socket) => {
  console.log('connect', socket.id, 'playerId=', socket.data.playerId);
  socket.data.joinedGame = null;

  // Ping/pong
  socket.on('ping_client', (payload) => {
    const clientTs = payload && payload.clientTs ? payload.clientTs : Date.now();
    socket.emit('pong_server', { clientTs, serverTs: now() });
  });

  socket.on('create_game', (payload, cb) => {
    try {
      const gameId = makeGameId();
      lobbies[gameId] = { hostSocketId: socket.id, createdAt: now(), lastActive: now() };
      const g = new Game(gameId);
      games[gameId] = g;
      const playerId = socket.data.playerId;
      const name = socket.data.name;
      g.addPlayer(socket, playerId, name);
      lobbies[gameId].players = [playerId];
      socket.emit('game_created', { ok: true, gameId });
      io.to(gameId).emit('lobby_update', { players: Array.from(g.players.values()).map(p => ({ playerId: p.playerId, name: p.name })), hostSocketId: lobbies[gameId].hostSocketId });
      console.log(`Created game ${gameId} by ${socket.id} (${playerId})`);
      if (cb) cb({ ok: true, gameId });
    } catch (err) {
      console.error('create_game err', err);
      if (cb) cb({ ok: false, error: err.message });
    }
  });

  socket.on('join_game', (payload, cb) => {
    try {
      const gameId = payload && payload.gameId ? payload.gameId.toUpperCase() : null;
      if (!gameId || !games[gameId]) {
        if (cb) cb({ ok: false, error: 'NOT_FOUND' });
        return;
      }
      const g = games[gameId];
      if (g.status !== 'lobby' && g.status !== 'playing') {
        if (cb) cb({ ok: false, error: 'UNAVAILABLE' });
        return;
      }
      const playerId = socket.data.playerId;
      const name = socket.data.name;
      g.addPlayer(socket, playerId, name);
      socket.emit('joined_game', { ok: true, gameId });
      io.to(gameId).emit('lobby_update', { players: Array.from(g.players.values()).map(p => ({ playerId: p.playerId, name: p.name })), hostSocketId: lobbies[gameId] && lobbies[gameId].hostSocketId });
      if (cb) cb({ ok: true });
      console.log(`${socket.id} joined game ${gameId} (${playerId})`);
    } catch (err) {
      console.error('join_game err', err);
      if (cb) cb({ ok: false, error: err.message });
    }
  });

  socket.on('start_game', (payload, cb) => {
    try {
      const gameId = socket.data.joinedGame;
      const gid = (payload && payload.gameId) ? payload.gameId.toUpperCase() : gameId;
      if (!gid || !games[gid]) {
        if (cb) cb({ ok: false, error: 'NO_GAME' });
        return;
      }
      const g = games[gid];
      if (!lobbies[gid] || lobbies[gid].hostSocketId !== socket.id) {
        if (cb) cb({ ok: false, error: 'NOT_HOST' });
        return;
      }
      g.start();
      io.to(gid).emit('game_started', { ok: true });
      if (cb) cb({ ok: true });
    } catch (err) {
      console.error('start_game err', err);
      if (cb) cb({ ok: false, error: err.message });
    }
  });

  socket.on('leave_game', (_, cb) => {
    try {
      const gameId = socket.data.joinedGame;
      if (!gameId) { if (cb) cb({ ok: false }); return; }
      if (games[gameId]) {
        games[gameId].removePlayer(socket);
        if (games[gameId].players.size === 0) {
          games[gameId].stop();
          delete games[gameId];
          delete lobbies[gameId];
        } else {
          io.to(gameId).emit('lobby_update', { players: Array.from(games[gameId].players.values()).map(p => ({ playerId: p.playerId, name: p.name })) });
        }
      }
      socket.leave(gameId);
      socket.data.joinedGame = null;
      if (cb) cb({ ok: true });
    } catch (err) {
      console.error('leave_game err', err);
      if (cb) cb({ ok: false, error: err.message });
    }
  });

  socket.on('input', (input) => {
    const gameId = socket.data.joinedGame;
    if (!gameId || !games[gameId]) return;
    if (input && typeof input.mx === 'number' && typeof input.my === 'number') {
      input.mx = Math.max(-1, Math.min(1, input.mx));
      input.my = Math.max(-1, Math.min(1, input.my));
      games[gameId].handleInput(socket.id, input);
    }
  });

  socket.on('disconnect', () => {
    const gameId = socket.data.joinedGame;
    if (gameId && games[gameId]) {
      games[gameId].removePlayer(socket);
      if (games[gameId].players.size === 0) {
        games[gameId].stop();
        delete games[gameId];
        delete lobbies[gameId];
      } else {
        io.to(gameId).emit('lobby_update', { players: Array.from(games[gameId].players.values()).map(p => ({ playerId: p.playerId, name: p.name })) });
      }
    }
    console.log('disconnect', socket.id);
  });
});

setInterval(() => {
  const keys = Object.keys(games);
  keys.forEach(k => {
    const g = games[k];
    if (!g) return;
    if (now() - g.lastActive > GAME_TTL) {
      if (g.status === 'playing') g.stop();
      delete games[k];
      delete lobbies[k];
      console.log('cleanup game', k);
    }
  });
}, CLEANUP_INTERVAL);

httpServer.listen(PORT, () => {
  console.log(`Authoritative server listening on port ${PORT}`);
  console.log(`JWT_SECRET: ${JWT_SECRET ? '[set]' : '[default]'}`);
});