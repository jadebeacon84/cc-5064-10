// 零依赖软件光栅器：每像素深度测试，输出 color / depth / 对象 uid / occluder 掩码。
// 三角形先在相机空间对 6 个视锥平面做 Sutherland-Hodgman 裁剪，
// 因此跨近裁面的物体也能得到正确图像（剔除器对这类包围体另有明确回退）。

import { basis, frustumPlanes } from './math3d.js';
import { triangleNormal } from './geometry.js';

export function createRenderTarget(width, height, opts = {}) {
  const n = width * height;
  return {
    width,
    height,
    color: new Uint8ClampedArray(n * 4),
    depth: new Float32Array(n),
    uid: new Int32Array(n),
    mask: new Uint32Array(n),
    clearColor: opts.clearColor ?? [16, 20, 28, 255],
  };
}

export function clearTarget(rt, color = rt.clearColor) {
  rt.depth.fill(1);
  rt.uid.fill(0);
  rt.mask.fill(0);
  const c = color ?? rt.clearColor;
  for (let i = 0; i < rt.width * rt.height; i++) {
    rt.color[i * 4] = c[0];
    rt.color[i * 4 + 1] = c[1];
    rt.color[i * 4 + 2] = c[2];
    rt.color[i * 4 + 3] = c[3] ?? 255;
  }
}

function clipPolygonPlane(poly, plane) {
  if (poly.length === 0) return poly;
  const out = [];
  let prev = poly[poly.length - 1];
  let gp = plane.g(prev.x, prev.y, prev.z);
  let prevIn = gp >= -1e-9;
  for (const cur of poly) {
    const gc = plane.g(cur.x, cur.y, cur.z);
    const curIn = gc >= -1e-9;
    if (curIn !== prevIn) {
      // 线段与 g=0 的交点：s = gp / (gp - gc)
      const s = gp / (gp - gc);
      out.push({
        x: prev.x + (cur.x - prev.x) * s,
        y: prev.y + (cur.y - prev.y) * s,
        z: prev.z + (cur.z - prev.z) * s,
      });
    }
    if (curIn) out.push(cur);
    prev = cur;
    gp = gc;
    prevIn = curIn;
  }
  return out;
}

const LIGHT = (() => {
  const l = [0.45, 0.85, 0.4];
  const n = Math.hypot(l[0], l[1], l[2]);
  return [l[0] / n, l[1] / n, l[2] / n];
})();

// objects: 场景对象数组；filter 决定哪些参与本次绘制。
// maskOf(obj) 返回写入 mask 缓冲的位（可靠遮挡物证据追踪用）。
export function renderScene(rt, cam, objects, options = {}) {
  const { width: W, height: H } = rt;
  const b = basis(cam);
  const planes = frustumPlanes(cam);
  const t = Math.tan(cam.fovY / 2);
  const kx = t * cam.aspect;
  const A = cam.far / (cam.far - cam.near);
  const B = (-cam.far * cam.near) / (cam.far - cam.near);
  const writeMask = options.writeMask ?? false;
  const stats = options.stats ?? null;

  for (const obj of objects) {
    if (options.filter && !options.filter(obj)) continue;
    const pos = obj.positions;
    const idx = obj.indices;
    const baseColor = obj.color ?? [180, 180, 180];
    const objMask = writeMask && options.maskOf ? options.maskOf(obj) : (obj.occluderBit ?? 0);
    const uid = obj.uid ?? 0;

    for (let ii = 0; ii < idx.length; ii += 3) {
      const ia = idx[ii] * 3;
      const ib = idx[ii + 1] * 3;
      const ic = idx[ii + 2] * 3;
      const wa = [pos[ia], pos[ia + 1], pos[ia + 2]];
      const wb = [pos[ib], pos[ib + 1], pos[ib + 2]];
      const wc = [pos[ic], pos[ic + 1], pos[ic + 2]];

      // 世界空间面法线 + 简单 Lambert（平面着色）
      const nrm = triangleNormal(wa, wb, wc);
      const diffuse = Math.max(0, nrm[0] * LIGHT[0] + nrm[1] * LIGHT[1] + nrm[2] * LIGHT[2]);
      const shade = 0.42 + 0.58 * diffuse;
      const cr = baseColor[0] * shade;
      const cg = baseColor[1] * shade;
      const cb = baseColor[2] * shade;

      const d0 = [wa[0] - cam.eye[0], wa[1] - cam.eye[1], wa[2] - cam.eye[2]];
      const d1 = [wb[0] - cam.eye[0], wb[1] - cam.eye[1], wb[2] - cam.eye[2]];
      const d2 = [wc[0] - cam.eye[0], wc[1] - cam.eye[1], wc[2] - cam.eye[2]];
      const va = { x: d0[0] * b.r[0] + d0[1] * b.r[1] + d0[2] * b.r[2], y: d0[0] * b.u[0] + d0[1] * b.u[1] + d0[2] * b.u[2], z: d0[0] * b.f[0] + d0[1] * b.f[1] + d0[2] * b.f[2] };
      const vb = { x: d1[0] * b.r[0] + d1[1] * b.r[1] + d1[2] * b.r[2], y: d1[0] * b.u[0] + d1[1] * b.u[1] + d1[2] * b.u[2], z: d1[0] * b.f[0] + d1[1] * b.f[1] + d1[2] * b.f[2] };
      const vc = { x: d2[0] * b.r[0] + d2[1] * b.r[1] + d2[2] * b.r[2], y: d2[0] * b.u[0] + d2[1] * b.u[1] + d2[2] * b.u[2], z: d2[0] * b.f[0] + d2[1] * b.f[1] + d2[2] * b.f[2] };

      // 任一平面全在外则整三角形丢弃（快速拒绝）
      let trivialOut = false;
      for (const pl of planes) {
        if (pl.g(va.x, va.y, va.z) < 0 && pl.g(vb.x, vb.y, vb.z) < 0 && pl.g(vc.x, vc.y, vc.z) < 0) {
          trivialOut = true;
          break;
        }
      }
      if (trivialOut) continue;

      let poly = [va, vb, vc];
      for (const pl of planes) {
        poly = clipPolygonPlane(poly, pl);
        if (poly.length < 3) break;
      }
      if (poly.length < 3) continue;

      if (stats) stats.clippedTris++;

      // 投影裁剪后顶点
      const sp = new Array(poly.length);
      for (let k = 0; k < poly.length; k++) {
        const p = poly[k];
        const invZ = 1 / p.z;
        sp[k] = {
          invZ,
          depth: A + B * invZ,
          x: (p.x / p.z / kx * 0.5 + 0.5) * W,
          y: (0.5 - p.y / p.z / t * 0.5) * H,
        };
      }

      // 扇形三角化
      for (let k = 1; k + 1 < sp.length; k++) {
        const p0 = sp[0];
        const p1 = sp[k];
        const p2 = sp[k + 1];
        const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x)));
        const maxX = Math.min(W - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
        const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y)));
        const maxY = Math.min(H - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
        if (minX > maxX || minY > maxY) continue;

        const area = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
        if (Math.abs(area) < 1e-10) continue;
        const invArea = 1 / area;

        for (let py = minY; py <= maxY; py++) {
          const fy = py + 0.5;
          for (let px = minX; px <= maxX; px++) {
            const fx = px + 0.5;
            // 边函数
            const e0 = (p2.x - p1.x) * (fy - p1.y) - (p2.y - p1.y) * (fx - p1.x);
            const e1 = (p0.x - p2.x) * (fy - p2.y) - (p0.y - p2.y) * (fx - p2.x);
            const e2 = (p1.x - p0.x) * (fy - p0.y) - (p1.y - p0.y) * (fx - p0.x);
            let w0 = e0 * invArea;
            let w1 = e1 * invArea;
            let w2 = e2 * invArea;
            // 除以带符号面积后即真实重心权重；留微小容差避免共享边漏点。
            const EPS_W = 1e-6;
            if (w0 < -EPS_W || w1 < -EPS_W || w2 < -EPS_W) continue;
            if (w0 < 0) w0 = 0;
            if (w1 < 0) w1 = 0;
            if (w2 < 0) w2 = 0;
            const invZ = w0 * p0.invZ + w1 * p1.invZ + w2 * p2.invZ;
            const d = A + B * invZ;
            if (d < 0 || d > 1 + 1e-6) continue;
            const off = py * W + px;
            if (d < rt.depth[off]) {
              rt.depth[off] = d;
              rt.uid[off] = uid;
              if (writeMask) rt.mask[off] = objMask;
              const ci = off * 4;
              rt.color[ci] = cr;
              rt.color[ci + 1] = cg;
              rt.color[ci + 2] = cb;
              rt.color[ci + 3] = 255;
              if (stats) stats.shadedPixels++;
            }
          }
        }
      }
    }
  }
}

// 从 uid 缓冲统计每个 uid 的可见像素数（无遮挡参照的可见集依据）。
export function countUidPixels(rt) {
  const counts = new Map();
  for (let i = 0; i < rt.uid.length; i++) {
    const u = rt.uid[i];
    if (u !== 0) counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  return counts;
}

// 统计 mask 缓冲中各 occluder bit 实际贡献的像素。
export function countMaskBits(rt) {
  const counts = new Map();
  for (let i = 0; i < rt.mask.length; i++) {
    let m = rt.mask[i] >>> 0;
    while (m) {
      const bit = 31 - Math.clz32(m);
      counts.set(bit, (counts.get(bit) ?? 0) + 1);
      m &= ~(1 << bit);
    }
  }
  return counts;
}
