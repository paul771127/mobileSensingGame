// 《島口大開》伺服器端模擬：浮島地磚、兩位修島員、巨怪狀態機、飛磚、鐘樓與核心。
// 座標：X 向右、Z 朝鏡頭（+Z = 畫面下方）、Y 向上；巨怪在北邊（-Z）面向 +Z。
// 地磚以 1.5 間距排格：x = (col - cx) * S，z = (row - cz) * S。

export const S = 1.5;                 // 地磚間距
export const TILE_H = 0.5;            // 疊在地磚上的平台高度
export const ROUND_TIME = 300;        // 每局秒數
export const BOSS_MAX_HP = 9;        // 三階段、每階段 3 滴：每打掉一段防護就合上、巨怪變兇，要再跑一輪
const BOSS_SEG = 3;

// 地圖：# 地磚、S 彈簧磚、o 出生點、1 黏土靴能力區、2 回音槌能力區、B 斷橋目標區（空）、T 鐘樓（空，塔在上面）、. 海
const MAP = [
  '..#####.....',
  '.#######....',
  '#1#######BB.',
  '###o#S###BBT',
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
const JUMP_VY = 8.6;          // 跳高約 1.85（比角色高，斜俯視也看得出來）
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
const BELL_OFFSET = { x: 0, y: 4.0, z: -0.9 };  // 鐘亭立在塔頂平台北側（鏡頭後方），玩家站在它前面敲，不會被屋頂擋住
const BOSS_ANCHOR = { x: 0, y: 0, z: cellZ(0) - 2.6 };
const CORE_OFFSET = { x: 0, y: 1.1, z: 1.6 };   // 相對 Boss 根節點（面向 +Z）
const MOUTH_OFFSET = { x: 0, y: 1.0, z: 1.3 };  // 嘴裡磚的位置（相對 Boss 根節點）

const ABILITIES = {
  boots: { name: '黏土靴', desc: '落地時固定相鄰的鬆動平台' },
  hammer: { name: '回音槌', desc: '敲擊距離變長' },
};

// 電腦搭檔個性：上場時隨機抽一種，反應、敢不敢搶鐘、追不追小怪、選哪個能力都不同
const PERSONAS = [
  { key: 'steady', name: '穩健', react: 0.6, jump: 0.9, hunt: 3.0, bellYield: 1.0, pad: 'hammer', sloppy: false, dodge: 0.9 },
  { key: 'hasty', name: '急性子', react: 0.15, jump: 0.6, hunt: 2.2, bellYield: -3, pad: 'hammer', sloppy: true, dodge: 0.6 },
  { key: 'hunter', name: '獵人', react: 0.45, jump: 0.8, hunt: 99, bellYield: 2.5, pad: 'hammer', sloppy: false, dodge: 0.8 },
  { key: 'careful', name: '謹慎', react: 0.9, jump: 1.0, hunt: 1.8, bellYield: 4, pad: 'boots', sloppy: false, dodge: 1.0 },
];
const MOB_DEF = {
  melee: { name: '爪爪怪', hp: 1, speed: 1.9 },
  ranged: { name: '浮游晶', hp: 1, speed: 1.6 },
  charger: { name: '衝撞精英', hp: 2, speed: 1.2 },
};
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

export const PERSONA_KEYS = PERSONAS.map((x) => x.key);
export class IslandGame {
  // opts.specials：巨怪的震地 / 衝撞 / 召喚；opts.mobs：小怪；opts.seed：固定亂數（測試用）
  constructor(opts = {}) {
    this.opts = { specials: true, mobs: true, phases: true, seed: null, ...opts };
    this.maxHp = this.opts.phases ? BOSS_MAX_HP : 5;
    this.rng = this.opts.seed != null ? mulberry32(this.opts.seed) : Math.random;
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
      this.players[s].bot = keep[s].bot; this.players[s].persona = keep[s].persona;
    }
    this.boss = {
      state: 'rest', until: 0, x: BOSS_ANCHOR.x, y: BOSS_ANCHOR.y, z: BOSS_ANCHOR.z,
      from: null, to: null, moveT0: 0, moveDur: 0,
      target: null, lastTarget: 'B', cands: [], locked: null, held: null,
      hp: this.maxHp, shieldOpenUntil: 0, pendingOpen: 0, stuckDur: 0, mouth: 0.2,
      bites: 0, special: null, lastSpecial: null, lane: null, extraWaveAt: 0,
    };
    this.mobs = []; this.orbs = []; this.waves = []; this.mobSeq = 0;
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
      side, connected: false, name: null, kb: false, bot: false, bounced: false,
      botPath: null, botPathAt: -9, botGoalKey: null,
      x: cellX(this.spawn.c) + (side === 'A' ? -0.4 : 0.4), y: 0, z: cellZ(this.spawn.r), prevY: 0,
      vx: 0, vy: 0, vz: 0, facing: Math.PI, grounded: true, airborne: false,
      dead: false, respawnAt: 0, input: { x: 0, y: 0 }, jumpReq: false, hitReq: false,
      hitAt: -9, hitCd: 0, kbUntil: 0, invulnUntil: 0, hurtAt: -9, persona: null, ability: null, padKind: null, padT: 0, onTower: false, lastSupportKey: null,
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
  setBot(side, on, personaKey = null) {
    const p = this.players[side]; if (!p) return;
    if (on) {
      if (p.connected && !p.bot) return;
      p.connected = true; p.bot = true; p.kb = false; p.name = '電腦';
      p.persona = PERSONAS.find((x) => x.key === personaKey) || PERSONAS[Math.floor(this.rng() * PERSONAS.length)];
      this.placeAtSafeTile(p); p.dead = false; p.input = { x: 0, y: 0 };
      this.pushEvent('bot', `電腦搭檔（${this.label(side)}・${p.persona.name}）上場`, side);
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
      for (const s of ['A', 'B']) { const p = this.players[s]; if (p.connected && p.hitReq) { this.startCountdown(); p.hitAt = this.now; p.hitKind = 'miss'; } p.hitReq = false; } // 大廳可以先試跳
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
    this.updateHazards(dt);
    this.updateMobs(dt);
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
      const kb = this.now < p.kbUntil; // 被打飛：暫時不受控、幾乎不減速
      const tx = kb ? 0 : p.input.x * PLAYER_SPEED, tz = kb ? 0 : p.input.y * PLAYER_SPEED;
      const acc = (kb ? 3 : p.grounded ? 28 : 14) * dt;
      p.vx = approach(p.vx, tx, acc * ctrl + (p.grounded ? 0 : 0));
      p.vz = approach(p.vz, tz, acc * ctrl);
      if (!kb && Math.hypot(p.input.x, p.input.y) > 0.15) p.facing = Math.atan2(p.input.x, p.input.y);
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
      if (p.jumpReq && p.grounded && !kb) { p.vy = JUMP_VY; p.grounded = false; p.airborne = true; }
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
        else if (lobby) { p.hitAt = this.now; p.hitKind = 'miss'; }
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
      b.coreHitT = this.now; p.hitKind = 'core';
      if (b.hp <= 0) this.finish('win');
      else if (this.opts.phases && b.hp % BOSS_SEG === 0) { // 打掉一段：防護提前合上、怒吼震波、進下一階段
        b.state = 'recoil'; b.until = this.now + 1.8; b.shieldOpenUntil = this.now; b.lastMove = 'special'; b.special = null;
        this.waves.push({ x: b.x, z: b.z + 1.0, r: 0.6, t0: this.now + 0.35, speed: 7.5, hit: {}, roll: {} });
        this.pushEvent('phase', `巨怪暴怒，進入第 ${this.bossPhase()} 階段！防護合上了，再引牠咬一次彈簧磚`, null);
      }
      return;
    }
    // 2. 卡住的巨怪 → 敲飛嘴裡的磚
    if (b.state === 'stuck' && b.held && this.inReach(p, this.mouthPos(), 2.2)) {
      p.hitKind = 'brick'; this.knockBrick(p);
      return;
    }
    // 3. 鐘
    if (this.inReach(p, this.bellPos(), 2.5) && p.onTower) { p.hitKind = 'bell'; this.ringBell(p); return; }
    // 4. 小怪 / 光球
    const range = this.hitRange(p) + 0.25;
    let mob = null, md = range;
    for (const m of this.mobs) { if (m.state === 'fall') continue; const d = Math.hypot(m.x - p.x, m.z - p.z); if (d <= md && Math.abs(m.y - p.y) < 1.8) { md = d; mob = m; } }
    if (mob) {
      mob.hp--; mob.hurtAt = this.now; p.hitKind = 'mob'; p.hitX = mob.x; p.hitZ = mob.z; p.hitY = mob.y + 0.6;
      p.facing = Math.atan2(mob.x - p.x, mob.z - p.z);
      const d = md || 1; mob.kx = (mob.x - p.x) / d * 5; mob.kz = (mob.z - p.z) / d * 5;
      if (mob.state === 'dash' || mob.state === 'aim' || mob.state === 'windup' || mob.state === 'charge') { mob.state = 'stun'; mob.until = this.now + 0.8; }
      if (mob.hp <= 0) { this.mobs = this.mobs.filter((x) => x !== mob); this.pushEvent('mobdown', `${this.label(p.side)} 打倒了${MOB_DEF[mob.type].name}！`, p.side, true); }
      return;
    }
    const orb = this.orbs.find((o) => Math.hypot(o.x - p.x, o.z - p.z) <= range);
    if (orb) { this.orbs = this.orbs.filter((o) => o !== orb); p.hitKind = 'orb'; p.hitX = orb.x; p.hitZ = orb.z; p.hitY = orb.y; return; }
    // 落空
    p.hitKind = 'miss';
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
    // 鐘聲把彈簧平台震鬆：每一階段都要重新引怪、敲一塊新的過來
    for (const pl of this.platforms.values()) if (pl.kind === 'spring') { pl.loose = true; pl.until = Math.min(pl.until, this.now + 1.5); }
    if (b.state !== 'stuck' && b.state !== 'lunge') this.openShield();
    this.pushEvent('bell', `${this.label(p.side)} 敲響了鐘！巨怪防護打開 ${dur} 秒，打核心！${first ? ' 能力區出現了' : ''}`, p.side);
  }
  openShield() {
    const b = this.boss;
    b.state = 'open'; b.shieldOpenUntil = this.now + b.pendingOpen; b.pendingOpen = 0;
    b.locked = null; b.cands = []; b.target = null; b.special = null; b.lane = null;
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
          // 每咬一口之後接一招特殊攻擊（震地 / 衝撞 / 召喚），不再只是慢慢宣告一口
          if (this.opts.specials && b.bites > 0 && b.special === null && b.lastMove === 'bite') { this.startSpecial(t); break; }
          b.lastMove = 'bite'; b.special = null;
          b.target = t; b.lastTarget = t; b.state = 'aim'; b.until = this.now + (n >= 2 ? 1.5 : 1.9) * this.bossTempo();
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
          b.locked = cell; b.cands = [cell]; b.state = 'lock'; b.until = this.now + 0.7;
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
          b.bites++;
          // 咬下的衝擊：還賴在落點旁的人會被撞飛
          const bx = cellX(b.locked[0]), bz = cellZ(b.locked[1]);
          for (const sd of ['A', 'B']) { const q = this.players[sd]; if (q.connected && !q.dead && q.y < 1.2 && Math.hypot(q.x - bx, q.z - bz) < 1.1) this.knockPlayer(q, q.x - bx, q.z - bz + 0.01, 6.5, 5.5, '被咬擊撞飛'); }
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
          else { b.state = 'rest'; b.until = this.now + 0.9 * this.bossTempo(); }
        }
        break;
      case 'windup': {
        b.mouth = approach(b.mouth, b.special === 'summon' ? 1 : 0.3, dt * 4);
        if (this.now < b.until) break;
        if (b.special === 'stomp') {
          this.waves.push({ x: b.x, z: b.z + 1.0, r: 0.6, t0: this.now, speed: 7.5, hit: {}, roll: {} });
          if (this.bossPhase() >= 3) b.extraWaveAt = this.now + 0.7;
          this.pushEvent('stomp', '震地！波紋到腳邊時跳起來', null, true);
          b.state = 'recoil'; b.until = this.now + 1.1; this.bossMoveTo(BOSS_ANCHOR, 0.25);
        } else if (b.special === 'charge') {
          b.state = 'charge'; b.until = this.now + 0.75;
          this.bossMoveTo({ x: b.lane.x, y: 0, z: cellZ(ROWS - 1) + 0.6 }, 0.75);
        } else {
          const cap = (n >= 2 ? 3 : 2) - this.mobs.length;
          for (let i = 0; i < Math.min(cap, n >= 2 ? 2 : 1); i++) this.spawnMob();
          b.state = 'recoil'; b.until = this.now + 0.8;
        }
        break;
      }
      case 'charge': {
        b.mouth = 0.8;
        for (const sd of ['A', 'B']) {
          const q = this.players[sd];
          if (q.connected && !q.dead && q.y < 1.6 && Math.abs(q.x - b.x) < 1.5 && Math.abs(q.z - (b.z + 0.5)) < 1.4) this.knockPlayer(q, q.x >= b.x ? 1 : -1, 0.25, 8, 6, '被巨怪撞飛');
        }
        if (this.now >= b.until) { b.lane = null; b.state = 'recoil'; b.until = this.now + 1.3; this.bossMoveTo(BOSS_ANCHOR, 1.0); }
        break;
      }
      case 'open':
        b.mouth = approach(b.mouth, 1, dt * 3);
        if (this.now >= b.shieldOpenUntil) { b.state = 'rest'; b.until = this.now + 1.2; this.pushEvent('close', '防護合上了，再敲一次鐘', null); }
        break;
    }
  }

  bossPhase() { return this.opts.phases ? Math.min(3, 1 + Math.floor((this.maxHp - this.boss.hp) / BOSS_SEG)) : (this.boss.hp <= 2 ? 3 : 1); }
  bossTempo() { return [1, 0.85, 0.7][this.bossPhase() - 1]; } // 越後面節奏越快；第三階段震地變兩圈
  startSpecial(targetSide) {
    const b = this.boss, t = this.players[targetSide];
    const ph = this.bossPhase();
    const pool = ph >= 2 ? ['stomp', 'charge'] : ['stomp'];
    if (this.opts.mobs && this.mobs.length < (this.humanCount() >= 2 ? 3 : 2)) pool.push('summon', 'summon');
    let pick = pool[Math.floor(this.rng() * pool.length)];
    if (pick === b.lastSpecial && pool.length > 1) pick = pool[(pool.indexOf(pick) + 1 + Math.floor(this.rng() * (pool.length - 1))) % pool.length];
    b.special = pick; b.lastSpecial = pick; b.lastMove = 'special'; b.state = 'windup'; b.target = null;
    if (pick === 'stomp') { b.until = this.now + 0.9 * this.bossTempo(); this.bossMoveTo({ x: BOSS_ANCHOR.x, y: 2.4, z: BOSS_ANCHOR.z }, 0.8 * this.bossTempo()); this.pushEvent('special', '巨怪跳起來要震地！波紋到腳邊時跳', null); }
    else if (pick === 'charge') {
      const x = clamp(t.x, cellX(1), cellX(7));
      b.lane = { x, w: 1.5 }; b.until = this.now + 1.0 * this.bossTempo();
      this.bossMoveTo({ x, y: 0, z: BOSS_ANCHOR.z }, 0.6);
      this.pushEvent('special', '巨怪要直線衝撞！離開紅色通道', null);
    } else { b.until = this.now + 0.8; this.pushEvent('special', '巨怪吐出小怪！靠近敲掉牠們', null); }
  }
  knockPlayer(p, dx, dz, power, up, why) {
    if (p.dead || this.now < p.invulnUntil) return false;
    const d = Math.hypot(dx, dz) || 1;
    p.vx = dx / d * power; p.vz = dz / d * power; p.vy = up; p.y += 0.05; p.grounded = false; p.airborne = true; p.bounced = false;
    p.kbUntil = this.now + 0.45; p.invulnUntil = this.now + 1.0; p.hurtAt = this.now; p.padT = 0;
    this.pushEvent('hurt', `${this.label(p.side)} ${why}！`, p.side, true);
    return true;
  }
  // 震波：從巨怪腳下往外擴，掃到站在地上的人就撞飛；跳起來可以躲
  updateHazards(dt) {
    const b = this.boss;
    if (b.extraWaveAt && this.now >= b.extraWaveAt) { b.extraWaveAt = 0; this.waves.push({ x: BOSS_ANCHOR.x, z: BOSS_ANCHOR.z + 1.0, r: 0.6, t0: this.now, speed: 7.5, hit: {}, roll: {} }); }
    for (const w of this.waves) {
      w.r = 0.6 + Math.max(0, this.now - w.t0) * w.speed;
      for (const sd of ['A', 'B']) {
        const p = this.players[sd]; if (!p.connected || p.dead || w.hit[sd]) continue;
        const d = Math.hypot(p.x - w.x, p.z - w.z);
        if (Math.abs(d - w.r) < 0.4) { if (p.grounded && !p.onTower) { w.hit[sd] = true; this.knockPlayer(p, p.x - w.x, p.z - w.z, 5.5, 5.5, '被震波掃到'); } }
        else if (w.r > d + 0.4) w.hit[sd] = true;
      }
    }
    this.waves = this.waves.filter((w) => w.r < 17);
    for (const o of this.orbs) {
      o.x += o.vx * dt; o.z += o.vz * dt;
      for (const sd of ['A', 'B']) { const p = this.players[sd]; if (p.connected && !p.dead && Math.hypot(p.x - o.x, p.z - o.z) < 0.6 && Math.abs(p.y + 0.6 - o.y) < 0.9) { if (this.knockPlayer(p, o.vx, o.vz, 5.5, 4.5, '被光球打中')) o.until = 0; } }
    }
    this.orbs = this.orbs.filter((o) => this.now < o.until);
  }

  // ---------- 小怪 ----------
  mobGround(x, z) { const sf = this.surfacesAt(x, z).filter((f) => f.top <= TILE_H + 0.01); return sf.length ? Math.max(...sf.map((f) => f.top)) : null; }
  spawnMob(type) {
    const ph = this.bossPhase();
    const pool = ['melee', 'melee'];
    if (ph >= 2) pool.push('ranged', 'ranged');
    if (ph >= 3 && !this.mobs.some((m) => m.type === 'charger')) pool.push('charger', 'charger');
    type = type || pool[Math.floor(this.rng() * pool.length)];
    const spots = [...this.tiles.values()].filter((t) => t.r <= 2 && t.kind !== 'spring' && !this.mobs.some((m) => Math.hypot(m.tx - cellX(t.c), m.tz - cellZ(t.r)) < 1));
    const t = spots.length ? spots[Math.floor(this.rng() * spots.length)] : this.nearestTile(0, cellZ(1));
    if (!t) return null;
    const m0 = this.mouthPos();
    const m = { id: ++this.mobSeq, type, hp: MOB_DEF[type].hp, x: m0.x, y: m0.y, z: m0.z, fx: m0.x, fy: m0.y, fz: m0.z, tx: cellX(t.c), tz: cellZ(t.r), facing: 0, state: 'spawn', t0: this.now, until: this.now + 0.7, cd: this.now + 1.5 + this.rng(), hurtAt: -9, kx: 0, kz: 0 };
    this.mobs.push(m); return m;
  }
  updateMobs(dt) {
    for (const m of this.mobs) {
      const def = MOB_DEF[m.type];
      if (m.state === 'spawn') { // 從巨怪嘴裡拋到島上
        const q = clamp((this.now - m.t0) / 0.7, 0, 1);
        m.x = m.fx + (m.tx - m.fx) * q; m.z = m.fz + (m.tz - m.fz) * q; m.y = m.fy * (1 - q) + Math.sin(q * Math.PI) * 2 + (m.type === 'ranged' ? 0 : 0);
        if (q >= 1) { m.state = 'move'; m.y = this.mobGround(m.x, m.z) ?? 0; }
        continue;
      }
      if (m.state === 'fall') { m.vy = (m.vy || 0) - GRAVITY * dt; m.y += m.vy * dt; continue; }
      // 被敲的擊退
      if (m.kx || m.kz) { m.x += m.kx * dt; m.z += m.kz * dt; m.kx = approach(m.kx, 0, 18 * dt); m.kz = approach(m.kz, 0, 18 * dt); }
      const ground = this.mobGround(m.x, m.z);
      if (m.type !== 'ranged') { if (ground == null) { m.state = 'fall'; m.vy = 0; if (m.type === 'charger') this.pushEvent('mobdown', '衝撞精英衝出島外了！', null); continue; } m.y = ground; }
      else m.y = 0;
      // 目標：最近、還在島上的玩家
      let tp = null, td = Infinity;
      for (const sd of ['A', 'B']) { const p = this.players[sd]; if (!p.connected || p.dead || p.onTower || p.y > 2) continue; const d = Math.hypot(p.x - m.x, p.z - m.z); if (d < td) { td = d; tp = p; } }
      const face = () => { if (tp) m.facing = Math.atan2(tp.x - m.x, tp.z - m.z); };
      const step = (dirX, dirZ, speed, needGround) => {
        const nx = m.x + dirX * speed * dt, nz = m.z + dirZ * speed * dt;
        if (needGround && this.mobGround(nx + dirX * 0.35, nz + dirZ * 0.35) == null) return false;
        m.x = clamp(nx, cellX(-0.4), cellX(COLS - 3.6)); m.z = clamp(nz, cellZ(-0.4), cellZ(ROWS - 0.6)); return true;
      };
      if (m.state === 'stun') { if (this.now >= m.until) { m.state = 'move'; m.cd = this.now + 1.2; } continue; }
      if (!tp) continue;
      const dx = (tp.x - m.x) / (td || 1), dz = (tp.z - m.z) / (td || 1);
      if (m.type === 'melee') {
        if (m.state === 'move') { face(); if (td > 0.95) step(dx, dz, def.speed, true); else if (this.now >= m.cd) { m.state = 'windup'; m.until = this.now + 0.45; } }
        else if (m.state === 'windup' && this.now >= m.until) {
          if (td < 1.3 && Math.abs(tp.y - m.y) < 1.0) this.knockPlayer(tp, dx, dz, 6, 5, '被爪爪怪拍飛');
          m.state = 'move'; m.cd = this.now + 1.1; m.strikeAt = this.now;
        }
      } else if (m.type === 'ranged') {
        if (m.state === 'move') {
          face();
          if (td > 5.2) step(dx, dz, def.speed, false); else if (td < 3.6) step(-dx, -dz, def.speed, false);
          if (this.now >= m.cd && td < 9) { m.state = 'charge'; m.until = this.now + 0.8; }
        } else if (m.state === 'charge') {
          face();
          if (this.now >= m.until) {
            const sx = m.x + Math.sin(m.facing) * 0.5, sz = m.z + Math.cos(m.facing) * 0.5;
            this.orbs.push({ id: ++this.mobSeq, x: sx, y: 0.85, z: sz, vx: Math.sin(m.facing) * 6.5, vz: Math.cos(m.facing) * 6.5, until: this.now + 2.2 });
            m.state = 'move'; m.cd = this.now + 3.0 + this.rng();
          }
        }
      } else { // charger：瞄準 → 直線衝 → 暈；衝出島外就自己掉下去
        if (m.state === 'move') { face(); if (td > 2.5) step(dx, dz, def.speed, true); if (this.now >= m.cd && td < 7) { m.state = 'aim'; m.until = this.now + 1.0; } }
        else if (m.state === 'aim') { if (this.now < m.until - 0.3) face(); if (this.now >= m.until) { m.state = 'dash'; m.until = this.now + 1.1; } }
        else if (m.state === 'dash') {
          m.x += Math.sin(m.facing) * 9 * dt; m.z += Math.cos(m.facing) * 9 * dt;
          if (td < 1.15 && Math.abs(tp.y - m.y) < 1.2) this.knockPlayer(tp, Math.sin(m.facing) + dx * 0.3, Math.cos(m.facing) + dz * 0.3, 8.5, 6, '被衝撞精英撞飛');
          if (this.now >= m.until) { m.state = 'stun'; m.until = this.now + 1.6; }
        }
      }
    }
    this.mobs = this.mobs.filter((m) => m.y > -7);
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
    const per = p.persona || PERSONAS[0];
    if (this.now < p.kbUntil) return;
    // 震波：快掃到時起跳（會不會跳、跳得準不準看個性）
    for (const w of this.waves) {
      if (w.hit[p.side]) continue;
      if (w.roll[p.side] == null) w.roll[p.side] = this.rng() < per.jump;
      const gap = Math.hypot(p.x - w.x, p.z - w.z) - w.r;
      if (w.roll[p.side] && gap > 0 && gap < 1.5 && !p.onTower) { p.jumpReq = true; }
    }
    // 衝撞通道：橫向閃開
    if (b.lane && (b.state === 'windup' || b.state === 'charge') && Math.abs(p.x - b.lane.x) < 2.1 && !p.onTower) {
      if (b.laneRoll?.[p.side] == null) { b.laneRoll = b.laneRoll || {}; b.laneRoll[p.side] = this.rng() < per.dodge; }
      if (b.laneRoll[p.side]) {
        const side = p.x >= b.lane.x ? 1 : -1;
        for (const sgn of [side, -side]) { const gx = b.lane.x + sgn * 2.7; if (this.surfacesAt(gx, p.z).length) { this.botMoveTo(p, gx, p.z, true); return; } }
      }
    } else if (!b.lane) b.laneRoll = null;
    // 小怪貼臉：順手敲掉（除非正要敲嘴裡的磚，免得把磚敲歪）
    let nearMob = null, nearD = Infinity;
    for (const m of this.mobs) { if (m.state === 'fall' || m.state === 'spawn') continue; const d = Math.hypot(m.x - p.x, m.z - p.z); if (d < nearD) { nearD = d; nearMob = m; } }
    const busyBrick = b.state === 'stuck' && b.held && this.inReach(p, this.mouthPos(), 2.2);
    const busyCore = b.state === 'open' && this.inReach(p, this.corePos(), 1.8);
    if (nearMob && nearD <= this.hitRange(p) && !busyBrick && !busyCore && !p.onTower && this.now >= p.hitCd) p.hitReq = true;
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
      if (p.onTower) { p.input.x = -1; p.input.y = 0; return; } // 往西走下塔（掉島後在安全磚復活再跑向核心）
      this.botMoveTo(p, coreFront.x, coreFront.z, true); return;
    }
    // 巨怪卡住：到能把磚敲進斷橋區（至少落在島上）的側邊位置，敲它
    if (b.state === 'stuck' && b.held) {
      const m = this.mouthPos();
      const spot = this.botHitSpot(p, m, b.held.kind === 'spring');
      const pred = this.predictLanding(p);
      const remain = b.until - this.now;
      // 彈簧磚只在落點對準斷橋時才敲：敲歪會卡在別處 30 秒，不如讓它被吞掉、8 秒後長回原位重來
      const good = pred.ok && (b.held.kind !== 'spring' || pred.inZone || (per.sloppy && remain < 1.5)); // 急性子等不及會亂敲
      const reacted = this.now - b.stuckAt >= per.react + 0.2 || remain < 0.6; // 反應時間：留給真人先敲的機會
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
      if (p.onTower) { if (this.inReach(p, bell, 2.5)) { stop(); if (this.now >= p.hitCd) p.hitReq = true; } else this.botMoveTo(p, TOWER.x + BELL_OFFSET.x * 0.4, TOWER.z + BELL_OFFSET.z * 0.4, true); return; }
      const px = cellX(springPlat.c), pz = cellZ(springPlat.r);
      const myD = Math.hypot(p.x - px, p.z - pz), hD = human ? Math.hypot(human.x - px, human.z - pz) : Infinity;
      const iGo = !human || (!human.onTower && hD > myD + per.bellYield);
      if (iGo) { this.botMoveTo(p, px, pz, true); return; }
      this.botMoveTo(p, coreFront.x, coreFront.z, true); return;
    }
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
    // 有空就去追小怪（追多遠看個性；獵人滿場追）
    if (nearMob && nearD < per.hunt && nearMob.type !== 'ranged' || (nearMob && per.key === 'hunter' && nearD < 12)) {
      if (this.mobGround(nearMob.x, nearMob.z) != null || nearD < 2.6) { this.botMoveTo(p, nearMob.x, nearMob.z, false); return; }
    }
    // 鐘響後沒能力：去拿個性偏好的能力
    if (this.bellRungOnce && !p.ability) {
      const pad = this.pads.find((x) => x.kind === per.pad);
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
      const landAt = (ang) => {
        const [lc, lr] = toCell(mouth.x + Math.cos(ang) * FLIGHT_DIST, mouth.z + Math.sin(ang) * FLIGHT_DIST);
        return { lc, lr, ok: inGrid(lc, lr) && !(lc === TOWER.c && lr === TOWER.r) };
      };
      const { lc, lr, ok } = landAt(a);
      // 電腦不會站得分毫不差：左右偏 6° 也要落在場內才算數
      if (!ok || !landAt(a - 0.1).ok || !landAt(a + 0.1).ok) continue;
      const inZone = this.bridge.some(([c, r]) => c === lc && r === lr);
      const solid = this.tiles.has(key(lc, lr));
      let score = (inZone ? 10 : solid ? 3 : 0) * (wantZone ? 1 : 0.2) - Math.hypot(p.x - sx, p.z - sz) * 0.3;
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
    if (direct && !this.surfacesAt(x, z).length) direct = false;
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
        ability: p.ability, hitAge: r3(this.now - p.hitAt), hit: p.hitKind || 'miss', hx: r3(p.hitX || 0), hy: r3(p.hitY || 0), hz: r3(p.hitZ || 0), hurtAge: r3(this.now - p.hurtAt), knocked: this.now < p.kbUntil, persona: p.bot && p.persona ? p.persona.name : null, onTower: p.onTower, pad: p.padKind, padT: p.padT ? r3(p.padT / PAD_TIME) : 0,
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
        x: r3(b.x), y: r3(b.y), z: r3(b.z), state: b.state, hp: b.hp, maxHp: this.maxHp, phase: this.bossPhase(), mouth: r3(b.mouth), held: b.held ? b.held.kind : null,
        openRemain: b.state === 'open' ? r3(Math.max(0, b.shieldOpenUntil - this.now)) : 0, stuckRemain: b.state === 'stuck' ? r3(Math.max(0, b.until - this.now)) : 0,
        special: b.special, lane: b.lane, rage: this.bossPhase() >= 3, windupRemain: b.state === 'windup' ? r3(Math.max(0, b.until - this.now)) : 0,
        target: b.target, coreHitAge: b.coreHitT != null ? r3(this.now - b.coreHitT) : 99, anchor: BOSS_ANCHOR, core: CORE_OFFSET, mouthOff: MOUTH_OFFSET,
      },
      flight, preds,
      mobs: this.mobs.map((m) => ({ id: m.id, type: m.type, x: r3(m.x), y: r3(m.y), z: r3(m.z), f: r3(m.facing), state: m.state, hp: m.hp, hurtAge: r3(this.now - m.hurtAt), strikeAge: r3(this.now - (m.strikeAt ?? -9)) })),
      orbs: this.orbs.map((o) => ({ id: o.id, x: r3(o.x), y: o.y, z: r3(o.z) })),
      waves: this.waves.map((w) => ({ x: w.x, z: w.z, r: r3(w.r) })),
      bridge: this.bridge, tower: { x: TOWER.x, z: TOWER.z, c: TOWER.c, r: TOWER.r, top: TOWER.top, radius: TOWER.radius, bellY: TOWER.top + 0.8, bellX: BELL_OFFSET.x, bellZ: BELL_OFFSET.z },
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
