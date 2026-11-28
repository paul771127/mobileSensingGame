// 《島口大開》顯示端：固定斜俯視 3D 場地，1～4 人合作闖關。所有提示、升級選單、結算都在這個畫面。
// 模型從 /assets/island/*.glb 載入（見 docs/ISLAND_COOP_ART.md），缺檔時用程式建立同名節點的替代模型。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { connect, qs } from '/common.js';

const $ = (id) => document.getElementById(id);
const SIDES = ['A', 'B', 'C', 'D'];
const COLORS = { A: 0x3aa0ff, B: 0xff9f2e, C: 0xb07cff, D: 0x3fd37a };
const CSS = { A: '#3aa0ff', B: '#ff9f2e', C: '#b07cff', D: '#3fd37a', accent: '#d9ff4a' };
const LABEL = { A: '藍', B: '橘', C: '紫', D: '綠' };
const PNUM = { A: 'P1', B: 'P2', C: 'P3', D: 'P4' };

let roomCode = (qs('room') || '').toUpperCase();
let joinedMsg = null;
let state = null, stateAt = 0;

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
    state = msg.state; stateAt = performance.now();
    window.__islandState = state; // 給自動化測試讀取
    onState(state);
  }
}
let hostIdx = 0;
function controllerUrl() {
  let host = qs('host') || location.hostname;
  if ((host === 'localhost' || host === '127.0.0.1') && joinedMsg?.hosts?.length) host = joinedMsg.hosts[hostIdx % joinedMsg.hosts.length];
  const port = location.port ? `:${location.port}` : '';
  return `${location.protocol}//${host}${port}/island/controller?room=${roomCode}`;
}
function loadQr() { const url = controllerUrl(); const src = `/qr?text=${encodeURIComponent(url)}`; $('qrBig').src = src; $('qrSmall').src = src; $('qrUrl').textContent = url; }
function buildHostPicker() {
  const box = $('hosts'); const hosts = joinedMsg?.hosts || [];
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!local || hosts.length < 2) { box.style.display = 'none'; return; }
  box.style.display = 'flex'; box.replaceChildren(document.createTextNode('QR code 用的 IP：'));
  hosts.forEach((h, i) => { const b = document.createElement('button'); b.textContent = h; b.className = i === hostIdx ? 'on' : ''; b.onclick = () => { hostIdx = i; loadQr(); buildHostPicker(); }; box.appendChild(b); });
}

// ---------- Three.js 基礎 ----------
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const BG = 0x5a7a92;
scene.background = new THREE.Color(BG); scene.fog = new THREE.Fog(BG, 40, 75);
const camera = new THREE.PerspectiveCamera(36, 1, 0.5, 200);
const CAM_DIR = new THREE.Vector3(0.22, 0.86, 0.86).normalize();
scene.add(new THREE.HemisphereLight(0xe6f0f7, 0x3a5a4a, 1.1));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.5);
sun.position.set(-10, 16, 9); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 60; sun.shadow.camera.left = -18; sun.shadow.camera.right = 18; sun.shadow.camera.top = 16; sun.shadow.camera.bottom = -16; sun.shadow.bias = -0.0005;
scene.add(sun); scene.add(sun.target);
const fill = new THREE.DirectionalLight(0xbfd8ee, 0.4); fill.position.set(10, 6, -8); scene.add(fill);
const sea = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x54748c, roughness: 0.9 }));
sea.rotation.x = -Math.PI / 2; sea.position.y = -2.2; sea.receiveShadow = true; scene.add(sea);
const ROCK_MAT = new THREE.MeshStandardMaterial({ color: 0x0b2238, roughness: 0.95, flatShading: true });
for (const [x, z, r] of [[-11, -5, 0.9], [-11.5, 4, 0.6], [11.5, 5.5, 0.8], [12, -5, 0.55], [4, 9.5, 0.6], [-5, 9, 0.45], [13, 0, 0.5]]) {
  const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), ROCK_MAT); rock.position.set(x, -2.2 + r * 0.25, z); rock.scale.y = 0.65; rock.rotation.set(0.3, x * 0.7, 0); rock.castShadow = rock.receiveShadow = true; scene.add(rock);
}
let worldBounds = null;
function fitCamera() {
  if (!worldBounds) return;
  const b = worldBounds;
  const center = new THREE.Vector3((b.minX + b.maxX) / 2, 0.6, (b.minZ + b.maxZ) / 2 + 0.4);
  const corners = []; for (const x of [b.minX, b.maxX]) for (const y of [-0.5, 3.2]) for (const z of [b.minZ, b.maxZ]) corners.push(new THREE.Vector3(x, y, z));
  let lo = 8, hi = 80;
  for (let i = 0; i < 24; i++) {
    const d = (lo + hi) / 2; camera.position.copy(center).addScaledVector(CAM_DIR, d); camera.lookAt(center); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
    let ok = true; for (const c of corners) { const p = c.clone().project(camera); if (Math.abs(p.x) > 0.96 || Math.abs(p.y) > 0.84) { ok = false; break; } }
    if (ok) hi = d; else lo = d;
  }
  camera.position.copy(center).addScaledVector(CAM_DIR, hi); camera.lookAt(center); sun.target.position.copy(center);
}
function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); fitCamera(); }
addEventListener('resize', resize);

// ---------- 模型 ----------
const loader = new GLTFLoader();
const models = {};
async function loadGlb(name) {
  try { const gltf = await loader.loadAsync(`/assets/island/${name}.glb`); gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } }); return gltf.scene; } catch { return null; }
}
const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...extra });
function box(w, h, d, m, x = 0, y = 0, z = 0) { const g = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); g.position.set(x, y, z); g.castShadow = g.receiveShadow = true; return g; }
function sphere(r, m, x = 0, y = 0, z = 0, seg = 16) { const g = new THREE.Mesh(new THREE.SphereGeometry(r, seg, seg), m); g.position.set(x, y, z); g.castShadow = true; return g; }
function cyl(rt, rb, h, m, x = 0, y = 0, z = 0, seg = 16) { const g = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), m); g.position.set(x, y, z); g.castShadow = g.receiveShadow = true; return g; }
function fallbackTile() { const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.BoxGeometry(1.44, 0.5, 1.44), [mat(0x0a4a52), mat(0x0a4a52), mat(0x6fbf5a), mat(0x05283a), mat(0x0a4a52), mat(0x0a4a52)]); m.position.y = -0.25; m.castShadow = m.receiveShadow = true; g.add(m); return g; }
function fallbackRepairer(color) {
  const g = new THREE.Group(); const team = mat(color), skin = mat(0xf3d2b3), dark = mat(0x2b2f45);
  g.add(box(0.44, 0.36, 0.3, team, 0, 0.49, 0)); g.add(sphere(0.24, skin, 0, 0.86, 0)); g.add(box(0.4, 0.14, 0.1, dark, 0, 0.84, 0.23));
  for (const [name, x] of [['Arm_L', -0.26], ['Arm_R', 0.26]]) { const a = new THREE.Group(); a.name = name; a.position.set(x, 0.6, 0); a.add(box(0.14, 0.3, 0.14, team, 0, -0.15, 0)); if (name === 'Arm_R') a.add(box(0.22, 0.15, 0.15, mat(0xf2c230), 0, -0.24, 0.33)); g.add(a); }
  for (const [name, x] of [['Leg_L', -0.13], ['Leg_R', 0.13]]) { const l = new THREE.Group(); l.name = name; l.position.set(x, 0.38, 0); l.add(box(0.15, 0.38, 0.15, dark, 0, -0.19, 0)); g.add(l); }
  return g;
}
function fallbackMob(kind) {
  const g = new THREE.Group();
  if (kind === 'grunt') { g.add(box(0.8, 0.5, 0.6, mat(0x8a2a2a), 0, 0.35, 0)); const h = new THREE.Group(); h.name = 'Head'; h.position.set(0, 0.5, 0.2); h.add(box(0.44, 0.1, 0.05, mat(0x111111), 0, 0.03, 0.28)); g.add(h); for (const [n, x] of [['Claw_L', -0.38], ['Claw_R', 0.38]]) { const c = new THREE.Group(); c.name = n; c.position.set(x, 0.36, 0.17); c.add(box(0.2, 0.2, 0.38, mat(0xff3020), 0, 0, 0.14)); g.add(c); } }
  else if (kind === 'ranged') { const hb = new THREE.Group(); hb.name = 'HoverBody'; hb.position.set(0, 0.64, 0); hb.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.42), mat(0x4a2a8a))); const sock = new THREE.Group(); sock.name = 'ProjectileSocket'; sock.position.set(0, -0.02, 0.48); hb.add(sock); hb.add(sphere(0.1, new THREE.MeshStandardMaterial({ color: 0x8ad6ff, emissive: 0x2a8ab0 }), 0, 0, 0.42)); g.add(hb); }
  else { g.add(box(1.5, 0.5, 1.4, mat(0x2a1830), 0, 0.5, 0)); g.add(box(1.3, 0.35, 1.0, mat(0x6a1a1a), 0, 0.95, -0.1)); const rg = new THREE.Group(); rg.name = 'RamGuard'; rg.position.set(0, 0.54, 0.53); rg.add(box(1.4, 0.5, 0.3, mat(0xff8a2a), 0, 0, 0.3)); const cl = sphere(0.12, new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010 }), 0, 0.08, 0.5); cl.name = 'ChargeLight'; rg.add(cl); g.add(rg); }
  return g;
}
function fallbackBoss() {
  const root = new THREE.Group(); root.name = 'Boss'; const purple = mat(0x0a4a58), tooth = mat(0xfff6e0);
  root.add(box(2.6, 2.2, 2.0, purple, 0, 1.3, -0.3));
  const upper = new THREE.Group(); upper.name = 'UpperJaw'; upper.position.set(0, 1.42, 0.18); upper.add(box(2.5, 0.7, 1.0, purple, 0, 0.3, 0.6)); for (let i = 0; i < 4; i++) upper.add(cyl(0.08, 0, 0.3, tooth, -0.75 + i * 0.5, -0.1, 1.0, 6)); root.add(upper);
  const jaw = new THREE.Group(); jaw.name = 'Jaw'; jaw.position.set(0, 0.54, 0.17); jaw.add(box(2.3, 0.4, 1.1, mat(0x073a46), 0, -0.1, 0.6)); root.add(jaw);
  const sock = new THREE.Group(); sock.name = 'BrickSocket'; sock.position.set(0, 0.95, 1.05); root.add(sock);
  const core = sphere(0.36, new THREE.MeshStandardMaterial({ color: 0xff3fd0, emissive: 0xff2fb0, emissiveIntensity: 1.2 }), 0, 1.0, 0.77); core.name = 'Core'; root.add(core);
  return root;
}
function fallbackGate() { const g = new THREE.Group(); const t = mat(0x0a4a58); g.add(box(0.4, 1.7, 0.4, t, -0.77, 0.85, 0)); g.add(box(0.4, 1.7, 0.4, t, 0.77, 0.85, 0)); g.add(box(2.1, 0.25, 0.5, mat(0x05283a), 0, 1.76, 0)); const c = new THREE.Group(); c.name = 'GateCenter'; c.position.set(0, 0.8, 0); g.add(c); return g; }
function fallbackShrine() { const g = new THREE.Group(); g.add(cyl(0.5, 0.6, 0.3, mat(0x05283a), 0, 0.15, 0)); const p = new THREE.Group(); p.name = 'CrystalPivot'; p.position.set(0, 0.72, 0); p.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.28), new THREE.MeshStandardMaterial({ color: 0x8ad6ff, emissive: 0x2a8ab0 }))); g.add(p); return g; }
async function loadModels() {
  const names = { tile: 'ground-tile', A: 'repairer-blue', B: 'repairer-orange', C: 'repairer-purple', D: 'repairer-green', boss: 'chomp-boss', grunt: 'mob-melee', ranged: 'mob-ranged', elite: 'mob-charger', orb: 'enemy-orb', gate: 'stage-gate', shrine: 'upgrade-shrine' };
  const loaded = await Promise.all(Object.values(names).map(loadGlb));
  models.usingGlb = {};
  Object.keys(names).forEach((k, i) => { models[k] = loaded[i]; models.usingGlb[k] = !!loaded[i]; });
  models.tile ||= fallbackTile();
  for (const s of SIDES) models[s] ||= fallbackRepairer(COLORS[s]);
  models.boss ||= fallbackBoss(); models.grunt ||= fallbackMob('grunt'); models.ranged ||= fallbackMob('ranged'); models.elite ||= fallbackMob('elite');
  models.orb ||= (() => { const g = new THREE.Group(); g.add(sphere(0.14, new THREE.MeshStandardMaterial({ color: 0x8ad6ff, emissive: 0x2a8ab0, emissiveIntensity: 1.2 }))); return g; })();
  models.gate ||= fallbackGate(); models.shrine ||= fallbackShrine();
}

// ---------- 程式畫的貼圖 / 文字 ----------
function canvasTex(size, draw) { const c = document.createElement('canvas'); c.width = c.height = size; const ctx = c.getContext('2d'); draw(ctx, size); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }
const biteTex = canvasTex(256, (ctx, s) => {
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 10; ctx.lineCap = 'round'; ctx.fillStyle = '#fff';
  for (const dir of [1, -1]) { ctx.beginPath(); ctx.arc(s / 2, s / 2, s * 0.36, dir > 0 ? Math.PI * 1.15 : Math.PI * 0.15, dir > 0 ? Math.PI * 1.85 : Math.PI * 0.85); ctx.stroke(); for (let i = 0; i < 6; i++) { const a = (dir > 0 ? Math.PI * 1.22 : Math.PI * 0.22) + i * Math.PI * 0.11; const x = s / 2 + Math.cos(a) * s * 0.36, y = s / 2 + Math.sin(a) * s * 0.36; ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.lineTo(x, y - dir * 30); ctx.closePath(); ctx.fill(); } }
});
const ringTex = canvasTex(256, (ctx, s) => { ctx.strokeStyle = '#fff'; ctx.lineWidth = 14; ctx.beginPath(); ctx.arc(s / 2, s / 2, 100, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([14, 14]); ctx.lineWidth = 6; ctx.beginPath(); ctx.arc(s / 2, s / 2, 70, 0, Math.PI * 2); ctx.stroke(); });
const weakTex = canvasTex(256, (ctx, s) => { ctx.strokeStyle = '#fff'; ctx.lineWidth = 12; ctx.lineJoin = 'round'; ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; const x = s / 2 + Math.cos(a) * 88, y = s / 2 + Math.sin(a) * 88; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.closePath(); ctx.stroke(); ctx.lineWidth = 10; for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + Math.PI / 6; ctx.beginPath(); ctx.moveTo(s / 2 + Math.cos(a) * 96, s / 2 + Math.sin(a) * 96); ctx.lineTo(s / 2 + Math.cos(a) * 120, s / 2 + Math.sin(a) * 120); ctx.stroke(); } });
const arrowTex = canvasTex(256, (ctx, s) => { ctx.fillStyle = '#fff'; for (let i = 0; i < 4; i++) { const y = 40 + i * 56; ctx.beginPath(); ctx.moveTo(s / 2 - 50, y + 30); ctx.lineTo(s / 2, y); ctx.lineTo(s / 2 + 50, y + 30); ctx.lineTo(s / 2 + 50, y + 46); ctx.lineTo(s / 2, y + 16); ctx.lineTo(s / 2 - 50, y + 46); ctx.closePath(); ctx.fill(); } });
function textSprite(text, color = '#fff', bg = 'rgba(10,16,38,.75)', scale = 1) {
  const c = document.createElement('canvas'); const ctx = c.getContext('2d'); const font = 'bold 64px system-ui, "Noto Sans TC", sans-serif';
  ctx.font = font; const w = Math.ceil(ctx.measureText(text).width) + 56; c.width = Math.max(96, Math.min(2048, w)); c.height = 128; ctx.font = font;
  ctx.fillStyle = bg; roundRect(ctx, 4, 14, c.width - 8, 100, 28); ctx.fill(); ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, c.width / 2, 66);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true })); sp.scale.set(c.width * 0.00625 * scale, 0.8 * scale, 1); sp.renderOrder = 10; return sp;
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function decal(tex, color, size = 1.4, opacity = 1) { const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity, depthWrite: false })); m.rotation.x = -Math.PI / 2; m.renderOrder = 5; return m; }
// 小血條：兩個 Sprite（底 + 前景，左對齊）
function hpBar(width = 0.9) {
  const g = new THREE.Group();
  const bg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x0a1020, depthTest: false, transparent: true, opacity: 0.8 })); bg.scale.set(width, 0.12, 1); bg.renderOrder = 9;
  const fg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xff4f7a, depthTest: false })); fg.center.set(0, 0.5); fg.position.x = -width / 2; fg.scale.set(width, 0.09, 1); fg.renderOrder = 10;
  g.add(bg, fg); g.userData = { fg, width }; return g;
}

// ---------- 場景物件 ----------
const world = new THREE.Group(); scene.add(world);
const tilesGroup = new THREE.Group(), markGroup = new THREE.Group(), enemyGroup = new THREE.Group(); world.add(tilesGroup, markGroup, enemyGroup);
const tileMeshes = new Map(), ghostMeshes = new Map(), enemyViews = new Map(), spawnDecals = [], projMeshes = [];
const playerViews = {};
let bossObj = null, bossParts = {}, gateObj = null, gateGlow = null, shrineObj = null, shrineRing = null, crystal = null;
let lockDecals = [], candDecals = [], weakSprite, weakLabel, coreBeacon, coreLabel, gridInfo = null;
const cellX = (c) => (c - gridInfo.cx) * gridInfo.s, cellZ = (r) => (r - gridInfo.cz) * gridInfo.s;

function buildStatic(s) {
  gridInfo = s.grid;
  // 關卡門（北邊）
  gateObj = models.gate.clone(); gateObj.scale.setScalar(1.3); gateObj.position.set(s.gate.x, 0, s.gate.z); world.add(gateObj);
  gateGlow = new THREE.Mesh(new THREE.PlaneGeometry(1.5 * 1.3, 1.55 * 1.3), new THREE.MeshBasicMaterial({ color: 0x8af5ff, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false }));
  gateObj.updateMatrixWorld(true);
  const gc = gateObj.getObjectByName('GateCenter'); const gp = gc ? gc.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(s.gate.x, 1.0, s.gate.z);
  gateGlow.position.copy(gp); world.add(gateGlow);
  // 升級台（中央，升級時出現）
  shrineObj = models.shrine.clone(); shrineObj.scale.setScalar(1.3); shrineObj.position.set(s.shrine.x, 0, s.shrine.z); shrineObj.visible = false; world.add(shrineObj);
  crystal = shrineObj.getObjectByName('CrystalPivot');
  shrineRing = decal(ringTex, 0x8af5ff, 3, 0.8); shrineRing.position.set(s.shrine.x, 0.04, s.shrine.z); shrineRing.visible = false; markGroup.add(shrineRing);
  // Boss
  bossObj = models.boss.clone(); bossObj.visible = false; world.add(bossObj);
  bossParts = { upper: bossObj.getObjectByName('UpperJaw'), jaw: bossObj.getObjectByName('Jaw'), core: bossObj.getObjectByName('Core') };
  if (bossParts.core) { bossParts.core.visible = false; if (bossParts.core.material) { bossParts.core.material = bossParts.core.material.clone(); bossParts.core.material.emissive = new THREE.Color(0xff2a3a); bossParts.core.material.emissiveIntensity = 1.2; } }
  bossObj.traverse((o) => { if (o.isMesh && o.material?.name === 'gold_glow') { o.material = o.material.clone(); o.material.emissiveIntensity = 1.5; } });
  for (let i = 0; i < 9; i++) { const d = decal(biteTex, 0x0b2238, 1.3, 0.55); d.visible = false; markGroup.add(d); candDecals.push(d); const l = decal(biteTex, 0xff3b3b, 1.5, 0.95); l.visible = false; markGroup.add(l); lockDecals.push(l); }
  weakSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: weakTex, color: 0xff3fd0, transparent: true, depthTest: false })); weakSprite.scale.set(2.2, 2.2, 1); weakSprite.visible = false; weakSprite.renderOrder = 9; markGroup.add(weakSprite);
  weakLabel = textSprite('核心露出：上前打！', '#ff9fe8'); weakLabel.visible = false; markGroup.add(weakLabel);
  coreBeacon = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 5, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xff9fe8, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false })); coreBeacon.visible = false; markGroup.add(coreBeacon);
  coreLabel = textSprite('站這裡打核心', '#fff', 'rgba(255,63,208,.85)', 0.8); coreLabel.visible = false; markGroup.add(coreLabel);
  // 玩家
  for (const side of SIDES) {
    const root = new THREE.Group(); const tilt = new THREE.Group(); root.add(tilt);
    const model = models[side].clone(); if (models.usingGlb[side]) model.scale.setScalar(1.25); tilt.add(model);
    const h = new THREE.Box3().setFromObject(model).max.y;
    const marker = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.45, 5), new THREE.MeshBasicMaterial({ color: COLORS[side] })); marker.rotation.x = Math.PI; marker.position.y = h + 0.55; root.add(marker);
    const label = textSprite(`${PNUM[side]} ${LABEL[side]}`, '#fff', `${CSS[side]}dd`, 0.7); label.position.y = h + 1.15; root.add(label);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.6, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.visible = false; root.add(ring);
    const quake = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 40), new THREE.MeshBasicMaterial({ color: 0xffd46d, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })); quake.rotation.x = -Math.PI / 2; quake.position.y = 0.04; quake.visible = false; root.add(quake);
    const shield = new THREE.Mesh(new THREE.SphereGeometry(0.85, 20, 16), new THREE.MeshBasicMaterial({ color: 0x64eba6, transparent: true, opacity: 0.22, depthWrite: false })); shield.position.y = 0.7; shield.visible = false; root.add(shield);
    const whirl = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.06, 8, 32), new THREE.MeshBasicMaterial({ color: 0xc997ff, transparent: true, opacity: 0.8 })); whirl.rotation.x = Math.PI / 2; whirl.position.y = 0.5; whirl.visible = false; root.add(whirl);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.015; root.add(shadow);
    const revive = hpBar(1.1); revive.position.y = 1.2; revive.visible = false; revive.userData.fg.material.color.setHex(0x64eba6); root.add(revive);
    const downLabel = textSprite('倒地！靠近救援', '#fff', 'rgba(255,79,122,.9)', 0.7); downLabel.position.y = 1.7; downLabel.visible = false; root.add(downLabel);
    root.visible = false; world.add(root);
    playerViews[side] = { root, tilt, model, marker, label, ring, quake, shield, whirl, shadow, revive, downLabel, h, parts: { armL: model.getObjectByName('Arm_L'), armR: model.getObjectByName('Arm_R'), legL: model.getObjectByName('Leg_L'), legR: model.getObjectByName('Leg_R') }, pos: new THREE.Vector3(), phase: 0, downTilt: 0 };
  }
  worldBounds = { minX: cellX(-0.4), maxX: cellX(gridInfo.cols - 0.6), minZ: s.gate.z - 2.4, maxZ: cellZ(gridInfo.rows - 0.6) };
  resize();
}

function syncTiles(s) {
  const seen = new Set();
  for (const [c, r] of s.tiles) { const k = `${c},${r}`; seen.add(k); if (!tileMeshes.has(k)) { const m = models.tile.clone(); m.userData.born = performance.now(); m.position.set(cellX(c), 0, cellZ(r)); tilesGroup.add(m); tileMeshes.set(k, m); } }
  for (const [k, m] of tileMeshes) if (!seen.has(k)) { tilesGroup.remove(m); tileMeshes.delete(k); }
  const seenG = new Set();
  for (const g of s.regrow) { const k = `${g.c},${g.r}`; seenG.add(k); if (tileMeshes.has(k)) continue; let m = ghostMeshes.get(k); if (!m) { m = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 1.3), new THREE.MeshBasicMaterial({ color: 0x9fe3a0, transparent: true, opacity: 0.2 })); m.position.set(cellX(g.c), -0.05, cellZ(g.r)); markGroup.add(m); ghostMeshes.set(k, m); } }
  for (const [k, m] of ghostMeshes) if (!seenG.has(k)) { markGroup.remove(m); ghostMeshes.delete(k); }
}
const ENEMY_SCALE = { grunt: 1.35, ranged: 1.25, elite: 1.2 };
function syncEnemies(s) {
  const seen = new Set();
  for (const e of s.enemies) {
    seen.add(e.id);
    let v = enemyViews.get(e.id);
    if (!v) {
      const root = new THREE.Group(); const model = models[e.kind].clone(); model.scale.setScalar(ENEMY_SCALE[e.kind]); root.add(model);
      const h = new THREE.Box3().setFromObject(model).max.y;
      const bar = hpBar(e.kind === 'elite' ? 1.4 : 0.9); bar.position.y = h + 0.35; bar.visible = false; root.add(bar);
      const tele = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 24), new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })); tele.rotation.x = -Math.PI / 2; tele.position.y = 0.03; tele.visible = false; root.add(tele);
      let charge = null;
      if (e.kind === 'elite') { // 衝撞線：外層群組轉朝向、內層平面拉長
        charge = new THREE.Group();
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1), new THREE.MeshBasicMaterial({ map: arrowTex, color: 0xff3a2a, transparent: true, opacity: 0.85, depthWrite: false }));
        plane.rotation.x = -Math.PI / 2; plane.renderOrder = 6; charge.add(plane); charge.userData.plane = plane; charge.visible = false; markGroup.add(charge);
      }
      const chain = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0x8becff, transparent: true, opacity: 0.9 })); chain.visible = false; markGroup.add(chain);
      v = { root, model, bar, tele, charge, chain, h, pos: new THREE.Vector3(e.x, e.y, e.z), parts: { head: model.getObjectByName('Head'), clawL: model.getObjectByName('Claw_L'), clawR: model.getObjectByName('Claw_R'), footL: model.getObjectByName('Foot_L'), footR: model.getObjectByName('Foot_R'), hover: model.getObjectByName('HoverBody'), finL: model.getObjectByName('Fin_L'), finR: model.getObjectByName('Fin_R'), socket: model.getObjectByName('ProjectileSocket'), ram: model.getObjectByName('RamGuard'), light: model.getObjectByName('ChargeLight') }, phase: Math.random() * 6 };
      if (v.parts.light && v.parts.light.material) v.parts.light.material = v.parts.light.material.clone();
      if (v.parts.socket) { const glow = sphere(0.12, new THREE.MeshBasicMaterial({ color: 0x8ad6ff, transparent: true, opacity: 0.9 }), 0, 0, 0, 10); glow.visible = false; v.parts.socket.add(glow); v.glow = glow; }
      enemyGroup.add(root); enemyViews.set(e.id, v);
    }
    v.data = e;
  }
  for (const [id, v] of enemyViews) if (!seen.has(id)) { enemyGroup.remove(v.root); if (v.charge) markGroup.remove(v.charge); markGroup.remove(v.chain); enemyViews.delete(id); }
  while (projMeshes.length < s.projectiles.length) { const m = models.orb.clone(); m.scale.setScalar(1.3); world.add(m); projMeshes.push(m); }
  projMeshes.forEach((m, i) => { const q = s.projectiles[i]; m.visible = !!q; if (q) m.position.set(q.x, q.y, q.z); });
  while (spawnDecals.length < s.spawning.length) { const d = decal(ringTex, 0xffffff, 1.3, 0.8); markGroup.add(d); spawnDecals.push(d); }
  spawnDecals.forEach((d, i) => { const sp = s.spawning[i]; d.visible = !!sp; if (sp) { d.position.set(cellX(sp.c), 0.03, cellZ(sp.r)); d.material.color.setHex(sp.kind === 'elite' ? 0xff6a3a : sp.kind === 'ranged' ? 0xb07cff : 0xff5050); } });
}

// ---------- 狀態 → HUD ----------
let lastEventT = -1, bannerUntil = 0, built = false, lastPhase = null;
function onState(s) {
  if (!built) { if (!models.tile) return; buildStatic(s); built = true; }
  syncTiles(s); syncEnemies(s);
  const ev = s.lastEvent;
  if (ev && ev.t !== lastEventT) {
    lastEventT = ev.t;
    if (!ev.quiet && ev.text) { const b = $('banner'); b.textContent = ev.text; b.style.color = ev.side ? CSS[ev.side] : (ev.type === 'win' ? '#7dff9a' : ev.type === 'lose' ? '#ff6b6b' : '#fff'); b.classList.add('on'); bannerUntil = performance.now() + (ev.type === 'win' || ev.type === 'lose' ? 6000 : 2800); }
  }
  updateHud(s);
}
function updateHud(s) {
  const ph = s.phase;
  if (ph !== lastPhase) { lastPhase = ph; if (ph === 'lobby' || ph === 'countdown') { $('banner').classList.remove('on'); bannerUntil = 0; } }
  $('lobby').classList.toggle('hidden', ph !== 'lobby');
  $('result').classList.toggle('hidden', !(ph === 'win' || ph === 'lose'));
  $('countdown').classList.toggle('hidden', ph !== 'countdown');
  $('transition').classList.toggle('hidden', !(ph === 'transition' && s.transition && s.transition.kind !== 'upgradeDone'));
  $('upgrade').classList.toggle('hidden', ph !== 'upgrade');
  if (ph === 'countdown') $('countdown').textContent = Math.ceil(s.countdown) || 'GO';
  if (ph === 'transition' && s.transition) { $('transTitle').textContent = s.transition.kind === 'boss' ? '🚪 進入 Boss 房' : '🚪 關卡門打開'; $('transText').textContent = s.transition.text; }
  if (ph === 'win' || ph === 'lose') { $('resultTitle').textContent = ph === 'win' ? '🎉 核心粉碎！' : '💀 全員倒地'; $('resultText').textContent = `${ph === 'win' ? '島保住了！' : '島被啃光了……'} 用時 ${fmt(s.elapsed)} ・ 全隊擊倒 ${s.kills} 隻 ・ 倒地 ${s.stats.downs} 次、救援 ${s.stats.revives} 次`; }
  const inRun = ph === 'wave' || ph === 'boss' || ph === 'upgrade' || ph === 'transition';
  $('timer').textContent = fmt(s.elapsed);
  if (ph === 'boss') { $('stageName').textContent = 'Boss 房：方塊巨怪'; $('stageSub').textContent = s.boss ? ({ intro: '牠醒了', rest: '準備咬地板', aim: '標記咬擊範圍', lock: '鎖定！', lunge: '咬下', exposed: '核心露出！', recoil: '縮回', minions: `雜兵 ×${s.stage.remaining}` }[s.boss.state] || '') : ''; }
  else if (inRun) { $('stageName').textContent = s.stage.name; $('stageSub').textContent = s.stage.wave > 0 ? `第 ${Math.min(s.stage.wave, s.stage.waveCount)}/${s.stage.waveCount} 波 ・ 剩 ${s.stage.remaining} 隻` : '準備'; }
  else { $('stageName').textContent = '島口大開'; $('stageSub').textContent = `${s.stage.count} 關 + Boss`; }
  const th = s.thresholds; const nextIdx = Math.min(s.upgradesEarned, th.length - 1); const next = th[nextIdx]; const prev = nextIdx > 0 ? th[nextIdx - 1] : 0;
  $('killText').textContent = `全隊擊倒 ${s.kills}`;
  const maxed = s.upgradesEarned >= th.length;
  $('killSub').textContent = maxed ? '升級已滿' : `下一次升級 ${next}${s.upgradesEarned > s.upgradesDone ? '（這波清完就選）' : ''}`;
  $('killBar').style.width = maxed ? '100%' : `${Math.round(Math.max(0, Math.min(1, (s.kills - prev) / (next - prev))) * 100)}%`;
  $('bossPill').style.display = s.boss ? '' : 'none';
  if (s.boss) { $('bossBar').style.width = `${(s.boss.hp / s.boss.maxHp) * 100}%`; $('bossSub').textContent = `${s.boss.hp} / ${s.boss.maxHp}`; }
  $('players').innerHTML = SIDES.map((side) => {
    const p = s.players[side];
    const hearts = Array.from({ length: p.maxHp }, (_, i) => `<i class="${i < p.hp ? '' : 'off'}"></i>`).join('') + Array.from({ length: p.shield || 0 }, () => '<i class="sh"></i>').join('');
    const skills = Object.entries(p.skills || {}).map(([id, lv]) => `<img src="/assets/island/skills/${s.skills[id].icon}" title="${s.skills[id].name}">${lv >= 2 ? '<span class="lv">2</span>' : ''}`).join('');
    const st = !p.connected ? '未加入' : p.downed ? (p.helper ? `救援中 ${Math.round(p.reviveT * 100)}%` : '倒地！') : ph === 'upgrade' && p.pick ? (p.pick.done ? '已選' : '選技能中…') : (p.kb ? '鍵盤' : '手機');
    return `<div class="pcard pill ${p.connected ? '' : 'off'}"><div class="dot bg-${side}"></div><div><b class="${side}">${PNUM[side]} ${LABEL[side]}${p.name && !p.kb ? ' · ' + esc(p.name) : ''}</b><div class="hearts">${p.connected ? hearts : ''}</div><div class="skills">${skills}</div><div class="st">${st}</div></div></div>`;
  }).join('');
  $('slots').innerHTML = SIDES.map((side) => `<div class="slot ${side} ${s.players[side].connected ? 'on' : ''}">${PNUM[side]} ${LABEL[side]}<br><small style="color:var(--muted)">${s.players[side].connected ? (s.players[side].kb ? '鍵盤' : '已加入') : '空位'}</small></div>`).join('');
  $('joinLine').textContent = s.n === 0 ? '等待手機加入…（或按 1～4 用鍵盤試玩）' : `${s.n} 位已加入：任一人向前短推開始，或等更多人`;
  if (ph === 'upgrade' && s.upgrade) renderUpgrade(s);
  $('hintText').innerHTML = hintFor(s);
}
function renderUpgrade(s) {
  $('upgradeTitle').textContent = `第 ${s.upgrade.index} 次升級：每人選一項（${Math.ceil(s.upgrade.remain)} 秒）`;
  $('upgradeCols').innerHTML = SIDES.filter((side) => s.players[side].connected).map((side) => {
    const p = s.players[side]; const pick = p.pick || {};
    const opts = s.upgrade.options.map((o, i) => {
      const lv = p.skills[o.id] || 0; const dim = lv >= 2; const cur = pick.cursor === i && !pick.done;
      return `<div class="uopt ${side} ${cur ? 'cur' : ''} ${dim ? 'dim' : ''}"><img src="/assets/island/skills/${o.icon}"><div><b style="color:var(--text)">${o.name} ${lv ? `<span class="lvtag">${dim ? 'Lv2 已滿' : '→ 強化 Lv2'}</span>` : ''}</b><small>${lv ? o.lv2 : o.desc}</small></div></div>`;
    }).join('');
    const foot = pick.done ? `<div class="udone">✓ 已選 ${s.skills[pick.choice]?.name || ''}</div>` : `<div class="ubar"><i style="width:${Math.round((pick.confirm || 0) * 100)}%"></i></div><div style="font-size:12px;color:var(--muted);margin-top:4px">${pick.confirm > 0.05 ? '回正停住中…' : '左右傾斜切換，回正停住確認'}</div>`;
    return `<div class="ucol ${side}"><h2>${PNUM[side]} ${LABEL[side]}</h2>${opts}${foot}</div>`;
  }).join('');
}
function hintFor(s) {
  const ph = s.phase;
  if (ph === 'lobby') return '手機掃 QR code 加入（1～4 人）→ 任一人向前短推開始';
  if (ph === 'countdown') return '傾斜走位、短抬跳躍，靠近敵人會自動敲';
  if (ph === 'upgrade') return '每人在自己的欄位選一項：左傾 / 右傾切換，回正停住 1.2 秒確認';
  if (ph === 'transition') return s.transition?.text || '';
  if (ph === 'win') return '島保住了！向前短推或 E 再來一局';
  if (ph === 'lose') return '再試一次：向前短推或 E 重開';
  const downed = SIDES.filter((x) => s.players[x].connected && s.players[x].downed);
  if (downed.length && s.n >= 2) return `<span style="color:#ff6b6b">${downed.map((x) => PNUM[x] + ' ' + LABEL[x]).join('、')} 倒地！</span>隊友靠近站著 2 秒救起（護友更快）`;
  if (ph === 'boss' && s.boss) {
    const b = s.boss;
    if (b.state === 'exposed') return `<span style="color:#ff9fe8">核心露出 ${b.exposeRemain.toFixed(1)} 秒！</span>所有人到洞的南邊上前打`;
    if (b.state === 'aim' || b.state === 'lock') return `巨怪盯上 ${PNUM[b.target]} ${LABEL[b.target]}：地上的牙印範圍會被咬掉，站在上面會掉下去`;
    if (b.state === 'minions') return `雜兵 ${s.stage.remaining} 隻：清場的清場、留在巨怪旁的準備打核心`;
    return '方塊巨怪準備咬地板，注意地上的牙印';
  }
  if (s.upgradesEarned > s.upgradesDone) return `升級門檻已達！清掉這波剩下的 ${s.stage.remaining} 隻就選技能`;
  const elite = s.enemies.find((e) => e.kind === 'elite' && !e.dead);
  if (elite && elite.state === 'windup') return '<span style="color:#ff6b6b">精英怪蓄力衝撞！</span>離開紅色箭頭那條線';
  if (s.stage.idx === 1 && s.enemies.some((e) => e.kind === 'ranged' && !e.dead)) return '遠程怪會保持距離射擊：分一個人去追它，別全擠在一起';
  return `清掉這波：剩 ${s.stage.remaining} 隻 ・ 全隊共用擊倒數，誰補最後一下都一樣`;
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
  const s = state, age = Math.min(0.12, (now - stateAt) / 1000), k = 1 - Math.exp(-dt * 18), T = now / 1000;
  const frozen = s.phase === 'upgrade' || s.phase === 'transition';

  for (const side of SIDES) {
    const p = s.players[side], v = playerViews[side];
    v.root.visible = p.connected;
    if (!p.connected) continue;
    tmpV.set(p.x + (frozen ? 0 : p.vx * age), p.y + (p.grounded || frozen ? 0 : p.vy * age), p.z + (frozen ? 0 : p.vz * age));
    if (v.pos.distanceTo(tmpV) > 3) v.pos.copy(tmpV); else v.pos.lerp(tmpV, k);
    v.root.position.copy(v.pos);
    v.model.rotation.y = lerpAngle(v.model.rotation.y, p.facing, k);
    v.downTilt = lerp(v.downTilt, p.downed ? 1 : 0, 1 - Math.exp(-dt * 8));
    v.tilt.rotation.x = -1.45 * v.downTilt; v.tilt.position.y = 0.25 * v.downTilt;
    v.revive.visible = p.downed && p.reviveT > 0.02; v.revive.userData.fg.scale.x = v.revive.userData.width * Math.min(1, p.reviveT);
    v.downLabel.visible = p.downed && s.n >= 2 && !v.revive.visible;
    const speed = Math.hypot(p.vx, p.vz); v.phase += dt * (6 + speed * 2.2); const run = Math.min(1, speed / 3.5);
    const { armL, armR, legL, legR } = v.parts;
    if (!p.grounded) { if (legL) legL.rotation.x = lerp(legL.rotation.x, -0.7, k); if (legR) legR.rotation.x = lerp(legR.rotation.x, 0.4, k); if (armL) armL.rotation.x = lerp(armL.rotation.x, -2.4, k); }
    else { const sw = Math.sin(v.phase) * 0.75 * run; if (legL) legL.rotation.x = sw; if (legR) legR.rotation.x = -sw; if (armL) armL.rotation.x = -sw * 0.8; }
    if (armR) { const h = p.hitAge; let target = p.grounded ? Math.sin(v.phase) * 0.75 * run : -1.2; if (h < 0.08) target = 2.2; else if (h < 0.3) target = lerp(2.2, -1.3, (h - 0.08) / 0.22); else if (h < 0.5) target = lerp(-1.3, target, (h - 0.3) / 0.2); armR.rotation.x = lerp(armR.rotation.x, target, h < 0.5 ? 0.6 : k); }
    v.marker.position.y = v.h + 0.55 + Math.sin(T * 4 + SIDES.indexOf(side)) * 0.08; v.marker.rotation.y = T * 2;
    v.ring.visible = p.hitAge < 0.25; if (v.ring.visible) { const q = p.hitAge / 0.25; v.ring.scale.setScalar(0.6 + q * 1.3); v.ring.material.opacity = 0.8 * (1 - q); }
    v.quake.visible = p.quakeAge < 0.5; if (v.quake.visible) { const q = p.quakeAge / 0.5; v.quake.scale.setScalar(0.3 + q * (p.quakeR || 2.2)); v.quake.material.opacity = 0.9 * (1 - q); }
    v.shield.visible = p.shield > 0; if (v.shield.visible) v.shield.material.opacity = 0.18 + Math.sin(T * 6) * 0.06;
    v.whirl.visible = p.whirl; if (p.whirl) { v.whirl.rotation.z = T * 12; v.whirl.scale.setScalar(1 + Math.sin(T * 20) * 0.1); }
    v.model.visible = !(p.invuln && !p.downed && Math.floor(T * 14) % 2 === 0 && p.hurtAge < 1.0);
    v.shadow.position.y = -p.y + 0.015; v.shadow.visible = p.y > -1;
    v.marker.scale.setScalar(s.boss && s.boss.target === side && (s.boss.state === 'aim' || s.boss.state === 'lock') ? 1.3 + Math.sin(T * 10) * 0.25 : 1);
  }

  for (const v of enemyViews.values()) {
    const e = v.data; const P = v.parts;
    tmpV.set(e.x, e.y, e.z); if (v.pos.distanceTo(tmpV) > 3) v.pos.copy(tmpV); else v.pos.lerp(tmpV, 1 - Math.exp(-dt * 16));
    v.root.position.copy(v.pos); v.root.rotation.y = lerpAngle(v.root.rotation.y, e.facing, k);
    v.phase += dt * 8;
    if (e.dead) { const q = Math.min(1, e.deadAge / 0.6); v.root.scale.setScalar(Math.max(0.01, 1 - q)); v.root.position.y += q * 0.6; v.bar.visible = false; v.tele.visible = false; if (v.charge) v.charge.visible = false; v.chain.visible = false; continue; }
    const hitPulse = e.hitAge < 0.15 ? 1 + 0.25 * (1 - e.hitAge / 0.15) : 1;
    const spawnPop = e.state === 'spawn' ? Math.min(1, e.stateAge / 0.4) : 1;
    v.root.scale.setScalar(hitPulse * spawnPop);
    v.bar.visible = e.hp < e.maxHp; v.bar.userData.fg.scale.x = v.bar.userData.width * Math.max(0, e.hp / e.maxHp);
    v.tele.visible = e.state === 'windup' && e.kind !== 'elite'; if (v.tele.visible) v.tele.scale.setScalar(1 + Math.sin(T * 16) * 0.12);
    if (e.kind === 'grunt') {
      const wind = e.state === 'windup' ? e.stateAge / 0.7 : 0;
      if (P.clawL) P.clawL.rotation.x = e.state === 'windup' ? -1.2 * wind : (e.strikeAge < 0.2 ? 1.0 : Math.sin(v.phase) * 0.3); if (P.clawR) P.clawR.rotation.x = P.clawL ? P.clawL.rotation.x : 0;
      if (P.footL) P.footL.rotation.x = Math.sin(v.phase) * 0.5; if (P.footR) P.footR.rotation.x = -Math.sin(v.phase) * 0.5;
      if (P.head) P.head.rotation.x = e.state === 'windup' ? -0.3 * wind : 0;
    } else if (e.kind === 'ranged') {
      if (P.hover) P.hover.position.y = 0.64 + Math.sin(T * 3 + v.phase) * 0.08;
      if (P.finL) P.finL.rotation.z = Math.sin(T * 6) * 0.4; if (P.finR) P.finR.rotation.z = -Math.sin(T * 6) * 0.4;
      if (v.glow) { v.glow.visible = e.state === 'windup'; v.glow.scale.setScalar(0.6 + (e.stateAge / 0.7) * 1.4); }
    } else {
      const wind = e.state === 'windup' ? Math.min(1, e.stateAge / 1.1) : 0;
      if (P.ram) P.ram.rotation.x = e.state === 'windup' ? -0.45 * wind : e.state === 'dash' ? 0.25 : e.state === 'stun' ? Math.sin(T * 10) * 0.15 : 0;
      if (P.light && P.light.material && P.light.material.emissiveIntensity != null) P.light.material.emissiveIntensity = e.state === 'windup' ? 1 + Math.abs(Math.sin(T * 20)) * 3 : 0.8;
      v.root.rotation.z = e.state === 'stun' ? Math.sin(T * 8) * 0.12 : 0;
      if (v.charge) { v.charge.visible = (e.state === 'windup' || e.state === 'dash') && !!e.dir; if (v.charge.visible) { const len = e.dashLen || 7; const pl = v.charge.userData.plane; pl.scale.set(1, len, 1); v.charge.position.set(e.x + e.dir.x * len / 2, 0.035, e.z + e.dir.z * len / 2); v.charge.rotation.y = Math.atan2(e.dir.x, e.dir.z) + Math.PI; pl.material.opacity = e.state === 'windup' ? 0.5 + Math.sin(T * 14) * 0.35 : 0.9; } }
    }
    v.chain.visible = e.chainAge < 0.25 && !!e.chainFrom; if (v.chain.visible) { const pos = v.chain.geometry.attributes.position; pos.setXYZ(0, e.chainFrom.x, 0.7, e.chainFrom.z); pos.setXYZ(1, e.x, 0.7, e.z); pos.needsUpdate = true; v.chain.geometry.computeBoundingSphere(); }
  }
  for (const m of projMeshes) if (m.visible) m.rotation.y = T * 6;

  if (gateObj) { gateObj.visible = s.phase !== 'boss' && !(s.phase === 'transition' && s.transition?.kind === 'boss' && s.transition.remain < 2); const open = s.phase === 'transition' && s.transition && s.transition.kind !== 'upgradeDone'; gateGlow.visible = gateObj.visible; gateGlow.material.opacity = open ? 0.45 + Math.sin(T * 6) * 0.2 : 0.08 + Math.sin(T * 2) * 0.04; gateGlow.lookAt(camera.position); }
  if (shrineObj) { const on = s.phase === 'upgrade'; shrineObj.visible = on; shrineRing.visible = on; if (on) { if (crystal) crystal.rotation.y = T * 1.5; const q = (T % 1.5) / 1.5; shrineRing.scale.setScalar(0.5 + q * 1.5); shrineRing.material.opacity = 0.8 * (1 - q); } }

  const b = s.boss;
  bossObj.visible = !!b;
  if (b) {
    tmpV.set(b.x, b.y, b.z); bossObj.position.lerp(tmpV, 1 - Math.exp(-dt * 14));
    if (b.state === 'exposed') bossObj.position.x += (Math.random() - 0.5) * 0.04;
    const open = b.mouth;
    if (bossParts.upper) bossParts.upper.rotation.x = lerp(bossParts.upper.rotation.x, -open * 0.38, 1 - Math.exp(-dt * 10));
    if (bossParts.jaw) bossParts.jaw.rotation.x = lerp(bossParts.jaw.rotation.x, open * 0.6, 1 - Math.exp(-dt * 10));
    if (bossParts.core) { bossParts.core.visible = b.state === 'exposed'; if (!bossParts.core.userData.base) bossParts.core.userData.base = bossParts.core.scale.clone(); const pulse = 1 + Math.sin(T * 8) * 0.12 + (b.coreHitAge < 0.25 ? 0.6 * (1 - b.coreHitAge / 0.25) : 0); bossParts.core.scale.copy(bossParts.core.userData.base).multiplyScalar(pulse); if (bossParts.core.material?.emissiveIntensity != null) bossParts.core.material.emissiveIntensity = 1.2 + Math.sin(T * 8) * 0.6; }
    bossObj.rotation.y = lerpAngle(bossObj.rotation.y, b.rot || 0, 1 - Math.exp(-dt * 8));
    bossObj.rotation.z = b.state === 'rest' || b.state === 'minions' ? Math.sin(T * 1.5) * 0.03 : 0;
    const cands = b.state === 'aim' ? b.cands : [];
    candDecals.forEach((d, i) => { const c = cands[i]; d.visible = !!c; if (c) { d.position.set(cellX(c[0]), 0.03, cellZ(c[1])); d.material.opacity = 0.5 + Math.sin(T * 3 + i) * 0.12; } });
    const locked = (b.state === 'lock' || b.state === 'lunge') ? b.locked : [];
    lockDecals.forEach((d, i) => { const c = locked[i]; d.visible = !!c; if (c) { d.position.set(cellX(c[0]), 0.04, cellZ(c[1])); d.scale.setScalar(1 + Math.sin(T * 14) * 0.1); } });
    if (b.state === 'exposed' && b.core) {
      weakSprite.visible = weakLabel.visible = coreBeacon.visible = coreLabel.visible = true;
      weakSprite.position.set(b.core.x, b.core.y, b.core.z + 0.2); weakSprite.scale.setScalar(2.0 + Math.sin(T * 7) * 0.25); weakSprite.material.rotation = T * 1.5;
      weakLabel.position.set(b.core.x, b.core.y + 1.9, b.core.z);
      const cf = b.coreFront || { x: b.core.x, z: b.core.z + 1.4 };
      coreBeacon.position.set(cf.x, 2.5, cf.z); coreBeacon.material.opacity = 0.25 + Math.sin(T * 10) * 0.1; coreLabel.position.set(cf.x, 1.3, cf.z);
    } else weakSprite.visible = weakLabel.visible = coreBeacon.visible = coreLabel.visible = false;
  } else { for (const d of candDecals) d.visible = false; for (const d of lockDecals) d.visible = false; weakSprite.visible = weakLabel.visible = coreBeacon.visible = coreLabel.visible = false; }

  for (const m of tileMeshes.values()) { const a2 = (now - m.userData.born) / 1000; if (a2 < 0.5) m.scale.setScalar(Math.min(1, a2 / 0.5)); else if (m.scale.x !== 1) m.scale.setScalar(1); }
  for (const m of ghostMeshes.values()) m.material.opacity = 0.15 + Math.sin(T * 4) * 0.08;
  for (const d of spawnDecals) if (d.visible) { d.scale.setScalar(1 + Math.sin(T * 10) * 0.12); d.rotation.z = T * 2; }
  renderer.render(scene, camera);
}
function lerp(a, b, t) { return a + (b - a) * t; }
function lerpAngle(a, b, t) { const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; }

// ---------- 鍵盤除錯（最多 4 人） ----------
const kbOn = { A: false, B: false, C: false, D: false };
const keys = new Set();
const KEYMAP = {
  A: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space' },
  B: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', jump: 'Enter' },
  C: { up: 'KeyI', down: 'KeyK', left: 'KeyJ', right: 'KeyL', jump: 'KeyU' },
  D: { up: 'KeyT', down: 'KeyG', left: 'KeyF', right: 'KeyH', jump: 'KeyY' },
};
const lastKbSent = { A: { x: 9, y: 9 }, B: { x: 9, y: 9 }, C: { x: 9, y: 9 }, D: { x: 9, y: 9 } };
function ensureKb(side) { if (!kbOn[side] && !state?.players?.[side]?.connected) { kbOn[side] = true; ws.send({ type: 'kb', side, on: true }); } }
addEventListener('keydown', (e) => {
  const mapped = Object.values(KEYMAP).some((m) => Object.values(m).includes(e.code));
  if (e.repeat) { if (mapped) e.preventDefault(); return; }
  if (['Digit1', 'Digit2', 'Digit3', 'Digit4'].includes(e.code)) { const side = SIDES[Number(e.code.slice(-1)) - 1]; kbOn[side] = !kbOn[side]; ws.send({ type: 'kb', side, on: kbOn[side] }); return; }
  if (e.code === 'KeyR') { ws.send({ type: 'reset' }); return; }
  if (e.code === 'KeyF' && !keys.size && !kbOn.D) { document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); return; }
  if (e.code === 'KeyE' || (e.code === 'Enter' && (state?.phase === 'win' || state?.phase === 'lose' || state?.phase === 'lobby'))) {
    if (state?.phase === 'win' || state?.phase === 'lose') { ws.send({ type: 'restart' }); return; }
    const side = SIDES.find((sd) => kbOn[sd]) || 'A'; ensureKb(side); ws.send({ type: 'input', side, act: 'hit' }); if (e.code === 'Enter') return;
  }
  for (const side of SIDES) {
    const m = KEYMAP[side];
    if (e.code === m.jump) { e.preventDefault(); ensureKb(side); if (kbOn[side]) ws.send({ type: 'input', side, act: 'jump' }); }
    if ([m.up, m.down, m.left, m.right].includes(e.code)) { e.preventDefault(); keys.add(e.code); ensureKb(side); }
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
setInterval(() => {
  for (const side of SIDES) {
    if (!kbOn[side]) continue;
    const m = KEYMAP[side];
    const x = (keys.has(m.right) ? 1 : 0) - (keys.has(m.left) ? 1 : 0), y = (keys.has(m.down) ? 1 : 0) - (keys.has(m.up) ? 1 : 0);
    const last = lastKbSent[side]; if (x !== last.x || y !== last.y) { lastKbSent[side] = { x, y }; ws.send({ type: 'input', side, x, y }); }
  }
}, 50);

// ---------- 啟動 ----------
loadModels().then(() => {
  resize(); if (state) onState(state);
  const missing = Object.entries(models.usingGlb).filter(([, ok]) => !ok).map(([k]) => k);
  if (missing.length) console.info(`[島口大開] 找不到 GLB，使用程式替代模型：${missing.join(', ')}`);
});
requestAnimationFrame(frame);
