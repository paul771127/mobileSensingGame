import { connect, qs, loadAssets } from '/common.js';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1;

let roomCode = (qs('room') || '').toUpperCase();
let viewSide = qs('side') || 'A'; // A | B | top
let joined = null;   // 伺服器回傳的 joined 訊息（含區網位址）
let state = null;    // 最新遊戲狀態
let stateAt = 0;     // 收到時間
let assets = {};
let lastEventT = -1, lastFxT = -1;
let banner = null;   // { text, until, color }
const fxList = [];   // 擊球閃光等短效果
const sounds = {};

const COLORS = { A: '#3aa0ff', B: '#ff5f6d', accent: '#d9ff4a' };

// ---------- 連線 ----------
const ws = connect(onMessage, (api) => {
  api.send({ type: 'join', role: 'display', room: roomCode });
});

function onMessage(msg) {
  if (msg.type === 'joined') {
    joined = msg;
    roomCode = msg.room;
    const u = new URL(location.href);
    if (u.searchParams.get('room') !== roomCode) { u.searchParams.set('room', roomCode); history.replaceState(null, '', u); }
    loadQr();
    buildHostPicker();
  } else if (msg.type === 'state') {
    state = msg.state;
    stateAt = performance.now();
    handleEvents(state);
  }
}

// ---------- QR ----------
let qrImg = null, qrUrl = '';
let hostIdx = 0;
function controllerUrl() {
  const proto = location.protocol;
  let host = qs('host') || location.hostname;
  if ((host === 'localhost' || host === '127.0.0.1') && joined?.hosts?.length) host = joined.hosts[hostIdx % joined.hosts.length];
  const port = location.port ? `:${location.port}` : '';
  return `${proto}//${host}${port}/controller?room=${roomCode}`;
}
function loadQr() {
  qrUrl = controllerUrl();
  const img = new Image();
  img.onload = () => { qrImg = img; };
  img.src = `/qr?text=${encodeURIComponent(qrUrl)}`;
}

// 大廳 IP 選擇（電腦有多張網卡時，讓 QR code 用手機連得到的那個 IP）
function buildHostPicker() {
  const box = document.getElementById('hosts');
  if (!box) return;
  const hosts = joined?.hosts || [];
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!local || hosts.length < 2) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  box.replaceChildren(document.createTextNode('QR code 用的 IP：'));
  hosts.forEach((h, i) => {
    const b = document.createElement('button');
    b.textContent = h; b.className = i === hostIdx ? 'on' : '';
    b.onclick = () => { hostIdx = i; loadQr(); buildHostPicker(); };
    box.appendChild(b);
  });
}

// ---------- 事件 / 音效 ----------
function handleEvents(s) {
  const ev = s.lastEvent;
  if (ev && ev.t !== lastEventT) {
    lastEventT = ev.t;
    if (ev.type === 'hit') {
      let label = { perfect: 'PERFECT!', good: 'GOOD', late: '勉強打到' }[ev.text] || ev.text;
      const sh = s.lastShot;
      if (sh && sh.t === ev.t) {
        const tags = [];
        if (sh.arc > 0.35) tags.push('挑高'); else if (sh.arc < -0.35) tags.push('壓平');
        if (sh.lateral > 0.4) tags.push('切右'); else if (sh.lateral < -0.4) tags.push('切左');
        if (sh.spin > 0.4) tags.push('上旋'); else if (sh.spin < -0.4) tags.push('下旋');
        if (tags.length) label += '  ' + tags.join(' ');
      }
      banner = { text: label, until: performance.now() + 800, color: COLORS[ev.side], small: true };
    } else if (ev.type === 'point' || ev.type === 'serve' || ev.type === 'pause' || ev.type === 'autoserve' || ev.type === 'bot') {
      banner = { text: ev.text, until: performance.now() + (ev.type === 'point' ? 2000 : 1400), color: ev.side ? COLORS[ev.side] : COLORS.accent };
    }
  }
  const fx = s.lastFx;
  if (fx && fx.t !== lastFxT) {
    lastFxT = fx.t;
    playSound(fx.type);
    if (fx.type === 'hit' || fx.type === 'net' || fx.type === 'bounce') {
      fxList.push({ type: fx.type, x: fx.x, y: fx.y, z: fx.type === 'hit' ? (s.ball?.z ?? 1) : 0, start: performance.now(), dur: fx.type === 'hit' ? 350 : 250 });
    }
  }
}

function playSound(name) {
  const file = assets.__manifest?.sounds?.[name];
  if (!file) return;
  try {
    if (!sounds[name]) { sounds[name] = new Audio(`/assets/${file}`); sounds[name].onerror = () => { sounds[name] = { play() {} }; }; }
    const a = sounds[name].cloneNode ? sounds[name].cloneNode() : sounds[name];
    a.volume = 0.7; a.play?.().catch(() => {});
  } catch { /* ignore */ }
}

// ---------- 投影 ----------
// 回傳 { x, y, s }：螢幕座標與縮放（1 公尺 = s 像素）
let proj = null;
function buildProjection() {
  const court = state?.court || { width: 10.97, length: 23.77 };
  const HL = court.length / 2;
  if (viewSide === 'top') {
    // 俯視：球場長邊沿螢幕水平，A 在左、B 在右
    const margin = 1.6;
    const s = Math.min(W / (court.length + margin * 2 + 4), H / (court.width + margin * 2 + 6)) ;
    const cx = W / 2, cy = H / 2 + 20 * DPR;
    proj = {
      type: 'top',
      p(x, y, z = 0) { return { x: cx + y * s, y: cy + x * s - z * s * 0.55, s, zc: 1 }; },
      ground(x, y) { return { x: cx + y * s, y: cy + x * s, s, zc: 1 }; },
      s,
    };
    return;
  }
  // 透視：攝影機在 viewSide 玩家後上方
  const flip = viewSide === 'B' ? -1 : 1; // B 視角把 y 和 x 翻轉
  const camY = -(HL + 10), camZ = 7.5;
  const tgt = { x: 0, y: 1.5, z: 0 };
  const f = norm({ x: 0, y: tgt.y - camY, z: tgt.z - camZ });
  const r = { x: 1, y: 0, z: 0 };
  const u = cross(r, f); // 上
  function cam(x, y, z) {
    // 世界 → 視角方（翻轉）→ 相機
    const wx = x * flip, wy = y * flip;
    const d = { x: wx, y: wy - camY, z: z - camZ };
    return { xc: dot(d, r), yc: dot(d, u), zc: dot(d, f) };
  }
  // 以球場四角 + 高度決定焦距，使球場填滿畫面
  const corners = [[-court.width / 2 - 1.5, -HL - 2.5, 0], [court.width / 2 + 1.5, -HL - 2.5, 0], [-court.width / 2 - 1, HL + 2, 0], [court.width / 2 + 1, HL + 2, 0], [0, 0, 3.5]];
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const [x, y, z] of corners) {
    const c = cam(x * flip, y * flip, z);
    const px = c.xc / c.zc, py = c.yc / c.zc;
    minx = Math.min(minx, px); maxx = Math.max(maxx, px); miny = Math.min(miny, py); maxy = Math.max(maxy, py);
  }
  const fl = Math.min((W * 0.96) / (maxx - minx), (H * 0.80) / (maxy - miny));
  const cx = W / 2 - fl * (minx + maxx) / 2;
  const cy = H / 2 + fl * (miny + maxy) / 2 + H * 0.06;
  proj = {
    type: 'persp',
    p(x, y, z = 0) {
      const c = cam(x, y, z);
      return { x: cx + fl * c.xc / c.zc, y: cy - fl * c.yc / c.zc, s: fl / c.zc, zc: c.zc };
    },
    ground(x, y) { return this.p(x, y, 0); },
    s: fl / cam(0, 0, 0).zc,
  };
}
function norm(v) { const l = Math.hypot(v.x, v.y, v.z); return { x: v.x / l, y: v.y / l, z: v.z / l }; }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }

// ---------- 繪製 ----------
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.width = Math.floor(innerWidth * DPR);
  H = canvas.height = Math.floor(innerHeight * DPR);
  buildProjection();
}
addEventListener('resize', resize);

function frame() {
  requestAnimationFrame(frame);
  if (!proj) buildProjection();
  drawBackground();
  drawCourt();
  if (state) {
    drawNet();
    drawScene();
    drawHud();
  }
  if (!state || state.phase === 'lobby') drawLobby();
  drawBanner();
}

function drawBackground() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const bg = assets.background;
  if (bg) {
    const sc = Math.max(W / bg.width, H / bg.height);
    ctx.drawImage(bg, (W - bg.width * sc) / 2, (H - bg.height * sc) / 2, bg.width * sc, bg.height * sc);
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0b1020'); g.addColorStop(1, '#141b33');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
}

// 以水平條帶把俯視圖貼到地面（透視下每條世界 y 線在螢幕上仍是水平線）
function drawGroundImage(img, ppm, yFrom, yTo) {
  const worldW = img.width / ppm, worldH = img.height / ppm;
  if (proj.type === 'top') {
    const c = proj.ground(0, 0);
    ctx.save(); ctx.translate(c.x, c.y); ctx.rotate(-Math.PI / 2);
    ctx.drawImage(img, -worldW / 2 * proj.s, -worldH / 2 * proj.s, worldW * proj.s, worldH * proj.s);
    ctx.restore();
    return;
  }
  const flip = viewSide === 'B' ? -1 : 1;
  const N = 220;
  for (let i = 0; i < N; i++) {
    // 世界 y（遠→近）切片
    const y0 = yFrom + (yTo - yFrom) * (i / N), y1 = yFrom + (yTo - yFrom) * ((i + 1) / N);
    const p0 = proj.ground(0, y0), p1 = proj.ground(0, y1);
    // 影像 y：影像上方對應世界 +y（B 方）
    const sy0 = (worldH / 2 - y0 * 1) * ppm, sy1 = (worldH / 2 - y1) * ppm;
    const top = Math.min(sy0, sy1), hgt = Math.abs(sy1 - sy0);
    const scale = (p0.s + p1.s) / 2;
    const dw = worldW * scale;
    const dy = Math.min(p0.y, p1.y), dh = Math.abs(p1.y - p0.y) + 1;
    ctx.save();
    if (flip === -1) { ctx.translate(p0.x, 0); ctx.scale(-1, 1); ctx.translate(-p0.x, 0); }
    ctx.drawImage(img, 0, top, img.width, Math.max(hgt, 1), p0.x - dw / 2, dy, dw, dh);
    ctx.restore();
  }
}

function drawCourt() {
  const court = state?.court || { width: 10.97, singlesWidth: 8.23, length: 23.77, serviceLine: 6.4 };
  const HL = court.length / 2, HW = court.width / 2, SW = court.singlesWidth / 2;
  const img = assets.court;
  if (img) {
    const ppm = assets.__manifest?.pixelsPerMeter || 100;
    const worldH = img.height / ppm;
    drawGroundImage(img, ppm, worldH / 2, -worldH / 2);
  } else {
    // 佔位：程式畫球場
    fillQuad([[-HW - 3, -HL - 4], [HW + 3, -HL - 4], [HW + 3, HL + 4], [-HW - 3, HL + 4]], '#1d4a9a');
    fillQuad([[-HW, -HL], [HW, -HL], [HW, HL], [-HW, HL]], '#2f6fdd');
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = Math.max(2, 0.05 * proj.s);
    line(-HW, -HL, HW, -HL); line(-HW, HL, HW, HL);
    line(-HW, -HL, -HW, HL); line(HW, -HL, HW, HL);
    line(-SW, -HL, -SW, HL); line(SW, -HL, SW, HL);
    line(-SW, -court.serviceLine, SW, -court.serviceLine); line(-SW, court.serviceLine, SW, court.serviceLine);
    line(0, -court.serviceLine, 0, court.serviceLine);
    line(0, -HL, 0, -HL + 0.3); line(0, HL, 0, HL - 0.3);
  }
}

function fillQuad(pts, color) {
  ctx.fillStyle = color; ctx.beginPath();
  pts.forEach(([x, y], i) => { const p = proj.ground(x, y); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
  ctx.closePath(); ctx.fill();
}
function line(x0, y0, x1, y1, z0 = 0, z1 = 0) {
  const a = proj.p(x0, y0, z0), b = proj.p(x1, y1, z1);
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
}

function drawNet() {
  const court = state.court, HW = court.width / 2 + 0.9, h = court.netHeight;
  const img = assets.net;
  if (proj.type === 'top') {
    const a = proj.ground(-HW, 0), b = proj.ground(HW, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = Math.max(3, 0.12 * proj.s);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.fillStyle = '#ddd';
    for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(4, 0.12 * proj.s), 0, Math.PI * 2); ctx.fill(); }
    return;
  }
  if (img) {
    // 把 net.png 拉成四邊形（上下邊各自縮放）
    const N = 8;
    for (let i = 0; i < N; i++) {
      const z0 = h * (1 - i / N), z1 = h * (1 - (i + 1) / N);
      const a = proj.p(-HW, 0, z0), b = proj.p(HW, 0, z0), c = proj.p(-HW, 0, z1);
      const sy = img.height * (i / N), sh = img.height / N;
      ctx.drawImage(img, 0, sy, img.width, sh, a.x, a.y, b.x - a.x, Math.max(c.y - a.y, 1));
    }
  } else {
    const a = proj.p(-HW, 0, 0), b = proj.p(HW, 0, 0), c = proj.p(HW, 0, h), d = proj.p(-HW, 0, h);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, 0.04 * proj.s);
    ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(c.x, c.y); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
    const cols = 40;
    for (let i = 0; i <= cols; i++) { const x = -HW + (2 * HW) * i / cols; line(x, 0, x, 0, 0, h); }
    for (let i = 1; i < 6; i++) { const z = h * i / 6; line(-HW, 0, HW, 0, z, z); }
    // 網柱
    ctx.strokeStyle = '#ddd'; ctx.lineWidth = Math.max(3, 0.08 * proj.s);
    line(-HW, 0, -HW, 0, 0, h + 0.1); line(HW, 0, HW, 0, 0, h + 0.1);
  }
}

function drawScene() {
  const s = state;
  const now = performance.now();
  // 外插球位置（補 30Hz 更新間的空隙）
  let ball = null;
  if (s.ball) {
    const dt = Math.min((now - stateAt) / 1000, 0.06);
    ball = { x: s.ball.x + s.ball.vx * dt, y: s.ball.y + s.ball.vy * dt, z: Math.max(0, s.ball.z + s.ball.vz * dt) };
  }
  // 依遠近排序（遠的先畫）
  const items = [];
  for (const side of ['A', 'B']) items.push({ kind: 'player', side, y: s.players[side].y, x: s.players[side].x });
  if (ball) items.push({ kind: 'ball', ...ball });
  for (const f of fxList) items.push({ kind: 'fx', ...f });
  items.sort((a, b) => proj.p(a.x, a.y, 0).zc - proj.p(b.x, b.y, 0).zc).reverse();

  // 球影先畫
  if (ball) {
    const g = proj.ground(ball.x, ball.y);
    const sh = assets.ballShadow;
    const r = 0.11 * g.s * (1 + ball.z * 0.15);
    if (sh) ctx.drawImage(sh, g.x - r * 1.6, g.y - r * 0.8, r * 3.2, r * 1.6);
    else { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(g.x, g.y, r * 1.5, r * 0.7, 0, 0, Math.PI * 2); ctx.fill(); }
  }

  for (const it of items) {
    if (it.kind === 'player') drawPlayer(it.side);
    else if (it.kind === 'ball') drawBall(it);
    else drawFx(it, now);
  }
  for (let i = fxList.length - 1; i >= 0; i--) if (now - fxList[i].start > fxList[i].dur) fxList.splice(i, 1);
}

function drawPlayer(side) {
  const p = state.players[side];
  const g = proj.ground(p.x, p.y);
  const color = COLORS[side];
  const swinging = p.swingAnim > 0;
  // 近 / 遠：決定用背面或正面圖
  let img = null;
  if (proj.type === 'top') img = assets[`player${side}Top`];
  else {
    const near = (viewSide === 'A' && side === 'A') || (viewSide === 'B' && side === 'B');
    const base = `player${side}${near ? 'Back' : 'Front'}`;
    img = (swinging && assets[`${base}Swing`]) || assets[base];
  }
  if (img) {
    const h = 1.9 * g.s; // 身高約 1.9m
    const w = h * (img.width / img.height);
    if (proj.type === 'top') {
      const sz = 1.4 * g.s;
      ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(side === 'A' ? Math.PI / 2 : -Math.PI / 2);
      ctx.drawImage(img, -sz / 2, -sz / 2, sz, sz); ctx.restore();
    } else ctx.drawImage(img, g.x - w / 2, g.y - h, w, h);
    if (!p.connected) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(g.x - 0.6 * g.s, g.y - 2 * g.s, 1.2 * g.s, 2 * g.s); }
    return;
  }
  // 佔位：色塊球員 + 球拍
  const sh = 0.45 * g.s;
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(g.x, g.y, sh, sh * 0.45, 0, 0, Math.PI * 2); ctx.fill();
  const bodyH = proj.type === 'top' ? 0 : 1.6 * g.s;
  ctx.fillStyle = p.connected ? color : '#555';
  ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(1.5, 0.03 * g.s);
  if (proj.type === 'top') {
    ctx.beginPath(); ctx.arc(g.x, g.y, 0.4 * g.s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else {
    roundRect(g.x - 0.3 * g.s, g.y - bodyH, 0.6 * g.s, bodyH * 0.75, 0.15 * g.s); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(g.x, g.y - bodyH * 0.9, 0.22 * g.s, 0, Math.PI * 2); ctx.fillStyle = '#ffd9b3'; ctx.fill(); ctx.stroke();
  }
  // 球拍
  const ang = swinging ? -0.9 + (0.35 - p.swingAnim) / 0.35 * 2.0 : -0.6;
  const rx = g.x + Math.cos(ang) * 0.55 * g.s, ry = (proj.type === 'top' ? g.y : g.y - bodyH * 0.55) + Math.sin(ang) * 0.55 * g.s;
  ctx.strokeStyle = '#222'; ctx.lineWidth = Math.max(2, 0.05 * g.s);
  ctx.beginPath(); ctx.moveTo(g.x + Math.cos(ang) * 0.3 * g.s, (proj.type === 'top' ? g.y : g.y - bodyH * 0.55) + Math.sin(ang) * 0.3 * g.s); ctx.lineTo(rx, ry); ctx.stroke();
  ctx.fillStyle = swinging ? COLORS.accent : '#eee'; ctx.beginPath(); ctx.ellipse(rx, ry, 0.16 * g.s, 0.2 * g.s, ang, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // 名字
  ctx.fillStyle = '#fff'; ctx.font = `${Math.max(12, 0.28 * g.s)}px system-ui`; ctx.textAlign = 'center';
  ctx.fillText(p.name + (p.connected ? '' : '（離線）'), g.x, g.y - (proj.type === 'top' ? 0.6 * g.s : bodyH + 0.4 * g.s));
}

function drawBall(b) {
  const p = proj.p(b.x, b.y, b.z);
  const r = Math.max(4, 0.11 * p.s * (proj.type === 'top' ? 1 + b.z * 0.12 : 1));
  const img = assets.ball;
  if (img) ctx.drawImage(img, p.x - r, p.y - r, r * 2, r * 2);
  else {
    ctx.fillStyle = COLORS.accent; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = Math.max(1, r * 0.15);
    ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.65, 0.4, 2.2); ctx.stroke();
  }
}

function drawFx(f, now) {
  const k = (now - f.start) / f.dur;
  const p = proj.p(f.x, f.y, f.z);
  const img = assets.hitFlash;
  const r = p.s * (f.type === 'hit' ? 0.5 + k * 0.9 : 0.2 + k * 0.5);
  ctx.save(); ctx.globalAlpha = 1 - k;
  if (img && f.type === 'hit') ctx.drawImage(img, p.x - r, p.y - r, r * 2, r * 2);
  else {
    ctx.strokeStyle = f.type === 'net' ? '#fff' : COLORS.accent; ctx.lineWidth = Math.max(2, p.s * 0.05 * (1 - k));
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function drawHud() {
  const s = state;
  const fs = Math.round(Math.min(W, H) * 0.045);
  const pad = fs * 0.5;
  const boxW = fs * 12, boxH = fs * 2.1;
  const x = W / 2 - boxW / 2, y = pad;
  ctx.fillStyle = 'rgba(10,14,30,0.75)'; roundRect(x, y, boxW, boxH, fs * 0.5); ctx.fill();
  ctx.textBaseline = 'middle';
  for (const [side, dir] of [['A', -1], ['B', 1]]) {
    const p = s.players[side];
    const cx = W / 2 + dir * boxW * 0.3;
    ctx.fillStyle = COLORS[side]; ctx.font = `700 ${fs * 0.7}px system-ui`; ctx.textAlign = 'center';
    ctx.fillText(p.name + (s.server === side ? ' 🎾' : ''), cx, y + boxH * 0.3);
    ctx.fillStyle = '#fff'; ctx.font = `800 ${fs * 1.0}px system-ui`;
    ctx.fillText(s.score.points[side], cx, y + boxH * 0.7);
    if (!p.connected) { ctx.fillStyle = '#aaa'; ctx.font = `${fs * 0.5}px system-ui`; ctx.fillText('未連線', cx + dir * fs * 3.2, y + boxH * 0.3); }
  }
  ctx.fillStyle = '#fff'; ctx.font = `800 ${fs * 1.1}px system-ui`; ctx.textAlign = 'center';
  ctx.fillText(`${s.score.games.A} - ${s.score.games.B}`, W / 2, y + boxH * 0.5);
  ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.font = `${fs * 0.45}px system-ui`;
  ctx.fillText('局數', W / 2, y + boxH * 0.88);
  if (s.rallyHits > 2 && s.phase === 'rally') {
    ctx.fillStyle = COLORS.accent; ctx.font = `700 ${fs * 0.6}px system-ui`;
    ctx.fillText(`連擊 ${s.rallyHits}`, W / 2, y + boxH + fs * 0.6);
  }
  // 房號（小字）
  ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = `${fs * 0.5}px system-ui`;
  ctx.fillText(`房號 ${roomCode}  ·  視角 ${viewSide}`, pad, H - pad * 2.2);
  ctx.textBaseline = 'alphabetic';
}

function drawLobby() {
  const fs = Math.round(Math.min(W, H) * 0.05);
  const boxW = Math.min(W * 0.8, fs * 16), boxH = fs * 9.5;
  const x = W / 2 - boxW / 2, y = H * 0.56 - boxH / 2;
  ctx.fillStyle = 'rgba(10,14,30,0.86)'; roundRect(x, y, boxW, boxH, fs * 0.6); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.font = `800 ${fs * 1.1}px system-ui`;
  if (assets.logo) {
    const lh = fs * 1.4, lw = lh * assets.logo.width / assets.logo.height;
    ctx.drawImage(assets.logo, W / 2 - lw / 2, y + fs * 0.4, lw, lh);
  } else ctx.fillText('🎾 手機球拍對戰', W / 2, y + fs * 0.5);
  ctx.font = `${fs * 0.6}px system-ui`; ctx.fillStyle = '#9aa3c7';
  ctx.fillText('用手機掃 QR code 加入，手機就是你的球拍', W / 2, y + fs * 2.1);
  ctx.fillStyle = '#fff'; ctx.font = `800 ${fs * 2.2}px ui-monospace, monospace`;
  ctx.fillText(roomCode || '....', W / 2, y + fs * 3.0);
  ctx.font = `${fs * 0.5}px system-ui`; ctx.fillStyle = '#9aa3c7';
  ctx.fillText(qrUrl, W / 2, y + fs * 5.6);
  if (qrImg) {
    const qs_ = fs * 3.2;
    ctx.fillStyle = '#fff'; roundRect(W / 2 - qs_ / 2 - 6, y + fs * 6.1, qs_ + 12, qs_ + 12, 8); ctx.fill();
    ctx.drawImage(qrImg, W / 2 - qs_ / 2, y + fs * 6.1 + 6, qs_, qs_);
  }
  // 玩家連線狀態
  if (state) {
    for (const [side, dir] of [['A', -1], ['B', 1]]) {
      const p = state.players[side];
      ctx.fillStyle = p.connected ? COLORS[side] : 'rgba(255,255,255,0.25)';
      ctx.font = `700 ${fs * 0.6}px system-ui`;
      ctx.fillText(`${side}：${p.connected ? p.name + ' 已加入' : '等待中…'}`, W / 2 + dir * boxW * 0.28, y + boxH - fs * 0.9);
    }
    if (state.players.A.connected !== state.players.B.connected) {
      ctx.fillStyle = '#9aa3c7'; ctx.font = `${fs * 0.45}px system-ui`;
      ctx.fillText('只有一支手機？在手機上按「和電腦練習」，或在此按 B 鍵', W / 2, y + boxH - fs * 0.35);
    }
  }
  ctx.textBaseline = 'alphabetic';
}

function drawBanner() {
  if (!banner) return;
  const now = performance.now();
  if (now > banner.until) { banner = null; return; }
  const k = Math.min(1, (banner.until - now) / 300);
  const fs = Math.round(Math.min(W, H) * (banner.small ? 0.05 : 0.07));
  ctx.save(); ctx.globalAlpha = k;
  ctx.font = `900 ${fs}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const tw = ctx.measureText(banner.text).width;
  const y = banner.small ? H * 0.22 : H * 0.4;
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; roundRect(W / 2 - tw / 2 - fs * 0.6, y - fs * 0.8, tw + fs * 1.2, fs * 1.6, fs * 0.4); ctx.fill();
  ctx.fillStyle = banner.color; ctx.fillText(banner.text, W / 2, y);
  ctx.restore();
}

// ---------- 鍵盤 / 視角 ----------
addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); }
  if (e.key === 'r' || e.key === 'R') ws.send({ type: 'reset' });
  if (e.key === 'b' || e.key === 'B') { const side = state?.players?.A?.connected ? 'B' : 'A'; ws.send({ type: 'bot', side, on: true }); }
});
document.querySelectorAll('#view button').forEach((b) => {
  const on = () => document.querySelectorAll('#view button').forEach((x) => x.classList.toggle('on', x.dataset.side === viewSide));
  on();
  b.onclick = () => {
    viewSide = b.dataset.side; buildProjection(); on();
    const u = new URL(location.href); u.searchParams.set('side', viewSide); history.replaceState(null, '', u);
  };
});

loadAssets().then((a) => { assets = a; });
resize();
frame();
