// 伺服器：靜態網頁 + WebSocket 房間 + 遊戲主迴圈
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { Game } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const CERT_DIR = path.join(__dirname, '..', 'certs');
const PORT = Number(process.env.PORT || 8443);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
};

// ---------- HTTP ----------
async function handleHttp(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === '/qr') {
    const text = url.searchParams.get('text') || '';
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width: 400 });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    return res.end(svg);
  }
  if (pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ hosts: lanAddresses(), port: PORT, secure: isSecure }));
  }

  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/display') pathname = '/display.html';
  if (pathname === '/controller' || pathname === '/c') pathname = '/controller.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

let isSecure = false;
let server;
const keyPath = path.join(CERT_DIR, 'key.pem');
const certPath = path.join(CERT_DIR, 'cert.pem');
try { fs.mkdirSync(CERT_DIR, { recursive: true }); } catch { /* ignore */ }
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, handleHttp);
  isSecure = true;
} else {
  server = http.createServer(handleHttp);
}

// ---------- 房間 ----------
const rooms = new Map(); // code -> Room

class Room {
  constructor(code) {
    this.code = code;
    this.game = new Game();
    this.displays = new Set();
    this.controllers = { A: null, B: null };
    this.lastActivity = Date.now();
  }
  broadcast(msg, { displaysOnly = false } = {}) {
    const data = JSON.stringify(msg);
    for (const ws of this.displays) safeSend(ws, data);
    if (!displaysOnly) for (const side of ['A', 'B']) if (this.controllers[side]) safeSend(this.controllers[side], data);
  }
  isEmpty() {
    return this.displays.size === 0 && !this.controllers.A && !this.controllers.B;
  }
}

function newRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(code)) return code;
  }
}

function getOrCreateRoom(code) {
  if (code && rooms.has(code)) return rooms.get(code);
  const c = code && /^[A-Z0-9]{4}$/.test(code) ? code : newRoomCode();
  const room = new Room(c);
  rooms.set(c, room);
  return room;
}

function safeSend(ws, data) {
  if (ws && ws.readyState === 1) { try { ws.send(data); } catch { /* ignore */ } }
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.meta = { room: null, role: null, side: null };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try { handleMessage(ws, msg); } catch (e) { console.error('message error', e); }
  });

  ws.on('close', () => leave(ws));
});

function handleMessage(ws, msg) {
  const room = ws.meta.room;
  switch (msg.type) {
    case 'join': {
      // { type:'join', role:'display'|'controller', room?:'ABCD', side?:'A'|'B', name? }
      leave(ws);
      const code = (msg.room || '').toUpperCase();
      if (msg.role === 'controller' && !rooms.has(code)) {
        return safeSend(ws, JSON.stringify({ type: 'error', code: 'no_room', text: '找不到這個房號' }));
      }
      const r = getOrCreateRoom(code);
      ws.meta.room = r;
      ws.meta.role = msg.role;
      r.lastActivity = Date.now();
      if (msg.role === 'display') {
        r.displays.add(ws);
        safeSend(ws, JSON.stringify({ type: 'joined', role: 'display', room: r.code, hosts: lanAddresses(), port: PORT, secure: isSecure }));
      } else {
        let side = msg.side;
        if (!side || r.controllers[side]) side = !r.controllers.A ? 'A' : !r.controllers.B ? 'B' : null;
        if (!side) return safeSend(ws, JSON.stringify({ type: 'error', code: 'full', text: '房間已滿' }));
        r.controllers[side] = ws;
        ws.meta.side = side;
        const name = String(msg.name || '').slice(0, 12) || undefined;
        r.game.setConnected(side, true, name);
        safeSend(ws, JSON.stringify({ type: 'joined', role: 'controller', room: r.code, side }));
        r.broadcast({ type: 'players', players: { A: r.game.players.A.connected, B: r.game.players.B.connected } });
      }
      safeSend(ws, JSON.stringify({ type: 'state', state: r.game.snapshot() }));
      break;
    }
    case 'swing': {
      if (!room || ws.meta.role !== 'controller') return;
      room.lastActivity = Date.now();
      const hit = room.game.swing(ws.meta.side, msg);
      safeSend(ws, JSON.stringify({ type: 'swing_ack', hit, quality: hit ? room.game.lastEvent?.text : null }));
      break;
    }
    case 'reset': {
      if (!room) return;
      room.game.resetMatch();
      break;
    }
    case 'ping': {
      safeSend(ws, JSON.stringify({ type: 'pong', t: msg.t, serverTime: Date.now() }));
      break;
    }
  }
}

function leave(ws) {
  const r = ws.meta.room;
  if (!r) return;
  if (ws.meta.role === 'display') r.displays.delete(ws);
  if (ws.meta.role === 'controller' && ws.meta.side && r.controllers[ws.meta.side] === ws) {
    r.controllers[ws.meta.side] = null;
    r.game.setConnected(ws.meta.side, false);
    r.broadcast({ type: 'players', players: { A: r.game.players.A.connected, B: r.game.players.B.connected } });
  }
  ws.meta.room = null; ws.meta.role = null; ws.meta.side = null;
}

// ---------- 主迴圈 ----------
const TICK_HZ = 60;
const SEND_HZ = 30;
let lastTick = Date.now();
let sendAccum = 0;
setInterval(() => {
  const now = Date.now();
  let dt = (now - lastTick) / 1000;
  lastTick = now;
  if (dt > 0.1) dt = 0.1;
  sendAccum += dt;
  const doSend = sendAccum >= 1 / SEND_HZ;
  if (doSend) sendAccum = 0;
  for (const [code, room] of rooms) {
    room.game.update(dt);
    if (doSend) room.broadcast({ type: 'state', state: room.game.snapshot() });
    if (room.isEmpty() && now - room.lastActivity > 10 * 60 * 1000) rooms.delete(code);
  }
}, 1000 / TICK_HZ);

// 心跳
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 15000);

// 列出區網 IPv4，把實體 Wi-Fi / 乙太網路排前面，虛擬介面（VMware、Hyper-V、WSL、Docker、Tailscale…）排後面
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ address: a.address, name, score: scoreInterface(name, a.address) });
    }
  }
  out.sort((x, y) => y.score - x.score);
  return out.map((x) => x.address);
}

function scoreInterface(name, ip) {
  const n = name.toLowerCase();
  let score = 0;
  if (/wi-?fi|wlan|無線|wireless|en0|en1/.test(n)) score += 30;
  if (/^(ethernet|乙太|eth\d|enp|eno|區域連線)/.test(n)) score += 20;
  if (/vethernet|vmware|vmnet|virtualbox|vbox|hyper-v|wsl|docker|tailscale|zerotier|hamachi|vpn|tun|tap|bridge|loopback|default switch/.test(n)) score -= 50;
  if (/^192\.168\.|^10\./.test(ip)) score += 10;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) score -= 40; // CGNAT（Tailscale）
  if (/^169\.254\./.test(ip)) score -= 60;
  if (/^192\.168\.(56|99|188|52)\.1$|\.1$/.test(ip)) score -= 15;    // 常見虛擬網卡閘道位址
  return score;
}

server.listen(PORT, () => {
  const proto = isSecure ? 'https' : 'http';
  console.log(`\n🎾 Mobile Sensing Game server`);
  console.log(`   顯示端（電視/電腦）: ${proto}://localhost:${PORT}/display`);
  for (const h of lanAddresses()) console.log(`   區網網址:            ${proto}://${h}:${PORT}/display`);
  if (!isSecure) {
    const sep = process.platform === 'win32' ? '\\' : '/';
    const ips = lanAddresses().slice(0, 2).join(' ');
    console.log(`   ⚠ 目前是 HTTP。iPhone 需要 HTTPS 才能讀感測器。在專案資料夾執行下面兩行後重新啟動：`);
    console.log(`       mkcert -install`);
    console.log(`       mkcert -key-file certs${sep}key.pem -cert-file certs${sep}cert.pem localhost 127.0.0.1 ${ips}`);
  }
});
