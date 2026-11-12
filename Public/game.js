(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const lobby = $('lobby');
  const panel = $('gamePanel');
  const createBtn = $('createBtn');
  const joinBtn = $('joinBtn');
  const joinForm = $('joinForm');
  const roomInput = $('roomInput');
  const roomCodeLabel = $('roomCode');
  const copyBtn = $('copyBtn');
  const leaveBtn = $('leaveBtn');
  const connection = $('connection');
  const leftScore = $('leftScore');
  const rightScore = $('rightScore');
  const leftLabel = $('leftLabel');
  const rightLabel = $('rightLabel');
  const statusText = $('statusText');
  const youAre = $('youAre');
  const overlay = $('gameOverlay');
  const overlayTitle = $('overlayTitle');
  const overlayHelp = $('overlayHelp');
  const restartBtn = $('restartBtn');
  const toast = $('toast');
  const canvas = $('court');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const PH = 102, PW = 15, PM = 34, BALL_R = 10;
  const colorLeft = '#57e7f2', colorRight = '#ff5ba2';
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  let ws = null;
  let code = '';
  let side = -1;
  let desired = null;
  let connected = false;
  let reconnectTimer = null;
  let noticeTimer = null;
  let lastInputSent = 0;
  let targetY = H / 2;
  let pointerActive = false;
  let lastRender = 0;
  const downKeys = new Set();
  let snap = {
    phase: 'waiting',
    paddles: [H / 2, H / 2],
    ball: { x: W / 2, y: H / 2 },
    scores: [0, 0],
    winner: -1,
    present: [true, false],
  };
  const trail = [];

  function notify(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  function updateConnection(online) {
    connected = online;
    connection.classList.toggle('online', online);
    connection.classList.toggle('offline', !online);
    connection.querySelector('span').textContent = online ? 'Online' : 'Reconnecting…';
    createBtn.disabled = !online;
    joinBtn.disabled = !online;
  }

  function send(packet) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(packet));
      return true;
    }
    return false;
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${scheme}//${location.host}/ws`);
    ws.onopen = () => {
      updateConnection(true);
      if (desired) send(desired);
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleMessage(msg);
    };
    ws.onerror = () => { /* The subsequent close event handles reconnection. */ };
    ws.onclose = () => {
      updateConnection(false);
      if (code) displayOverlay('Connection lost', 'Trying to reconnect to your match…');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1900);
    };
  }

  function showLobby() {
    code = '';
    side = -1;
    panel.classList.add('hidden');
    lobby.classList.remove('hidden');
    history.replaceState({}, '', location.pathname);
  }

  function displayOverlay(title, help, showRematch = false) {
    overlayTitle.textContent = title;
    overlayHelp.textContent = help;
    overlay.classList.remove('hidden');
    restartBtn.classList.toggle('hidden', !showRematch);
  }

  function updateGameUi() {
    if (!code) return;
    leftScore.textContent = snap.scores[0];
    rightScore.textContent = snap.scores[1];
    leftLabel.textContent = side === 0 ? 'YOU · BLUE' : 'BLUE';
    rightLabel.textContent = side === 1 ? 'YOU · PINK' : 'PINK';
    if (!connected) {
      statusText.textContent = 'Reconnecting';
      displayOverlay('Connection lost', 'Reconnecting to the game…');
    } else if (!snap.present[0] || !snap.present[1] || snap.phase === 'waiting') {
      statusText.textContent = 'Waiting for your friend';
      displayOverlay('Waiting for opponent', 'Send your room link. The match starts when both players arrive.');
    } else if (snap.phase === 'finished') {
      const win = snap.winner === side;
      statusText.textContent = win ? 'You win!' : 'Opponent wins';
      displayOverlay(win ? 'YOU WIN! 🏆' : 'OPPONENT WINS', 'Want another round? Both players must request a rematch.', true);
    } else {
      overlay.classList.add('hidden');
      statusText.textContent = snap.phase === 'serving' ? 'Get ready!' : 'Playing live';
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined': {
        code = msg.code;
        side = msg.side;
        desired = { type: 'join', code };
        roomCodeLabel.textContent = code;
        youAre.textContent = side === 0 ? 'BLUE / Left' : 'PINK / Right';
        joinForm.reset();
        history.replaceState({}, '', `/?room=${encodeURIComponent(code)}`);
        panel.classList.remove('hidden');
        lobby.classList.add('hidden');
        trail.length = 0;
        targetY = H / 2;
        updateGameUi();
        break;
      }
      case 'state':
      case 'status': {
        snap = { ...snap, ...msg };
        updateGameUi();
        break;
      }
      case 'notice': notify(msg.message); break;
      case 'error': {
        notify(msg.message || 'Something went wrong.');
        if (!code) desired = null;
        if (code && /not found/i.test(msg.message || '')) {
          desired = null;
          showLobby();
        }
        break;
      }
      case 'left': break;
    }
  }

  createBtn.addEventListener('click', () => {
    if (!connected) return notify('Connecting to server…');
    desired = { type: 'create' };
    send(desired);
  });

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = roomInput.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (value.length !== 6) return notify('Enter the 6-character code.');
    desired = { type: 'join', code: value };
    send(desired);
  });

  copyBtn.addEventListener('click', async () => {
    const link = `${location.origin}/?room=${encodeURIComponent(code)}`;
    try {
      await navigator.clipboard.writeText(link);
      notify('Invite link copied! Send it to your friend.');
    } catch {
      // Older browsers / HTTP: present a copyable link instead of silently failing.
      window.prompt('Copy and share this link:', link);
    }
  });

  leaveBtn.addEventListener('click', () => {
    desired = null;
    send({ type: 'leave' });
    showLobby();
  });
  restartBtn.addEventListener('click', () => {
    send({ type: 'restart' });
    restartBtn.disabled = true;
    restartBtn.textContent = 'Rematch requested ✓';
    // Re-enable in case the opponent declines / leaves.
    setTimeout(() => { restartBtn.disabled = false; restartBtn.textContent = 'Request rematch'; }, 4000);
  });

  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); }
  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#071022'; ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, 540);
    glow.addColorStop(0, '#25395e'); glow.addColorStop(1, '#07102200');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#5f7ca375'; ctx.lineWidth = 4; ctx.setLineDash([11, 17]);
    ctx.beginPath(); ctx.moveTo(W / 2, 15); ctx.lineTo(W / 2, H - 15); ctx.stroke(); ctx.setLineDash([]);
    ctx.lineWidth = 2; ctx.strokeStyle = '#60799d88';
    ctx.beginPath(); ctx.arc(W / 2, H / 2, 75, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 24;
    ctx.fillStyle = colorLeft; ctx.shadowColor = colorLeft;
    roundRect(PM, snap.paddles[0] - PH / 2, PW, PH, 7);
    ctx.fillStyle = colorRight; ctx.shadowColor = colorRight;
    roundRect(W - PM - PW, snap.paddles[1] - PH / 2, PW, PH, 7);
    if (snap.phase === 'playing' || snap.phase === 'serving') {
      trail.push({ ...snap.ball });
      if (trail.length > 8) trail.shift();
    } else if (trail.length) trail.length = 0;
    trail.forEach((p, i) => {
      ctx.globalAlpha = ((i + 1) / trail.length) * .20;
      ctx.fillStyle = '#e9faff'; ctx.shadowColor = '#57e7f2';
      ctx.beginPath(); ctx.arc(p.x, p.y, BALL_R * (.4 + .6 * i / trail.length), 0, Math.PI * 2); ctx.fill();
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff'; ctx.shadowColor = '#fff'; ctx.shadowBlur = 24;
    ctx.beginPath(); ctx.arc(snap.ball.x, snap.ball.y, BALL_R, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    if (side >= 0) {
      ctx.fillStyle = side === 0 ? colorLeft : colorRight;
      ctx.font = 'bold 15px system-ui,sans-serif';
      ctx.textAlign = side === 0 ? 'left' : 'right';
      ctx.fillText('YOU', side === 0 ? PM : W - PM, 24);
    }
  }

  function setTarget(clientY) {
    const rect = canvas.getBoundingClientRect();
    targetY = clamp((clientY - rect.top) / rect.height * H, PH / 2, H - PH / 2);
    pointerActive = true;
    sendInput(true);
  }
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    setTarget(e.clientY);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || e.buttons) setTarget(e.clientY);
  });
  canvas.addEventListener('pointercancel', () => { pointerActive = false; });
  window.addEventListener('keydown', (e) => {
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (['w', 's', 'ArrowUp', 'ArrowDown'].includes(key)) {
      if (code) e.preventDefault();
      downKeys.add(key);
      pointerActive = false;
    }
  });
  window.addEventListener('keyup', (e) => { downKeys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); });
  window.addEventListener('blur', () => downKeys.clear());
  function sendInput(force = false) {
    if (!code || !connected || side < 0) return;
    const now = performance.now();
    if (!force && now - lastInputSent < 33) return;
    if (force && now - lastInputSent < 21) return;
    send({ type: 'input', y: targetY });
    lastInputSent = now;
  }
  function render(now) {
    const dt = clamp((now - lastRender) / 1000 || 0, 0, .04);
    lastRender = now;
    if (code) {
      const dir = (downKeys.has('s') || downKeys.has('ArrowDown') ? 1 : 0) - (downKeys.has('w') || downKeys.has('ArrowUp') ? 1 : 0);
      if (dir) {
        targetY = clamp(targetY + dir * 800 * dt, PH / 2, H - PH / 2);
        sendInput();
      }
    }
    draw();
    requestAnimationFrame(render);
  }

  const invitedCode = new URLSearchParams(location.search).get('room');
  if (invitedCode && /^[A-Za-z0-9]{6}$/.test(invitedCode)) {
    roomInput.value = invitedCode.toUpperCase();
    desired = { type: 'join', code: invitedCode.toUpperCase() };
  }
  connect();
  requestAnimationFrame(render);
})();
