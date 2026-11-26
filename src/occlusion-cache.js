// 历史遮挡结论缓存：给每条 occluded 结论附上“适用范围”，
// 让迟到查询 / 相机跳变回放时，旧值无法吞掉新镜头的首个可见帧。
//
// 适用范围（全部满足才允许复用旧 occluded）：
//   1. evidenceVersion 与当前 Hi-Z 一致 —— 深度层一旦重建，旧结论立即失效；
//   2. 旧查询的保守屏幕矩形仍完整落在当前帧包围体投影矩形内（旧证据覆盖当前区域）；
//   3. 当前帧包围体最近深度不更近于旧结论（dNearNow >= dNearOld - depthMargin）；
//   4. 相机戳记未发生近裁穿越等严重位移（由调用方以 motion 裁决传入）。
// 任一不满足：旧 occluded 必须失效并按当前证据重查；查询型回退（near/edge）永不缓存。

export const CACHE_DECISION = {
  HIT: 'cache-hit',                 // 适用范围内，可沿用旧 occluded
  VERSION_STALE: 'version-stale',   // 深度层版本不一致，旧结论失效
  SCOPE_GREW: 'scope-grew',         // 当前投影矩形超出旧证据覆盖
  DEPTH_NEARER: 'depth-nearer',     // 当前包围体比旧结论更近
  NOT_CACHED: 'not-cached',         // 无历史结论 / 历史非 occluded
};

export function createOcclusionCache() {
  const map = new Map();
  return {
    kind: 'occlusion-cache',
    map,
    size: () => map.size,
    clear: () => map.clear(),
    get: (uid) => map.get(uid) ?? null,
    // 仅缓存真正的 occluded；near/edge/outside 等回退绝不缓存为可剔除结论。
    remember(uid, entry) {
      if (entry?.status !== 'occluded') {
        map.delete(uid);
        return;
      }
      map.set(uid, {
        uid,
        evidenceVersion: entry.evidenceVersion,
        stampCamera: entry.stampCamera,
        rect: { ...entry.rect },
        dNear: entry.dNear,
        level: entry.level,
        margin: entry.margin,
      });
    },
    // 判定旧 occluded 是否仍适用于当前帧。motionSevere 由运动界限裁决给出。
    applicability(uid, current) {
      const old = map.get(uid);
      if (!old) return { reusable: false, why: CACHE_DECISION.NOT_CACHED, entry: null };
      if (old.evidenceVersion !== current.evidenceVersion) {
        return { reusable: false, why: CACHE_DECISION.VERSION_STALE, entry: old };
      }
      const r = current.rect;
      const covers =
        old.rect.x0 <= r.x0 && old.rect.y0 <= r.y0 &&
        old.rect.x1 >= r.x1 && old.rect.y1 >= r.y1;
      if (!covers) return { reusable: false, why: CACHE_DECISION.SCOPE_GREW, entry: old };
      if (current.dNear < old.dNear - (old.margin ?? 0)) {
        return { reusable: false, why: CACHE_DECISION.DEPTH_NEARER, entry: old };
      }
      if (current.motionSevere) {
        return { reusable: false, why: CACHE_DECISION.VERSION_STALE, entry: old };
      }
      return { reusable: true, why: CACHE_DECISION.HIT, entry: old };
    },
  };
}
