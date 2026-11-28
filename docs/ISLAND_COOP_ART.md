# 《島口大開》多人闖關美術交接

將這份交接提供給負責程式的 session。素材位於 `public/assets/island/`。若沿用既有靜態目錄，瀏覽器載入根路徑為 `/assets/island/`。

## 多人闖關

| 用途 | 檔案 | 節點與接法 |
|---|---|---|
| 玩家 1～4 | `repairer-blue.glb`、`repairer-orange.glb`、`repairer-purple.glb`、`repairer-green.glb` | 四色共用尺寸和零件。用 `Arm_L`、`Arm_R`、`Leg_L`、`Leg_R` 接現有動畫。 |
| 近戰怪 | `mob-melee.glb` | 紅色矮殼、前伸雙爪，適合成群讀取。動作節點為 `Head`、`Claw_L`、`Claw_R`、`Foot_L`、`Foot_R`。 |
| 遠程怪 | `mob-ranged.glb` | 紫色懸浮晶體，前方發光眼睛可做蓄力。節點 `HoverBody` 可上下擺動，`Fin_L`、`Fin_R` 可轉動。從 `ProjectileSocket` 取世界座標生成 `enemy-orb.glb`。 |
| 衝撞精英 | `mob-charger.glb` | 寬體履帶、橘色撞板、發光紅眼。用 `RamGuard` 做蓄力姿勢與撞擊回彈，`ChargeLight` 可做蓄力閃爍。 |
| 關卡門 | `stage-gate.glb` | `GateCenter` 用於光幕及通關提示定位。通行碰撞由關卡規則控制。 |
| 升級台 | `upgrade-shrine.glb` | `CrystalPivot` 可旋轉；出現時用外擴光圈提示全隊可升級。畫面上每位玩家仍有自己的選項。 |
| 最終 Boss | `chomp-boss.glb` | 沿用既有 `UpperJaw`、`Jaw`、`Core`、`BrickSocket`。咬地板時前置顯示地面範圍，露弱點時開啟 `Core`。 |

技能圖示在 `public/assets/island/skills/`。依序用 `ground-slam.svg`（震地）、`chain-hammer.svg`（連鎖槌）、`whirlwind-step.svg`（旋風步）、`ally-guard.svg`（護友）。在共享螢幕上將圖示與技能名稱一起顯示。

GLB 採 Y-up，角色與怪物視覺正面朝 +Z。站立模型原點在腳底，懸浮怪原點在它正下方的地面，投射物原點在中心。模型無外部貼圖與預烘動畫。維持既有物理範圍，依需要調整視覺模型比例。

`coop-art-preview.png` 是比例與造型預覽。第一關可用近戰怪示範清怪，第二關加浮游遠程怪，第三關加入衝撞精英，最後使用既有巨怪模型。
