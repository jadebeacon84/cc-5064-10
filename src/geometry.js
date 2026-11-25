// 程序化几何与包围体。所有最终顶点都烘焙到世界坐标，场景静态、只有相机动。
// bounds 支持：
//   { kind:'vertices', vertices:[[x,y,z]...] } 凸包/OBB 角点
//   { kind:'sphere', center, radius }
//   { kind:'compound', parts:[bounds...] }
// 查询端必须使用完整包围体投影，禁止用中心点代替整体判定。

import { cross, normalize } from './math3d.js';

export function transformPositions(positions, tr = {}) {
  const { position = [0, 0, 0], rotationY = 0, scale = 1 } = tr;
  const sx = Array.isArray(scale) ? scale[0] : scale;
  const sy = Array.isArray(scale) ? scale[1] : scale;
  const sz = Array.isArray(scale) ? scale[2] : scale;
  const c = Math.cos(rotationY);
  const s = Math.sin(rotationY);
  const out = new Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    let x = positions[i] * sx;
    let y = positions[i + 1] * sy;
    let z = positions[i + 2] * sz;
    // 绕 Y 旋转
    const rx = c * x + s * z;
    const rz = -s * x + c * z;
    out[i] = rx + position[0];
    out[i + 1] = y + position[1];
    out[i + 2] = rz + position[2];
  }
  return out;
}

// 8 角点盒体 + 12 三角形（索引）。
export function boxGeometry(w, h, d) {
  const x = w / 2;
  const y = h / 2;
  const z = d / 2;
  const positions = [
    -x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z,
    -x, -y, z, x, -y, z, x, y, z, -x, y, z,
  ];
  // 朝外绕序（不开启背面剔除，绕序仅影响法线方向的符号兜底）
  const indices = [
    0, 2, 1, 0, 3, 2, // -z
    4, 5, 6, 4, 6, 7, // +z
    0, 1, 5, 0, 5, 4, // -y
    3, 6, 2, 3, 7, 6, // +y
    1, 2, 6, 1, 6, 5, // +x
    0, 4, 7, 0, 7, 3, // -x
  ];
  return { positions, indices };
}

export function sphereGeometry(radius = 1, seg = 16, rings = 10) {
  const positions = [];
  const indices = [];
  for (let j = 0; j <= rings; j++) {
    const phi = (j / rings) * Math.PI;
    const y = Math.cos(phi) * radius;
    const rr = Math.sin(phi) * radius;
    for (let i = 0; i <= seg; i++) {
      const theta = (i / seg) * Math.PI * 2;
      positions.push(Math.cos(theta) * rr, y, Math.sin(theta) * rr);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      const b = a + seg + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  return { positions, indices };
}

// 二十面体（可缩放成复杂凸包包围体）。
export function icosahedronGeometry() {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const positions = [];
  for (const p of raw) {
    const n = normalize(p);
    positions.push(n[0], n[1], n[2]);
  }
  // 每组 3 个索引构成面（20 面）
  const indices = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
  ];
  return { positions, indices };
}

// 把局部 8 角点盒包围体按同一变换烘焙到世界。
export function boxBounds(w, h, d, tr = {}) {
  const g = boxGeometry(w, h, d);
  const baked = transformPositions(g.positions, tr);
  const vertices = [];
  for (let i = 0; i < baked.length; i += 3) vertices.push([baked[i], baked[i + 1], baked[i + 2]]);
  return { kind: 'vertices', vertices };
}

export function hullBoundsFromGeometry(geometry, tr = {}) {
  const baked = transformPositions(geometry.positions, tr);
  const vertices = [];
  for (let i = 0; i < baked.length; i += 3) vertices.push([baked[i], baked[i + 1], baked[i + 2]]);
  return { kind: 'vertices', vertices };
}

export function sphereBounds(center, radius) {
  return { kind: 'sphere', center: center.slice(), radius };
}

export function compoundBounds(parts) {
  return { kind: 'compound', parts };
}

// 生成球体在当前相机基下的外切相机对齐立方体角点（保守包围球）。
export function sphereBoundVertices(bounds, cam, b) {
  const c = bounds.center;
  const R = bounds.radius;
  const out = [];
  for (const sz of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sx of [-1, 1]) {
        out.push([
          c[0] + b.r[0] * R * sx + b.u[0] * R * sy + b.f[0] * R * sz,
          c[1] + b.r[1] * R * sx + b.u[1] * R * sy + b.f[1] * R * sz,
          c[2] + b.r[2] * R * sx + b.u[2] * R * sy + b.f[2] * R * sz,
        ]);
      }
    }
  }
  return out;
}

// 展开任意 bounds 为当前相机下可投影的凸顶点数组（compound 合并）。
export function boundVertices(bounds, cam, b) {
  if (bounds.kind === 'vertices') return bounds.vertices;
  if (bounds.kind === 'sphere') return sphereBoundVertices(bounds, cam, b);
  const all = [];
  for (const p of bounds.parts) all.push(...boundVertices(p, cam, b));
  return all;
}

export function countTriangles(obj) {
  return obj.indices.length / 3;
}

// 简单包围体可视化线框（返回世界线段端点对），供调试视窗绘制。
export function boundWireSegments(bounds, cam, b) {
  const segs = [];
  if (bounds.kind === 'sphere') {
    // 用 3 个圆环近似球线框
    const c = bounds.center;
    const R = bounds.radius;
    const rings = [
      { a: b.r, q: b.u },
      { a: b.r, q: b.f },
      { a: b.u, q: b.f },
    ];
    for (const ring of rings) {
      let prev = null;
      for (let i = 0; i <= 24; i++) {
        const t = (i / 24) * Math.PI * 2;
        const p = [
          c[0] + (ring.a[0] * Math.cos(t) + ring.q[0] * Math.sin(t)) * R,
          c[1] + (ring.a[1] * Math.cos(t) + ring.q[1] * Math.sin(t)) * R,
          c[2] + (ring.a[2] * Math.cos(t) + ring.q[2] * Math.sin(t)) * R,
        ];
        if (prev) segs.push([prev, p]);
        prev = p;
      }
    }
    return segs;
  }
  if (bounds.kind === 'compound') {
    for (const p of bounds.parts) segs.push(...boundWireSegments(p, cam, b));
    return segs;
  }
  // vertices：若是 8 角盒按盒边连接；否则只画凸包索引（若提供 hullIndices）
  const v = bounds.vertices;
  if (bounds.edgeIndices) {
    for (let i = 0; i < bounds.edgeIndices.length; i += 2) {
      segs.push([v[bounds.edgeIndices[i]], v[bounds.edgeIndices[i + 1]]]);
    }
    return segs;
  }
  if (v.length === 8) {
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    for (const [a, bb] of edges) segs.push([v[a], v[bb]]);
  }
  return segs;
}

// 世界空间三角形法线（着色用）。
export function triangleNormal(a, bb, c) {
  const e1 = [bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return normalize(cross(e1, e2));
}
