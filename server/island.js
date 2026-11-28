// 《島口大開》伺服器端模擬：1～4 人同屏合作闖關。
// 三個小關（近戰 → 加遠程 → 混合精英）各三波，清完進 Boss 房；全隊共用擊倒計數，達門檻在波清後選技能。
// 座標：X 向右、Z 朝鏡頭（+Z = 畫面下方）、Y 向上；Boss 在北邊（-Z）面向 +Z。地磚 1.5 間距。

export const S = 1.5;
export const SIDES = ['A', 'B', 'C', 'D'];
export const COLORS = { A: '藍', B: '橘', C: '紫', D: '綠' };

const MAP = [
  '...#####...',
  '..#######..',
  '.#########.',
  '###########',
  '###########',
  '###########',
  '.#########.',
  '..#######..',
  '...#####...',
];
const COLS = MAP[0].length, ROWS = MAP.length;
const CX = 5, CZ = 4;
export function cellX(c) { return (c - CX) * S; }
export function cellZ(r) { return (r - CZ) * S; }
function toCell(x, z) { return [Math.round(x / S + CX), Math.round(z / S + CZ)]; }
const key = (c, r) => `${c},${r}`;

// 玩家
const PLAYER_SPEED = 4.2, AIR_CONTROL = 0.6, GRAVITY = 20, JUMP_VY = 7.5, DEATH_Y = -6;
const PLAYER_HP = 4, INVULN = 1.0, ATTACK_RANGE = 1.6, ATTACK_CD = 0.6, ATTACK_DMG = 1;
const REVIVE_RANGE = 1.3, REVIVE_TIME = 2.0, SOLO_RECOVER = 5, SOLO_LIVES = 3;
const HOLE_REGROW = 18;
// 敵人（半徑依模型：mob-melee 寬 1.0、mob-ranged 寬 1.16、mob-charger 寬 1.54）
export const ENEMY = {
  grunt: { hp: 2, speed: 2.6, radius: 0.45, windup: 0.7, reach: 1.25, dmg: 1, cd: 1.6, name: '近戰小怪' },
  ranged: { hp: 2, speed: 2.2, radius: 0.5, keep: 5, near: 3.5, far: 6.5, fireCd: 3.6, windup: 0.7, projSpeed: 4.5, dmg: 1, name: '遠程怪' },
  elite: { hp: 7, speed: 2.0, radius: 0.65, chargeRange: 6, windup: 1.1, dashSpeed: 11, dashDur: 0.65, stun: 1.8, cd: 4, dmg: 1, name: '衝撞精英' },
};
const PROJ_LIFE = 3, PROJ_HIT_R = 0.5;
// 關卡
export const STAGES = [
  { name: '第一關 荒磚岸', intro: '近戰小怪來了：走位、跳躍，靠近就會自動敲', waves: [{ g: 4 }, { g: 5 }, { g: 6 }] },
  { name: '第二關 回音灘', intro: '多了遠程怪：分頭處理，別讓它們在遠處一直射', waves: [{ g: 3, r: 2 }, { g: 4, r: 3 }, { g: 4, r: 4 }] },
  { name: '第三關 碎裂崖', intro: '精英怪會蓄力衝撞：看到地上的衝撞線就閃開，撞完它會暈', waves: [{ g: 4, r: 2, e: 1 }, { g: 5, r: 3, e: 1 }, { g: 5, r: 3, e: 2 }] },
];
export const KILL_THRESHOLDS = [8, 20, 36];
const COUNT_SCALE = [0, 0.6, 1, 1.3, 1.6], KILL_SCALE = [0, 0.6, 1, 1.35, 1.7], BOSS_HP_SCALE = [0, 0.5, 1, 1.4, 1.8], EXPOSE_DUR = [0, 7, 5, 4.5, 4];
const BOSS_BASE_HP = 24;
// 技能（圖示：public/assets/island/skills/*.svg）
export const SKILLS = {
  quake: { name: '震地', desc: '落地時把身邊的小怪打退', lv2: '範圍更大、傷害加倍', icon: 'ground-slam.svg' },
  chain: { name: '連鎖槌', desc: '敲中的敵人把傷害傳給附近另一隻', lv2: '傳給兩隻', icon: 'chain-hammer.svg' },
  whirl: { name: '旋風步', desc: '持續朝同一方向走會短暫加速並推開路上的小怪', lv2: '更快觸發、傷害加倍', icon: 'whirlwind-step.svg' },
  guard: { name: '護友', desc: '救援倒地隊友更快，救起後兩人短暫獲得護盾', lv2: '護盾兩層、救起回滿血', icon: 'ally-guard.svg' },
};
const SKILL_IDS = Object.keys(SKILLS);
const UPGRADE_TIMEOUT = 25, CONFIRM_HOLD = 1.2;

// Boss（chomp-boss.glb：BrickSocket (0,0.95,1.05)、Core (0,1.0,0.77)、牙齒前緣 z+1.23）
const BOSS_ANCHOR = { x: 0, y: 0, z: cellZ(0) - 2.25 };
const MOUTH_OFFSET = { x: 0, y: 0.95, z: 1.05 };
const CORE_OFFSET = { x: 0, y: 1.0, z: 0.77 };
// 關卡門（北邊，Boss 房時換成 Boss）與升級台（島中央）
export const GATE = { x: 0, z: cellZ(0) - 1.6 };
export const SHRINE = { x: 0, z: cellZ(CZ) };

export class IslandGame {
  constructor() { this.players = {}; for (const s of SIDES) this.players[s] = this.newPlayer(s); this.resetMatch(); }

  // ---------- 建局 ----------
  resetMatch() {
    this.now = 0; this.phase = 'lobby'; this.phaseAt = 0; this.countdownAt = 0; this.startedAt = 0; this.endedAt = 0;
    this.lastEvent = null; this.nextId = 1;
    this.buildMap();
    for (const s of SIDES) { const keep = this.players[s]; const p = this.newPlayer(s); p.connected = keep.connected; p.name = keep.name; p.kb = keep.kb; this.players[s] = p; if (p.connected) this.placeAtSpawn(p); }
    this.enemies = []; this.projectiles = []; this.spawning = []; this.regrow = [];
    this.kills = 0; this.upgradesEarned = 0; this.upgradesDone = 0; this.upgrade = null;
    this.stageIdx = 0; this.waveIdx = -1; this.waveState = 'idle'; this.waveAt = 0; this.transition = null;
    this.boss = null; this.soloLivesUsed = 0;
    this.stats = { downs: 0, revives: 0 };
  }
  buildMap() {
    this.tiles = new Map();
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (MAP[r][c] === '#') this.tiles.set(key(c, r), { c, r });
    this.spawn = { c: CX, r: CZ + 1 };
  }
  newPlayer(side) {
    return {
      side, connected: false, name: null, kb: false,
      x: 0, y: 0, z: 0, prevY: 0, vx: 0, vy: 0, vz: 0, facing: Math.PI, grounded: true, airborne: false, airT: 0,
      input: { x: 0, y: 0 }, jumpReq: false, hitReq: false,
      hp: PLAYER_HP, maxHp: PLAYER_HP, downed: false, downAt: 0, reviveT: 0, helper: null, invulnUntil: 0, hurtAt: -99, shield: 0, shieldUntil: 0,
      attackCd: 0, hitAt: -9, targetId: null, skills: {}, quakeAt: -9, whirlUntil: 0, whirlCd: 0, sameDirT: 0, lastDir: null, whirlHit: new Set(),
      upgradeCursor: 0, upgradeConfirm: 0, upgradeDone: false, upgradeMoveAt: 0, upgradeChoice: null,
    };
  }
  placeAtSpawn(p) {
    const i = SIDES.indexOf(p.side);
    const t = this.nearestTile(cellX(this.spawn.c) + (i - 1.5) * 0.9, cellZ(this.spawn.r));
    p.x = t ? cellX(t.c) + ((i - 1.5) * 0.35) : 0; p.z = t ? cellZ(t.r) : 0; p.y = 0; p.prevY = 0; p.vx = p.vy = p.vz = 0; p.grounded = true; p.airborne = false; p.facing = Math.PI;
  }
  nearestTile(x, z) {
    let best = null, bd = Infinity;
    for (const t of this.tiles.values()) { const d = (cellX(t.c) - x) ** 2 + (cellZ(t.r) - z) ** 2; if (d < bd) { bd = d; best = t; } }
    return best;
  }

  // ---------- 連線 / 輸入 ----------
  setConnected(side, on, name, kb = false) {
    const p = this.players[side]; if (!p) return;
    const was = p.connected;
    p.connected = on; p.kb = on ? kb : false; if (name) p.name = name;
    if (on && !was) {
      this.placeAtSpawn(p); p.input = { x: 0, y: 0 }; p.downed = false; p.hp = PLAYER_HP; p.skills = {};
      if (this.phase === 'upgrade') p.upgradeDone = true;
      if (this.phase !== 'lobby') this.pushEvent('join', `${this.label(side)} 加入了`, side);
    }
    if (!on) { p.input = { x: 0, y: 0 }; if (this.playerCount() === 0 && this.phase !== 'lobby') this.resetMatch(); }
  }
  playerCount() { return SIDES.filter((s) => this.players[s].connected).length; }
  n() { return Math.max(1, Math.min(4, this.playerCount())); }
  setMove(side, x, y) { const p = this.players[side]; if (!p || !p.connected) return; p.input.x = clamp(num(x), -1, 1); p.input.y = clamp(num(y), -1, 1); }
  action(side, kind) { const p = this.players[side]; if (!p || !p.connected) return; if (kind === 'jump') p.jumpReq = true; else if (kind === 'hit') p.hitReq = true; }
  label(side) { return `P${SIDES.indexOf(side) + 1} ${COLORS[side]}`; }
  alive() { return SIDES.filter((s) => this.players[s].connected && !this.players[s].downed); }

  // ---------- 主迴圈 ----------
  update(dt) {
    this.now += dt;
    if (this.phase === 'lobby') {
      for (const s of SIDES) { const p = this.players[s]; if (p.connected && p.hitReq) this.startCountdown(); p.hitReq = false; }
      this.updatePlayers(dt, true); return;
    }
    if (this.phase === 'countdown') {
      if (this.playerCount() === 0) return this.resetMatch();
      this.updatePlayers(dt, true);
      if (this.now >= this.countdownAt) this.startRun();
      return;
    }
    if (this.phase === 'win' || this.phase === 'lose') {
      for (const s of SIDES) { const p = this.players[s]; if (p.connected && p.hitReq && this.now - this.phaseAt > 2.5) { this.resetMatch(); this.startCountdown(); } p.hitReq = false; p.jumpReq = false; }
      return;
    }
    if (this.phase === 'upgrade') { this.updateUpgrade(dt); return; }
    if (this.phase === 'transition') {
      for (const s of SIDES) { this.players[s].jumpReq = false; this.players[s].hitReq = false; }
      if (this.now >= this.transition.until) this.endTransition();
      return;
    }
    // wave / boss
    this.updateRegrow();
    this.updateSpawning();
    if (this.phase === 'wave') this.updateWaves();
    if (this.phase === 'boss') this.updateBoss(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    this.updatePlayers(dt, false);
    this.updateRevive(dt);
    this.checkDefeat();
  }
  startCountdown() { this.phase = 'countdown'; this.countdownAt = this.now + 3; this.pushEvent('countdown', `${this.n()} 人出發，準備！`); }
  startRun() {
    this.phase = 'wave'; this.phaseAt = this.now; this.startedAt = this.now;
    for (const s of SIDES) if (this.players[s].connected) { this.placeAtSpawn(this.players[s]); this.players[s].hp = PLAYER_HP; }
    this.stageIdx = 0; this.waveIdx = -1; this.waveState = 'idle'; this.waveAt = this.now + 2;
    this.pushEvent('stage', `${STAGES[0].name}：${STAGES[0].intro}`);
  }
  finish(result) {
    this.phase = result; this.phaseAt = this.now; this.endedAt = this.now;
    this.pushEvent(result, result === 'win' ? '核心粉碎！島保住了！' : '全員倒地……島被啃光了', null);
  }
  elapsed() { return this.startedAt ? (this.endedAt || this.now) - this.startedAt : 0; }

  // ---------- 波次 ----------
  waveDef() { const st = STAGES[this.stageIdx]; return st ? st.waves[this.waveIdx] : null; }
  scaleCount(base) { if (!base) return 0; return Math.max(1, Math.round(base * COUNT_SCALE[this.n()])); }
  updateWaves() {
    if (this.waveState === 'idle' && this.now >= this.waveAt) {
      this.waveIdx++;
      const def = this.waveDef();
      if (!def) { this.stageCleared(); return; }
      this.spawnWave(def, 1.0);
      this.waveState = 'fight';
      this.pushEvent('wave', `${STAGES[this.stageIdx].name} 第 ${this.waveIdx + 1}/${STAGES[this.stageIdx].waves.length} 波`, null, true);
      return;
    }
    if (this.waveState === 'fight' && this.enemies.every((e) => e.dead) && !this.spawning.length) {
      this.waveState = 'idle'; this.waveAt = this.now + 2.5;
      this.healAll(1);
      this.pushEvent('cleared', `第 ${this.waveIdx + 1} 波清完，全員回 1 格血`, null, true);
      if (this.upgradesEarned > this.upgradesDone) this.beginUpgrade();
    }
  }
  spawnWave(def, delay) {
    const list = [];
    for (let i = 0; i < this.scaleCount(def.g); i++) list.push('grunt');
    for (let i = 0; i < this.scaleCount(def.r); i++) list.push('ranged');
    for (let i = 0; i < this.scaleCount(def.e); i++) list.push('elite');
    const cells = this.perimeterCells();
    list.forEach((kind, i) => {
      const cell = cells[(i * 7 + Math.floor(Math.random() * 3)) % cells.length];
      this.spawning.push({ kind, c: cell.c, r: cell.r, at: this.now + delay + i * 0.25 });
    });
  }
  perimeterCells() {
    const out = [];
    for (const t of this.tiles.values()) {
      const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dc, dr]) => !this.tiles.has(key(t.c + dc, t.r + dr)));
      if (!edge) continue;
      const far = SIDES.every((s) => { const p = this.players[s]; return !p.connected || Math.hypot(p.x - cellX(t.c), p.z - cellZ(t.r)) > 3.5; });
      if (far) out.push(t);
    }
    if (!out.length) return [...this.tiles.values()];
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    return out;
  }
  updateSpawning() {
    for (let i = this.spawning.length - 1; i >= 0; i--) {
      const sp = this.spawning[i];
      if (this.now < sp.at) continue;
      this.spawning.splice(i, 1);
      this.enemies.push(this.newEnemy(sp.kind, cellX(sp.c), cellZ(sp.r)));
    }
  }
  stageCleared() {
    const next = this.stageIdx + 1;
    if (next < STAGES.length) this.transition = { kind: 'stage', until: this.now + 4, next, text: `${STAGES[this.stageIdx].name} 完成！關卡門打開，前往${STAGES[next].name}` };
    else this.transition = { kind: 'boss', until: this.now + 4, text: '三關全清！關卡門打開，全隊進 Boss 房' };
    this.pushEvent('stageClear', this.transition.text);
    this.phase = 'transition';
  }
  endTransition() {
    const tr = this.transition; this.transition = null;
    // 過關：全員回到中央、倒地的扶起、補滿血
    if (tr.kind === 'stage' || tr.kind === 'boss') for (const s of SIDES) if (this.players[s].connected) { const p = this.players[s]; this.placeAtSpawn(p); p.downed = false; p.reviveT = 0; p.hp = PLAYER_HP; p.invulnUntil = this.now + 1; }
    if (tr.kind === 'stage') {
      this.stageIdx = tr.next; this.waveIdx = -1; this.waveState = 'idle'; this.waveAt = this.now + 2.5; this.phase = 'wave';
      this.pushEvent('stage', `${STAGES[this.stageIdx].name}：${STAGES[this.stageIdx].intro}`);
    } else if (tr.kind === 'boss') {
      this.phase = 'boss';
      this.boss = { state: 'intro', until: this.now + 2.5, x: BOSS_ANCHOR.x, y: BOSS_ANCHOR.y, z: BOSS_ANCHOR.z, from: null, to: null, moveT0: 0, moveDur: 0, mouth: 0.2, hp: Math.round(BOSS_BASE_HP * BOSS_HP_SCALE[this.n()]), maxHp: 0, cands: [], locked: null, target: null, lastTarget: null, exposeUntil: 0, coreHitAt: -9, minionUntil: 0, bites: 0, center: null };
      this.boss.maxHp = this.boss.hp;
      this.pushEvent('bossIntro', 'Boss 方塊巨怪：牠會先在地上標出咬擊範圍再吃掉地板，咬完會短暫露出核心，所有人上前打！');
    } else if (tr.kind === 'upgradeDone') {
      this.phase = this.boss ? 'boss' : 'wave';
    }
  }

  // ---------- 擊倒計數 / 升級 ----------
  thresholds() { const k = KILL_SCALE[this.n()]; return KILL_THRESHOLDS.map((t) => Math.max(3, Math.round(t * k))); }
  countKill(e) {
    if (e.counted) return;
    e.counted = true; this.kills++;
    const th = this.thresholds();
    while (this.upgradesEarned < th.length && this.kills >= th[this.upgradesEarned]) {
      this.upgradesEarned++;
      this.pushEvent('threshold', `全隊擊倒 ${this.kills} 隻，達到升級門檻！這波清完就選技能`, null);
    }
  }
  beginUpgrade() {
    this.phase = 'upgrade';
    this.upgrade = { until: this.now + UPGRADE_TIMEOUT, index: this.upgradesDone + 1 };
    for (const s of SIDES) { const p = this.players[s]; p.upgradeDone = !p.connected; p.upgradeConfirm = 0; p.upgradeMoveAt = 0; p.upgradeChoice = null; p.upgradeCursor = this.firstAvailable(p, 0, 1); p.input = { x: 0, y: 0 }; p.vx = p.vz = 0; }
    this.pushEvent('upgrade', `第 ${this.upgrade.index} 次升級：手機左右傾斜切換、回正停住確認`, null);
  }
  skillAvailable(p, id) { return (p.skills[id] || 0) < 2; }
  firstAvailable(p, from, dir) {
    for (let i = 0; i < SKILL_IDS.length; i++) { const idx = ((from + dir * i) % SKILL_IDS.length + SKILL_IDS.length) % SKILL_IDS.length; if (this.skillAvailable(p, SKILL_IDS[idx])) return idx; }
    return ((from % SKILL_IDS.length) + SKILL_IDS.length) % SKILL_IDS.length;
  }
  updateUpgrade(dt) {
    const u = this.upgrade;
    let allDone = true;
    for (const s of SIDES) {
      const p = this.players[s];
      if (!p.connected || p.upgradeDone) continue;
      allDone = false;
      const x = p.input.x;
      if (Math.abs(x) > 0.5) {
        p.upgradeConfirm = 0;
        if (this.now - p.upgradeMoveAt > 0.45) { p.upgradeMoveAt = this.now; p.upgradeCursor = this.firstAvailable(p, p.upgradeCursor + Math.sign(x), Math.sign(x)); }
      } else if (Math.abs(x) < 0.25) {
        p.upgradeConfirm += dt;
        if (p.upgradeConfirm >= CONFIRM_HOLD) this.confirmUpgrade(p);
      } else p.upgradeConfirm = Math.max(0, p.upgradeConfirm - dt);
      if (!p.upgradeDone && this.now >= u.until) this.confirmUpgrade(p);
      p.jumpReq = false; p.hitReq = false;
    }
    if (allDone) {
      this.upgradesDone++; this.upgrade = null;
      this.transition = { kind: 'upgradeDone', until: this.now + 1.5, text: '升級完成，繼續！' };
      this.phase = 'transition';
    }
  }
  confirmUpgrade(p) {
    const id = SKILL_IDS[p.upgradeCursor];
    p.skills[id] = (p.skills[id] || 0) + 1; p.upgradeDone = true; p.upgradeChoice = id;
    this.pushEvent('picked', `${this.label(p.side)} 選了${SKILLS[id].name}${p.skills[id] >= 2 ? ' Lv2' : ''}`, p.side);
  }

  // ---------- 地磚 ----------
  surfaceAt(x, z) { const [c, r] = toCell(x, z); return this.tiles.has(key(c, r)) ? 0 : null; }
  updateRegrow() {
    for (let i = this.regrow.length - 1; i >= 0; i--) { const g = this.regrow[i]; if (this.now < g.at) continue; this.regrow.splice(i, 1); this.tiles.set(key(g.c, g.r), { c: g.c, r: g.r }); }
  }
  removeTile(c, r) { const k = key(c, r); if (!this.tiles.has(k)) return false; this.tiles.delete(k); this.regrow.push({ c, r, at: this.now + HOLE_REGROW }); return true; }

  // ---------- 玩家 ----------
  speedOf(p) { return PLAYER_SPEED * (this.now < p.whirlUntil ? 1.5 : 1); }
  updatePlayers(dt, lobby) {
    for (const s of SIDES) {
      const p = this.players[s];
      if (!p.connected) continue;
      if (p.downed) { p.jumpReq = p.hitReq = false; p.vx = p.vz = 0; this.updateDowned(p); continue; }
      const sp = this.speedOf(p);
      const ctrl = p.grounded ? 1 : AIR_CONTROL;
      const tx = p.input.x * sp, tz = p.input.y * sp;
      const acc = (p.grounded ? 28 : 14) * dt;
      p.vx = approach(p.vx, tx, acc * ctrl); p.vz = approach(p.vz, tz, acc * ctrl);
      const mag = Math.hypot(p.input.x, p.input.y);
      if (mag > 0.15 && (!p.targetId || this.now - p.hitAt > 0.5)) p.facing = Math.atan2(p.input.x, p.input.y);
      p.x += p.vx * dt; p.z += p.vz * dt;
      p.x = clamp(p.x, cellX(-1), cellX(COLS)); p.z = clamp(p.z, cellZ(-1), cellZ(ROWS));
      this.updateWhirl(p, dt, mag);
      p.prevY = p.y;
      const top = this.surfaceAt(p.x, p.z);
      if (p.jumpReq && p.grounded) { p.vy = JUMP_VY; p.grounded = false; p.airborne = true; p.airT = 0; }
      p.jumpReq = false;
      if (!p.grounded || top == null) {
        p.vy -= GRAVITY * dt; p.y += p.vy * dt; p.grounded = false; p.airT += dt;
        if (top != null && p.vy <= 0 && p.y <= top && p.prevY >= top - 0.3) this.land(p, top);
      } else { p.y = top; p.vy = 0; }
      if (p.y < DEATH_Y) this.fellOff(p, lobby);
      if (!lobby) { if (p.hitReq) p.attackCd = Math.min(p.attackCd, this.now); this.autoAttack(p); }
      p.hitReq = false;
      if (p.shield && this.now > p.shieldUntil) p.shield = 0;
    }
  }
  land(p, top) {
    p.y = top; p.vy = 0; p.grounded = true;
    const wasAir = p.airborne; p.airborne = false;
    if (wasAir && p.airT > 0.25 && p.skills.quake && this.phase !== 'lobby') this.quake(p);
    p.airT = 0;
  }
  quake(p) {
    const lv = p.skills.quake; const R = lv >= 2 ? 3 : 2.2, dmg = lv >= 2 ? 2 : 1;
    let n = 0;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const dx = e.x - p.x, dz = e.z - p.z, d = Math.hypot(dx, dz);
      if (d > R) continue;
      const k = d || 0.1; e.kvx += dx / k * 6; e.kvz += dz / k * 6;
      this.damageEnemy(e, dmg); n++;
    }
    p.quakeAt = this.now; p.quakeR = R;
    if (n) this.pushEvent('quake', `${this.label(p.side)} 震地打退 ${n} 隻`, p.side, true);
  }
  updateWhirl(p, dt, mag) {
    const lv = p.skills.whirl;
    if (!lv) return;
    if (mag > 0.5) {
      const dir = { x: p.input.x / mag, y: p.input.y / mag };
      if (p.lastDir && dir.x * p.lastDir.x + dir.y * p.lastDir.y > 0.9) p.sameDirT += dt; else p.sameDirT = 0;
      p.lastDir = dir;
    } else { p.sameDirT = 0; p.lastDir = null; }
    const need = lv >= 2 ? 0.8 : 1.2;
    if (p.sameDirT >= need && this.now >= p.whirlCd && this.now >= p.whirlUntil) {
      p.whirlUntil = this.now + 1.5; p.whirlCd = p.whirlUntil + 3; p.whirlHit = new Set(); p.sameDirT = 0;
      this.pushEvent('whirl', `${this.label(p.side)} 旋風步！`, p.side, true);
    }
    if (this.now < p.whirlUntil) {
      for (const e of this.enemies) {
        if (e.dead || p.whirlHit.has(e.id)) continue;
        const dx = e.x - p.x, dz = e.z - p.z, d = Math.hypot(dx, dz);
        if (d > 0.9 + ENEMY[e.kind].radius) continue;
        p.whirlHit.add(e.id);
        const k = d || 0.1; e.kvx += dx / k * 7; e.kvz += dz / k * 7;
        this.damageEnemy(e, lv >= 2 ? 2 : 1);
      }
    }
  }
  autoAttack(p) {
    if (this.now < p.attackCd) return;
    let best = null, bd = Infinity;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z) - ENEMY[e.kind].radius;
      if (d <= ATTACK_RANGE && d < bd) { bd = d; best = e; }
    }
    let core = null;
    if (this.boss && this.boss.state === 'exposed') {
      const cp = this.corePos(); const d = Math.hypot(cp.x - p.x, cp.z - p.z);
      if (d <= ATTACK_RANGE + 0.3 && d < bd) core = cp;
    }
    if (!best && !core) { p.targetId = null; return; }
    p.attackCd = this.now + ATTACK_CD; p.hitAt = this.now;
    if (core) {
      p.targetId = 'boss'; p.facing = Math.atan2(core.x - p.x, core.z - p.z);
      this.boss.hp = Math.max(0, this.boss.hp - ATTACK_DMG); this.boss.coreHitAt = this.now;
      if (this.boss.hp <= 0) this.finish('win');
      return;
    }
    p.targetId = best.id; p.facing = Math.atan2(best.x - p.x, best.z - p.z);
    this.damageEnemy(best, ATTACK_DMG, p.x, p.z);
    const lv = p.skills.chain;
    if (lv) {
      const others = this.enemies.filter((e) => !e.dead && e !== best && Math.hypot(e.x - best.x, e.z - best.z) <= 3).sort((a, b) => Math.hypot(a.x - best.x, a.z - best.z) - Math.hypot(b.x - best.x, b.z - best.z));
      for (const e of others.slice(0, lv >= 2 ? 2 : 1)) { this.damageEnemy(e, 1); e.chainAt = this.now; e.chainFrom = { x: best.x, z: best.z }; }
    }
  }
  hurt(p, dmg, fromX, fromZ, knock = 0) {
    if (p.downed || this.now < p.invulnUntil) return false;
    if (knock) { const dx = p.x - fromX, dz = p.z - fromZ, d = Math.hypot(dx, dz) || 1; p.vx += dx / d * knock; p.vz += dz / d * knock; }
    if (p.shield > 0) { p.shield--; p.invulnUntil = this.now + 0.6; p.hurtAt = this.now; return true; }
    p.hp -= dmg; p.invulnUntil = this.now + INVULN; p.hurtAt = this.now;
    if (p.hp <= 0) { p.hp = 0; this.down(p); }
    return true;
  }
  down(p) {
    p.downed = true; p.downAt = this.now; p.reviveT = 0; p.vx = p.vz = 0; p.targetId = null; this.stats.downs++;
    this.pushEvent('down', this.playerCount() >= 2 ? `${this.label(p.side)} 倒地了！隊友靠近救援` : `${this.label(p.side)} 倒地了…… ${SOLO_RECOVER} 秒後自己爬起來（還剩 ${Math.max(0, SOLO_LIVES - this.soloLivesUsed)} 次）`, p.side);
  }
  fellOff(p, lobby) {
    this.placeAtSpawn(p);
    if (lobby) return;
    p.invulnUntil = 0; this.hurt(p, 1, p.x, p.z);
    if (!p.downed) this.pushEvent('fall', `${this.label(p.side)} 掉下島了，回到中央`, p.side, true);
  }
  updateDowned(p) {
    if (this.playerCount() <= 1 && this.now - p.downAt >= SOLO_RECOVER) {
      this.soloLivesUsed++;
      if (this.soloLivesUsed > SOLO_LIVES) return this.finish('lose');
      this.revive(p, null);
    }
  }
  updateRevive(dt) {
    for (const s of SIDES) {
      const p = this.players[s];
      if (!p.connected || !p.downed) continue;
      let helper = null, best = Infinity;
      for (const s2 of SIDES) { const q = this.players[s2]; if (q === p || !q.connected || q.downed) continue; const d = Math.hypot(q.x - p.x, q.z - p.z); if (d <= REVIVE_RANGE && d < best) { best = d; helper = q; } }
      if (!helper) { p.reviveT = Math.max(0, p.reviveT - dt * 0.5); p.helper = null; continue; }
      const lv = helper.skills.guard || 0;
      const need = lv >= 2 ? 0.7 : lv ? 1.0 : REVIVE_TIME;
      p.helper = helper.side; p.reviveT += dt / need;
      if (p.reviveT >= 1) this.revive(p, helper);
    }
  }
  revive(p, helper) {
    p.downed = false; p.reviveT = 0; p.invulnUntil = this.now + 1.5; p.helper = null; if (helper) this.stats.revives++;
    const lv = helper ? (helper.skills.guard || 0) : 0;
    p.hp = helper ? (lv >= 2 ? PLAYER_HP : 2) : 1;
    if (helper && lv) { const sh = lv >= 2 ? 2 : 1; p.shield = sh; p.shieldUntil = this.now + 6; helper.shield = sh; helper.shieldUntil = this.now + 6; }
    this.pushEvent('revive', helper ? `${this.label(helper.side)} 救起了 ${this.label(p.side)}${lv ? '，兩人獲得護盾' : ''}` : `${this.label(p.side)} 爬起來了`, helper ? helper.side : p.side);
  }
  healAll(n) { for (const s of SIDES) { const p = this.players[s]; if (p.connected && !p.downed) p.hp = Math.min(p.maxHp, p.hp + n); } }
  checkDefeat() {
    if (this.playerCount() >= 2 && this.alive().length === 0 && (this.phase === 'wave' || this.phase === 'boss')) this.finish('lose');
  }

  // ---------- 敵人 ----------
  newEnemy(kind, x, z) {
    const def = ENEMY[kind];
    return { id: this.nextId++, kind, x, y: 0, z, kvx: 0, kvz: 0, facing: Math.PI, hp: def.hp, maxHp: def.hp, state: 'spawn', stateAt: this.now, cd: this.now + 1 + Math.random(), dead: false, deadAt: 0, counted: false, hitAt: -9, dir: null, dashHit: new Set(), spawnedAt: this.now, dashLen: 0 };
  }
  targetFor(e) {
    let best = null, bd = Infinity;
    for (const s of SIDES) { const p = this.players[s]; if (!p.connected || p.downed) continue; const d = Math.hypot(p.x - e.x, p.z - e.z); if (d < bd) { bd = d; best = p; } }
    return best;
  }
  updateEnemies(dt) {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.dead) { if (this.now - e.deadAt > 0.7) this.enemies.splice(i, 1); continue; }
      const def = ENEMY[e.kind];
      const t = this.targetFor(e);
      let mvx = 0, mvz = 0;
      const move = (x, z) => { mvx = x; mvz = z; };
      if (e.state === 'spawn') { if (this.now - e.spawnedAt > 0.4) e.state = 'idle'; }
      else if (e.kind === 'grunt') this.aiGrunt(e, def, t, move);
      else if (e.kind === 'ranged') this.aiRanged(e, def, t, move);
      else if (e.kind === 'elite') this.aiElite(e, def, t, move);
      for (const o of this.enemies) { if (o === e || o.dead) continue; const dx = e.x - o.x, dz = e.z - o.z, d = Math.hypot(dx, dz), min = def.radius + ENEMY[o.kind].radius; if (d < min && d > 0.001) { mvx += dx / d * (min - d) * 4; mvz += dz / d * (min - d) * 4; } }
      e.kvx *= Math.max(0, 1 - 6 * dt); e.kvz *= Math.max(0, 1 - 6 * dt);
      const nx = e.x + (mvx + e.kvx) * dt, nz = e.z + (mvz + e.kvz) * dt;
      const knocked = Math.hypot(e.kvx, e.kvz) > 1.5 || e.state === 'dash';
      if (this.surfaceAt(nx, nz) != null || knocked) { e.x = nx; e.z = nz; }
      else { if (this.surfaceAt(nx, e.z) != null) e.x = nx; else if (this.surfaceAt(e.x, nz) != null) e.z = nz; }
      if (Math.hypot(mvx, mvz) > 0.2 && e.state !== 'dash' && e.state !== 'windup') e.facing = Math.atan2(mvx, mvz);
      if (this.surfaceAt(e.x, e.z) == null) { e.y -= 8 * dt; if (e.y < -1.5) this.killEnemy(e, true); } else e.y = 0;
    }
  }
  aiGrunt(e, def, t, move) {
    if (!t) return;
    const dx = t.x - e.x, dz = t.z - e.z, d = Math.hypot(dx, dz) || 1;
    if (e.state === 'windup') {
      e.facing = Math.atan2(dx, dz);
      if (this.now - e.stateAt >= def.windup) { e.state = 'idle'; e.cd = this.now + def.cd; e.strikeAt = this.now; if (d <= def.reach + 0.25) this.hurt(t, def.dmg, e.x, e.z, 3); }
      return;
    }
    if (d <= def.reach && this.now >= e.cd) { e.state = 'windup'; e.stateAt = this.now; e.facing = Math.atan2(dx, dz); return; }
    if (d > def.reach * 0.7) move(dx / d * def.speed, dz / d * def.speed);
  }
  aiRanged(e, def, t, move) {
    if (!t) return;
    const dx = t.x - e.x, dz = t.z - e.z, d = Math.hypot(dx, dz) || 1;
    if (e.state === 'windup') {
      e.facing = Math.atan2(dx, dz);
      if (this.now - e.stateAt >= def.windup) {
        e.state = 'idle'; e.cd = this.now + def.fireCd;
        this.projectiles.push({ x: e.x + dx / d * 0.5, y: 0.62, z: e.z + dz / d * 0.5, vx: dx / d * def.projSpeed, vz: dz / d * def.projSpeed, born: this.now });
      }
      return;
    }
    if (d < def.near) move(-dx / d * def.speed, -dz / d * def.speed);
    else if (d > def.far) move(dx / d * def.speed, dz / d * def.speed);
    else { const sgn = e.id % 2 ? 1 : -1; move(-dz / d * def.speed * 0.4 * sgn, dx / d * def.speed * 0.4 * sgn); e.facing = Math.atan2(dx, dz); }
    if (this.now >= e.cd && d < def.far + 2) { e.state = 'windup'; e.stateAt = this.now; }
  }
  aiElite(e, def, t, move) {
    if (e.state === 'stun') { if (this.now - e.stateAt >= def.stun) { e.state = 'idle'; e.cd = this.now + def.cd; } return; }
    if (e.state === 'windup') { if (this.now - e.stateAt >= def.windup) { e.state = 'dash'; e.stateAt = this.now; e.dashHit = new Set(); } return; }
    if (e.state === 'dash') {
      const age = this.now - e.stateAt;
      const nx = e.x + e.dir.x * def.dashSpeed * 0.05, nz = e.z + e.dir.z * def.dashSpeed * 0.05;
      if (this.surfaceAt(nx, nz) == null || age >= def.dashDur) { e.state = 'stun'; e.stateAt = this.now; return; }
      move(e.dir.x * def.dashSpeed, e.dir.z * def.dashSpeed);
      for (const s of SIDES) { const p = this.players[s]; if (!p.connected || p.downed || e.dashHit.has(s)) continue; if (Math.hypot(p.x - e.x, p.z - e.z) <= def.radius + 0.5 && p.y < 1.2) { e.dashHit.add(s); this.hurt(p, def.dmg, e.x, e.z, 4); } }
      return;
    }
    if (!t) return;
    const dx = t.x - e.x, dz = t.z - e.z, d = Math.hypot(dx, dz) || 1;
    if (d <= def.chargeRange && this.now >= e.cd) { e.state = 'windup'; e.stateAt = this.now; e.dir = { x: dx / d, z: dz / d }; e.facing = Math.atan2(dx, dz); e.dashLen = def.dashSpeed * def.dashDur; return; }
    move(dx / d * def.speed, dz / d * def.speed);
  }
  damageEnemy(e, dmg, fromX = null, fromZ = null) {
    if (e.dead) return;
    if (e.kind === 'elite' && e.state === 'stun') dmg *= 2;
    e.hp -= dmg; e.hitAt = this.now;
    if (e.kind !== 'elite') {
      if (e.state === 'windup') { e.state = 'idle'; e.cd = this.now + 0.6; } // 被敲就踉蹌，蓄力中斷
      if (fromX != null) { const dx = e.x - fromX, dz = e.z - fromZ, d = Math.hypot(dx, dz) || 1; e.kvx += dx / d * 2.5; e.kvz += dz / d * 2.5; }
    }
    if (e.hp <= 0) this.killEnemy(e);
  }
  killEnemy(e, fell = false) {
    if (e.dead) return;
    e.dead = true; e.deadAt = this.now; e.fell = fell;
    this.countKill(e);
  }
  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const q = this.projectiles[i];
      q.x += q.vx * dt; q.z += q.vz * dt;
      let hit = false;
      for (const s of SIDES) { const p = this.players[s]; if (!p.connected || p.downed) continue; if (Math.hypot(p.x - q.x, p.z - q.z) <= PROJ_HIT_R && p.y < 1.0) { this.hurt(p, ENEMY.ranged.dmg, q.x - q.vx, q.z - q.vz, 2); hit = true; break; } }
      if (hit || this.now - q.born > PROJ_LIFE || (this.surfaceAt(q.x, q.z) == null && this.now - q.born > 0.3)) this.projectiles.splice(i, 1);
    }
  }

  // ---------- Boss ----------
  // Boss 面向：rot = 0 朝 +Z（南）、π 朝北、π/2 朝東、-π/2 朝西；偏移沿面向旋轉
  bossDir() { const r = this.boss.rot || 0; return { x: Math.sin(r), z: Math.cos(r) }; }
  mouthPos() { const b = this.boss, d = this.bossDir(); return { x: b.x + d.x * MOUTH_OFFSET.z, y: b.y + MOUTH_OFFSET.y, z: b.z + d.z * MOUTH_OFFSET.z }; }
  corePos() { const b = this.boss, d = this.bossDir(); return { x: b.x + d.x * CORE_OFFSET.z, y: b.y + CORE_OFFSET.y, z: b.z + d.z * CORE_OFFSET.z }; }
  coreFront() { const b = this.boss; const c = this.corePos(); if (!b.rim) return { x: c.x, z: c.z + 1.4 }; const d = this.bossDir(); return { x: b.rim.x + d.x * (S / 2), z: b.rim.z + d.z * (S / 2) }; }
  // 選下巴要搭在洞的哪一邊：外側有最多可站地磚的那一邊（平手時南優先），讓所有人都能從那邊上前打核心
  chooseRim(cells) {
    const cs = cells.map((c) => c[0]), rs = cells.map((c) => c[1]);
    const minC = Math.min(...cs), maxC = Math.max(...cs), minR = Math.min(...rs), maxR = Math.max(...rs);
    const cx = (cellX(minC) + cellX(maxC)) / 2, cz = (cellZ(minR) + cellZ(maxR)) / 2;
    const opts = [
      { rot: 0, rim: { x: cx, z: cellZ(maxR) + S / 2 }, count: () => { let n = 0; for (let c = minC; c <= maxC; c++) if (this.tiles.has(key(c, maxR + 1))) n++; return n; } },
      { rot: Math.PI, rim: { x: cx, z: cellZ(minR) - S / 2 }, count: () => { let n = 0; for (let c = minC; c <= maxC; c++) if (this.tiles.has(key(c, minR - 1))) n++; return n; } },
      { rot: Math.PI / 2, rim: { x: cellX(maxC) + S / 2, z: cz }, count: () => { let n = 0; for (let r = minR; r <= maxR; r++) if (this.tiles.has(key(maxC + 1, r))) n++; return n; } },
      { rot: -Math.PI / 2, rim: { x: cellX(minC) - S / 2, z: cz }, count: () => { let n = 0; for (let r = minR; r <= maxR; r++) if (this.tiles.has(key(minC - 1, r))) n++; return n; } },
    ];
    let best = opts[0], bn = -1;
    for (const o of opts) { const n = o.count(); if (n > bn) { bn = n; best = o; } }
    return best;
  }
  bossMoveTo(to, dur) { const b = this.boss; b.from = { x: b.x, y: b.y, z: b.z }; b.to = { ...to }; b.moveT0 = this.now; b.moveDur = dur; }
  updateBossMotion() {
    const b = this.boss; if (!b.to) return;
    const t = clamp((this.now - b.moveT0) / b.moveDur, 0, 1), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    b.x = b.from.x + (b.to.x - b.from.x) * e; b.y = b.from.y + (b.to.y - b.from.y) * e; b.z = b.from.z + (b.to.z - b.from.z) * e;
    if (b.state === 'lunge') b.y += Math.sin(t * Math.PI) * 1.6;
    if (t >= 1) b.to = null;
  }
  biteArea(p) {
    const [c, r] = toCell(p.x, p.z);
    const out = [];
    for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) if (this.tiles.has(key(c + dc, r + dr))) out.push([c + dc, r + dr]);
    if (!out.length) { const t = this.nearestTile(p.x, p.z); if (t) out.push([t.c, t.r]); }
    return out;
  }
  updateBoss(dt) {
    const b = this.boss;
    this.updateBossMotion();
    switch (b.state) {
      case 'intro': b.mouth = approach(b.mouth, 0.3, dt); if (this.now >= b.until) { b.state = 'rest'; b.until = this.now + 1.5; } break;
      case 'rest': {
        b.mouth = approach(b.mouth, 0.15, dt * 2);
        if (this.now < b.until) break;
        const alive = this.alive(); if (!alive.length) { b.until = this.now + 1; break; }
        const pool = alive.filter((s) => s !== b.lastTarget);
        const pick = pool.length ? pool : alive;
        b.target = pick[Math.floor(Math.random() * pick.length)];
        b.lastTarget = b.target; b.state = 'aim'; b.until = this.now + 2.0;
        this.pushEvent('bossAim', `巨怪盯上了 ${this.label(b.target)}：離開地上的咬痕範圍`, b.target);
        break;
      }
      case 'aim': {
        b.mouth = approach(b.mouth, 0.6, dt * 2);
        const p = this.players[b.target];
        if (!p.connected) { b.state = 'rest'; b.until = this.now + 1; b.cands = []; break; }
        b.cands = this.biteArea(p);
        if (this.now >= b.until) { b.locked = b.cands.slice(); b.state = 'lock'; b.until = this.now + 0.8; this.pushEvent('bossLock', '鎖定了！離開紅色範圍', b.target, true); }
        break;
      }
      case 'lock':
        b.mouth = approach(b.mouth, 1, dt * 3);
        if (this.now >= b.until) {
          // 下巴搭在洞的某一緣（外側有可站地磚的那邊）：核心離那排磚約 1 格，所有人從那邊上前打
          const rimOpt = this.chooseRim(b.locked);
          b.rot = rimOpt.rot; b.rim = rimOpt.rim;
          const d = this.bossDir(); // 從洞內朝外（下巴方向）
          b.state = 'lunge'; b.until = this.now + 0.5;
          this.bossMoveTo({ x: b.rim.x - d.x * (1.0 + CORE_OFFSET.z), y: -0.2, z: b.rim.z - d.z * (1.0 + CORE_OFFSET.z) }, 0.5);
        }
        break;
      case 'lunge':
        b.mouth = 1;
        if (this.now >= b.until) {
          let n = 0; for (const [c, r] of b.locked) if (this.removeTile(c, r)) n++;
          b.bites++; b.cands = []; b.locked = null;
          b.state = 'exposed'; b.exposeUntil = this.now + EXPOSE_DUR[this.n()]; b.until = b.exposeUntil;
          this.pushEvent('bossExposed', `咬掉 ${n} 塊地板！核心露出 ${EXPOSE_DUR[this.n()]} 秒，所有人上前打！`, null);
        }
        break;
      case 'exposed':
        b.mouth = approach(b.mouth, 1, dt * 3);
        if (this.now >= b.exposeUntil) { b.state = 'recoil'; b.until = this.now + 1.2; b.rot = 0; b.rim = null; this.bossMoveTo(BOSS_ANCHOR, 1.0); this.pushEvent('bossClose', '核心縮回去了', null, true); }
        break;
      case 'recoil':
        b.mouth = approach(b.mouth, 0.4, dt * 2);
        if (this.now >= b.until) {
          b.state = 'minions'; b.minionUntil = this.now + 25;
          this.spawnWave({ g: 3, r: 1 }, 0.8);
          this.pushEvent('minions', '一小波雜兵來了：決定誰清場、誰留在巨怪旁', null);
        }
        break;
      case 'minions':
        b.mouth = approach(b.mouth, 0.2, dt);
        if ((this.enemies.every((e) => e.dead) && !this.spawning.length) || this.now >= b.minionUntil) { b.state = 'rest'; b.until = this.now + 1.0; this.healAll(1); }
        break;
    }
  }

  // ---------- 事件 / 快照 ----------
  pushEvent(type, text, side = null, quiet = false) { this.lastEvent = { t: Math.round(this.now * 1000), type, text, side, quiet }; }
  snapshot() {
    const tiles = []; for (const t of this.tiles.values()) tiles.push([t.c, t.r]);
    const players = {};
    for (const s of SIDES) {
      const p = this.players[s];
      players[s] = {
        connected: p.connected, name: p.name, kb: p.kb,
        x: r3(p.x), y: r3(p.y), z: r3(p.z), vx: r3(p.vx), vy: r3(p.vy), vz: r3(p.vz), facing: r3(p.facing), grounded: p.grounded,
        hp: p.hp, maxHp: p.maxHp, downed: p.downed, reviveT: r3(p.reviveT), helper: p.helper || null, invuln: this.now < p.invulnUntil, shield: p.shield,
        hitAge: r3(this.now - p.hitAt), hurtAge: r3(this.now - p.hurtAt), targetId: p.targetId, skills: p.skills,
        whirl: this.now < p.whirlUntil, quakeAge: r3(this.now - p.quakeAt), quakeR: p.quakeR || 2.2,
        pick: this.phase === 'upgrade' ? { cursor: p.upgradeCursor, confirm: r3(Math.min(1, p.upgradeConfirm / CONFIRM_HOLD)), done: p.upgradeDone, choice: p.upgradeChoice } : null,
      };
    }
    const enemies = this.enemies.map((e) => ({ id: e.id, kind: e.kind, x: r3(e.x), y: r3(e.y), z: r3(e.z), facing: r3(e.facing), hp: e.hp, maxHp: e.maxHp, state: e.state, stateAge: r3(this.now - e.stateAt), dead: e.dead, deadAge: e.dead ? r3(this.now - e.deadAt) : 0, hitAge: r3(this.now - e.hitAt), dir: e.state === 'windup' || e.state === 'dash' ? e.dir : null, dashLen: e.dashLen || 0, chainAge: e.chainAt ? r3(this.now - e.chainAt) : 99, chainFrom: e.chainFrom || null, fell: !!e.fell, strikeAge: e.strikeAt ? r3(this.now - e.strikeAt) : 99 }));
    const b = this.boss;
    const stage = STAGES[this.stageIdx];
    const remaining = this.enemies.filter((e) => !e.dead).length + this.spawning.length;
    return {
      game: 'island', phase: this.phase, t: Math.round(this.now * 1000), n: this.playerCount(), elapsed: r3(this.elapsed()),
      countdown: this.phase === 'countdown' ? Math.max(0, this.countdownAt - this.now) : 0,
      grid: { cols: COLS, rows: ROWS, cx: CX, cz: CZ, s: S }, gate: GATE, shrine: SHRINE,
      tiles, regrow: this.regrow.map((g) => ({ c: g.c, r: g.r, in: r3(Math.max(0, g.at - this.now)) })),
      spawning: this.spawning.map((sp) => ({ c: sp.c, r: sp.r, kind: sp.kind, in: r3(Math.max(0, sp.at - this.now)) })),
      stage: { idx: this.stageIdx, count: STAGES.length, name: this.phase === 'boss' ? 'Boss 房' : (stage ? stage.name : ''), wave: this.waveIdx + 1, waveCount: stage ? stage.waves.length : 0, remaining, waveState: this.waveState, names: STAGES.map((x) => x.name) },
      kills: this.kills, thresholds: this.thresholds(), upgradesEarned: this.upgradesEarned, upgradesDone: this.upgradesDone,
      players, enemies, projectiles: this.projectiles.map((q) => ({ x: r3(q.x), y: r3(q.y), z: r3(q.z) })),
      boss: b ? { x: r3(b.x), y: r3(b.y), z: r3(b.z), rot: r3(b.rot || 0), state: b.state, hp: b.hp, maxHp: b.maxHp, mouth: r3(b.mouth), cands: b.cands, locked: b.locked, target: b.target, exposeRemain: b.state === 'exposed' ? r3(Math.max(0, b.exposeUntil - this.now)) : 0, core: b.state === 'exposed' ? this.corePos() : null, coreFront: b.state === 'exposed' ? this.coreFront() : null, coreHitAge: r3(this.now - b.coreHitAt), coreOff: CORE_OFFSET } : null,
      upgrade: this.upgrade ? { index: this.upgrade.index, remain: r3(Math.max(0, this.upgrade.until - this.now)), options: SKILL_IDS.map((id) => ({ id, ...SKILLS[id] })) } : null,
      transition: this.transition ? { kind: this.transition.kind, text: this.transition.text, remain: r3(Math.max(0, this.transition.until - this.now)) } : null,
      skills: SKILLS, colors: COLORS, stats: this.stats, soloLives: this.playerCount() <= 1 ? Math.max(0, SOLO_LIVES - this.soloLivesUsed) : null,
      lastEvent: this.lastEvent,
    };
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function num(v) { v = Number(v); return Number.isFinite(v) ? v : 0; }
function approach(cur, target, maxStep) { const d = target - cur; return Math.abs(d) <= maxStep ? target : cur + Math.sign(d) * maxStep; }
function r3(v) { return Math.round(v * 1000) / 1000; }
