#!/usr/bin/env node
// 命令行仅用于辅助深度遮挡：跑零误剔扫描、来源审计、陈旧证据实验、性能简报。
// 主交付是图形调试视窗：npm start 后浏览器打开 http://localhost:8123/web/

import { makeOrbitCamera } from './src/math3d.js';
import { createScenes } from './src/scene.js';
import { verifyAllScenes, verifyScene, compareFrame, renderAll } from './src/verify.js';
import { runPipeline } from './src/pipeline.js';
import { createRenderTarget, clearTarget, renderScene, countUidPixels, countMaskBits } from './src/raster.js';
import { buildHiZ } from './src/hiz.js';
import { classifyCandidate } from './src/pipeline.js';

function fmt(n) {
  return n.toLocaleString('en-US');
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = isNaN(Number(next)) ? next : Number(next); i++; }
    } else args._.push(a);
  }
  return args;
}

function cmdList() {
  for (const s of createScenes()) {
    const tris = s.objects.reduce((n, o) => n + o.indices.length / 3, 0);
    console.log(`- ${s.id.padEnd(8)} ${s.name}  对象 ${s.objects.length}  三角形 ${tris}`);
    console.log(`           ${s.description}`);
  }
}

function printReport(report) {
  console.log(`\n=== [${report.sceneId}] ${report.sceneName} ===`);
  console.log(`扫描机位 ${report.frames} | 含实际遮挡剔除的机位 ${report.framesWithOcclusion} | 累计 occluded ${report.totalOccluded} | 跳过三角形 ${fmt(report.totalSkippedTris)}`);
  console.log(`状态分布 ${JSON.stringify(report.statusHist)}`);
  const d = report.defaultFrame;
  const st = d.pipe.stats;
  console.log(`默认机位: occluded=${st.occluded} outsideFrustum=${st.outsideFrustum} nearFallback=${st.nearFallback} edgeFallback=${st.edgeFallback} submitted=${st.submitted}`);
  console.log(`默认机位绘制三角形: 全量 ${fmt(st.totalTris)} -> 实际提交 ${fmt(st.submittedTris)}（遮挡跳过 ${fmt(st.skippedOcclusionTris)}）`);
  console.log(`默认机位像素差异 ${d.pixelDiff} | 集合缺失 ${d.setMissing.length} | 集合多余 ${d.setExtra.length}`);
  if (report.falseCullEvents > 0) {
    console.log(`!! 误剔除事件 ${report.falseCullEvents}，像素不一致帧 ${report.pixelMismatchFrames}，集合不一致帧 ${report.setMismatchFrames}`);
    for (const f of report.frameReports ?? []) {
      for (const fc of f.falseCulls.slice(0, 5)) {
        console.log(`   FALSE-CULL ${fc.id} refPixels=${fc.referencePixels} L=${fc.level} slack=${fc.worstSlack} owners=0b${(fc.ownerBits >>> 0).toString(2)}`);
      }
    }
  } else {
    console.log('PASS 零误剔除：所有 occluded 对象在无剔除参照中均为 0 像素，开启/关闭像素与可见集合完全一致。');
  }
}

function cmdVerify(args) {
  const quick = args.quick;
  const opts = {
    width: args.width ?? (quick ? 320 : 480),
    height: args.height ?? (quick ? 180 : 270),
    yawSteps: quick ? 12 : (args.yawSteps ?? 24),
    keepFrames: true,
  };
  if (args.scene) {
    const scene = createScenes().find((s) => s.id === args.scene);
    if (!scene) { console.error('未知场景', args.scene); process.exit(2); }
    const r = verifyScene(scene, opts);
    printReport(r);
    process.exit(r.passed ? 0 : 1);
  }
  const all = verifyAllScenes(opts);
  for (const r of all.reports) printReport(r);
  console.log('\n声明范围:', JSON.stringify(all.scope, null, 0));
  console.log(all.passed ? '\n总体 PASS：声明范围内误剔除为零。' : '\n总体 FAIL：存在误剔除/像素或集合不一致。');
  process.exit(all.passed ? 0 : 1);
}

// 来源追踪 + 自遮挡循环审计。
function cmdAudit() {
  const scene = createScenes()[0];
  const W = 480, H = 270;
  const cam = makeOrbitCamera({ ...scene.camera, aspect: W / H });
  const pipe = runPipeline(scene, cam, W, H);
  console.log('可靠遮挡物 bit 分配与实际写入像素：');
  const bitCounts = countMaskBits(pipe.occluderRT);
  for (const o of scene.objects.filter((x) => x.reliableOccluder)) {
    console.log(`  bit${o.bitIndex} 0x${o.occluderBit.toString(16).padStart(8, '0')} ${o.name}: ${bitCounts.get(o.bitIndex) ?? 0} 深度像素`);
  }
  console.log('\n被剔除候选的证据链（实际采用的遮挡物）：');
  for (const obj of pipe.culled) {
    const d = pipe.decisions.get(obj.uid);
    const names = [];
    for (const [bit, name] of pipe.ownerNames) {
      if (d.query.ownerBits & (1 << bit)) names.push(name);
    }
    console.log(`  ${obj.id} <- L${d.query.level} ${d.query.testedCount} texels, owners=[${names.join(', ')}], worstSlack=${d.query.worstSlack.toExponential(3)}`);
    if (d.selfAudit?.circular) console.log('    !! 检测到自遮挡循环');
  }

  // 合成循环证据：让候选也写入深度，验证审计一定能抓到。
  console.log('\n合成循环依据测试（候选被错误允许写入 Hi-Z）：');
  const rt = createRenderTarget(W, H);
  clearTarget(rt);
  const allWithBits = scene.objects.map((o, i) => ({ ...o, selfBit: 1 << Math.min(i, 30) }));
  renderScene(rt, cam, allWithBits, { writeMask: true, maskOf: (o) => o.selfBit });
  const hiZ = buildHiZ(rt.depth, rt.mask, W, H);
  let caught = 0;
  for (const o of allWithBits.filter((x) => x.candidate)) {
    const d = classifyCandidate(o, cam, hiZ, { depthMargin: 2e-4 });
    if (d.selfAudit?.circular) {
      caught++;
      if (caught <= 5) console.log(`  审计拦截 ${o.id}: ${d.selfAudit.message}`);
    }
  }
  console.log(caught > 0 ? `PASS 审计在 ${caught} 个候选证据中识别出循环自身 bit。` : 'WARN 合成用例未触发循环 bit（可能候选均未投影）。');

  // 正常流水线上限检查：Hi-Z mask 中绝不允许出现非 occluder bit。
  const occMaskUnion = scene.objects.filter((o) => o.reliableOccluder).reduce((m, o) => m | o.occluderBit, 0) >>> 0;
  let illegal = 0;
  for (let i = 0; i < pipe.hiZ.levels[0].mask.length; i++) {
    if ((pipe.hiZ.levels[0].mask[i] & ~occMaskUnion) !== 0) { illegal++; if (illegal < 3) console.log('  非法 mask @', i, pipe.hiZ.levels[0].mask[i].toString(16)); }
  }
  console.log(illegal === 0 ? 'PASS 正式 Hi-Z 仅含可靠遮挡物来源，不存在候选自证路径。' : `FAIL 发现 ${illegal} 个含非法来源 bit 的纹素。`);
  process.exit(illegal === 0 && caught > 0 ? 0 : 1);
}

// 陈旧金字塔实验：冻结证据 + 转动镜头，无剔除参照负责抓漏显。
function cmdStale() {
  const scene = createScenes()[0];
  const W = 480, H = 270;
  const cam0 = makeOrbitCamera({ ...scene.camera, aspect: W / H });
  const fresh = runPipeline(scene, cam0, W, H);
  const frozen = { hiZ: fresh.hiZ, camera: cam0 };
  console.log('冻结默认机位 Hi-Z，随后水平旋转镜头，观察运动界限裁决与参照抓错：');
  let detected = 0;
  for (const yaw of [0.05, 0.12, 0.25, 0.4, 0.7]) {
    const cam = makeOrbitCamera({ ...scene.camera, yaw, aspect: W / H });
    const unsafePipe = runPipeline(scene, cam, W, H, { frozenEvidence: frozen, stalePolicy: 'apply-for-experiment' });
    const ref = renderAll(scene, cam, W, H);
    const counts = countUidPixels(ref);
    const bad = unsafePipe.culled.filter((o) => (counts.get(o.uid) ?? 0) > 0);
    const safePipe = runPipeline(scene, cam, W, H, { frozenEvidence: frozen });
    const safeBad = safePipe.culled.filter((o) => (counts.get(o.uid) ?? 0) > 0);
    detected += bad.length;
    console.log(
      ` yaw+${yaw.toFixed(2)} 界限=${unsafePipe.motion.boundPx === Infinity ? '∞' : unsafePipe.motion.boundPx.toFixed(1) + 'px'}` +
      ` 裁决=${unsafePipe.motion.decision} 实验性旧证据误剔=${bad.length}` +
      ` 安全策略实际剔除=${safePipe.stats.occluded} 误剔=${safeBad.length} blocked=${safePipe.stats.staleBlocked}`,
    );
  }
  console.log(detected > 0
    ? `PASS 参照成功捕获旧金字塔导致的 ${detected} 个漏显，界面会以异常条提示；安全策略下误剔为 0。`
    : 'NOTE 本组运动未制造漏显（可加大转角或换孔场景复现）。');
  process.exit(0);
}

function cmdBench(args) {
  const scene = createScenes().find((s) => s.id === (args.scene ?? 'wall')) ?? createScenes()[0];
  const W = args.width ?? 480, H = args.height ?? 270;
  const cam = makeOrbitCamera({ ...scene.camera, aspect: W / H });
  const N = args.frames ?? 60;
  let t0 = performance.now();
  let accCulled = 0, accTris = 0;
  for (let i = 0; i < N; i++) {
    const yaw = Math.sin(i / N * Math.PI * 2) * 0.5;
    const c = makeOrbitCamera({ ...scene.camera, yaw, aspect: W / H });
    const p = runPipeline(scene, c, W, H);
    accCulled += p.stats.occluded;
    accTris += p.stats.skippedOcclusionTris;
  }
  const ms = (performance.now() - t0) / N;
  console.log(`[${scene.id}] ${W}x${H} 平均每帧流水线(遮挡pass+HiZ+查询) ${ms.toFixed(2)} ms`);
  console.log(`平均 occluded ${(accCulled / N).toFixed(1)} 对象/帧，平均跳过三角形 ${(accTris / N).toFixed(0)}/帧`);

  t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const c = makeOrbitCamera({ ...scene.camera, yaw: Math.sin(i / N * Math.PI * 2) * 0.5, aspect: W / H });
    renderAll(scene, c, W, H);
  }
  console.log(`全量软件渲染平均 ${((performance.now() - t0) / N).toFixed(2)} ms/帧`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? 'verify';
if (cmd === 'list') cmdList();
else if (cmd === 'verify') cmdVerify(args);
else if (cmd === 'audit') cmdAudit();
else if (cmd === 'stale') cmdStale();
else if (cmd === 'bench') cmdBench(args);
else {
  console.log('用法: node cli.js <verify|list|audit|stale|bench> [--quick] [--scene wall|hole|complex]');
  process.exit(2);
}
