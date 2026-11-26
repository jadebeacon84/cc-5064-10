// 遮挡剔除流水线：
//   1) 只把“可靠遮挡物”渲染进遮挡深度 + owner mask；
//   2) 构造 max 归约 Hi-Z；
//   3) 对每个候选的完整包围体做视锥 / 近裁面 / 屏幕边缘判定，
//      再做保守矩形层级查询，只有证据充分才允许从真实绘制列表排除。
// 任何剔除决定都只依赖当前 Hi-Z 证据，不读取预先知道的可见列表。

import { basis, frustumPlanes, viewCoords, depthFromZ, motionBound, sameCamera } from './math3d.js';
import { boundVertices } from './geometry.js';
import { createRenderTarget, clearTarget, renderScene } from './raster.js';
import { buildHiZ, queryRect, auditSelfEvidence } from './hiz.js';
import { createOcclusionCache, CACHE_DECISION } from './occlusion-cache.js';

export const STATUS = {
  OUTSIDE_FRUSTUM: 'outside-frustum',
  NEAR_FALLBACK: 'near-fallback',
  EDGE_FALLBACK: 'edge-fallback',
  OCCLUDED: 'occluded',
  SUBMITTED: 'submitted',
  STALE_BLOCKED: 'stale-blocked',
};

// 仅做视锥保守分类：存在某个平面让包围体所有顶点都在外侧 -> 视锥外。
export function outsideFrustum(vertices, cam) {
  const planes = frustumPlanes(cam);
  for (const pl of planes) {
    let allOut = true;
    for (const p of vertices) {
      const vc = viewCoords(p, cam);
      if (pl.g(vc.x, vc.y, vc.z) >= -1e-7) {
        allOut = false;
        break;
      }
    }
    if (allOut) return pl.name;
  }
  return null;
}

// 对单个候选做完整分类 + Hi-Z 查询。纯函数，便于校验脚本复用。
export function classifyCandidate(obj, cam, hiZ, options = {}) {
  const W = hiZ.width;
  const H = hiZ.height;
  const b = basis(cam);
  const vertices = boundVertices(obj.bounds, cam, b);
  const triCount = obj.indices.length / 3;

  const base = {
    uid: obj.uid,
    id: obj.id,
    name: obj.name,
    kind: obj.bounds.kind,
    triCount,
    query: null,
    selfAudit: null,
    rect: null,
    zMin: null,
    dNear: null,
    frustumPlane: null,
    evidenceVersion: hiZ.evidenceVersion ?? null,
    cache: null,
  };

  const outPlane = outsideFrustum(vertices, cam);
  if (outPlane) {
    return { ...base, status: STATUS.OUTSIDE_FRUSTUM, cull: false, frustumPlane: outPlane,
      reason: `全在 ${outPlane} 面外（视锥过滤，不计入遮挡成绩）` };
  }

  let zMin = Infinity;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const t = Math.tan(cam.fovY / 2);
  for (const p of vertices) {
    const vc = viewCoords(p, cam, b);
    if (vc.z < zMin) zMin = vc.z;
    const sx = (vc.x / (vc.z * t * cam.aspect) * 0.5 + 0.5) * W;
    const sy = (0.5 - (vc.y / (vc.z * t)) * 0.5) * H;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sy < minY) minY = sy;
    if (sy > maxY) maxY = sy;
  }
  base.zMin = zMin;

  // 明确回退 1：包围体跨越/进入近裁面，透视投影不保守。
  if (zMin < cam.near + (options.nearPadding ?? 1e-4)) {
    return { ...base, status: STATUS.NEAR_FALLBACK, cull: false,
      reason: `最近包围深度 ${zMin.toFixed(3)}m < near ${cam.near}m，跨近裁面回退，照常绘制` };
  }

  // floor/ceil 取整已让闭整数矩形在每侧多含至多一列纹素，默认不再外扩。
  const pad = options.rectPadPx ?? 0;
  const rect = {
    x0: Math.floor(minX - pad),
    y0: Math.floor(minY - pad),
    x1: Math.ceil(maxX + pad),
    y1: Math.ceil(maxY + pad),
  };
  base.rect = rect;
  const dNear = depthFromZ(zMin, cam);
  base.dNear = dNear;

  // 明确回退 2：保守屏幕矩形碰到/越过屏幕边缘。
  if (rect.x0 < 0 || rect.y0 < 0 || rect.x1 > W - 1 || rect.y1 > H - 1) {
    return { ...base, status: STATUS.EDGE_FALLBACK, cull: false,
      reason: '投影包围矩形触及屏幕边缘，边缘回退，照常绘制（不使用中心点判定）' };
  }

  const q = queryRect(hiZ, rect, dNear, options);
  base.query = q;
  base.selfAudit = auditSelfEvidence(q, obj.selfBit ?? 0);

  if (base.selfAudit.circular) {
    return { ...base, status: STATUS.SUBMITTED, cull: false,
      reason: '证据来源含候选自身 bit，审计拦截，拒绝剔除：' + base.selfAudit.message };
  }

  if (q.occluded) {
    return { ...base, status: STATUS.OCCLUDED, cull: true,
      reason: `L${q.level} ${q.testedCount} 纹素全部通过，最差余量 ${(q.worstSlack).toExponential(2)}` };
  }
  return { ...base, status: STATUS.SUBMITTED, cull: false,
    reason: q.reason === 'evidence-insufficient'
      ? `证据不足（L${q.level}，最差余量 ${(q.worstSlack ?? NaN).toExponential?.(2) ?? q.worstSlack} < ${q.margin}），提交绘制`
      : `查询未通过：${q.reason}` };
}

// 镜头移动界限裁决。stampCam 为 Hi-Z 生成时的相机。
// limitTexels: 允许的屏幕位移界限（Hi-Z 像素）。
export function evaluateMotion(stampCam, cam, occluderPoints, limitTexels, width, height) {
  if (sameCamera(stampCam, cam)) {
    return { boundPx: 0, limitTexels, decision: 'hold', severe: false, detail: '镜头与证据戳记一致，可保持查询状态' };
  }
  const mb = motionBound(stampCam, cam, occluderPoints, width, height);
  const conservative = Number.isFinite(mb.pixels) ? mb.pixels * 1.5 + 1 : Infinity;
  if (!Number.isFinite(conservative) || conservative > limitTexels) {
    return {
      boundPx: conservative, rawPx: mb.pixels, depthDelta: mb.depthDelta, limitTexels,
      decision: 'rebuild-requery', severe: true,
      detail: `位移界限 ${conservative === Infinity ? '∞' : conservative.toFixed(1) + 'px'} 超过 ${limitTexels}px（或绕到近裁面后），旧金字塔失效：重建深度并全量重查`,
    };
  }
  return {
    boundPx: conservative, rawPx: mb.pixels, depthDelta: mb.depthDelta, limitTexels,
    decision: 'requery', severe: false,
    detail: `位移 ${conservative.toFixed(1)}px 在界限 ${limitTexels}px 内：旧剔除结论不得沿用，使用当前镜头重新查询`,
  };
}

function collectOccluderPoints(scene) {
  const pts = [];
  for (const o of scene.objects) {
    if (!o.reliableOccluder) continue;
    const b = o.bounds;
    if (b.kind === 'vertices') pts.push(...b.vertices);
    else if (b.kind === 'sphere') {
      // 球心 + 轴向极点作为位移估计点
      pts.push(b.center);
      pts.push([b.center[0] + b.radius, b.center[1], b.center[2]]);
      pts.push([b.center[0], b.center[1] + b.radius, b.center[2]]);
      pts.push([b.center[0], b.center[1], b.center[2] + b.radius]);
    } else if (b.kind === 'compound') {
      for (const p of b.parts) {
        if (p.kind === 'vertices') pts.push(...p.vertices);
      }
    }
  }
  return pts;
}

// 主入口。frozenEvidence 可注入旧 Hi-Z 做陈旧证据实验。
// occlusionCache 可跨帧注入：历史 occluded 仅在适用范围（证据版本/屏幕范围/深度/运动界限）
// 全部满足时才允许复用，否则按当前深度层重查，避免旧值吞掉首个可见帧。
export function runPipeline(scene, cam, width, height, options = {}) {
  const occluders = scene.objects.filter((o) => o.reliableOccluder);
  const candidates = scene.objects.filter((o) => o.candidate === true);

  let hiZ;
  let occluderRT = null;
  let evidenceCam = cam;
  let frozen = false;

  if (options.frozenEvidence) {
    hiZ = options.frozenEvidence.hiZ;
    evidenceCam = options.frozenEvidence.camera;
    frozen = true;
  } else {
    occluderRT = createRenderTarget(width, height);
    clearTarget(occluderRT);
    renderScene(occluderRT, cam, occluders, { writeMask: true });
    hiZ = buildHiZ(occluderRT.depth, occluderRT.mask, width, height, options.hiZOptions);
  }

  const ownerNames = new Map();
  for (const o of occluders) {
    if (o.bitIndex != null) ownerNames.set(o.bitIndex, o.name);
  }

  const motion = evaluateMotion(
    evidenceCam, cam, collectOccluderPoints(scene),
    options.moveLimitTexels ?? 4, width, height,
  );

  const cache = options.occlusionCache ?? createOcclusionCache();
  const decisions = new Map();
  const culled = [];
  const culledSet = new Set();
  const stats = {
    width, height,
    totalObjects: scene.objects.length,
    occluderCount: occluders.length,
    candidateCount: candidates.length,
    occluded: 0,
    outsideFrustum: 0,
    nearFallback: 0,
    edgeFallback: 0,
    submitted: 0,
    staleBlocked: 0,
    cacheHit: 0,
    cacheInvalidated: 0,
    totalTris: 0,
    submittedTris: 0,
    skippedOcclusionTris: 0,
    occluderTris: occluders.reduce((s, o) => s + o.indices.length / 3, 0),
    queryTexels: 0,
  };

  for (const o of scene.objects) stats.totalTris += o.indices.length / 3;

  for (const obj of candidates) {
    const d = classifyCandidate(obj, cam, hiZ, options);

    // 历史遮挡结论适用范围校验（迟到查询/相机跳变回放路径）。
    // 仅对“本帧据证据判 occluded”的候选检查缓存：旧结论版本/范围/深度不匹配即失效，
    // 强制按当前深度层重查；near/edge/outside 等回退本就不进缓存。
    if (d.status === STATUS.OCCLUDED) {
      const verdict = cache.applicability(obj.uid, {
        evidenceVersion: hiZ.evidenceVersion ?? null,
        rect: d.rect,
        dNear: d.dNear,
        motionSevere: motion.severe,
      });
      d.cache = { reusable: verdict.reusable, why: verdict.why };
      if (!verdict.reusable && verdict.why !== CACHE_DECISION.NOT_CACHED) {
        stats.cacheInvalidated++;
        // 旧结论不再适用：安全侧回退为提交绘制，交由当前/下一帧证据重新证明。
        d.originalStatus = d.status;
        d.invalidatedWhy = verdict.why;
        d.status = STATUS.STALE_BLOCKED;
        d.cull = false;
        d.reason = `历史遮挡结论超出适用范围（${verdict.why}），旧值失效，强制提交并等待当前深度层重查`;
      } else if (verdict.reusable) {
        stats.cacheHit++;
      }
    }

    // 陈旧证据安全策略：越界后不允许依据旧金字塔真正剔除。
    if (frozen && motion.severe && d.status === STATUS.OCCLUDED && options.stalePolicy !== 'apply-for-experiment') {
      d.originalStatus = d.status;
      d.status = STATUS.STALE_BLOCKED;
      d.cull = false;
      d.reason = '证据已随镜头移动越界失效，安全策略拦截旧结论，强制提交';
    }
    // 实验模式下，陈旧证据给出的 occluded 标记为 occluded-stale，仍按开关决定绘制。
    if (frozen && d.status === STATUS.OCCLUDED && options.stalePolicy === 'apply-for-experiment') {
      d.stale = true;
    }
    decisions.set(obj.uid, d);
    stats.queryTexels += d.query?.testedCount ?? 0;

    if (d.status === STATUS.OUTSIDE_FRUSTUM) stats.outsideFrustum++;
    if (d.status === STATUS.NEAR_FALLBACK) stats.nearFallback++;
    if (d.status === STATUS.EDGE_FALLBACK) stats.edgeFallback++;

    if (options.cullingEnabled !== false && d.cull) {
      culled.push(obj);
      culledSet.add(obj.uid);
      stats.occluded++;
      stats.skippedOcclusionTris += d.triCount;
      // 仅把当前证据版本下成立的 occluded 连同适用范围写入缓存。
      if (!frozen) {
        cache.remember(obj.uid, {
          status: STATUS.OCCLUDED,
          evidenceVersion: hiZ.evidenceVersion ?? null,
          stampCamera: cam,
          rect: d.rect,
          dNear: d.dNear,
          level: d.query?.level ?? null,
          margin: d.query?.margin ?? null,
        });
      }
    } else {
      stats.submitted++;
      stats.submittedTris += d.triCount;
      if (d.status === STATUS.STALE_BLOCKED) stats.staleBlocked++;
      // 一旦当前证据不再支持剔除，历史结论立即作废，防止后续帧复用脏值。
      if (!frozen) cache.map.delete(obj.uid);
    }
  }

  // 真实绘制列表：保持场景原始顺序的过滤子集（深度测试下结果与全量一致），
  // 可靠遮挡物与地面等装饰物自然包含在内。
  const drawList = options.cullingEnabled === false
    ? scene.objects.slice()
    : scene.objects.filter((o) => !culledSet.has(o.uid));

  return {
    width, height, hiZ, occluderRT, evidenceCam, frozen, motion,
    decisions, drawList, culled, culledSet, stats, ownerNames, occlusionCache: cache,
  };
}

// 相机跳变 × 迟到查询交错回放：
// 先用戳记镜头建立带适用范围的历史 occluded（写入共享缓存），再用“戳记帧的同一版
// 深度证据 + 当前镜头”跑一帧迟到查询，最后用当前镜头重建的新深度层跑一帧。
// 历史结论带证据版本/屏幕范围/深度/运动界限；首个可见帧不会被旧值吞掉。
export function replayWithLateQuery(scene, stampCam, currentCam, width, height, cache, options = {}) {
  const stampPipe = runPipeline(scene, stampCam, width, height, { ...options, occlusionCache: cache });
  const late = runPipeline(scene, currentCam, width, height, {
    ...options,
    occlusionCache: cache,
    frozenEvidence: { hiZ: stampPipe.hiZ, camera: stampCam },
  });
  const fresh = runPipeline(scene, currentCam, width, height, { ...options, occlusionCache: cache });
  return { stampPipe, late, fresh };
}
