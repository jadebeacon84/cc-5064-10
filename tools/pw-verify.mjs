// 真实浏览器核验（Playwright）：在光栅调试视窗里
//   1) 切到深度遮挡案例（小孔/复杂），读取实际可见集、深度层版本与缓存状态；
//   2) 转动相机（轨道拖拽）制造镜头跳变，观察历史 occluded 适用范围失效与重建；
//   3) 切换遮挡剔除开关，核对像素差异与可见集；
// 全程断言无红色异常、无 pageerror，并保存截图。
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:8123/web/';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);

const read = async () => page.evaluate(() => ({
  anomalyClass: document.getElementById('anomaly-bar').className,
  anomalyText: document.getElementById('anomaly-bar').textContent.slice(0, 120),
  motion: document.getElementById('motion-detail').textContent.replace(/\s+/g, ' ').trim(),
  stats: document.getElementById('stats-grid').textContent.replace(/\s+/g, ' ').trim(),
  visibleChips: document.getElementById('visible-chips').children.length,
  culledChips: document.getElementById('culled-chips').children.length,
  compare: document.getElementById('compare-stats').textContent.replace(/\s+/g, ' ').trim(),
}));

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); };

// 1. 默认 wall 场景基线
let r = await read();
assert(!r.anomalyClass.includes('error'), 'wall 默认机位无红色异常: ' + r.anomalyText);
assert(r.motion.includes('深度层版本'), '运动面板显示深度层版本: ' + r.motion.slice(0, 80));
assert(r.stats.includes('缓存命中'), '统计卡显示缓存命中/失效: ' + r.stats.slice(0, 120));
assert(r.visibleChips > 0, `实际可见集非空 (${r.visibleChips})`);
assert(r.compare.includes('像素差异'), '显示像素差异统计');
await page.screenshot({ path: '/tmp/ui-1-wall.png' });

// 2. 转动相机：模拟轨道拖拽，触发镜头跳变与缓存适用范围失效
const wrap = page.locator('#viewport-wrap');
const box = await wrap.boundingBox();
await page.mouse.move(box.x + 200, box.y + 120);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(box.x + 200 + i * 28, box.y + 120 + Math.sin(i) * 8);
  await page.waitForTimeout(60);
}
await page.mouse.up();
await page.waitForTimeout(1200);
r = await read();
assert(!r.anomalyClass.includes('error'), '转动相机后无漏显红色异常: ' + r.anomalyText);
assert(r.stats.match(/深度层版本\s*v?\d+/) != null, '深度层版本号持续可见: ' + r.stats.slice(0, 120));
await page.screenshot({ path: '/tmp/ui-2-rotated.png' });

// 3. 切到小孔深度遮挡案例
await page.getByText('小孔窥视').click();
await page.waitForTimeout(1200);
r = await read();
assert(!r.anomalyClass.includes('error'), 'hole 场景无异常: ' + r.anomalyText);
const treasureRow = page.locator('#candidate-rows tr', { hasText: '宝石' });
assert((await treasureRow.count()) === 1, '孔后宝石候选存在');
const rowText = await treasureRow.innerText();
assert(rowText.includes('提交') || rowText.includes('submitted'), '宝石未被错误剔除');
await page.screenshot({ path: '/tmp/ui-3-hole.png' });

// 4. 切换遮挡剔除开关：关闭后应全量提交，重开后恢复节省且像素差异回到 0
const chk = page.locator('#chk-cull');
await chk.uncheck();
await page.waitForTimeout(900);
r = await read();
assert(r.stats.includes('剔除关闭'), '关闭剔除时统计卡标注未执行剔除');
assert(!r.anomalyClass.includes('error'), '关闭剔除无异常');
await chk.check();
await page.waitForTimeout(900);
r = await read();
const m = r.compare.match(/像素差异\s*(\d+)/);
assert(m && Number(m[1]) === 0, '重开剔除后像素差异为 0: ' + r.compare);
assert(!r.anomalyClass.includes('error'), '重开剔除后零漏显');
await page.screenshot({ path: '/tmp/ui-4-cull-on.png' });

// 5. 复杂包围形状场景（长梁端部外露）
await page.getByText('复杂包围形状').click();
await page.waitForTimeout(1200);
r = await read();
assert(!r.anomalyClass.includes('error'), 'complex 场景无异常: ' + r.anomalyText);
const beamRow = page.locator('#candidate-rows tr', { hasText: '长梁' });
assert((await beamRow.count()) === 1, '外露长梁候选存在');
const beamText = await beamRow.innerText();
assert(!beamText.includes('occluded'), '长梁未被中心点逻辑误剔');
await page.screenshot({ path: '/tmp/ui-5-complex.png' });

assert(errs.length === 0, '浏览器无 pageerror/console.error: ' + errs.join(' | '));
console.log('\n浏览器核验', process.exitCode ? '存在失败' : '全部通过');
await browser.close();
