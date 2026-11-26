import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createScenes } from '../src/scene.js';
import { makeOrbitCamera, makeCamera, basis, projectWorld, depthFromZ, motionBound, viewCoords } from '../src/math3d.js';
import { buildHiZ, nextEvidenceVersion, currentEvidenceVersion } from '../src/hiz.js';
import { runPipeline, replayWithLateQuery } from '../src/pipeline.js';
import { compareFrame, verifyScene } from '../src/verify.js';
import { renderAll } from '../src/verify.js';
import { countUidPixels } from '../src/raster.js';
import { boxGeometry, transformPositions, boxBounds } from '../src/geometry.js';
import { createOcclusionCache, CACHE_DECISION } from '../src/occlusion-cache.js';

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

// ---------- 保守查询边界回归（近面跨越 / 屏幕边缘 / 相机跳变回放）----------

let PROBE_UID = 9000;
function probeBox(pos, size, id = 'probe-box') {
  const g = boxGeometry(size, size, size);
  return {
    id, name: id,
    positions: transformPositions(g.positions, { position: pos }),
    indices: g.indices,
    bounds: boxBounds(size, size, size, { position: pos }),
    reliableOccluder: false, candidate: true,
    uid: PROBE_UID++, color: [230, 120, 90],
  };
}

function withProbe(base, probe) {
  return { ...base, objects: [...base.objects, probe] };
}

test('边界回归：可见小物体连续穿越近裁面时绝不漏绘，跨面帧走 near-fallback', () => {
  const base = createScenes().find((s) => s.id === 'wall');
  let nearFallbackSeen = 0;
  let frames = 0;
  for (let zEye = 4.0; zEye >= 0.12; zEye -= 0.08) {
    const scene = withProbe(base, probeBox([0, 1.2, 0], 0.6));
    const cam = makeCamera([0, 1.2, zEye], [0, 1.2, -1], { aspect: W / H, near: 0.5, far: 80 });
    const f = compareFrame(scene, cam, W, H);
    const probe = scene.objects.find((o) => o.id === 'probe-box');
    const d = f.pipe.decisions.get(probe.uid);
    const zMin = Math.min(...probe.bounds.vertices.map((p) => viewCoords(p, cam, basis(cam)).z));
    assert.equal(f.falseCulls.length, 0, `zEye=${zEye} 不得误剔`);
    assert.equal(f.pixelDiff, 0, `zEye=${zEye} 像素须一致`);
    if (zMin < cam.near + 1e-4) {
      // 骑近裁面（仍有顶点在视锥内）必须 near-fallback；完全落到近面之后则 outside-frustum，
      // 两者都不允许查询、都不允许剔除。
      assert.ok(['near-fallback', 'outside-frustum'].includes(d.status),
        `zEye=${zEye} 跨近面必须回退或视锥外，实际 ${d.status}`);
      assert.equal(d.cull, false);
      if (d.status === 'near-fallback') nearFallbackSeen++;
    }
    frames++;
  }
  assert.ok(frames >= 20, '应覆盖足够密的近面扫描');
  assert.ok(nearFallbackSeen >= 5, '应确实命中多个 near-fallback 帧');
});

test('边界回归：小物体投影矩形越过屏幕四边时走 edge-fallback 且不漏绘', () => {
  const base = createScenes().find((s) => s.id === 'wall');
  const cam = makeOrbitCamera({ ...base.camera, aspect: W / H });
  let edgeSeen = 0;
  let frames = 0;
  for (let x = 1.5; x <= 16; x += 0.25) {
    const scene = withProbe(base, probeBox([x, 1.2, -1.6], 0.5));
    const f = compareFrame(scene, cam, W, H);
    const probe = scene.objects.find((o) => o.id === 'probe-box');
    const d = f.pipe.decisions.get(probe.uid);
    assert.equal(f.falseCulls.length, 0, `x=${x} 不得误剔`);
    assert.equal(f.pixelDiff, 0, `x=${x} 像素须一致`);
    const r = d.rect;
    if (r && (r.x0 < 0 || r.y0 < 0 || r.x1 > W - 1 || r.y1 > H - 1)) {
      edgeSeen++;
      assert.equal(d.status, 'edge-fallback', `x=${x} 触边必须 edge-fallback`);
    }
    frames++;
  }
  assert.ok(edgeSeen >= 3, '应确实出现越过屏幕边缘的帧');
  assert.ok(frames >= 30);
});

test('边界回归：小物体从墙后连续移动到墙外，状态可在 occluded 与 submitted 间正确迁移', () => {
  const base = createScenes().find((s) => s.id === 'wall');
  const cam = makeOrbitCamera({ ...base.camera, aspect: W / H });
  let occludedSeen = 0;
  let visibleSubmittedSeen = 0;
  for (let x = -4.5; x <= 8; x += 0.2) {
    const scene = withProbe(base, probeBox([x, 0.9, -3.4], 0.7));
    const f = compareFrame(scene, cam, W, H);
    const probe = scene.objects.find((o) => o.id === 'probe-box');
    const d = f.pipe.decisions.get(probe.uid);
    assert.equal(f.falseCulls.length, 0, `x=${x} 迁移过程不得漏绘`);
    assert.equal(f.pixelDiff, 0);
    if (d.status === 'occluded') occludedSeen++;
    if ((f.refCounts.get(probe.uid) ?? 0) > 0 && d.status === 'submitted') visibleSubmittedSeen++;
  }
  assert.ok(occludedSeen >= 3, '墙后段应真实发生遮挡剔除');
  assert.ok(visibleSubmittedSeen >= 3, '墙外可见段必须提交绘制（首个可见帧不被旧值吞掉）');
});

test('深度层版本：每次重建 Hi-Z 版本单调递增，旧版本结论在新层上失效', () => {
  const v0 = currentEvidenceVersion();
  const scene = createScenes()[0];
  const cam = makeOrbitCamera({ ...scene.camera, aspect: W / H });
  const p1 = runPipeline(scene, cam, W, H);
  const p2 = runPipeline(scene, cam, W, H);
  assert.equal(p2.hiZ.evidenceVersion, p1.hiZ.evidenceVersion + 1, '重建须产生新版本号');
  assert.ok(p1.hiZ.evidenceVersion > v0);

  const cache = createOcclusionCache();
  cache.remember(42, {
    status: 'occluded', evidenceVersion: p1.hiZ.evidenceVersion,
    stampCamera: cam, rect: { x0: 10, y0: 10, x1: 20, y1: 20 }, dNear: 0.5, margin: 2e-4,
  });
  // 新版本深度层：版本不一致立即判失效，即使矩形/深度都在范围内。
  const stale = cache.applicability(42, {
    evidenceVersion: p2.hiZ.evidenceVersion,
    rect: { x0: 11, y0: 11, x1: 19, y1: 19 }, dNear: 0.5, motionSevere: false,
  });
  assert.equal(stale.reusable, false);
  assert.equal(stale.why, CACHE_DECISION.VERSION_STALE);
  // 同版本且范围被当前矩形突破：scope-grew
  const grew = cache.applicability(42, {
    evidenceVersion: p1.hiZ.evidenceVersion,
    rect: { x0: 9, y0: 10, x1: 20, y1: 20 }, dNear: 0.5, motionSevere: false,
  });
  assert.equal(grew.why, CACHE_DECISION.SCOPE_GREW);
  // 当前包围体更近：depth-nearer
  const nearer = cache.applicability(42, {
    evidenceVersion: p1.hiZ.evidenceVersion,
    rect: { x0: 10, y0: 10, x1: 20, y1: 20 }, dNear: 0.4, motionSevere: false,
  });
  assert.equal(nearer.why, CACHE_DECISION.DEPTH_NEARER);
  // 同版本、范围覆盖、深度不更近、无严重位移：命中
  const hit = cache.applicability(42, {
    evidenceVersion: p1.hiZ.evidenceVersion,
    rect: { x0: 11, y0: 11, x1: 19, y1: 19 }, dNear: 0.51, motionSevere: false,
  });
  assert.equal(hit.why, CACHE_DECISION.HIT);
  assert.equal(hit.reusable, true);
  // 回退结论不得进入缓存
  cache.remember(7, { status: 'edge-fallback' });
  assert.equal(cache.get(7), null);
});

test('相机跳变 × 迟到查询交错回放：首个可见帧不被旧 occluded 吞掉', () => {
  const scene = createScenes().find((s) => s.id === 'wall');
  const cam0 = makeOrbitCamera({ ...scene.camera, aspect: W / H });
  const cache = createOcclusionCache();
  // 第一镜头：建立带适用范围的历史 occluded 结论。
  const stamp = runPipeline(scene, cam0, W, H, { occlusionCache: cache });
  assert.ok(stamp.stats.occluded >= 5, '默认机位应先建立一批真实 occluded');
  assert.ok(cache.size() >= 5);

  let lateFalseCulls = 0;
  let freshMismatch = 0;
  for (const yaw of [0.05, 0.15, 0.35, 0.7, 1.2, 2.4, 3.05]) {
    const cam = makeOrbitCamera({ ...scene.camera, yaw, aspect: W / H });
    const { late, fresh } = replayWithLateQuery(scene, cam0, cam, W, H, cache);
    // 迟到帧用旧证据 + 历史缓存：任何实际剔除都必须在参照中为 0 像素。
    const ref = renderAll(scene, cam, W, H);
    const counts = countUidPixels(ref);
    for (const o of late.culled) {
      if ((counts.get(o.uid) ?? 0) > 0) lateFalseCulls++;
    }
    // 当前证据帧必须与参照像素/集合完全一致（首个可见帧已重查）。
    if (fresh.drawList) {
      const f = compareFrame(scene, cam, W, H);
      if (f.pixelDiff !== 0 || f.falseCulls.length !== 0) freshMismatch++;
    }
    // 每个被旧金字塔判 occluded 的候选都带适用性裁决记录。
    for (const d of late.decisions.values()) {
      if (d.originalStatus === 'occluded' || d.status === 'occluded') {
        assert.ok(d.cache, 'occluded 候选必须附带缓存适用性裁决');
      }
    }
  }
  assert.equal(lateFalseCulls, 0, '迟到查询帧不得让旧值吞掉可见对象');
  assert.equal(freshMismatch, 0, '当前证据帧零漏绘、零像素差异');
});

test('相机跳变回放：迟到帧沿用戳记版本并因屏幕范围扩大失效，新帧重建版本号', () => {
  const scene = createScenes().find((s) => s.id === 'wall');
  const cam0 = makeOrbitCamera({ ...scene.camera, aspect: W / H });
  const cam = makeOrbitCamera({ ...scene.camera, yaw: 0.05, aspect: W / H });
  const cache = createOcclusionCache();
  const { stampPipe, late, fresh } = replayWithLateQuery(scene, cam0, cam, W, H, cache);
  // 迟到帧复用戳记帧的同一版深度证据（冻结不重建）
  assert.equal(late.hiZ.evidenceVersion, stampPipe.hiZ.evidenceVersion);
  assert.equal(late.frozen, true);
  // 当前帧重建深度层，版本号递增
  assert.ok(fresh.hiZ.evidenceVersion > late.hiZ.evidenceVersion);
  // 相机轻微跳变后投影矩形扩大，历史 occluded 全部因 scope-grew 失效并被拦截
  assert.ok(late.stats.cacheInvalidated >= 5);
  assert.equal(late.stats.occluded, 0, '迟到帧不得实际剔除');
  const why = [...late.decisions.values()].filter((d) => d.cache).map((d) => d.cache.why);
  assert.ok(why.includes(CACHE_DECISION.SCOPE_GREW));
  // 当前帧重新证明遮挡，剔除成绩恢复，且零漏绘
  const f = compareFrame(scene, cam, W, H);
  assert.equal(f.falseCulls.length, 0);
  assert.ok(f.pipe.stats.occluded >= 1);
});

test('相机 A→B→A 往返：可见帧清空旧结论，回到原机位由当前证据重新证明而非沿用脏值', () => {
  const scene = createScenes().find((s) => s.id === 'wall');
  const cache = createOcclusionCache();
  const camA = makeOrbitCamera({ ...scene.camera, yaw: 0, aspect: W / H });
  const camB = makeOrbitCamera({ ...scene.camera, yaw: 0.9, aspect: W / H });

  const pA1 = runPipeline(scene, camA, W, H, { occlusionCache: cache });
  assert.ok(pA1.stats.occluded >= 5);
  assert.equal(cache.size(), pA1.stats.occluded);

  // 转到差异明显的机位：历史结论全部失效，零误剔且缓存被清空。
  const pB = runPipeline(scene, camB, W, H, { occlusionCache: cache });
  const refB = renderAll(scene, camB, W, H);
  const cB = countUidPixels(refB);
  assert.equal(pB.culled.filter((o) => (cB.get(o.uid) ?? 0) > 0).length, 0);
  assert.ok(pB.stats.cacheInvalidated >= 5);
  assert.equal(cache.size(), 0);

  // 回到原机位：缓存已空，必须由当前深度层重新证明 occluded，恢复真实绘制节省。
  const pA2 = runPipeline(scene, camA, W, H, { occlusionCache: cache });
  const refA = renderAll(scene, camA, W, H);
  const cA = countUidPixels(refA);
  assert.equal(pA2.culled.filter((o) => (cA.get(o.uid) ?? 0) > 0).length, 0);
  assert.equal(pA2.stats.occluded, pA1.stats.occluded);
  assert.ok(pA2.stats.skippedOcclusionTris > 0);
  assert.equal(pA2.stats.cacheHit, 0, '清空后不得命中残留脏值');
});

test('保守查询修复不是“关闭全部剔除”：默认机位仍有真实绘制节省且零漏绘', () => {
  for (const scene of createScenes()) {
    const cam = makeOrbitCamera({ ...scene.camera, aspect: W / H });
    const f = compareFrame(scene, cam, W, H);
    assert.equal(f.falseCulls.length, 0);
    assert.equal(f.pixelDiff, 0);
    const s = f.pipe.stats;
    assert.ok(s.occluded >= 1, `${scene.id} 仍须实际剔除对象`);
    assert.ok(s.skippedOcclusionTris > 0, `${scene.id} 须有真实跳过的三角形`);
    assert.ok(s.submittedTris < s.totalTris, `${scene.id} 实际提交三角形必须少于全量`);
    // 回退路径计数合理：近面/边缘回退不等于关闭剔除。
    assert.ok(typeof s.nearFallback === 'number' && typeof s.edgeFallback === 'number');
  }
});

test('近面/边缘回退对象仍被实际绘制，且不占用遮挡剔除成绩', () => {
  const base = createScenes().find((s) => s.id === 'wall');
  // 构造一个必然骑近裁面的小物体
  const nearScene = withProbe(base, probeBox([0, 1.2, 0], 0.6));
  const nearCam = makeCamera([0, 1.2, 0.6], [0, 1.2, -1], { aspect: W / H, near: 0.5, far: 80 });
  const nf = compareFrame(nearScene, nearCam, W, H);
  const nearProbe = nearScene.objects.find((o) => o.id === 'probe-box');
  const nd = nf.pipe.decisions.get(nearProbe.uid);
  assert.equal(nd.status, 'near-fallback');
  assert.ok((nf.refCounts.get(nearProbe.uid) ?? 0) > 0, '近面回退物体参照中可见');
  assert.ok((nf.onCounts.get(nearProbe.uid) ?? 0) > 0, '近面回退物体必须实际绘制');
  assert.ok(!nf.pipe.culled.includes(nearProbe));
  assert.equal(nf.pixelDiff, 0);

  // 构造一个必然越过屏幕边缘的小物体（x=15 时投影矩形 x1=484 > 479）
  const edgeScene = withProbe(base, probeBox([15, 1.2, -1.6], 0.5));
  const edgeCam = makeOrbitCamera({ ...base.camera, aspect: W / H });
  const ef = compareFrame(edgeScene, edgeCam, W, H);
  const edgeProbe = edgeScene.objects.find((o) => o.id === 'probe-box');
  const ed = ef.pipe.decisions.get(edgeProbe.uid);
  assert.equal(ed.status, 'edge-fallback');
  assert.ok(!ef.pipe.culled.includes(edgeProbe));
  assert.ok((ef.refCounts.get(edgeProbe.uid) ?? 0) > 0, '边缘回退物体参照中可见');
  assert.ok((ef.onCounts.get(edgeProbe.uid) ?? 0) > 0, '边缘回退物体必须实际绘制');
  assert.equal(ef.pixelDiff, 0);
});
