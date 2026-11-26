# 分层深度（Hi-Z）遮挡剔除实验室

一个零运行时依赖的 JavaScript ES Module 项目：用软件光栅器生成**仅含可靠遮挡物**的深度，
构建 Hi-Z 金字塔，对候选包围体做保守的屏幕范围 + 深度查询，只在证据充分时把对象移出真实绘制列表。
内置可旋转相机的**光栅调试视窗**，实时显示层级查询、候选状态、实际可见集、深度层与无剔除参照对比。

---

## 1. 图形入口（主要交付物）

```bash
npm start                 # 等价于 node serve.js
# 打开 http://localhost:8123/   （/ 会 302 到 /web/）
```

也可以直接指定端口：`PORT=9000 node serve.js`，然后访问 `http://localhost:9000/web/`。
服务器是零依赖的 Node 静态服务器（`serve.js`），Node.js 22 验证通过；运行时不需要安装任何包。

### 视窗操作

| 操作 | 效果 |
| --- | --- |
| 左键拖拽 | 轨道旋转（yaw / pitch） |
| 滚轮 | 推拉距离（2.2–48） |
| 右键拖拽 或 Shift+拖拽 | 平移注视点 |
| 顶部场景页签 | 遮挡墙阵列 / 小孔窥视 / 复杂包围形状 |
| **遮挡剔除** 勾选框 | 实时开关剔除，与无剔除参照逐像素核对 |
| **自动旋转** | 缓慢环绕，观察连续裁决 |
| **冻结 Hi-Z** | 冻结当前深度证据，用于复现“旧金字塔”风险 |
| **模拟循环依据** | 故意把候选自身 bit 混入证据，验证自遮挡审计报警 |
| 右侧 Hi-Z 面板 | 切换线性深度 / 原始深度 / 来源 bit 着色，选择查看层级 |
| 候选表行 | 选中后在视口叠加包围线框与实际查询纹素热力格 |
| 运动界限滑杆 + 安全策略 | 调整允许的像素运动阈值（默认 4 texel），切换陈旧证据处理策略 |
| 运动面板证据行 | 显示当前深度层版本号、历史 occluded 缓存条数、本帧命中/适用范围失效计数 |
| 候选表缓存裁决 | 每行标注 `cache-hit / version-stale / scope-grew / depth-nearer / not-cached` |
| 底部扫描按钮 | 在页面内对当前场景或全部三场景跑真实 `verifyScene` 扫描 |

界面各区域全部来自真实运算：

- 左：480×270 软件光栅视口（提交绘制列表）、HUD、三角形/对象统计、运动界限裁决；
- 左下：**无剔除参照 / 开启剔除结果 / 逐像素差异**三张实时对比图；
- 右：Hi-Z 选中层大图与全部 mip 缩略图（标注尺寸）、候选裁决表（状态、参照像素、worst slack、查询层级/纹素数、来源遮挡物）；
- 底部：**实际可见集**与**本次被剔除集**的 uid chips，以及扫描报告。

任何真实漏显（被剔对象在参照中有像素）、像素差异或集合缺失都会把顶部异常条置为红色；
循环依据审计命中时为琥珀色警告；冻结证据超运动界限时给出陈旧风险提示。

---

## 2. 命令行（仅辅助）

```bash
npm test                 # node:test 20 项：约定、扫描、fuzz、运动界限、安全策略、
                         #   近面/屏幕边缘边界回归、证据版本失效、相机跳变×迟到查询回放、A→B→A 往返
npm run verify           # 全量验证：3 场景 × 292 机位 @480×270
node cli.js verify --quick            # 快速：3 场景 × 148 机位 @320×180
node cli.js verify --scene hole       # 只跑一个场景（wall|hole|complex）
npm run audit            # 遮挡物 bit 来源、每条剔除的证据链、合成循环依据抓捕
npm run stale            # 冻结金字塔 + 转镜头：复现旧深度漏显，并验证安全策略为零误剔
npm run bench            # 60 帧流水线/全量渲染耗时与跳过三角形统计
node cli.js list         # 列出场景
npm run probe:boundary   # 最小复现探针：近面跨越/屏幕边缘/相机跳变/近面临域
npm run probe:sweep      # 216 帧激进边界穷举（含遮挡物自身跨近面、状态迁移）
npm run probe:stale      # 非严重 requery 区间沿用旧 occluded 的漏绘排查
npm run smoke            # jsdom UI 接线冒烟（需 devDependency：npm install）
```

---

## 3. 内置场景（`src/scene.js`）

1. **wall 遮挡墙阵列**：主墙 + 两翼，8 个板条箱/球分布在墙后与墙侧。
   默认机位 10 个候选被判 occluded，绘制三角形 **1140 → 356**（遮挡跳过 736）。
2. **hole 小孔窥视**：四段遮挡墙留出一个小孔，孔后放置宝石（treasure）。
   宝石在参照中约 312 px，查询 slack 为负，因此**必须 submitted**——验证“孔中可见物不被整墙深度误杀”。
   默认 448 → 44 三角形。
3. **complex 复杂包围形状**：缩放凸包晶体、`compound` 组合包围体，以及一根
   **中心在墙后、左端伸出墙外的长梁 long-beam**。长梁参照中约 383 px，
   其完整顶点投影得到负 slack，不会因“中心点被挡”而被剔除。默认 704 → 352 三角形。

场景不提供任何“已知可见列表”；每个决定只来自当前镜头下有效深度金字塔的保守查询，
视锥外对象单独标记为 `outside-frustum`，不会被计入遮挡剔除成绩。

---

## 4. 方法与必须一致的约定

### 深度方向（全项目唯一约定）

相机空间 `z` 为沿视线向前的正值，深度缓冲值

```
d(z) = far/(far-near) · (1 - near/z) ∈ [0,1]，越小越近
```

投影、光栅插值（屏幕空间仿射 `1/z`）、Hi-Z 归约、查询比较全部使用这一约定，
并有单调测试（`depthFromZ(near)=0`，z 越大 d 越大）。

### Hi-Z 构造（`src/hiz.js`）

- level 0 来自遮挡 pass 的深度与遮挡物 bitmask（`Float32Array` + `Uint32Array`）；
- 每个父纹素深度 = 子纹素深度的 **max**（取最远遮挡面），mask = 子纹素 mask 的**按位 OR**；
- 奇数尺寸按 `ceil(w/2)` 建层。max 归约保证粗层深度只会更远，用它做“遮挡物足够近”的判定是保守的。

### 保守查询（`queryRect` / `classifyCandidate`，`src/pipeline.js`）

1. 视锥剔除先于一切：只有当包围体**所有**顶点在某一平面外侧时才判 `outside-frustum`；
2. 投影包围体的**全部顶点**（OBB/凸包用 8+ 顶点，球在查询时展开为相机对齐外接立方体的 8 角，
   compound 取各部件并集），屏幕矩形向整数纹素做 floor/ceil 外扩，天然保守；
3. 若包围体最近处 `zMin < near + ε` → **`near-fallback`**，绝不查询；
4. 若整数矩形碰到屏幕四边 → **`edge-fallback`**，绝不查询；
5. 按矩形跨度选择 mip（默认每轴最多约 12 纹素，`maxAxisTexels=12`，允许选更细层以提高剔除率），
   枚举覆盖到的**每一个**纹素；
6. 仅当每个纹素都满足
   `slack = dNear − cellMax ≥ depthMargin (2e-4)` **且** `cellMask ≠ 0`
   才判 `occluded`。任一纹素无遮挡来源、深度差不足，结果都是 submitted。

因此“中心点被挡”永远不足以推出整个对象被挡：证据必须覆盖完整投影矩形。

### 来源可追踪与循环依据审计

- 每个可靠遮挡物分配唯一 `bitIndex / occluderBit`，遮挡 pass 写入 mask，
  Hi-Z 每层 OR 归约；查询返回 `ownerBits`，界面与 `cli audit` 可列出实际贡献证据的遮挡物名；
- 正式流水线只允许 `reliableOccluder` 写深度，候选对象不写 Hi-Z，结构上不存在自证路径；
- `auditSelfEvidence(result, selfBit)` 会把证据 mask 与候选自身 bit 求交，
  命中即报“循环依据”。`cli audit` 与界面“模拟循环依据”用合成污染证据验证审计确实能抓到。

### 镜头运动界限与陈旧金字塔（`src/math3d.js` 的 `motionBound`）

冻结旧相机的 Hi-Z 后，把各遮挡物包围点分别用旧/新相机投影，
取屏幕位移的保守上界（`raw*1.5 + 1` px；任一点跨越近裁面则返回 `Infinity`）。
与用户阈值（默认 4 Hi-Z texel）比较，给出：

- `hold`：界限内，可继续使用旧证据；
- `requery`：超阈值，应重查（本实现每帧本来就重建当前证据）；
- `rebuild-requery`：出现近裁穿越等，必须重建金字塔。

陈旧证据有两种策略：默认**安全策略**把严重陈旧下的 `occluded` 全部降级为
`stale-blocked`（仍然提交绘制）；`apply-for-experiment` 仅供实验复现漏显，
界面与 CLI 会明确标注其结论不在零误剔声明范围内。

### 证据版本与历史遮挡结论适用范围（`src/hiz.js` + `src/occlusion-cache.js`）

每次由当前镜头重建 Hi-Z 都会取得单调递增的 `evidenceVersion`；冻结/迟到的旧金字塔
保留戳记版本号，不占新版本。跨帧的 `occlusionCache` 只缓存真正的 `occluded`
（near/edge/outside 等回退绝不缓存），每条结论带四项**适用范围**，全部满足才允许复用：

1. **证据版本一致**：深度层一旦重建，旧结论立即 `version-stale` 失效；
2. **屏幕范围覆盖**：旧查询矩形仍完整包住当前投影矩形，否则 `scope-grew`；
3. **深度不更近**：当前包围体最近深度不比旧结论更近（容差 `depthMargin`），否则 `depth-nearer`；
4. **无严重镜头位移**：运动界限判 `rebuild-requery`（含近裁穿越）时强制失效。

任一不满足，旧 `occluded` 降级为 `stale-blocked` 并强制提交，交当前深度层重查——
这就是“相机跳变 × 迟到查询交错回放”下首个可见帧不被旧值吞掉的结构性保证。
`replayWithLateQuery(stampCam, currentCam)` 先在戳记镜头写入带范围的历史结论，
再用同一版冻结证据跑迟到帧、最后重建当前帧，专门复现这条传播链；界面运动面板与
候选表实时显示版本号、缓存命中/失效计数与每条裁决原因。

---

## 5. 零误剔声明及其精确范围

“误剔除（false cull）”定义：被流水线标记为 `occluded` 并移出绘制列表的对象，
在**同机位、同分辨率、不做任何遮挡剔除**的全量参照渲染中存在至少 1 个 uid 像素。
校验同时比较：

- 每个对象的参照像素数；
- 开启/关闭剔除两帧的逐像素 RGBA 差异（要求 0）；
- 可见 uid 集合（要求完全相等，无 missing / extra）。

### 声明为零误剔的范围

**证据模式为 `current`（每帧用当前镜头的可靠遮挡物深度重建 Hi-Z）时**，在以下已执行验证内：

- `npm test`：20/20 通过，其中包括
  - 3 场景默认机位的像素/集合完全一致且确有遮挡发生；
  - **确定性扫描**：每场景每分辨率 148 机位
    （12 yaw × 4 pitch × 3 距离 + 2 近裁逼近 + 2 屏幕边缘专项），
    分别在 **320×180 与 480×270** 下零误剔、零像素差异、零集合差异；
  - **种子 fuzz**（mulberry32 seed `20261125`）：3 场景 × 48 个随机机位
    （全周 yaw、pitch −1.2…1.2、距离 2.2…24、随机 FOV/near/目标偏移）@480×270，
    共 144 帧全部像素一致、零误剔；
  - **保守查询边界回归**：可见小物体连续穿越近裁面（骑面帧必须 `near-fallback`、
    完全到近面后 `outside-frustum`，全程零漏绘）；投影矩形越过屏幕四边必须
    `edge-fallback` 且仍实际绘制；小物体从墙后连续移到墙外时 `occluded↔submitted`
    状态正确迁移，首个可见帧不被旧值吞掉；回退对象不计入遮挡剔除成绩；
  - **证据版本/适用范围**：Hi-Z 重建版本号单调递增，旧版本结论 `version-stale`、
    范围扩大 `scope-grew`、包围体变近 `depth-nearer` 全部失效，回退结论不进缓存；
  - **相机跳变 × 迟到查询回放**：迟到帧沿用戳记版本并因屏幕范围扩大失效、当前帧
    重建版本号恢复剔除，迟到/当前两条路径都零漏绘；
  - mask 来源纯净、长梁/宝石专项、运动界限 Infinity、安全陈旧策略等测试。
- `npm run verify`（完整 CLI）：3 场景 × **292** 机位
  （24 yaw × 4 pitch × 3 距离 + 4 专项）@480×270，共 876 个对比帧，
  全部 `误剔除=0 / 像素不一致帧=0 / 集合不一致帧=0`。

默认机位实测：wall 10 个 occluded（1140→356 三角形）、hole 3 个（448→44）、
complex 4 个（704→352），证明减少的是真实绘制工作而非仅做状态演示。

### 明确不在声明范围内的部分

- **冻结/陈旧证据实验模式**（`stalePolicy: 'apply-for-experiment'`）故意使用旧金字塔，
  `node cli.js stale` 会在 yaw +0.70 等机位复现出被参照渲染抓到的漏显；
  界面异常条同样会报红。这是被设计用来证明“看门狗有效”的反例。
  默认的**安全策略**在同一组运动下误剔仍为 0。
- 声明只覆盖上述三个内置场景、给定相机域与分辨率，以及本仓库的确定性软件光栅；
  `depthMargin = 2e-4` 提供了深度量化余量，但不构成对任意场景的形式化证明。

---

## 6. 目录结构

```
serve.js                 零依赖静态服务器（图形入口）
cli.js                   辅助 CLI：verify / audit / stale / bench / list
src/math3d.js            相机、右手基、投影、深度约定、运动界限
src/geometry.js          盒/球/凸包几何与各类保守包围体
src/raster.js            软件光栅器（depth/uid/mask/RGBA）
src/hiz.js               Hi-Z max/OR 归约、证据版本戳、保守矩形查询、循环审计
src/occlusion-cache.js   历史 occluded 适用范围缓存（版本/屏幕范围/深度/运动失效）
src/pipeline.js          候选分类、陈旧策略、缓存失效与相机跳放回放、绘制列表
src/scene.js             三个场景与遮挡物 bit 分配
src/verify.js            无剔除参照、像素/集合对比、相机扫描
web/index.html           调试视窗结构
web/styles.css           深色调试主题
web/app.js               视窗接线、实时对比、Hi-Z 绘制、缓存/版本状态、扫描
test/culler.test.js      node:test 测试套件（含近面/边缘边界回归与回放）
tools/boundary-probe.mjs 近面/边缘/相机跳变最小复现探针
tools/boundary-sweep.mjs 216 帧激进边界穷举（漏绘数 + 查询结论对照）
tools/stale-requery-probe.mjs 非严重 requery 区间旧结论漏绘排查
tools/dom-smoke.mjs      jsdom UI 接线冒烟（npm run smoke）
tools/pwshot.mjs         可选 Playwright 真实浏览器截图脚本
tools/png.mjs            零依赖 PNG 输出（调试快照用）
```
