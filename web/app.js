// 图形调试视窗主控。所有图像/集合/层级均来自 src 下的真实运算，
// 不使用预置可见名单；UI 只负责调度运算与呈现证据。

import { createScenes } from '../src/scene.js';
import { makeOrbitCamera, basis, projectWorld, zFromDepth } from '../src/math3d.js';
import { createRenderTarget, clearTarget, renderScene, countUidPixels } from '../src/raster.js';
import { runPipeline } from '../src/pipeline.js';
import { verifyScene, verifyAllScenes } from '../src/verify.js';
import { buildHiZ } from '../src/hiz.js';
import { boundWireSegments } from '../src/geometry.js';

const W = 480;
const H = 270;

const scenes = createScenes();
let sceneIndex = 0;
let scene = scenes[0];
let camState = { ...scene.camera };

let cullingOn = true;
let autoRotate = false;
let showOverlay = true;
let freezeArmed = false;
let frozenEvidence = null;
let circularSim = false;
let safeStale = false;
let moveLimit = 4;
let selectedUid = null;
let hizMode = 'linear';
let hizLevelChoice = 'auto';

const viewCanvas = document.getElementById('view');
const overlayCanvas = document.getElementById('overlay');
const vctx = viewCanvas.getContext('2d');
const octx = overlayCanvas.getContext('2d');
const offCanvas = document.getElementById('cmp-off');
const onCanvas = document.getElementById('cmp-on');
const diffCanvas = document.getElementById('cmp-diff');
const offCtx = offCanvas.getContext('2d');
const onCtx = onCanvas.getContext('2d');
const diffCtx = diffCanvas.getContext('2d');
const hizCanvas = document.getElementById('hiz-main');
const hizCtx = hizCanvas.getContext('2d');

const submittedRT = createRenderTarget(W, H);
const refRT = createRenderTarget(W, H);
const diffImage = diffCtx.createImageData(W, H);

const OWNER_PALETTE = ['#4f9cff', '#ffb020', '#37e08b', '#c792ea', '#ff7a90', '#56d6c2', '#e0d45a', '#ff8a4c'];
const ownerColor = (bit) => OWNER_PALETTE[bit % OWNER_PALETTE.length];

const uidObj = new Map();
for (const s of scenes) for (const o of s.objects) uidObj.set(o.uid, o);

// ---------- 顶部场景页签 ----------
const tabsEl = document.getElementById('scene-tabs');
scenes.forEach((s, i) => {
  const b = document.createElement('button');
  b.textContent = s.name;
  b.dataset.i = String(i);
  if (i === 0) b.classList.add('active');
  b.addEventListener('click', () => {
    sceneIndex = i;
    scene = scenes[i];
    camState = { ...scene.camera, target: scene.camera.target.slice() };
    selectedUid = null;
    hizLevelChoice = 'auto';
    if (levelSel) levelSel.value = 'auto';
    disarmFreeze();
    document.querySelectorAll('.scene-tabs button').forEach((x) => x.classList.toggle('active', Number(x.dataset.i) === i));
    buildCandidateRows();
  });
  tabsEl.appendChild(b);
});

document.getElementById('view-res').textContent = `内部光栅 ${W}×${H}`;

// ---------- 控件 ----------
document.getElementById('chk-cull').addEventListener('change', (e) => { cullingOn = e.target.checked; });
document.getElementById('chk-rotate').addEventListener('change', (e) => { autoRotate = e.target.checked; });
document.getElementById('chk-overlay').addEventListener('change', (e) => { showOverlay = e.target.checked; });
document.getElementById('btn-reset-cam').addEventListener('click', () => {
  camState = { ...scene.camera, target: scene.camera.target.slice() };
});

const freezeBtn = document.getElementById('btn-freeze');
function disarmFreeze() {
  freezeArmed = false;
  frozenEvidence = null;
  freezeBtn.classList.remove('armed');
  freezeBtn.textContent = '冻结 Hi-Z（陈旧证据实验）';
}
freezeBtn.addEventListener('click', () => {
  if (freezeArmed) { disarmFreeze(); return; }
  // 在下一帧正常流水线之后捕获证据；这里先打标记，由帧循环 arm。
  freezeArmed = 'pending';
  freezeBtn.classList.add('armed');
  freezeBtn.textContent = '点击解冻并按界限重查';
});

document.getElementById('chk-circular').addEventListener('change', (e) => {
  circularSim = e.target.checked;
  if (circularSim) {
    disarmFreeze();
    scene.objects.forEach((o, i) => { o.selfBit = 1 << Math.min(i, 30); });
  } else {
    scene.objects.forEach((o) => { o.selfBit = 0; });
  }
});

document.getElementById('sel-hiz-mode').addEventListener('change', (e) => { hizMode = e.target.value; });

// 运动界限条（只注入一次，避免拖动时重建 DOM）
const motionBox = document.getElementById('motion-box');
motionBox.innerHTML = `
  <div id="motion-detail" style="margin-bottom:6px"></div>
  <label>镜头移动界限 <b id="limit-val">4</b> Hi-Z px
    <input type="range" id="rng-limit" min="0" max="32" value="4" style="width:180px;vertical-align:-3px" />
  </label>
  <label style="margin-left:14px"><input type="checkbox" id="chk-safe-stale" /> 越界旧证据安全拦截（默认关闭以复现漏显）</label>`;
document.getElementById('rng-limit').addEventListener('input', (e) => {
  moveLimit = Number(e.target.value);
  document.getElementById('limit-val').textContent = moveLimit;
});
document.getElementById('chk-safe-stale').addEventListener('change', (e) => { safeStale = e.target.checked; });

// ---------- 相机指针控制 ----------
const wrap = document.getElementById('viewport-wrap');
let dragging = false;
let panMode = false;
let lastX = 0, lastY = 0;
function internalDelta(e) {
  const rect = overlayCanvas.getBoundingClientRect();
  return {
    dx: (e.clientX - lastX) * (W / rect.width),
    dy: (e.clientY - lastY) * (H / rect.height),
  };
}
wrap.addEventListener('pointerdown', (e) => {
  dragging = true;
  panMode = e.button === 2 || e.shiftKey;
  lastX = e.clientX; lastY = e.clientY;
  wrap.classList.add('dragging');
  wrap.setPointerCapture(e.pointerId);
});
wrap.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const rect = overlayCanvas.getBoundingClientRect();
  const dx = (e.clientX - lastX) * (W / rect.width);
  const dy = (e.clientY - lastY) * (H / rect.height);
  lastX = e.clientX; lastY = e.clientY;
  if (panMode || e.shiftKey) {
    const cam = makeOrbitCamera({ target: camState.target, yaw: camState.yaw, pitch: camState.pitch, distance: camState.distance, aspect: W / H });
    const bb = basis(cam);
    const k = (2 * camState.distance * Math.tan((camState.fovY ?? Math.PI / 3) / 2)) / H;
    const t = camState.target;
    for (let i = 0; i < 3; i++) t[i] -= bb.r[i] * dx * k + bb.u[i] * dy * k;
  } else {
    camState.yaw -= dx * 0.006;
    camState.pitch = Math.max(-1.25, Math.min(1.35, camState.pitch - dy * 0.005));
  }
});
function endDrag(e) { dragging = false; wrap.classList.remove('dragging'); }
wrap.addEventListener('pointerup', endDrag);
wrap.addEventListener('pointercancel', endDrag);
wrap.addEventListener('contextmenu', (e) => e.preventDefault());
wrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  camState.distance = Math.max(2.2, Math.min(48, camState.distance * Math.exp(e.deltaY * 0.0011)));
}, { passive: false });

// ---------- 候选表 ----------
const rowsEl = document.getElementById('candidate-rows');
let rowRefs = new Map();
function buildCandidateRows() {
  rowsEl.innerHTML = '';
  rowRefs = new Map();
  for (const o of scene.objects.filter((x) => x.candidate === true)) {
    const tr = document.createElement('tr');
    tr.dataset.uid = String(o.uid);
    tr.innerHTML = `
      <td class="name">${o.name}<div class="dim mono">${o.id} · ${o.triCount} tri</div></td>
      <td><span class="badge">…</span></td>
      <td class="mono refpx">–</td>
      <td class="mono slack">–</td>
      <td class="mono tex">–</td>
      <td class="owners"></td>`;
    tr.addEventListener('click', () => {
      selectedUid = selectedUid === o.uid ? null : o.uid;
      document.querySelectorAll('.cand-table tr').forEach((r) => r.classList.toggle('selected', Number(r.dataset.uid) === selectedUid));
      const d = lastPipe?.decisions.get(o.uid);
      if (selectedUid && d?.query) {
        hizLevelChoice = String(d.query.level);
        const sel = document.getElementById('sel-level');
        if (sel) sel.value = hizLevelChoice;
      }
    });
    rowsEl.appendChild(tr);
    rowRefs.set(o.uid, {
      tr,
      badge: tr.querySelector('.badge'),
      px: tr.querySelector('.refpx'),
      slack: tr.querySelector('.slack'),
      tex: tr.querySelector('.tex'),
      owners: tr.querySelector('.owners'),
    });
  }
}
buildCandidateRows();

// 深度层选择下拉（含“跟随选中”）
const hizPanelHead = document.querySelector('.hiz-panel .panel-head');
const levelSel = document.createElement('select');
levelSel.id = 'sel-level';
levelSel.innerHTML = '<option value="auto">层级: 跟随/0</option>';
levelSel.addEventListener('change', () => { hizLevelChoice = levelSel.value; });
hizPanelHead.appendChild(levelSel);

// ---------- 伪彩 ----------
function heat(t) {
  t = Math.max(0, Math.min(1, t));
  // 深蓝 -> 青 -> 绿 -> 黄 -> 红
  const stops = [[10, 18, 60], [30, 120, 220], [40, 210, 190], [120, 220, 90], [240, 170, 40], [235, 60, 60]];
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function paintLevelImage(targetCtx, canvas, level, cam, mode) {
  canvas.width = level.width;
  canvas.height = level.height;
  const img = targetCtx.createImageData(level.width, level.height);
  const data = img.data;
  for (let i = 0; i < level.depth.length; i++) {
    let r = 0, g = 0, b = 0;
    const d = level.depth[i];
    if (mode === 'raw') {
      const v = Math.max(0, Math.min(255, Math.round(d * 255)));
      r = g = b = v;
    } else if (mode === 'linear') {
      if (d >= 0.999999) { r = 6; g = 8; b = 14; }
      else {
        const z = zFromDepth(d, cam);
        const t = (z - 1.5) / 22;
        [r, g, b] = heat(t);
      }
    } else {
      const m = level.mask[i] >>> 0;
      if (m === 0) { r = 4; g = 6; b = 10; }
      else {
        let bit = 0;
        let mm = m;
        while (!(mm & 1)) { bit++; mm >>= 1; }
        const c = OWNER_PALETTE[bit % OWNER_PALETTE.length];
        r = parseInt(c.slice(1, 3), 16); g = parseInt(c.slice(3, 5), 16); b = parseInt(c.slice(5, 7), 16);
      }
    }
    const o = i * 4;
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
  }
  targetCtx.putImageData(img, 0, 0);
}

let lastPipe = null;
let lastRefCounts = new Map();
let lastOnCounts = new Map();
let lastActualCulled = [];
let lastFalseCulls = [];

function paintHiz(pipe, cam) {
  const hiZ = pipe.hiZ;
  // 层级按钮
  const strip = document.getElementById('hiz-levels');
  if (strip.childElementCount !== hiZ.levels.length) {
    strip.innerHTML = '';
    hiZ.levels.forEach((L, idx) => {
      const div = document.createElement('div');
      div.className = 'hiz-level';
      const cv = document.createElement('canvas');
      cv.width = L.width; cv.height = L.height;
      const lb = document.createElement('div');
      lb.className = 'lb';
      lb.textContent = `L${idx} ${L.width}×${L.height}`;
      div.appendChild(cv); div.appendChild(lb);
      div.addEventListener('click', () => { hizLevelChoice = String(idx); levelSel.value = String(idx); });
      strip.appendChild(div);
    });
    levelSel.innerHTML = '<option value="auto">层级: 跟随选中</option>' +
      hiZ.levels.map((L, i) => `<option value="${i}">L${i} (${L.width}×${L.height})</option>`).join('');
  }
  let idx;
  if (hizLevelChoice === 'auto') {
    const d = selectedUid != null ? pipe.decisions.get(selectedUid) : null;
    idx = d?.query?.level ?? 0;
  } else idx = Number(hizLevelChoice) || 0;
  idx = Math.min(idx, hiZ.levels.length - 1);

  [...strip.children].forEach((el, i) => el.classList.toggle('active', i === idx));
  const L = hiZ.levels[idx];
  paintLevelImage(hizCtx, hizCanvas, L, cam, hizMode);

  // 选中候选的查询纹素框
  const d = selectedUid != null ? pipe.decisions.get(selectedUid) : null;
  if (d?.query && d.query.level === idx) {
    const tr = d.query.texelRect;
    hizCtx.strokeStyle = '#ffffff';
    hizCtx.lineWidth = 1;
    hizCtx.strokeRect(tr.tx0 + 0.5, tr.ty0 + 0.5, tr.tx1 - tr.tx0 + 1 - 1, tr.ty1 - tr.ty0 + 1 - 1);
  }
  // 缩略图
  [...strip.children].forEach((el, i) => {
    const cv = el.querySelector('canvas');
    const ctx = cv.getContext('2d');
    paintLevelImage(ctx, cv, hiZ.levels[i], cam, hizMode);
  });

  const legend = document.getElementById('hiz-legend');
  if (hizMode === 'mask') {
    legend.innerHTML = '来源：' + [...pipe.ownerNames.entries()]
      .map(([bit, name]) => `<span class="owner-tag" style="border-left:3px solid ${ownerColor(bit)}">${name}</span>`).join(' ');
  } else if (hizMode === 'linear') {
    legend.textContent = '线性视深伪彩：蓝=近（约1.5m），红=远（约23.5m），近黑=远裁/空。max 归约使粗层偏向更远、更保守。';
  } else {
    legend.textContent = '原始深度值：本场景距离下普遍接近 1（深度缓冲非线性），建议看线性视深。';
  }
}

// ---------- overlay ----------
const STATUS_COLOR = {
  occluded: '#ffb020', submitted: '#37e08b', 'edge-fallback': '#56b6ff',
  'near-fallback': '#c792ea', 'outside-frustum': '#7a869c', 'stale-blocked': '#56b6ff',
};
function drawOverlay(pipe, cam) {
  octx.clearRect(0, 0, W, H);
  if (!showOverlay) return;
  const bb = basis(cam);
  octx.font = '9px ui-monospace, monospace';
  for (const o of scene.objects) {
    if (o.candidate !== true) continue;
    const d = pipe.decisions.get(o.uid);
    if (!d?.rect) continue;
    const color = STATUS_COLOR[d.status] ?? '#fff';
    const selected = o.uid === selectedUid;
    octx.strokeStyle = color;
    octx.lineWidth = selected ? 1.4 : 0.7;
    const r = d.rect;
    octx.strokeRect(r.x0 + 0.5, r.y0 + 0.5, r.x1 - r.x0, r.y1 - r.y0);
    if (selected) {
      octx.fillStyle = color;
      octx.fillText(o.name, Math.max(2, r.x0), Math.max(9, r.y0 - 2));
      // 包围体线框
      octx.globalAlpha = 0.8;
      for (const [p0, p1] of boundWireSegments(o.bounds, cam, bb)) {
        const a = projectWorld(p0, cam, bb, W, H);
        const b2 = projectWorld(p1, cam, bb, W, H);
        octx.beginPath(); octx.moveTo(a.sx, a.sy); octx.lineTo(b2.sx, b2.sy); octx.stroke();
      }
      octx.globalAlpha = 1;
      // 查询纹素覆盖
      if (d.query) {
        const s = 1 << d.query.level;
        for (const q of d.query.samples) {
          const x = q.tx * s, y = q.ty * s;
          octx.fillStyle = q.pass ? 'rgba(55,224,139,0.20)' : 'rgba(255,93,108,0.22)';
          octx.fillRect(x, y, s, s);
        }
      }
    }
  }
}

// ---------- DOM 统计刷新（节流） ----------
const statsGrid = document.getElementById('stats-grid');
function stat(k, v, cls = '') { return `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`; }

function refreshPanels(pipe, cam, frameMs, diffPixelsN) {
  const s = pipe.stats;
  const fps = Math.round(1000 / Math.max(1, frameMs));
  lastFalseCulls = lastActualCulled.filter((o) => (lastRefCounts.get(o.uid) ?? 0) > 0);
  const actualSubmittedTris = cullingOn ? s.submittedTris : s.totalTris;
  const actualSkippedTris = cullingOn ? s.skippedOcclusionTris : 0;
  statsGrid.innerHTML = [
    stat('帧时间 / FPS', `${frameMs.toFixed(1)}ms ${fps}`, frameMs < 33 ? 'good' : 'amber'),
    stat('候选 / 遮挡物', `${s.candidateCount} / ${s.occluderCount}`),
    stat(cullingOn ? 'occluded' : '查询判 occluded(未执行)', s.occluded, s.occluded ? 'amber' : ''),
    stat('视锥外(非遮挡)', s.outsideFrustum),
    stat('近裁/边缘回退', `${s.nearFallback} / ${s.edgeFallback}`, (s.nearFallback + s.edgeFallback) ? 'blue' : ''),
    stat('三角形 总→实际提交', `${s.totalTris}→${actualSubmittedTris}`),
    stat(cullingOn ? '遮挡跳过三角形' : '剔除关闭·实际跳过', actualSkippedTris, actualSkippedTris ? 'good' : ''),
    stat('实时像素差异', diffPixelsN, diffPixelsN === 0 ? 'good' : 'red'),
    stat('参照可见 uid', lastRefCounts.size, 'blue'),
  ].join('');

  document.getElementById('hud').textContent =
    `yaw ${camState.yaw.toFixed(2)} pitch ${camState.pitch.toFixed(2)} dist ${camState.distance.toFixed(1)}\n` +
    `${cullingOn ? 'CULL ON ' : 'CULL OFF'} · ${pipe.frozen ? 'FROZEN EVIDENCE' : 'CURRENT EVIDENCE'} · ${W}x${H}`;

  const m = pipe.motion;
  const cls = m.decision === 'hold' ? 'dec-hold' : m.decision === 'requery' ? 'dec-requery' : 'dec-rebuild';
  document.getElementById('motion-detail').innerHTML =
    `证据戳记镜头位移界限：<b class="${cls}">${m.boundPx === Infinity ? '∞' : m.boundPx.toFixed(1) + ' px'} / 限 ${m.limitTexels}px → ${
      m.decision === 'hold' ? '保持(hold)' : m.decision === 'requery' ? '界限内：废弃旧结论并重查(requery)' : '越界：重建深度+全量重查(rebuild)'
    }</b><br><span>${m.detail}</span>`;

  // 候选表
  for (const [uid, refs] of rowRefs) {
    const d = pipe.decisions.get(uid);
    if (!d) continue;
    if (selectedUid === uid) refs.tr.classList.add('selected');
    refs.tr.classList.toggle('row-occluded', d.status === 'occluded');
    refs.badge.className = `badge ${d.status}`;
    const label = {
      occluded: pipe.frozen ? (d.stale ? '旧证据剔除' : 'occluded') : 'occluded',
      submitted: '提交绘制', 'edge-fallback': '边缘回退', 'near-fallback': '近裁回退',
      'outside-frustum': '视锥外', 'stale-blocked': '陈旧拦截',
    }[d.status] ?? d.status;
    refs.badge.textContent = label;
    const px = lastRefCounts.get(uid) ?? 0;
    refs.px.textContent = px;
    refs.px.style.color = d.status === 'occluded' && px > 0 ? 'var(--red)' : '';
    if (d.query) {
      const sl = d.query.worstSlack;
      refs.slack.innerHTML = `<span class="${sl >= d.query.margin ? 'slack-ok' : 'slack-bad'}">${sl >= 0 ? '+' : ''}${sl.toExponential(1)}</span>`;
      refs.tex.textContent = `L${d.query.level} · ${d.query.testedCount} 纹素`;
      const names = [];
      for (const [bit, name] of pipe.ownerNames) if (d.query.ownerBits & (1 << bit)) names.push({ bit, name });
      refs.owners.innerHTML = names.map((x) =>
        `<span class="owner-tag" style="border-left:3px solid ${ownerColor(x.bit)}">${x.name}</span>`).join('') || '<span class="dim">无有效来源</span>';
    } else {
      refs.slack.textContent = '–';
      refs.tex.textContent = d.frustumPlane ? `plane:${d.frustumPlane}` : '未查询';
      refs.owners.innerHTML = '';
    }
  }

  // 可见集 / 剔除集
  const refVisible = [...lastRefCounts.entries()].filter(([, n]) => n > 0).map(([u]) => u);
  const onVisible = new Set();
  // onVisible 由调用方通过 lastOnCounts 提供
  for (const u of (lastOnCounts?.keys?.() ?? [])) if ((lastOnCounts.get(u) ?? 0) > 0) onVisible.add(u);
  const missing = refVisible.filter((u) => !onVisible.has(u));
  document.getElementById('visible-count').textContent = `(${refVisible.length})`;
  document.getElementById('visible-chips').innerHTML = refVisible.map((u) => {
    const o = uidObj.get(u);
    return `<span class="chip ${missing.includes(u) ? 'missing' : ''}">${o ? o.name : u}${missing.includes(u) ? ' ·缺失!' : ''}</span>`;
  }).join('');
  document.getElementById('culled-count').textContent = `(${lastActualCulled.length})`;
  document.getElementById('culled-chips').innerHTML = lastActualCulled.map((o) =>
    `<span class="chip culled">${o.name}${lastFalseCulls.find((f) => f.uid === o.uid) ? ' ·误剔!' : ''}</span>`).join('')
    || `<span class="dim">${cullingOn ? '本帧无排除' : '剔除开关已关闭：全部候选提交'}</span>`;

  const totalPx = W * H;
  document.getElementById('compare-stats').innerHTML =
    `像素差异 <b class="${diffPixelsN === 0 ? 'ok' : 'bad'}">${diffPixelsN}</b> / ${totalPx} (${(100 * diffPixelsN / totalPx).toFixed(3)}%)` +
    ` · 参照可见 ${refVisible.length} · 提交可见 ${onVisible.size}` +
    ` · 集合缺失 <b class="${missing.length ? 'bad' : 'ok'}">${missing.length}</b>`;

  // 异常条
  const bar = document.getElementById('anomaly-bar');
  const circularCaught = [...pipe.decisions.values()].filter((d) => d.selfAudit?.circular).length;
  if (lastFalseCulls.length > 0 || diffPixelsN > 0 || missing.length > 0) {
    bar.className = 'anomaly error';
    bar.textContent = `⚠ 检测到误剔除（漏显）${lastFalseCulls.length} 个对象、${diffPixelsN} 个差异像素：` +
      lastFalseCulls.map((f) => `${f.name}(参照${f.referencePixels}px)`).join('，') +
      '。当前决定所依据的深度证据已不能证明其不可见，请重查/解冻。';
  } else if (circularCaught > 0) {
    bar.className = 'anomaly warn';
    bar.textContent = `循环依据审计：${circularCaught} 个候选的查询证据包含其自身写入的 bit，已拒绝据此剔除。正式流水线只允许可靠遮挡物写入 Hi-Z。`;
  } else if (pipe.frozen && pipe.motion.severe) {
    const boundTxt = Number.isFinite(pipe.motion.boundPx) ? pipe.motion.boundPx.toFixed(1) + 'px' : '∞';
    bar.className = 'anomaly warn';
    bar.textContent = `Hi-Z 证据冻结于旧镜头，位移 ${boundTxt} 已越 ${moveLimit}px 界限：必须重建深度并重查${safeStale ? '；安全策略已拦截全部旧结论剔除' : '；当前为实验策略，可能发生误剔，右侧实时参照正在抓错'}`;
  } else {
    bar.className = 'anomaly ok';
    bar.textContent = `实时无剔除参照核对通过：当前机位被排除对象在参照中均为 0 像素，开启/关闭像素一致，误剔除 = 0。`;
  }
}

let lastT = performance.now();
let panelAcc = 0;
let hizAcc = 0;

function frame(now) {
  const dt = Math.min(100, now - lastT);
  lastT = now;
  if (autoRotate) camState.yaw += dt * 0.00022;

  const cam = makeOrbitCamera({
    target: camState.target, yaw: camState.yaw, pitch: camState.pitch,
    distance: camState.distance, fovY: camState.fovY ?? Math.PI / 3, aspect: W / H,
  });

  if (freezeArmed === 'pending' && !frozenEvidence) {
    // 先用当前镜头生成一版证据并冻结
  }
  let evidence = null;
  if (circularSim) {
    const rt = createRenderTarget(W, H);
    clearTarget(rt);
    renderScene(rt, cam, scene.objects, { writeMask: true, maskOf: (o) => o.selfBit ?? 0 });
    evidence = { hiZ: buildHiZ(rt.depth, rt.mask, W, H), camera: cam };
  } else if (freezeArmed && frozenEvidence) {
    evidence = frozenEvidence;
  }

  const t0 = performance.now();
  const pipe = runPipeline(scene, cam, W, H, {
    frozenEvidence: evidence ?? undefined,
    stalePolicy: safeStale ? 'safe' : 'apply-for-experiment',
    moveLimitTexels: moveLimit,
  });

  // pending 冻结：捕获本帧刚生成的当前证据
  if (freezeArmed === 'pending') {
    frozenEvidence = { hiZ: pipe.hiZ, camera: cam };
    freezeArmed = true;
  }

  // 实际提交绘制
  clearTarget(submittedRT);
  renderScene(submittedRT, cam, cullingOn ? pipe.drawList : scene.objects);
  // 无剔除参照
  clearTarget(refRT);
  renderScene(refRT, cam, scene.objects);
  const frameMs = performance.now() - t0;

  vctx.putImageData(new ImageData(submittedRT.color, W, H), 0, 0);
  offCtx.putImageData(new ImageData(refRT.color, W, H), 0, 0);
  onCtx.putImageData(new ImageData(submittedRT.color, W, H), 0, 0);

  // 像素差异
  let diffN = 0;
  const dd = diffImage.data;
  const a = submittedRT.color, b = refRT.color;
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
      diffN++;
      dd[i] = 255; dd[i + 1] = 70; dd[i + 2] = 80; dd[i + 3] = 255;
    } else {
      const v = 14;
      dd[i] = v; dd[i + 1] = v + 4; dd[i + 2] = v + 10; dd[i + 3] = 255;
    }
  }
  diffCtx.putImageData(diffImage, 0, 0);

  lastRefCounts = countUidPixels(refRT);
  lastOnCounts = countUidPixels(submittedRT);
  lastActualCulled = cullingOn ? pipe.culled : [];
  lastPipe = pipe;

  drawOverlay(pipe, cam);

  panelAcc += dt; hizAcc += dt;
  if (panelAcc > 140) { refreshPanels(pipe, cam, frameMs, diffN); panelAcc = 0; }
  if (hizAcc > 220) { paintHiz(pipe, cam); hizAcc = 0; }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- 扫描按钮 ----------
function reportText(r) {
  const d = r.defaultFrame;
  const s = d.pipe.stats;
  return [
    `[${r.sceneId}] ${r.sceneName}`,
    `扫描机位 ${r.frames}｜误剔除事件 ${r.falseCullEvents}｜像素不一致帧 ${r.pixelMismatchFrames}｜集合不一致帧 ${r.setMismatchFrames}`,
    `含遮挡剔除机位 ${r.framesWithOcclusion}｜累计 occluded ${r.totalOccluded}｜累计跳过三角形 ${r.totalSkippedTris}`,
    `状态分布 ${JSON.stringify(r.statusHist)}`,
    `默认机位：occluded=${s.occluded} 视锥外=${s.outsideFrustum} 近裁回退=${s.nearFallback} 边缘回退=${s.edgeFallback} 提交=${s.submitted}`,
    `默认机位三角形 ${s.totalTris} -> 提交 ${s.submittedTris}（遮挡跳过 ${s.skippedOcclusionTris}）`,
    r.passed ? '结论 PASS：声明范围内误剔除为零，像素与可见集合完全一致。' : '结论 FAIL：存在误剔除，见上方红色异常与 CLI 详情。',
  ].join('\n');
}

document.getElementById('btn-scan-scene').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const out = document.getElementById('scan-report');
  btn.disabled = true;
  out.textContent = '正在对当前场景运行 16 向 yaw × 4 pitch × 3 距离 + 专项机位扫描…';
  await new Promise((r) => setTimeout(r, 40));
  try {
    const r = verifyScene(scene, { yawSteps: 16, width: W, height: H });
    out.textContent = reportText(r);
  } catch (err) {
    out.textContent = '扫描异常：' + (err?.stack ?? err);
  } finally { btn.disabled = false; }
});

document.getElementById('btn-scan-all').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const out = document.getElementById('scan-report');
  btn.disabled = true;
  out.textContent = '正在运行三场景完整声明范围校验（24 yaw × 4 pitch × 3 距离 + 专项）…';
  await new Promise((r) => setTimeout(r, 40));
  try {
    const all = verifyAllScenes({ width: W, height: H });
    out.textContent = all.reports.map(reportText).join('\n\n') +
      `\n\n声明范围：${JSON.stringify(all.scope)}\n总体：${all.passed ? 'PASS 误剔除为零' : 'FAIL'}`;
  } catch (err) {
    out.textContent = '扫描异常：' + (err?.stack ?? err);
  } finally { btn.disabled = false; }
});

window.addEventListener('error', (ev) => {
  const bar = document.getElementById('anomaly-bar');
  bar.className = 'anomaly error';
  bar.textContent = '界面运行异常：' + (ev.message || ev.error) + '（可查看控制台堆栈）';
});
