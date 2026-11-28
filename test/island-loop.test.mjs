// 《島口大開》無頭模擬測試：腳本玩家跑完整一局
//   兩人擊倒同一波怪 → 共用計數達標 → 兩人各選不同技能 → 同進 Boss 房 → 打完這局（勝利）
//   另外驗證：單人縮減規模與門檻、倒地救援、四人加入。
// 執行：node test/island-loop.test.mjs
import assert from 'node:assert/strict';
import { IslandGame, cellX, cellZ, SIDES, KILL_THRESHOLDS } from '../server/island.js';

const DT = 1 / 60;
function step(g, seconds, fn) { const n = Math.round(seconds / DT); for (let i = 0; i < n; i++) { fn?.(); g.update(DT); } }

// 簡單的腳本玩家：追最近的敵人、避開咬痕與衝撞線、救隊友、露核心時衝核心
function botStep(g, side, pickSkill) {
  const p = g.players[side];
  if (!p.connected) return;
  if (g.phase === 'upgrade') {
    // 選技能：把游標移到想要的技能，再回正停住
    const ids = Object.keys(g.snapshot().skills);
    const want = ids.indexOf(pickSkill);
    if (p.upgradeDone) { g.setMove(side, 0, 0); return; }
    if (p.upgradeCursor !== want) g.setMove(side, p.upgradeCursor < want ? 1 : -1, 0); else g.setMove(side, 0, 0);
    return;
  }
  if (p.downed) return;
  let tx = null, tz = null;
  // 1. 隊友倒地 → 去救
  for (const s of SIDES) { const q = g.players[s]; if (q !== p && q.connected && q.downed) { tx = q.x; tz = q.z; } }
  // 2. Boss 露核心 → 衝核心前
  if (tx == null && g.boss && g.boss.state === 'exposed') { const c = g.coreFront(); tx = c.x; tz = c.z; }
  // 3. 追最近的敵人（遠程怪優先一點點）
  if (tx == null) {
    let best = null, bd = Infinity;
    for (const e of g.enemies) { if (e.dead) continue; const d = Math.hypot(e.x - p.x, e.z - p.z) * (e.kind === 'ranged' ? 0.8 : 1); if (d < bd) { bd = d; best = e; } }
    if (best) { tx = best.x; tz = best.z; }
  }
  // 避開：Boss 咬痕 / 鎖定範圍
  if (g.boss && (g.boss.state === 'aim' || g.boss.state === 'lock' || g.boss.state === 'lunge')) {
    const cells = g.boss.locked || g.boss.cands;
    const c = Math.round(p.x / 1.5 + 5), r = Math.round(p.z / 1.5 + 4);
    if (cells.some(([cc, rr]) => cc === c && rr === r)) { tx = p.x; tz = p.z + 3.5; }
  }
  // 避開：精英衝撞線
  for (const e of g.enemies) {
    if (e.dead || e.kind !== 'elite' || e.state !== 'windup') continue;
    const rx = p.x - e.x, rz = p.z - e.z, along = rx * e.dir.x + rz * e.dir.z, side2 = -rx * e.dir.z + rz * e.dir.x;
    if (along > -0.5 && along < 8 && Math.abs(side2) < 1.3) { tx = p.x - e.dir.z * 3 * Math.sign(side2 || 1); tz = p.z + e.dir.x * 3 * Math.sign(side2 || 1); }
  }
  if (tx == null) { g.setMove(side, 0, 0); return; }
  const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
  if (d < 0.9) { g.setMove(side, 0, 0); return; }
  // 繞開洞：前方 0.7 沒有磚就改走左右，都沒有就停（真人看得到洞，腳本玩家也要）
  let ux = dx / d, uz = dz / d;
  const ok = (vx, vz) => g.surfaceAt(p.x + vx * 0.7, p.z + vz * 0.7) != null && g.surfaceAt(p.x + vx * 1.2, p.z + vz * 1.2) != null;
  if (!ok(ux, uz)) {
    const cands = [[-uz, ux], [uz, -ux], [(ux - uz) * 0.707, (uz + ux) * 0.707], [(ux + uz) * 0.707, (uz - ux) * 0.707]];
    const alt = cands.find(([vx, vz]) => ok(vx, vz));
    if (!alt) { g.setMove(side, 0, 0); return; }
    [ux, uz] = alt;
  }
  g.setMove(side, ux, uz);
}

function runCoop() {
  const g = new IslandGame();
  g.setConnected('A', true, 'kb', true); g.setConnected('B', true, 'kb', true);
  g.action('A', 'hit'); step(g, 3.3);
  assert.equal(g.phase, 'wave');
  const picks = { A: 'quake', B: 'chain' };
  const seen = { upgrade: 0, boss: false, exposed: false, down: false, revive: false };
  let t = 0;
  while (g.phase !== 'win' && g.phase !== 'lose' && t < 900) {
    for (const s of ['A', 'B']) botStep(g, s, picks[s]);
    g.update(DT); t += DT;
    if (g.phase === 'upgrade' && g.upgrade && seen.upgrade < g.upgrade.index) seen.upgrade = g.upgrade.index;
    if (g.phase === 'boss') seen.boss = true;
    if (g.boss && g.boss.state === 'exposed') seen.exposed = true;
    if (g.players.A.downed || g.players.B.downed) seen.down = true;
    if (g.stats.revives) seen.revive = true;
  }
  const s = g.snapshot();
  console.log(`   結果 ${g.phase}，用時 ${Math.round(g.elapsed())} 秒，擊倒 ${g.kills}，升級 ${g.upgradesDone} 次，倒地 ${g.stats.downs} 救援 ${g.stats.revives}，技能 A=${JSON.stringify(g.players.A.skills)} B=${JSON.stringify(g.players.B.skills)}`);
  assert.equal(g.phase, 'win', '兩人應能打完這局');
  assert.ok(g.kills >= s.thresholds[0], '共用計數應達第一門檻');
  assert.ok(seen.upgrade >= 1, '應至少升級一次');
  assert.ok(g.players.A.skills.quake >= 1 && g.players.B.skills.chain >= 1, '兩人應各選到不同技能');
  assert.ok(seen.boss && seen.exposed, '應進 Boss 房並看到核心露出');
  assert.ok(g.elapsed() < 900, '一局應在 15 分鐘內');
  return g;
}

function runSoloScale() {
  const g = new IslandGame();
  g.setConnected('A', true, 'kb', true);
  const th1 = g.thresholds();
  g.setConnected('B', true, 'kb', true);
  const th2 = g.thresholds();
  assert.ok(th1[0] < th2[0] && th1[2] < th2[2], `單人門檻應較低：${th1} vs ${th2}`);
  assert.deepEqual(th2, KILL_THRESHOLDS, '兩人為基準門檻 8/20/36');
  g.setConnected('B', false);
  g.action('A', 'hit'); step(g, 3.3);
  step(g, 2.2); // 第一波生成
  const solo = g.enemies.length + g.spawning.length;
  assert.ok(solo >= 1 && solo < 4, `單人第一波敵人應比兩人少：${solo}`);
  // 單人倒地會自己爬起
  const p = g.players.A; p.invulnUntil = 0; g.hurt(p, 99, p.x, p.z);
  assert.ok(p.downed);
  step(g, 5.2);
  assert.ok(!p.downed && g.phase !== 'lose', '單人倒地 5 秒後應自己爬起');
}

function runRevive() {
  const g = new IslandGame();
  g.setConnected('A', true, 'kb', true); g.setConnected('B', true, 'kb', true);
  g.action('A', 'hit'); step(g, 3.3);
  const a = g.players.A, b = g.players.B;
  a.invulnUntil = 0; g.hurt(a, 99, a.x, a.z);
  assert.ok(a.downed);
  // B 走到 A 旁邊停住
  b.x = a.x + 0.6; b.z = a.z;
  step(g, 2.3, () => g.setMove('B', 0, 0));
  assert.ok(!a.downed, '隊友靠近 2 秒應救起');
  assert.equal(g.stats.revives, 1);
  // 護友：更快且有護盾
  b.skills.guard = 1; a.invulnUntil = 0; g.hurt(a, 99, a.x, a.z); assert.ok(a.downed);
  step(g, 1.2);
  assert.ok(!a.downed, '護友應 1 秒內救起');
  assert.ok(a.shield >= 1 && b.shield >= 1, '救起後兩人都有護盾');
  // 兩人都倒 → 失敗（先拿掉護盾與無敵）
  a.invulnUntil = 0; b.invulnUntil = 0; a.shield = 0; b.shield = 0; g.hurt(a, 99, 0, 0); g.hurt(b, 99, 0, 0); g.update(DT);
  assert.equal(g.phase, 'lose');
}

function runFourPlayers() {
  const g = new IslandGame();
  for (const s of SIDES) g.setConnected(s, true, 'kb', true);
  assert.equal(g.playerCount(), 4);
  g.action('C', 'hit'); step(g, 3.3);
  assert.equal(g.phase, 'wave');
  step(g, 2.5);
  const n4 = g.enemies.length + g.spawning.length;
  assert.ok(n4 >= 6, `四人第一波應更多敵人：${n4}`);
  const xs = SIDES.map((s) => g.players[s].x);
  assert.ok(new Set(xs.map((x) => x.toFixed(1))).size === 4, '四人出生位置應錯開');
}

const t0 = Date.now();
// 腳本玩家不會閃投射物，偶爾會輸；允許重試，連輸三次才算失敗
let coopOk = false, lastErr = null;
for (let i = 0; i < 3 && !coopOk; i++) { try { runCoop(); coopOk = true; } catch (e) { lastErr = e; console.log(`   （第 ${i + 1} 次未過關：${e.message.split('\n')[0]}）`); } }
if (!coopOk) throw lastErr;
console.log('✓ 兩人完整一局：共用計數 → 各選技能 → Boss 房 → 勝利');
runSoloScale(); console.log('✓ 單人：門檻與敵人數量縮減、倒地自己爬起');
runRevive(); console.log('✓ 倒地救援 / 護友 / 全員倒地失敗');
runFourPlayers(); console.log('✓ 四人加入與規模');
console.log(`全部通過（${Date.now() - t0} ms）`);
