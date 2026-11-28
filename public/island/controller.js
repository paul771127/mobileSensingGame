// 《島口大開》手機控制器：配對 → 持握校正 → 傾斜走位 / 上抬跳躍 / 前推敲擊。
// 配對完成後玩家只看電腦螢幕，手機畫面只留狀態與備援按鈕。
import { connect, qs } from '/common.js';

const $ = (id) => document.getElementById(id);
const joinScreen = $('join'), playScreen = $('play'), calibScreen = $('calibScreen');
const show = (sec) => { for (const x of [joinScreen, calibScreen, playScreen]) x.classList.toggle('on', x === sec); };

let room = (qs('room') || '').toUpperCase();
let side = qs('side') || null;
let mySide = null;
let joined = false;
let motionOK = false;
let vibrate = true;
let flipY = false, flipX = false;
let sensIdx = 1;
// 手勢門檻（去重力加速度 m/s²）
const SENS = [{ label: '低', th: 9.5 }, { label: '中', th: 7.5 }, { label: '高', th: 5.8 }];
let cid = null;
try { cid = localStorage.getItem('cid'); if (!cid) { cid = Math.random().toString(36).slice(2, 12); localStorage.setItem('cid', cid); } } catch { cid = Math.random().toString(36).slice(2, 12); }

$('room').value = room;
if (side) $('sideSel').querySelector(`[data-side="${side}"]`)?.classList.add('on');
$('sideSel').querySelectorAll('button').forEach((b) => {
  b.onclick = () => { side = b.dataset.side; $('sideSel').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
});

// ---------- 連線 ----------
const ws = connect(onMessage, () => {
  $('conn').textContent = '已連線';
  if (joined) sendJoin();
});
function sendJoin() { ws.send({ type: 'join', role: 'controller', game: 'island', room, side: mySide || side, name: $('name').value, cid }); }

let lastState = null;
function onMessage(msg) {
  if (msg.type === 'joined') {
    mySide = msg.side; room = msg.room; joined = true;
    show(playScreen);
    document.body.className = `side-${mySide}`;
    $('badge').textContent = mySide === 'A' ? '藍' : '橘';
    $('roomLabel').innerHTML = `房號 <b>${room}</b>`;
    const u = new URL(location.href); u.searchParams.set('room', room); u.searchParams.set('side', mySide); history.replaceState(null, '', u);
    requestWakeLock();
  } else if (msg.type === 'error') {
    $('joinMsg').textContent = msg.text;
    show(joinScreen);
    joined = false;
  } else if (msg.type === 'state') {
    lastState = msg.state; renderState(msg.state);
  }
}

function renderState(s) {
  if (!mySide || gestFlashing) return;
  const me = s.players?.[mySide];
  let sub = '';
  const other = s.players?.[mySide === 'A' ? 'B' : 'A'];
  const showBot = s.phase === 'lobby' && other && (!other.connected || other.bot);
  $('botBtn').style.display = showBot ? '' : 'none';
  $('botBtn').textContent = other?.bot ? '🤖 電腦搭檔已上場（再按一次移除）' : '🤖 只有一個人？讓電腦當搭檔';
  if (s.phase === 'lobby') sub = s.bots ? '電腦搭檔就位，向前短推開始' : '向前短推（敲擊）開始遊戲';
  else if (s.phase === 'countdown') sub = '準備…';
  else if (s.phase === 'win' || s.phase === 'lose') sub = '向前短推再來一局';
  else if (me?.dead) sub = `掉下去了，${me.respawnIn.toFixed(1)} 秒後復活`;
  else if (s.marks?.target === mySide) sub = '巨怪盯上你了：站上想讓它咬的磚，鎖定後跳開';
  else if (s.boss?.state === 'stuck') sub = '巨怪卡住了！從側邊敲它';
  else if (s.boss?.state === 'open') sub = '防護打開！打核心';
  $('sub').textContent = sub;
}

// ---------- 加入 / 校正 ----------
$('go').onclick = async () => {
  room = $('room').value.trim().toUpperCase();
  if (room.length !== 4) { $('joinMsg').textContent = '房號是 4 個字'; return; }
  $('joinMsg').textContent = '';
  await enableMotion();
  startCalibration();
};
let calibTimer = null;
function startCalibration() {
  show(calibScreen);
  $('calibDone').disabled = true;
  $('calibLive').textContent = '等待姿態感測器…';
  const t0 = performance.now();
  clearInterval(calibTimer);
  calibTimer = setInterval(() => {
    if (orient) {
      $('calibDone').disabled = false;
      const d = pitchDeg - NEUTRAL_PITCH;
      const where = Math.abs(d) < DEAD ? '剛好是不動姿勢 ✓' : d > 0 ? `再往前壓 ${Math.round(d)}° 就是不動姿勢` : `再往後抬 ${Math.round(-d)}° 就是不動姿勢`;
      $('calibLive').textContent = `目前仰角 ${pitchDeg.toFixed(0)}°（不動 = ${NEUTRAL_PITCH}°）：${where}`;
    } else if (performance.now() - t0 > 2500) {
      $('calibDone').disabled = false;
      $('calibLive').textContent = '沒有收到姿態資料：將只能用下方按鈕操作。';
    }
  }, 150);
}
$('calibDone').onclick = () => {
  clearInterval(calibTimer);
  resetBase(); // 預設不動 = 往前傾 45°，不用校正時的角度
  joined = true;
  sendJoin();
};
$('calib').onclick = () => { captureBase(); flashGesture(`已重新校正：不動 = 仰角 ${basePitch.toFixed(0)}°`, 'hit'); };
$('leave').onclick = () => { joined = false; mySide = null; ws.send({ type: 'leave' }); location.href = '/island/controller'; };

async function enableMotion() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') $('joinMsg').textContent = '沒有取得動作感測器權限，仍可用按鈕操作。';
    }
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      await DeviceOrientationEvent.requestPermission().catch(() => {});
    }
  } catch (e) { console.warn(e); }
  if (!motionOK) {
    window.addEventListener('devicemotion', onMotion, { passive: true });
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
    motionOK = true;
  }
  if (!window.isSecureContext) $('joinMsg').textContent = '非 HTTPS 連線：iPhone 將無法使用感測器。';
}

// ---------- 姿態（傾斜走位） ----------
const DEG = Math.PI / 180;
let orient = null;
let pitchDeg = 0, rollDeg = 0;         // 手機長軸仰角、右側抬高角
const NEUTRAL_PITCH = 45;              // 預設「不動」姿勢：手機往前傾 45°（平放 0°、直立 90°）
let basePitch = NEUTRAL_PITCH, baseRoll = 0;
let moveX = 0, moveY = 0;
const DEAD = 6, FULL = 24;             // 死區與全速角度
// 重新校正手勢：快速抬過 90° 再放回，放回停住的角度 = 新的不動姿勢
const RECAL_UP = 92, RECAL_UP_MS = 120, RECAL_BACK = 85, RECAL_SETTLE_MS = 400, RECAL_SETTLE_DEG = 4, RECAL_TIMEOUT = 4000;
const recal = { state: 'idle', since: 0, hist: [], doneAt: -9999 };

function rotMatrix(alpha, beta, gamma) {
  const cX = Math.cos(beta * DEG), sX = Math.sin(beta * DEG);
  const cY = Math.cos(gamma * DEG), sY = Math.sin(gamma * DEG);
  const cZ = Math.cos(alpha * DEG), sZ = Math.sin(alpha * DEG);
  return {
    m11: cZ * cY - sZ * sX * sY, m12: -cX * sZ, m13: cY * sZ * sX + cZ * sY,
    m21: cY * sZ + cZ * sX * sY, m22: cZ * cX, m23: sZ * sY - cZ * cY * sX,
    m31: -cX * sY, m32: sX, m33: cX * cY,
  };
}
function onOrientation(e) {
  if (e.alpha == null || e.beta == null || e.gamma == null) return;
  const m = rotMatrix(e.alpha, e.beta, e.gamma);
  orient = m;
  // 仰角：長軸 (0,1,0) 與螢幕法線 (0,0,1) 的世界上分量用 atan2 合成，平放 0°、直立 90°、
  // 再往自己壓會繼續到 90° 以上（用 asin 會在 90° 折返，往後傾就變成往前）
  pitchDeg = Math.atan2(m.m32, m.m33) / DEG;
  // 左右傾：短軸 (1,0,0) 的世界上分量 = 右側抬高
  rollDeg = Math.asin(clamp(m.m31, -1, 1)) / DEG;
  updateRecal(performance.now());
  updateMove();
}
function updateRecal(now) {
  const r = recal;
  if (r.state === 'idle') {
    if (pitchDeg > RECAL_UP && joined) { r.state = 'up'; r.since = now; r.armed = false; }
    return;
  }
  if (r.state === 'up') {
    if (now - r.since >= RECAL_UP_MS) r.armed = true;
    if (pitchDeg < RECAL_BACK) {
      if (!r.armed) { r.state = 'idle'; return; } // 只是瞬間晃過 90°（例如跳躍手勢），不算
      r.state = 'settle'; r.since = now; r.hist = [];
      $('gest').textContent = '重新校正中：放回想要的握法後停住'; $('gest').style.color = '#d9ff4a';
    }
    return;
  }
  if (r.state === 'settle') {
    if (pitchDeg > RECAL_UP) { r.state = 'up'; r.since = now; r.armed = true; return; }
    r.hist.push({ t: now, p: pitchDeg, r: rollDeg });
    while (r.hist.length && now - r.hist[0].t > RECAL_SETTLE_MS) r.hist.shift();
    const span = r.hist.length ? now - r.hist[0].t : 0;
    if (span >= RECAL_SETTLE_MS * 0.9) {
      let pMin = 999, pMax = -999, rMin = 999, rMax = -999, pSum = 0, rSum = 0;
      for (const h of r.hist) { pMin = Math.min(pMin, h.p); pMax = Math.max(pMax, h.p); rMin = Math.min(rMin, h.r); rMax = Math.max(rMax, h.r); pSum += h.p; rSum += h.r; }
      if (pMax - pMin < RECAL_SETTLE_DEG && rMax - rMin < RECAL_SETTLE_DEG) {
        basePitch = pSum / r.hist.length; baseRoll = rSum / r.hist.length;
        r.state = 'idle'; r.doneAt = now;
        moveX = moveY = 0; sendMove(true);
        $('gest').style.color = '';
        flashGesture(`已重新校正：不動 = 仰角 ${basePitch.toFixed(0)}°`, 'hit');
        if (vibrate && navigator.vibrate) navigator.vibrate([20, 40, 20]);
        return;
      }
    }
    if (now - r.since > RECAL_TIMEOUT) { r.state = 'idle'; r.doneAt = now; $('gest').textContent = ''; $('gest').style.color = ''; }
  }
}
function captureBase() {
  if (!orient) return;
  basePitch = pitchDeg; baseRoll = rollDeg;
  moveX = moveY = 0; sendMove(true);
  if (vibrate && navigator.vibrate) navigator.vibrate(20);
}
function resetBase() { basePitch = NEUTRAL_PITCH; baseRoll = 0; moveX = moveY = 0; sendMove(true); }
function curve(deg) {
  const a = Math.abs(deg);
  if (a < DEAD) return 0;
  const t = clamp((a - DEAD) / (FULL - DEAD), 0, 1);
  return Math.sign(deg) * Math.pow(t, 1.3);
}
let lastMoveSent = 0, lastSent = { x: 9, y: 9 };
function updateMove() {
  if (!joined) return;
  const now = performance.now();
  // 重新校正手勢進行中：角色不動
  if (recal.state !== 'idle') { if (moveX || moveY) { moveX = moveY = 0; sendMove(true); } $('tilt').firstElementChild.style.transform = 'translate(-50%, -50%)'; return; }
  // 手勢進行中與結束後 250ms 內姿態不可信：保持原值
  if (bursting || now - lastGestureAt < 250) return;
  let mx = -curve(rollDeg - baseRoll);   // 右側壓低 → 往右
  let my = curve(pitchDeg - basePitch);  // 往前壓低（仰角變小）→ 往上（-Z，巨怪方向）
  if (flipX) mx = -mx; if (flipY) my = -my;
  moveX = mx; moveY = my;
  $('tilt').firstElementChild.style.transform = `translate(${-50 + mx * 220}%, ${-50 + my * 220}%)`;
  sendMove();
}
function sendMove(force = false) {
  const now = performance.now();
  const changed = Math.abs(moveX - lastSent.x) > 0.02 || Math.abs(moveY - lastSent.y) > 0.02;
  const zeroEdge = (moveX === 0 && moveY === 0) && (lastSent.x !== 0 || lastSent.y !== 0);
  if (!force && !zeroEdge && (now - lastMoveSent < 50 || (!changed && now - lastMoveSent < 300))) return;
  lastMoveSent = now; lastSent = { x: moveX, y: moveY };
  ws.send({ type: 'move', x: +moveX.toFixed(2), y: +moveY.toFixed(2) });
}

// ---------- 手勢（跳躍 / 敲擊） ----------
// 去重力加速度轉到世界座標，超過門檻進入「爆發」，累積加速階段的向量；
// 峰值一過就分類：向上占優 → 跳躍、沿手機前方（水平）占優 → 敲擊，其餘忽略。
let accSign = 1, accSignAcc = 0, accSignLocked = false;
function detectAccSign(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null || !orient || accSignLocked) return;
  const m = orient;
  const dot = g.x * m.m31 + g.y * m.m32 + g.z * m.m33; // 期望 ≈ +9.8
  accSignAcc += Math.sign(dot);
  if (Math.abs(accSignAcc) >= 30) { accSign = accSignAcc > 0 ? 1 : -1; accSignLocked = true; }
}
let bursting = false, burstStart = 0, peak = 0, peakReached = false, classified = false;
let vSum = { x: 0, y: 0, z: 0 };
let lastGestureAt = -9999, lastJumpAt = -9999, lastHitAt = -9999;
let debugAcc = 0, lastClass = '';
const JUMP_CD = 450, HIT_CD = 350, LOCKOUT = 250;

function onMotion(e) {
  detectAccSign(e);
  const raw = e.acceleration || e.accelerationIncludingGravity;
  if (!raw || raw.x == null) return;
  if (!orient) return;
  const m = orient;
  const a = { x: raw.x * accSign, y: raw.y * accSign, z: raw.z * accSign };
  // 裝置 → 世界（東 / 北 / 上）
  const w = {
    x: m.m11 * a.x + m.m12 * a.y + m.m13 * a.z,
    y: m.m21 * a.x + m.m22 * a.y + m.m23 * a.z,
    z: m.m31 * a.x + m.m32 * a.y + m.m33 * a.z,
  };
  const mag = Math.hypot(w.x, w.y, w.z);
  debugAcc = mag;
  const th = SENS[sensIdx].th;
  const now = performance.now();
  if (recal.state !== 'idle' || now - recal.doneAt < 300) { bursting = false; return; } // 抬手重新校正時不算跳躍 / 敲擊
  if (!bursting) {
    if (mag > th && now - lastGestureAt > LOCKOUT) {
      bursting = true; burstStart = now; peak = mag; peakReached = false; classified = false;
      vSum = { x: w.x, y: w.y, z: w.z };
    }
  } else {
    if (mag > peak) peak = mag;
    else if (!peakReached && mag < peak * 0.8) peakReached = true;
    if (!peakReached) { vSum.x += w.x; vSum.y += w.y; vSum.z += w.z; }
    const dur = now - burstStart;
    if ((peakReached || dur > 140) && !classified) { classified = true; classify(now); }
    if ((mag < th * 0.5 && dur > 60) || dur > 300) bursting = false;
  }
  if (now % 8 < 1) updateDebug();
}
function classify(now) {
  const m = orient;
  // 手機前方（長軸）在水平面上的方向
  let fx = m.m12, fy = m.m22; const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
  const up = vSum.z;
  const fwd = vSum.x * fx + vSum.y * fy;
  const lat = -vSum.x * fy + vSum.y * fx;
  const horiz = Math.hypot(fwd, lat);
  let kind = null;
  if (up > 0 && up > 1.15 * horiz) kind = 'jump';
  else if (fwd > 0 && fwd > 1.15 * Math.abs(up) && fwd > 1.3 * Math.abs(lat)) kind = 'hit';
  lastClass = `${kind || '-'} up ${up.toFixed(0)} fwd ${fwd.toFixed(0)} lat ${lat.toFixed(0)}`;
  if (!kind) return;
  if (kind === 'jump' && now - lastJumpAt < JUMP_CD) return;
  if (kind === 'hit' && now - lastHitAt < HIT_CD) return;
  lastGestureAt = now;
  if (kind === 'jump') lastJumpAt = now; else lastHitAt = now;
  sendAct(kind);
}
function sendAct(kind) {
  ws.send({ type: 'act', kind });
  flashGesture(kind === 'jump' ? '⤒ 跳躍' : '🔨 敲擊', kind);
  if (vibrate && navigator.vibrate) navigator.vibrate(kind === 'jump' ? 15 : [20, 30, 25]);
}
let gestFlashing = false, gestTimer = null;
function flashGesture(text, kind) {
  gestFlashing = true;
  const main = $('main');
  main.classList.remove('flash-jump', 'flash-hit');
  main.classList.add(kind === 'jump' ? 'flash-jump' : 'flash-hit');
  $('gest').textContent = text;
  clearTimeout(gestTimer);
  gestTimer = setTimeout(() => { gestFlashing = false; $('gest').textContent = ''; main.classList.remove('flash-jump', 'flash-hit'); if (lastState) renderState(lastState); }, 450);
}

// 備援按鈕（沒有感測器 / 桌機測試）
$('tapJump').addEventListener('pointerdown', (e) => { e.preventDefault(); if (joined) sendAct('jump'); });
$('tapHit').addEventListener('pointerdown', (e) => { e.preventDefault(); if (joined) sendAct('hit'); });
$('botBtn').onclick = () => { const other = lastState?.players?.[mySide === 'A' ? 'B' : 'A']; ws.send({ type: 'bot', on: !(other && other.bot) }); };
$('sens').onclick = () => { sensIdx = (sensIdx + 1) % SENS.length; $('sens').textContent = `手勢靈敏度：${SENS[sensIdx].label}`; };
$('flipY').onclick = () => { flipY = !flipY; $('flipY').textContent = `前後反轉：${flipY ? '開' : '關'}`; };
$('flipX').onclick = () => { flipX = !flipX; $('flipX').textContent = `左右反轉：${flipX ? '開' : '關'}`; };
$('vib').onclick = () => { vibrate = !vibrate; $('vib').textContent = `震動：${vibrate ? '開' : '關'}`; };

function updateDebug() {
  if (joined && !orient) { $('gest').textContent = '⚠ 沒有姿態資料：請確認是 https 連線並允許感測器'; $('gest').style.color = '#ff6b6b'; }
  else if (!gestFlashing && recal.state === 'idle' && $('gest').style.color) { $('gest').textContent = ''; $('gest').style.color = ''; }
  $('debug').textContent = `acc ${debugAcc.toFixed(1)}  sign ${accSignLocked ? (accSign > 0 ? '+' : '-') : '?'}  th ${SENS[sensIdx].th}\npitch ${(pitchDeg - basePitch).toFixed(0)}° roll ${(rollDeg - baseRoll).toFixed(0)}°  move ${moveX.toFixed(2)},${moveY.toFixed(2)}\n${lastClass}`;
}
setInterval(updateDebug, 150);

// ---------- 保持連線 / 螢幕常亮 ----------
let wakeLock = null;
async function requestWakeLock() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ } }
document.addEventListener('visibilitychange', () => {
  if (!joined) return;
  if (document.visibilityState === 'visible') { requestWakeLock(); sendJoin(); }
  else ws.send({ type: 'leave' });
});
addEventListener('pagehide', () => { if (joined) ws.send({ type: 'leave' }); });
setInterval(() => { if (joined && document.visibilityState === 'visible') ws.send({ type: 'ping', t: Date.now() }); }, 2000);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
if (room) $('go').focus();
