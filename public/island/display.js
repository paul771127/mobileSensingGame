// 《島口大開》顯示端：固定斜俯視 3D 場地、所有提示與選擇都在這個畫面。
// 模型從 /assets/island/*.glb 載入，缺檔時用程式建立同名節點的替代模型。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { connect, qs } from '/common.js';

const $ = (id) => document.getElementById(id);
const COLORS = { A: 0x3aa0ff, B: 0xff9f2e };
const CSS_COLORS = { A: '#3aa0ff', B: '#ff9f2e', accent: '#d9ff4a' };
const LABEL = { A: '藍', B: '橘' };

let roomCode = (qs('room') || '').toUpperCase();
let joinedMsg = null;
let state = null, stateAt = 0, prevState = null;

// ---------- 連線 ----------
const ws = connect(onMessage, (api) => { api.send({ type: 'join', role: 'display', game: 'island', room: roomCode }); });
function onMessage(msg) {
  if (msg.type === 'joined') {
    joinedMsg = msg; roomCode = msg.room;
    const u = new URL(location.href);
    if (u.searchParams.get('room') !== roomCode) { u.searchParams.set('room', roomCode); history.replaceState(null, '', u); }
    $('roomCode').textContent = roomCode;
    loadQr(); buildHostPicker();
  } else if (msg.type === 'state') {
    prevState = state; state = msg.state; stateAt = performance.now();
    onState(state);
  }
}

// ---------- QR ----------
let hostIdx = 0;
function controllerUrl() {
  let host = qs('host') || location.hostname;
  if ((host === 'localhost' || host === '127.0.0.1') && joinedMsg?.hosts?.length) host = joinedMsg.hosts[hostIdx % joinedMsg.hosts.length];
  const port = location.port ? `:${location.port}` : '';
  return `${location.protocol}//${host}${port}/island/controller?room=${roomCode}`;
}
function loadQr() {
  const url = controllerUrl();
  const src = `/qr?text=${encodeURIComponent(url)}`;
  $('qrBig').src = src; $('qrSmall').src = src; $('qrUrl').textContent = url;
}
function buildHostPicker() {
  const box = $('hosts');
  const hosts = joinedMsg?.hosts || [];
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

// ---------- Three.js 基礎 ----------
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
// 底色對齊美術預覽的灰藍：深青色的巨怪與鐘樓在近黑底色上會糊掉
scene.background = new THREE.Color(0x3c5878);
scene.fog = new THREE.Fog(0x3c5878, 38, 70);
const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 200);
const WHITE = new THREE.Color(0xffffff), RED = new THREE.Color(0xff2a1a);
const CAM_DIR = new THREE.Vector3(0.05, 1.0, 0.8).normalize();

scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x3a2a1a, 0.9));
const sun = new THREE.DirectionalLight(0xfff1dc, 1.6);
sun.position.set(-8, 18, 10); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 60;
sun.shadow.camera.left = -18; sun.shadow.camera.right = 18; sun.shadow.camera.top = 16; sun.shadow.camera.bottom = -16;
sun.shadow.bias = -0.0005;
scene.add(sun); scene.add(sun.target);
const fill = new THREE.DirectionalLight(0x9fc3ff, 0.35); fill.position.set(10, 6, -8); scene.add(fill);

// 海面
const sea = new THREE.Mesh(new THREE.PlaneGeometry(200, 200, 1, 1), new THREE.MeshStandardMaterial({ color: 0x4f7396, roughness: 0.6, metalness: 0.1 }));
sea.rotation.x = -Math.PI / 2; sea.position.y = -2.2; sea.receiveShadow = true; scene.add(sea);

// 固定斜俯視：把整座島（含巨怪與鐘樓）收進畫面
let worldBounds = null;
function fitCamera() {
  if (!worldBounds) return;
  const b = worldBounds;
  const center = new THREE.Vector3((b.minX + b.maxX) / 2, 0.8, (b.minZ + b.maxZ) / 2 + 0.6);
  const corners = [];
  for (const x of [b.minX, b.maxX]) for (const y of [-0.5, 5.5]) for (const z of [b.minZ, b.maxZ]) corners.push(new THREE.Vector3(x, y, z));
  let lo = 8, hi = 80;
  for (let i = 0; i < 24; i++) {
    const d = (lo + hi) / 2;
    camera.position.copy(center).addScaledVector(CAM_DIR, d);
    camera.lookAt(center); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
    let ok = true;
    for (const c of corners) { const p = c.clone().project(camera); if (Math.abs(p.x) > 0.93 || Math.abs(p.y) > 0.84) { ok = false; break; } }
    if (ok) hi = d; else lo = d;
  }
  camera.position.copy(center).addScaledVector(CAM_DIR, hi);
  camera.lookAt(center);
  camBase.copy(camera.position);
  sun.target.position.copy(center);
}
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  fitCamera();
}
addEventListener('resize', resize);

// ---------- 模型（GLB 或程式替代） ----------
const loader = new GLTFLoader();
const models = {}; // name -> Object3D 範本
async function loadGlb(name) {
  try {
    const gltf = await loader.loadAsync(`/assets/island/${name}.glb`);
    const obj = gltf.scene;
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return obj;
  } catch { return null; }
}
const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...extra });
function box(w, h, d, m, x = 0, y = 0, z = 0) { const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); g.position.set(x, y, z); g.castShadow = g.receiveShadow = true; return g; }
function sphere(r, m, x = 0, y = 0, z = 0, seg = 18) { const g = new THREE.Mesh(new THREE.SphereGeometry(r, seg, seg), m); g.position.set(x, y, z); g.castShadow = true; return g; }
function cyl(rt, rb, h, m, x = 0, y = 0, z = 0, seg = 16) { const g = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m); g.position.set(x, y, z); g.castShadow = g.receiveShadow = true; return g; }

function fallbackTile(spring) {
  const g = new THREE.Group();
  const top = spring ? mat(0xf2c230, { roughness: 0.4, metalness: 0.3 }) : mat(0x6fbf5a);
  const side = spring ? mat(0xb8841a) : mat(0x8a5a3c);
  const m = new THREE.Mesh(new THREE.BoxGeometry(1.44, 0.5, 1.44), [side, side, top, mat(0x5a3a26), side, side]);
  m.position.y = -0.25; m.castShadow = m.receiveShadow = true; g.add(m);
  if (spring) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.06, 10, 28), mat(0x6b4a12)); ring.rotation.x = Math.PI / 2; ring.position.y = 0.03; g.add(ring);
    const knob = cyl(0.14, 0.14, 0.1, mat(0xfff0a8, { emissive: 0x665500 }), 0, 0.05, 0); g.add(knob);
  }
  return g;
}
function fallbackRepairer(color) {
  const g = new THREE.Group();
  const team = mat(color), skin = mat(0xf3d2b3), dark = mat(0x2b2f45), wood = mat(0x9a6b3a), iron = mat(0x9aa3b5, { metalness: 0.6, roughness: 0.3 });
  g.add(box(0.5, 0.6, 0.3, team, 0, 0.85, 0));
  g.add(sphere(0.23, skin, 0, 1.4, 0));
  const hat = cyl(0.28, 0.3, 0.14, team, 0, 1.6, 0); g.add(hat);
  const eyeL = sphere(0.035, dark, -0.08, 1.42, 0.2, 8), eyeR = sphere(0.035, dark, 0.08, 1.42, 0.2, 8); g.add(eyeL, eyeR);
  const armL = new THREE.Group(); armL.name = 'Arm_L'; armL.position.set(-0.33, 1.1, 0); armL.add(box(0.14, 0.5, 0.14, team, 0, -0.25, 0)); g.add(armL);
  const armR = new THREE.Group(); armR.name = 'Arm_R'; armR.position.set(0.33, 1.1, 0); armR.add(box(0.14, 0.5, 0.14, team, 0, -0.25, 0));
  const handle = cyl(0.03, 0.03, 0.75, wood, 0, -0.5, 0.32); handle.rotation.x = Math.PI / 2; armR.add(handle);
  armR.add(box(0.22, 0.15, 0.15, iron, 0, -0.5, 0.66));
  g.add(armR);
  for (const [name, x] of [['Leg_L', -0.13], ['Leg_R', 0.13]]) { const leg = new THREE.Group(); leg.name = name; leg.position.set(x, 0.55, 0); leg.add(box(0.16, 0.55, 0.16, dark, 0, -0.275, 0)); g.add(leg); }
  return g;
}
function fallbackBoss() {
  const root = new THREE.Group(); root.name = 'Boss';
  const purple = mat(0x7a4ac8), darker = mat(0x4b2a86), tooth = mat(0xfff6e0), eyeW = mat(0xffffff), pupil = mat(0x111111);
  const body = sphere(1.5, purple, 0, 1.4, -0.2, 24); body.scale.set(1.1, 0.95, 1.05); root.add(body);
  for (let i = 0; i < 4; i++) { const sp = cyl(0, 0.18, 0.7, darker, -0.9 + i * 0.6, 2.6, -0.6 - Math.abs(i - 1.5) * 0.3, 6); root.add(sp); }
  for (const x of [-0.62, 0.62]) { root.add(sphere(0.28, eyeW, x, 2.15, 0.95, 14)); root.add(sphere(0.13, pupil, x, 2.17, 1.2, 10)); }
  const upper = new THREE.Group(); upper.name = 'UpperJaw'; upper.position.set(0, 1.35, 0.5);
  upper.add(box(2.3, 0.6, 1.7, purple, 0, 0.3, 0.75));
  for (let i = 0; i < 5; i++) { const t = cyl(0, 0.1, 0.32, tooth, -0.8 + i * 0.4, -0.12, 1.5, 6); t.rotation.x = Math.PI; upper.add(t); }
  root.add(upper);
  const jaw = new THREE.Group(); jaw.name = 'Jaw'; jaw.position.set(0, 0.75, 0.5);
  jaw.add(box(2.3, 0.5, 1.7, darker, 0, -0.25, 0.75));
  for (let i = 0; i < 4; i++) jaw.add(cyl(0, 0.1, 0.3, tooth, -0.6 + i * 0.4, 0.12, 1.5, 6));
  root.add(jaw);
  const socket = new THREE.Group(); socket.name = 'BrickSocket'; socket.position.set(0, 1.0, 1.3); root.add(socket);
  const core = sphere(0.36, new THREE.MeshStandardMaterial({ color: 0xff3fd0, emissive: 0xff2fb0, emissiveIntensity: 1.2, roughness: 0.3 }), 0, 1.1, 1.6, 20); core.name = 'Core'; root.add(core);
  return root;
}
function fallbackMob(color, r, lift = 0) { const g = new THREE.Group(); g.add(sphere(r, mat(color), 0, r + lift, 0, 12)); g.add(box(r * 0.9, r * 0.3, r * 0.5, mat(0x222222), 0, r + lift, r * 0.8)); return g; }
function fallbackTower() {
  const g = new THREE.Group();
  const stone = mat(0x8e94a8), wood = mat(0x7a5533), roof = mat(0xb5443a), gold = mat(0xf2c230, { metalness: 0.5, roughness: 0.3 });
  g.add(cyl(0.95, 1.1, 3.2, stone, 0, 1.6, 0, 20));
  g.add(cyl(1.4, 1.4, 0.2, wood, 0, 3.1, 0, 24));
  for (const x of [-0.85, 0.85]) for (const z of [-0.85, 0.85]) g.add(cyl(0.08, 0.08, 1.7, wood, x, 4.05, z, 8));
  g.add(cyl(0, 1.45, 0.9, roof, 0, 5.35, 0, 8));
  const pivot = new THREE.Group(); pivot.name = 'BellPivot'; pivot.position.set(0, 4.85, 0);
  pivot.add(cyl(0.16, 0.42, 0.65, gold, 0, -0.38, 0, 16));
  pivot.add(sphere(0.08, gold, 0, -0.74, 0, 8));
  g.add(pivot);
  return g;
}
async function loadModels() {
  const [tile, spring, blue, orange, boss, tower] = await Promise.all(['ground-tile', 'spring-tile', 'repairer-blue', 'repairer-orange', 'chomp-boss', 'bell-tower'].map(loadGlb));
  models.tile = tile || fallbackTile(false);
  models.spring = spring || fallbackTile(true);
  models.A = blue || fallbackRepairer(COLORS.A);
  models.B = orange || fallbackRepairer(COLORS.B);
  models.boss = boss || fallbackBoss();
  models.tower = tower || fallbackTower();
  const [mm, mr, mc, orb] = await Promise.all(['mob-melee', 'mob-ranged', 'mob-charger', 'enemy-orb'].map(loadGlb));
  models.mob = { melee: mm || fallbackMob(0xd9483b, 0.5), ranged: mr || fallbackMob(0x9a5cff, 0.5, 0.6), charger: mc || fallbackMob(0xff8a2a, 0.85) };
  models.orb = orb || sphere(0.16, new THREE.MeshStandardMaterial({ color: 0xff5ad0, emissive: 0xff2fb0, emissiveIntensity: 1.5 }));
  models.usingGlb = { tile: !!tile, spring: !!spring, A: !!blue, B: !!orange, boss: !!boss, tower: !!tower };
}

// ---------- 程式畫的標記貼圖 ----------
function canvasTex(size, draw) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'); draw(ctx, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
// 咬痕：上下兩排牙齒的弧線
const biteTex = canvasTex(256, (ctx, s) => {
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 10; ctx.lineCap = 'round'; ctx.fillStyle = '#fff';
  for (const dir of [1, -1]) {
    ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.36, dir > 0 ? Math.PI * 1.15 : Math.PI * 0.15, dir > 0 ? Math.PI * 1.85 : Math.PI * 0.85); ctx.stroke();
    for (let i = 0; i < 6; i++) {
      const a = (dir > 0 ? Math.PI * 1.22 : Math.PI * 0.22) + i * Math.PI * 0.11;
      const x = s / 2 + Math.cos(a) * s * 0.36, y = s / 2 + Math.sin(a) * s * 0.36;
      ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.lineTo(x, y - dir * 30); ctx.closePath(); ctx.fill();
    }
  }
});
// 落點：方框四角 + 中心點
const targetTex = canvasTex(256, (ctx, s) => {
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 14; ctx.lineCap = 'round';
  const m = 28, L = 60;
  for (const [x, y, dx, dy] of [[m, m, 1, 1], [s - m, m, -1, 1], [m, s - m, 1, -1], [s - m, s - m, -1, -1]]) {
    ctx.beginPath(); ctx.moveTo(x, y + dy * L); ctx.lineTo(x, y); ctx.lineTo(x + dx * L, y); ctx.stroke();
  }
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(s / 2, s / 2, 16, 0, Math.PI * 2); ctx.fill();
});
// 弱點：六角環 + 尖刺
const weakTex = canvasTex(256, (ctx, s) => {
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 12; ctx.lineJoin = 'round';
  ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; const x = s / 2 + Math.cos(a) * 88, y = s / 2 + Math.sin(a) * 88; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.closePath(); ctx.stroke();
  ctx.lineWidth = 10; for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + Math.PI / 6; ctx.beginPath(); ctx.moveTo(s / 2 + Math.cos(a) * 96, s / 2 + Math.sin(a) * 96); ctx.lineTo(s / 2 + Math.cos(a) * 120, s / 2 + Math.sin(a) * 120); ctx.stroke(); }
});
// 斷橋目標格：虛線方框
const dashTex = canvasTex(256, (ctx, s) => {
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 10; ctx.setLineDash([26, 18]); ctx.strokeRect(18, 18, s - 36, s - 36);
});
// 能力區：圓盤 + 圖示
function padTex(kind) {
  return canvasTex(256, (ctx, s) => {
    ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.beginPath(); ctx.arc(s / 2, s / 2, 110, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 10; ctx.beginPath(); ctx.arc(s / 2, s / 2, 110, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 16; ctx.lineCap = 'round';
    if (kind === 'boots') { // 靴子
      ctx.beginPath(); ctx.moveTo(95, 70); ctx.lineTo(135, 70); ctx.lineTo(135, 150); ctx.lineTo(185, 165); ctx.lineTo(185, 190); ctx.lineTo(95, 190); ctx.closePath(); ctx.fill();
    } else { // 槌子
      ctx.beginPath(); ctx.moveTo(128, 200); ctx.lineTo(128, 110); ctx.stroke();
      ctx.fillRect(70, 60, 116, 56);
    }
  });
}
function textSprite(text, color = '#fff', bg = 'rgba(10,16,38,.75)', scale = 1) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = 'bold 64px system-ui, "Noto Sans TC", sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 56;
  c.width = Math.max(96, Math.min(2048, w)); c.height = 128;
  ctx.font = font;
  ctx.fillStyle = bg; roundRect(ctx, 4, 14, c.width - 8, 100, 28); ctx.fill();
  ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, c.width / 2, 66);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  sp.scale.set(c.width * 0.00625 * scale, 0.8 * scale, 1); sp.renderOrder = 10;
  return sp;
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function decal(tex, color, size = 1.4, opacity = 1) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.renderOrder = 5; return m;
}

// ---------- 場景物件 ----------
const world = new THREE.Group(); scene.add(world);
const tileMeshes = new Map(), platMeshes = new Map(), ghostMeshes = new Map();
const tilesGroup = new THREE.Group(), platsGroup = new THREE.Group(), markGroup = new THREE.Group(), ghostGroup = new THREE.Group();
world.add(tilesGroup, platsGroup, markGroup, ghostGroup);
let bossObj = null, bossParts = {}, towerObj = null, bellPivot = null, heldBrick = null, flightBrick = null;
const playerViews = {};
let bridgeDecals = [], padDecals = [], lockDecal, candDecals = [], landDecal, landArrow, landLabel, weakSprite, weakLabel, previewLine, flightLine, bridgeLabel;
let gridInfo = null;
const cellX = (c) => (c - gridInfo.cx) * gridInfo.s, cellZ = (r) => (r - gridInfo.cz) * gridInfo.s;

function buildStatic(s) {
  gridInfo = s.grid;
  // 鐘樓
  towerObj = new THREE.Group(); towerObj.position.set(s.tower.x, 0, s.tower.z); world.add(towerObj);
  const towerModel = models.tower.clone();
  if (models.usingGlb.tower) {
    // 美術的鐘樓是原點在底部的小鐘亭（基座 1.5×1.4、鐘緣離地 0.9，角色站不進去）。
    // 可站高度與半徑由遊戲邏輯決定（s.tower.top / radius）：程式畫石柱與塔頂平台當站位，
    // 鐘亭照原比例立在平台北側（邏輯的鐘位置 bellX / bellZ），玩家站在它前面敲鐘。
    const top = s.tower.top, R = s.tower.radius + 0.1, bx = s.tower.bellX || 0, bz = s.tower.bellZ || 0;
    const stone = mat(0x6f8f9a), dark = mat(0x1d3a4c), deck = mat(0x2a6f78);
    towerObj.add(cyl(R * 0.72, R * 0.86, top + 2.0, stone, 0, (top - 2.4) / 2, 0, 10));
    towerObj.add(cyl(R, R * 0.9, 0.22, dark, 0, top - 0.33, 0, 10));
    towerObj.add(cyl(R, R, 0.22, deck, 0, top - 0.11, 0, 10));
    towerObj.add(box(1.7, 0.44, 1.6, dark, bx, top - 0.22, bz));
    towerModel.position.set(bx, top, bz);
  }
  towerObj.add(towerModel);
  bellPivot = towerObj.getObjectByName('BellPivot');
  // 巨怪
  bossObj = models.boss.clone(); world.add(bossObj);
  bossParts = { upper: bossObj.getObjectByName('UpperJaw'), jaw: bossObj.getObjectByName('Jaw'), socket: bossObj.getObjectByName('BrickSocket'), core: bossObj.getObjectByName('Core') };
  if (bossParts.core) bossParts.core.visible = false;
  // 斷橋目標格
  for (const [c, r] of s.bridge) { const d = decal(dashTex, 0x35d0e0, 1.44, 0.75); d.position.set(cellX(c), 0.02, cellZ(r)); markGroup.add(d); bridgeDecals.push(d); }
  const mid = s.bridge[Math.floor(s.bridge.length / 2)];
  bridgeLabel = textSprite('斷橋：彈簧磚落點', '#35d0e0'); bridgeLabel.position.set(cellX(mid[0]) + 0.75, 1.6, cellZ(mid[1]) + 0.2); markGroup.add(bridgeLabel);
  // 能力區（等鐘響後顯示）
  for (const pd of [{ kind: 'boots' }, { kind: 'hammer' }]) {
    const d = decal(padTex(pd.kind), pd.kind === 'boots' ? 0xd9a066 : 0x35d0e0, 1.3, 0.95); d.visible = false; markGroup.add(d);
    const label = textSprite(pd.kind === 'boots' ? '黏土靴：落地固定相鄰平台' : '回音槌：敲擊距離變長', pd.kind === 'boots' ? '#ffd9b0' : '#9ff2ff'); label.visible = false; markGroup.add(label);
    padDecals.push({ kind: pd.kind, d, label });
  }
  // 標記
  lockDecal = decal(biteTex, 0xff3b3b, 1.6, 0.95); lockDecal.visible = false; markGroup.add(lockDecal);
  for (let i = 0; i < 9; i++) { const d = decal(biteTex, 0xffffff, 1.3, 0.4); d.visible = false; markGroup.add(d); candDecals.push(d); }
  landDecal = decal(targetTex, 0xffe14d, 1.5, 1); landDecal.visible = false; markGroup.add(landDecal);
  landArrow = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.6, 6), new THREE.MeshBasicMaterial({ color: 0xffe14d })); landArrow.rotation.x = Math.PI; landArrow.visible = false; markGroup.add(landArrow);
  landLabel = textSprite('落點', '#ffe14d'); landLabel.visible = false; markGroup.add(landLabel);
  weakSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: weakTex, color: 0xff3fd0, transparent: true, depthTest: false })); weakSprite.scale.set(2.2, 2.2, 1); weakSprite.visible = false; weakSprite.renderOrder = 9; markGroup.add(weakSprite);
  weakLabel = textSprite('弱點：打核心！', '#ff9fe8'); weakLabel.visible = false; markGroup.add(weakLabel);
  previewLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(new Array(25).fill(0).map(() => new THREE.Vector3())), new THREE.LineDashedMaterial({ color: 0xffe14d, dashSize: 0.35, gapSize: 0.2, transparent: true, opacity: 0.9 }));
  previewLine.visible = false; previewLine.renderOrder = 8; markGroup.add(previewLine);
  flightLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(new Array(25).fill(0).map(() => new THREE.Vector3())), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
  flightLine.visible = false; markGroup.add(flightLine);
  // 玩家
  for (const side of ['A', 'B']) {
    const root = new THREE.Group();
    const model = models[side].clone(); root.add(model);
    const marker = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.45, 5), new THREE.MeshBasicMaterial({ color: COLORS[side] })); marker.rotation.x = Math.PI; marker.position.y = 2.25; root.add(marker);
    const label = textSprite(`${side === 'A' ? '1P' : '2P'} ${LABEL[side]}`, '#fff', side === 'A' ? 'rgba(58,160,255,.85)' : 'rgba(255,159,46,.85)', 0.7); label.position.y = 2.85; root.add(label);
    const abil = textSprite('', '#fff', 'rgba(0,0,0,0)', 0.6); abil.position.y = 3.35; abil.visible = false; root.add(abil);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.6, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.visible = false; root.add(ring);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.015; root.add(shadow);
    root.visible = false; world.add(root);
    playerViews[side] = {
      root, model, marker, label, abil, ring, shadow, abilKind: null,
      parts: { armL: model.getObjectByName('Arm_L'), armR: model.getObjectByName('Arm_R'), legL: model.getObjectByName('Leg_L'), legR: model.getObjectByName('Leg_R') },
      pos: new THREE.Vector3(), phase: 0, lastHitAge: 99, wasGrounded: true, squash: 0, airT: 0,
    };
  }
  // 鏡頭範圍
  const bz = s.boss.anchor.z - 2.4;
  worldBounds = { minX: cellX(-0.6), maxX: Math.max(cellX(gridInfo.cols - 0.4), s.tower.x + 1.6), minZ: bz, maxZ: cellZ(gridInfo.rows - 0.4) };
  resize();
}

// 地磚 / 平台 / 長回預告 同步
function syncTiles(s) {
  const seen = new Set();
  for (const [c, r, spring] of s.tiles) {
    const k = `${c},${r}`; seen.add(k);
    let m = tileMeshes.get(k);
    if (m && m.userData.spring !== !!spring) { tilesGroup.remove(m); tileMeshes.delete(k); m = null; }
    if (!m) {
      m = (spring ? models.spring : models.tile).clone(); m.userData.spring = !!spring; m.userData.born = performance.now();
      m.position.set(cellX(c), 0, cellZ(r)); tilesGroup.add(m); tileMeshes.set(k, m);
    }
  }
  for (const [k, m] of tileMeshes) if (!seen.has(k)) { tilesGroup.remove(m); tileMeshes.delete(k); }
  const seenP = new Set();
  for (const [c, r, spring, top, loose, remain] of s.plats) {
    const k = `${c},${r}`; seenP.add(k);
    let m = platMeshes.get(k);
    if (m && (m.userData.spring !== !!spring || m.userData.top !== top)) { platsGroup.remove(m); platMeshes.delete(k); m = null; }
    if (!m) {
      m = new THREE.Group();
      const body = (spring ? models.spring : models.tile).clone(); m.add(body);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.07, 8, 32), mat(0xa66b3a)); rim.rotation.x = Math.PI / 2; rim.position.y = -0.02; rim.visible = false; m.add(rim);
      m.userData = { spring: !!spring, top, rim, born: performance.now() };
      m.position.set(cellX(c), top, cellZ(r)); platsGroup.add(m); platMeshes.set(k, m);
    }
    m.userData.loose = !!loose; m.userData.remain = remain; m.userData.rim.visible = !loose;
  }
  for (const [k, m] of platMeshes) if (!seenP.has(k)) { platsGroup.remove(m); platMeshes.delete(k); }
  const seenG = new Set();
  for (const g of s.regrow) {
    const k = `${g.c},${g.r}`; seenG.add(k);
    if (platMeshes.has(k) || tileMeshes.has(k)) continue;
    let m = ghostMeshes.get(k);
    if (!m) {
      m = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.1, 1.3), new THREE.MeshBasicMaterial({ color: g.kind === 'spring' ? 0xf2c230 : 0x9fe3a0, transparent: true, opacity: 0.25, wireframe: false }));
      m.position.set(cellX(g.c), -0.05, cellZ(g.r)); ghostGroup.add(m); ghostMeshes.set(k, m);
    }
    m.userData.in = g.in;
  }
  for (const [k, m] of ghostMeshes) if (!seenG.has(k)) { ghostGroup.remove(m); ghostMeshes.delete(k); }
}

// ---------- 狀態事件 → HUD ----------

// ---------- 打擊特效：揮擊弧光、命中爆點、飄字、鏡頭震動 ----------
const fxList = []; // { obj, t, dur, tick(q) }
let shakeAmt = 0, bossFlash = 0, bossJolt = 0, bossMats = null;
const camBase = new THREE.Vector3();
function addFx(obj, dur, tick) { world.add(obj); fxList.push({ obj, t: 0, dur, tick }); return obj; }
function burstTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  g.translate(128, 128); g.fillStyle = '#fff';
  g.beginPath(); for (let i = 0; i < 20; i++) { const a = i / 20 * Math.PI * 2, r = i % 2 ? 46 : 120; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
const burstTex = burstTexture();
function spawnSwoosh(p, color, big) {
  // 玩家面前的扇形弧光：不管有沒有打中都看得到自己揮了
  const R = big ? 2.6 : 1.6;
  const geo = new THREE.RingGeometry(R * 0.45, R, 24, 1, -1.15, 2.3);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).lerp(WHITE, 0.55), transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
  m.rotation.order = 'YXZ'; m.rotation.x = -Math.PI / 2; m.rotation.y = p.facing - Math.PI / 2; m.position.set(p.x, p.y + 0.55, p.z); m.renderOrder = 8;
  addFx(m, 0.28, (q) => { m.scale.setScalar(0.55 + q * 0.6); m.material.opacity = Math.min(1, 1.6 * (1 - q)); m.rotation.y = p.facing - Math.PI / 2 + (q - 0.5) * 0.9; });
}
function spawnImpact(x, y, z, color, text, size = 1) {
  const star = new THREE.Sprite(new THREE.SpriteMaterial({ map: burstTex, color: 0xffffff, transparent: true, depthTest: false })); star.position.set(x, y, z); star.renderOrder = 12;
  addFx(star, 0.3, (q) => { star.scale.setScalar(size * (1.2 + q * 2.6)); star.material.opacity = 1 - q * q; star.material.rotation = q * 0.6; star.material.color.set(q < 0.25 ? 0xffffff : color); });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 32), new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthTest: false })); ring.position.set(x, y, z); ring.quaternion.copy(camera.quaternion); ring.renderOrder = 11;
  addFx(ring, 0.45, (q) => { ring.scale.setScalar(size * (0.6 + q * 3.2)); ring.material.opacity = 0.9 * (1 - q); });
  for (let i = 0; i < 10; i++) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), new THREE.MeshBasicMaterial({ color: i % 3 ? color : 0xffffff, transparent: true }));
    const a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 4, vy = 3 + Math.random() * 4;
    addFx(s, 0.55, (q) => { const t = q * 0.55; s.position.set(x + Math.cos(a) * sp * t, y + vy * t - 10 * t * t, z + Math.sin(a) * sp * t); s.rotation.set(q * 9, q * 7, 0); s.material.opacity = 1 - q; });
  }
  if (text) { const tx = textSprite(text, '#fff', 'rgba(0,0,0,0)', 1.5 * size); tx.position.set(x, y + 0.6, z); addFx(tx, 0.9, (q) => { tx.position.y = y + 0.6 + q * 1.8; tx.material.opacity = q < 0.6 ? 1 : 1 - (q - 0.6) / 0.4; }); }
}
function spawnDust(x, y, z, size = 1) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.42, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.set(x, y + 0.03, z);
  addFx(ring, 0.35, (q) => { ring.scale.setScalar(size * (0.8 + q * 2.2)); ring.material.opacity = 0.7 * (1 - q); });
}
function updateFx(dt) {
  for (let i = fxList.length - 1; i >= 0; i--) {
    const f = fxList[i]; f.t += dt; const q = Math.min(1, f.t / f.dur); f.tick(q);
    if (q >= 1) { world.remove(f.obj); f.obj.geometry?.dispose?.(); f.obj.material?.dispose?.(); fxList.splice(i, 1); }
  }
  shakeAmt = Math.max(0, shakeAmt - dt * 2.4); bossFlash = Math.max(0, bossFlash - dt * 5); bossJolt = Math.max(0, bossJolt - dt * 4);
  camera.position.copy(camBase);
  if (shakeAmt > 0) { camera.position.x += (Math.random() - 0.5) * shakeAmt; camera.position.y += (Math.random() - 0.5) * shakeAmt; }
}
// 每位玩家新的一次敲擊：依伺服器回報的結果（core / brick / bell / miss）放特效
function onPlayerHit(side, p, s) {
  const color = COLORS[side];
  spawnSwoosh(p, color, p.ability === 'hammer');
  const b = s.boss;
  if (p.hit === 'core') { spawnImpact(b.x + b.core.x, b.y + b.core.y, b.z + b.core.z, 0xff3fd0, '-1', 1.3); shakeAmt = 0.55; bossFlash = 1; bossJolt = 1; popHearts(); }
  else if (p.hit === 'brick') { spawnImpact(b.x + b.mouthOff.x, b.y + b.mouthOff.y, b.z + b.mouthOff.z, 0xffd23f, '鏘！', 1.1); shakeAmt = 0.4; bossFlash = 0.8; bossJolt = 0.8; }
  else if (p.hit === 'mob') { spawnImpact(p.hx, p.hy, p.hz, 0xff7a3a, '砰！', 1.0); shakeAmt = 0.3; }
  else if (p.hit === 'orb') { spawnImpact(p.hx, p.hy, p.hz, 0xff5ad0, '', 0.7); }
  else if (p.hit === 'bell') { spawnImpact(s.tower.x + (s.tower.bellX || 0), s.tower.bellY + 0.3, s.tower.z + (s.tower.bellZ || 0), 0xffe07a, '噹！', 1.2); shakeAmt = 0.35; }
}
function popHearts() { const hp = $('hp'); hp.classList.remove('pop'); void hp.offsetWidth; hp.classList.add('pop'); }

// ---------- 小怪 / 光球 / 震波 / 衝撞通道 ----------
const mobViews = new Map(), orbViews = new Map(), waveMeshes = [];
let laneMesh = null;
function syncHazards(s, dt, T) {
  const seen = new Set();
  for (const m of s.mobs || []) {
    seen.add(m.id);
    let v = mobViews.get(m.id);
    if (!v) {
      const root = new THREE.Group(), model = models.mob[m.type].clone(); root.add(model);
      model.traverse((o) => { if (o.isMesh && o.material?.emissive) { o.material = o.material.clone(); o.userData.e0 = o.material.emissive.clone(); o.userData.i0 = o.material.emissiveIntensity; } });
      const tele = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 9), new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0.35, depthWrite: false })); tele.rotation.x = -Math.PI / 2; tele.position.set(0, 0.06, 4.5); tele.visible = false;
      const pivot = new THREE.Group(); pivot.add(tele); root.add(pivot);
      world.add(root); v = { root, model, pivot, tele, parts: {}, hp: m.hp };
      for (const n of ['Head', 'Claw_L', 'Claw_R', 'Foot_L', 'Foot_R', 'HoverBody', 'Fin_L', 'Fin_R', 'RamGuard', 'ChargeLight']) v.parts[n] = model.getObjectByName(n);
      root.position.set(m.x, m.y, m.z); mobViews.set(m.id, v);
    }
    v.last = m;
    tmpV.set(m.x, m.y, m.z); v.root.position.lerp(tmpV, 1 - Math.exp(-dt * 20));
    v.model.rotation.y = lerpAngle(v.model.rotation.y, m.f, 1 - Math.exp(-dt * 12)); v.pivot.rotation.y = v.model.rotation.y;
    const hurt = m.hurtAge < 0.25 ? 1 - m.hurtAge / 0.25 : 0, P = v.parts;
    v.model.traverse((o) => { if (o.userData.e0) { o.material.emissive.copy(o.userData.e0).lerp(WHITE, hurt); o.material.emissiveIntensity = lerp(o.userData.i0, 1.8, hurt); } });
    const wind = m.state === 'windup' || m.state === 'aim' || m.state === 'charge';
    const sq = hurt * 0.3 + (wind ? Math.sin(T * 30) * 0.05 : 0);
    v.model.scale.set(1 + sq, 1 - sq, 1 + sq);
    v.model.rotation.z = m.state === 'stun' ? Math.sin(T * 14) * 0.18 : 0;
    v.model.rotation.x = m.state === 'fall' ? T * 6 : m.state === 'dash' ? 0.25 : 0;
    const walk = Math.sin(T * 12);
    if (P.Foot_L) P.Foot_L.rotation.x = m.state === 'move' ? walk * 0.6 : 0; if (P.Foot_R) P.Foot_R.rotation.x = m.state === 'move' ? -walk * 0.6 : 0;
    const claw = m.state === 'windup' ? -1.5 : m.strikeAge < 0.2 ? 1.0 : 0;
    if (P.Claw_L) P.Claw_L.rotation.x = lerp(P.Claw_L.rotation.x, claw, 0.4); if (P.Claw_R) P.Claw_R.rotation.x = lerp(P.Claw_R.rotation.x, claw, 0.4);
    if (P.HoverBody) P.HoverBody.position.y = 0.64 + Math.sin(T * 3 + m.id) * 0.1; if (P.Fin_L) P.Fin_L.rotation.z = Math.sin(T * 6) * 0.4; if (P.Fin_R) P.Fin_R.rotation.z = -Math.sin(T * 6) * 0.4;
    if (P.RamGuard) P.RamGuard.position.z = 0.53 + (m.state === 'aim' ? -0.18 : m.state === 'dash' ? 0.2 : 0);
    if (P.ChargeLight?.material) P.ChargeLight.visible = m.state !== 'aim' || Math.sin(T * 40) > 0;
    v.tele.visible = m.type === 'charger' && m.state === 'aim'; if (v.tele.visible) v.tele.material.opacity = 0.25 + Math.sin(T * 20) * 0.15;
  }
  for (const [id, v] of mobViews) if (!seen.has(id)) { const l = v.last; if (l && l.y > -3) spawnImpact(l.x, l.y + 0.5, l.z, 0xff7a3a, '', 1.2); world.remove(v.root); mobViews.delete(id); }
  const seenO = new Set();
  for (const o of s.orbs || []) {
    seenO.add(o.id); let v = orbViews.get(o.id);
    if (!v) { v = models.orb.clone(); v.scale.setScalar(1.6); world.add(v); orbViews.set(o.id, v); v.position.set(o.x, o.y, o.z); }
    tmpV.set(o.x, o.y, o.z); v.position.lerp(tmpV, 1 - Math.exp(-dt * 25)); v.rotation.y = T * 8; v.scale.setScalar(1.6 + Math.sin(T * 20) * 0.25);
  }
  for (const [id, v] of orbViews) if (!seenO.has(id)) { world.remove(v); orbViews.delete(id); }
  // 震波：貼地白紅雙圈
  const waves = s.waves || [];
  while (waveMeshes.length < waves.length) { const m = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 64), new THREE.MeshBasicMaterial({ color: 0xff5a4a, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })); m.rotation.x = -Math.PI / 2; world.add(m); waveMeshes.push(m); }
  waveMeshes.forEach((m, i) => { const w = waves[i]; m.visible = !!w; if (w) { m.position.set(w.x, 0.08, w.z); m.scale.setScalar(w.r + 0.3); m.material.opacity = 0.55 + Math.sin(T * 30) * 0.3; } });
  // 衝撞通道
  const lane = s.boss.lane;
  if (!laneMesh) { laneMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.4, depthWrite: false })); laneMesh.rotation.x = -Math.PI / 2; world.add(laneMesh); }
  laneMesh.visible = !!lane && s.phase === 'play';
  if (lane) { const z0 = cellZ(-1.2), z1 = cellZ(gridInfo.rows - 0.3); laneMesh.position.set(lane.x, 0.07, (z0 + z1) / 2); laneMesh.scale.set(lane.w * 2, z1 - z0, 1); laneMesh.material.opacity = s.boss.state === 'charge' ? 0.6 : 0.25 + Math.abs(Math.sin(T * 9)) * 0.3; }
}

let lastEventT = -1, bannerUntil = 0;
let built = false;
function onState(s) {
  if (!built) { if (!models.tile) return; buildStatic(s); built = true; }
  syncTiles(s);
  const ev = s.lastEvent;
  if (ev && ev.t !== lastEventT) {
    lastEventT = ev.t;
    if (!ev.quiet && ev.text) {
      const b = $('banner'); b.textContent = ev.text; b.style.color = ev.side ? CSS_COLORS[ev.side] : (ev.type === 'win' ? '#7dff9a' : ev.type === 'lose' ? '#ff6b6b' : '#fff');
      b.classList.add('on'); bannerUntil = performance.now() + (ev.type === 'win' || ev.type === 'lose' ? 6000 : 2600);
    }
    if (ev.type === 'bell') bellSwing = 1;
  }
  updateHud(s);
}
let bellSwing = 0;

let lastPhase = null;
function updateHud(s) {
  const lobby = s.phase === 'lobby';
  if (s.phase !== lastPhase) { lastPhase = s.phase; if (lobby || s.phase === 'countdown') { $('banner').classList.remove('on'); bannerUntil = 0; } }
  $('lobby').classList.toggle('hidden', !lobby);
  $('hint').style.visibility = lobby ? 'hidden' : ''; // 大廳說明已涵蓋，避免和底部提示重疊
  $('result').classList.toggle('hidden', !(s.phase === 'win' || s.phase === 'lose'));
  $('countdown').classList.toggle('hidden', s.phase !== 'countdown');
  if (s.phase === 'countdown') $('countdown').textContent = Math.ceil(s.countdown) || 'GO';
  if (s.phase === 'win' || s.phase === 'lose') { $('resultTitle').textContent = s.phase === 'win' ? '🎉 核心粉碎！' : '⏰ 時間到'; $('resultText').textContent = s.phase === 'win' ? `島保住了！用時 ${fmt(300 - s.timeLeft)}` : '巨怪還在，島被啃光了……'; }
  const t = $('timer'); t.textContent = fmt(s.timeLeft); t.classList.toggle('low', s.timeLeft <= 30 && s.phase === 'play');
  // 巨怪 HP
  const hp = $('hp');
  while (hp.children.length - 1 < s.boss.maxHp) { const h = document.createElement('i'); h.className = 'heart'; hp.appendChild(h); }
  [...hp.querySelectorAll('.heart')].forEach((h, i) => { h.classList.toggle('off', i >= s.boss.hp); h.style.display = i < s.boss.maxHp ? '' : 'none'; h.style.marginLeft = i && i % 3 === 0 && s.boss.maxHp > 5 ? '10px' : ''; });
  hp.dataset.phase = s.boss.maxHp > 5 ? `第 ${s.boss.phase} 階段` : '';
  $('mode').textContent = s.bots ? '你 + 電腦搭檔（窗口加長）' : s.mode >= 2 ? '雙人合作' : s.mode === 1 ? '單人模式（窗口加長）' : '等待玩家';
  // 玩家卡
  const cards = [];
  for (const side of ['A', 'B']) {
    const p = s.players[side];
    const ab = p.ability ? `<span class="tag ${p.ability}">${s.abilities[p.ability].name}</span>` : '';
    let st = !p.connected ? '未加入' : p.bot && p.dead ? `電腦（${p.persona || ''}）· 掉下島… ${p.respawnIn.toFixed(1)}s` : p.dead ? `掉下島… ${p.respawnIn.toFixed(1)}s` : p.pad && p.padT ? `選擇中 ${Math.round(p.padT * 100)}%` : p.onTower ? '在鐘樓上' : s.marks.target === side && s.phase === 'play' ? '被盯上！' : (p.bot ? `電腦搭檔・${p.persona || ''}` : p.kb ? '鍵盤' : '手機');
    cards.push(`<div class="pcard pill ${side} ${p.connected ? '' : 'off'}"><div class="dot"></div><div><b>${side === 'A' ? '1P' : '2P'} ${LABEL[side]}${p.name && !p.kb && !p.bot ? ' · ' + esc(p.name) : ''}</b>${ab}<div class="st">${st}</div></div></div>`);
  }
  $('players').innerHTML = cards.join('');
  const n = s.mode;
  $('joinLine').textContent = n === 0 ? '等待手機加入…（或按 1 / 2 用鍵盤試玩）' : s.bots ? '電腦搭檔就位：向前短推開始！' : n === 1 ? '1 位玩家已加入：向前短推開始單人模式、等第二位加入，或按 B 加電腦搭檔' : '2 位玩家都到了：任一人向前短推開始！';
  // 底部提示
  $('hintText').innerHTML = hintFor(s);
}
function hintFor(s) {
  if (s.phase === 'lobby') return '手機掃 QR code 加入 → 向前短推開始。一個人也能玩，兩個人更快。';
  if (s.phase === 'countdown') return '準備！傾斜走位、手腕短抬跳躍、向前短推敲擊';
  if (s.phase === 'win') return '島保住了！向前短推或 Enter 再來一局';
  if (s.phase === 'lose') return '再試一次：向前短推或 Enter 重開';
  const b = s.boss;
  const springPlat = s.plats.find((p) => p[2] === 1);
  const springInZone = springPlat && s.bridge.some(([c, r]) => c === springPlat[0] && r === springPlat[1]);
  if (s.flight) return s.flight.ok ? '磚飛出去了！落地後會變成可踩的平台' : '<span class="zone-bad">磚飛出島外了……</span>彈簧磚會長回原位，再引一次';
  if (b.state === 'windup' && b.special === 'stomp') return '<b style="color:#ff6b6b">巨怪要震地！</b>紅色波紋掃到腳邊的瞬間跳起來（手腕短抬）';
  if ((b.state === 'windup' || b.state === 'charge') && b.special === 'charge') return '<b style="color:#ff6b6b">巨怪要直線衝撞！</b>離開紅色通道，往左右閃';
  if (b.state === 'windup' && b.special === 'summon') return '巨怪吐出小怪：靠近牠們向前短推敲掉，別被拍下島';
  if ((s.waves || []).length) return '<b style="color:#ff6b6b">震波來了！</b>掃到腳邊時跳起來';
  if (b.state === 'open') return `<span class="zone-ok">防護打開 ${b.openRemain.toFixed(1)} 秒</span>：靠近巨怪嘴前的粉紅核心，向前短推敲它！`;
  if (b.state === 'stuck') {
    const pr = s.preds.find((p) => p.ready) || s.preds[0];
    const where = pr ? (pr.inZone ? '<span class="zone-ok">落點對準斷橋 ✓</span>' : pr.ok ? '落點在島上（移動位置，讓黃色落點進到虛線格）' : '<span class="zone-bad">落點在海裡！換個方向</span>') : '走到巨怪側邊，黃色標記就是磚的落點';
    return `巨怪卡住 ${b.stuckRemain.toFixed(1)} 秒！${b.held === 'spring' ? '咬的是彈簧磚：' : ''}從側邊向前短推敲它 ・ ${where}`;
  }
  if (springInZone) {
    const anyTower = Object.values(s.players).some((p) => p.onTower);
    return anyTower ? '站在鐘樓上，靠近鐘向前短推敲鐘！' : '彈簧磚就位：走到斷橋旁踩上去，空中傾斜朝鐘樓，落在平台上敲鐘';
  }
  if (springPlat) return '彈簧磚落在島上：踩上去也能彈，但要落在鐘樓平台才行；或等它崩落長回原位再引一次';
  if (b.state === 'aim' || b.state === 'lock') {
    const t = b.target ? LABEL[b.target] : '';
    const springTile = s.tiles.find((t2) => t2[2] === 1);
    return `${t} 被盯上：${springTile ? '站到金色彈簧磚上，' : '站到想讓它咬的磚上，'}白色咬痕是候選格，<b style="color:#ff6b6b">紅色鎖定</b>出現就跳開`;
  }
  if (!s.tiles.some((t2) => t2[2] === 1)) { const g = s.regrow.find((x) => x.kind === 'spring'); return g ? `彈簧磚 ${Math.ceil(g.in)} 秒後長回原位，先避開巨怪` : '引巨怪咬下金色彈簧磚'; }
  return '引巨怪咬下金色彈簧磚：被盯上的人站上去，鎖定後跳開，搭檔準備在側邊敲';
}
function fmt(sec) { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- 每幀繪製 ----------
let lastFrame = performance.now();
const tmpV = new THREE.Vector3();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now;
  if (now > bannerUntil) $('banner').classList.remove('on');
  if (!state || !built) { renderer.render(scene, camera); return; }
  const s = state;
  const age = Math.min(0.12, (now - stateAt) / 1000);
  const k = 1 - Math.exp(-dt * 18);
  const T = now / 1000;

  // 玩家
  for (const side of ['A', 'B']) {
    const p = s.players[side], v = playerViews[side];
    v.root.visible = p.connected && !p.dead;
    if (!v.root.visible) continue;
    tmpV.set(p.x + p.vx * age, p.y + (p.grounded ? 0 : p.vy * age), p.z + p.vz * age);
    if (v.pos.distanceTo(tmpV) > 3) v.pos.copy(tmpV); else v.pos.lerp(tmpV, k);
    v.root.position.copy(v.pos);
    v.model.rotation.y = lerpAngle(v.model.rotation.y, p.facing, k);
    if (p.hitAge < v.lastHitAge - 0.05) onPlayerHit(side, p, s);
    if (p.hurtAge < (v.lastHurtAge ?? 99) - 0.05) { spawnImpact(p.x, p.y + 0.7, p.z, 0xffffff, '哎！', 0.9); shakeAmt = Math.max(shakeAmt, 0.45); }
    v.lastHurtAge = p.hurtAge;
    v.lastHitAge = p.hitAge;
    // 跳躍：起跳拉長、落地壓扁、腳下揚塵，影子隨高度縮小
    if (v.wasGrounded && !p.grounded && p.vy > 2) { v.squash = -1; spawnDust(p.x, p.y, p.z); }
    if (!v.wasGrounded && p.grounded) { if (v.airT > 0.25) { v.squash = 1; spawnDust(p.x, p.y, p.z, 1.4); } }
    v.airT = p.grounded ? 0 : v.airT + dt; v.wasGrounded = p.grounded;
    v.squash *= Math.exp(-dt * 9);
    // 敲擊時整個人往前撲一下
    const lunge = p.hitAge < 0.1 ? -0.12 : p.hitAge < 0.3 ? 0.38 * Math.sin((p.hitAge - 0.1) / 0.2 * Math.PI) : 0;
    v.model.position.set(Math.sin(p.facing) * lunge, 0, Math.cos(p.facing) * lunge);
    const sy = 1 - v.squash * 0.28 + (p.grounded ? 0 : 0.08), sxz = 1 + v.squash * 0.22;
    v.model.scale.set(sxz, sy, sxz);
    v.model.rotation.z = p.knocked ? T * 14 : 0; v.model.visible = !(p.hurtAge < 1.0 && !p.knocked && Math.sin(T * 40) > 0.3); // 被打飛翻滾、之後閃爍無敵
    v.model.rotation.x = p.hitAge < 0.3 ? 0.35 * Math.sin(p.hitAge / 0.3 * Math.PI) : (p.grounded ? 0 : -0.15);
    const speed = Math.hypot(p.vx, p.vz);
    v.phase += dt * (6 + speed * 2.2);
    const run = Math.min(1, speed / 3.5);
    const { armL, armR, legL, legR } = v.parts;
    if (!p.grounded) {
      if (legL) legL.rotation.x = lerp(legL.rotation.x, -0.7, k); if (legR) legR.rotation.x = lerp(legR.rotation.x, 0.4, k);
      if (armL) armL.rotation.x = lerp(armL.rotation.x, -2.4, k);
    } else {
      const sw = Math.sin(v.phase) * 0.75 * run;
      if (legL) legL.rotation.x = sw; if (legR) legR.rotation.x = -sw;
      if (armL) armL.rotation.x = -sw * 0.8;
    }
    // 敲擊：右臂舉起再揮下
    if (armR) {
      const h = p.hitAge;
      let target = p.grounded ? Math.sin(v.phase) * 0.75 * run : -1.2;
      if (h < 0.1) target = -2.9;
      else if (h < 0.3) target = lerp(-2.9, 1.3, (h - 0.1) / 0.2);
      else if (h < 0.55) target = lerp(1.3, target, (h - 0.3) / 0.25);
      armR.rotation.x = lerp(armR.rotation.x, target, h < 0.55 ? 0.75 : k);
      armR.scale.setScalar(h < 0.4 ? 1 + 0.9 * Math.sin(h / 0.4 * Math.PI) : 1); // 揮擊瞬間槌子放大
    }
    v.marker.position.y = 2.25 + Math.sin(T * 4 + (side === 'A' ? 0 : 1)) * 0.08;
    v.marker.rotation.y = T * 2;
    v.ring.visible = false && p.hitAge < 0.3; if (v.ring.visible) { const q = p.hitAge / 0.3; v.ring.scale.setScalar(0.6 + q * 1.4 * (p.ability === 'hammer' ? 1.6 : 1)); v.ring.material.opacity = 0.8 * (1 - q); }
    v.shadow.position.y = -p.y + 0.015; v.shadow.scale.setScalar(Math.max(0.45, 1 - Math.max(0, p.y) * 0.22));
    v.shadow.visible = p.y > -1;
    if (p.ability !== v.abilKind) {
      v.abilKind = p.ability; v.root.remove(v.abil);
      if (p.ability) { v.abil = textSprite(s.abilities[p.ability].name, '#fff', p.ability === 'boots' ? 'rgba(166,107,58,.9)' : 'rgba(53,208,224,.9)', 0.55); v.abil.position.y = 3.35; v.root.add(v.abil); }
    }
    if (s.marks.target === side && s.phase === 'play' && (s.boss.state === 'aim' || s.boss.state === 'lock')) v.marker.scale.setScalar(1.3 + Math.sin(T * 10) * 0.25); else v.marker.scale.setScalar(1);
  }

  // 巨怪
  const b = s.boss;
  tmpV.set(b.x, b.y, b.z);
  bossObj.position.lerp(tmpV, 1 - Math.exp(-dt * 14));
  if (b.state === 'stuck') { bossObj.position.x += (Math.random() - 0.5) * 0.08; bossObj.position.y += (Math.random() - 0.5) * 0.05; }
  if (b.state === 'recoil') bossObj.position.x += Math.sin(T * 30) * 0.05;
  const open = b.state === 'stuck' ? 0.08 : b.mouth;
  if (b.state === 'windup') { bossObj.position.x += Math.sin(T * 45) * 0.06; if (b.special === 'stomp') bossObj.rotation.x = -0.25; }
  if (b.state === 'charge') bossObj.rotation.x = 0.3;
  if (bossParts.upper) bossParts.upper.rotation.x = lerp(bossParts.upper.rotation.x, -open * 0.5, 1 - Math.exp(-dt * 10));
  if (bossParts.jaw) bossParts.jaw.rotation.x = lerp(bossParts.jaw.rotation.x, open * 0.65, 1 - Math.exp(-dt * 10));
  if (bossParts.core) {
    bossParts.core.visible = b.state === 'open';
    const pulse = 1 + Math.sin(T * 8) * 0.12 - (b.coreHitAge < 0.3 ? 0.45 * (1 - b.coreHitAge / 0.3) : 0); // 被打中先縮一下
    bossParts.core.scale.setScalar(pulse);
    if (bossParts.core.material?.emissiveIntensity != null) bossParts.core.material.emissiveIntensity = 0.9 + Math.sin(T * 8) * 0.5;
  }
  if (!bossMats) { bossMats = []; bossObj.traverse((o) => { if (o.isMesh && o !== bossParts.core && o.material?.emissive) { o.material = o.material.clone(); bossMats.push({ m: o.material, e: o.material.emissive.clone(), i: o.material.emissiveIntensity }); } }); }
  const rageGlow = b.rage ? 0.25 + Math.sin(T * 6) * 0.12 : b.phase === 2 ? 0.1 : 0;
  for (const { m, e, i } of bossMats) { m.emissive.copy(e).lerp(RED, rageGlow).lerp(WHITE, bossFlash); m.emissiveIntensity = lerp(i, 1.6, bossFlash); }
  bossObj.position.z -= bossJolt * 0.45; if (bossJolt > 0) bossObj.rotation.x = -bossJolt * 0.22; else if (b.state !== 'windup' && b.state !== 'charge') bossObj.rotation.x = 0;
  const bj = Math.sin(bossJolt * Math.PI); bossObj.scale.set(1 + bj * 0.14, 1 - bj * 0.12, 1 + bj * 0.14);
  bossObj.rotation.y = 0; bossObj.rotation.z = b.state === 'rest' || b.state === 'aim' ? Math.sin(T * 1.5) * 0.03 : 0;
  // 嘴裡的磚
  if (bossParts.socket) {
    if (b.held && (!heldBrick || heldBrick.userData.kind !== b.held)) { if (heldBrick) bossParts.socket.remove(heldBrick); heldBrick = (b.held === 'spring' ? models.spring : models.tile).clone(); heldBrick.userData.kind = b.held; heldBrick.scale.setScalar(0.8); heldBrick.position.y = -0.1; bossParts.socket.add(heldBrick); }
    if (!b.held && heldBrick) { bossParts.socket.remove(heldBrick); heldBrick = null; }
  }

  // 標記：候選咬痕 / 鎖定
  const cands = s.phase === 'play' && (b.state === 'aim' || b.state === 'lock') ? s.marks.cands : [];
  candDecals.forEach((d, i) => {
    const c = cands[i];
    d.visible = !!c && !(s.marks.locked && s.marks.locked[0] === c[0] && s.marks.locked[1] === c[1]);
    if (d.visible) { d.position.set(cellX(c[0]), 0.03, cellZ(c[1])); d.material.opacity = 0.35 + Math.sin(T * 3 + i) * 0.1; }
  });
  if (s.marks.locked && s.phase === 'play' && (b.state === 'lock' || b.state === 'lunge')) {
    lockDecal.visible = true; lockDecal.position.set(cellX(s.marks.locked[0]), 0.04, cellZ(s.marks.locked[1]));
    lockDecal.scale.setScalar(1 + Math.sin(T * 14) * 0.12); lockDecal.rotation.z = Math.sin(T * 14) * 0.08;
  } else lockDecal.visible = false;

  // 落點預測（優先顯示已在敲擊範圍內的玩家）
  const pr = s.preds.find((p) => p.ready) || s.preds[0];
  const mouth = { x: b.x + b.mouthOff.x, y: b.y + b.mouthOff.y, z: b.z + b.mouthOff.z };
  if (pr && b.state === 'stuck') {
    const lx = cellX(pr.c), lz = cellZ(pr.r);
    const top = platTopAt(pr.c, pr.r, s);
    landDecal.visible = landArrow.visible = landLabel.visible = previewLine.visible = true;
    const col = pr.inZone ? 0x7dff9a : pr.ok ? 0xffe14d : 0xff5555;
    landDecal.material.color.setHex(col); landArrow.material.color.setHex(col);
    landDecal.position.set(lx, (pr.ok ? top : -1.5) + 0.04, lz); landDecal.scale.setScalar(pr.ready ? 1 + Math.sin(T * 8) * 0.08 : 0.85);
    landArrow.position.set(lx, (pr.ok ? top : -1.5) + 1.1 + Math.sin(T * 6) * 0.15, lz);
    const want = pr.inZone ? '落點：斷橋 ✓' : pr.ok ? `落點（${LABEL[pr.side]} 敲）` : '落點：海裡 ✗';
    if (landLabel.userData.text !== want) { markGroup.remove(landLabel); landLabel = textSprite(want, pr.inZone ? '#7dff9a' : pr.ok ? '#ffe14d' : '#ff6b6b'); landLabel.userData.text = want; markGroup.add(landLabel); }
    landLabel.position.set(lx, (pr.ok ? top : -1.5) + 2.0, lz);
    setArc(previewLine, mouth, { x: lx, y: pr.ok ? top : -1.5, z: lz }, 3);
    previewLine.computeLineDistances();
    previewLine.material.color.setHex(col);
  } else { landDecal.visible = landArrow.visible = landLabel.visible = previewLine.visible = false; }

  // 飛行中的磚
  if (s.flight) {
    const f = s.flight;
    const p = Math.min(1, f.p + age / 1.1);
    if (!flightBrick || flightBrick.userData.kind !== f.kind) { if (flightBrick) world.remove(flightBrick); flightBrick = (f.kind === 'spring' ? models.spring : models.tile).clone(); flightBrick.userData.kind = f.kind; world.add(flightBrick); }
    const pos = arcPoint(f.from, f.to, p, 3);
    flightBrick.position.set(pos.x, pos.y, pos.z); flightBrick.rotation.set(p * 6, p * 3, 0);
    flightBrick.visible = true;
    setArc(flightLine, f.from, f.to, 3); flightLine.visible = true;
  } else { if (flightBrick) flightBrick.visible = false; flightLine.visible = false; }

  // 弱點
  if (b.state === 'open') {
    weakSprite.visible = weakLabel.visible = true;
    weakSprite.position.set(b.x + b.core.x, b.y + b.core.y, b.z + b.core.z + 0.2);
    weakSprite.scale.setScalar(2.0 + Math.sin(T * 7) * 0.25); weakSprite.material.rotation = T * 1.5;
    weakLabel.position.set(b.x + b.core.x, b.y + b.core.y + 1.9, b.z + b.core.z);
  } else weakSprite.visible = weakLabel.visible = false;

  // 能力區
  for (const pd of padDecals) {
    const info = s.pads.find((x) => x.kind === pd.kind);
    pd.d.visible = pd.label.visible = !!info;
    if (info) { pd.d.position.set(cellX(info.c), 0.03, cellZ(info.r)); pd.d.rotation.z = T * 0.6; pd.label.position.set(cellX(info.c), 1.5, cellZ(info.r)); }
  }
  // 斷橋格閃爍
  for (const d of bridgeDecals) d.material.opacity = 0.5 + Math.sin(T * 2.5) * 0.25;
  // 鬆動平台搖晃 / 新磚長出動畫
  for (const m of platMeshes.values()) {
    const age2 = (now - m.userData.born) / 1000;
    const grow = Math.min(1, age2 / 0.3);
    const wob = m.userData.loose && m.userData.remain < 8 ? Math.sin(T * 9) * 0.05 * (1 - m.userData.remain / 8) : 0;
    m.rotation.z = wob; m.scale.setScalar(0.6 + 0.4 * grow);
  }
  for (const m of tileMeshes.values()) { const age2 = (now - m.userData.born) / 1000; if (age2 < 0.5) m.scale.setScalar(Math.min(1, age2 / 0.5)); else if (m.scale.x !== 1) m.scale.setScalar(1); }
  for (const m of ghostMeshes.values()) m.material.opacity = 0.15 + Math.sin(T * 4) * 0.08;
  // 鐘
  if (bellPivot) { bellSwing = Math.max(0, bellSwing - dt * 0.35); bellPivot.rotation.z = Math.sin(T * 12) * 0.5 * bellSwing; }

  syncHazards(s, dt, T);
  updateFx(dt);
  renderer.render(scene, camera);
}
function platTopAt(c, r, s) { const p = s.plats.find((x) => x[0] === c && x[1] === r); if (p) return p[3]; return s.tiles.some((t) => t[0] === c && t[1] === r) ? s.grid.tileH : 0; }
function arcPoint(a, b, t, h) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + Math.sin(t * Math.PI) * h, z: a.z + (b.z - a.z) * t }; }
function setArc(line, a, b, h) {
  const pos = line.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) { const q = arcPoint(a, b, i / (pos.count - 1), h); pos.setXYZ(i, q.x, q.y + 0.05, q.z); }
  pos.needsUpdate = true; line.geometry.computeBoundingSphere();
}
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpAngle(a, b, t) { let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; }

// ---------- 鍵盤除錯 ----------
const kbOn = { A: false, B: false };
const keys = new Set();
const KEYMAP = {
  A: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', hit: 'KeyE' },
  B: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', jump: 'Enter', hit: 'ShiftRight' },
};
const lastKbSent = { A: { x: 9, y: 9 }, B: { x: 9, y: 9 } };
addEventListener('keydown', (e) => {
  if (e.repeat) { if (Object.values(KEYMAP).some((m) => Object.values(m).includes(e.code))) e.preventDefault(); return; }
  if (e.code === 'Digit1' || e.code === 'Digit2') { const side = e.code === 'Digit1' ? 'A' : 'B'; kbOn[side] = !kbOn[side]; ws.send({ type: 'kb', side, on: kbOn[side] }); return; }
  if (e.code === 'KeyR') { ws.send({ type: 'reset' }); return; }
  if (e.code === 'Enter' && (state?.phase === 'win' || state?.phase === 'lose')) { ws.send({ type: 'restart' }); return; }
  if (e.code === 'KeyB') { // 電腦搭檔：有就移除，沒有就加到空位
    const botSide = ['A', 'B'].find((sd) => state?.players?.[sd]?.bot);
    if (botSide) ws.send({ type: 'bot', side: botSide, on: false });
    else { const free = ['A', 'B'].find((sd) => !state?.players?.[sd]?.connected); if (free) ws.send({ type: 'bot', side: free, on: true }); }
    return;
  }
  if (e.code === 'KeyF') { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); return; }
  for (const side of ['A', 'B']) {
    const m = KEYMAP[side];
    if (e.code === m.jump || e.code === m.hit) {
      e.preventDefault();
      if (!kbOn[side] && !state?.players?.[side]?.connected) { kbOn[side] = true; ws.send({ type: 'kb', side, on: true }); }
      if (kbOn[side]) ws.send({ type: 'input', side, act: e.code === m.jump ? 'jump' : 'hit' });
    }
    if ([m.up, m.down, m.left, m.right].includes(e.code)) { e.preventDefault(); keys.add(e.code); if (!kbOn[side] && !state?.players?.[side]?.connected) { kbOn[side] = true; ws.send({ type: 'kb', side, on: true }); } }
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
setInterval(() => {
  for (const side of ['A', 'B']) {
    if (!kbOn[side]) continue;
    const m = KEYMAP[side];
    const x = (keys.has(m.right) ? 1 : 0) - (keys.has(m.left) ? 1 : 0);
    const y = (keys.has(m.down) ? 1 : 0) - (keys.has(m.up) ? 1 : 0);
    const last = lastKbSent[side];
    if (x !== last.x || y !== last.y) { lastKbSent[side] = { x, y }; ws.send({ type: 'input', side, x, y }); }
  }
}, 50);

// ---------- 啟動 ----------
loadModels().then(() => {
  resize();
  if (state) onState(state);
  const missing = Object.entries(models.usingGlb).filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length) console.info(`[島口大開] 找不到 GLB，使用程式替代模型：${missing.join(', ')}（放進 public/assets/island/ 即可自動載入）`);
});
requestAnimationFrame(frame);
