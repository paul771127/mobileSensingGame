// 球場與球的物理 / 規則（伺服器端權威運算）
// 座標系：單位公尺。x = 球場寬度方向（-W/2 ~ W/2），y = 球場長度方向（A 方在負、B 方在正），z = 高度。

export const COURT = {
  width: 10.97,        // 雙打寬（畫面用）
  singlesWidth: 8.23,  // 單打有效寬
  length: 23.77,
  netHeight: 0.9,
  serviceLine: 6.4,    // 距球網
  baselineOffset: 1.0, // 球員站在底線後方多少
};

const G = 9.8;
const TOPSPIN_ACC = 6.0;  // 上旋 = 1 時額外向下加速度 m/s²（下旋為向上，球會飄）
const CURVE_ACC = 4.5;    // 側旋 = 1 時的側向加速度 m/s²
export const MANUAL_MOVE = false; // 舊：手機姿態（傾斜）控制跑位
// 手機平移控制跑位：手機位移（公尺，最大約 ±0.3）× 增益 = 角色相對基準點的位移
export const TRANSLATE_MOVE = true;
const PHONE_RANGE = 0.3;           // 手機平移最大範圍 m
const COURT_RANGE_X = 5.0;         // 對應球場左右 ±5 m
const COURT_RANGE_Y = 3.5;         // 對應球場前後 ±3.5 m
const TRANSLATE_SPEED = 9.0;       // 角色追上目標點的最大速度 m/s
const ASSIST_BLEND = 0.5;          // 來球最後 0.7 秒，目標點向球靠近的比例
const HALF_L = COURT.length / 2;
const HALF_W = COURT.singlesWidth / 2;

const SIDES = ['A', 'B'];
const sign = (side) => (side === 'A' ? -1 : 1);
const other = (side) => (side === 'A' ? 'B' : 'A');

const POINT_NAMES = ['0', '15', '30', '40'];

export class Game {
  constructor() {
    this.players = {
      A: this.makePlayer('A'),
      B: this.makePlayer('B'),
    };
    this.score = { points: { A: 0, B: 0 }, games: { A: 0, B: 0 } };
    this.phase = 'lobby'; // lobby | serve | rally | point | gameover
    this.server = 'A';
    this.ball = null;
    this.rallyHits = 0;
    this.lastEvent = null; // { type, side, text, t }
    this.phaseTimer = 0;
    this.pendingSwing = { A: null, B: null }; // 揮拍緩衝（允許稍早揮）
    this.lastFx = null; // 音效/特效事件 { type, t, x, y }
    this.lastShot = null; // 最近一次擊球的參數（顯示/除錯用）
    this.bot = { A: false, B: false }; // 電腦玩家（單人練習）
    this.botNextSwing = 0;
    this.time = 0;
  }

  makePlayer(side) {
    return {
      side,
      connected: false,
      name: side === 'A' ? '玩家 A' : '玩家 B',
      x: 0,
      y: sign(side) * (HALF_L + COURT.baselineOffset),
      swingAnim: 0, // 揮拍動畫倒數（秒）
      speed: 7,     // 自動跑位速度 m/s
      move: { x: 0, y: 0, t: -10 }, // 手機姿態控制的移動輸入（x: 右為正, y: 朝球網為正）
      offset: { x: 0, y: 0, t: -10 }, // 手機平移位移（公尺；x 右、y 朝球網）
      head: null, // 拍頭方向單位向量 { r, f, u }（玩家座標：右/前/上），無感測器時為 null
      facing: 0,  // 面向（8 方向，玩家座標）：0 前(朝球網) 1 右前 2 右 3 右後 4 後 5 左後 6 左 7 左前
      facingHold: 0,
    };
  }

  // ---------- 連線 ----------
  setConnected(side, connected, name) {
    const p = this.players[side];
    if (connected) this.bot[side] = false; // 真人加入就取代電腦
    p.connected = connected;
    if (name) p.name = name;
    else if (connected) p.name = side === 'A' ? '玩家 A' : '玩家 B';
    if (this.bothReady() && this.phase === 'lobby') this.startServe(this.server);
    if (!this.bothReady() && this.phase !== 'lobby') {
      this.phase = 'lobby';
      this.ball = null;
      this.event('pause', side, '等待玩家重新連線');
    }
  }

  bothReady() {
    return this.players.A.connected && this.players.B.connected;
  }

  // 手機平移位移（公尺）
  setOffset(side, x, y) {
    const p = this.players[side];
    const n = (v) => (Number.isFinite(v) ? clamp(v, -PHONE_RANGE * 1.2, PHONE_RANGE * 1.2) : 0);
    p.offset = { x: n(x), y: n(y), t: this.time };
  }

  // 手機姿態移動輸入
  setMove(side, x, y) {
    const p = this.players[side];
    const n = (v) => (Number.isFinite(v) ? clamp(v, -1, 1) : 0);
    p.move = { x: n(x), y: n(y), t: this.time };
  }

  setPose(side, r, f, u) {
    if (![r, f, u].every(Number.isFinite)) return;
    const n = Math.hypot(r, f, u) || 1;
    this.players[side].head = { r: r / n, f: f / n, u: u / n };
  }

  // 單人練習：讓某一方由電腦操作
  setBot(side, on) {
    this.bot[side] = on;
    const p = this.players[side];
    if (on) { p.connected = true; p.name = '電腦'; p.speed = 9; }
    else { p.connected = false; p.name = side === 'A' ? '玩家 A' : '玩家 B'; p.speed = 7; }
    if (this.bothReady() && this.phase === 'lobby') this.startServe(this.server);
    if (!this.bothReady() && this.phase !== 'lobby') { this.phase = 'lobby'; this.ball = null; }
    this.event(on ? 'bot' : 'pause', side, on ? '電腦加入練習' : '電腦離開');
  }

  updateBots() {
    for (const side of SIDES) {
      if (!this.bot[side] || !this.ball) continue;
      const serving = this.phase === 'serve' && this.server === side;
      const b = this.ball;
      const towardMe = this.phase === 'rally' && Math.sign(b.vy) === sign(side);
      if (!serving && !towardMe) continue;
      if (this.time < this.botNextSwing) continue;
      // 發球：等 1 秒再揮；回球：球進擊球區且離理想擊球點夠近才揮
      if (serving && this.phaseTimer > 2.0) continue;
      if (!this.inHitZone(side)) continue;
      const p = this.players[side];
      const dy = (b.y - p.y) * -sign(side);
      if (!serving && dy > 1.1) continue; // 太早
      this.botNextSwing = this.time + 0.5;
      this.swing(side, {
        strength: 0.45 + Math.random() * 0.3,
        dirX: 0,
        face: (Math.random() - 0.5) * 0.9,
        loft: 0,
        plane: (Math.random() - 0.5) * 0.5,
        spin: 0,
      });
    }
  }

  event(type, side, text) {
    this.lastEvent = { type, side, text, t: this.time };
  }

  fx(type, x = 0, y = 0) {
    this.lastFx = { type, t: this.time, x: round(x), y: round(y) };
  }

  // ---------- 流程 ----------
  startServe(side) {
    this.phase = 'serve';
    this.server = side;
    this.rallyHits = 0;
    const p = this.players[side];
    p.x = sign(side) * -1.5; // 發球位置稍微偏一側
    const baseY = sign(side) * (HALF_L + COURT.baselineOffset);
    p.y = baseY;
    this.players[other(side)].x = 0;
    this.players[other(side)].y = -baseY;
    // 球拋在發球者頭上，等待揮拍；超時自動發球
    this.ball = {
      x: p.x,
      y: p.y,
      z: 1.2,
      vx: 0, vy: 0, vz: 3.2,
      lastHitBy: null,
      bounces: 0,
      bounceSide: null,
      inPlay: false,
      spin: 0, curve: 0, ax: 0,
    };
    this.phaseTimer = 3.0;
    this.event('serve', side, `${p.name} 發球`);
  }

  awardPoint(winner, reason) {
    if (this.phase === 'point' || this.phase === 'gameover') return;
    this.phase = 'point';
    this.phaseTimer = 2.2;
    const loser = other(winner);
    const pts = this.score.points;
    pts[winner] += 1;
    let text = `${this.players[winner].name} 得分（${reason}）`;
    // 網球計分：拿到 4 分且領先 2 分贏一局
    if (pts[winner] >= 4 && pts[winner] - pts[loser] >= 2) {
      this.score.games[winner] += 1;
      pts.A = 0; pts.B = 0;
      text = `${this.players[winner].name} 贏得這一局！`;
      this.server = other(this.server); // 換發球
      if (this.score.games[winner] >= 6 && this.score.games[winner] - this.score.games[loser] >= 2) {
        this.phase = 'gameover';
        text = `${this.players[winner].name} 贏得整盤比賽！`;
        this.phaseTimer = 8;
      }
    }
    this.event('point', winner, text);
    this.fx('point');
    if (this.ball) this.ball.inPlay = false;
  }

  resetMatch() {
    this.score = { points: { A: 0, B: 0 }, games: { A: 0, B: 0 } };
    this.server = 'A';
    if (this.bothReady()) this.startServe('A');
    else { this.phase = 'lobby'; this.ball = null; }
  }

  // 顯示用的分數字串
  pointLabel(side) {
    const a = this.score.points[side], b = this.score.points[other(side)];
    if (a >= 3 && b >= 3) {
      if (a === b) return '40';
      return a > b ? 'Ad' : '40';
    }
    return POINT_NAMES[Math.min(a, 3)];
  }

  // ---------- 揮拍 ----------
  // swing = {
  //   strength: 0..1   揮拍速度（加速度峰值）
  //   dirX:    -1..1   揮動方向（左/右）
  //   face:    -1..1   拍面開合角（手機 yaw 相對校正方向；負=朝左、正=朝右）
  //   loft:    -1..1   拍面仰角（手機前後傾；正=拍面朝上）
  //   plane:   -1..1   揮拍平面（負=由上往下劈、正=由下往上撈）
  //   spin:    -1..1   手腕翻轉（正=上旋、負=下旋）
  //   curve:   -1..1   側旋（正=往自己右邊彎）
  // }
  normalizeSwing(swing) {
    const num = (v, def) => (Number.isFinite(v) ? v : def);
    return {
      strength: clamp(num(swing?.strength, 0.6), 0, 1),
      dirX: clamp(num(swing?.dirX, 0), -1, 1),
      face: clamp(num(swing?.face, 0), -1, 1),
      loft: clamp(num(swing?.loft, 0), -1, 1),
      plane: clamp(num(swing?.plane, 0), -1, 1),
      spin: clamp(num(swing?.spin, 0), -1, 1),
      curve: clamp(num(swing?.curve, 0), -1, 1),
      t: this.time,
    };
  }

  swing(side, swing) {
    const p = this.players[side];
    p.swingAnim = 0.35;
    const s = this.normalizeSwing(swing);
    p.lastSwing = { plane: s.plane, dirX: s.dirX, t: this.time };
    if (this.tryHit(side, s)) return true;
    // 揮早了：緩衝 0.25 秒，球進入擊球區時再判定
    this.pendingSwing[side] = s;
    return false;
  }

  // 球拍拍頭的世界座標（與顯示端畫法一致）：手在身體右前方 1.0m 高，拍長 0.78m
  racketHeadPos(side) {
    const p = this.players[side];
    const dir = -sign(side); // 玩家座標 → 世界：右 = dir*x, 前 = dir*y
    const h = p.head || { r: 0.5, f: 0.35, u: 0.8 };
    const n = Math.hypot(h.r, h.f, h.u) || 1;
    const hx = p.x + 0.3 * dir, hy = p.y + 0.1 * dir, hz = 1.0;
    const L = 0.78;
    return { x: hx + (h.r / n) * dir * L, y: hy + (h.f / n) * dir * L, z: hz + (h.u / n) * L, hr: h.r / n, hu: h.u / n };
  }

  // 不揮拍時球碰到拍面：自動以小力道擊回（像用拍面擋球 / 放短球）
  passiveBlock(dt) {
    if (this.phase !== 'rally' || !this.ball) return;
    const b = this.ball;
    for (const side of SIDES) {
      if (this.bot[side]) continue;
      const p = this.players[side];
      if (!p.connected) continue;
      if (Math.sign(b.vy) !== sign(side)) continue; // 球要朝我飛來
      if (p.swingAnim > 0) continue;               // 正在揮拍就交給揮拍判定
      if (this.time - (p.lastBlockT || -10) < 0.5) continue;
      const rh = this.racketHeadPos(side);
      const d = Math.hypot(b.x - rh.x, b.y - rh.y, b.z - rh.z);
      if (d > 0.6) continue;
      p.lastBlockT = this.time;
      p.swingAnim = 0.15;
      const s = this.normalizeSwing({
        strength: 0.12 + Math.min(0.1, Math.hypot(b.vx, b.vy) / 200), // 幾乎只靠來球反彈：短球
        dirX: 0,
        face: rh.hr * 0.8,            // 拍面朝哪就往哪偏
        loft: clamp((rh.hu - 0.5) * 1.2, -1, 1),
        plane: 0, spin: 0, curve: 0,
      });
      this.hitBall(side, s, false);
      this.event('hit', side, 'block');
      return;
    }
  }

  inHitZone(side) {
    const b = this.ball, p = this.players[side];
    if (!b) return false;
    const dy = (b.y - p.y) * -sign(side); // 球在球員前方多少（朝球網方向為正）
    return dy > -0.8 && dy < 2.2 && Math.abs(b.x - p.x) < 1.8 && b.z < 2.8;
  }

  tryHit(side, s) {
    const b = this.ball;
    if (!b) return false;
    const towardMe = b.inPlay ? Math.sign(b.vy) === sign(side) : false;
    const serving = this.phase === 'serve' && this.server === side;
    if (!serving && !(this.phase === 'rally' && towardMe)) return false;
    if (!this.inHitZone(side)) return false;
    this.hitBall(side, s, serving);
    return true;
  }

  hitBall(side, s, serving) {
    const b = this.ball, p = this.players[side];
    const dir = -sign(side); // 往對方打
    // 時機品質：球離球員理想擊球點 (前方 0.6m) 的誤差
    const dy = (b.y - p.y) * dir;
    const timingErr = clamp((dy - 0.7) / 1.5, -1, 1); // -1 太晚, +1 太早

    // 弧線因子：揮拍平面為主、拍面仰角次之、手腕翻轉再次之。正 = 挑高/撈球，負 = 壓平/殺球
    const arc = clamp(s.plane * 0.6 + s.loft * 0.3, -1, 1); // 旋球的高低改由飛行中的馬格努斯力呈現
    // 左右：拍面角度為主（開拍面往外切），揮動方向為輔
    const lateralIn = clamp(s.face * 0.65 + s.dirX * 0.45, -1.2, 1.2);

    let speed = (serving ? 12 : 11) + s.strength * 10; // 11~21 m/s（慢一點比較看得清楚）
    speed *= 1 - 0.22 * Math.max(0, arc);   // 挑高較慢
    speed *= 1 + 0.12 * Math.max(0, -arc);  // 殺球較快

    // 目標落點深度（距球網），力道越大越深；時機差會打太深（出界）或太淺（掛網）
    // 落點深度：輕揮 = 短球（約 2.5m），全力 = 接近底線（約 10m）；時機與弧線再微調
    let depth = 2.5 + s.strength * 7.5 + timingErr * 1.5 + (arc > 0 ? arc * 1.0 : -arc * 1.2);
    depth = clamp(depth, 1.2, 13.5);
    const targetY = dir * depth;
    // 時機太晚：球會往慣用手反方向偏（dir 修正讓 A/B 對稱）
    // lateralIn 的正值 = 球員自己的右手邊；A 面向 +y 時右邊是 +x，B 面向 -y 時右邊是 -x
    const lateral = lateralIn * dir * (2.5 + s.strength * 1.6) + timingErr * 1.2 * -dir;
    const targetX = clamp(b.x + lateral * 1.2, -HALF_W - 0.9, HALF_W + 0.9);

    // 側旋：側向加速度（以球員右手邊為正）。瞄準點反向補償一半，讓球「彎進來」但仍大致落在目標
    const ax = s.curve * CURVE_ACC * dir;
    const dxT0 = targetX - b.x, dyT0 = targetY - b.y;
    const dist0 = Math.hypot(dxT0, dyT0);
    const shortK = clamp(0.5 + depth * 0.055, 0.5, 1);
    const horiz = Math.max(speed * shortK * (0.75 + 0.25 * (1 - Math.abs(s.spin) * 0.5)), 5.5);
    const tEst = dist0 / horiz;
    const curvedTargetX = clamp(targetX - 0.5 * ax * tEst * tEst * 0.5, -HALF_W - 1.2, HALF_W + 1.2);
    const dxT = curvedTargetX - b.x, dyT = targetY - b.y;
    const dist = Math.hypot(dxT, dyT);
    const t = dist / horiz;
    const vx = dxT / t, vy = dyT / t;
    // 以「有效重力」解拋物線：上旋在空中多一個向下加速度 → 出手要更高、飛行中明顯下墜；
    // 下旋相反 → 出手較平、飛行中飄。落點仍大致在目標
    const gEff = G + s.spin * TOPSPIN_ACC;
    let vz = (0.5 * gEff * t * t - b.z) / t;
    vz += arc > 0 ? arc * 2.4 : arc * 0.9; // 揮拍平面／拍面仰角抬高或壓低弧線
    if (![vx, vy, vz].every(Number.isFinite)) {
      console.error('hitBall produced non-finite velocity', { s, b: { x: b.x, y: b.y, z: b.z }, targetX, targetY });
      this.startServe(this.server);
      return;
    }
    b.vx = vx; b.vy = vy; b.vz = vz;
    b.spin = s.spin;
    b.curve = s.curve;
    b.ax = ax;
    b.lastHitBy = side;
    b.bounces = 0;
    b.bounceSide = null;
    b.inPlay = true;
    this.phase = 'rally';
    this.rallyHits += 1;
    this.pendingSwing.A = null; this.pendingSwing.B = null;
    const q = Math.abs(timingErr) < 0.3 ? 'perfect' : Math.abs(timingErr) < 0.7 ? 'good' : 'late';
    this.event('hit', side, q);
    this.fx('hit', b.x, b.y);
    this.lastShot = { side, strength: round(s.strength, 2), arc: round(arc, 2), lateral: round(lateralIn, 2), spin: round(s.spin, 2), curve: round(s.curve, 2), timing: round(timingErr, 2), t: this.time };
  }

  // ---------- 每幀更新 ----------
  update(dt) {
    this.time += dt;
    for (const side of SIDES) {
      const p = this.players[side];
      if (p.swingAnim > 0) p.swingAnim = Math.max(0, p.swingAnim - dt);
    }
    if (this.phase === 'lobby') return;
    this.updateBots();
    if (this.ball && ![this.ball.x, this.ball.y, this.ball.z, this.ball.vx, this.ball.vy, this.ball.vz].every(Number.isFinite)) {
      console.error('ball state corrupted, restarting serve', this.ball);
      this.startServe(this.server);
      return;
    }

    if (this.phase === 'point' || this.phase === 'gameover') {
      this.phaseTimer -= dt;
      this.autoMove(dt, false);
      this.updateFacing(dt);
      if (this.ball && this.ball.inPlay === false && this.ball.z > 0) {
        // 讓球自然落地
        this.integrateBall(dt, false);
      }
      if (this.phaseTimer <= 0) {
        if (this.phase === 'gameover') this.resetMatch();
        else this.startServe(this.server);
      }
      return;
    }

    const b = this.ball;
    if (this.phase === 'serve') {
      // 球在發球者頭上上下彈跳，並跟著發球者左右移動
      const sp = this.players[this.server];
      b.x = sp.x; b.y = sp.y;
      b.vz -= G * dt;
      b.z += b.vz * dt;
      if (b.z < 1.2) { b.z = 1.2; b.vz = 3.2; }
      this.phaseTimer -= dt;
      const srv = this.server;
      if (this.pendingSwing[srv] && this.time - this.pendingSwing[srv].t < 0.25) {
        this.hitBall(srv, this.pendingSwing[srv], true);
      } else if (this.phaseTimer <= 0) {
        this.hitBall(srv, this.normalizeSwing({ strength: 0.55, dirX: (Math.random() - 0.5) * 0.6 }), true);
        this.event('autoserve', srv, '自動發球');
      }
      this.autoMove(dt);
      this.updateFacing(dt);
      return;
    }

    // rally
    this.integrateBall(dt, true);
    this.autoMove(dt);
    this.updateFacing(dt);
    this.passiveBlock(dt);

    // 揮拍緩衝：球進區時補判定
    for (const side of SIDES) {
      const ps = this.pendingSwing[side];
      if (!ps) continue;
      if (this.time - ps.t > 0.25) { this.pendingSwing[side] = null; continue; }
      if (this.tryHit(side, ps)) break;
    }
  }

  integrateBall(dt, judge) {
    const b = this.ball;
    const prevY = b.y, prevZ = b.z;
    // 馬格努斯效應：上旋往下壓、下旋飄；側旋側向彎。落地後旋轉大幅衰減
    const spinK = b.bounces === 0 ? 1 : 0.3;
    b.vz -= (G + (b.spin || 0) * TOPSPIN_ACC * spinK) * dt;
    b.vx += (b.ax || 0) * spinK * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;

    if (!judge) {
      if (b.z <= 0) { b.z = 0; b.vz = -b.vz * 0.5; b.vx *= 0.7; b.vy *= 0.7; if (Math.abs(b.vz) < 0.5) { b.vz = 0; b.vx = 0; b.vy = 0; } }
      return;
    }

    const hitter = b.lastHitBy;
    const receiver = other(hitter);

    // 過網判定
    if ((prevY < 0 && b.y >= 0) || (prevY > 0 && b.y <= 0)) {
      const frac = (0 - prevY) / (b.y - prevY);
      const zAtNet = prevZ + (b.z - prevZ) * frac;
      if (zAtNet < COURT.netHeight) {
        b.vx *= 0.1; b.vy *= -0.1; b.vz = 0.5;
        b.y = prevY < 0 ? -0.05 : 0.05;
        this.fx('net', b.x, 0);
        this.awardPoint(receiver, '掛網');
        return;
      }
    }

    // 落地
    if (b.z <= 0) {
      b.z = 0;
      const spin = b.spin || 0;
      // 上旋：彈得高、往前竄（速度幾乎不掉）；下旋：彈得低、速度被吃掉（滑行）
      b.vz = Math.min(-b.vz * clamp(0.62 + 0.18 * spin, 0.3, 0.85), 6.5);
      const keep = clamp(0.85 + 0.17 * spin, 0.55, 1.02);
      b.vx *= keep; b.vy *= keep;
      b.spin = spin * 0.5; // 旋轉衰減
      this.fx('bounce', b.x, b.y);
      const landSide = b.y < 0 ? 'A' : 'B';
      const LINE = 0.12; // 壓線算進：球半徑約 0.033 + 線寬 0.05 再寬鬆一點
      const inX = Math.abs(b.x) <= HALF_W + LINE;
      const inY = Math.abs(b.y) <= HALF_L + LINE;
      b.bounces += 1;
      if (b.bounces === 1) {
        b.bounceSide = landSide;
        if (landSide !== receiver || !inX || !inY) {
          this.awardPoint(receiver, '出界');
          return;
        }
      } else if (b.bounces >= 2) {
        // 第二次落地：接球方沒接到
        this.awardPoint(hitter, '未擊回');
        return;
      }
    }

    // 球飛過接球方底線後方太遠 → 沒接到
    const r = this.players[receiver];
    const behind = (b.y - r.y) * sign(receiver);
    if (behind > 2.5 && Math.sign(b.vy) === sign(receiver)) {
      if (b.bounces === 0) this.awardPoint(receiver, '出界');
      else this.awardPoint(hitter, '未擊回');
    }
  }

  // 球員移動：手機姿態有輸入時手動移動；沒有輸入時自動跑向球（輔助）
  autoMove(dt, assist = true) {
    const b = this.ball;
    for (const side of SIDES) {
      const p = this.players[side];
      p._px = p.x; p._py = p.y; p._dt = dt;
      const baseY = sign(side) * (HALF_L + COURT.baselineOffset);
      const serving = this.phase === 'serve' && this.server === side;
      const mv = p.move;
      const manual = MANUAL_MOVE && !this.bot[side] && (mv.x !== 0 || mv.y !== 0) && this.time - mv.t < 0.6;
      if (manual) {
        const spd = 4.5; // 正常速度（輸入 0.5 時為慢走 2.25 m/s）
        // 量化成 8 方向：兩軸都有輸入時取較大的檔位、斜向以 1/√2 正規化，斜走不會比直走快
        let mx = mv.x, my = mv.y;
        if (mx !== 0 && my !== 0) {
          const mag = Math.max(Math.abs(mx), Math.abs(my)) / Math.SQRT2;
          mx = Math.sign(mx) * mag; my = Math.sign(my) * mag;
        }
        // 發球時只能左右移動（選發球位置），不能前後
        if (serving) my = 0;
        // x：以球員自己的右手邊為正（A 面向 +y 右邊是 +x；B 相反）；y：朝球網為正
        const dir = -sign(side);
        p.x = clamp(p.x + mx * dir * spd * dt, -HALF_W - 2.5, HALF_W + 2.5);
        const ny = p.y + my * dir * spd * dt;
        // 限制在自己半場：離網 1.5m 到底線後 3.5m
        const minAbs = 1.5, maxAbs = HALF_L + 3.5;
        p.y = sign(side) * clamp(Math.abs(ny) * (Math.sign(ny) === sign(side) || ny === 0 ? 1 : 0) || minAbs, minAbs, maxAbs);
        continue;
      }
      let targetX = p.x, targetY = p.y;
      if (TRANSLATE_MOVE && !this.bot[side] && p.connected) {
        // 目標 = 基準點（底線中央）+ 手機位移 × 增益；來球最後 0.7 秒再向球靠一半
        const dir = -sign(side);
        const ox = clamp(p.offset.x, -PHONE_RANGE, PHONE_RANGE) / PHONE_RANGE;
        const oy = clamp(p.offset.y, -PHONE_RANGE, PHONE_RANGE) / PHONE_RANGE;
        targetX = ox * COURT_RANGE_X * dir;
        targetY = serving ? p.y : baseY + oy * COURT_RANGE_Y * dir;
        if (assist && b && !serving) {
          const towardMe = Math.sign(b.vy) === sign(side) && Math.abs(b.vy) > 0.01;
          if (towardMe) {
            const tArr = Math.max(0, (p.y - b.y) / b.vy);
            if (tArr < 0.7) {
              const bx = clamp(b.x + b.vx * tArr - 0.6 * dir, -HALF_W - 1.5, HALF_W + 1.5);
              targetX += (bx - targetX) * ASSIST_BLEND;
            }
          }
        }
        targetX = clamp(targetX, -HALF_W - 2.5, HALF_W + 2.5);
        const ay = Math.abs(targetY);
        targetY = sign(side) * clamp(ay, 1.5, HALF_L + 3.5);
        const dx = targetX - p.x, dy = targetY - p.y, d = Math.hypot(dx, dy);
        const step = TRANSLATE_SPEED * dt;
        if (d <= step) { p.x = targetX; p.y = targetY; }
        else { p.x += dx / d * step; p.y += dy / d * step; }
        continue;
      }
      if (serving || !assist) continue;
      targetX = 0; targetY = baseY;
      if (b) {
        const towardMe = Math.sign(b.vy) === sign(side) && Math.abs(b.vy) > 0.01;
        if (towardMe) {
          const t = Math.max(0, (p.y - b.y) / b.vy);
          // 讓「拍頭」對準來球，而不是身體中心：拍頭在身體右前方約 0.6m
          const dir = -sign(side);
          targetX = clamp(b.x + b.vx * t - 0.6 * dir, -HALF_W - 1.5, HALF_W + 1.5);
          const land = predictLanding(b);
          if (land && Math.abs(land.y) < HALF_L - 3) {
            targetY = sign(side) * clamp(Math.abs(land.y) + 1.2, 3.5, HALF_L + COURT.baselineOffset);
          }
        } else if (!this.bot[side] && MANUAL_MOVE) {
          // 手動模式：對手回球前留在原地
          targetX = Math.abs(p.x) > HALF_W + 1.5 ? Math.sign(p.x) * (HALF_W + 1.5) : p.x;
          targetY = p.y;
        }
      }
      const dx = targetX - p.x, dy = targetY - p.y;
      const d = Math.hypot(dx, dy);
      const step = p.speed * dt;
      if (d <= step) { p.x = targetX; p.y = targetY; }
      else { p.x += dx / d * step; p.y += dy / d * step; }
    }
  }

  // 更新 8 方向面向：移動中 = 位移方向；停下 0.4 秒後回到面向球網
  updateFacing(dt) {
    for (const side of SIDES) {
      const p = this.players[side];
      const spd = this.playerSpeed(p);
      if (spd > 0.4) {
        const dir = -sign(side); // 玩家座標：右 = dir * x，前 = dir * y
        const rx = (p.x - p._px) * dir, fy = (p.y - p._py) * dir;
        const ang = Math.atan2(rx, fy); // 0 = 前，順時針為正
        p.facing = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
        p.facingHold = 0.4;
      } else if (p.facingHold > 0) {
        p.facingHold -= dt;
        if (p.facingHold <= 0) p.facing = 0;
      }
    }
  }

  // 這一幀的移動速度（m/s），給顯示端做走路動畫
  playerSpeed(p) {
    if (!p._dt) return 0;
    return Math.hypot(p.x - (p._px ?? p.x), p.y - (p._py ?? p.y)) / p._dt;
  }

  // ---------- 序列化 ----------
  snapshot() {
    return {
      phase: this.phase,
      time: round(this.time, 2),
      server: this.server,
      court: COURT,
      ball: this.ball ? {
        x: round(this.ball.x), y: round(this.ball.y), z: round(this.ball.z),
        vx: round(this.ball.vx), vy: round(this.ball.vy), vz: round(this.ball.vz),
        lastHitBy: this.ball.lastHitBy, bounces: this.ball.bounces,
        spin: round(this.ball.spin || 0, 2), curve: round(this.ball.curve || 0, 2),
      } : null,
      players: {
        A: this.playerSnap('A'),
        B: this.playerSnap('B'),
      },
      score: {
        games: this.score.games,
        points: { A: this.pointLabel('A'), B: this.pointLabel('B') },
      },
      rallyHits: this.rallyHits,
      lastEvent: this.lastEvent,
      lastFx: this.lastFx,
      lastShot: this.lastShot,
    };
  }

  playerSnap(side) {
    const p = this.players[side];
    const manual = (p.move.x !== 0 || p.move.y !== 0) && this.time - p.move.t < 0.6;
    const head = p.head ? [round(p.head.r, 2), round(p.head.f, 2), round(p.head.u, 2)] : null;
    const swing = p.lastSwing ? [round(p.lastSwing.plane, 2), round(p.lastSwing.dirX, 2)] : null;
    return { connected: p.connected, bot: this.bot[side], name: p.name, x: round(p.x), y: round(p.y), swingAnim: round(p.swingAnim), manual, head, swing, spd: round(this.playerSpeed(p), 2), facing: p.facing };
  }
}

function predictLanding(b) {
  // 解 z + vz t - 0.5 g t^2 = 0
  const a = -0.5 * G, bb = b.vz, c = b.z;
  const disc = bb * bb - 4 * a * c;
  if (disc < 0) return null;
  const t = (-bb - Math.sqrt(disc)) / (2 * a);
  if (!(t > 0)) return null;
  return { x: b.x + b.vx * t, y: b.y + b.vy * t, t };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round(v, d = 3) { const m = 10 ** d; return Math.round(v * m) / m; }
