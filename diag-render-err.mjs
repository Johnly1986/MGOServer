/**
 * 抓取 roadbed tileset 的完整渲染错误堆栈（Cesium scene.renderError + 瓦片数值健全性）。
 *
 * 用法：先起服务（npm start，默认 8080），再用一个已转换完成的作业号运行：
 *   node diag-render-err.mjs <job-id>     # 或 MGO_DIAG_JOB=<job-id> node diag-render-err.mjs
 */
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:8080';
const JOB = process.argv[2] || process.env.MGO_DIAG_JOB;
if (!JOB) {
  console.error('用法: node diag-render-err.mjs <job-id>   (或设 MGO_DIAG_JOB=<job-id>)');
  process.exit(1);
}
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 500)));
await page.goto(`${BASE}/viewer.html?asset=/ws/${JOB}/out/tileset.json&type=3dtiles&basemap=none`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__mgoViewer, null, { timeout: 60000 });

const r = await page.evaluate(async () => {
  const C = window.Cesium, v = window.__mgoViewer;
  const ts = v.scene.primitives.get(0);
  const stack = [];
  v.scene.renderError.addEventListener((s, e) => stack.push(String(e?.stack || e).slice(0, 4000)));
  v.otherError?.addEventListener?.((e) => stack.push('otherError:' + String(e).slice(0, 2000)));
  for (let i = 0; i < 60; i++) { if (stack.length) break; await new Promise(r2 => setTimeout(r2, 500)); }
  // 检查瓦片/内容的数值健全性
  const probe = [];
  (function walk(n, d) {
    if (!n || d > 2 || probe.length > 8) return;
    let ge = n.geometricError, bv = null;
    try { bv = n.boundingVolume?.boundingVolume; } catch {}
    probe.push({ d, ge, center: bv ? [bv.center.x, bv.center.y, bv.center.z].map(x => +x.toFixed(1)) : null,
      radius: bv ? bv.radius : null });
    (n.children || []).forEach(k => walk(k, d + 1));
  })(ts.root, 0);
  return { stackCount: stack.length, stack: stack[0] ?? null, probe };
});
console.log('stack:', JSON.stringify(r.stack, null, 1) ?? 'none');
console.log('probe:', JSON.stringify(r.probe, null, 1));
await browser.close();
