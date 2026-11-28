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
// 巨怪站位與偏移依 chomp-boss.glb：牙齒前緣 z+1.23、BrickSocket (0,0.95,1.05)、Core (0,1.0,0.77)
const BOSS_ANCHOR = { x: 0, y: 0, z: cellZ(0) - 2.25 };  // 牙齒前緣離第一排地磚邊緣約 0.3
const CORE_OFFSET = { x: 0, y: 1.0, z: 0.77 };   // 相對 Boss 根節點（面向 +Z）
const MOUTH_OFFSET = { x: 0, y: 0.95, z: 1.05 }; // 嘴裡磚的位置（BrickSocket，相對 Boss 根節點）

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
    this.platZoneSince = 0;
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
      side, connected: false, name: null, kb: false, bot: false, bounced: false,
      botPath: null, botPathAt: -9, botGoalKey: null,
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
    p.connected = on; p.kb = on ? kb : false; p.bot = false;
    if (name) p.name = name;
    if (on && !was) {
      this.placeAtSafeTile(p);
      p.dead = false; p.input = { x: 0, y: 0 };
      if (this.phase === 'play') this.pushEvent('join', `${this.label(side)} 加入了`, side);
    }
    if (!on) {
      p.input = { x: 0, y: 0 };
      if (this.humanCount() === 0 && this.phase !== 'lobby') this.resetMatch();
    }
  }
  // 電腦玩家：占用沒有真人的位置，真人加入時自動讓位
  setBot(side, on) {
    const p = this.players[side]; if (!p) return;
    if (on) {
      if (p.connected && !p.bot) return;
      p.connected = true; p.bot = true; p.kb = false; p.name = '電腦';
      this.placeAtSafeTile(p); p.dead = false; p.input = { x: 0, y: 0 };
      this.pushEvent('bot', `電腦搭檔（${this.label(side)}）上場`, side);
    } else if (p.bot) {
      p.connected = false; p.bot = false; p.input = { x: 0, y: 0 };
      if (this.humanCount() === 0 && this.phase !== 'lobby') this.resetMatch();
    }
  }
  playerCount() { return (this.players.A.connected ? 1 : 0) + (this.players.B.connected ? 1 : 0); }
  humanCount() { return ['A', 'B'].filter((s) => this.players[s].connected && !this.players[s].bot).length; }
  botCount() { return ['A', 'B'].filter((s) => this.players[s].connected && this.players[s].bot).length; }
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
    const n = this.humanCount(); // 敲磚與弱點窗口長度以真人數為準，電腦搭檔不縮短窗口
    if (this.phase === 'lobby') {
      // 任一玩家「敲擊」開始倒數
      for (const s of ['A', 'B']) { const p = this.players[s]; if (p.connected && p.hitReq) { this.startCountdown(); } p.hitReq = false; p.jumpReq = false; }
      this.updatePlayers(dt, true);
      return;
    }
    if (this.phase === 'countdown') {
      if (this.playerCount() === 0) { this.resetMatch(); return; }
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
    this.updateBots(dt);
    this.updatePlayers(dt, false);
  }

  startCountdown() { this.phase = 'countdown'; this.countdownAt = this.now + 3; this.pushEvent('countdown', this.botCount() ? '你和電腦搭檔，準備！' : this.playerCount() >= 2 ? '雙人合作模式，準備！' : '單人模式，準備！'); }
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
    const wasAir = p.airborne; p.airborne = false; p.bounced = false;
    p.lastSupportKey = sf.key;
    if (sf.type === 'plat' && sf.kind === 'spring') { this.bounce(p, sf); return; }
    if (wasAir && p.ability === 'boots') this.clayAnchor(p);
  }
  bounce(p, sf) {
    p.vy = SPRING_VY; p.grounded = false; p.airborne = true; p.bounced = true; p.y = sf.top + 0.01;
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
    const n = this.humanCount();
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
          this.bossMoveTo({ x: cellX(b.locked[0]) - MOUTH_OFFSET.x, y: -0.2, z: cellZ(b.locked[1]) - MOUTH_OFFSET.z }, 0.5);
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
            b.state = 'stuck'; b.until = this.now + b.stuckDur; b.stuckAt = this.now;
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

  // ---------- 電腦玩家 ----------
  updateBots(dt) {
    for (const s of ['A', 'B']) {
      const p = this.players[s];
      if (!p.connected || !p.bot || p.dead) continue;
      try { this.botThink(p); } catch (e) { console.error('bot error', e); p.input = { x: 0, y: 0 }; }
    }
  }
  botThink(p) {
    const b = this.boss;
    const other = this.players[p.side === 'A' ? 'B' : 'A'];
    const human = other.connected && !other.bot && !other.dead ? other : null;
    const [pc, pr] = toCell(p.x, p.z);
    const stop = () => { p.input.x = 0; p.input.y = 0; };
    // 空中：彈起後朝鐘樓平台飄
    if (!p.grounded) {
      if (p.bounced) { const dx = TOWER.x - p.x, dz = TOWER.z - p.z, d = Math.hypot(dx, dz) || 1; const k = Math.min(1, d / 0.8); p.input.x = dx / d * k; p.input.y = dz / d * k; }
      return;
    }
    // 腳下的磚被鎖定：往遠離巨怪的方向跳到鄰磚
    if (b.locked && (b.state === 'lock' || b.state === 'lunge') && b.locked[0] === pc && b.locked[1] === pr) {
      const esc = this.botEscapeCell(pc, pr);
      if (esc) this.botMoveTo(p, cellX(esc[0]), cellZ(esc[1]), true); else stop();
      return;
    }
    const core = this.corePos();
    const coreFront = this.botReachSpot(p, core, this.hitRange(p)) || { x: core.x, z: core.z + 1.0 };
    // 防護打開：打核心
    if (b.state === 'open') {
      if (this.inReach(p, core, 1.8)) { stop(); if (this.now >= p.hitCd) p.hitReq = true; return; }
      if (p.onTower) { this.botMoveTo(p, TOWER.x - 2.2, TOWER.z, true); return; } // 走下塔（掉島後復活再跑）
      this.botMoveTo(p, coreFront.x, coreFront.z, true); return;
    }
    // 巨怪卡住：到能把磚敲進斷橋區（至少落在島上）的側邊位置，敲它
    if (b.state === 'stuck' && b.held) {
      const m = this.mouthPos();
      const spot = this.botHitSpot(p, m, b.held.kind === 'spring');
      const pred = this.predictLanding(p);
      const remain = b.until - this.now;
      const good = pred.ok && (b.held.kind !== 'spring' || pred.inZone || remain < 1.2 || (spot && !spot.inZone));
      const reacted = this.now - b.stuckAt >= 0.8 || remain < 0.6; // 反應時間：留給真人先敲的機會
      if (this.inReach(p, m, 2.2) && good && reacted) { stop(); if (this.now >= p.hitCd) p.hitReq = true; return; }
      if (spot) this.botMoveTo(p, spot.x, spot.z, true); else stop();
      return;
    }
    const springTile = [...this.tiles.values()].find((t) => t.kind === 'spring');
    const springPlat = [...this.platforms.values()].find((pl) => pl.kind === 'spring');
    const platInZone = springPlat && this.bridge.some(([c, r]) => c === springPlat.c && r === springPlat.r);
    // 被盯上：站上彈簧磚引怪（鎖定後上面的邏輯會跳開）
    if (b.target === p.side && (b.state === 'aim' || b.state === 'lock')) {
      if (b.state === 'lock') { stop(); return; }
      if (springTile && !springPlat) this.botMoveTo(p, cellX(springTile.c), cellZ(springTile.r), true);
      else stop();
      return;
    }
    // 彈簧磚在斷橋旁、防護未開：離平台近的去敲鐘，另一人先到核心前站位
    if (platInZone && !b.pendingOpen) {
      const bell = this.bellPos();
      if (p.onTower) { if (this.inReach(p, bell, 2.5)) { stop(); if (this.now >= p.hitCd) p.hitReq = true; } else this.botMoveTo(p, TOWER.x, TOWER.z, true); return; }
      const px = cellX(springPlat.c), pz = cellZ(springPlat.r);
      const myD = Math.hypot(p.x - px, p.z - pz), hD = human ? Math.hypot(human.x - px, human.z - pz) : Infinity;
      if (!this.platZoneSince) this.platZoneSince = this.now;
      const humanStalled = this.now - this.platZoneSince > 6 && !human?.onTower && !human?.bounced && hD > 2.5; // 真人一直沒去踩：電腦自己去
      const iGo = !human || (!human.onTower && !human.bounced && (hD > myD + 1.0 || humanStalled));
      if (iGo) { this.botMoveTo(p, px, pz, true); return; }
      this.botMoveTo(p, coreFront.x, coreFront.z, true); return;
    }
    if (!platInZone) this.platZoneSince = 0;
    // 搭檔被盯：先到預計咬點的側邊待命
    if (b.target && b.target !== p.side && (b.state === 'aim' || b.state === 'lock' || b.state === 'lunge')) {
      let cell = b.locked;
      if (!cell && other.connected) { const [c, r] = toCell(other.x, other.z); cell = this.tiles.has(key(c, r)) ? [c, r] : (springTile ? [springTile.c, springTile.r] : null); }
      if (cell) {
        const m = { x: cellX(cell[0]), y: 0.4, z: cellZ(cell[1]) }; // 咬下後嘴巴會落在這格中心
        const spot = this.botHitSpot(p, m, this.tiles.get(key(cell[0], cell[1]))?.kind === 'spring', cell);
        if (spot) { this.botMoveTo(p, spot.x, spot.z, true); return; }
      }
    }
    // 鐘響後沒能力：去拿回音槌
    if (this.bellRungOnce && !p.ability) {
      const pad = this.pads.find((x) => x.kind === 'hammer');
      if (pad) { this.botMoveTo(p, cellX(pad.c), cellZ(pad.r), true); return; }
    }
    // 閒置：站在彈簧磚南邊一格（不擋路、也不會被連帶咬到）
    if (springTile) { this.botMoveTo(p, cellX(springTile.c), cellZ(springTile.r) + S, true); return; }
    this.botMoveTo(p, cellX(this.spawn.c), cellZ(this.spawn.r), true);
  }
  // 找一個站得住、敲下去磚會落在想要位置的側邊點
  botHitSpot(p, mouth, wantZone, excludeCell = null) {
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < 24; i++) {
      const a = i * Math.PI / 12;
      const dx = Math.cos(a), dz = Math.sin(a);
      const sx = mouth.x - dx * 1.25, sz = mouth.z - dz * 1.25;
      const [sc, sr] = toCell(sx, sz);
      if (excludeCell && sc === excludeCell[0] && sr === excludeCell[1]) continue;
      if (!this.surfacesAt(sx, sz).some((sf) => sf.top <= TILE_H + 0.01)) continue;
      const [lc, lr] = toCell(mouth.x + dx * FLIGHT_DIST, mouth.z + dz * FLIGHT_DIST);
      const ok = inGrid(lc, lr) && !(lc === TOWER.c && lr === TOWER.r);
      const inZone = this.bridge.some(([c, r]) => c === lc && r === lr);
      if (!ok) continue;
      let score = (inZone ? 10 : 0) * (wantZone ? 1 : 0.2) - Math.hypot(p.x - sx, p.z - sz) * 0.3;
      if (score > bestScore) { bestScore = score; best = { x: sx, z: sz, inZone, ok }; }
    }
    return best;
  }
  // 在目標（核心 / 鐘）敲擊距離內找一個站得住、離自己最近的點
  botReachSpot(p, target, range) {
    let best = null, bd = Infinity;
    for (const rad of [range - 0.35, range - 0.7, range - 1.0]) {
      if (rad <= 0.2) continue;
      for (let i = 0; i < 16; i++) {
        const a = i * Math.PI / 8;
        const x = target.x + Math.cos(a) * rad, z = target.z + Math.sin(a) * rad;
        const [c, r] = toCell(x, z);
        if (!this.botWalkable(c, r)) continue;
        if (!this.surfacesAt(x, z).some((sf) => sf.top <= TILE_H + 0.01)) continue;
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < bd) { bd = d; best = { x, z }; }
      }
    }
    return best;
  }
  botEscapeCell(c, r) {
    const opts = [[0, 1], [1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
    let best = null, bd = -Infinity;
    for (const [dc, dr] of opts) {
      const k = key(c + dc, r + dr);
      if (!this.tiles.has(k) && !this.platforms.has(k)) continue;
      const score = dr * 2 - Math.abs(dc); // 往南（遠離巨怪）優先
      if (score > bd) { bd = score; best = [c + dc, r + dr]; }
    }
    return best;
  }
  botWalkable(c, r) {
    if (!inGrid(c, r)) return false;
    const k = key(c, r);
    if (this.boss.locked && (this.boss.state === 'lock' || this.boss.state === 'lunge') && this.boss.locked[0] === c && this.boss.locked[1] === r) return false;
    return this.tiles.has(k) || this.platforms.has(k);
  }
  // BFS 找路（四方向，只走有磚 / 平台的格），回傳格子序列（含起點）
  botFindPath(from, to) {
    const start = key(from[0], from[1]);
    const prev = new Map([[start, null]]);
    const q = [from];
    let found = null, nearest = from, nd = Infinity;
    while (q.length) {
      const cur = q.shift();
      const d = Math.hypot(cur[0] - to[0], cur[1] - to[1]);
      if (d < nd) { nd = d; nearest = cur; }
      if (cur[0] === to[0] && cur[1] === to[1]) { found = cur; break; }
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = [cur[0] + dc, cur[1] + dr], k = key(n[0], n[1]);
        if (prev.has(k) || !this.botWalkable(n[0], n[1])) continue;
        prev.set(k, cur); q.push(n);
      }
    }
    const end = found || nearest;
    const path = []; let cur = end;
    while (cur) { path.unshift(cur); cur = prev.get(key(cur[0], cur[1])); }
    return path;
  }
  // 沿格子走到目標點；direct = 最後一段直接走向目標點（目標可能是平台 / 塔）
  botMoveTo(p, x, z, direct = false) {
    const from = toCell(p.x, p.z), to = toCell(x, z);
    const goalKey = key(to[0], to[1]);
    if (p.botGoalKey !== goalKey || this.now - p.botPathAt > 0.5 || !p.botPath) {
      p.botPath = this.botFindPath(from, to); p.botPathAt = this.now; p.botGoalKey = goalKey;
    }
    const path = p.botPath;
    while (path.length > 1 && path[0][0] === from[0] && path[0][1] === from[1] && Math.hypot(cellX(path[1][0]) - p.x, cellZ(path[1][1]) - p.z) < 0.9 && path.length > 2) path.shift();
    let tx = x, tz = z;
    if (path.length > 1) {
      const next = path[0][0] === from[0] && path[0][1] === from[1] ? path[1] : path[0];
      const last = path[path.length - 1];
      const atLast = last[0] === from[0] && last[1] === from[1];
      if (!atLast) { tx = cellX(next[0]); tz = cellZ(next[1]); }
      else if (!direct) { tx = cellX(last[0]); tz = cellZ(last[1]); }
    } else if (!direct && !this.botWalkable(to[0], to[1])) { tx = cellX(from[0]); tz = cellZ(from[1]); }
    const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
    if (d < 0.08) { p.input.x = 0; p.input.y = 0; return; }
    const k = Math.min(1, d / 0.45);
    p.input.x = dx / d * k; p.input.y = dz / d * k;
  }

  // ---------- 玩家目標（畫面上的光柱 / 箭頭 / 一句話） ----------
  // 回傳 { kind, x, z, text, urgent, act }：act = 'hit' 表示現在就該敲
  goalFor(p) {
    const b = this.boss;
    const other = this.players[p.side === 'A' ? 'B' : 'A'];
    const partner = other.connected && !other.dead ? other : null;
    const partnerBot = partner && partner.bot;
    if (this.phase !== 'play') return null;
    if (p.dead) return { kind: 'wait', text: '掉下去了，馬上在安全磚復活' };
    const [pc, pr] = toCell(p.x, p.z);
    if (b.locked && (b.state === 'lock' || b.state === 'lunge') && b.locked[0] === pc && b.locked[1] === pr) {
      const esc = this.botEscapeCell(pc, pr);
      return { kind: 'flee', x: esc ? cellX(esc[0]) : p.x, z: esc ? cellZ(esc[1]) : p.z + S, text: '快走開！這塊磚要被咬了', urgent: true };
    }
    const core = this.corePos();
    const coreSpot = this.botReachSpot(p, core, this.hitRange(p)) || { x: core.x, z: core.z + 1.0 };
    if (b.state === 'open') {
      if (this.inReach(p, core, 1.8)) return { kind: 'core', x: core.x, z: core.z, text: '敲核心！向前短推（連敲）', urgent: true, act: 'hit' };
      return { kind: 'core', x: coreSpot.x, z: coreSpot.z, text: `去巨怪嘴前敲粉紅核心（剩 ${Math.ceil(b.shieldOpenUntil - this.now)} 秒）`, urgent: true };
    }
    if (b.state === 'stuck' && b.held) {
      const m = this.mouthPos();
      const spot = this.botHitSpot(p, m, b.held.kind === 'spring');
      const pred = this.predictLanding(p);
      if (this.inReach(p, m, 2.2) && pred.ok && (b.held.kind !== 'spring' || pred.inZone || !spot || !spot.inZone)) return { kind: 'knock', x: m.x, z: m.z, text: '敲它！向前短推，磚會飛向綠色落點', urgent: true, act: 'hit' };
      if (spot) return { kind: 'knock', x: spot.x, z: spot.z, text: partnerBot ? '站到這裡敲巨怪（電腦也會幫忙）' : '站到這裡，從側邊敲巨怪', urgent: true };
    }
    const springTile = [...this.tiles.values()].find((t) => t.kind === 'spring');
    const springPlat = [...this.platforms.values()].find((pl) => pl.kind === 'spring');
    const platInZone = springPlat && this.bridge.some(([c, r]) => c === springPlat.c && r === springPlat.r);
    if (b.target === p.side && (b.state === 'aim' || b.state === 'lock')) {
      if (b.state === 'lock') return { kind: 'hold', x: p.x, z: p.z, text: '離紅色牙印遠一點，等它咬下去' };
      if (springTile && !springPlat) {
        const on = pc === springTile.c && pr === springTile.r;
        return { kind: 'lure', x: cellX(springTile.c), z: cellZ(springTile.r), text: on ? '站好別動，紅色牙印出現就走開' : '巨怪盯上你了：去站金色彈簧磚', urgent: !on };
      }
      return { kind: 'hold', x: p.x, z: p.z, text: '巨怪盯上你了：站在磚上等，紅色牙印出現就走開' };
    }
    if (platInZone && !b.pendingOpen) {
      const bell = this.bellPos();
      if (p.onTower) return this.inReach(p, bell, 2.5) ? { kind: 'bell', x: bell.x, z: bell.z, text: '敲鐘！向前短推', urgent: true, act: 'hit' } : { kind: 'bell', x: TOWER.x, z: TOWER.z, text: '走到鐘下面敲鐘' };
      const px = cellX(springPlat.c), pz = cellZ(springPlat.r);
      const myD = Math.hypot(p.x - px, p.z - pz), oD = partner ? Math.hypot(partner.x - px, partner.z - pz) : Infinity;
      const partnerGoing = partner && (partner.onTower || partner.bounced || oD + 1.0 < myD || (partnerBot && this.platZoneSince && this.now - this.platZoneSince > 6 && myD > 2.5));
      if (!partnerGoing) return { kind: 'spring', x: px, z: pz, text: '踩金色彈簧磚彈起來，空中往鐘樓傾斜', urgent: true };
      return { kind: 'wait-core', x: coreSpot.x, z: coreSpot.z, text: `搭檔去敲鐘，你先到巨怪嘴前等防護打開` };
    }
    if (b.target && b.target !== p.side && (b.state === 'aim' || b.state === 'lock' || b.state === 'lunge')) {
      let cell = b.locked;
      if (!cell && partner) { const [c, r] = toCell(partner.x, partner.z); cell = this.tiles.has(key(c, r)) ? [c, r] : (springTile ? [springTile.c, springTile.r] : null); }
      if (cell) {
        const spot = this.botHitSpot(p, { x: cellX(cell[0]), y: 0.4, z: cellZ(cell[1]) }, this.tiles.get(key(cell[0], cell[1]))?.kind === 'spring', cell);
        if (spot) return { kind: 'prep', x: spot.x, z: spot.z, text: '搭檔在引怪：先站到這裡，等巨怪咬住就敲它' };
      }
    }
    if (springPlat && !platInZone) {
      const left = Math.max(0, springPlat.until - this.now);
      return { kind: 'wait', x: coreSpot.x, z: coreSpot.z, text: `彈簧磚沒落在斷橋旁，${Math.ceil(left)} 秒後崩落長回原位；先避開巨怪` };
    }
    if (!springTile && !springPlat) {
      const g = this.regrow.find((x) => x.kind === 'spring');
      return { kind: 'wait', x: p.x, z: p.z, text: g ? `彈簧磚 ${Math.ceil(g.at - this.now)} 秒後長回，先避開巨怪` : '等彈簧磚長回' };
    }
    if (this.bellRungOnce && !p.ability) {
      const pad = this.pads.find((x) => x.kind === 'hammer');
      if (pad) return { kind: 'pad', x: cellX(pad.c), z: cellZ(pad.r), text: '空檔：站上能力區 1 秒選能力（可以不選）' };
    }
    if (springTile) return { kind: 'idle', x: cellX(springTile.c), z: cellZ(springTile.r) + S, text: '等巨怪盯人。盯上你就去站金色彈簧磚，盯上搭檔就到旁邊準備敲' };
    return { kind: 'idle', x: p.x, z: p.z, text: '等巨怪盯人' };
  }
  // 整局進度：1 引怪咬磚 2 敲飛到斷橋 3 敲鐘 4 打核心
  currentStep() {
    const b = this.boss;
    if (b.state === 'open') return 4;
    const springPlat = [...this.platforms.values()].find((pl) => pl.kind === 'spring');
    if (springPlat && this.bridge.some(([c, r]) => c === springPlat.c && r === springPlat.r)) return 3;
    if ((b.state === 'stuck' && b.held?.kind === 'spring') || (this.flight && this.flight.kind === 'spring')) return 2;
    return 1;
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
        connected: p.connected, name: p.name, kb: p.kb, bot: p.bot,
        x: r3(p.x), y: r3(p.y), z: r3(p.z), vx: r3(p.vx), vz: r3(p.vz), vy: r3(p.vy), facing: r3(p.facing),
        grounded: p.grounded, dead: p.dead, respawnIn: p.dead ? Math.max(0, p.respawnAt - this.now) : 0,
        ability: p.ability, hitAge: r3(this.now - p.hitAt), onTower: p.onTower, pad: p.padKind, padT: p.padT ? r3(p.padT / PAD_TIME) : 0,
        goal: p.connected && !p.bot ? this.goalFor(p) : null,
      };
    }
    let flight = null;
    if (this.flight) { const f = this.flight; flight = { kind: f.kind, from: f.from, to: f.to, p: r3(clamp((this.now - f.t0) / f.dur, 0, 1)), c: f.c, r: f.r, ok: f.ok }; }
    const regrow = this.regrow.map((g) => ({ c: g.c, r: g.r, kind: g.kind, in: r3(Math.max(0, g.at - this.now)) }));
    return {
      game: 'island', phase: this.phase, t: Math.round(this.now * 1000), timeLeft: Math.ceil(this.timeLeft), mode: this.playerCount(), humans: this.humanCount(), bots: this.botCount(),
      countdown: this.phase === 'countdown' ? Math.max(0, this.countdownAt - this.now) : 0,
      grid: { cols: COLS, rows: ROWS, cx: CX, cz: CZ, s: S, tileH: TILE_H },
      tiles, plats, regrow,
      marks: { cands: b.cands, locked: b.locked, target: b.target },
      boss: {
        x: r3(b.x), y: r3(b.y), z: r3(b.z), state: b.state, hp: b.hp, maxHp: BOSS_MAX_HP, mouth: r3(b.mouth), held: b.held ? b.held.kind : null,
        openRemain: b.state === 'open' ? r3(Math.max(0, b.shieldOpenUntil - this.now)) : 0, stuckRemain: b.state === 'stuck' ? r3(Math.max(0, b.until - this.now)) : 0,
        target: b.target, coreHitAge: b.coreHitT != null ? r3(this.now - b.coreHitT) : 99, anchor: BOSS_ANCHOR, core: CORE_OFFSET, mouthOff: MOUTH_OFFSET,
      },
      flight, preds, step: this.phase === 'play' ? this.currentStep() : 0,
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
