// 《島口大開》伺服器端模擬：浮島地磚、兩位修島員、巨怪狀態機、飛磚、鐘樓與核心。
// 座標：X 向右、Z 朝鏡頭（+Z = 畫面下方）、Y 向上；巨怪在北邊（-Z）面向 +Z。
// 地磚以 1.5 間距排格：x = (col - cx) * S，z = (row - cz) * S。

export const S = 1.5;                 // 地磚間距
export const TILE_H = 0.5;            // 疊在地磚上的平台高度
export const ROUND_TIME = 300;        // 每局秒數
export const BOSS_MAX_HP = 5;

// 地圖：# 地磚、S 彈簧磚、o 出生點、1 黏土靴能力區、2 回音槌能力區、B 斷橋目標區（空）、T 鐘樓（空，塔在上面）、. 海
const MAP = [
  '..#####.....',
  '.#######....',
  '#1#######BB.',
  '####oS###BBT',
  '#2#######BB.',
  '.#######....',
  '..#####.....',
];
const COLS = MAP[0].length, ROWS = MAP.length;
const CX = 4, CZ = 3;

export function cellX(c) { return (c - CX) * S; }
export function cellZ(r) { return (r - CZ) * S; }
function toCell(x, z) { return [Math.round(x / S + CX), Math.round(z / S + CZ)]; }
function inGrid(c, r) { return c >= 0 && c < COLS && r >= 0 && r < ROWS; }
const key = (c, r) => `${c},${r}`;

// 幾何常數
const PLAYER_SPEED = 4.2;
const AIR_CONTROL = 0.6;
const GRAVITY = 20;
const JUMP_VY = 7.5;          // 跳高約 1.4
const SPRING_VY = 13;         // 彈簧跳高約 4.2
const STEP_UP = 0.9;
const DEATH_Y = -6;
const HIT_RANGE = 1.7, HIT_RANGE_ECHO = 2.9;
const HIT_COOLDOWN = 0.5, HIT_ANIM = 0.35;
const FLIGHT_DIST = 6;        // 被敲出的磚飛 4 格（彈簧磚從原位往東飛剛好落在斷橋旁）
const FLIGHT_DUR = 1.1;
const PLATFORM_LIFE = 30;     // 鬆動平台存活秒數（黏土靴可固定）
const REGROW_GROUND = 25, REGROW_SPRING = 8;
const PAD_TIME = 1.0;

const TOWER = { c: 11, r: 3, top: 3.2, radius: 1.35 };
TOWER.x = cellX(TOWER.c); TOWER.z = cellZ(TOWER.r);
const BELL_OFFSET = { x: 0, y: 4.0, z: 0 };
const BOSS_ANCHOR = { x: 0, y: 0, z: cellZ(0) - 2.6 };
const CORE_OFFSET = { x: 0, y: 1.1, z: 1.6 };   // 相對 Boss 根節點（面向 +Z）
const MOUTH_OFFSET = { x: 0, y: 1.0, z: 1.3 };  // 嘴裡磚的位置（相對 Boss 根節點）

const ABILITIES = {
  boots: { name: '黏土靴', desc: '落地時固定相鄰的鬆動平台' },
  hammer: { name: '回音槌', desc: '敲擊距離變長' },
};

export class IslandGame {
  constructor() {
    this.resetMatch();
  }

  // ---------- 建局 ----------
  resetMatch() {
    this.now = 0;
    this.phase = 'lobby';   // lobby | countdown | play | win | lose
    this.phaseAt = 0;
    this.countdownAt = 0;
    this.timeLeft = ROUND_TIME;
    this.events = [];
    this.lastEvent = null;
    this.bellRungOnce = false;
    this.bellRingT = -99;
    this.buildMap();
    const keep = this.players;
    this.players = { A: this.newPlayer('A'), B: this.newPlayer('B') };
    if (keep) for (const s of ['A', 'B']) {
      this.players[s].connected = keep[s].connected; this.players[s].name = keep[s].name; this.players[s].kb = keep[s].kb;
    }
    this.boss = {
      state: 'rest', until: 0, x: BOSS_ANCHOR.x, y: BOSS_ANCHOR.y, z: BOSS_ANCHOR.z,
      from: null, to: null, moveT0: 0, moveDur: 0,
      target: null, lastTarget: 'B', cands: [], locked: null, held: null,
      hp: BOSS_MAX_HP, shieldOpenUntil: 0, pendingOpen: 0, stuckDur: 0, mouth: 0.2,
    };
    this.flight = null;
    this.regrow = [];
    this.platforms = new Map();   // key -> { c, r, kind, top, loose, until }
  }

  buildMap() {
    this.tiles = new Map();       // key -> { c, r, kind:'ground'|'spring' }
    this.bridge = []; this.pads = []; this.spawn = { c: CX, r: CZ };
    this.springOrigin = null;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const ch = MAP[r][c];
      if (ch === '#' || ch === 'o' || ch === '1' || ch === '2' || ch === 'S') {
        this.tiles.set(key(c, r), { c, r, kind: ch === 'S' ? 'spring' : 'ground' });
        if (ch === 'o') this.spawn = { c, r };
        if (ch === 'S') this.springOrigin = { c, r };
        if (ch === '1') this.pads.push({ kind: 'boots', c, r });
        if (ch === '2') this.pads.push({ kind: 'hammer', c, r });
      } else if (ch === 'B') this.bridge.push([c, r]);
    }
  }

  newPlayer(side) {
    return {
      side, connected: false, name: null, kb: false,
      x: cellX(this.spawn.c) + (side === 'A' ? -0.4 : 0.4), y: 0, z: cellZ(this.spawn.r), prevY: 0,
      vx: 0, vy: 0, vz: 0, facing: Math.PI, grounded: true, airborne: false,
      dead: false, respawnAt: 0, input: { x: 0, y: 0 }, jumpReq: false, hitReq: false,
      hitAt: -9, hitCd: 0, ability: null, padKind: null, padT: 0, onTower: false, lastSupportKey: null,
    };
  }

  // ---------- 連線 / 輸入 ----------
  setConnected(side, on, name, kb = false) {
    const p = this.players[side]; if (!p) return;
    const was = p.connected;
    p.connected = on; p.kb = on ? kb : false;
    if (name) p.name = name;
    if (on && !was) {
      this.placeAtSafeTile(p);
      p.dead = false; p.input = { x: 0, y: 0 };
      if (this.phase === 'play') this.pushEvent('join', `${this.label(side)} 加入了`, side);
    }
    if (!on) {
      p.input = { x: 0, y: 0 };
      if (!this.players.A.connected && !this.players.B.connected && this.phase !== 'lobby') this.resetMatch();
    }
  }
  playerCount() { return (this.players.A.connected ? 1 : 0) + (this.players.B.connected ? 1 : 0); }
  label(side) { return side === 'A' ? '藍' : '橘'; }

  setMove(side, x, y) {
    const p = this.players[side]; if (!p || !p.connected) return;
    p.input.x = clamp(num(x), -1, 1); p.input.y = clamp(num(y), -1, 1);
  }
  action(side, kind) {
    const p = this.players[side]; if (!p || !p.connected) return;
    if (kind === 'jump') p.jumpReq = true;
    else if (kind === 'hit') p.hitReq = true;
  }

  // ---------- 主迴圈 ----------
  update(dt) {
    this.now += dt;
    const n = this.playerCount();
    if (this.phase === 'lobby') {
      // 任一玩家「敲擊」開始倒數
      for (const s of ['A', 'B']) { const p = this.players[s]; if (p.connected && p.hitReq) { this.startCountdown(); } p.hitReq = false; p.jumpReq = false; }
      this.updatePlayers(dt, true);
      return;
    }
    if (this.phase === 'countdown') {
      if (n === 0) { this.resetMatch(); return; }
      this.updatePlayers(dt, true);
      if (this.now >= this.countdownAt) this.startPlay();
      return;
    }
    if (this.phase === 'win' || this.phase === 'lose') {
      // 結束 2.5 秒後任一玩家敲擊 → 重開
      for (const s of ['A', 'B']) { const p = this.players[s]; if (p.connected && p.hitReq && this.now - this.phaseAt > 2.5) this.restart(); p.hitReq = false; p.jumpReq = false; }
      return;
    }
    // play
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.timeLeft = 0; return this.finish('lose'); }
    this.updateRegrow();
    this.updatePlatforms();
    this.updateBoss(dt, n);
    this.updateFlight();
    this.updatePlayers(dt, false);
  }

  startCountdown() { this.phase = 'countdown'; this.countdownAt = this.now + 3; this.pushEvent('countdown', this.playerCount() >= 2 ? '雙人合作模式，準備！' : '單人模式，準備！'); }
  startPlay() { this.phase = 'play'; this.phaseAt = this.now; this.timeLeft = ROUND_TIME; this.boss.state = 'rest'; this.boss.until = this.now + 2; this.pushEvent('start', '開始！引巨怪咬下金色彈簧磚'); }
  restart() { this.resetMatch(); this.startCountdown(); }
  finish(result) {
    this.phase = result; this.phaseAt = this.now;
    this.pushEvent(result, result === 'win' ? '核心粉碎！島保住了！' : '時間到……島被啃光了', null);
  }

  // ---------- 支撐面 ----------
  // 回傳 (x,z) 處所有可站的表面高度（由高到低）
  surfacesAt(x, z) {
    const out = [];
    const [c, r] = toCell(x, z);
    const k = key(c, r);
    const plat = this.platforms.get(k);
    if (plat) out.push({ top: plat.top, type: 'plat', key: k, kind: plat.kind });
    const tile = this.tiles.get(k);
    if (tile) out.push({ top: 0, type: 'tile', key: k, kind: tile.kind });
    const dx = x - TOWER.x, dz = z - TOWER.z;
    if (dx * dx + dz * dz <= TOWER.radius * TOWER.radius) out.push({ top: TOWER.top, type: 'tower', key: 'tower' });
    out.sort((a, b) => b.top - a.top);
    return out;
  }

  placeAtSafeTile(p) {
    const best = this.nearestTile(cellX(this.spawn.c), cellZ(this.spawn.r), true);
    if (best) { p.x = cellX(best.c) + (p.side === 'A' ? -0.3 : 0.3); p.z = cellZ(best.r); }
    else { p.x = cellX(this.spawn.c); p.z = cellZ(this.spawn.r); }
    p.y = 0; p.prevY = 0; p.vx = p.vy = p.vz = 0; p.grounded = true; p.airborne = false;
  }
  nearestTile(x, z, avoidMarked = false) {
    let best = null, bd = Infinity;
    for (const t of this.tiles.values()) {
      if (avoidMarked && this.boss.locked && this.boss.locked[0] === t.c && this.boss.locked[1] === t.r) continue;
      if (avoidMarked && this.boss.cands.some(([c, r]) => c === t.c && r === t.r)) continue;
      const d = (cellX(t.c) - x) ** 2 + (cellZ(t.r) - z) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  // ---------- 玩家 ----------
  updatePlayers(dt, lobby) {
    for (const s of ['A', 'B']) {
      const p = this.players[s];
      if (!p.connected) continue;
      if (p.dead) {
        p.jumpReq = p.hitReq = false;
        if (this.now >= p.respawnAt) { p.dead = false; this.placeAtSafeTile(p); this.pushEvent('respawn', `${this.label(s)} 在安全磚復活`, s); }
        continue;
      }
      // 水平
      const ctrl = p.grounded ? 1 : AIR_CONTROL;
      const tx = p.input.x * PLAYER_SPEED, tz = p.input.y * PLAYER_SPEED;
      const acc = (p.grounded ? 28 : 14) * dt;
      p.vx = approach(p.vx, tx, acc * ctrl + (p.grounded ? 0 : 0));
      p.vz = approach(p.vz, tz, acc * ctrl);
      if (Math.hypot(p.input.x, p.input.y) > 0.15) p.facing = Math.atan2(p.input.x, p.input.y);
      p.x += p.vx * dt; p.z += p.vz * dt;
      // 場地外圍硬邊界（海面範圍）
      p.x = clamp(p.x, cellX(-1), cellX(COLS)); p.z = clamp(p.z, cellZ(-1), cellZ(ROWS));

      // 垂直
      p.prevY = p.y;
      const surfaces = this.surfacesAt(p.x, p.z);
      // 可當支撐：表面不高於腳 + 容許值；低矮台階自動踏上
      let support = null;
      for (const sf of surfaces) {
        if (sf.top <= p.y + 0.06 && p.y - sf.top <= 0.25) { support = sf; break; }
        if (p.grounded && sf.top > p.y && sf.top - p.y <= STEP_UP) { support = sf; break; }
      }
      if (p.jumpReq && p.grounded) { p.vy = JUMP_VY; p.grounded = false; p.airborne = true; }
      p.jumpReq = false;
      if (!p.grounded || !support) {
        p.vy -= GRAVITY * dt;
        p.y += p.vy * dt;
        p.grounded = false;
        // 落地判定：穿過支撐面
        const land = surfaces.find((sf) => p.vy <= 0 && p.y <= sf.top && p.prevY >= sf.top - 0.3);
        if (land) this.land(p, land);
      } else {
        // 站在支撐面上（含台階）
        p.y = support.top; p.vy = 0;
        if (support.type === 'plat' && support.kind === 'spring') this.bounce(p, support); // 彈簧磚只有被敲出、落地成平台後才會彈
        p.lastSupportKey = support.key;
      }
      p.onTower = p.grounded && Math.hypot(p.x - TOWER.x, p.z - TOWER.z) <= TOWER.radius && Math.abs(p.y - TOWER.top) < 0.1;
      if (p.y < DEATH_Y && !lobby) this.kill(p);
      else if (p.y < DEATH_Y) { this.placeAtSafeTile(p); }

      // 能力區
      if (!lobby) this.updatePad(p, dt);

      // 敲擊
      if (p.hitReq) {
        p.hitReq = false;
        if (this.now >= p.hitCd && !lobby) { p.hitCd = this.now + HIT_COOLDOWN; p.hitAt = this.now; this.resolveHit(p); }
        else if (lobby) p.hitAt = this.now;
      }
    }
  }

  land(p, sf) {
    p.y = sf.top; p.vy = 0; p.grounded = true;
    const wasAir = p.airborne; p.airborne = false;
    p.lastSupportKey = sf.key;
    if (sf.type === 'plat' && sf.kind === 'spring') { this.bounce(p, sf); return; }
    if (wasAir && p.ability === 'boots') this.clayAnchor(p);
  }
  bounce(p, sf) {
    p.vy = SPRING_VY; p.grounded = false; p.airborne = true; p.y = sf.top + 0.01;
    this.pushEvent('spring', `${this.label(p.side)} 彈起來了！`, p.side, true);
  }
  clayAnchor(p) {
    const [c, r] = toCell(p.x, p.z);
    let n = 0;
    for (const pl of this.platforms.values()) if (Math.abs(pl.c - c) <= 1 && Math.abs(pl.r - r) <= 1 && pl.loose) { pl.loose = false; n++; }
    if (n) this.pushEvent('anchor', `黏土靴固定了 ${n} 塊平台`, p.side);
  }
  kill(p) {
    p.dead = true; p.respawnAt = this.now + 1.5; p.vx = p.vz = 0; p.input = { x: 0, y: 0 };
    this.pushEvent('fall', `${this.label(p.side)} 掉下島了，1.5 秒後在安全磚復活`, p.side);
  }
  updatePad(p, dt) {
    if (!this.bellRungOnce || !p.grounded) { p.padT = 0; p.padKind = null; return; }
    const [c, r] = toCell(p.x, p.z);
    const pad = this.pads.find((pd) => pd.c === c && pd.r === r);
    if (!pad || pad.kind === p.ability) { p.padT = 0; p.padKind = pad ? pad.kind : null; return; }
    if (p.padKind !== pad.kind) { p.padKind = pad.kind; p.padT = 0; }
    p.padT += dt;
    if (p.padT >= PAD_TIME) {
      p.ability = pad.kind; p.padT = 0;
      this.pushEvent('ability', `${this.label(p.side)} 選了${ABILITIES[pad.kind].name}：${ABILITIES[pad.kind].desc}`, p.side);
    }
  }

  hitRange(p) { return p.ability === 'hammer' ? HIT_RANGE_ECHO : HIT_RANGE; }
  corePos() { return { x: this.boss.x + CORE_OFFSET.x, y: this.boss.y + CORE_OFFSET.y, z: this.boss.z + CORE_OFFSET.z }; }
  mouthPos() { return { x: this.boss.x + MOUTH_OFFSET.x, y: this.boss.y + MOUTH_OFFSET.y, z: this.boss.z + MOUTH_OFFSET.z }; }
  bellPos() { return { x: TOWER.x + BELL_OFFSET.x, y: TOWER.top + 0.8, z: TOWER.z + BELL_OFFSET.z }; }
  inReach(p, pos, extraY = 1.6) {
    const d = Math.hypot(p.x - pos.x, p.z - pos.z);
    return d <= this.hitRange(p) && Math.abs((p.y + 0.9) - pos.y) <= extraY;
  }

  resolveHit(p) {
    const b = this.boss;
    // 1. 核心
    if (b.state === 'open' && this.inReach(p, this.corePos(), 1.8)) {
      b.hp = Math.max(0, b.hp - 1);
      this.pushEvent('corehit', b.hp > 0 ? `${this.label(p.side)} 打中核心！剩 ${b.hp}` : '核心碎了！', p.side);
      b.coreHitT = this.now;
      if (b.hp <= 0) this.finish('win');
      return;
    }
    // 2. 卡住的巨怪 → 敲飛嘴裡的磚
    if (b.state === 'stuck' && b.held && this.inReach(p, this.mouthPos(), 2.2)) {
      this.knockBrick(p);
      return;
    }
    // 3. 鐘
    if (this.inReach(p, this.bellPos(), 2.5) && p.onTower) { this.ringBell(p); return; }
    // 落空
    this.pushEvent('whiff', '', p.side, true);
  }

  // 預測某玩家現在敲擊時磚的落點格
  predictLanding(p) {
    const m = this.mouthPos();
    let dx = m.x - p.x, dz = m.z - p.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d; dz /= d;
    const lx = m.x + dx * FLIGHT_DIST, lz = m.z + dz * FLIGHT_DIST;
    let [c, r] = toCell(lx, lz);
    const ok = inGrid(c, r) && !(c === TOWER.c && r === TOWER.r);
    const inZone = this.bridge.some(([bc, br]) => bc === c && br === r);
    // 落在斷橋區就吸附到最靠島的那一格，讓玩家走得上去
    if (inZone) c = Math.min(...this.bridge.filter(([, br]) => br === r).map(([bc]) => bc));
    return { c, r, ok, inZone };
  }

  knockBrick(p) {
    const b = this.boss;
    const pred = this.predictLanding(p);
    const m = this.mouthPos();
    const tc = cellX(pred.c), tz = cellZ(pred.r);
    const existing = this.tiles.get(key(pred.c, pred.r));
    const top = pred.ok ? (existing ? TILE_H : 0) : -5;
    this.flight = { kind: b.held.kind, from: { x: m.x, y: m.y, z: m.z }, to: { x: tc, y: top, z: tz }, t0: this.now, dur: FLIGHT_DUR, c: pred.c, r: pred.r, ok: pred.ok, origin: b.held.origin, by: p.side };
    b.held = null; b.locked = null; b.cands = [];
    this.bossMoveTo(BOSS_ANCHOR, 0.9);
    b.state = 'recoil'; b.until = this.now + 1.6;
    this.pushEvent('knock', `${this.label(p.side)} 敲飛了${this.flight.kind === 'spring' ? '彈簧磚' : '地磚'}！`, p.side);
  }

  ringBell(p) {
    const b = this.boss;
    const n = this.playerCount();
    const dur = n >= 2 ? 8 : 15;
    this.bellRingT = this.now;
    const first = !this.bellRungOnce;
    this.bellRungOnce = true;
    b.pendingOpen = dur;
    if (b.state !== 'stuck' && b.state !== 'lunge') this.openShield();
    this.pushEvent('bell', `${this.label(p.side)} 敲響了鐘！巨怪防護打開 ${dur} 秒，打核心！${first ? ' 能力區出現了' : ''}`, p.side);
  }
  openShield() {
    const b = this.boss;
    b.state = 'open'; b.shieldOpenUntil = this.now + b.pendingOpen; b.pendingOpen = 0;
    b.locked = null; b.cands = []; b.target = null;
    this.bossMoveTo(BOSS_ANCHOR, 0.6);
  }

  // ---------- 飛磚 / 平台 / 長回 ----------
  updateFlight() {
    const f = this.flight; if (!f) return;
    if (this.now - f.t0 < f.dur) return;
    this.flight = null;
    if (!f.ok) {
      this.scheduleRegrow(f.origin, f.kind);
      this.pushEvent('lost', `${f.kind === 'spring' ? '彈簧磚' : '地磚'}掉進海裡了……${f.kind === 'spring' ? `${REGROW_SPRING} 秒後長回原位，再來一輪` : ''}`, null);
      return;
    }
    const k = key(f.c, f.r);
    const old = this.platforms.get(k);
    if (old) this.scheduleRegrow(old.origin, old.kind); // 疊上去的舊平台視為被撞掉
    this.platforms.set(k, { c: f.c, r: f.r, kind: f.kind, top: f.to.y, loose: true, until: this.now + PLATFORM_LIFE, origin: f.origin });
    const inZone = this.bridge.some(([bc, br]) => bc === f.c && br === f.r);
    if (f.kind === 'spring') this.pushEvent('landed', inZone ? '彈簧磚落在斷橋旁！踩上去彈到鐘樓' : '彈簧磚落地成平台（不在斷橋旁，仍可用）', f.by);
    else this.pushEvent('landed', '地磚落地，成為新的平台', f.by, true);
  }
  updatePlatforms() {
    for (const [k, pl] of this.platforms) {
      if (pl.loose && this.now >= pl.until) {
        this.platforms.delete(k);
        this.scheduleRegrow(pl.origin, pl.kind);
        this.pushEvent('crumble', `${pl.kind === 'spring' ? '彈簧磚' : '平台'}鬆動崩落了`, null);
      }
    }
  }
  scheduleRegrow(origin, kind) {
    if (!origin) return;
    this.regrow.push({ c: origin.c, r: origin.r, kind, at: this.now + (kind === 'spring' ? REGROW_SPRING : REGROW_GROUND) });
  }
  updateRegrow() {
    for (let i = this.regrow.length - 1; i >= 0; i--) {
      const g = this.regrow[i];
      if (this.now < g.at) continue;
      this.regrow.splice(i, 1);
      const k = key(g.c, g.r);
      if (this.tiles.has(k)) continue;
      this.tiles.set(k, { c: g.c, r: g.r, kind: g.kind });
      if (g.kind === 'spring') this.pushEvent('regrow', '彈簧磚長回來了！再引巨怪咬一次', null);
    }
  }

  // ---------- 巨怪 ----------
  bossMoveTo(to, dur) {
    const b = this.boss;
    b.from = { x: b.x, y: b.y, z: b.z }; b.to = { x: to.x, y: to.y, z: to.z }; b.moveT0 = this.now; b.moveDur = dur;
  }
  updateBossMotion() {
    const b = this.boss;
    if (!b.to) return;
    const t = clamp((this.now - b.moveT0) / b.moveDur, 0, 1);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    b.x = b.from.x + (b.to.x - b.from.x) * e; b.y = b.from.y + (b.to.y - b.from.y) * e; b.z = b.from.z + (b.to.z - b.from.z) * e;
    // 撲擊時畫一個小弧
    if (b.state === 'lunge') b.y += Math.sin(t * Math.PI) * 1.6;
    if (t >= 1) b.to = null;
  }
  pickTarget() {
    const alive = ['A', 'B'].filter((s) => this.players[s].connected && !this.players[s].dead);
    if (!alive.length) return null;
    const other = this.boss.lastTarget === 'A' ? 'B' : 'A';
    return alive.includes(other) ? other : alive[0];
  }
  candidatesFor(p) {
    const [c, r] = toCell(p.x, p.z);
    const out = [];
    for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) if (this.tiles.has(key(c + dc, r + dr))) out.push([c + dc, r + dr]);
    if (!out.length) { const t = this.nearestTile(p.x, p.z); if (t) out.push([t.c, t.r]); }
    return out;
  }
  updateBoss(dt, n) {
    const b = this.boss;
    this.updateBossMotion();
    switch (b.state) {
      case 'rest':
        b.mouth = approach(b.mouth, 0.15, dt * 2);
        if (this.now >= b.until) {
          const t = this.pickTarget();
          if (!t) { b.until = this.now + 1; break; }
          b.target = t; b.lastTarget = t; b.state = 'aim'; b.until = this.now + 2.5;
          this.pushEvent('target', `巨怪盯上了 ${this.label(t)}！站上想讓它咬的磚，鎖定後跳開`, t);
        }
        break;
      case 'aim': {
        b.mouth = approach(b.mouth, 0.5, dt * 2);
        const p = this.players[b.target];
        if (!p.connected || p.dead) { b.state = 'rest'; b.until = this.now + 1; b.cands = []; break; }
        b.cands = this.candidatesFor(p);
        if (this.now >= b.until) {
          const [c, r] = toCell(p.x, p.z);
          let cell = this.tiles.has(key(c, r)) ? [c, r] : null;
          if (!cell) { const t = this.nearestTile(p.x, p.z); cell = t ? [t.c, t.r] : null; }
          if (!cell) { b.state = 'rest'; b.until = this.now + 1; b.cands = []; break; }
          b.locked = cell; b.cands = [cell]; b.state = 'lock'; b.until = this.now + 0.9;
          this.pushEvent('lock', `鎖定落點！${this.label(b.target)} 快離開那塊磚`, b.target);
        }
        break;
      }
      case 'lock':
        b.mouth = approach(b.mouth, 1, dt * 3);
        if (this.now >= b.until) {
          b.state = 'lunge'; b.until = this.now + 0.5;
          // 讓嘴巴（MOUTH_OFFSET）落在目標磚上
          this.bossMoveTo({ x: cellX(b.locked[0]) - MOUTH_OFFSET.x, y: -0.6, z: cellZ(b.locked[1]) - MOUTH_OFFSET.z }, 0.5);
        }
        break;
      case 'lunge':
        b.mouth = 1;
        if (this.now >= b.until) {
          const k = key(b.locked[0], b.locked[1]);
          const tile = this.tiles.get(k);
          if (tile) {
            this.tiles.delete(k);
            b.held = { kind: tile.kind, origin: { c: tile.c, r: tile.r } };
            b.stuckDur = n >= 2 ? 3.5 : 6.5;
            b.state = 'stuck'; b.until = this.now + b.stuckDur;
            this.pushEvent('bite', `咬住${tile.kind === 'spring' ? '彈簧磚' : '地磚'}了！巨怪卡住 ${b.stuckDur} 秒，從側邊敲它，磚會朝遠離你的方向飛`, null);
          } else {
            b.state = 'recoil'; b.until = this.now + 1.2; this.bossMoveTo(BOSS_ANCHOR, 0.9);
          }
          b.locked = null; b.cands = [];
        }
        break;
      case 'stuck':
        b.mouth = approach(b.mouth, 0.05, dt * 6);
        if (this.now >= b.until) {
          const kind = b.held.kind, origin = b.held.origin;
          b.held = null;
          this.scheduleRegrow(origin, kind);
          b.state = 'recoil'; b.until = this.now + 1.4; this.bossMoveTo(BOSS_ANCHOR, 0.9);
          this.pushEvent('swallow', `${kind === 'spring' ? '彈簧磚' : '地磚'}被吞掉了……${kind === 'spring' ? `${REGROW_SPRING} 秒後長回原位` : ''}`, null);
        }
        break;
      case 'recoil':
        b.mouth = approach(b.mouth, 0.6, dt * 3);
        if (this.now >= b.until) {
          if (b.pendingOpen) this.openShield();
          else { b.state = 'rest'; b.until = this.now + 1.5; }
        }
        break;
      case 'open':
        b.mouth = approach(b.mouth, 1, dt * 3);
        if (this.now >= b.shieldOpenUntil) { b.state = 'rest'; b.until = this.now + 1.2; this.pushEvent('close', '防護合上了，再敲一次鐘', null); }
        break;
    }
  }

  // ---------- 事件 / 快照 ----------
  pushEvent(type, text, side = null, quiet = false) {
    const ev = { t: Math.round(this.now * 1000), type, text, side, quiet };
    this.lastEvent = ev;
  }

  snapshot() {
    const b = this.boss;
    const tiles = []; for (const t of this.tiles.values()) tiles.push([t.c, t.r, t.kind === 'spring' ? 1 : 0]);
    const plats = []; for (const pl of this.platforms.values()) plats.push([pl.c, pl.r, pl.kind === 'spring' ? 1 : 0, pl.top, pl.loose ? 1 : 0, pl.loose ? Math.max(0, pl.until - this.now) : -1]);
    const preds = [];
    if (b.state === 'stuck' && b.held) for (const s of ['A', 'B']) {
      const p = this.players[s]; if (!p.connected || p.dead) continue;
      const d = Math.hypot(p.x - this.mouthPos().x, p.z - this.mouthPos().z);
      if (d <= this.hitRange(p) * 2.2) { const pr = this.predictLanding(p); preds.push({ side: s, c: pr.c, r: pr.r, ok: pr.ok, inZone: pr.inZone, ready: this.inReach(p, this.mouthPos(), 2.2) }); }
    }
    const players = {};
    for (const s of ['A', 'B']) {
      const p = this.players[s];
      players[s] = {
        connected: p.connected, name: p.name, kb: p.kb,
        x: r3(p.x), y: r3(p.y), z: r3(p.z), vx: r3(p.vx), vz: r3(p.vz), vy: r3(p.vy), facing: r3(p.facing),
        grounded: p.grounded, dead: p.dead, respawnIn: p.dead ? Math.max(0, p.respawnAt - this.now) : 0,
        ability: p.ability, hitAge: r3(this.now - p.hitAt), onTower: p.onTower, pad: p.padKind, padT: p.padT ? r3(p.padT / PAD_TIME) : 0,
      };
    }
    let flight = null;
    if (this.flight) { const f = this.flight; flight = { kind: f.kind, from: f.from, to: f.to, p: r3(clamp((this.now - f.t0) / f.dur, 0, 1)), c: f.c, r: f.r, ok: f.ok }; }
    const regrow = this.regrow.map((g) => ({ c: g.c, r: g.r, kind: g.kind, in: r3(Math.max(0, g.at - this.now)) }));
    return {
      game: 'island', phase: this.phase, t: Math.round(this.now * 1000), timeLeft: Math.ceil(this.timeLeft), mode: this.playerCount(),
      countdown: this.phase === 'countdown' ? Math.max(0, this.countdownAt - this.now) : 0,
      grid: { cols: COLS, rows: ROWS, cx: CX, cz: CZ, s: S, tileH: TILE_H },
      tiles, plats, regrow,
      marks: { cands: b.cands, locked: b.locked, target: b.target },
      boss: {
        x: r3(b.x), y: r3(b.y), z: r3(b.z), state: b.state, hp: b.hp, maxHp: BOSS_MAX_HP, mouth: r3(b.mouth), held: b.held ? b.held.kind : null,
        openRemain: b.state === 'open' ? r3(Math.max(0, b.shieldOpenUntil - this.now)) : 0, stuckRemain: b.state === 'stuck' ? r3(Math.max(0, b.until - this.now)) : 0,
        target: b.target, coreHitAge: b.coreHitT != null ? r3(this.now - b.coreHitT) : 99, anchor: BOSS_ANCHOR, core: CORE_OFFSET, mouthOff: MOUTH_OFFSET,
      },
      flight, preds,
      bridge: this.bridge, tower: { x: TOWER.x, z: TOWER.z, c: TOWER.c, r: TOWER.r, top: TOWER.top, radius: TOWER.radius, bellY: TOWER.top + 0.8 },
      pads: this.bellRungOnce ? this.pads : [], padsVisible: this.bellRungOnce,
      bell: { age: r3(this.now - this.bellRingT) },
      players, lastEvent: this.lastEvent,
      abilities: ABILITIES,
    };
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function num(v) { v = Number(v); return Number.isFinite(v) ? v : 0; }
function approach(cur, target, maxStep) { const d = target - cur; return Math.abs(d) <= maxStep ? target : cur + Math.sign(d) * maxStep; }
function r3(v) { return Math.round(v * 1000) / 1000; }
