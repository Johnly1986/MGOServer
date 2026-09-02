/**
 * Page-level functional test for console.html / viewer.html using headless Chromium.
 * Requires a running server (default http://127.0.0.1:8080). Write protection
 * is an IP whitelist — localhost is always allowed, so local runs need no token.
 * Run: node ui-test.mjs            (env: UI_BASE, UI_TIF)
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:8080';

// Terrain upload fixture: regenerated from scripts/generate-test-tif.py (also
// `npm run fixture:terrain`) so a clean clone can run the suite unaided.
const TIF = process.env.UI_TIF
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'test', 'fixtures', 'test_terrain.tif');
if (!fs.existsSync(TIF)) {
  console.log(`(fixture ${TIF} missing — generating)`);
  execFileSync('python3', [path.join('scripts', 'generate-test-tif.py')], { stdio: 'inherit' });
  if (!fs.existsSync(TIF)) {
    console.error(`cannot run UI test without the terrain fixture: ${TIF}\n`
      + '  python3 scripts/generate-test-tif.py   (or set UI_TIF=/path/to/file.tif)');
    process.exit(1);
  }
}

const results = [];
let passN = 0, failN = 0, skipN = 0;
/** Steps that need optional inputs (private regression models) report SKIP, not FAIL. */
function skip (why) { const e = new Error(why); e.__skip = true; throw e; }
const step = async (name, fn) => {
  try { await fn(); passN++; console.log(`PASS  ${name}`); }
  catch (e) {
    if (e.__skip) { skipN++; console.log(`SKIP  ${name}\n      ${e.message}`); return; }
    failN++; console.log(`FAIL  ${name}\n      ${e.message.split('\n')[0]}`);
  }
};

// The whitelist suite step writes workspace/whitelist.json.  Snapshot the live
// entries first so a test run against a real deployment can never lock anyone out.
const wlSnapshot = (await (await fetch(BASE + '/api/v1/whitelist')).json().catch(() => ({ whitelist: [] })))
  .whitelist.filter((e) => e !== '127.0.0.1' && e !== '::1');
const wlRestore = async () => {
  await fetch(BASE + '/api/v1/whitelist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ whitelist: wlSnapshot }),
  });
};

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });

async function newPage(url) {
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push('console: ' + m.text().slice(0, 200)); });
  await page.goto(BASE + url, { waitUntil: 'networkidle' });
  return page;
}
const realErrs = (p) => p.errors.filter(e => !/favicon|Automatic fallback|Shader cache|performance/i.test(e));

/* ---------- 1. console boot ---------- */
let page;
await step('1 console.html 加载、健康探测在线、表单渲染且无 JS 错误', async () => {
  page = await newPage('/console.html');
  await page.waitForFunction(() => /在线/.test(document.querySelector('#health').textContent), null, { timeout: 10000 });
  await page.waitForSelector('#paramForm details.grp');
  if (realErrs(page).length) throw new Error('JS 错误: ' + realErrs(page).join(' ;; '));
});

/* ---------- 2. IP whitelist self-report ---------- */
await step('2 本机 IP 默认在白名单（capabilities.client）', async () => {
  const caps = await (await fetch(BASE + '/api/v1/capabilities')).json();
  if (caps.features.authMode !== 'ip-whitelist') throw new Error('authMode: ' + caps.features.authMode);
  if (!caps.client || !caps.client.allowed) throw new Error('本机 IP 未授权: ' + JSON.stringify(caps.client));
  const ipNote = await page.textContent('#ipNote');
  // UI 文案（2026-09「去除冗余描述」起）：已授权行是 "🟢 IP <b>…</b>"，不再写"已在白名单"
  if (!/🟢 IP/.test(ipNote) || !ipNote.includes(caps.client.ip))
    throw new Error('ipNote 未显示已授权: ' + ipNote);
});

/* ---------- 3. type switch ---------- */
await step('3 切换任务类型 → 表单组/输入区随类型重建', async () => {
  await page.selectOption('#type', 'tiles');
  await page.waitForSelector('#paramForm summary');
  const groups = await page.$$eval('#paramForm summary', (n) => n.map(x => x.textContent));
  for (const w of ['投影', '坐标原点', '地理配准', '简化', '3D Tiles'])
    if (!groups.some(g => g.includes(w))) throw new Error('缺组: ' + w + '｜有: ' + groups.join('|'));
  await page.selectOption('#type', 'osgb');
  if (!(await page.$('#inputPath'))) throw new Error('osgb 未显示目录路径输入');
  if (!(await page.$('#osgbDir'))) throw new Error('osgb 未显示文件夹选择控件');
  await page.selectOption('#type', 'terrain');
  await page.waitForSelector('#f_maxLod');
});

/* ---------- 4. form → JSON preview ---------- */
await step('4 表单输入实时生成 JSON 预览（含 normals=false）', async () => {
  await page.fill('#f_maxLod', '5');
  await page.fill('#f_samplesPerTile', '65');
  await page.uncheck('#f_normals');
  const json = JSON.parse(await page.inputValue('#jsonBox'));
  if (json.type !== 'terrain' || json.maxLod !== 5 || json.samplesPerTile !== 65 || json.normals !== false)
    throw new Error('预览不符: ' + JSON.stringify(json));
});

/* ---------- 5. submit real conversion through the form ---------- */
let jobId;
await step('5 表单上传 TIF → 提交 → 新行出现 → SSE 实时到 succeeded', async () => {
  const before = new Set(await page.$$eval('#jobs tr[data-id]', (n) => n.map(x => x.dataset.id)));
  await page.setInputFiles('#file', TIF);
  await page.click('#submit');
  jobId = await page.waitForFunction((old) => {
    const tr = [...document.querySelectorAll('#jobs tr[data-id]')]
      .find(x => !old.includes(x.dataset.id));
    return tr ? tr.dataset.id : null;
  }, [...before], { timeout: 15000 }).then(h => h.jsonValue());
  await page.waitForFunction(() => /\[status\] succeeded/.test(document.querySelector('#logBox').textContent),
    null, { timeout: 150000 });
  const badgeCls = await page.$eval(`#jobs tr[data-id="${jobId}"] .badge`,
    n => n.className).catch(() => '');
  if (!/s-succeeded/.test(badgeCls)) throw new Error('行内状态类: ' + badgeCls);
  const logs = await page.textContent('#logBox');
  if (!/\[progress\] \d+\/\d+ \(\d+%\)/.test(logs))
    throw new Error('日志面板缺实时 [progress] 事件');
  // 回归：实时行曾是 Element.append() 的字面文本——<span class=…> 包装标签原样露在日志里
  // （"日志带 html 标签"），颜色类也从未真正生效。要求：不得有泄漏的 <span> 字面量（日志
  // 正文若本身含 <…> 文本是允许的），且确实存在真实 span.t-prog / span.t-status 元素。
  if (/<\/?span[ >]/.test(logs))
    throw new Error('日志里泄漏了字面 <span> 包装标签: …' + logs.slice(-160));
  const liveCls = await page.$$eval('#logBox span', (n) => n.map((x) => x.className));
  if (!liveCls.some((c) => c.includes('t-prog')) || !liveCls.some((c) => c.includes('t-status')))
    throw new Error('实时行不是真实 span 元素（缺 t-prog/t-status）: ' + liveCls.join('|'));
  // raw protocol lines live in run.log (SSE turns them into [progress] summaries by design)
  const { lines } = await (await fetch(`${BASE}/api/v1/jobs/${jobId}/log?tail=400`)).json();
  if (!lines.some(l => /^\[TerrainConverter\] Progress: \d+\/\d+/.test(l))
    || !lines.some(l => /^\[TerrainConverter\] Done: \d+\/\d+/.test(l)))
    throw new Error('run.log 缺原始 Progress:/Done: 协议行');
  // 提交后自动弹出模态日志框：收掉，否则会挡住后续步骤对表单的操作
  await page.keyboard.press('Escape');
  await page.waitForSelector('#logModal', { state: 'hidden' });
  if (realErrs(page).length) throw new Error('提交后 JS 错误: ' + realErrs(page).join(' ;; '));
});

/* ---------- 6. progress bar + viewer link ---------- */
await step('6 进度条 100% 且生成 viewer 深链', async () => {
  const w = await page.$eval('#jobs tr .bar i', (n) => n.style.width);
  if (w !== '100%') throw new Error('进度条: ' + w);
  const href = await page.$eval('#jobs tr a', (n) => n.getAttribute('href'));
  if (!/viewer\.html\?asset=/.test(href)) throw new Error('查看链接: ' + href);
});

/* ---------- 7. zod validation surfaces in UI ---------- */
await step('7 偶数 samplesPerTile → 界面显示 422 VALIDATION', async () => {
  await page.fill('#f_samplesPerTile', '64');
  await page.setInputFiles('#file', TIF);
  await page.click('#submit');
  await page.waitForFunction(() => document.querySelector('#msg').textContent.length > 0, null, { timeout: 8000 });
  const msg = await page.textContent('#msg');
  if (!/VALIDATION|odd/i.test(msg)) throw new Error('提示: ' + msg);
});

/* ---------- 8. viewer: real terrain renders (WebGL) ---------- */
await step('8 viewer 深链加载真实 quantized-mesh 地形（WebGL 渲染 + 瓦片 200）', async () => {
  const body = await (await fetch(`${BASE}/api/v1/jobs/${jobId}/artifacts`)).json();
  const arts = body.artifacts || body;
  const url = arts.find(a => a.role === 'terrain').viewer.url; // dir, not the layer.json itself
  const vp = await newPage('/viewer.html?asset=' + encodeURIComponent(url) + '&type=terrain');
  await vp.waitForFunction(() => /已加载/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  await vp.waitForTimeout(2500);
  const size = await vp.$eval('#cesiumContainer canvas', (c) => [c.width, c.height]);
  if (!size[0] || !size[1]) throw new Error('canvas 尺寸 0');
  const tileReq = await vp.evaluate(async (u) => {
    const r = await fetch(u.replace(/\/+$/, '') + '/layer.json');
    return r.status;
  }, url);
  if (tileReq !== 200) throw new Error('layer.json ' + tileReq);
  if (realErrs(vp).length) throw new Error('viewer JS 错误: ' + realErrs(vp).join(' ;; '));
  await vp.screenshot({ path: '/tmp/ui_terrain.png' });
  await vp.close();   // free the WebGL render loop — leaked viewers starve later steps
});

/* ---------- 9. viewer: real 3D Tiles ---------- */
await step('9 viewer 加载真实 3D Tiles tileset（.prj+.cps 配准产物）', async () => {
  const list = await (await fetch(`${BASE}/api/v1/jobs?limit=200`)).json();
  const t = list.items.find(j => j.type === 'tiles' && j.status === 'succeeded');
  if (!t) skip('无成功 tiles 任务可复用 — 需先跑过一例真实模型（../MGO/Data 私有回归数据不随仓库分发）');
  const url = t.artifacts.find(a => a.role === '3dtiles').url;
  const vp = await newPage('/viewer.html?asset=' + encodeURIComponent(url) + '&type=3dtiles');
  await vp.waitForFunction(() => /已加载/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  await vp.waitForTimeout(1500);
  await vp.screenshot({ path: '/tmp/ui_tiles.png' });
  const errs = realErrs(vp).filter(e => !/404|not found|Failed to load|tile/i.test(e));
  if (errs.length) throw new Error('tiles 渲染 JS 错误: ' + errs.join(' ;; '));
  await vp.close();
});

/* ---------- 10. responsive mobile ---------- */
await step('10 移动端 390px：单列、表格滚动、无横向溢出、viewer HUD 可折叠', async () => {
  const mc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const p = await mc.newPage();
  await p.goto(BASE + '/console.html', { waitUntil: 'networkidle' });
  const cols = await p.$eval('main', (n) => getComputedStyle(n).gridTemplateColumns.split(' ').length);
  if (cols !== 1) throw new Error('main 列数=' + cols);
  if (await p.$eval('th.c-input', (n) => getComputedStyle(n).display) !== 'none')
    throw new Error('输入列未隐藏');
  if (await p.$eval('.scrollx', (n) => getComputedStyle(n).overflowX) !== 'auto')
    throw new Error('表格未横向滚动');
  if (!(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2)))
    throw new Error('出现横向溢出');
  const mv = await mc.newPage();
  await mv.goto(BASE + '/viewer.html', { waitUntil: 'domcontentloaded' });
  await mv.waitForFunction(() => getComputedStyle(document.querySelector('#hudToggle')).display !== 'none');
  // HUD default-collapse runs inside the ES module, after ~5MB Cesium.js loads → wait for it
  await mv.waitForFunction(() => document.querySelector('#hud').classList.contains('collapsed'),
    null, { timeout: 60000 });
  await mv.click('#hudToggle');
  await mv.waitForFunction(() => !document.querySelector('#hud').classList.contains('collapsed'));
  await mc.close();
});

/* ---------- 11. non-whitelisted IP rejected (X-Forwarded-For) ---------- */
await step('11 非白名单 IP：API 403 + 页面 403 + 本机白名单页可开', async () => {
  // browser pages cannot set X-Forwarded-For (forbidden header) → test the
  // API directly with a spoofed client IP; localhost stays allowed
  const r = await fetch(BASE + '/api/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '8.8.8.8' },
    body: JSON.stringify({ type: 'geojson', inputPath: '/tmp/x.json' }),
  });
  const body = await r.json().catch(() => null);
  if (r.status !== 403 || body?.error?.code !== 'IP_NOT_ALLOWED') {
    throw new Error(`非白名单 IP 未被拒绝: ${r.status} ${JSON.stringify(body)}`);
  }
  // global gate: spoofed IP cannot open any page
  const page = await fetch(BASE + '/console.html', { headers: { 'X-Forwarded-For': '8.8.8.8' } });
  if (page.status !== 403) throw new Error('非白名单页面未 403: ' + page.status);
  const pg = await page.text();
  if (!/403/.test(pg)) throw new Error('403 页面无内容');
  // localhost stays allowed + management page reachable
  const ok = await fetch(BASE + '/api/v1/whitelist');
  if (ok.status !== 200) throw new Error('本机访问 whitelist 失败: ' + ok.status);
  const wl = await fetch(BASE + '/whitelist.html');
  if (wl.status !== 200) throw new Error('本机白名单页不可达: ' + wl.status);
});

/* ---------- 12. bare viewer recent-jobs picker ---------- */
await step('12 viewer 无参打开 → 近期成功任务下拉可加载', async () => {
  const vp = await newPage('/viewer.html');
  // the recent-jobs <select> is a direct child of #hud (the type select is nested in .row)
  await vp.waitForFunction(() => document.querySelector('#hud > select'), null, { timeout: 60000 });
  const opts = await vp.$$eval('#hud > select option', (n) => n.length);
  if (opts < 2) throw new Error('下拉为空: ' + opts + '项');
  await vp.selectOption('#hud > select', { index: 1 });
  await vp.waitForFunction(() => /已加载/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  await vp.close();
});

/* ---------- 13-23. product-polish features (redesigned UI) ---------- */
{
  const consolePage = await newPage('/console.html');

  await step('13 任务统计条（计数与总数）', async () => {
    await consolePage.waitForFunction(() => /成功/.test(document.querySelector('#stats').textContent));
    if (!/共 \d+ 个任务/.test(await consolePage.textContent('#stats'))) throw new Error('统计条缺总数');
  });
  await step('14 拖拽区显示所选文件名与大小', async () => {
    await consolePage.selectOption('#type', 'terrain');
    await consolePage.setInputFiles('#file', TIF);
    await consolePage.waitForFunction(() => /test_terrain\.tif/.test(document.querySelector('#dropMeta').textContent));
  });
  await step('15 类型下拉带图标', async () => {
    await consolePage.selectOption('#type', 'tiles');
    const opts = await consolePage.$$eval('#type option', (n) => n.map((o) => o.textContent));
    if (!opts.some((x) => x.includes('🏗'))) throw new Error('图标缺失: ' + opts.join('|'));
  });
  await step('16 提交成功 → Toast 自动出现并消失', async () => {
    await consolePage.setInputFiles('#file', TIF);
    await consolePage.click('#submit');
    await consolePage.waitForFunction(() => document.querySelectorAll('.toast').length > 0, null, { timeout: 8000 });
    await consolePage.waitForFunction(() => document.querySelectorAll('.toast').length === 0, null, { timeout: 8000 });
    await consolePage.keyboard.press('Escape');   // 提交弹出的日志模态框会遮住列表
    await consolePage.waitForSelector('#logModal', { state: 'hidden' });
  });
  await step('17 点击任务 ID 复制 → Toast（如实：成功才说已复制，且带完整 ID）', async () => {
    await consolePage.waitForSelector('#jobs tr .jobId');
    const uuid = await consolePage.getAttribute('#jobs tr .jobId', 'data-copy');
    await consolePage.click('#jobs tr .jobId');
    // 回归：剪贴板 API 只存在于安全上下文（https/localhost），经 http://IP 访问时没有
    // navigator.clipboard——旧代码吞掉失败还弹"已复制"，纯误导。成功提示必须带上完整 ID。
    await consolePage.waitForFunction((u) => {
      const t = [...document.querySelectorAll('.toast')].find((x) => !x.classList.contains('err'));
      return t && /已复制：/.test(t.textContent) && t.textContent.includes(u) && !/失败/.test(t.textContent);
    }, uuid, { timeout: 4000 });
    // 回归①：完整 36 位无空格 UUID 曾把 .toast 撑成 ~30px 细条（图标/文字/✕ 全溢出盒外、
    // 超出视口）；回归②：盒子高度也曾被算成纯 padding 的 24px（折行的第二行文字伸出盒底）。
    // 要求：盒子在视口内、宽高都贴着内容（宽≥200；高不能是 24px 那种纯边距值），子元素
    // 上下左右都落在盒内。
    await consolePage.waitForFunction(() => {
      const t = [...document.querySelectorAll('.toast')].at(-1);
      if (!t) return false;
      const r = t.getBoundingClientRect();
      if (r.left < 0 || r.right > innerWidth + 1 || r.width < 200 || r.height < 45) return false;
      return [...t.children].every((k) => {
        const kr = k.getBoundingClientRect();
        return kr.width > 0 && kr.left >= r.left && kr.right <= r.right + 1 && kr.bottom <= r.bottom + 1;
      });
    }, null, { timeout: 4000 }).catch(() => { throw new Error('toast 未正确包裹提示内容（宽度/高度/内容溢出）'); });
  });
  await step('18 日志悬浮弹框：居中弹出 / 复制 / Esc 与遮罩关闭', async () => {
    await consolePage.click('#jobs tr [data-act="log"]');
    await consolePage.waitForSelector('#logModal .dialog', { state: 'visible' });
    // 弹框必须是悬浮层且整体在视口内，不依赖页面滚动位置
    // （回归：它曾排在上百行表格之后，点开在视口外，看起来就是"按钮点了没反应"；
    //   waitForSelector 只看元素可见，管不了在不在视口内，所以必须显式断言）
    await consolePage.waitForFunction(() => {
      const m = document.querySelector('#logModal');
      const r = m.querySelector('.dialog').getBoundingClientRect();
      return getComputedStyle(m).position === 'fixed'
        && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    }, null, { timeout: 4000 }).catch(() => { throw new Error('日志弹框未悬浮在视口内'); });
    if (!(await consolePage.$eval('#jobs tr[data-id]', (n) => n.classList.contains('cur'))))
      throw new Error('正在看日志的行缺高亮标记');
    if (!(await consolePage.evaluate(() => document.body.classList.contains('locked'))))
      throw new Error('弹框打开时背景未锁滚动');
    await consolePage.click('#copyLogBtn');
    await consolePage.waitForFunction(() => document.querySelectorAll('.toast').length > 0, null, { timeout: 4000 });
    await consolePage.keyboard.press('Escape');
    await consolePage.waitForSelector('#logModal', { state: 'hidden' });
    await consolePage.waitForFunction(() => !document.body.classList.contains('locked')
      && document.querySelectorAll('#jobs tr.cur').length === 0, null, { timeout: 4000 });
    await consolePage.click('#jobs tr [data-act="log"]');   // 点遮罩也要能关
    await consolePage.waitForSelector('#logModal .dialog', { state: 'visible' });
    await consolePage.mouse.click(6, 6);
    await consolePage.waitForSelector('#logModal', { state: 'hidden' });
  });

  await step('18b 任务列表分页：翻页不重叠、每页条数、末页夹取', async () => {
    const { total } = await (await fetch(BASE + '/api/v1/jobs?limit=1')).json();
    if (total < 21) skip(`任务总数 ${total} < 21，不足以验证分页`);
    const rows = () => consolePage.$$eval('#jobs tr[data-id]', (n) => n.map((x) => x.dataset.id));
    await consolePage.selectOption('#pageSizeSel', '10');
    await consolePage.waitForFunction(() => document.querySelectorAll('#jobs tr[data-id]').length === 10,
      null, { timeout: 8000 });
    if (!new RegExp(`共 ${total} 条`).test(await consolePage.textContent('#pager')))
      throw new Error('分页条缺总数：' + (await consolePage.textContent('#pager')).trim());
    const p1 = await rows();
    await consolePage.click('#pager [data-page="2"]');
    await consolePage.waitForFunction((old) => {
      const now = [...document.querySelectorAll('#jobs tr[data-id]')].map((x) => x.dataset.id);
      return now.length === 10 && !now.some((id) => old.includes(id));
    }, p1, { timeout: 8000 });
    if ((await rows()).some((id) => p1.includes(id))) throw new Error('第 2 页与第 1 页内容重叠');
    if (!(await consolePage.$eval('#pager [data-page="2"]', (n) => n.classList.contains('on'))))
      throw new Error('当前页码未高亮');
    await consolePage.selectOption('#pageSizeSel', '20');   // 换每页条数应回到第 1 页
    await consolePage.waitForFunction(() => document.querySelectorAll('#jobs tr[data-id]').length === 20
      && document.querySelector('#pager [data-page="1"].on'), null, { timeout: 8000 });
    await consolePage.click('#pager [title="末页"]');        // 末页只装得下剩下的尾巴
    await consolePage.waitForFunction(() => document.querySelectorAll('#jobs tr[data-id]').length < 20,
      null, { timeout: 8000 });
    if (!(await consolePage.$eval('#pager [title="下一页"]', (n) => n.disabled)))
      throw new Error('末页的"下一页"未禁用');
    if ((await rows()).length + (Math.ceil(total / 20) - 1) * 20 !== total)
      throw new Error('末页行数与总数不自洽');
    await consolePage.selectOption('#pageSizeSel', '10');   // 复原：后续步骤按默认页大小断言
    await consolePage.waitForFunction(() => document.querySelectorAll('#jobs tr[data-id]').length === 10,
      null, { timeout: 8000 });
  });
  await step('19 状态徽章为中文文案 + 状态类', async () => {
    const txt = await consolePage.$eval('#jobs tr .badge', (n) => n.textContent);
    if (!/成功|运行中|排队中|失败/.test(txt)) throw new Error('徽章文案: ' + txt);
  });
  await consolePage.close();

  const vp = await newPage('/viewer.html?asset=' + encodeURIComponent('/ws/' + jobId + '/out') + '&type=terrain');
  await vp.waitForFunction(() => /已加载/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  await step('20 viewer 图层列表 + 计数条', async () => {
    await vp.waitForSelector('#layerList li');
    if ((await vp.textContent('#layerCount')).trim() !== '1') throw new Error('计数条≠1');
  });
  await step('21 坐标读数随鼠标移动更新', async () => {
    await vp.mouse.move(500, 400);
    await vp.waitForFunction(() => /经度/.test(document.querySelector('#coord').textContent), null, { timeout: 6000 });
  });
  await step('22 截图按钮产出 PNG 下载', async () => {
    const dl = vp.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await vp.click('#shot');
    const d = await dl;
    // headless 下下载事件偶发不可靠 → 以状态文本兜底
    const okStatus = await vp.waitForFunction(() => /已保存截图|截图失败/.test(document.querySelector('#status').textContent),
      null, { timeout: 10000 }).then((h) => h.jsonValue());
    if (d && !/\.png$/.test(d.suggestedFilename())) throw new Error('下载名非 png: ' + d.suggestedFilename());
    if (!d && !/已保存截图/.test(okStatus)) throw new Error('既无下载也无成功状态: ' + okStatus);
  });
  await step('23 复位视角按钮可点击 + 移除图层生效', async () => {
    await vp.click('#home');
    await vp.waitForFunction(() => /已复位视角/.test(document.querySelector('#status').textContent), null, { timeout: 8000 });
    await vp.click('#layerList li .rm');
    await vp.waitForFunction(() => document.querySelector('#layerCount').textContent === '0');
    const wrap = await vp.$eval('#layerWrap', (n) => getComputedStyle(n).display);
    if (wrap !== 'none') throw new Error('空图层分组未隐藏');
  });
  await vp.close();

  /* ---------- 24. free online base imagery ---------- */
  await step('24 免费在线底图：切换源 + 瓦片请求 + 归属标注 + 关闭', async () => {
    const bp = await newPage('/viewer.html?asset=' + encodeURIComponent('/ws/' + jobId + '/out') + '&type=terrain&basemap=none');
    await bp.waitForFunction(() => /已加载/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
    const tileReqs = [];
    bp.on('request', (r) => {
      if (/tile\.openstreetmap\.org|arcgisonline\.com|basemaps\.cartocdn\.com|tile\.opentopomap\.org/.test(r.url())) tileReqs.push(1);
    });
    await bp.selectOption('#basemap', 'carto_dark');
    await bp.waitForFunction(() => /底图：/.test(document.querySelector('#status').textContent));
    await bp.waitForFunction(() => document.querySelector('#credit').textContent.includes('CARTO'));
    await bp.waitForTimeout(5000);
    if (!tileReqs.length) throw new Error('切换底图后无瓦片请求');
    await bp.selectOption('#basemap', 'none');
    await bp.waitForFunction(() => /底图：无/.test(document.querySelector('#status').textContent));
    if (realErrs(bp).length) throw new Error('底图切换 JS 错误: ' + realErrs(bp).join(' ;; '));
    await bp.close();
  });

  /* ---------- 25. whitelist management page (localhost) ---------- */
  await step('25 白名单管理页：增删条目 → 保存 → 持久化 → 重置', async () => {
    // idempotent start: clear any leftovers from previous runs
    await fetch(BASE + '/api/v1/whitelist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ whitelist: [] }),
    });
    const wp = await newPage('/whitelist.html');
    await wp.waitForSelector('#list li', { timeout: 8000 });
    if (!/已授权/.test(await wp.textContent('#stateBadge'))) throw new Error('本机未显示已授权');
    if ((await wp.$$eval('#list li', (n) => n.length)) < 2) throw new Error('恒允许的本机条目缺失');
    // add two entries (button + Enter)
    await wp.fill('#entry', '203.0.113.80');
    await wp.click('#addBtn');
    await wp.fill('#entry', '10.30.0.0/16');
    await wp.press('#entry', 'Enter');
    // remove the first one
    await wp.click('#list li .rm');
    await wp.click('#saveBtn');
    await wp.waitForFunction(() => /已保存/.test(document.querySelector('#msg').textContent));
    const wl = await (await fetch(BASE + '/api/v1/whitelist')).json();
    if (!wl.whitelist.includes('10.30.0.0/16')) throw new Error('保存后 CIDR 未生效: ' + JSON.stringify(wl.whitelist));
    if (wl.whitelist.includes('203.0.113.80')) throw new Error('移除的条目仍在白名单');
    // newly added CIDR passes the global gate (any non-IP_NOT_ALLOWED error
    // means the gate let it through — here it reaches the localpath check)
    const r = await fetch(BASE + '/api/v1/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.30.1.1' },
      body: JSON.stringify({ type: 'geojson', inputPath: '/tmp/none.json' }),
    });
    const rbody = await r.json().catch(() => null);
    if (rbody?.error?.code === 'IP_NOT_ALLOWED') throw new Error('新增 CIDR 未放行');
    // reset to default
    await wp.click('#resetBtn');
    await wp.waitForFunction(() => /已恢复默认/.test(document.querySelector('#msg').textContent));
    const wl2 = await (await fetch(BASE + '/api/v1/whitelist')).json();
    if (wl2.whitelist.some((e) => e !== '127.0.0.1' && e !== '::1')) throw new Error('重置后仍有额外条目');
    // The reset above wipes workspace/whitelist.json — put the deployment's own
    // entries back so running the UI suite can never lock a remote operator out.
    await wlRestore();
    const wl3 = await (await fetch(BASE + '/api/v1/whitelist')).json();
    for (const e of wlSnapshot) {
      if (!wl3.whitelist.includes(e)) throw new Error(`未能恢复原白名单条目 ${e}: ${JSON.stringify(wl3.whitelist)}`);
    }
    if (realErrs(wp).length) throw new Error('白名单页 JS 错误: ' + realErrs(wp).join(' ;; '));
    await wp.close();
  });
}

await wlRestore().catch(() => {});   // safety net even if a step threw mid-flight
await browser.close();
console.log(`\n${passN} pass / ${failN} fail / ${skipN} skip / ${passN + failN + skipN} total`);
process.exit(failN ? 1 : 0);
