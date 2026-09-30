/**
 * 诊断2：无要素 b3dm（featuresLength=0）被 pick 时返回什么对象，
 * viewer 分支能否接住。用 route 拦截给 tileset.json 注入杭州 ENU transform
 * 让模型可见（真实用户场景是带 origin/georef 转换，这里只为了能拾取）。
 *
 * 用法：先起服务（npm start，默认 8080），再用一个已转换完成的作业号运行：
 *   node diag-content-pick.mjs <job-id>   # 或 MGO_DIAG_JOB=<job-id> node diag-content-pick.mjs
 */
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:8080';
const JOB = process.argv[2] || process.env.MGO_DIAG_JOB;
if (!JOB) {
  console.error('用法: node diag-content-pick.mjs <job-id>   (或设 MGO_DIAG_JOB=<job-id>)');
  process.exit(1);
}
const LON = 120.0, LAT = 30.0;   // 杭州
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const errs = [];

// 拦截 tileset.json 注入 ENU transform（ENU→ECEF 列主序 4x4）
await page.route(`**/ws/${JOB}/out/tileset.json*`, async (route) => {
  const resp = await route.fetch();
  const doc = await resp.json();
  const D2R = Math.PI / 180, a = 6378137.0, f = 1 / 298.257223563, e2 = f * (2 - f);
  const lat = LAT * D2R, lon = LON * D2R;
  const sLat = Math.sin(lat), cLat = Math.cos(lat), sLon = Math.sin(lon), cLon = Math.cos(lon);
  const N = a / Math.sqrt(1 - e2 * sLat * sLat);
  // east/north/up 三列 + 平移（列主序）
  doc.root.transform = [
    -sLon, cLon, 0, 0,
    -sLat * cLon, -sLat * sLon, cLat, 0,
    cLat * cLon, cLat * sLon, sLat, 0,
    (N) * cLon * cLat, (N) * sLon * cLat, N * (1 - e2) * sLat, 1,
  ];
  await route.fulfill({ response: resp, body: JSON.stringify(doc), contentType: 'application/json' });
});

page.on('pageerror', e => errs.push(String(e).slice(0, 200)));
await page.goto(`${BASE}/viewer.html?asset=/ws/${JOB}/out/tileset.json&type=3dtiles&basemap=none`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__mgoViewer, null, { timeout: 60000 });
await page.waitForFunction(() => /已加载|失败/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });

const setup = await page.evaluate(async () => {
  const C = window.Cesium, v = window.__mgoViewer;
  const ts = v.scene.primitives.get(0);
  for (let i = 0; i < 160; i++) { if (ts.tilesLoaded) break; await new Promise(r => setTimeout(r, 250)); }
  let center = null;
  try { center = ts.root.boundingVolume.center; } catch {}
  if (!center) { try { center = ts.root.boundingVolume.boundingVolume.center; } catch {} }
  if (!center) return { fail: 'no center' };
  v.camera.viewBoundingSphere(new C.BoundingSphere(center, 16000 * 1.4),
    new C.HeadingPitchRange(0, C.Math.toRadians(-30), 0));
  await new Promise(r => setTimeout(r, 5000));
  const nodes = [];
  (function walk(n, d) {
    if (!n || d > 2 || nodes.length > 6) return;
    const c = n.content;
    nodes.push({ d, ready: (()=>{try{return !!c?.ready}catch{return '?'}})(),
      featuresLength: (()=>{try{return c?.featuresLength}catch{return '?'}})() });
    (n.children || []).forEach(k => walk(k, d+1));
  })(ts.root, 0);
  return { center: [center.x, center.y, center.z], tilesLoaded: ts.tilesLoaded, nodes };
});
console.log('SETUP:', JSON.stringify(setup));
if (!setup.center) { await browser.close(); process.exit(1); }

// 全画布扫描 pick，dump 命中对象形态
const scan = await page.evaluate(() => {
  const C = window.Cesium, v = window.__mgoViewer;
  const out = { anyPicks: 0, hits: [] };
  for (let fy = 0.2; fy <= 0.9; fy += 0.05) {
    for (let fx = 0.35; fx <= 0.98; fx += 0.05) {
      const x = Math.round(v.scene.canvas.clientWidth * fx), y = Math.round(v.scene.canvas.clientHeight * fy);
      if (document.elementFromPoint(x, y) !== v.scene.canvas) continue;
      let pk = null; try { pk = v.scene.pick(new C.Cartesian2(x, y)); } catch (e) { continue; }
      if (!pk) continue;
      out.anyPicks++;
      if (out.hits.length >= 2) continue;
      out.hits.push({
        x, y, ctor: pk.constructor?.name, ownKeys: Object.keys(pk),
        has: {
          content: !!pk.content, id_entity: pk.id instanceof C.Entity,
          getPropertyIds: typeof pk.getPropertyIds, getProperty: typeof pk.getProperty,
          hasProperty: typeof pk.hasProperty, getFeature: typeof pk.getFeature,
          tile: !!pk.tile, tileset: !!pk.tileset, primitive: !!pk.primitive,
          featureId: pk.featureId, batchId: pk.batchId,
        },
      });
    }
  }
  return out;
});
console.log('SCAN:', JSON.stringify(scan, null, 1));

if (scan.hits.length) {
  const h = scan.hits[0];
  await page.mouse.click(h.x, h.y);
  await page.waitForTimeout(1200);
  const panel = await page.evaluate(() => ({
    hidden: document.querySelector('#featPanel').hidden,
    title: document.querySelector('#featTitle').textContent,
    tag: document.querySelector('#featTag').textContent,
    rows: [...document.querySelectorAll('#featBody tr')].map(t => t.textContent).slice(0, 6),
    empty: document.querySelector('#featEmpty')?.textContent?.slice(0, 80) ?? null,
  }));
  console.log('PANEL:', JSON.stringify(panel, null, 1));
}
console.log('pageerrors:', errs.join(' | ') || '(none)');
await page.screenshot({ path: '/tmp/roadbed-pick.png' });
await browser.close();
