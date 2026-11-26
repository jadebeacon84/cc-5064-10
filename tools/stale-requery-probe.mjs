// 定向复现：非 severe（requery）区间内沿用冻结旧 occluded 是否产生漏绘。
// 安全策略当前只拦截 severe；这里密集扫描小 yaw，让运动界限保持在阈值内，
// 再用无剔除参照核对旧证据剔除集。
import { makeOrbitCamera } from '../src/math3d.js';
import { createScenes } from '../src/scene.js';
import { runPipeline } from '../src/pipeline.js';
import { renderAll } from '../src/verify.js';
import { countUidPixels } from '../src/raster.js';

const W = 480;
const H = 270;

for (const sceneId of ['wall', 'hole', 'complex']) {
  const scene = createScenes().find((s) => s.id === sceneId);
  const cam0 = makeOrbitCamera({ ...scene.camera, aspect: W / H });
  const fresh = runPipeline(scene, cam0, W, H);
  const frozen = { hiZ: fresh.hiZ, camera: cam0 };
  console.log(`\n== 场景 ${sceneId}：高 moveLimit=64，扫描非 severe 小转角 ==`);
  let found = 0;
  for (let yaw = 0.001; yaw <= 0.05; yaw += 0.001) {
    const cam = makeOrbitCamera({ ...scene.camera, yaw, aspect: W / H });
    const pipe = runPipeline(scene, cam, W, H, { frozenEvidence: frozen, moveLimitTexels: 64 });
    if (pipe.motion.severe) continue;
    const ref = renderAll(scene, cam, W, H);
    const counts = countUidPixels(ref);
    const bad = pipe.culled.filter((o) => (counts.get(o.uid) ?? 0) > 0);
    if (bad.length) {
      found++;
      console.log(`  yaw=${yaw.toFixed(3)} decision=${pipe.motion.decision} bound=${pipe.motion.boundPx.toFixed(1)} 漏绘:`,
        bad.map((o) => `${o.id}(ref=${counts.get(o.uid)}px)`).join(', '));
    }
  }
  console.log(` 非 severe 区间旧结论漏绘机位：${found}`);
}
