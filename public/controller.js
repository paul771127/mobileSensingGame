import { connect, qs, loadAssets } from '/common.js';

const $ = (id) => document.getElementById(id);
const joinScreen = $('join'), playScreen = $('play'), calibScreen = $('calibScreen');
const show = (sec) => { for (const x of [joinScreen, calibScreen, playScreen]) x.classList.toggle('on', x === sec); };

let room = (qs('room') || '').toUpperCase();
let side = qs('side') || null;
let mySide = null;
let joined = false;
let motionOK = false;
let mirror = false;
let vibrate = true;
let sensIdx = 1; // 0 低 1 中 2 高
const SENS = [{ label: '低', th: 22 }, { label: '中', th: 15 }, { label: '高', th: 10 }];
let lastState = null;
// 這支手機的固定識別碼：重連時接回原本的位置
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
  if (joined) ws.send({ type: 'join', role: 'controller', room, side: mySide || side, name: $('name').value, cid });
});

function onMessage(msg) {
  if (msg.type === 'joined') {
    mySide = msg.side; room = msg.room; joined = true;
    show(playScreen);
    $('roomLabel').innerHTML = `房號 <b>${room}</b> · 你是 <b class="side-${mySide}">${mySide} 方</b>`;
    const u = new URL(location.href); u.searchParams.set('room', room); u.searchParams.set('side', mySide); history.replaceState(null, '', u);
    requestWakeLock();
  } else if (msg.type === 'error') {
    $('joinMsg').textContent = msg.text;
    show(joinScreen);
  } else if (msg.type === 'state') {
    lastState = msg.state; renderState(msg.state);
  } else if (msg.type === 'swing_ack') {
    flash(msg.hit, msg.quality);
  }
}

let lastPhase = null;
function renderState(s) {
  if (!mySide) return;
  if (s.phase !== lastPhase) {
    // 每一分開始（進入發球）時把平移歸零：回到基準站位，漂移不會累積
    if (s.phase === 'serve') resetTranslation();
    lastPhase = s.phase;
  }
  $('score').firstChild.textContent = `${s.score.points.A} - ${s.score.points.B}`;
  $('games').textContent = `局數 ${s.score.games.A} - ${s.score.games.B}`;
  const other = mySide === 'A' ? 'B' : 'A';
  let text = '', sub = '';
  $('botBtn').style.display = (s.phase === 'lobby' && !s.players[other].connected) ? '' : 'none';
  if (s.phase === 'lobby') { text = '等待對手'; sub = s.players[other].connected ? '' : '請另一支手機加入 ' + other + ' 方'; }
  else if (s.phase === 'serve') { text = s.server === mySide ? '你發球：揮拍！' : '對手發球'; sub = s.server === mySide ? '三秒內沒揮會自動發球' : ''; }
  else if (s.phase === 'rally') {
    const b = s.ball;
    const toMe = b && Math.sign(b.vy) === (mySide === 'A' ? -1 : 1);
    text = toMe ? '球來了！' : '等對手回球';
    if (toMe && b) {
      const p = s.players[mySide];
      const dist = Math.abs(b.y - p.y);
      const eta = Math.abs(b.vy) > 0.1 ? dist / Math.abs(b.vy) : 9;
      sub = eta < 0.45 ? '現在揮！' : eta < 1.2 ? '準備…' : '';
      $('meter').firstChild.style.width = `${Math.max(0, 100 - eta * 60)}%`;
    } else $('meter').firstChild.style.width = '0%';
  }
  else if (s.phase === 'point') { text = s.lastEvent?.text || ''; }
  else if (s.phase === 'gameover') { text = s.lastEvent?.text || '比賽結束'; }
  if (!flashing) { $('status').textContent = text; $('sub').textContent = sub; }
}

let flashing = false, flashTimer = null;
function flash(hit, quality) {
  flashing = true;
  const main = $('main');
  main.classList.remove('flash-hit', 'flash-miss');
  main.classList.add(hit ? 'flash-hit' : 'flash-miss');
  $('status').textContent = hit ? ({ perfect: 'PERFECT!', good: 'GOOD!', late: '打到了', block: '擋球' }[quality] || '打到了') : '揮空…';
  $('sub').textContent = hit ? '' : '等球再近一點再揮';
  if (vibrate && navigator.vibrate) navigator.vibrate(hit ? [30, 20, 60] : 15);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashing = false; main.classList.remove('flash-hit', 'flash-miss'); if (lastState) renderState(lastState); }, 600);
}

// ---------- 加入 ----------
$('go').onclick = async () => {
  room = $('room').value.trim().toUpperCase();
  if (room.length !== 4) { $('joinMsg').textContent = '房號是 4 個字'; return; }
  $('joinMsg').textContent = '';
  await enableMotion(); // 需要在使用者點擊中呼叫（iOS）
  startCalibration();
};

// ---------- 校正流程 ----------
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
      $('calibLive').textContent = `偵測到姿態：拍頭仰角 ${headElevDeg.toFixed(0)}°（直立 90°、水平 0°）`;
    } else if (performance.now() - t0 > 2500) {
      $('calibDone').disabled = false;
      $('calibLive').textContent = '沒有收到姿態資料：將略過拍面控制，仍可用揮拍與點擊。';
    }
  }, 150);
}
$('calibDone').onclick = () => {
  clearInterval(calibTimer);
  captureBase();
  joined = true;
  ws.send({ type: 'join', role: 'controller', room, side, name: $('name').value, cid });
};
$('leave').onclick = () => { joined = false; mySide = null; location.href = '/controller'; };

// ---------- 感測器 ----------
async function enableMotion() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') { $('joinMsg').textContent = '沒有取得動作感測器權限，仍可用「點一下揮拍」。'; }
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
  if (!window.isSecureContext) $('joinMsg').textContent = '非 HTTPS 連線：iPhone 將無法使用感測器，Android 部分可用。';
}

// ---- 姿態（拍面角度 / 仰角）----
// 由 alpha/beta/gamma 建旋轉矩陣（W3C ZXY），取手機螢幕法線在世界座標的方向：
//   水平方位 = 拍面朝向（相對校正時的方位）、垂直分量 = 拍面仰角
let orient = null;      // 最新姿態的矩陣
let baseHeading = null; // 校正時的拍面方位（面向球網 / 電視）
let baseHeadElev = 90, baseTilt = 0; // 校正時拍頭仰角與左右傾
let faceDeg = 0, loftDeg = 0, headElevDeg = 90, tiltDeg = 0, pitchDelta = 0, tiltDelta = 0;
let lastHeading = 0;
const DEG = Math.PI / 180;

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
function wrapDeg(d) { return ((d + 540) % 360) - 180; }

function onOrientation(e) {
  if (e.alpha == null || e.beta == null || e.gamma == null) return;
  const m = rotMatrix(e.alpha, e.beta, e.gamma);
  orient = m;
  // 螢幕法線 (0,0,1) 在世界座標：(m13, m23, m33)；x 東 y 北 z 上
  const heading = Math.atan2(m.m13, m.m23) / DEG;  // 順時針為正
  lastHeading = heading;
  if (baseHeading == null) baseHeading = heading;
  loftDeg = Math.asin(Math.max(-1, Math.min(1, m.m33))) / DEG; // 正 = 拍面朝上
  // 拍面幾乎朝天/朝地時法線沒有水平方位可言，拍面角度視為 0
  faceDeg = Math.abs(m.m33) > 0.85 ? 0 : wrapDeg(heading - baseHeading);
  // 拍頭方向 = 手機長軸 (0,1,0) 在世界座標：(m12, m22, m32)
  headElevDeg = Math.asin(Math.max(-1, Math.min(1, m.m32))) / DEG; // 90 = 直立
  // 以校正時的面向為準，拍頭往玩家右手邊傾多少度
  const h = baseHeading * DEG;
  const rightE = -Math.cos(h), rightN = Math.sin(h);        // 玩家右手邊（東/北分量）
  const headRight = m.m12 * rightE + m.m22 * rightN;
  tiltDeg = Math.atan2(headRight, Math.max(m.m32, 0.2)) / DEG; // 從正面看拍頭往右傾幾度
  pitchDelta = headElevDeg - baseHeadElev;
  tiltDelta = tiltDeg - baseTilt;
  // 拍頭單位向量（玩家座標：右 / 前 / 上），給顯示端畫球拍方向
  const fwdE = -Math.sin(h), fwdN = -Math.cos(h);
  headVec = { r: headRight * (mirror ? -1 : 1), f: m.m12 * fwdE + m.m22 * fwdN, u: m.m32 };
  updateMove();
  sendPose();
}

// 拍頭方向：每 100ms 最多送一次，變化夠大才送
let headVec = null, lastPoseSent = 0, lastPose = null;
function sendPose(force = false) {
  if (!joined || !headVec) return;
  const now = performance.now();
  // 揮拍中（含揮完 0.45 秒）每 25ms 回報一次，讓畫面上的球拍跟著實際軌跡走；平時 100ms
  const fast = swinging || now - lastSwingAt < 450 || (swingStart && now - swingStart < 450);
  if (!force && now - lastPoseSent < (fast ? 25 : 100)) return;
  const h = headVec;
  if (!force && !fast && lastPose && Math.abs(h.r - lastPose.r) < 0.03 && Math.abs(h.f - lastPose.f) < 0.03 && Math.abs(h.u - lastPose.u) < 0.03) return;
  lastPose = { ...h }; lastPoseSent = now;
  ws.send({ type: 'pose', r: +h.r.toFixed(3), f: +h.f.toFixed(3), u: +h.u.toFixed(3) });
}

function captureBase() {
  if (!orient) return;
  baseHeading = lastHeading;
  baseHeadElev = headElevDeg;
  // 重新以新基準算一次左右傾，當成基準傾角
  const h = baseHeading * DEG;
  const m = orient;
  const headRight = m.m12 * -Math.cos(h) + m.m22 * Math.sin(h);
  baseTilt = Math.atan2(headRight, Math.max(m.m32, 0.2)) / DEG;
  pitchDelta = 0; tiltDelta = 0;
}

function calibrate() {
  captureBase();
  resetTranslation();
  $('status').textContent = '已校正：現在的姿勢 = 正對球網的準備姿勢';
  if (vibrate && navigator.vibrate) navigator.vibrate(20);
}

// ---- 姿態 → 角色移動 ----
// 相對校正姿勢的角度：±7.5° 內不動、7.5~20° 慢速(0.5)、20° 以上正常速度(1)。
// 拍頭左右傾控制左右、抬高後退、壓低前進，可同時成立。帶 2° 遲滯避免在門檻附近抖動。
const DEAD = 7.5, SLOW = 20, HYST = 2;
let moveX = 0, moveY = 0, lastMoveSent = 0, lastMoveMsg = '';
function band(cur, val) {
  const a = Math.abs(val), sgn = Math.sign(val);
  const same = cur !== 0 && Math.sign(cur) === sgn;
  const lv = same ? Math.abs(cur) : 0;
  const tFast = SLOW - (lv >= 1 ? HYST : 0);
  const tSlow = DEAD - (lv >= 0.5 ? HYST : 0);
  if (a >= tFast) return sgn;
  if (a >= tSlow) return sgn * 0.5;
  return 0;
}
const MANUAL_MOVE = false; // 與伺服器一致：目前為自動跑位，手機姿態不控制移動
function updateMove() {
  if (!joined || !MANUAL_MOVE) return;
  const now = performance.now();
  // 揮拍中與揮完 0.4 秒內不算移動
  const busy = swinging || now - lastSwingAt < 400;
  let mx = busy ? 0 : band(moveX, tiltDelta);
  let my = busy ? 0 : -band(moveY, pitchDelta); // 抬高(正) → 後退(-)；壓低 → 前進(+)
  if (mirror) mx = -mx;
  const changed = mx !== moveX || my !== moveY;
  moveX = mx; moveY = my;
  if (changed || ((mx || my) && now - lastMoveSent > 300)) {
    ws.send({ type: 'move', x: mx, y: my });
    lastMoveSent = now;
  }
  const slow = (v) => (Math.abs(v) === 0.5 ? '(慢)' : '');
  const txt = (my > 0 ? '▲ 前進' + slow(my) + ' ' : my < 0 ? '▼ 後退' + slow(my) + ' ' : '') + (mx < 0 ? '◀ 左移' + slow(mx) : mx > 0 ? '右移' + slow(mx) + ' ▶' : '');
  if (txt !== lastMoveMsg) { $('moveInd').textContent = txt; lastMoveMsg = txt; }
}

// ---- 揮拍偵測 ----
// 加速度大小超過門檻→進入揮拍→低於門檻或超時後送出一次 swing。
// 揮拍期間累積：峰值、橫向加速度、陀螺儀，以及「加速階段」的加速度向量（用來算揮拍平面）。
let swinging = false, peak = 0, swingStart = 0, lastSwingAt = 0;
let accX = 0, rotY = 0, rotX = 0, rotZ = 0, samples = 0;
let vSum = { x: 0, y: 0, z: 0 }, peakReached = false, swingOrient = null, swingFace = 0, swingLoft = 0;
let gyroAvail = false;
let debugAcc = 0, lastPlane = 0;

function onMotion(e) {
  const a = e.acceleration || e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const mag = Math.hypot(a.x, a.y, a.z);
  debugAcc = mag;
  const th = SENS[sensIdx].th;
  const now = performance.now();
  const rr = e.rotationRate;
  if (rr && rr.alpha != null) gyroAvail = true;

  if (!swinging) {
    if (mag > th && now - lastSwingAt > 350) {
      swinging = true; swingStart = now; peak = mag; peakReached = false;
      onSwingStartTranslation(now);
      accX = a.x; rotY = rr?.gamma ?? 0; rotX = rr?.beta ?? 0; rotZ = rr?.alpha ?? 0; samples = 1;
      vSum = { x: a.x, y: a.y, z: a.z };
      swingOrient = orient; swingFace = faceDeg; swingLoft = loftDeg; // 以揮拍開始時的拍面為準
    }
  } else {
    if (mag > peak) { peak = mag; }
    else if (!peakReached && mag < peak * 0.8) { peakReached = true; }
    if (!peakReached) { vSum.x += a.x; vSum.y += a.y; vSum.z += a.z; }
    accX += a.x; rotY += rr?.gamma ?? 0; rotX += rr?.beta ?? 0; rotZ += rr?.alpha ?? 0; samples++;
    const dur = now - swingStart;
    if ((mag < th * 0.5 && dur > 60) || dur > 220) {
      swinging = false; lastSwingAt = now;
      emitSwing(peak, accX / samples, rotY / samples, rotX / samples, rotZ / samples);
      if (moveX || moveY) { moveX = 0; moveY = 0; ws.send({ type: 'move', x: 0, y: 0 }); $('moveInd').textContent = ''; lastMoveMsg = ''; }
    }
  }
  integrateTranslation(a, now);
  if (now % 10 < 1) updateDebug();
}

// ---- 手機平移 → 角色位置 ----
// 把去重力加速度轉到世界座標，再投影到玩家座標（右 / 前），積分成速度與位移。
// 靜止時（加速度小於門檻持續 120ms）速度歸零抑制漂移；揮拍中與揮完 0.2 秒不積分加速度、只以慣性滑行；位移限制在 ±35cm。
const TR = { v: { r: 0, f: 0 }, p: { r: 0, f: 0 }, lastT: 0, quietSince: 0, lastSent: 0, lastSentP: { r: 9, f: 9 }, hist: [] };
const TR_MAX = 0.35, TR_QUIET_ACC = 0.7, TR_QUIET_MS = 120, TR_DAMP = 1.2;
const TR_GAINS = [1, 1.5, 2, 3]; let trGainIdx = 1; // 位移倍率（積分會低估實際位移，預設 1.5x，可在手機上切換）
function integrateTranslation(a, now) {
  if (!orient || !joined) return;
  const dt = TR.lastT ? Math.min(0.05, (now - TR.lastT) / 1000) : 0;
  TR.lastT = now;
  if (!dt) return;
  const busy = swinging || now - lastSwingAt < 200;
  const m = orient;
  // 裝置 → 世界（東/北/上）
  const wx = m.m11 * a.x + m.m12 * a.y + m.m13 * a.z;
  const wy = m.m21 * a.x + m.m22 * a.y + m.m23 * a.z;
  // 世界 → 玩家座標（以校正方位為準）
  const h = baseHeading * DEG;
  const ar = wx * -Math.cos(h) + wy * Math.sin(h);
  const af = wx * -Math.sin(h) + wy * -Math.cos(h);
  const mag = Math.hypot(ar, af);
  if (busy) { TR.v.r = 0; TR.v.f = 0; TR.quietSince = now; return; } // 揮拍中：手機位移不可信，保持原位（球場上的「撲球」由伺服器處理）
  if (mag < TR_QUIET_ACC) {
    if (!TR.quietSince) TR.quietSince = now;
    if (now - TR.quietSince > TR_QUIET_MS) { TR.v.r = 0; TR.v.f = 0; }
  } else TR.quietSince = 0;
  TR.v.r = (TR.v.r + ar * dt) * (1 - TR_DAMP * dt);
  TR.v.f = (TR.v.f + af * dt) * (1 - TR_DAMP * dt);
  const gain = TR_GAINS[trGainIdx];
  TR.p.r = clamp(TR.p.r + TR.v.r * dt * gain, -TR_MAX, TR_MAX);
  TR.p.f = clamp(TR.p.f + TR.v.f * dt * gain, -TR_MAX, TR_MAX);
  // 位移歷史（300ms），揮拍開始時用來回溯引拍造成的假位移
  TR.hist.push({ t: now, r: TR.p.r, f: TR.p.f });
  while (TR.hist.length && now - TR.hist[0].t > 300) TR.hist.shift();
  sendOffset(now);
}
// 揮拍開始：引拍（反方向的手臂動作）在過去約 250ms 內被當成平移，回溯到引拍前的位置
function onSwingStartTranslation(now) {
  const h = TR.hist.find((x) => now - x.t <= 250) || TR.hist[0];
  if (h) { TR.p.r = h.r; TR.p.f = h.f; }
  TR.v.r = 0; TR.v.f = 0; TR.hist.length = 0;
  sendOffset(now, true);
}
function sendOffset(now, force = false) {
  if (!joined) return;
  if (!force && now - TR.lastSent < 50) return;
  const dr = Math.abs(TR.p.r - TR.lastSentP.r), df = Math.abs(TR.p.f - TR.lastSentP.f);
  if (!force && dr < 0.004 && df < 0.004) return;
  TR.lastSent = now; TR.lastSentP = { r: TR.p.r, f: TR.p.f };
  const mr = mirror ? -1 : 1;
  ws.send({ type: 'offset', x: +(TR.p.r * mr).toFixed(3), y: +TR.p.f.toFixed(3) });
  const cm = (v) => `${Math.round(v * 100)}`;
  $('moveInd').textContent = (Math.abs(TR.p.r) > 0.01 || Math.abs(TR.p.f) > 0.01)
    ? `位移 ${TR.p.r >= 0 ? '→' : '←'}${cm(Math.abs(TR.p.r))}cm ${TR.p.f >= 0 ? '↑' : '↓'}${cm(Math.abs(TR.p.f))}cm` : '';
}
function resetTranslation() {
  TR.v.r = 0; TR.v.f = 0; TR.p.r = 0; TR.p.f = 0; TR.hist.length = 0;
  sendOffset(performance.now(), true);
}

function emitSwing(peakMag, meanAx, meanGy, meanGx, meanGz) {
  // 力道：門檻以上到 ~55 m/s² 線性映射（輕揮 = 短球，全力才到底線）
  const th = SENS[sensIdx].th;
  const strength = clamp((peakMag - th) / (55 - th), 0.05, 1);
  // 揮動方向：陀螺儀繞手機長軸(gamma)，否則用橫向加速度
  let dirX = gyroAvail ? clamp(-meanGy / 250, -1, 1) : clamp(meanAx / 15, -1, 1);
  // 手腕翻轉(beta)：往下壓 = 上旋(正)，往上甩 = 下旋/挑(負)。門檻外線性放大，旋球要明顯
  const spin = gyroAvail ? spinCurve(meanGx / 200) : 0;
  // 繞螢幕法線轉(alpha)：像削球那樣側向刷 = 側旋
  let curve = gyroAvail ? spinCurve(meanGz / 220) : 0;
  // 拍面角度：±45° 對應 ±1；拍面仰角：±40° 對應 ±1
  let face = orient ? clamp(swingFace / 45, -1, 1) : 0;
  const loft = orient ? clamp(swingLoft / 40, -1, 1) : 0;
  // 揮拍平面：把加速階段的加速度向量轉到世界座標，看垂直分量與水平分量的夾角
  let plane = 0;
  if (swingOrient) {
    const m = swingOrient;
    const wz = m.m31 * vSum.x + m.m32 * vSum.y + m.m33 * vSum.z;
    const wx = m.m11 * vSum.x + m.m12 * vSum.y + m.m13 * vSum.z;
    const wy = m.m21 * vSum.x + m.m22 * vSum.y + m.m23 * vSum.z;
    const horiz = Math.hypot(wx, wy);
    const ang = Math.atan2(wz, horiz) / DEG; // +90 = 垂直往上
    plane = clamp(ang / 60, -1, 1);
  }
  if (mirror) { dirX = -dirX; face = -face; curve = -curve; }
  lastPlane = plane;
  sendSwing({ strength, dirX, face, loft, plane, spin, curve });
}
// 小動作忽略（±0.15 以內視為沒旋），之後線性到 1
function spinCurve(v) {
  const a = Math.abs(v);
  if (a < 0.15) return 0;
  return Math.sign(v) * clamp((a - 0.15) / 0.6, 0, 1);
}

function sendSwing(s) {
  ws.send({ type: 'swing', ...s, t: Date.now() });
  const r = $('racket'); r.classList.add('swing'); setTimeout(() => r.classList.remove('swing'), 160);
  $('meter').firstChild.style.width = `${Math.round(s.strength * 100)}%`;
  const tags = [];
  if (s.plane > 0.35) tags.push('撈球 ↗'); else if (s.plane < -0.35) tags.push('劈球 ↘');
  if (s.face > 0.3) tags.push('拍面朝右'); else if (s.face < -0.3) tags.push('拍面朝左');
  if (s.loft > 0.4) tags.push('開拍面');
  if (s.spin > 0.4) tags.push('上旋'); else if (s.spin < -0.4) tags.push('下旋');
  if (s.curve > 0.4) tags.push('側旋 ↪'); else if (s.curve < -0.4) tags.push('側旋 ↩');
  $('shot').textContent = `力道 ${Math.round(s.strength * 100)}%${tags.length ? ' · ' + tags.join(' · ') : ''}`;
}

// 點擊揮拍（桌機測試 / 無感測器時）：按住越久力道越大
let pressAt = 0;
const tap = $('tapswing');
tap.addEventListener('pointerdown', (e) => { pressAt = performance.now(); e.preventDefault(); });
tap.addEventListener('pointerup', (e) => {
  const held = performance.now() - pressAt;
  const strength = clamp(0.4 + held / 1200, 0.4, 1);
  const rect = tap.getBoundingClientRect();
  const dirX = clamp(((e.clientX - rect.left) / rect.width - 0.5) * 2, -1, 1) * (mirror ? -1 : 1);
  sendSwing({ strength, dirX, face: 0, loft: 0, plane: 0, spin: 0, curve: 0 });
});
const KEYMOVE = { KeyA: [-1, 0], KeyD: [1, 0], KeyW: [0, 1], KeyS: [0, -1] };
const keyOff = { x: 0, y: 0 };
addEventListener('keyup', (e) => { if (joined && KEYMOVE[e.code]) { if (KEYMOVE[e.code][0]) keyOff.x = 0; else keyOff.y = 0; ws.send({ type: 'offset', ...keyOff }); } });
addEventListener('keydown', (e) => {
  if (!joined) return;
  if (KEYMOVE[e.code]) { e.preventDefault(); if (e.repeat) return; if (KEYMOVE[e.code][0]) keyOff.x = KEYMOVE[e.code][0] * 0.3; else keyOff.y = KEYMOVE[e.code][1] * 0.3; ws.send({ type: 'offset', ...keyOff }); return; }
  const k = { Space: {}, ArrowUp: { plane: 0.8 }, ArrowDown: { plane: -0.8 }, ArrowLeft: { face: -0.7 }, ArrowRight: { face: 0.7 }, KeyZ: { spin: 1 }, KeyX: { spin: -1 }, KeyQ: { curve: -1 }, KeyE: { curve: 1 } }[e.code];
  if (k) { e.preventDefault(); sendSwing({ strength: 0.6, dirX: 0, face: 0, loft: 0, plane: 0, spin: 0, curve: 0, ...k }); }
});
$('calib').onclick = calibrate;
$('botBtn').onclick = () => ws.send({ type: 'bot', side: mySide === 'A' ? 'B' : 'A', on: true });

$('mirror').onclick = () => { mirror = !mirror; $('mirror').textContent = `左右鏡像：${mirror ? '開' : '關'}`; };
$('sens').onclick = () => { sensIdx = (sensIdx + 1) % SENS.length; $('sens').textContent = `靈敏度：${SENS[sensIdx].label}`; };
$('vib').onclick = () => { vibrate = !vibrate; $('vib').textContent = `震動：${vibrate ? '開' : '關'}`; };
$('trgain').onclick = () => { trGainIdx = (trGainIdx + 1) % TR_GAINS.length; $('trgain').textContent = `位移倍率：${TR_GAINS[trGainIdx]}x`; resetTranslation(); };

function updateDebug() {
  $('debug').textContent = `acc ${debugAcc.toFixed(1)} m/s²  gyro ${gyroAvail ? 'yes' : 'no'}  th ${SENS[sensIdx].th}  plane ${lastPlane.toFixed(2)}`;
  $('face').textContent = orient ? `拍面 ${faceDeg >= 0 ? '+' : ''}${faceDeg.toFixed(0)}°  拍頭仰 ${pitchDelta >= 0 ? '+' : ''}${pitchDelta.toFixed(0)}°  傾 ${tiltDelta >= 0 ? '+' : ''}${tiltDelta.toFixed(0)}°` : '（此裝置沒有姿態感測）';
}
setInterval(updateDebug, 120);

// ---------- 保持螢幕常亮 ----------
let wakeLock = null;
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
}
// 切到背景 = 離線；回到前景 = 自動重新加入。關閉頁面也立刻通知伺服器。
document.addEventListener('visibilitychange', () => {
  if (!joined) return;
  if (document.visibilityState === 'visible') {
    requestWakeLock();
    ws.send({ type: 'join', role: 'controller', room, side: mySide, name: $('name').value, cid });
  } else {
    ws.send({ type: 'leave' });
  }
});
addEventListener('pagehide', () => { if (joined) ws.send({ type: 'leave' }); });
setInterval(() => { if (joined && document.visibilityState === 'visible') ws.send({ type: 'ping', t: Date.now() }); }, 2000);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 美術：球拍圖
loadAssets().then((a) => {
  if (a.controllerRacket) { const img = document.createElement('img'); img.src = a.controllerRacket.src; $('racket').replaceChildren(img); }
});

// 若網址帶房號就直接顯示加入畫面並聚焦按鈕
if (room) $('go').focus();
