# 🎾 手機球拍對戰（Mobile Sensing Game）

把手機當成球拍的體感對戰遊戲。手機透過瀏覽器讀取加速度計 / 陀螺儀偵測揮拍，
電視或電腦的瀏覽器顯示完整球場、雙方球員與球的飛行；同一個房號可以在**多台螢幕**同時開啟顯示端，
雙方各看各的螢幕（各自的視角）對戰。不需要安裝 App。

```
手機 A ──┐                        ┌── 螢幕 1（A 視角）
         ├─ WebSocket ─ 伺服器 ───┼── 螢幕 2（B 視角）
手機 B ──┘   （物理 / 規則）       └── 螢幕 3（俯視）
```

## 快速開始

```bash
npm install
npm start
```

1. 電視或電腦開 `http://<伺服器IP>:8443/display`，畫面會顯示房號與 QR code。
2. 兩支手機掃 QR code（或開 `/controller` 輸入房號），選 A 方或 B 方，按「加入並開啟感測器」。
3. 兩人都加入後自動開始。發球方揮手機發球，之後球飛向誰，誰就在球接近時揮拍。
4. 要多螢幕：在其他裝置開 `http://<伺服器IP>:8443/display?room=房號&side=B`（`side` 可為 `A`、`B`、`top`）。

顯示端快捷鍵：`F` 全螢幕、`R` 重新開始。手機上也可以「點一下揮拍」（桌機測試用空白鍵）。

## iPhone 需要 HTTPS

iOS Safari 只允許 HTTPS 網頁讀取動作感測器。區網測試請用 [mkcert](https://github.com/FiloSottile/mkcert) 產生憑證：

```bash
mkcert -install
mkdir -p certs
mkcert -key-file certs/key.pem -cert-file certs/cert.pem localhost 192.168.x.x
npm start
```

`certs/` 裡有 `key.pem` 與 `cert.pem` 時伺服器會自動改用 HTTPS（同一個 8443 埠）。
手機要先安裝 mkcert 的根憑證（iOS：設定 → 一般 → VPN 與裝置管理，然後在「憑證信任設定」開啟）。
也可以直接部署到任何提供 HTTPS 的主機（Render、Fly.io、Railway 等），用 `PORT` 環境變數指定埠。

## 遊戲機制

- **揮拍偵測**（`public/controller.js`）：加速度大小超過門檻進入揮拍、低於門檻後送出一次 `swing`，包含六個參數：
  - `strength` 力道：加速度峰值。
  - `dirX` 揮動方向：陀螺儀繞手機長軸。
  - `face` 拍面角度：由 DeviceOrientation 建旋轉矩陣，取螢幕法線的水平方位，相對「加入時 / 按校正時正對電視」的基準，±45° 對應 ±1。
  - `loft` 拍面仰角：螢幕法線的垂直分量，手機往後躺就是開拍面。
  - `plane` 揮拍平面：揮拍加速階段的加速度向量轉到世界座標，看垂直與水平的夾角，由下往上撈為正、由上往下劈為負。
  - `spin` 手腕翻轉：陀螺儀繞手機短軸，往下壓上旋、往上甩下旋。
  - `curve` 側旋：陀螺儀繞螢幕法線（像削球那樣側向刷）。

  可調靈敏度、左右鏡像、重新校正拍面方向。桌機測試：空白鍵平擊、↑ 撈球、↓ 劈球、← → 拍面左右、Z 上旋、X 下旋、Q/E 側旋、WASD 移動。
- **開局校正**：按加入後先進入校正畫面，用準備姿勢握手機、正對電視按「完成校正」。這個姿勢是拍面方向與移動的基準。
- **跑位**：目前為全自動（角色自動跑向來球，拍頭對準球）。手機姿態控制移動的程式仍在，`server/game.js` 與 `public/controller.js` 的 `MANUAL_MOVE` 改為 true 即可啟用（±7.5° 不動、7.5~20° 慢走、20° 以上正常速度）。
- **物理與規則**（`server/game.js`）：伺服器權威。球有 3D 位置與重力、過網判定、落地出界判定、
  兩次落地失分。擊球時：
  - 落點左右 = 拍面角度（主）+ 揮動方向（輔），以球員自己的左右為準（A、B 自動對稱）。
  - 弧線 = 揮拍平面（主）+ 拍面仰角 + 手腕翻轉。撈球較慢、較高、較深；劈球較快、較平、更深，時機差就掛網。
  - 擊球時機（球距理想擊球點的誤差）影響深度與左右，太早太晚就出界或掛網。
  - 旋球用馬格努斯效應呈現：上旋出手較高、空中明顯下墜、落地彈高往前竄；下旋出手平、空中飄、落地低且慢；側旋在空中側向彎。拖尾顏色：上旋橘、下旋藍、側旋紫。

  網球計分（0/15/30/40/Ad，6 局勝）。
- **球員移動**：手機無法定位真實位置，採自動跑位（Wii Sports 式），移動為 8 方向並有走路動畫。
- **落點**：輕揮約 2.5 m 的網前短球，全力約 10 m；壓線算進（球心超出線外 12 cm 內都算界內）。
- **顯示端**（`public/display.js`）：Canvas 2D，A/B 視角是從球員後上方的透視投影（俯視球場圖用水平條帶貼到地面），`top` 為俯視。30 Hz 狀態廣播 + 本地外插。

## 美術資源

目前畫面全部是程式畫的佔位圖。美術工單在 **`docs/CODEX_ART_TICKETS.md`**，
檔案放進 `public/assets/`（檔名依 `public/assets/manifest.json`）就會自動替換，不用改程式。

## 專案結構

```
server/index.js     HTTP(S) 靜態檔 + WebSocket 房間 + 60Hz 主迴圈
server/game.js      物理、規則、計分、自動跑位
public/index.html   入口
public/display.*    顯示端（電視 / 電腦）
public/controller.* 手機控制器（球拍）
public/common.js    WebSocket 重連、資源載入
public/assets/      美術資源（manifest.json 定義檔名）
docs/               工單與文件
```
