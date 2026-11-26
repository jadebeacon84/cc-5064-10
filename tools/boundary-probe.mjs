// 保守查询漏洞探针（最小复现）：
//   A. 可见小物体从镜头前穿越近裁面（包围体 zMin 由 >near 变成 <near）；
//   B. 同一小物体横向移动，投影矩形逐步越过屏幕边缘；
//   C. 相机跳变 + 迟到/旧查询交错：历史 occluded 结论在新镜头是否被错误沿用。
// 每个机位都与无剔除参照逐像素、可见集合对照，记录漏绘数与查询结论。
// 用法：node tools/boundary-probe.mjs

import { makeOrbitCamera, makeCamera, basis, viewCoords, depthFromZ } from '../src/math3d.js';
import { createScenes } from '../src/scene.js';
import { boxGeometry, sphereGeometry, transformPositions, boxBounds, sphereBounds } from '../src/geometry.js';
import { runPipeline, classifyCandidate, STATUS } from '../src/pipeline.js';
import { compareFrame, renderAll } from '../src/verify.js';
import { countUidPixels, createRenderTarget, clearTarget, renderScene } from '../src/raster.js';
import { buildHiZ } from '../src/hiz.js';

const W = 480;
const H = 270;

let uid = 1000;
function smallBox(pos, size = 0.5) {
  const g = boxGeometry(size, size, size);
  return {
    id: 'probe-box', name: '穿越小箱',
    positions: transformPositions(g.positions, { position: pos }),
    indices: g.indices,
    bounds: boxBounds(size, size, size, { position: pos }),
    reliableOccluder: false, candidate: true,
    uid: uid++, color: [230, 120, 90],
  };
}

function wallSceneWithProbe(probePos) {
  const scene = createScenes().find((s) => s.id === 'wall');
  const clone = { ...scene, objects: scene.objects.slice() };
  clone.objects.push(smallBox(probePos));
  return clone;
}

function summarize(tag, scene, cam, opts = {}) {
  const f = compareFrame(scene, cam, W, H, opts);
  const probe = scene.objects.find((o) => o.id === 'probe-box');
  const d = f.pipe.decisions.get(probe.uid);
  const refPx = f.refCounts.get(probe.uid) ?? 0;
  const onPx = f.onCounts.get(probe.uid) ?? 0;
  return {
    tag, refPx, onPx, pixelDiff: f.pixelDiff,
    status: d.status, culled: d.cull,
    zMin: d.zMin, rect: d.rect, dNear: d.dNear,
    level: d.query?.level ?? null, tested: d.query?.testedCount ?? 0,
    worstSlack: d.query?.worstSlack ?? null,
    falseCulls: f.falseCulls.length,
  };
}

console.log('== A. 近裁面跨越：小箱沿视线从墙后推向镜头 ==');
const near = 0.1;
// 目标点固定在墙前，distance 递减使相机穿过小箱附近；小箱放在相机默认视线略偏的位置，保证部分帧可见。
let aFail = 0;
for (const dist of [13, 8, 5, 3.2, 2.4, 1.8, 1.4, 1.0, 0.8, 0.6, 0.45, 0.3, 0.2, 0.15]) {
  const target = [0, 1.4, -1.2];
  const cam = makeOrbitCamera({ target, yaw: 0.06, pitch: 0.08, distance: dist, aspect: W / H, near });
  // 小箱固定在世界空间、靠近注视点；相机推近时它会跨越近裁面。
  const scene = wallSceneWithProbe([0.9, 1.2, -0.6]);
  const r = summarize(`dist=${dist}`, scene, cam);
  const bad = r.falseCulls > 0 || r.pixelDiff > 0;
  if (bad) aFail++;
  console.log(
    ` dist=${String(dist).padEnd(5)} zMin=${r.zMin === null ? '–' : r.zMin.toFixed(3)} ` +
    `status=${String(r.status).padEnd(16)} ref=${String(r.refPx).padEnd(4)} on=${String(r.onPx).padEnd(4)} ` +
    `pxDiff=${r.pixelDiff} ${bad ? '<< 漏绘!' : 'ok'}`,
  );
}

console.log('\n== B. 屏幕边缘跨越：小箱横向平移，投影矩形从屏内走到屏外 ==');
let bFail = 0;
const base = createScenes().find((s) => s.id === 'wall');
for (const x of [2, 3.5, 4.8, 5.6, 6.2, 6.8, 7.4, 8.2, 9.5, 12]) {
  const scene = wallSceneWithProbe([x, 1.2, -1.6]);
  const cam = makeOrbitCamera({ ...base.camera, aspect: W / H });
  const r = summarize(`x=${x}`, scene, cam);
  const bad = r.falseCulls > 0 || r.pixelDiff > 0;
  if (bad) bFail++;
  const rect = r.rect ? `[${r.rect.x0},${r.rect.y0},${r.rect.x1},${r.rect.y1}]` : '–';
  console.log(
    ` x=${String(x).padEnd(5)} status=${String(r.status).padEnd(16)} rect=${String(rect).padEnd(22)} ` +
    `ref=${String(r.refPx).padEnd(4)} pxDiff=${r.pixelDiff} ${bad ? '<< 漏绘!' : 'ok'}`,
  );
}

console.log('\n== C. 相机跳变 × 冻结旧证据：历史 occluded 不得吞掉新镜头首个可见帧 ==');
const cScene = createScenes().find((s) => s.id === 'wall');
const cam0 = makeOrbitCamera({ ...cScene.camera, aspect: W / H });
const fresh = runPipeline(cScene, cam0, W, H);
const frozen = { hiZ: fresh.hiZ, camera: cam0, version: fresh.evidenceVersion ?? null };
let cFail = 0;
for (const yaw of [0.0, 0.05, 0.15, 0.35, 0.7, 1.2, 2.4]) {
  const cam = makeOrbitCamera({ ...cScene.camera, yaw, aspect: W / H });
  // 交错：同一新镜头先跑冻结旧证据（迟到查询），再跑当前证据。
  const stale = runPipeline(cScene, cam, W, H, { frozenEvidence: frozen });
  const curr = compareFrame(cScene, cam, W, H);
  const ref = renderAll(cScene, cam, W, H);
  const counts = countUidPixels(ref);
  const staleBad = stale.culled.filter((o) => (counts.get(o.uid) ?? 0) > 0);
  const bad = staleBad.length > 0 || curr.pixelDiff > 0;
  if (bad) cFail++;
  console.log(
    ` yaw=${String(yaw).padEnd(4)} motion=${String(stale.motion.decision).padEnd(15)} ` +
    `severe=${stale.motion.severe} 旧证据实际剔除=${stale.stats.occluded} 旧证据漏绘=${staleBad.length} ` +
    `当前帧pxDiff=${curr.pixelDiff} ${bad ? '<< 问题' : 'ok'}`,
  );
}

console.log('\n== D. 近面穿越专项：包围体恰好骑在近裁面上（zMin 在 near±ε 邻域）==');
let dFail = 0;
// 自由相机直接控制 eye，使小箱相对相机的最近深度扫过 near。
for (const zEye of [2.0, 1.5, 1.0, 0.75, 0.62, 0.55, 0.5, 0.45, 0.3]) {
  const scene = wallSceneWithProbe([0, 1.2, 0]);
  const cam = makeCamera([0, 1.2, zEye], [0, 1.2, -1], { aspect: W / H, near: 0.5, far: 80 });
  const f = compareFrame(scene, cam, W, H);
  const probe = scene.objects.find((o) => o.id === 'probe-box');
  const d = f.pipe.decisions.get(probe.uid);
  const b = basis(cam);
  const zs = probe.bounds.vertices.map((p) => viewCoords(p, cam, b).z);
  const zMin = Math.min(...zs);
  const bad = f.falseCulls.length > 0 || f.pixelDiff > 0;
  if (bad) dFail++;
  console.log(
    ` zEye=${String(zEye).padEnd(5)} boundZMin=${zMin.toFixed(3)} near=0.5 status=${String(d.status).padEnd(16)} ` +
    `ref=${f.refCounts.get(probe.uid) ?? 0} pxDiff=${f.pixelDiff} ${bad ? '<< 漏绘!' : 'ok'}`,
  );
}

const totalFail = aFail + bFail + cFail + dFail;
console.log(`\n探针结论：A近面=${aFail} B边缘=${bFail} C陈旧=${cFail} D近面临域=${dFail}，合计异常 ${totalFail}`);
process.exit(totalFail ? 1 : 0);
