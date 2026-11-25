// 参照与校验：
//   - 用“不做遮挡剔除”的全量软件渲染得到真实可见 uid 集合（无先验名单）；
//   - 与开启剔除的绘制结果做逐像素与可见集合比较；
//   - 任何被 Hi-Z 判 occluded 但参照中存在像素的对象都记为误剔除（漏显）。

import { makeOrbitCamera } from './math3d.js';
import { createRenderTarget, clearTarget, renderScene, countUidPixels } from './raster.js';
import { runPipeline } from './pipeline.js';
import { createScenes } from './scene.js';

export function renderAll(scene, cam, width, height) {
  const rt = createRenderTarget(width, height);
  clearTarget(rt);
  renderScene(rt, cam, scene.objects);
  return rt;
}

function diffPixels(a, b) {
  let diff = 0;
  const n = a.width * a.height;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    if (a.color[i] !== b.color[i] || a.color[i + 1] !== b.color[i + 1] || a.color[i + 2] !== b.color[i + 2]) diff++;
  }
  return diff;
}

function visibleSetFromCounts(counts) {
  return new Set([...counts.entries()].filter(([, n]) => n > 0).map(([u]) => u));
}

// 单帧完整对比。options 透传给 pipeline。
export function compareFrame(scene, cam, width, height, options = {}) {
  const refRT = renderAll(scene, cam, width, height);
  const refCounts = countUidPixels(refRT);
  const refVisible = visibleSetFromCounts(refCounts);

  const pipe = runPipeline(scene, cam, width, height, { ...options, cullingEnabled: true });

  const onRT = createRenderTarget(width, height);
  clearTarget(onRT);
  renderScene(onRT, cam, pipe.drawList);
  const onCounts = countUidPixels(onRT);
  const onVisible = visibleSetFromCounts(onCounts);

  const pixelDiff = diffPixels(refRT, onRT);

  const falseCulls = [];
  for (const obj of pipe.culled) {
    const px = refCounts.get(obj.uid) ?? 0;
    if (px > 0) {
      const d = pipe.decisions.get(obj.uid);
      falseCulls.push({
        uid: obj.uid, id: obj.id, name: obj.name, referencePixels: px,
        reason: d?.reason, level: d?.query?.level, worstSlack: d?.query?.worstSlack,
        ownerBits: d?.query?.ownerBits,
      });
    }
  }

  const setMissing = [...refVisible].filter((u) => !onVisible.has(u));
  const setExtra = [...onVisible].filter((u) => !refVisible.has(u));

  return {
    cam: { yaw: cam.yaw, pitch: cam.pitch, distance: cam.distance, eye: cam.eye.slice() },
    pipe, refRT, onRT, refCounts, refVisible, onVisible, onCounts,
    pixelDiff, falseCulls, setMissing, setExtra,
    pixelPerfect: pixelDiff === 0,
    setEqual: setMissing.length === 0 && setExtra.length === 0,
  };
}

// 确定性相机扫描：全周 yaw × 多个 pitch × 多个距离，外加近裁/边缘专项机位。
export function sweepCameras(scene, opts = {}) {
  const yawSteps = opts.yawSteps ?? 24;
  const pitches = opts.pitches ?? [-0.12, 0.08, 0.28, 0.5];
  const distances = opts.distances ?? [undefined, 9, 20];
  const width = opts.width ?? 480;
  const height = opts.height ?? 270;
  const base = scene.camera;
  const cams = [];
  for (let i = 0; i < yawSteps; i++) {
    const yaw = (i / yawSteps) * Math.PI * 2;
    for (const pitch of pitches) {
      for (const dd of distances) {
        cams.push(makeOrbitCamera({
          target: base.target, yaw, pitch,
          distance: dd ?? base.distance,
          fovY: base.fovY ?? Math.PI / 3,
          aspect: width / height,
          near: opts.near ?? 0.1, far: opts.far ?? 80,
        }));
      }
    }
  }
  // 专项：逼近候选制造近裁面穿越
  cams.push(makeOrbitCamera({ target: [0, 1, -4.2], yaw: 0, pitch: 0.05, distance: 2.2, aspect: width / height }));
  cams.push(makeOrbitCamera({ target: [0, 1, -4.2], yaw: 0.6, pitch: 0.2, distance: 1.4, aspect: width / height }));
  // 专项：侧向贴边
  cams.push(makeOrbitCamera({ target: [3.5, 1.2, -3], yaw: -0.9, pitch: 0.1, distance: 4, aspect: width / height }));
  cams.push(makeOrbitCamera({ target: [-3.5, 1.2, -3], yaw: 0.9, pitch: 0.1, distance: 4, aspect: width / height }));
  return cams;
}

// 对一个场景跑完整声明范围扫描。
export function verifyScene(scene, opts = {}) {
  const cams = opts.cameras ?? sweepCameras(scene, opts);
  const frameReports = [];
  let falseCullEvents = 0;
  let pixelMismatchFrames = 0;
  let setMismatchFrames = 0;
  let framesWithOcclusion = 0;
  let totalOccluded = 0;
  let totalSkippedTris = 0;
  const statusHist = {};

  for (let i = 0; i < cams.length; i++) {
    const f = compareFrame(scene, cams[i], opts.width ?? 480, opts.height ?? 270, opts.pipelineOptions ?? {});
    frameReports.push(f);
    if (f.falseCulls.length) falseCullEvents += f.falseCulls.length;
    if (!f.pixelPerfect) pixelMismatchFrames++;
    if (!f.setEqual) setMismatchFrames++;
    if (f.pipe.stats.occluded > 0) framesWithOcclusion++;
    totalOccluded += f.pipe.stats.occluded;
    totalSkippedTris += f.pipe.stats.skippedOcclusionTris;
    for (const [, d] of f.pipe.decisions) {
      statusHist[d.status] = (statusHist[d.status] ?? 0) + 1;
    }
  }

  // 找出默认机位的实际剔除成绩（证明真实减少绘制工作）
  const defaultCam = makeOrbitCamera({ ...scene.camera, aspect: (opts.width ?? 480) / (opts.height ?? 270) });
  const defaultFrame = compareFrame(scene, defaultCam, opts.width ?? 480, opts.height ?? 270, opts.pipelineOptions ?? {});

  return {
    sceneId: scene.id, sceneName: scene.name,
    frames: cams.length,
    falseCullEvents, pixelMismatchFrames, setMismatchFrames,
    framesWithOcclusion, totalOccluded, totalSkippedTris,
    statusHist,
    passed: falseCullEvents === 0 && pixelMismatchFrames === 0 && setMismatchFrames === 0,
    defaultFrame,
    frameReports: opts.keepFrames ? frameReports : undefined,
  };
}

export function verifyAllScenes(opts = {}) {
  const scenes = createScenes();
  const reports = scenes.map((s) => verifyScene(s, opts));
  const passed = reports.every((r) => r.passed);
  return {
    passed,
    reports,
    scope: {
      resolution: `${opts.width ?? 480}x${opts.height ?? 270}`,
      yawSteps: opts.yawSteps ?? 24,
      pitches: opts.pitches ?? [-0.12, 0.08, 0.28, 0.5],
      distances: opts.distances ?? ['preset', 9, 20],
      extra: '近裁面逼近 2 机位 + 屏幕边缘 2 机位；深度 margin 默认 2e-4',
      evidenceMode: 'current（每帧由当前镜头可靠遮挡物深度重建金字塔）',
    },
  };
}
