// 声明式场景：遮挡墙阵列 / 小孔窥视 / 复杂包围形状。
// 场景不包含任何“预期可见列表”；可见性只能由参照渲染与 Hi-Z 证据实际算出。

import {
  boxGeometry, sphereGeometry, icosahedronGeometry,
  transformPositions, boxBounds, hullBoundsFromGeometry,
  sphereBounds, compoundBounds,
} from './geometry.js';

let UID = 1;

function finalize(obj) {
  obj.uid = UID++;
  obj.triCount = obj.indices.length / 3;
  return obj;
}

export function resetUids() {
  UID = 1;
}

function boxObject(cfg) {
  const { w, h, d, tr = {}, color, id, name, occluder = false } = cfg;
  const g = boxGeometry(w, h, d);
  return finalize({
    id, name, color,
    positions: transformPositions(g.positions, tr),
    indices: g.indices,
    bounds: boxBounds(w, h, d, tr),
    reliableOccluder: occluder,
    candidate: cfg.candidate ?? !occluder,
  });
}

function sphereObject(cfg) {
  const { radius, position, color, id, name, seg = 16, rings = 10 } = cfg;
  const g = sphereGeometry(radius, seg, rings);
  return finalize({
    id, name, color,
    positions: transformPositions(g.positions, { position }),
    indices: g.indices,
    bounds: sphereBounds(position, radius),
    reliableOccluder: false,
    candidate: true,
  });
}

function hullObject(cfg) {
  const { tr, scale, color, id, name } = cfg;
  const g = icosahedronGeometry();
  const t2 = { ...tr, scale: scale ?? tr?.scale ?? 1 };
  return finalize({
    id, name, color,
    positions: transformPositions(g.positions, t2),
    indices: g.indices,
    bounds: hullBoundsFromGeometry(g, t2),
    reliableOccluder: false,
    candidate: true,
  });
}

// 合并多个带独立变换的几何，生成一个对象 + compound 包围体。
function mergedObject(cfg) {
  const { parts, color, id, name } = cfg;
  const positions = [];
  const indices = [];
  const boundsParts = [];
  let vertexOffset = 0;
  for (const part of parts) {
    let g;
    let bounds;
    if (part.type === 'ico') {
      g = icosahedronGeometry();
      bounds = hullBoundsFromGeometry(g, part.tr);
    } else if (part.type === 'sphere') {
      g = sphereGeometry(part.radius, 12, 8);
      bounds = sphereBounds(part.tr.position, part.radius);
    } else {
      g = boxGeometry(part.w, part.h, part.d);
      bounds = boxBounds(part.w, part.h, part.d, part.tr);
    }
    const baked = transformPositions(g.positions, part.tr);
    for (const v of baked) positions.push(v);
    for (const ix of g.indices) indices.push(ix + vertexOffset);
    vertexOffset += baked.length / 3;
    boundsParts.push(bounds);
  }
  return finalize({
    id, name, color, positions, indices,
    bounds: compoundBounds(boundsParts),
    reliableOccluder: false,
    candidate: true,
  });
}

function ground() {
  return boxObject({
    id: 'ground', name: '地面', w: 60, h: 0.2, d: 60,
    tr: { position: [0, -0.1, 0] }, color: [44, 52, 66], candidate: false,
  });
}

function assignOccluderBits(objects) {
  let bit = 0;
  for (const o of objects) {
    if (o.reliableOccluder) {
      o.bitIndex = bit;
      o.occluderBit = 1 << bit;
      bit++;
    }
  }
}

// 场景 1：大遮挡墙 + 墙后阵列 + 两侧/墙前可见物。
function wallScene() {
  const objects = [ground()];
  objects.push(boxObject({
    id: 'wall-main', name: '主遮挡墙', w: 10, h: 5, d: 0.6,
    tr: { position: [0, 2.5, -2] }, color: [126, 136, 152], occluder: true,
  }));
  objects.push(boxObject({
    id: 'wall-left-wing', name: '左翼墙', w: 0.6, h: 4, d: 5,
    tr: { position: [-5.6, 2, -3.6] }, color: [112, 122, 140], occluder: true,
  }));
  objects.push(boxObject({
    id: 'wall-right-pillar', name: '右立柱', w: 1.2, h: 5.5, d: 1.2,
    tr: { position: [5.4, 2.75, -2.4] }, color: [118, 128, 146], occluder: true,
  }));

  // 墙后两排箱子：默认机位下应被 Hi-Z 剔除。
  const crateColors = [[216, 142, 66], [196, 96, 72], [224, 178, 92]];
  const xs = [-3.3, -1.1, 1.1, 3.3];
  let n = 0;
  for (const z of [-4.2, -6.0]) {
    for (const x of xs) {
      objects.push(boxObject({
        id: `behind-crate-${n}`, name: `墙后箱 ${n + 1}`,
        w: 1.15, h: 1.15, d: 1.15,
        tr: { position: [x, 0.575, z], rotationY: (n % 3) * 0.21 },
        color: crateColors[n % 3],
      }));
      n++;
    }
  }
  // 墙后小球堆（球包围体）
  objects.push(sphereObject({
    id: 'behind-sphere-1', name: '墙后球 A', radius: 0.7,
    position: [-2.2, 0.7, -5.1], color: [96, 178, 214],
  }));
  objects.push(sphereObject({
    id: 'behind-sphere-2', name: '墙后球 B', radius: 0.55,
    position: [2.4, 0.55, -5.4], color: [150, 120, 210],
  }));

  // 墙两侧外：必须可见。
  objects.push(boxObject({
    id: 'side-crate-l', name: '左侧箱', w: 1.4, h: 1.4, d: 1.4,
    tr: { position: [-6.6, 0.7, -1.6] }, color: [86, 190, 168],
  }));
  objects.push(boxObject({
    id: 'side-crate-r', name: '右侧箱', w: 1.4, h: 1.4, d: 1.4,
    tr: { position: [6.9, 0.7, -3.4] }, color: [86, 190, 168],
  }));
  // 墙前：必须可见。
  objects.push(boxObject({
    id: 'front-crate-1', name: '墙前箱', w: 1.5, h: 1.0, d: 1.2,
    tr: { position: [-1.8, 0.5, 1.6], rotationY: 0.4 }, color: [222, 120, 92],
  }));
  objects.push(sphereObject({
    id: 'front-sphere', name: '墙前球', radius: 0.8,
    position: [2.2, 0.8, 2.2], color: [232, 200, 96],
  }));

  assignOccluderBits(objects);
  return {
    id: 'wall',
    name: '遮挡墙阵列',
    description: '整面可靠遮挡墙后藏有两排箱子与球；两侧和墙前物件不可被误剔。',
    camera: { target: [0, 1.7, -1.2], yaw: 0, pitch: 0.1, distance: 14.5 },
    objects,
  };
}

// 场景 2：带小孔的墙。孔后宝物只能透过小孔看见 -> 绝不允许被矩形查询误剔。
function holeScene() {
  const objects = [ground()];
  const wallColor = [132, 128, 122];
  const z = -2;
  // 孔范围 x[-0.7,0.7], y[1.55,2.85]
  objects.push(boxObject({
    id: 'hole-wall-left', name: '孔墙-左段', w: 4.3, h: 5, d: 0.6,
    tr: { position: [-2.85, 2.5, z] }, color: wallColor, occluder: true,
  }));
  objects.push(boxObject({
    id: 'hole-wall-right', name: '孔墙-右段', w: 4.3, h: 5, d: 0.6,
    tr: { position: [2.85, 2.5, z] }, color: wallColor, occluder: true,
  }));
  objects.push(boxObject({
    id: 'hole-wall-bottom', name: '孔墙-下坎', w: 1.4, h: 1.55, d: 0.6,
    tr: { position: [0, 0.775, z] }, color: [124, 120, 114], occluder: true,
  }));
  objects.push(boxObject({
    id: 'hole-wall-top', name: '孔墙-上梁', w: 1.4, h: 2.15, d: 0.6,
    tr: { position: [0, 3.925, z] }, color: [124, 120, 114], occluder: true,
  }));

  // 孔后宝物：与小孔对齐，参照渲染中应有像素。
  objects.push(hullObject({
    id: 'treasure', name: '孔后宝石',
    tr: { position: [0, 2.2, -4.2], rotationY: 0.3, scale: [0.62, 0.85, 0.62] },
    color: [90, 230, 200],
  }));
  // 孔后立柱（细），部分透过孔可见
  objects.push(boxObject({
    id: 'behind-hole-pillar', name: '孔后细柱', w: 0.5, h: 3.2, d: 0.5,
    tr: { position: [0.35, 1.6, -5.2] }, color: [180, 120, 220],
  }));

  // 实墙后的箱子：可剔除。
  objects.push(boxObject({
    id: 'hole-behind-l', name: '左实墙后箱', w: 1.3, h: 1.3, d: 1.3,
    tr: { position: [-2.9, 0.65, -4.4] }, color: [216, 142, 66],
  }));
  objects.push(boxObject({
    id: 'hole-behind-r', name: '右实墙后箱', w: 1.3, h: 1.3, d: 1.3,
    tr: { position: [2.9, 0.65, -4.4] }, color: [196, 96, 72],
  }));
  objects.push(sphereObject({
    id: 'hole-behind-sphere', name: '右墙后球', radius: 0.75,
    position: [2.2, 0.75, -5.6], color: [96, 178, 214],
  }));

  // 孔前指示物
  objects.push(boxObject({
    id: 'hole-front-marker', name: '孔前标记箱', w: 0.9, h: 0.9, d: 0.9,
    tr: { position: [-1.7, 0.45, 0.8] }, color: [232, 200, 96],
  }));

  assignOccluderBits(objects);
  return {
    id: 'hole',
    name: '小孔窥视',
    description: '墙中央留有真实小孔，宝石只能透过孔被看见：任何把孔区也算作遮挡的粗判都会误剔它。',
    camera: { target: [0, 2.05, -1.6], yaw: 0, pitch: 0.04, distance: 12.5 },
    objects,
  };
}

// 场景 3：复杂包围形状 + “中心被挡但端部外露”的长条物。
function complexScene() {
  const objects = [ground()];
  objects.push(boxObject({
    id: 'cx-back-wall', name: '复杂场-后墙', w: 9, h: 5.5, d: 0.7,
    tr: { position: [0.5, 2.75, -3] }, color: [118, 130, 138], occluder: true,
  }));
  objects.push(boxObject({
    id: 'cx-side-wall', name: '复杂场-侧墙', w: 0.7, h: 4.5, d: 4,
    tr: { position: [-4.6, 2.25, -2] }, color: [108, 120, 130], occluder: true,
  }));

  // 缩放二十面体：凸包包围体
  objects.push(hullObject({
    id: 'crystal-tall', name: '高晶簇(凸包)',
    tr: { position: [-1.6, 1.5, -4.6], rotationY: 0.5, scale: [0.9, 1.7, 0.9] },
    color: [120, 200, 255],
  }));
  objects.push(hullObject({
    id: 'crystal-fat', name: '宽晶石(凸包)',
    tr: { position: [1.8, 1.1, -4.8], rotationY: 1.1, scale: [1.5, 1.0, 1.2] },
    color: [190, 140, 255],
  }));

  // compound 包围体：多块晶簇合并为一个候选
  objects.push(mergedObject({
    id: 'crystal-cluster', name: '三联晶簇(复合包围体)',
    color: [120, 230, 190],
    parts: [
      { type: 'ico', tr: { position: [0.2, 0.9, -5.4], scale: [0.7, 1.1, 0.7] } },
      { type: 'ico', tr: { position: [1.1, 0.7, -5.0], rotationY: 0.7, scale: [0.55, 0.8, 0.55] } },
      { type: 'ico', tr: { position: [-0.7, 0.6, -5.1], rotationY: -0.4, scale: [0.5, 0.7, 0.5] } },
    ],
  }));

  // 中心藏在墙后、左端明显伸出墙外的长梁：禁止用中心点判定剔除。
  objects.push(boxObject({
    id: 'long-beam', name: '外露长梁(中心被挡)', w: 12.5, h: 0.6, d: 0.6,
    tr: { position: [-2.4, 2.8, -4.4], rotationY: 0.34 }, color: [232, 130, 80],
  }));

  // 完全位于墙后的小物：可剔除
  objects.push(mergedObject({
    id: 'behind-cluster', name: '墙后复合货堆',
    color: [220, 170, 80],
    parts: [
      { type: 'box', w: 1.0, h: 1.0, d: 1.0, tr: { position: [0.2, 0.5, -5.2] } },
      { type: 'sphere', radius: 0.55, tr: { position: [1.2, 0.55, -5.6] } },
      { type: 'box', w: 0.8, h: 1.6, d: 0.8, tr: { position: [-0.8, 0.8, -5.5] } },
    ],
  }));

  // 墙外右侧复杂物：可见
  objects.push(hullObject({
    id: 'outside-rock', name: '墙外巨石(凸包)',
    tr: { position: [5.6, 0.9, -2.2], scale: [1.5, 0.9, 1.1], rotationY: 0.9 },
    color: [150, 160, 150],
  }));
  objects.push(sphereObject({
    id: 'cx-front-ball', name: '前场球', radius: 0.7,
    position: [-2.6, 0.7, 1.6], color: [232, 200, 96],
  }));

  assignOccluderBits(objects);
  return {
    id: 'complex',
    name: '复杂包围形状',
    description: '凸包 / 复合包围体与“中心被挡、端部外露”的长梁；查询必须覆盖完整投影矩形而非采样中心。',
    camera: { target: [0, 1.9, -1.8], yaw: 0, pitch: 0.1, distance: 14 },
    objects,
  };
}

export function createScenes() {
  resetUids();
  return [wallScene(), holeScene(), complexScene()];
}

export function createSceneById(id) {
  const all = createScenes();
  return all.find((s) => s.id === id) ?? all[0];
}
