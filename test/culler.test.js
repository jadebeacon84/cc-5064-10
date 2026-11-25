import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createScenes } from '../src/scene.js';
import { makeOrbitCamera, basis, projectWorld, depthFromZ, motionBound } from '../src/math3d.js';
import { buildHiZ } from '../src/hiz.js';
import { runPipeline } from '../src/pipeline.js';
import { compareFrame, verifyScene } from '../src/verify.js';
import { renderAll } from '../src/verify.js';
import { countUidPixels } from '../src/raster.js';

const W = 480;
const H = 270;

test('相机基向量保持右手系且画面不水平镜像', () => {
  const cam = makeOrbitCamera({ target: [0, 0, 0], yaw: 0, pitch: 0, distance: 10, aspect: W / H });
  const b = basis(cam);
  assert.ok(b.r[0] > 0.99, '默认机位 right 应指向 +X');
  assert.ok(b.u[1] > 0.99, 'up 应指向 +Y');
  const p = projectWorld([2, 0, 0], cam, b, W, H);
  assert.ok(p.ndcX > 0, '+X 点应投影到屏幕右侧');
});

test('深度约定单调：z 越大深度值越大（越远）', () => {
  const cam = makeOrbitCamera({ aspect: 1 });
  assert.ok(depthFromZ(2, cam) < depthFromZ(5, cam));
  assert.ok(depthFromZ(cam.near, cam) === 0);
});

test('Hi-Z 归约为 max，且粗层不小于细层对应值', () => {
  const depth = new Float32Array([0.2, 0.8, 0.4, 0.6]);
  const mask = new Uint32Array([1, 2, 1, 2]);
  const hiZ = buildHiZ(depth, mask, 2, 2);
  assert.ok(Math.abs(hiZ.levels[1].depth[0] - 0.8) < 1e-6);
  assert.equal(hiZ.levels[1].mask[0], 3);
});

test('三个场景默认机位：像素一致、集合一致且确实发生遮挡剔除', () => {
  for (const scene of createScenes()) {
    const cam = makeOrbitCamera({ ...scene.camera, aspect: W / H });
    const f = compareFrame(scene, cam, W, H);
    assert.equal(f.falseCulls.length, 0, `${scene.id} 不应有误剔`);
    assert.equal(f.pixelDiff, 0, `${scene.id} 开启/关闭剔除应像素一致`);
    assert.equal(f.setMissing.length, 0);
    assert.equal(f.setExtra.length, 0);
    assert.ok(f.pipe.stats.occluded >= 1, `${scene.id} 默认机位应至少剔除 1 个对象以减少实际绘制`);
    assert.ok(f.pipe.stats.skippedOcclusionTris > 0);
  }
});

test('小孔场景：宝石在参照中可见且绝不被剔除', () => {
  const scene = createScenes().find((s) => s.id === 'hole');
  const cam = makeOrbitCamera({ ...scene.camera, aspect: W / H });
  const f = compareFrame(scene, cam, W, H);
  const treasure = scene.objects.find((o) => o.id === 'treasure');
  assert.ok((f.refCounts.get(treasure.uid) ?? 0) > 80, '宝石应透过小孔有明显像素');
  const d = f.pipe.decisions.get(treasure.uid);
  assert.notEqual(d.status, 'occluded');
  assert.ok(!f.pipe.culled.includes(treasure));
});

test('复杂场景：中心被挡但端部外露的长梁不被中心点逻辑误剔', () => {
  const scene = createScenes().find((s) => s.id === 'complex');
  const cam = makeOrbitCamera({ ...scene.camera, aspect: W / H });
  const f = compareFrame(scene, cam, W, H);
  const beam = scene.objects.find((o) => o.id === 'long-beam');
  assert.ok((f.refCounts.get(beam.uid) ?? 0) > 0, '长梁端部应在参照中可见');
  assert.notEqual(f.pipe.decisions.get(beam.uid).status, 'occluded');
});

test('正式 Hi-Z 来源只包含可靠遮挡物 bit', () => {
  const scene = createScenes()[0];
  const cam = makeOrbitCamera({ ...scene.camera, aspect: W / H });
  const pipe = runPipeline(scene, cam, W, H);
  const allowed = scene.objects.filter((o) => o.reliableOccluder).reduce((m, o) => m | o.occluderBit, 0) >>> 0;
  const m0 = pipe.hiZ.levels[0].mask;
  for (let i = 0; i < m0.length; i++) {
    assert.equal(m0[i] & ~allowed, 0, `纹素 ${i} 含非法来源 bit`);
  }
});

test('确定性扫描（12 yaw × 4 pitch × 3 距离 + 专项）零误剔，320p 与 480p', () => {
  for (const width of [320, 480]) {
    for (const scene of createScenes()) {
      const r = verifyScene(scene, { yawSteps: 12, width, height: Math.round(width * 9 / 16) });
      assert.equal(r.falseCullEvents, 0, `${width} ${scene.id} falseCull`);
      assert.equal(r.pixelMismatchFrames, 0, `${width} ${scene.id} pixel`);
      assert.equal(r.setMismatchFrames, 0, `${width} ${scene.id} set`);
      assert.ok(r.framesWithOcclusion > 0);
    }
  }
});

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('种子随机机位 fuzz：任意俯仰/距离/FOV 下仍零误剔', () => {
  const rnd = mulberry32(20261125);
  let frames = 0;
  for (const scene of createScenes()) {
    for (let i = 0; i < 48; i++) {
      const yaw = rnd() * Math.PI * 2;
      const pitch = -1.2 + rnd() * 2.4;
      const dist = 2.2 + rnd() * 22;
      const t = scene.camera.target;
      const cp = Math.cos(pitch);
      const eye = [
        t[0] + Math.sin(yaw) * cp * dist + (rnd() - 0.5) * 3,
        t[1] + Math.sin(pitch) * dist + (rnd() - 0.5) * 2,
        t[2] + Math.cos(yaw) * cp * dist + (rnd() - 0.5) * 3,
      ];
      const target = [t[0] + (rnd() - 0.5) * 4, t[1] + (rnd() - 0.5) * 2, t[2] + (rnd() - 0.5) * 4];
      const cam = makeOrbitCamera({
        target, yaw: 0, pitch: 0.1, distance: 10, aspect: W / H, // placeholder 被下面自由相机替代
      });
      Object.assign(cam, {
        kind: 'free', eye, target, yaw, pitch, distance: dist,
        fovY: Math.PI / 3 * (0.85 + rnd() * 0.4), near: rnd() < 0.2 ? 0.05 : 0.1, far: 80,
      });
      const f = compareFrame(scene, cam, W, H);
      frames++;
      assert.equal(f.falseCulls.length, 0, `fuzz ${scene.id} frame ${i}: ${JSON.stringify(f.falseCulls[0])}`);
      assert.equal(f.pixelDiff, 0, `fuzz ${scene.id} frame ${i} pixelDiff=${f.pixelDiff}`);
    }
  }
  assert.ok(frames > 100);
});

test('运动界限：点跑到近裁面之后返回 Infinity', () => {
  const c0 = makeOrbitCamera({ target: [0, 0, 0], yaw: 0, distance: 10, aspect: 1 });
  const c1 = makeOrbitCamera({ target: [0, 0, 0], yaw: 2.8, distance: 1.2, aspect: 1 });
  const mb = motionBound(c0, c1, [[0, 0, 0], [1, 0, 0]], W, H);
  assert.ok(!Number.isFinite(mb.pixels) || mb.pixels > 50);
});

test('陈旧证据安全策略：越界旋转后不产生实际误剔', () => {
  const scene = createScenes()[0];
  const cam0 = makeOrbitCamera({ ...scene.camera, aspect: W / H });
  const fresh = runPipeline(scene, cam0, W, H);
  const frozen = { hiZ: fresh.hiZ, camera: cam0 };
  for (const yaw of [0.1, 0.3, 0.6]) {
    const cam = makeOrbitCamera({ ...scene.camera, yaw, aspect: W / H });
    const safe = runPipeline(scene, cam, W, H, { frozenEvidence: frozen });
    const ref = renderAll(scene, cam, W, H);
    const counts = countUidPixels(ref);
    for (const o of safe.culled) assert.equal(counts.get(o.uid) ?? 0, 0, '安全策略下陈旧证据不得误剔');
  }
});
