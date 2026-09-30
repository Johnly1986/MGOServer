/**
 * roadbed 真实模型点击诊断：
 * 加载转换产物 → 相机对准 → dump scene.pick 返回对象的完整形态（ctor/方法/键）
 * → 判断 viewer 的三个分支为什么接不住，再真实点击看面板是否展示。
 *
 * 用法：先起服务（npm start，默认 8080），再用一个已转换完成的作业号运行：
 *   node diag-click.mjs <job-id>        # 或 MGO_DIAG_JOB=<job-id> node diag-click.mjs
 */
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:8080';
const JOB = process.argv[2] || process.env.MGO_DIAG_JOB;
if (!JOB) {
  console.error('用法: node diag-click.mjs <job-id>   (或设 MGO_DIAG_JOB=<job-id>)');
  process.exit(1);
}
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await page.goto(`${BASE}/viewer.html?asset=/ws/${JOB}/out/tileset.json&type=3dtiles&basemap=none`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__mgoViewer, null, { timeout: 60000 });
await page.waitForFunction(() => /已加载|失败/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });

const setup = await page.evaluate(async () => {
  const C = window.Cesium, v = window.__mgoViewer;
  const ts = v.scene.primitives.get(0);
  if (!ts) return { fail: 'no tileset primitive' };
  for (let i = 0; i < 240; i++) { if (ts.tilesLoaded) break; await new Promise(r => setTimeout(r, 250)); }
  let center = null;
  try { center = ts.root.boundingVolume.center; } catch {}
  if (!center) { try { center = ts.root.boundingVolume.boundingVolume.center; } catch {} }
  if (!center) return { fail: 'no center' };
  v.camera.viewBoundingSphere(new C.BoundingSphere(center, Math.max(60, ts.root.boundingVolume.boundingVolume.radius * 1.6)),
    new C.HeadingPitchRange(0, C.Math.toRadians(-30), 0));
  await new Promise(r => setTimeout(r, 5000));
  // 统计瓦片树内容状态
  const nodes = [];
  (function walk(n, d) {
    if (!n || d > 2 || nodes.length > 6) return;
    const c = n.content;
    nodes.push({ d, ready: (()=>{try{return !!c?.ready}catch{return '?'}})(),
      featuresLength: (()=>{try{return c?.featuresLength}catch{return '?'}})(),
      ctor: (()=>{try{return c?.constructor?.name}catch{return '?'}})() });
    (n.children || []).forEach(k => walk(k, d+1));
  })(ts.root, 0);
  return { center: [center.x, center.y, center.z], tilesLoaded: ts.tilesLoaded, nodes,
    stats: (()=>{try{const s=ts.statistics;return{seld:s.numberOfTilesSelected??s.tilesSelected,tot:s.numberOfTilesTotal}}catch{return '?'}})() };
});
console.log('SETUP:', JSON.stringify(setup));
if (!setup.center) { await browser.close(); process.exit(1); }

// 扫描 pick：dump 返回对象的完整形状
const scan = await page.evaluate((c) => {
  const C = window.Cesium, v = window.__mgoViewer;
  const p = new C.Cartesian3(c[0], c[1], c[2]);
  const s = v.scene.cartesianToCanvasCoordinates(p);
  const out = { scr: s ? [Math.round(s.x), Math.round(s.y)] : null, hits: [], anyPicks: 0 };
  if (!s) return out;
  for (let fy = 0.25; fy <= 0.85; fy += 0.06) {
    for (let fx = 0.35; fx <= 0.95; fx += 0.06) {
      const x = Math.round(v.scene.canvas.clientWidth * fx), y = Math.round(v.scene.canvas.clientHeight * fy);
      if (document.elementFromPoint(x, y) !== v.scene.canvas) continue;
      let pk = null; try { pk = v.scene.pick(new C.Cartesian2(x, y)); } catch (e) { continue; }
      if (!pk) continue;
      out.anyPicks++;
      if (out.hits.length >= 3) continue;
      out.hits.push({
        x, y, ctor: pk.constructor?.name,
        ownKeys: Object.keys(pk),
        has: {
          content: !!pk.content, id_entity: pk.id instanceof C.Entity,
          getPropertyIds: typeof pk.getPropertyIds, getProperty: typeof pk.getProperty,
          hasProperty: typeof pk.hasProperty, featureId: pk.featureId, batchId: pk.batchId,
          color: typeof pk.color, primitive: !!pk.primitive,
          isContent: !!pk.tile && !!pk.tileset,   // Batched3DModel3DTileContent 特征
        },
        featureIdVal: pk.featureId, batchIdVal: pk.batchId,
      });
    }
  }
  return out;
}, setup.center);
console.log('SCAN:', JSON.stringify(scan, null, 1));

if (scan.hits.length) {
  const h = scan.hits[0];
  await page.mouse.click(h.x, h.y);
  await page.waitForTimeout(1200);
  const panel = await page.evaluate(() => ({
    hidden: document.querySelector('#featPanel').hidden,
    title: document.querySelector('#featTitle').textContent,
    tag: document.querySelector('#featTag').textContent,
    rows: [...document.querySelectorAll('#featBody tr')].map(t => t.textContent).slice(0, 8),
    empty: document.querySelector('#featEmpty')?.textContent?.slice(0, 60) ?? null,
  }));
  console.log('PANEL:', JSON.stringify(panel, null, 1));
}
console.log('pageerrors:', errs.join(' | ') || '(none)');
await page.screenshot({ path: '/tmp/roadbed-click.png' });
await browser.close();
