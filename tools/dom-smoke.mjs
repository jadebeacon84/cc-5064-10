// UI 接线冒烟测试（非像素级浏览器测试）：
// 用 jsdom 载入真实 index.html，stub 掉 2D context，真实执行 web/app.js
// 与全部 src 运算，驱动若干帧、场景切换、行选择、循环模拟、冻结与扫描。
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:8123/', pretendToBeVisual: true });
const { window } = dom;

function makeCtx() {
  return {
    canvas: null,
    createImageData(w, h) {
      if (typeof w === 'number') return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
      return { data: new Uint8ClampedArray(w.data), width: w.width, height: w.height };
    },
    putImageData() {}, clearRect() {}, fillRect() {}, strokeRect() {},
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {}, fill() {},
    fillText() {}, save() {}, restore() {}, scale() {}, setTransform() {},
    measureText: () => ({ width: 8 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
}
window.HTMLCanvasElement.prototype.getContext = function getContext() {
  const c = makeCtx(); c.canvas = this; return c;
};
window.HTMLCanvasElement.prototype.setPointerCapture = () => {};
window.HTMLCanvasElement.prototype.releasePointerCapture = () => {};

globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.ImageData = class ImageData {
  constructor(a, w, h) {
    if (a instanceof Uint8ClampedArray) { this.data = a; this.width = w; this.height = h ?? Math.floor(a.length / 4 / w); }
    else { this.width = a ?? 0; this.height = w ?? 0; this.data = new Uint8ClampedArray((a ?? 0) * (w ?? 1) * 4); }
  }
};
let queuedFrame = null;
globalThis.requestAnimationFrame = (cb) => { queuedFrame = cb; return 1; };
globalThis.cancelAnimationFrame = () => {};
window.requestAnimationFrame = globalThis.requestAnimationFrame;
window.ImageData = globalThis.ImageData;

const errors = [];
window.addEventListener('error', (e) => errors.push(e.message));

await import('../web/app.js');

function step(frames = 1, dt = 16) {
  for (let i = 0; i < frames; i++) {
    const cb = queuedFrame;
    queuedFrame = null;
    if (!cb) throw new Error('no rAF callback scheduled');
    cb(simT);
    simT += dt;
  }
}
let simT = performance.now() + 50;

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); };

step(30);

const $ = (id) => document.getElementById(id);
assert(errors.length === 0, `窗口无 error 事件 ${errors.join(';')}`);
assert($('candidate-rows').children.length >= 10, `候选行已生成 (${$('candidate-rows').children.length})`);
assert($('stats-grid').children.length >= 8, '统计卡已渲染');
assert($('visible-chips').children.length > 0, '实际可见集 chips 非空');
assert($('hiz-levels').children.length >= 8, `深度层缩略图已生成 (${$('hiz-levels').children.length})`);
assert(!$('anomaly-bar').classList.contains('error'), `默认机位无红色异常：${$('anomaly-bar').textContent.slice(0, 80)}`);
assert($('anomaly-bar').classList.contains('ok'), '默认机位显示实时核对通过');
assert($('motion-detail').textContent.includes('深度层版本'), '运动面板显示深度层版本与缓存适用范围');

// 转动相机制造镜头跳变：历史 occluded 的适用范围（屏幕范围/版本）应失效并被拦截，
// 随后在当前深度层重建后恢复，全程不得出现红色漏显。
const wrap0 = $('viewport-wrap');
wrap0.dispatchEvent(new window.PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }));
for (let i = 0; i < 10; i++) {
  wrap0.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 100 + (i + 1) * 26, clientY: 100, bubbles: true }));
}
wrap0.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true }));
step(40);
assert(!$('anomaly-bar').classList.contains('error'), '相机跳变后无红色漏显异常');
const statsText = $('stats-grid').textContent;
assert(statsText.includes('缓存命中'), '统计卡含缓存命中/失效指标');
step(30);
assert(!$('anomaly-bar').classList.contains('error'), '重建深度层后仍无漏显');

// 选择一个候选行
$('candidate-rows').children[3].click();
step(18);
assert(document.querySelector('.cand-table tr.selected') != null, '候选行可选中');

// 切换到小孔场景
[...document.querySelectorAll('.scene-tabs button')].find((b) => b.textContent.includes('小孔')).click();
step(25);
assert($('candidate-rows').children.length === 6, `小孔场景 6 候选行 (${$('candidate-rows').children.length})`);
const treasureRow = [...$('candidate-rows').children].find((tr) => tr.textContent.includes('宝石'));
assert(treasureRow.textContent.includes('submitted') || treasureRow.textContent.includes('提交'), '孔后宝石未被剔除');

// 循环依据模拟
$('chk-circular').checked = true;
$('chk-circular').dispatchEvent(new window.Event('change', { bubbles: true }));
step(25);
assert($('anomaly-bar').textContent.includes('循环依据'), '循环依据审计提示出现');
$('chk-circular').checked = false;
$('chk-circular').dispatchEvent(new window.Event('change', { bubbles: true }));
step(5);

// 冻结 + 滚轮制造位移
$('btn-freeze').click();
step(3);
const wrap = $('viewport-wrap');
for (let i = 0; i < 12; i++) {
  wrap.dispatchEvent(new window.WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
}
step(25);
assert($('anomaly-bar').textContent.includes('界限'), '冻结移动后提示运动界限/重查');
$('btn-freeze').click();
step(10);

// 运行当前场景扫描（真实 verifyScene）
$('btn-scan-scene').click();
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 50));
  if ($('scan-report').textContent.includes('结论')) break;
}
const report = $('scan-report').textContent;
assert(report.includes('结论 PASS'), '界面扫描报告 PASS：\n' + report.split('\n').slice(0, 8).join('\n'));

console.log(process.exitCode ? '\nDOM SMOKE HAS FAILURES' : '\nDOM SMOKE ALL PASS');
