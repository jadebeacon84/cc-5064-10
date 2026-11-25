// 分层深度 (Hi-Z)：
//   layer[0] 直接来自可靠遮挡物光栅化深度；
//   上层每个纹素 = 2x2 子块深度的 max（区块内“最远的遮挡深度”），
//   mask 做按位 OR，记录该区块出现过哪些遮挡物（来源追踪）。
// 查询方向必须与深度约定一致：
//   深度值越小越近；若物体包围体的最近深度 dNear 仍严格远于
//   区块 max 深度（dNear >= cellMax + margin），则整个区块被遮挡。

export function buildHiZ(depth0, mask0, width, height) {
  const levels = [{ width, height, depth: depth0, mask: mask0, level: 0 }];
  let pw = width;
  let ph = height;
  let pd = depth0;
  let pm = mask0;
  while (pw > 1 || ph > 1) {
    const nw = Math.max(1, Math.ceil(pw / 2));
    const nh = Math.max(1, Math.ceil(ph / 2));
    const nd = new Float32Array(nw * nh);
    const nm = new Uint32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let dmax = -Infinity;
        let mor = 0;
        for (let yy = 0; yy <= 1; yy++) {
          const sy = y * 2 + yy;
          if (sy >= ph) continue;
          for (let xx = 0; xx <= 1; xx++) {
            const sx = x * 2 + xx;
            if (sx >= pw) continue;
            const si = sy * pw + sx;
            const dv = pd[si];
            if (dv > dmax) dmax = dv;
            mor |= pm[si] >>> 0;
          }
        }
        if (!Number.isFinite(dmax)) dmax = 1;
        const di = y * nw + x;
        nd[di] = dmax;
        nm[di] = mor >>> 0;
      }
    }
    levels.push({ width: nw, height: nh, depth: nd, mask: nm, level: levels.length });
    pw = nw;
    ph = nh;
    pd = nd;
    pm = nm;
  }
  return { width, height, levels };
}

// 屏幕矩形（level0 闭区间整数坐标）上的保守 Hi-Z 查询。
// rect 必须已经完整包围物体投影。返回结构化证据，供 UI 与审计追踪。
export function queryRect(hiZ, rect, dNear, options = {}) {
  const margin = options.depthMargin ?? 2e-4;
  // 允许测试较多纹素以使用更细层级：细层级不会比粗层级更保守误判，
  // 粗层级只是用更少采样换取更高的漏剔率。
  const maxAxisTexels = options.maxAxisTexels ?? 12;
  const W = hiZ.width;
  const H = hiZ.height;

  const x0 = Math.max(0, rect.x0);
  const y0 = Math.max(0, rect.y0);
  const x1 = Math.min(W - 1, rect.x1);
  const y1 = Math.min(H - 1, rect.y1);
  if (x0 > x1 || y0 > y1) {
    return { occluded: false, reason: 'empty-rect', samples: [] };
  }

  const span = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  let level = Math.max(0, Math.ceil(Math.log2(span / maxAxisTexels)));
  level = Math.min(level, hiZ.levels.length - 1);
  const L = hiZ.levels[level];
  const shift = level;

  const tx0 = x0 >> shift;
  const ty0 = y0 >> shift;
  const tx1 = x1 >> shift;
  const ty1 = y1 >> shift;

  const samples = [];
  let worstSlack = Infinity;
  let maxDepth = -Infinity;
  let ownerBits = 0;
  let allPass = true;
  let tested = 0;

  for (let ty = ty0; ty <= ty1; ty++) {
    if (ty < 0 || ty >= L.height) continue;
    for (let tx = tx0; tx <= tx1; tx++) {
      if (tx < 0 || tx >= L.width) continue;
      const i = ty * L.width + tx;
      const cellMax = L.depth[i];
      const cellMask = L.mask[i] >>> 0;
      const slack = dNear - cellMax;
      const pass = slack >= margin && cellMask !== 0;
      tested++;
      if (!pass) allPass = false;
      if (slack < worstSlack) worstSlack = slack;
      if (cellMax > maxDepth) maxDepth = cellMax;
      ownerBits |= cellMask;
      if (samples.length < 400) {
        samples.push({ tx, ty, depth: cellMax, mask: cellMask, slack, pass });
      }
    }
  }

  if (tested === 0) {
    return { occluded: false, reason: 'no-texels', level, samples };
  }

  return {
    occluded: allPass,
    reason: allPass ? 'all-cells-pass' : 'evidence-insufficient',
    level,
    texelRect: { tx0, ty0, tx1, ty1 },
    testedCount: tested,
    worstSlack,
    maxDepth,
    margin,
    ownerBits: ownerBits >>> 0,
    samples,
  };
}

// 来源审计：被剔除候选自身的 bit 不得出现在证据掩码中（防止自证遮挡循环）。
export function auditSelfEvidence(result, candidateSelfBit) {
  if (!candidateSelfBit) return { circular: false };
  const hit = (result.ownerBits ?? 0) & candidateSelfBit;
  return {
    circular: hit !== 0,
    hitBits: hit >>> 0,
    message: hit ? '证据深度包含候选自身写入的 bit，存在自遮挡循环依据' : null,
  };
}
