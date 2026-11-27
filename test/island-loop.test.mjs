// 《島口大開》無頭模擬測試：用腳本玩家跑完整循環
//   引怪咬彈簧磚 → 側邊敲飛到斷橋 → 踩彈簧磚彈上鐘樓 → 敲鐘 → 打核心 → 勝利
// 單人與雙人各跑一次，另外驗證落空（磚掉海裡）後彈簧磚會長回來、掉島會復活。
// 執行：node test/island-loop.test.mjs
import assert from 'node:assert/strict';
import { IslandGame, cellX, cellZ, S } from '../server/island.js';

const DT = 1 / 60;
function step(g, seconds, fn) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) { fn?.(i * DT); g.update(DT); }
}
// 讓玩家走向目標點；到達回傳 true
function walkTo(g, side, x, z, maxSec = 8, tol = 0.15) {
  const p = g.players[side];
  let t = 0;
  while (t < maxSec) {
    const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
    if (d < tol) { g.setMove(side, 0, 0); g.update(DT); return true; }
    const k = Math.min(1, d / 0.6);
    g.setMove(side, dx / d * k, dz / d * k);
    g.update(DT); t += DT;
  }
  g.setMove(side, 0, 0);
  return false;
}
function waitFor(g, pred, maxSec, fn) {
  let t = 0;
  while (t < maxSec) { if (pred()) return true; fn?.(); g.update(DT); t += DT; }
  return pred();
}
const spring = (g) => [...g.tiles.values()].find((t) => t.kind === 'spring');
const springPlat = (g) => [...g.platforms.values()].find((p) => p.kind === 'spring');

function runLoop({ two }) {
  const g = new IslandGame();
  g.setConnected('A', true, 'kb', true);
  if (two) g.setConnected('B', true, 'kb', true);
  g.action('A', 'hit'); // 開始
  step(g, 0.1);
  assert.equal(g.phase, 'countdown');
  step(g, 3.2);
  assert.equal(g.phase, 'play');
  const lure = 'A', hitter = two ? 'B' : 'A';

  // ---- 1. 引怪：被盯上的人站上彈簧磚，鎖定後跳開
  const sp = spring(g); assert.ok(sp, '應有彈簧磚');
  const sx = cellX(sp.c), sz = cellZ(sp.r);
  // 等到巨怪盯上 lure（第一次一定是 A，因為 lastTarget 初始為 B）
  assert.ok(waitFor(g, () => g.boss.state === 'aim' && g.boss.target === lure, 6), '巨怪應盯上 A');
  assert.ok(walkTo(g, lure, sx, sz, 4), '應走到彈簧磚上');
  // 搭檔先到彈簧磚西邊兩格待命（側邊）
  if (two) walkTo(g, hitter, sx - 2 * S, sz, 4);
  assert.ok(waitFor(g, () => g.boss.state === 'lock', 4), '應進入鎖定');
  assert.deepEqual(g.boss.locked, [sp.c, sp.r], '應鎖定彈簧磚');
  // 跳開：往南一格
  walkTo(g, lure, sx, sz + S, 1.5);
  assert.ok(waitFor(g, () => g.boss.state === 'stuck', 3), '巨怪應咬住並卡住');
  assert.equal(g.boss.held.kind, 'spring');
  assert.ok(!g.players[lure].dead, '跳開的人不該掉下去');

  // ---- 2. 側邊敲擊：站在嘴的西邊，磚往東飛到斷橋
  const m = g.mouthPos();
  assert.ok(walkTo(g, hitter, m.x - 1.3, m.z, 3, 0.2), '敲擊手應走到巨怪側邊');
  const pred = g.predictLanding(g.players[hitter]);
  assert.ok(pred.inZone, `落點應在斷橋區，得到 ${JSON.stringify(pred)}`);
  g.action(hitter, 'hit'); g.update(DT);
  assert.ok(g.flight, '磚應飛出');
  assert.equal(g.boss.state, 'recoil');
  assert.ok(waitFor(g, () => springPlat(g), 2), '彈簧磚應落地成平台');
  const plat = springPlat(g);
  assert.ok(g.bridge.some(([c, r]) => c === plat.c && r === plat.r), '彈簧平台應在斷橋區');

  // ---- 3. 踩彈簧磚彈上鐘樓
  const jumper = hitter;
  const px = cellX(plat.c), pz = cellZ(plat.r);
  // 繞過被咬掉的洞：先往南一排，再往東到島緣，再踏上彈簧平台
  assert.ok(walkTo(g, jumper, sx - S, sz + S, 4), '繞路 1');
  assert.ok(walkTo(g, jumper, px - S, sz + S, 6), '繞路 2');
  assert.ok(walkTo(g, jumper, px - S, pz, 4), '繞路 3');
  assert.ok(walkTo(g, jumper, px, pz, 3, 0.3), '應走到彈簧平台');
  // 空中朝鐘樓傾斜
  const tw = g.snapshot().tower;
  assert.ok(waitFor(g, () => g.players[jumper].onTower, 4, () => {
    const p = g.players[jumper];
    const dx = tw.x - p.x, dz = tw.z - p.z, d = Math.hypot(dx, dz) || 1;
    g.setMove(jumper, p.grounded ? 0 : dx / d, p.grounded ? 0 : dz / d);
  }), '應彈上鐘樓平台');
  g.setMove(jumper, 0, 0);

  // ---- 4. 敲鐘 → 防護打開
  g.action(jumper, 'hit'); g.update(DT);
  assert.ok(g.bellRungOnce, '鐘應敲響');
  assert.ok(waitFor(g, () => g.boss.state === 'open', 3), '防護應打開');
  assert.ok(g.snapshot().pads.length === 2, '能力區應出現');

  // ---- 5. 打核心
  const core = g.corePos();
  const attackers = two ? ['A'] : ['A'];
  // 單人：從鐘樓跳下來跑去核心（會掉島 → 復活在安全磚 → 再跑）
  for (const a of attackers) {
    const p = g.players[a];
    if (p.onTower) { walkTo(g, a, tw.x - 2.5, tw.z, 2); waitFor(g, () => !p.dead && p.grounded && p.y < 0.2, 6); }
    assert.ok(walkTo(g, a, core.x, core.z + 1.0, 8, 0.25), '應跑到核心前');
  }
  let hits = 0;
  assert.ok(waitFor(g, () => g.boss.hp === 0 || g.boss.state !== 'open', 20, () => {
    for (const a of attackers) { if (g.now >= g.players[a].hitCd) { g.action(a, 'hit'); hits++; } }
  }), '應持續打核心');
  assert.equal(g.boss.hp, 0, `核心應被打到 0（敲了 ${hits} 次）`);
  assert.equal(g.phase, 'win');
  return g;
}

// ---- 落空重來：敲飛的磚掉進海裡 → 彈簧磚長回 → 可以再引
function runMissAndRetry() {
  const g = new IslandGame();
  g.setConnected('A', true, 'kb', true);
  g.action('A', 'hit'); step(g, 3.3);
  const sp = spring(g); const sx = cellX(sp.c), sz = cellZ(sp.r);
  waitFor(g, () => g.boss.state === 'aim', 6);
  walkTo(g, 'A', sx, sz, 4);
  waitFor(g, () => g.boss.state === 'lock', 4);
  walkTo(g, 'A', sx, sz + S, 1.5);
  waitFor(g, () => g.boss.state === 'stuck', 3);
  // 從南邊敲：磚往北飛出島外（掉海）
  const m = g.mouthPos();
  walkTo(g, 'A', m.x, m.z + 1.3, 3, 0.2);
  const pred = g.predictLanding(g.players.A);
  assert.ok(!pred.ok, `從南邊敲應掉海裡，得到 ${JSON.stringify(pred)}`);
  g.action('A', 'hit'); g.update(DT);
  assert.ok(waitFor(g, () => !g.flight, 2));
  assert.ok(!springPlat(g) && !spring(g), '彈簧磚應暫時消失');
  assert.ok(g.regrow.some((r) => r.kind === 'spring'), '應排程長回');
  assert.ok(waitFor(g, () => spring(g), 10), '彈簧磚應長回原位');
  // 掉島復活
  walkTo(g, 'A', cellX(-1), cellZ(3), 6);
  assert.ok(waitFor(g, () => g.players.A.dead, 3), '走出島外應掉落');
  assert.ok(waitFor(g, () => !g.players.A.dead, 3), '應復活');
  assert.ok(g.surfacesAt(g.players.A.x, g.players.A.z).length > 0, '復活點應有地磚');
}

// ---- 吞掉：錯過卡住窗口 → 磚被吞 → 長回
function runSwallow() {
  const g = new IslandGame();
  g.setConnected('A', true, 'kb', true);
  g.action('A', 'hit'); step(g, 3.3);
  const sp = spring(g); const sx = cellX(sp.c), sz = cellZ(sp.r);
  waitFor(g, () => g.boss.state === 'aim', 6);
  walkTo(g, 'A', sx, sz, 4);
  waitFor(g, () => g.boss.state === 'lock', 4);
  walkTo(g, 'A', sx - 2 * S, sz, 2);
  waitFor(g, () => g.boss.state === 'stuck', 3);
  assert.ok(waitFor(g, () => g.boss.state === 'recoil', 8), '沒人敲應吞掉後退回');
  assert.equal(g.lastEvent.type, 'swallow');
  assert.ok(waitFor(g, () => spring(g), 12), '吞掉的彈簧磚應長回');
}

// ---- 能力分流：鐘響後走上能力區取得能力
function runAbilities() {
  const g = runLoop({ two: true });
  // 勝利後重開，直接驗證能力區邏輯：把 bellRungOnce 設為 true 模擬鐘響後
  const g2 = new IslandGame();
  g2.setConnected('A', true, 'kb', true); g2.setConnected('B', true, 'kb', true);
  g2.action('A', 'hit'); step(g2, 3.3);
  g2.bellRungOnce = true;
  const boots = g2.pads.find((p) => p.kind === 'boots'), hammer = g2.pads.find((p) => p.kind === 'hammer');
  walkTo(g2, 'A', cellX(boots.c), cellZ(boots.r), 6);
  walkTo(g2, 'B', cellX(hammer.c), cellZ(hammer.r), 6);
  step(g2, 1.3);
  assert.equal(g2.players.A.ability, 'boots');
  assert.equal(g2.players.B.ability, 'hammer');
  assert.ok(g2.hitRange(g2.players.B) > g2.hitRange(g2.players.A), '回音槌距離應較長');
  // 兩人可選同一能力
  walkTo(g2, 'A', cellX(hammer.c), cellZ(hammer.r) + 0.2, 6);
  step(g2, 1.3);
  assert.equal(g2.players.A.ability, 'hammer');
  void g;
}

// ---- 真人 + 電腦搭檔：真人只負責引怪與打核心，其餘交給電腦
function runWithBot() {
  const g = new IslandGame();
  g.setConnected('A', true, 'kb', true);
  g.setBot('B', true);
  assert.equal(g.playerCount(), 2); assert.equal(g.humanCount(), 1);
  g.action('A', 'hit'); step(g, 3.3);
  assert.equal(g.phase, 'play');
  const sp = spring(g); const sx = cellX(sp.c), sz = cellZ(sp.r);
  // 第一輪：巨怪先盯 A（真人）
  assert.ok(waitFor(g, () => g.boss.state === 'aim' && g.boss.target === 'A', 6));
  assert.ok(walkTo(g, 'A', sx, sz, 4));
  assert.ok(waitFor(g, () => g.boss.state === 'lock', 4));
  walkTo(g, 'A', sx, sz + S, 1.5);
  assert.ok(waitFor(g, () => g.boss.state === 'stuck', 3));
  // 電腦應自己走到側邊把彈簧磚敲進斷橋區
  assert.ok(waitFor(g, () => springPlat(g), 8), '電腦應在窗口內敲飛彈簧磚');
  const plat = springPlat(g);
  assert.ok(g.bridge.some(([c, r]) => c === plat.c && r === plat.r), '電腦敲的落點應在斷橋區');
  // 真人跑去核心前等；電腦應去彈、敲鐘
  const core = g.corePos();
  walkTo(g, 'A', core.x, core.z + 1.0, 10, 0.25);
  assert.ok(waitFor(g, () => g.boss.state === 'open', 25, () => { const p = g.players.A; if (Math.hypot(p.x - core.x, p.z - core.z - 1) > 0.5) { const dx = core.x - p.x, dz = core.z + 1 - p.z, d = Math.hypot(dx, dz); g.setMove('A', dx / d, dz / d); } else g.setMove('A', 0, 0); }), '電腦應彈上鐘樓敲鐘');
  g.setMove('A', 0, 0);
  // 真人 + 電腦一起打核心
  assert.ok(waitFor(g, () => g.boss.hp === 0 || g.boss.state !== 'open', 20, () => { if (g.now >= g.players.A.hitCd) g.action('A', 'hit'); }));
  assert.equal(g.boss.hp, 0, '應打掉核心');
  assert.equal(g.phase, 'win');
}
// ---- 電腦自己也能被盯、自己引怪跳開而不掉島
function runBotLured() {
  const g = new IslandGame();
  g.setConnected('A', true, 'kb', true);
  g.setBot('B', true);
  g.action('A', 'hit'); step(g, 3.3);
  // 真人躲遠一點、什麼都不做；第一次盯 A，A 不站磚 → 咬 A 腳下的磚；第二次盯 B（電腦）
  walkTo(g, 'A', cellX(2), cellZ(1), 5);
  assert.ok(waitFor(g, () => g.boss.target === 'B' && g.boss.state === 'aim', 40), '巨怪應輪到盯電腦');
  assert.ok(waitFor(g, () => g.boss.state === 'stuck' || g.boss.state === 'recoil', 10));
  assert.ok(!g.players.B.dead, '電腦引怪後不該掉下島');
  // 真人全程沒掉島（站在遠處）
  assert.ok(!g.players.A.dead);
}

const t0 = Date.now();
runLoop({ two: false }); console.log('✓ 單人完整循環');
runLoop({ two: true }); console.log('✓ 雙人完整循環');
runMissAndRetry(); console.log('✓ 落空 → 彈簧磚長回 → 掉島復活');
runSwallow(); console.log('✓ 錯過窗口 → 吞掉 → 長回');
runAbilities(); console.log('✓ 能力區分流');
runWithBot(); console.log('✓ 真人 + 電腦搭檔完整循環');
runBotLured(); console.log('✓ 電腦被盯上會自己引怪跳開');
console.log(`全部通過（${Date.now() - t0} ms）`);
