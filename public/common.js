// 共用：WebSocket 自動重連
export function connect(onMessage, onOpen) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws, closed = false, timer;
  const api = {
    send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); },
    close() { closed = true; clearTimeout(timer); ws?.close(); },
    get open() { return ws?.readyState === 1; },
  };
  function open() {
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => onOpen?.(api);
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data), api); } catch (err) { console.error(err); } };
    ws.onclose = () => { if (!closed) timer = setTimeout(open, 1000); };
    ws.onerror = () => ws.close();
  }
  open();
  return api;
}

export function qs(name, def = null) {
  return new URLSearchParams(location.search).get(name) ?? def;
}

// 載入美術資源；缺檔時回傳 null，由程式畫佔位圖
export async function loadAssets(manifestUrl = '/assets/manifest.json') {
  const out = {};
  let manifest = {};
  try { manifest = await (await fetch(manifestUrl)).json(); } catch { return out; }
  await Promise.all(Object.entries(manifest.images || {}).map(([key, file]) => new Promise((res) => {
    const img = new Image();
    img.onload = () => { out[key] = img; res(); };
    img.onerror = () => { out[key] = null; res(); };
    img.src = `/assets/${file}`;
  })));
  out.__manifest = manifest;
  return out;
}
