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

$('room').value = room;
if (side) $('sideSel').querySelector(`[data-side="${side}"]`)?.classList.add('on');
$('sideSel').querySelectorAll('button').forEach((b) => {
  b.onclick = () => { side = b.dataset.side; $('sideSel').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
});

// ---------- 連線 ----------
const ws = connect(onMessage, () => {
  $('conn').textContent = '已連線';
  if (joined) ws.send({ type: 'join', role: 'controller', room, side: mySide || side, name: $('name').value });
});

function onMessage(msg) {
  if (msg.type === 'joined') {
    mySide = msg.side; room = msg.room; joined = true;
    joinScreen.classList.remove('on'); playScreen.classList.add('on');
    $('roomLabel').innerHTML = `房號 <b>${room}</b> · 你是 <b class="side-${mySide}">${mySide} 方</b>`;
    const u = new URL(location.href); u.searchParams.set('room', room); u.searchParams.set('side', mySide); history.replaceState(null, '', u);
    requestWakeLock();
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
      sub = eta < 0.35 ? '現在揮！' : eta < 1.0 ? '準備…' : '';
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
  ws.send({ type: 'join', role: 'controller', room, side, name: $('name').value });
};
$('leave').onclick = () => { joined = false; mySide = null; location.href = '/controller'; };

// ---------- 感測器 ----------
async function enableMotion() {
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') { $('joinMsg').textContent = '沒有取得動作感測器權限，仍可用「點一下揮拍」。'; }
    }
  } catch (e) { console.warn(e); }
  if (!motionOK) {
    window.addEventListener('devicemotion', onMotion, { passive: true });
    motionOK = true;
  }
  if (!window.isSecureContext) $('joinMsg').textContent = '非 HTTPS 連線：iPhone 將無法使用感測器，Android 部分可用。';
}

// 揮拍偵測：加速度大小超過門檻→進入揮拍→低於門檻或超時後送出一次 swing
let swinging = false, peak = 0, swingStart = 0, lastSwingAt = 0;
let accX = 0, rotY = 0, rotX = 0, samples = 0;
let gyroAvail = false;
let debugAcc = 0;

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
      swinging = true; swingStart = now; peak = mag; accX = a.x; rotY = rr?.gamma ?? 0; rotX = rr?.beta ?? 0; samples = 1;
    }
  } else {
    peak = Math.max(peak, mag);
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
  // 左右：優先用陀螺儀繞手機長軸(gamma)的方向，否則用橫向加速度
  let dirX = gyroAvail ? clamp(-meanGy / 250, -1, 1) : clamp(meanAx / 15, -1, 1);
  if (mirror) dirX = -dirX;
  // 旋轉：手腕上下翻(beta)：往上甩 = 挑高(負)，往下壓 = 上旋(正)
  const spin = gyroAvail ? clamp(meanGx / 300, -1, 1) : 0;
  sendSwing({ strength, dirX, spin });
}

function sendSwing(s) {
  ws.send({ type: 'swing', ...s, t: Date.now() });
  const r = $('racket'); r.classList.add('swing'); setTimeout(() => r.classList.remove('swing'), 160);
  $('meter').firstChild.style.width = `${Math.round(s.strength * 100)}%`;
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
  sendSwing({ strength, dirX, spin: 0 });
});
addEventListener('keydown', (e) => { if (e.code === 'Space' && joined) sendSwing({ strength: 0.6, dirX: 0, spin: 0 }); });

$('mirror').onclick = () => { mirror = !mirror; $('mirror').textContent = `左右鏡像：${mirror ? '開' : '關'}`; };
$('sens').onclick = () => { sensIdx = (sensIdx + 1) % SENS.length; $('sens').textContent = `靈敏度：${SENS[sensIdx].label}`; };
$('vib').onclick = () => { vibrate = !vibrate; $('vib').textContent = `震動：${vibrate ? '開' : '關'}`; };

function updateDebug() {
  $('debug').textContent = `acc ${debugAcc.toFixed(1)} m/s²  gyro ${gyroAvail ? 'yes' : 'no'}  th ${SENS[sensIdx].th}`;
}

// ---------- 保持螢幕常亮 ----------
let wakeLock = null;
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && joined) requestWakeLock(); });

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// 美術：球拍圖
loadAssets().then((a) => {
  if (a.controllerRacket) { const img = document.createElement('img'); img.src = a.controllerRacket.src; $('racket').replaceChildren(img); }
});

// 若網址帶房號就直接顯示加入畫面並聚焦按鈕
if (room) $('go').focus();
