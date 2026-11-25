// 最小 3D 数学 / 相机 / 投影模块。
// 全项目统一约定（改动时必须同步 raster.js 与 hiz.js）：
//   相机空间 z 轴沿视线向前为正；近裁面 z = near，远裁面 z = far。
//   深度缓冲值 d(z) = far/(far-near) * (1 - near/z)，范围 [0,1]，
//   值越小越近。Hi-Z 每层做 max 归约（取区块内最远遮挡深度）。

export const TAU = Math.PI * 2;

export function v3(x = 0, y = 0, z = 0) {
  return [x, y, z];
}
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export function normalize(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const lerp = (a, b, t) => a + (b - a) * t;

// orbit 相机：target 为环绕中心，yaw/pitch 为弧度，distance 为轨道半径。
export function makeOrbitCamera(opts = {}) {
  const {
    target = [0, 1.4, 0],
    yaw = 0,
    pitch = 0.12,
    distance = 13,
    fovY = Math.PI / 3,
    aspect = 16 / 9,
    near = 0.1,
    far = 80,
  } = opts;
  const cp = Math.cos(pitch);
  const eye = [
    target[0] + Math.sin(yaw) * cp * distance,
    target[1] + Math.sin(pitch) * distance,
    target[2] + Math.cos(yaw) * cp * distance,
  ];
  return { kind: 'orbit', target: target.slice(), yaw, pitch, distance, fovY, aspect, near, far, eye };
}

// 自由参数相机（校验扫描用）。
export function makeCamera(eye, target, opts = {}) {
  return {
    kind: 'free',
    eye: eye.slice(),
    target: target.slice(),
    yaw: 0,
    pitch: 0,
    distance: 0,
    fovY: opts.fovY ?? Math.PI / 3,
    aspect: opts.aspect ?? 16 / 9,
    near: opts.near ?? 0.1,
    far: opts.far ?? 80,
  };
}

// 基向量：forward 指向场景；
// right = forward × worldUp；up = right × forward。
// 对默认机位（eye 在 +Z 看向 -Z）得到 right=+X，画面不镜像。
export function basis(cam) {
  const f = normalize(sub(cam.target, cam.eye));
  const worldUp = [0, 1, 0];
  let r = normalize(cross(f, worldUp));
  if (length(r) < 1e-6) r = [1, 0, 0];
  const u = cross(r, f);
  return { f, r, u };
}

// 相机坐标：z 沿视线向前为正。
export function viewCoords(p, cam, b = basis(cam)) {
  const d = sub(p, cam.eye);
  return { x: dot(d, b.r), y: dot(d, b.u), z: dot(d, b.f) };
}

export function depthFromZ(z, cam) {
  return (cam.far / (cam.far - cam.near)) * (1 - cam.near / z);
}

// 与 depthFromZ 互逆。
export function zFromDepth(d, cam) {
  const A = cam.far / (cam.far - cam.near);
  const B = (-cam.far * cam.near) / (cam.far - cam.near);
  return B / (d - A);
}

// 投影一个世界点；z<=0 时 ndc 无意义，调用方需先做近裁判定。
export function projectWorld(p, cam, b, width, height) {
  const vc = viewCoords(p, cam, b);
  const t = Math.tan(cam.fovY / 2);
  const ndcX = vc.x / (vc.z * t * cam.aspect);
  const ndcY = vc.y / (vc.z * t);
  return {
    vc,
    ndcX,
    ndcY,
    depth: depthFromZ(vc.z, cam),
    sx: (ndcX * 0.5 + 0.5) * width,
    sy: (0.5 - ndcY * 0.5) * height,
  };
}

// 相机空间的 6 个视锥平面，统一为 g(x,y,z) >= 0 表示在内部。
// 返回的 g 直接作用于 viewCoords。
export function frustumPlanes(cam) {
  const t = Math.tan(cam.fovY / 2);
  const kx = t * cam.aspect;
  const n = cam.near;
  const f = cam.far;
  return [
    { name: 'near', g: (x, y, z) => z - n },
    { name: 'far', g: (x, y, z) => f - z },
    { name: 'left', g: (x, y, z) => x + kx * z },
    { name: 'right', g: (x, y, z) => kx * z - x },
    { name: 'bottom', g: (x, y, z) => y + t * z },
    { name: 'top', g: (x, y, z) => t * z - y },
  ];
}

// 点集相对相机的保守屏幕位移界限（Hi-Z/光栅像素单位）。
// 任一点落到任一相机近裁面之后时返回 Infinity：此时旧证据必须重建。
// 同时返回深度值变化的最大幅度，供证据陈旧度参考。
export function motionBound(cam0, cam1, worldPoints, width, height) {
  const b0 = basis(cam0);
  const b1 = basis(cam1);
  const t0 = Math.tan(cam0.fovY / 2);
  const t1 = Math.tan(cam1.fovY / 2);
  let maxPx = 0;
  let maxDepthDelta = 0;
  for (const p of worldPoints) {
    const v0 = viewCoords(p, cam0, b0);
    const v1 = viewCoords(p, cam1, b1);
    if (v0.z <= cam0.near || v1.z <= cam1.near) return { pixels: Infinity, depthDelta: Infinity };
    const x0 = (v0.x / (v0.z * t0 * cam0.aspect) * 0.5 + 0.5) * width;
    const y0 = (0.5 - (v0.y / (v0.z * t0)) * 0.5) * height;
    const x1 = (v1.x / (v1.z * t1 * cam1.aspect) * 0.5 + 0.5) * width;
    const y1 = (0.5 - (v1.y / (v1.z * t1)) * 0.5) * height;
    const dx = x1 - x0;
    const dy = y1 - y0;
    maxPx = Math.max(maxPx, Math.hypot(dx, dy), Math.abs(dx) + Math.abs(dy) * 0);
    maxDepthDelta = Math.max(maxDepthDelta, Math.abs(depthFromZ(v1.z, cam1) - depthFromZ(v0.z, cam0)));
  }
  return { pixels: maxPx, depthDelta: maxDepthDelta };
}

// 两相机是否逐分量相同（证据戳记比较）。
export function sameCamera(a, b, eps = 1e-9) {
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.eye[i] - b.eye[i]) > eps) return false;
    if (Math.abs(a.target[i] - b.target[i]) > eps) return false;
  }
  return (
    Math.abs(a.fovY - b.fovY) <= eps &&
    Math.abs(a.aspect - b.aspect) <= eps &&
    Math.abs(a.near - b.near) <= eps &&
    Math.abs(a.far - b.far) <= eps
  );
}
