/*
Cliente final: autenticación, inputs, predicción, reconciliación (lerp), ack processing y telemetría.
El cliente conecta a /auth para obtener token y luego usa socket.io con auth token.
*/
(function(){
  const API_PREFIX = '';
  const AUTH_KEY = 'interestelar_auth_token';
  const PLAYER_ID_KEY = 'interestelar_player_id';
  const PLAYER_NAME_KEY = 'interestelar_name';

  // UI elements (may be present in HTML)
  const userDisplay = document.getElementById('userDisplay');
  const gameIdDisplay = document.getElementById('gameIdDisplay');
  const createGameBtn = document.getElementById('createGameBtn');
  const joinGameBtn = document.getElementById('joinGameBtn');
  const gameIdInput = document.getElementById('gameIdInput');
  const lobbyPlayerList = document.getElementById('lobbyPlayerList');
  const lobbyBackBtn = document.getElementById('lobbyBackBtn');

  let token = localStorage.getItem(AUTH_KEY);
  let myId = localStorage.getItem(PLAYER_ID_KEY) || null;
  let myName = localStorage.getItem(PLAYER_NAME_KEY) || null;

  // Telemetry HUD
  let telemetryEl = document.getElementById('telemetryHud');
  if (!telemetryEl) {
    telemetryEl = document.createElement('div');
    telemetryEl.id = 'telemetryHud';
    telemetryEl.style.position = 'absolute';
    telemetryEl.style.left = '10px';
    telemetryEl.style.top = '10px';
    telemetryEl.style.background = 'rgba(0,0,0,0.5)';
    telemetryEl.style.color = '#0ff';
    telemetryEl.style.padding = '6px 10px';
    telemetryEl.style.fontFamily = 'Segoe UI, sans-serif';
    telemetryEl.style.fontSize = '13px';
    telemetryEl.style.borderRadius = '6px';
    telemetryEl.style.zIndex = '300';
    document.body.appendChild(telemetryEl);
  }

  async function ensureAuth() {
    if (token && myId && myName) return { ok: true };
    let name = myName;
    if (!name) {
      name = prompt('Introduce tu nombre de jugador (max 16 chars):', `Nave-${Math.floor(Math.random()*1000)}`);
      if (!name) name = `Nave-${Math.floor(Math.random()*10000)}`;
      name = name.substring(0, 16);
    }
    try {
      const res = await fetch(API_PREFIX + '/auth', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (!data || !data.ok) throw new Error(data && data.error ? data.error : 'no_token');
      token = data.token; myId = data.playerId; myName = data.name;
      localStorage.setItem(AUTH_KEY, token);
      localStorage.setItem(PLAYER_ID_KEY, myId);
      localStorage.setItem(PLAYER_NAME_KEY, myName);
      return { ok: true };
    } catch (err) {
      alert('No se pudo autenticar: ' + err.message);
      return { ok: false, error: err.message };
    }
  }

  // Socket and input loop
  let socket = null;
  let inputSeq = 0;
  const SEND_HZ = 20;
  const SEND_MS = 1000 / SEND_HZ;
  let sendInterval = null;
  let pendingInputs = []; // { seq, mx, my, shoot, dash, dt, ts }

  let predicted = { x: null, y: null, angle: 0 };
  let reconcileTarget = null;
  let reconcileStart = null;
  let reconcileDuration = 120;
  let smoothingRAF = null;

  // Telemetry
  let lastPing = null;
  let rtt = null;
  let serverClockOffset = 0;
  let serverTick = null;
  let lastSnapshotTime = null;

  function updateTelemetryHud() {
    telemetryEl.innerHTML = `
      RTT: ${rtt !== null ? Math.round(rtt) + ' ms' : '––'}<br>
      Pending inputs: ${pendingInputs.length}<br>
      Server tick: ${serverTick !== null ? serverTick : '––'}<br>
      Snapshot age: ${lastSnapshotTime ? Math.max(0, Date.now() - lastSnapshotTime) + ' ms' : '––'}
    `;
  }

  function startPingLoop() {
    setInterval(() => {
      if (!socket || !socket.connected) return;
      const clientTs = Date.now();
      lastPing = clientTs;
      socket.emit('ping_client', { clientTs });
    }, 2000);
  }

  function connectSocket() {
    if (!token) return;
    socket = io({ auth: { token } });

    socket.on('connect_error', (err) => {
      console.error('connect_error', err);
      if (userDisplay) userDisplay.textContent = 'Error conexión: ' + (err && err.message);
    });

    socket.on('connect', () => {
      console.log('socket connected', socket.id);
      if (userDisplay) userDisplay.textContent = 'Conectado: ' + myId;
      startPingLoop();
    });

    socket.on('pong_server', (payload) => {
      if (!payload || !payload.clientTs) return;
      const nowTs = Date.now();
      const measuredRTT = nowTs - payload.clientTs;
      rtt = measuredRTT;
      serverClockOffset = payload.serverTs - (payload.clientTs + measuredRTT / 2);
      updateTelemetryHud();
    });

    socket.on('lobby_update', (data) => {
      if (lobbyPlayerList && data && data.players) {
        lobbyPlayerList.innerHTML = '';
        (data.players || []).forEach(p => {
          const li = document.createElement('li');
          li.textContent = `${p.name || p.playerId} ${p.isHost ? '(Anfitrión)' : ''}`;
          lobbyPlayerList.appendChild(li);
        });
      }
      if (gameIdDisplay && data && data.gameId) {
        gameIdDisplay.textContent = `ID DE PARTIDA: ${data.gameId}`;
      }
    });

    socket.on('game_created', (data) => {
      if (data && data.gameId) gameIdDisplay.textContent = `ID DE PARTIDA: ${data.gameId}`;
    });

    socket.on('joined_game', (data) => {
      if (data && data.gameId) gameIdDisplay.textContent = `ID DE PARTIDA: ${data.gameId}`;
    });

    socket.on('game_started', () => startSendingInputs());
    socket.on('game_ended', () => stopSendingInputs());

    socket.on('state', (snapshot) => applySnapshot(snapshot));
    socket.on('hit', d => console.log('hit', d));
    socket.on('player_respawn', d => console.log('player_respawn', d));
    socket.on('disconnect', reason => { console.log('disconnect', reason); if (userDisplay) userDisplay.textContent = 'Desconectado'; });
  }

  function startSendingInputs() {
    if (sendInterval) return;
    if (window.PLAYER) { predicted.x = window.PLAYER.x; predicted.y = window.PLAYER.y; predicted.angle = window.PLAYER.angle || 0; }
    else { predicted.x = null; predicted.y = null; predicted.angle = 0; }

    sendInterval = setInterval(() => {
      const inp = readLocalInput();
      inputSeq++;
      const packet = { seq: inputSeq, mx: inp.mx, my: inp.my, shoot: !!inp.shoot, dash: !!inp.dash, timestamp: Date.now() };
      applyLocalInput(packet, 1 / SEND_HZ);
      pendingInputs.push({ ...packet, dt: 1 / SEND_HZ, ts: Date.now() });
      updateTelemetryHud();
      if (socket && socket.connected) socket.emit('input', packet);
    }, SEND_MS);
  }

  function stopSendingInputs() {
    if (sendInterval) { clearInterval(sendInterval); sendInterval = null; pendingInputs = []; updateTelemetryHud(); }
  }

  const keys = {};
  window.addEventListener('keydown', e => keys[e.key.toLowerCase()] = true);
  window.addEventListener('keyup', e => keys[e.key.toLowerCase()] = false);

  function readLocalInput() {
    let mx = 0, my = 0;
    if (keys['arrowleft'] || keys['a']) mx -= 1;
    if (keys['arrowright'] || keys['d']) mx += 1;
    if (keys['arrowup'] || keys['w']) my -= 1;
    if (keys['arrowdown'] || keys['s']) my += 1;
    const shoot = keys[' '] || false;
    const dash = keys['shift'] || false;
    return { mx, my, shoot, dash };
  }

  function applyLocalInput(input, dt) {
    if (predicted.x === null && window.PLAYER) { predicted.x = window.PLAYER.x; predicted.y = window.PLAYER.y; predicted.angle = window.PLAYER.angle || 0; }
    const SPEED = 220, DASH_SPEED = 900;
    const mag = Math.hypot(input.mx, input.my);
    if (mag > 0.01) {
      const nx = input.mx / mag, ny = input.my / mag;
      const angle = Math.atan2(ny, nx);
      predicted.angle = angle;
      const sp = input.dash ? DASH_SPEED : SPEED;
      predicted.x += nx * sp * dt;
      predicted.y += ny * sp * dt;
    }
    if (window.PLAYER) { window.PLAYER.x = predicted.x; window.PLAYER.y = predicted.y; window.PLAYER.angle = predicted.angle; }
  }

  function applySnapshot(snapshot) {
    if (!snapshot) return;
    serverTick = snapshot.tick !== undefined ? snapshot.tick : serverTick;
    lastSnapshotTime = snapshot.serverTime || snapshot.time || Date.now();
    updateTelemetryHud();

    const me = (snapshot.players || []).find(p => p.playerId === myId);
    if (me) {
      const serverSeq = me.lastProcessedInputSeq || 0;
      if (serverSeq > 0 && pendingInputs.length > 0) pendingInputs = pendingInputs.filter(pi => pi.seq > serverSeq);

      const authX = me.x, authY = me.y, authAngle = me.angle || 0;
      let replX = authX, replY = authY, replAngle = authAngle;
      const SPEED = 220, DASH_SPEED = 900;
      pendingInputs.forEach(pi => {
        const mag = Math.hypot(pi.mx, pi.my);
        if (mag > 0.01) {
          const nx = pi.mx / mag, ny = pi.my / mag;
          const sp = pi.dash ? DASH_SPEED : SPEED;
          replX += nx * sp * (pi.dt || (1 / SEND_HZ));
          replY += ny * sp * (pi.dt || (1 / SEND_HZ));
          replAngle = Math.atan2(ny, nx);
        }
      });

      reconcileTarget = { x: replX, y: replY, angle: replAngle };
      reconcileStart = performance.now();
      if (!window.PLAYER) { window.PLAYER = { x: authX, y: authY, angle: authAngle, hp: me.hp, r: 20 }; }
      else { window.PLAYER.hp = me.hp; }

      if (!smoothingRAF) smoothingLoop();
    }

    if (Array.isArray(snapshot.bullets)) {
      window.bullets = snapshot.bullets.map(b => ({ x: b.x, y: b.y, life: 1, dmg: 10 }));
    } else { window.bullets = window.bullets || []; }

    if (Array.isArray(snapshot.players)) {
      const others = snapshot.players.filter(p => p.playerId !== myId);
      window.enemies = others.map(o => ({ x: o.x, y: o.y, angle: o.angle, hp: o.hp, r: o.r || 16 }));
      if (lobbyPlayerList) {
        lobbyPlayerList.innerHTML = '';
        snapshot.players.forEach(p => {
          const li = document.createElement('li');
          li.textContent = p.name || p.playerId;
          lobbyPlayerList.appendChild(li);
        });
      }
    }
    updateTelemetryHud();
  }

  function smoothingLoop() {
    smoothingRAF = requestAnimationFrame(function step(ts) {
      if (!reconcileTarget || !window.PLAYER) { smoothingRAF = null; return; }
      const now = performance.now();
      const elapsed = Math.max(0, now - reconcileStart);
      const t = Math.min(1, elapsed / reconcileDuration);
      const curX = window.PLAYER.x, curY = window.PLAYER.y;
      const nx = curX + (reconcileTarget.x - curX) * (0.15 + 0.7 * t);
      const ny = curY + (reconcileTarget.y - curY) * (0.15 + 0.7 * t);
      let a0 = window.PLAYER.angle || 0, a1 = reconcileTarget.angle || 0;
      let diff = a1 - a0;
      while (diff > Math.PI) diff -= Math.PI*2;
      while (diff < -Math.PI) diff += Math.PI*2;
      const na = a0 + diff * (0.2 + 0.8 * t);
      window.PLAYER.x = nx; window.PLAYER.y = ny; window.PLAYER.angle = na;
      const dx = reconcileTarget.x - nx, dy = reconcileTarget.y - ny;
      if (Math.hypot(dx, dy) < 1 || t >= 1) {
        window.PLAYER.x = reconcileTarget.x; window.PLAYER.y = reconcileTarget.y; window.PLAYER.angle = reconcileTarget.angle;
        reconcileTarget = null; reconcileStart = null; smoothingRAF = null; return;
      }
      smoothingRAF = requestAnimationFrame(step);
    });
  }

  // UI bindings
  if (createGameBtn) {
    createGameBtn.onclick = async () => {
      const auth = await ensureAuth(); if (!auth.ok) return;
      if (!socket) connectSocket();
      createGameBtn.disabled = true;
      socket.emit('create_game', {}, (res) => { createGameBtn.disabled = false; if (!res || !res.ok) return alert('Error al crear partida: ' + (res && res.error)); });
    };
  }
  if (joinGameBtn) {
    joinGameBtn.onclick = async () => {
      const gid = (gameIdInput.value || '').toUpperCase();
      if (!gid || gid.length !== 6) return alert('Introduce un ID de 6 caracteres.');
      const auth = await ensureAuth(); if (!auth.ok) return;
      if (!socket) connectSocket();
      joinGameBtn.disabled = true;
      socket.emit('join_game', { gameId: gid }, (res) => { joinGameBtn.disabled = false; if (!res || !res.ok) return alert('Error al unirse: ' + (res && res.error)); });
    };
  }
  if (lobbyBackBtn) {
    lobbyBackBtn.onclick = () => { if (!socket) return; socket.emit('leave_game', {}, (res) => {}); };
  }

  window.authoritative = {
    ensureAuth, connectSocket, startSendingInputs, stopSendingInputs,
    getSocket: () => socket, _debug_pendingInputs: () => pendingInputs.slice(),
    setReconcileDuration: (ms) => { reconcileDuration = ms; }
  };

  if (token) connectSocket();
  else if (userDisplay) userDisplay.textContent = 'No autenticado';

  setInterval(updateTelemetryHud, 500);
})();