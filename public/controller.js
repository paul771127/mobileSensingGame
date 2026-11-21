import { connect, qs, loadAssets } from '/common.js';

const $ = (id) => document.getElementById(id);
const joinScreen = $('join'), playScreen = $('play');

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
    joinScreen.classList.remove('on'); playScreen.classList.add('on');
    $('roomLabel').innerHTML = `房號 <b>${room}</b> · 你是 <b class="side-${mySide}">${mySide} 方</b>`;
    const u = new URL(location.href); u.searchParams.set('room', room); u.searchParams.set('side', mySide); history.replaceState(null, '', u);
    requestWakeLock();
    baseHeading = null; // 加入當下視為正對球網
  } else if (msg.type === 'error') {
    $('joinMsg').textContent = msg.text;
    joinScreen.classList.add('on'); playScreen.classList.remove('on');
  } else if (msg.type === 'state') {
    lastState = msg.state; renderState(msg.state);
  } else if (msg.type === 'swing_ack') {
    flash(msg.hit, msg.quality);
  }
}

function renderState(s) {
  if (!mySide) return;
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
  $('status').textContent = hit ? ({ perfect: 'PERFECT!', good: 'GOOD!', late: '打到了' }[quality] || '打到了') : '揮空…';
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
let faceDeg = 0, loftDeg = 0;
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
  if (baseHeading == null) baseHeading = heading;
  faceDeg = wrapDeg(heading - baseHeading);
  loftDeg = Math.asin(Math.max(-1, Math.min(1, m.m33))) / DEG; // 正 = 拍面朝上
}

function calibrate() {
  baseHeading = null; // 下一筆姿態就成為新基準
  $('status').textContent = '已校正：現在的方向 = 正對球網';
  if (vibrate && navigator.vibrate) navigator.vibrate(20);
}

// ---- 揮拍偵測 ----
// 加速度大小超過門檻→進入揮拍→低於門檻或超時後送出一次 swing。
// 揮拍期間累積：峰值、橫向加速度、陀螺儀，以及「加速階段」的加速度向量（用來算揮拍平面）。
let swinging = false, peak = 0, swingStart = 0, lastSwingAt = 0;
let accX = 0, rotY = 0, rotX = 0, samples = 0;
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
      accX = a.x; rotY = rr?.gamma ?? 0; rotX = rr?.beta ?? 0; samples = 1;
      vSum = { x: a.x, y: a.y, z: a.z };
      swingOrient = orient; swingFace = faceDeg; swingLoft = loftDeg; // 以揮拍開始時的拍面為準
    }
  } else {
    if (mag > peak) { peak = mag; }
    else if (!peakReached && mag < peak * 0.8) { peakReached = true; }
    if (!peakReached) { vSum.x += a.x; vSum.y += a.y; vSum.z += a.z; }
    accX += a.x; rotY += rr?.gamma ?? 0; rotX += rr?.beta ?? 0; samples++;
    const dur = now - swingStart;
    if ((mag < th * 0.5 && dur > 60) || dur > 220) {
      swinging = false; lastSwingAt = now;
      emitSwing(peak, accX / samples, rotY / samples, rotX / samples);
    }
  }
  if (now % 10 < 1) updateDebug();
}

function emitSwing(peakMag, meanAx, meanGy, meanGx) {
  // 力道：門檻以上到 ~45 m/s² 線性映射
  const th = SENS[sensIdx].th;
  const strength = clamp((peakMag - th) / (45 - th), 0.15, 1);
  // 揮動方向：陀螺儀繞手機長軸(gamma)，否則用橫向加速度
  let dirX = gyroAvail ? clamp(-meanGy / 250, -1, 1) : clamp(meanAx / 15, -1, 1);
  // 手腕翻轉(beta)：往下壓 = 上旋(正)，往上甩 = 下旋/挑(負)
  const spin = gyroAvail ? clamp(meanGx / 300, -1, 1) : 0;
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
  if (mirror) { dirX = -dirX; face = -face; }
  lastPlane = plane;
  sendSwing({ strength, dirX, face, loft, plane, spin });
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
  sendSwing({ strength, dirX, face: 0, loft: 0, plane: 0, spin: 0 });
});
addEventListener('keydown', (e) => {
  if (!joined) return;
  const k = { Space: {}, ArrowUp: { plane: 0.8 }, ArrowDown: { plane: -0.8 }, ArrowLeft: { face: -0.7 }, ArrowRight: { face: 0.7 } }[e.code];
  if (k) { e.preventDefault(); sendSwing({ strength: 0.6, dirX: 0, face: 0, loft: 0, plane: 0, spin: 0, ...k }); }
});
$('calib').onclick = calibrate;
$('botBtn').onclick = () => ws.send({ type: 'bot', side: mySide === 'A' ? 'B' : 'A', on: true });

$('mirror').onclick = () => { mirror = !mirror; $('mirror').textContent = `左右鏡像：${mirror ? '開' : '關'}`; };
$('sens').onclick = () => { sensIdx = (sensIdx + 1) % SENS.length; $('sens').textContent = `靈敏度：${SENS[sensIdx].label}`; };
$('vib').onclick = () => { vibrate = !vibrate; $('vib').textContent = `震動：${vibrate ? '開' : '關'}`; };

function updateDebug() {
  $('debug').textContent = `acc ${debugAcc.toFixed(1)} m/s²  gyro ${gyroAvail ? 'yes' : 'no'}  th ${SENS[sensIdx].th}  plane ${lastPlane.toFixed(2)}`;
  $('face').textContent = orient ? `拍面 ${faceDeg >= 0 ? '+' : ''}${faceDeg.toFixed(0)}°  仰角 ${loftDeg >= 0 ? '+' : ''}${loftDeg.toFixed(0)}°` : '（此裝置沒有姿態感測）';
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
