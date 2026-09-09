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
const WS = process.env.UI_WORKSPACE || 'workspace';   // server workspace root (disk asserts only)

// Terrain upload fixture: regenerated from scripts/generate-test-tif.py (also
// `npm run fixture:terrain`) so a clean clone can run the suite unaided.
const TIF = process.env.UI_TIF
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'test', 'fixtures', 'test_terrain.tif');
if (!fs.existsSync(TIF)) {
  console.log(`(fixture ${TIF} missing — generating)`);
  const REPO = path.dirname(fileURLToPath(import.meta.url));
  execFileSync('python3', [path.join(REPO, 'scripts', 'generate-test-tif.py')], { stdio: 'inherit' });
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
    failN++; console.log(`FAIL  ${name}\n      ${e.message.split('\n').slice(0, 18).join('\n      ')}`);
    // 失败现场：截图 + 主页面的点击拦截诊断（弹框未关/inert/遮挡是常见根因）
    try {
      await page.screenshot({ path: '/tmp/uitest-fail.png' });
      const hit = await page.evaluate(() => {
        const btn = document.querySelector('#submit');
        const r = btn?.getBoundingClientRect();
        const el = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
        return JSON.stringify({
          hit: el ? `${el.tagName}#${el.id}.${String(el.className).slice(0, 40)}` : null,
          mainInert: document.querySelector('main')?.inert ?? null,
          modals: [...document.querySelectorAll('.modal')].map((m) => `${m.id}:${m.hidden}`),
          focused: document.activeElement?.id || document.activeElement?.tagName || null,
          logJob: document.querySelector('#logJob')?.textContent ?? null,
          logHead: (document.querySelector('#logBox')?.textContent ?? '').slice(0, 60),
        });
      });
      console.log(`      现场诊断: ${hit}  截图: /tmp/uitest-fail.png`);
    } catch { /* 诊断失败不影响结果 */ }
  }
};

// The whitelist suite step writes workspace/whitelist.json.  Snapshot the live
// entries first so a test run against a real deployment can never lock anyone
// out.  IMPORTANT: only trust the snapshot if the GET actually succeeded —
// a boot-time fetch failure degrades to [] and would then *clear* the real
// whitelist on restore.  When the snapshot is unusable we SKIP step 25 instead
// of risking a live deployment's access list.
const wlProbe = await fetch(BASE + '/api/v1/whitelist')
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
const wlSnapshotOk = Boolean(wlProbe);
const wlSnapshot = (wlProbe?.whitelist ?? [])
  .filter((e) => e !== '127.0.0.1' && e !== '::1');
const wlRestore = async () => {
  await fetch(BASE + '/api/v1/whitelist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ whitelist: wlSnapshot }),
  });
};

// Per-run unique fs-probe fixture name: two concurrent runs (or a crashed
// predecessor) must never share/collide on the same directory under the
// deployment's allowed root.
const FIXNAME = 'ui-fsprobe-' + process.pid;
const ZIPNAME = `ui_res_tree-${process.pid}`;   // /tmp 暂存 zip 同样按运行唯一

/** 新任务绑定：除「不在 before 集合」外还要求 inputName 匹配——在有真实
 *  并发提交的部署上，纯集合差可能把步骤绑到别人的任务上（后续断言全错）。
 *  分页窗口取前 50 条足够：新任务排在最前。 */
async function waitForNewJob(before, inputName, { timeout = 25000 } = {}) {
  const names = Array.isArray(inputName) ? inputName : [inputName];
  const t0 = Date.now();
  for (;;) {
    const { items } = await (await fetch(`${BASE}/api/v1/jobs?limit=50`)).json();
    const hit = (items ?? []).find((x) => !before.has(x.id) && names.includes(x.inputName));
    if (hit) return hit.id;
    if (Date.now() - t0 > timeout) throw new Error(`${timeout}ms 内未出现新任务（inputName=${names.join('|')}）`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

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
  if (!(await page.$('#inputPath'))) throw new Error('osgb 未显示路径输入（隐藏态）');
  if (!(await page.$('#file'))) throw new Error('osgb 未显示上传输入');
  if (!(await page.$('#dirPick'))) throw new Error('osgb 未显示文件夹选择控件');
  // FilePicker 切换段恒在：上传/路径两按钮；未启用本地路径时路径段禁用+有提示
  const segBtns = await page.$$eval('#fpkSeg button', (bs) => bs.map((x) => ({ m: x.dataset.m, dis: x.disabled, tip: x.title })));
  if (segBtns.length !== 2) throw new Error('切换段按钮数 != 2: ' + JSON.stringify(segBtns));
  const cap3 = await (await fetch(BASE + '/api/v1/capabilities')).json();
  if (segBtns[1].dis !== !cap3.features?.fsBrowse) throw new Error('路径段禁用态与 capabilities 不符');
  if (!cap3.features?.fsBrowse && !/MGO_ALLOW_LOCAL_PATH/.test(segBtns[1].tip)) throw new Error('禁用提示缺失');
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
  const before = new Set((await (await fetch(`${BASE}/api/v1/jobs?limit=50`)).json()).items.map((x) => x.id));
  await page.setInputFiles('#file', TIF);
  await page.click('#submit');
  jobId = await waitForNewJob(before, 'test_terrain.tif');
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
  let vp;
  try {
    vp = await newPage('/viewer.html?asset=' + encodeURIComponent(url) + '&type=terrain');
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
  } finally {
    await vp?.close();   // free the WebGL render loop — leaked viewers starve later steps
  }
});

/* ---------- 8b. tiles multi-file through the console ---------- */
const OBJ_A = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'test', 'fixtures', 'cubeA.obj');
const OBJ_B = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'test', 'fixtures', 'cubeB.obj');
let multiJobId;
await step('8b tiles 多文件：统一参数转换 + 合并 tileset（console 上传两个模型）', async () => {
  const before = new Set((await (await fetch(`${BASE}/api/v1/jobs?limit=50`)).json()).items.map((x) => x.id));
  await page.selectOption('#type', 'tiles');
  await page.waitForSelector('#inputArea input#file[multiple]');
  await page.setInputFiles('#file', [OBJ_A, OBJ_B]);
  await page.waitForFunction(() => /2 个文件/.test(document.querySelector('#dropMeta').textContent),
    null, { timeout: 5000 });
  await page.click('#submit');
  multiJobId = await waitForNewJob(before, 'cubeA.obj (+1)');
  await page.waitForFunction(() => /\[status\] succeeded/.test(document.querySelector('#logBox').textContent),
    null, { timeout: 180000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#logModal', { state: 'hidden' });
  const dto = await (await fetch(`${BASE}/api/v1/jobs/${multiJobId}`)).json();
  if (dto.status !== 'succeeded') throw new Error('状态 ' + dto.status + ' ' + JSON.stringify(dto.error));
  if (dto.inputName !== 'cubeA.obj (+1)') throw new Error('inputName: ' + dto.inputName);
  const url = dto.artifacts.find((a) => a.role === '3dtiles').url;
  if (url !== `/ws/${multiJobId}/out/tileset.json`) throw new Error('统一入口: ' + url);
  const merged = await (await fetch(BASE + url)).json();
  const uris = merged.root.children.map((c) => c.content.uri);
  if (uris.length !== 2 || !uris.includes('cubeA/tileset.json') || !uris.includes('cubeB/tileset.json'))
    throw new Error('合并 children 不符: ' + JSON.stringify(uris));
  // 目录逻辑统一：每个输入各有 out/<stem>/tileset.json，且可经数据面访问
  for (const u of uris) {
    const r = await fetch(`${BASE}/ws/${multiJobId}/out/${u}`);
    if (r.status !== 200) throw new Error(u + ' → ' + r.status);
  }
  const { lines } = await (await fetch(`${BASE}/api/v1/jobs/${multiJobId}/log?tail=200`)).json();
  const argvs = lines.filter((l) => l.startsWith('[Service] argv: tiles'));
  if (argvs.length !== 2) throw new Error('每个输入应有独立 argv 记录: ' + argvs.length);
  if (!/ -i \S+\/input\/cubeA\.obj -o \S+\/out\/cubeA( |$)/.test(argvs[0])
    || !/ -i \S+\/input\/cubeB\.obj -o \S+\/out\/cubeB( |$)/.test(argvs[1]))
    throw new Error('逐输入独立转换目录不符: ' + argvs.join(' ;; '));
  if (argvs[0].replace(/-i \S+ -o \S+/, '') !== argvs[1].replace(/-i \S+ -o \S+/, ''))
    throw new Error('两次转换参数不一致（应统一）');
  if (!lines.some((l) => l.includes('merging 2 tileset(s) with 3d-tiles-tools mergeJson')))
    throw new Error('未见合并步骤日志');
});

/* ---------- 8c. model + side-car textures ZIP (resource-tree upload) ---------- */
async function makeResZip(entries) {
  const yazl = (await import('yazl')).default;
  const { pipeline } = await import('node:stream/promises');
  const { Writable } = await import('node:stream');
  const z = new yazl.ZipFile();
  for (const [p, buf] of entries) z.addBuffer(buf, p);
  const chunks = [];
  const done = pipeline(z.outputStream, new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } }));
  z.end();
  await done;
  return Buffer.concat(chunks);
}
await step('8c tiles+贴图 ZIP（文件树上传）：贴图与模型同层保留、多模型自动全选', async () => {
  const fs = await import('node:fs');
  // ① 两个子目录模型 + 各自贴图：tiles 无模型路径框，服务端自动全选全部模型再合并
  const zip2 = await makeResZip([
    ['g1/cubeA.obj', fs.readFileSync(OBJ_A)],
    ['g1/tex.png', Buffer.from('PNGFAKE')],
    ['g2/cubeB.obj', fs.readFileSync(OBJ_B)],
    ['g2/tex.png', Buffer.from('PNGFAKE')],
  ]);
  const ZIP_A = `/tmp/${ZIPNAME}.zip`;
  fs.writeFileSync(ZIP_A, zip2);
  await page.selectOption('#type', 'tiles');
  await page.waitForSelector('#file');
  await page.setInputFiles('#file', ZIP_A);   // 统一入口：ZIP 直接进文件区
  await page.waitForFunction((zn) => new RegExp(zn + '\\.zip.*ZIP 文件树').test(document.querySelector('#dropMeta').textContent), ZIPNAME,
    { timeout: 5000 });
  if (await page.$('#modelPaths')) throw new Error('tiles 不应再出现模型路径输入框');
  const before = new Set((await (await fetch(`${BASE}/api/v1/jobs?limit=50`)).json()).items.map((x) => x.id));
  await page.click('#submit');
  const zipJobId = await waitForNewJob(before, 'g1/cubeA.obj (+1)');
  await page.waitForFunction(() => /\[status\] succeeded/.test(document.querySelector('#logBox').textContent),
    null, { timeout: 180000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('#logModal', { state: 'hidden' });
  const dto = await (await fetch(`${BASE}/api/v1/jobs/${zipJobId}`)).json();
  if (dto.status !== 'succeeded') throw new Error('状态 ' + dto.status + ' ' + JSON.stringify(dto.error));
  if (dto.inputName !== 'g1/cubeA.obj (+1)') throw new Error('inputName: ' + dto.inputName);
  const merged = await (await fetch(`${BASE}/ws/${zipJobId}/out/tileset.json`)).json();
  const uris = merged.root.children.map((c) => c.content.uri).sort();
  if (JSON.stringify(uris) !== JSON.stringify(['g1_cubeA/tileset.json', 'g2_cubeB/tileset.json']))
    throw new Error('树上传合并 children 不符: ' + JSON.stringify(uris));
  const { lines } = await (await fetch(`${BASE}/api/v1/jobs/${zipJobId}/log?tail=200`)).json();
  const argvs = lines.filter((l) => l.startsWith('[Service] argv: tiles'));
  if (!/ -i \S+\/input\/g1\/cubeA\.obj -o \S+\/out\/g1_cubeA( |$)/.test(argvs[0])
    || !/ -i \S+\/input\/g2\/cubeB\.obj -o \S+\/out\/g2_cubeB( |$)/.test(argvs[1]))
    throw new Error('模型未在树内路径被转换: ' + argvs.join(' ;; '));
  for (const rel of ['g1/cubeA.obj', 'g1/tex.png', 'g2/cubeB.obj', 'g2/tex.png']) {
    const p = path.resolve(WS, 'jobs', zipJobId, 'input', rel);
    if (!fs.existsSync(p)) throw new Error('贴图/模型未同层保留: ' + rel);
  }
  // ② 单模型 ZIP：无需模型路径框，自动识别唯一模型
  const zip1 = await makeResZip([
    ['only/cubeA.obj', fs.readFileSync(OBJ_A)],
    ['only/tex.png', Buffer.from('PNGFAKE')],
  ]);
  const ZIP_B = `/tmp/${ZIPNAME}-1.zip`;
  fs.writeFileSync(ZIP_B, zip1);
  await page.setInputFiles('#file', ZIP_B);
  const before2 = new Set((await (await fetch(`${BASE}/api/v1/jobs?limit=50`)).json()).items.map((x) => x.id));
  await page.click('#submit');
  const autoId = await waitForNewJob(before2, 'only/cubeA.obj');
  await page.waitForFunction(() => /\[status\] succeeded/.test(document.querySelector('#logBox').textContent),
    null, { timeout: 180000 });
  await page.keyboard.press('Escape');
  const dto2 = await (await fetch(`${BASE}/api/v1/jobs/${autoId}`)).json();
  if (dto2.inputName !== 'only/cubeA.obj') throw new Error('自动识别失败: ' + dto2.inputName);
  const merged2 = await (await fetch(`${BASE}/ws/${autoId}/out/tileset.json`)).json();
  if (merged2.root.children[0].content.uri !== 'only_cubeA/tileset.json')
    throw new Error('单模型树上传 children 不符');
});

/* ---------- 9. viewer: real 3D Tiles ---------- */
await step('9 viewer 加载真实 3D Tiles tileset（优先 8b 的合并产物）', async () => {
  const list = await (await fetch(`${BASE}/api/v1/jobs?limit=200`)).json();
  const t = list.items.find((j) => j.type === 'tiles' && j.status === 'succeeded');
  if (!t) skip('无成功 tiles 任务可复用 — 需先跑过一例真实模型（../MGO/Data 私有回归数据不随仓库分发）');
  const url = t.artifacts.find(a => a.role === '3dtiles').url;
  let vp;
  try {
    vp = await newPage('/viewer.html?asset=' + encodeURIComponent(url) + '&type=3dtiles');
  await vp.waitForFunction(() => /已加载/.test(document.querySelector('#status').textContent), null, { timeout: 60000 });
  await vp.waitForTimeout(1500);
  await vp.screenshot({ path: '/tmp/ui_tiles.png' });
  const errs = realErrs(vp).filter(e => !/404|not found|Failed to load|tile/i.test(e));
  if (errs.length) throw new Error('tiles 渲染 JS 错误: ' + errs.join(' ;; '));
  // 合并 tileset 的每个外部子瓦片集都必须能被 Cesium 解析请求到（HTTP 200）
  if (t.id === multiJobId) {
    const merged = await (await fetch(BASE + url)).json();
    for (const c of merged.root.children) {
      const r = await fetch(`${BASE}${url.replace('/tileset.json', '/')}${c.content.uri}`);
      if (r.status !== 200) throw new Error('外部子瓦片集不可达: ' + c.content.uri);
    }
  }
  } finally {
    await vp?.close();
  }
});

/* ---------- 10. responsive mobile ---------- */
await step('10 移动端 390px：单列、表格滚动、无横向溢出、viewer HUD 可折叠', async () => {
  const mc = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  try {
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
  } finally {
    await mc.close();
  }
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
  try {

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
    const wf = (label, fn, arg) => consolePage.waitForFunction(fn, arg, { timeout: 15000 })
      .catch((e) => { throw new Error(`18b/${label}: ${e.message.split('\n')[0]}`); });
    await consolePage.selectOption('#pageSizeSel', '10');
    await wf('W1 rows=10', () => document.querySelectorAll('#jobs tr[data-id]').length === 10);
    if (!new RegExp(`共 ${total} 条`).test(await consolePage.textContent('#pager')))
      throw new Error('分页条缺总数：' + (await consolePage.textContent('#pager')).trim());
    const p1 = await rows();
    await consolePage.click('#pager [data-page="2"]');
    await wf('W2 p2 all-new', (old) => {
      const now = [...document.querySelectorAll('#jobs tr[data-id]')].map((x) => x.dataset.id);
      return now.length === 10 && !now.some((id) => old.includes(id));
    }, p1);
    if ((await rows()).some((id) => p1.includes(id))) throw new Error('第 2 页与第 1 页内容重叠');
    if (!(await consolePage.$eval('#pager [data-page="2"]', (n) => n.classList.contains('on'))))
      throw new Error('当前页码未高亮');
    await consolePage.selectOption('#pageSizeSel', '20');   // 换每页条数应回到第 1 页
    await wf('W3 rows=20 on p1', () => document.querySelectorAll('#jobs tr[data-id]').length === 20
      && document.querySelector('#pager [data-page="1"].on'));
    await consolePage.click('#pager [title="末页"]');        // 末页只装得下剩下的尾巴
    await wf('W4 last<20', () => document.querySelectorAll('#jobs tr[data-id]').length < 20);
    if (!(await consolePage.$eval('#pager [title="下一页"]', (n) => n.disabled)))
      throw new Error('末页的"下一页"未禁用');
    if ((await rows()).length + (Math.ceil(total / 20) - 1) * 20 !== total)
      throw new Error('末页行数与总数不自洽');
    await consolePage.selectOption('#pageSizeSel', '10');   // 复原：后续步骤按默认页大小断言
    await wf('W5 back to 10', () => document.querySelectorAll('#jobs tr[data-id]').length === 10);
  });
  await step('19 状态徽章为中文文案 + 状态类', async () => {
    const txt = await consolePage.$eval('#jobs tr .badge', (n) => n.textContent);
    if (!/成功|运行中|排队中|失败/.test(txt)) throw new Error('徽章文案: ' + txt);
  });
  } finally {
    await consolePage.close();   // 中途失败也不泄漏控制台页
  }

  let vp;
  try {
  vp = await newPage('/viewer.html?asset=' + encodeURIComponent('/ws/' + jobId + '/out') + '&type=terrain');
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
  } finally {
    await vp?.close();   // WebGL 循环泄漏会饿死后续步骤
  }

  /* ---------- 24. free online base imagery ---------- */
  await step('24 免费在线底图：切换源 + 瓦片请求 + 归属标注 + 关闭', async () => {
    // 内网/防火墙环境公开瓦片源不可达 → 固定等待后必假失败；先探一次可达性
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const probe = await fetch('https://basemaps.cartocdn.com/dark_all/0/0/0.png', { signal: ctl.signal });
      clearTimeout(t);
      if (!probe.ok) skip(`公开底图源不可达（HTTP ${probe.status}），跳过外网瓦片断言`);
    } catch { skip('无外网（公开底图源不可达），跳过外网瓦片断言'); }
    let bp;
    try {
    bp = await newPage('/viewer.html?asset=' + encodeURIComponent('/ws/' + jobId + '/out') + '&type=terrain&basemap=none');
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
    } finally {
      await bp?.close();
    }
  });

  /* ---------- 26. FilePicker 组件：上传 ↔ 服务器路径（弹框增强版） ---------- */
await step('26 FilePicker：模式切换 + 跨目录多选/过滤/面包屑 + 路径提交', async () => {
  const cap = await (await fetch(BASE + '/api/v1/capabilities')).json();
  if (!cap.features?.fsBrowse) skip('服务器未开 MGO_ALLOW_LOCAL_PATH（默认部署只有上传模式）');
  const b0 = await (await fetch(BASE + '/api/v1/fs/browse', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  const root = (b0.roots ?? []).find((r) => r.ok && fs.existsSync(r.path));
  if (!root) skip('无可用允许根（MGO_ALLOWED_ROOTS 全部缺失），无法建浏览夹具');
  const FIX = path.join(root.path, FIXNAME);
  fs.mkdirSync(path.join(FIX, 'site', 'deep'), { recursive: true });
  fs.copyFileSync(OBJ_A, path.join(FIX, 'site', 'cubeA.obj'));
  fs.copyFileSync(OBJ_B, path.join(FIX, 'site', 'deep', 'cubeB.obj'));
  fs.writeFileSync(path.join(FIX, 'site', 'notes.txt'), 'not a model');   // 过滤/只看可选夹具
  // sweep leftover probe dirs from crashed/killed runs (unique names still
  // accumulate on a long-lived deployment) — anything older than a day is dead
  for (const e of fs.readdirSync(root.path)) {
    if (!e.startsWith('ui-fsprobe-')) continue;
    const p2 = path.join(root.path, e);
    try {
      if (Date.now() - fs.statSync(p2).mtimeMs > 86_400_000) fs.rmSync(p2, { recursive: true, force: true });
    } catch { /* raced */ }
  }
  try {
  await page.setViewportSize({ width: 1280, height: 900 });                 // 步骤 10 会留在移动端视口
  await page.goto(BASE + '/console.html', { waitUntil: 'networkidle' });   // 前面步骤可能停在 viewer 页
  await page.waitForSelector('#type');
  await page.selectOption('#type', 'tiles');
  await page.waitForSelector('#fpkSeg');
  if (await page.isVisible('#inputPath')) throw new Error('默认应为上传模式，路径框不可见');
  await page.click('#fpkSeg button[data-m="path"]');
  if (!(await page.isVisible('#inputPath'))) throw new Error('切到路径模式后输入框未显示');
  if (await page.isVisible('#file')) throw new Error('路径模式下上传区未隐藏');
  // 展开「投影」组，验证 pathOnly/uploadOnly 随模式切换的显隐矩阵
  await page.click('#paramForm details.grp > summary:has-text("投影")');
  // 当前处于路径模式：附件行隐藏、服务器投影文件行显示
  if (await page.isVisible('#paramForm [data-k="@prj"]')) throw new Error('路径模式下上传附件行未隐藏');
  if (!(await page.isVisible('#paramForm .pathOnly'))) throw new Error('路径模式下投影 prjPath 行未显示');
  await page.click('#fpkSeg button[data-m="upload"]');   // 回上传模式：镜像互换
  if (!(await page.isVisible('#paramForm [data-k="@prj"]'))) throw new Error('上传模式下附件行应恢复显示');
  if (await page.isVisible('#paramForm .pathOnly')) throw new Error('上传模式下 prjPath 行应隐藏');
  await page.click('#fpkSeg button[data-m="path"]');     // 再去路径模式，继续浏览流程
  await page.click('#fsBrowseBtn');
  await page.waitForSelector('#fsModal .fsItem');
  // 根 → ui-fsprobe/ → site/
  await page.click(`#fsModal .fsItem:text-is("📁 ${root.name}")`);
  await page.waitForSelector(`.fsItem:text-is("📁 ${FIXNAME}")`);
  await page.click(`.fsItem:text-is("📁 ${FIXNAME}")`);
  await page.waitForSelector('.fsItem:text-is("📁 site")');
  await page.click('.fsItem:text-is("📁 site")');
  await page.waitForSelector('.fsItem:has-text("cubeA.obj")');
  // 「只看可选」默认开：不匹配的 notes.txt 不显示；关掉后可见且禁用
  if (await page.isVisible('.fsItem:has-text("notes.txt")')) throw new Error('只看可选未生效');
  await page.uncheck('#fsOnlyOk');
  await page.waitForSelector('.fsItem:has-text("notes.txt")');
  if (!(await page.isDisabled('.fsItem:has-text("notes.txt")'))) throw new Error('不可选项未置灰');
  await page.check('#fsOnlyOk');
  if (await page.isVisible('.fsItem:has-text("notes.txt")')) throw new Error('重新开启只看可选失败');
  // 过滤框：输入 deep 后只剩 deep 目录
  await page.fill('#fsFilter', 'deep');
  await page.waitForTimeout(100);
  if (await page.isVisible('.fsItem:has-text("cubeA.obj")')) throw new Error('过滤未隐藏不匹配文件');
  if (!(await page.isVisible('.fsItem:has-text("deep")'))) throw new Error('过滤误隐藏匹配目录');
  await page.fill('#fsFilter', '');
  await page.waitForTimeout(100);
  // 跨目录多选：deep/ 里选 cubeB → 面包屑回 site/ → 选 cubeA → 加入选中（弹框保持打开）
  await page.click('.fsItem:text-is("📁 deep")');
  await page.waitForSelector('.fsItem:has-text("cubeB.obj")');
  await page.click('.fsItem:has-text("cubeB.obj")');
  await page.click('#fsCrumbs button:text-is("site")');
  await page.waitForSelector('.fsItem:has-text("cubeA.obj")');
  await page.click('.fsItem:has-text("cubeA.obj")');
  await page.click('#fsConfirm');
  if (!(await page.isVisible('#fsModal'))) throw new Error('加入选中后弹框不应关闭（跨目录续选）');
  const val = await page.inputValue('#inputPath');
  const parts = val.split(',').map((s) => s.trim());
  const reFix = FIXNAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (parts.length !== 2 || !new RegExp(`${reFix}/site/deep/cubeB\\.obj$`).test(parts[0]) || !new RegExp(`${reFix}/site/cubeA\\.obj$`).test(parts[1]))
    throw new Error('跨目录多选回填异常: ' + val);
  // 已选中不可再选：已加入的 cubeA 行置灰划线禁选，强点也不改路径框
  const usedA = page.locator('#fsList .fsItem.used', { hasText: 'cubeA.obj' });
  if (await usedA.count() !== 1) throw new Error('已加入的 cubeA 未标记为不可再选');
  if (await usedA.isEnabled()) throw new Error('已加入项仍可被点击选中');
  await usedA.click({ force: true }).catch(() => {});
  if (await page.inputValue('#inputPath') !== val) throw new Error('点击已加入项改动了路径框');
  // 跨目录同理：deep/ 内已加入的 cubeB 也置灰（目录行仍可进入，不受影响）
  await page.click('.fsItem:text-is("📁 deep")');
  await page.waitForSelector('.fsItem.used:has-text("cubeB.obj")');
  await page.click('#fsCloseBtn');
  await page.waitForFunction(() => document.querySelector('#fsModal').hidden);
  // 提交（原地路径，逗号分隔→inputPaths）→ 成功且合并 2 children
  const before26 = new Set((await (await fetch(BASE + '/api/v1/jobs?limit=50')).json()).items.map((x) => x.id));
  await page.click('#submit');
  const id = await waitForNewJob(before26, ['cubeA.obj (+1)', 'cubeB.obj (+1)']);
  if (!id) throw new Error('提交后未见新任务');
  let st = '';
  for (let i2 = 0; i2 < 60; i2++) {
    const j = await (await fetch(`${BASE}/api/v1/jobs/${id}`)).json();
    st = j.status;
    if (['succeeded', 'failed', 'usage_error'].includes(st)) break;
    await page.waitForTimeout(2000);
  }
  if (st !== 'succeeded') throw new Error('路径模式任务未成功: ' + st);
  const m = await (await fetch(`${BASE}/ws/${id}/out/tileset.json`)).json();
  if (m.root.children.length !== 2) throw new Error('合并 children 应为 2，实为 ' + m.root.children.length);
  await page.keyboard.press('Escape');   // 提交自动弹出的日志模态框会遮住表单
  await page.waitForFunction(() => document.querySelector('#logModal').hidden, null, { timeout: 5000 });
  // 再验「选择当前文件夹」（mesh 树模式：原地整目录）
  await page.selectOption('#type', 'mesh');
  await page.click('#fpkSeg button[data-m="path"]');
  await page.click('#fsBrowseBtn');
  await page.waitForSelector('#fsModal .fsItem');
  await page.click(`#fsModal .fsItem:text-is("📁 ${root.name}")`);
  await page.waitForSelector(`.fsItem:text-is("📁 ${FIXNAME}")`);
  await page.click(`.fsItem:text-is("📁 ${FIXNAME}")`);
  await page.waitForSelector('.fsItem:text-is("📁 site")');
  await page.click('.fsItem:text-is("📁 site")');
  await page.waitForSelector('#fsUseDir:not([hidden])');
  await page.click('#fsUseDir');
  const dirVal = await page.inputValue('#inputPath');
  if (!new RegExp(`${reFix}/site$`).test(dirVal)) throw new Error('目录选择回填异常: ' + dirVal);
  fs.rmSync(path.join(FIX, 'site', 'deep', 'cubeB.obj'), { force: true });   // 26b 在 site/ 再放投影夹具
  } finally {
    // FIX 故意保留给 26b 复用（cubeA.obj 是它的模型夹具）；最终清理在 26b 的
    // finally 里做，中途失败则由下一次运行的陈旧清扫兜底
  }
});

/* ---------- 26b. 服务器路径模式：投影文件（proj.prjPath）生效 ---------- */
await step('26b 路径模式投影：浏览选 .prj → proj.prjPath 进 argv；上传附件防呆拦截', async () => {
  const cap = await (await fetch(BASE + '/api/v1/capabilities')).json();
  if (!cap.features?.fsBrowse) skip('服务器未开 MGO_ALLOW_LOCAL_PATH');
  const b0 = await (await fetch(BASE + '/api/v1/fs/browse', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' })).json();
  const root = (b0.roots ?? []).find((r) => r.ok && fs.existsSync(r.path));
  if (!root) skip('无可用允许根');
  const FIX = path.join(root.path, FIXNAME);
  try {
  // 合法 WKT：WGS84 地理坐标 .prj（真实引擎可解析）
  fs.writeFileSync(path.join(FIX, 'site', 'wgs84.prj'),
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,'
    + 'AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,'
    + 'AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,'
    + 'AUTHORITY["EPSG","9122"]],AXIS["Lat",NORTH],AXIS["Lon",EAST],AUTHORITY["EPSG","4326"]]\n');
  await page.goto(BASE + '/console.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('#type');
  await page.selectOption('#type', 'tiles');
  await page.waitForSelector('#fpkSeg');
  await page.click('#fpkSeg button[data-m="path"]');
  // 模型：浏览选 site/cubeA.obj（tiles 多选模式：勾选 → 加入选中 → 关闭）
  await page.click('#fsBrowseBtn');
  await page.waitForSelector('#fsModal .fsItem');
  await page.click(`#fsModal .fsItem:text-is("📁 ${root.name}")`);
  await page.waitForSelector(`.fsItem:text-is("📁 ${FIXNAME}")`);
  await page.click(`.fsItem:text-is("📁 ${FIXNAME}")`);
  await page.waitForSelector('.fsItem:text-is("📁 site")');
  await page.click('.fsItem:text-is("📁 site")');
  await page.waitForSelector('.fsItem:has-text("cubeA.obj")');
  await page.click('.fsItem:has-text("cubeA.obj")');
  await page.click('#fsConfirm');
  await page.click('#fsCloseBtn');
  await page.waitForFunction(() => document.querySelector('#fsModal').hidden);
  if (!/cubeA\.obj$/.test(await page.inputValue('#inputPath')))
    throw new Error('模型选择回填失败: ' + await page.inputValue('#inputPath'));
  // 自动定位：重开浏览应直接进入已有路径值所在目录（site/）
  await page.click('#fsBrowseBtn');
  await page.waitForFunction(() => /site$/.test(document.querySelector('#fsCwd').textContent.trim()), null, { timeout: 5000 });
  await page.click('#fsCloseBtn');
  // 投影行浏览：展开投影组；目标框为空 → 从根导航；只允许 .prj/.wkt/.proj，cubeA.obj 被「只看可选」隐藏
  await page.click('#paramForm details.grp > summary:has-text("投影")');
  await page.click('#paramForm .pathOnly button');
  await page.waitForSelector('#fsModal:not([hidden])');
  await page.click(`#fsModal .fsItem:text-is("📁 ${root.name}")`);
  await page.waitForSelector(`.fsItem:text-is("📁 ${FIXNAME}")`);
  await page.click(`.fsItem:text-is("📁 ${FIXNAME}")`);
  await page.waitForSelector('.fsItem:text-is("📁 site")');
  await page.click('.fsItem:text-is("📁 site")');
  await page.waitForSelector('.fsItem:has-text("wgs84.prj")');
  if (await page.isVisible('.fsItem:has-text("cubeA.obj")')) throw new Error('投影浏览未过滤非投影文件');
  await page.click('.fsItem:has-text("wgs84.prj")');
  await page.waitForFunction(() => document.querySelector('#fsModal').hidden);
  const prjVal = await page.inputValue('#paramForm [data-k="proj.prjPath"]');
  if (!/wgs84\.prj$/.test(prjVal)) throw new Error('prjPath 未回填: ' + prjVal);
  // CRS 文本框被投影文件压制；JSON 预览携带 proj.prjPath、不含 proj.crs
  if (!(await page.isDisabled('#paramForm [data-k="proj.crs"]'))) throw new Error('crs 未被压制');
  const preview = JSON.parse(await page.inputValue('#jsonBox'));
  if (preview.proj?.prjPath !== prjVal || preview.proj?.crs) throw new Error('JSON 预览投影参数不符: ' + JSON.stringify(preview.proj));
  // 防呆①：上传模式选了投影文件 → 切回路径模式应自动清空（不再静默残留）
  await page.click('#fpkSeg button[data-m="upload"]');
  await page.setInputFiles('#paramForm [data-k="@prj"]',
    { name: 'x.prj', mimeType: 'application/octet-stream', buffer: Buffer.from('GEOGCS["x"]') });
  await page.click('#fpkSeg button[data-m="path"]');
  if (await page.evaluate(() => document.querySelector('#paramForm [data-k="@prj"]').files.length))
    throw new Error('切回路径模式后上传附件未清空');
  // 防呆②（守卫兜底）：绕过 UI 直设附件文件 → 提交必须被拦截且不建任务
  const n0 = (await (await fetch(BASE + '/api/v1/jobs?limit=1')).json()).total;
  await page.setInputFiles('#paramForm [data-k="@prj"]',
    { name: 'x.prj', mimeType: 'application/octet-stream', buffer: Buffer.from('GEOGCS["x"]') });
  await page.click('#submit');
  let blocked = false;
  for (let i = 0; i < 10 && !blocked; i++) {
    blocked = /不携带上传附件/.test(await page.textContent('#msg'));
    if (!blocked) await page.waitForTimeout(300);
  }
  const n1 = (await (await fetch(BASE + '/api/v1/jobs?limit=1')).json()).total;
  if (!blocked) throw new Error('投影附件未被拦截，#msg=' + await page.textContent('#msg'));
  if (n1 > n0) throw new Error('拦截提示出现但仍创建了任务');
  await page.setInputFiles('#paramForm [data-k="@prj"]', []);   // 清空注入的附件
  // 防呆①的模式往返按设计清空了 prjPath（离开路径模式即清），重新选回投影文件再提交
  await page.fill('#paramForm [data-k="proj.prjPath"]', prjVal);
  if (!(await page.isDisabled('#paramForm [data-k="proj.crs"]'))) throw new Error('回填后 crs 未再被压制');
  // 正式提交 → 真实引擎成功 + 服务端 params/argv 均带投影文件
  const before27 = new Set((await (await fetch(BASE + '/api/v1/jobs?limit=50')).json()).items.map((x) => x.id));
  await page.click('#submit');
  const id = await waitForNewJob(before27, 'cubeA.obj');
  if (!id) throw new Error('投影路径任务未提交，#msg=' + await page.textContent('#msg'));
  let st = ''; let full = null;
  for (let i2 = 0; i2 < 90; i2++) {
    full = await (await fetch(`${BASE}/api/v1/jobs/${id}`)).json();
    st = full.status;
    if (['succeeded', 'failed', 'usage_error'].includes(st)) break;
    await page.waitForTimeout(2000);
  }
  const argv = (await (await fetch(`${BASE}/api/v1/jobs/${id}/log?tail=100`)).json()).lines
    .filter((l) => l.startsWith('[Service] argv:')).join('\n');
  fs.rmSync(FIX, { recursive: true, force: true });   // 探针夹具用完即清（原地任务已完成）
  if (st !== 'succeeded') throw new Error(`投影任务未成功: ${st} ${JSON.stringify(full?.error ?? {})}`);
  if (!/wgs84\.prj$/.test(full.params?.proj?.prjPath ?? ''))
    throw new Error('服务端 params.proj.prjPath 不符: ' + JSON.stringify(full.params?.proj));
  if (!argv.includes(`--prj ${full.params.proj.prjPath}`))
    throw new Error('argv 未携带 --prj 投影文件:\n' + argv);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#logModal').hidden, null, { timeout: 5000 });
  } finally {
    fs.rmSync(FIX, { recursive: true, force: true });   // 全套件最后一步：无论成败清走夹具根
  }
});

/* ---------- 25. whitelist management page (localhost) ---------- */
  await step('25 白名单管理页：增删条目 → 保存 → 持久化 → 重置', async () => {
    // The step clears + rewrites workspace/whitelist.json.  Only run it when
    // the boot-time snapshot succeeded — otherwise a restore of the empty
    // snapshot would wipe a live deployment's operator-added IPs.
    if (!wlSnapshotOk) skip('启动时未取到白名单快照（服务未就绪/不可达），跳过以免覆盖线上白名单');
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

// safety net even if a step threw mid-flight — but never wipe the live
// whitelist with an empty snapshot just because the boot probe failed
await (wlSnapshotOk ? wlRestore() : Promise.resolve()).catch(() => {});   // eslint-disable-line
await browser.close();
console.log(`\n${passN} pass / ${failN} fail / ${skipN} skip / ${passN + failN + skipN} total`);
process.exit(failN ? 1 : 0);
