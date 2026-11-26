// 激进边界扫描：在连续机位上穷举近面跨越与屏幕边缘跨越，
// 并让可靠遮挡物本身跨越近裁面（Hi-Z 层证据会缺角），逐帧与参照对照。
import { makeOrbitCamera, makeCamera, basis, viewCoords } from '../src/math3d.js';
import { createScenes } from '../src/scene.js';
import { boxGeometry, transformPositions, boxBounds } from '../src/geometry.js';
import { compareFrame, renderAll } from '../src/verify.js';
import { runPipeline } from '../src/pipeline.js';
import { countUidPixels } from '../src/raster.js';

const W = 480;
const H = 270;
let uid = 2000;
function probeBox(pos, size, id) {
  const g = boxGeometry(size, size, size);
  return {
    id, name: id,
    positions: transformPositions(g.positions, { position: pos }),
    indices: g.indices,
    bounds: boxBounds(size, size, size, { position: pos }),
    reliableOccluder: false, candidate: true, uid: uid++, color: [230, 120, 90],
  };
}

let totalFrames = 0;
let totalFalseCulls = 0;
let totalPxBad = 0;
const statusSeen = new Map();
const note = (s) => statusSeen.set(s, (statusSeen.get(s) ?? 0) + 1);

function check(scene, cam, label) {
  const f = compareFrame(scene, cam, W, H);
  totalFrames++;
  totalFalseCulls += f.falseCulls.length;
  if (f.pixelDiff !== 0) totalPxBad++;
  for (const d of f.pipe.decisions.values()) note(d.status);
  if (f.falseCulls.length || f.pixelDiff) {
    console.log(`  !! ${label} falseCulls=${f.falseCulls.length} pxDiff=${f.pixelDiff}`,
      f.falseCulls.slice(0, 2));
  }
  return f;
}

console.log('== E. 屏幕边缘穷举：小箱从屏内一路平移到屏外（含矩形恰贴边/越界）==');
const base = createScenes().find((s) => s.id === 'wall');
for (let x = 1.5; x <= 16; x += 0.25) {
  const scene = { ...base, objects: [...base.objects, probeBox([x, 1.2, -1.6], 0.5, 'edge-box')] };
  const cam = makeOrbitCamera({ ...base.camera, aspect: W / H });
  check(scene, cam, `edge x=${x.toFixed(2)}`);
}
// 纵向贴边
for (let y = -1; y <= 6; y += 0.25) {
  const scene = { ...base, objects: [...base.objects, probeBox([3.0, y, -1.6], 0.5, 'edge-box-y')] };
  const cam = makeOrbitCamera({ ...base.camera, aspect: W / H });
  check(scene, cam, `edge y=${y.toFixed(2)}`);
}

console.log('== F. 小物体从墙后（应被遮挡）连续穿过边缘到墙外可见：状态迁移不得停在错误 occluded ==');
for (let x = -4.5; x <= 8; x += 0.2) {
  const scene = { ...base, objects: [...base.objects, probeBox([x, 0.9, -3.4], 0.7, 'travel-box')] };
  const cam = makeOrbitCamera({ ...base.camera, aspect: W / H });
  check(scene, cam, `travel x=${x.toFixed(2)}`);
}

console.log('== G. 近裁面连续扫描：自由相机沿视线推进，小箱 zMin 扫过 near ==');
for (let zEye = 4.0; zEye >= 0.12; zEye -= 0.08) {
  const scene = { ...base, objects: [...base.objects, probeBox([0, 1.2, 0], 0.6, 'near-box')] };
  const cam = makeCamera([0, 1.2, zEye], [0, 1.2, -1], { aspect: W / H, near: 0.5, far: 80 });
  check(scene, cam, `near zEye=${zEye.toFixed(2)}`);
}

console.log('== H. 遮挡物自身跨近面：相机推近主墙，Hi-Z 证据缺角时小物不得被误剔 ==');
for (const dist of [12, 9, 6, 4.5, 3.5, 2.8, 2.3, 1.9, 1.6]) {
  const scene = { ...base, objects: [...base.objects, probeBox([1.5, 1.0, -2.6], 0.6, 'near-wall-box')] };
  const cam = makeOrbitCamera({ target: [0, 1.7, -1.2], yaw: 0.1, pitch: 0.1, distance: dist, aspect: W / H, near: 0.1 });
  check(scene, cam, `occluder-near dist=${dist}`);
}

console.log('== I. 小位移陈旧证据（非 severe 的 requery 区间）：高 moveLimit 下旧结论仍不得吞可见帧 ==');
const cam0 = makeOrbitCamera({ ...base.camera, aspect: W / H });
const fresh = runPipeline(base, cam0, W, H);
const frozen = { hiZ: fresh.hiZ, camera: cam0 };
for (const yaw of [0.002, 0.006, 0.01, 0.018, 0.025, 0.04, 0.06]) {
  const cam = makeOrbitCamera({ ...base.camera, yaw, aspect: W / H });
  const pipe = runPipeline(base, cam, W, H, { frozenEvidence: frozen, moveLimitTexels: 64 });
  const ref = renderAll(base, cam, W, H);
  const counts = countUidPixels(ref);
  const bad = pipe.culled.filter((o) => (counts.get(o.uid) ?? 0) > 0);
  totalFrames++;
  totalFalseCulls += bad.length;
  if (bad.length) console.log(`  !! stale yaw=${yaw} 漏绘 ${bad.length}`, bad.map((b) => b.id));
  console.log(` yaw=${yaw} decision=${pipe.motion.decision} bound=${Number.isFinite(pipe.motion.boundPx) ? pipe.motion.boundPx.toFixed(1) : '∞'} culled=${pipe.stats.occluded} blocked=${pipe.stats.staleBlocked} staleFalseCull=${bad.length}`);
}

console.log(`\n激进扫描：帧 ${totalFrames}，漏绘事件 ${totalFalseCulls}，像素不一致帧 ${totalPxBad}`);
console.log('状态分布：', JSON.stringify(Object.fromEntries(statusSeen)));
process.exit(totalFalseCulls || totalPxBad ? 1 : 0);
