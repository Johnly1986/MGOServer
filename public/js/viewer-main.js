/**
 * Cesium 查看器主脚本。
 * 结构：引擎加载 → Viewer 装配 → 底图 → 在线地形 → 五类图层 loader → 点击拾取属性 → 深链。
 */
import { $, el, esc, copyText } from './dom.js';
import { BASE_MAPS } from './basemaps.js';
import { ONLINE_TERRAINS } from './terrains.js';

/**
 * Cesium base: prefer self-hosted /cesium/ (design §9.1, pinned 1.111),
 * fall back to the official 1.111 CDN when not synced yet.
 */
async function cesiumBaseUrl() {
  try {
    const r = await fetch('/cesium/Cesium.js', { method: 'HEAD' });
    if (r.ok) return '/cesium/';
  } catch { /* offline env without sync → CDN */ }
  return 'https://cesium.com/downloads/cesiumjs/releases/1.111/Build/Cesium/';
}

function loadScript(src) { return new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('failed ' + src)); document.head.append(s); }); }
function loadCss(href) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.append(l); }

const bootText = $('#bootText');
const base = await cesiumBaseUrl();
bootText.textContent = `正在加载 Cesium 引擎（${base.includes('cesium.com') ? 'CDN' : '自托管'}）…`;
loadCss(base + 'Widgets/widgets.css');
await loadScript(base + 'Cesium.js');
const Cesium = window.Cesium;
$('#boot').classList.add('off');

// deep-link 参数：/viewer.html?asset=&type=&basemap=&terrain=（§9.2）
const q = new URLSearchParams(location.search);

/**
 * No ion token / no external services: bare ellipsoid globe. MGO products
 * (terrain / imagery / tiles / geojson) are what this viewer is for.
 */
const viewer = new Cesium.Viewer('cesiumContainer', {
  baseLayer: false,
  baseLayerPicker: false, geocoder: false, homeButton: false, sceneModePicker: false,
  navigationHelpButton: false, animation: false, timeline: false, fullscreenButton: false,
  infoBox: false, selectionIndicator: false,
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
});
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#1d2733');
viewer.scene.globe.showGroundAtmosphere = false;
// 调试/自动化钩子：把 viewer 暴露到 window，便于页面级回归（ui-test.mjs 注入
// 拾取结果验证「点击构件看属性」面板）与二次开发嵌入；不参与业务逻辑。
window.__mgoViewer = viewer;
setStatus(`Cesium ${Cesium.VERSION} 就绪`, 'ok');

function setStatus(text, kind = '') {
  const s = $('#status');
  s.textContent = text;
  s.className = kind;
}

let baseLayer = null;   // current base imagery layer (or null = plain globe)
let baseCredit = '';    // current base imagery attribution

/* ---------------- 在线地形（免费公开全球 quantized-mesh，可关） ----------------
 * terrainProvider 是「地球级」单例，同一时刻只有一个生效。优先级固定：
 * 本地任务地形（layers 中 type==='terrain'） > 在线地形（terrainSel） > 平滑椭球。
 * 本地图层移除后自动回落到所选在线地形（若有），不会把用户选择静默吞掉。 */
let terrainSel = q.get('terrain') || 'none';   // HUD 选择：'none' 或 ONLINE_TERRAINS 键
let onlineTerrain = null;                      // 已就绪的在线地形 { key, provider }

/** Sun-lighting pass is only useful on the plain globe (terrain relief);
 *  when a base imagery layer is active the imagery carries its own shading,
 *  so lighting is switched off to keep tiles bright. */
function syncLighting() {
  const hasTerrain = layers.some((l) => l.type === 'terrain') || terrainSel !== 'none';
  viewer.scene.globe.enableLighting = !baseLayer && hasTerrain;
  if (!baseLayer) {
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString(hasTerrain ? '#3a4a5e' : '#1d2733');
  }
}

/** 归属行 = 底图 + 在线地形（本地任务地形是本服务产物，无外部归属）。 */
function updateCredit() {
  const t = onlineTerrain && !layers.some((l) => l.type === 'terrain')
    ? ONLINE_TERRAINS[onlineTerrain.key]?.credit ?? ''
    : '';
  $('#credit').textContent = [baseCredit, t].filter(Boolean).join(' · ');
}

/** 让 terrainProvider 与上面的优先级保持一致（切换选择 / 移除本地地形时调用）。 */
async function applyTerrain() {
  const globe = viewer.scene.globe;
  if (layers.some((l) => l.type === 'terrain')) {   // 本地任务地形加载时已接管 provider
    globe.depthTestAgainstTerrain = true;
    syncLighting(); updateCredit();
    if (ONLINE_TERRAINS[terrainSel]) setStatus(`已选在线地形：${ONLINE_TERRAINS[terrainSel].label}（待本地地形图层移除后生效）`);
    return;
  }
  const key = terrainSel, src = ONLINE_TERRAINS[key];
  if (!src) {
    onlineTerrain = null;
    viewer.scene.terrainProvider = new Cesium.EllipsoidTerrainProvider();
    globe.depthTestAgainstTerrain = false;
    syncLighting(); updateCredit();
    setStatus('在线地形：无（平滑椭球）');
    return;
  }
  if (onlineTerrain?.key === key) {
    viewer.scene.terrainProvider = onlineTerrain.provider;   // 已就绪，直接切回
  } else {
    setStatus(`加载在线地形：${src.label}…`);
    try {
      // octvertexnormals / watermask 扩展内嵌在 .terrain 瓦片二进制里，
      // 打开解码不产生额外请求（服务端 layer.json 的 extensions 已声明两者）。
      const tp = await Cesium.CesiumTerrainProvider.fromUrl(src.url, {
        requestVertexNormals: true,
        requestWaterMask: true,
      });
      if (terrainSel !== key || layers.some((l) => l.type === 'terrain')) return;   // 等待期间优先级已变
      onlineTerrain = { key, provider: tp };
      viewer.scene.terrainProvider = tp;
    } catch (e) {
      console.error(e);
      setStatus(`在线地形加载失败：${e.message}`, 'err');
      terrainSel = 'none'; $('#terrain').value = 'none';
      return applyTerrain();
    }
  }
  globe.depthTestAgainstTerrain = true;
  syncLighting(); updateCredit();
  setStatus(`在线地形：${src.label}`, 'ok');
}

$('#terrain').addEventListener('change', () => { terrainSel = $('#terrain').value; applyTerrain(); });

function setBaseMap(key) {
  if (baseLayer) { viewer.imageryLayers.remove(baseLayer, true); baseLayer = null; }
  const src = BASE_MAPS[key];
  baseCredit = '';
  if (!src) {
    syncLighting(); updateCredit();
    setStatus('底图：无（纯色地球）');
    return;
  }
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: src.url,
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    maximumLevel: src.max,
  });
  baseLayer = viewer.imageryLayers.addImageryProvider(provider);
  syncLighting();
  baseCredit = src.credit;
  updateCredit();
  setStatus(`底图：${src.label}`);
}
$('#basemap').addEventListener('change', () => setBaseMap($('#basemap').value));

// ---------------- loaders (design §9.2) ----------------
const layers = [];
const LOADERS = {
  '3dtiles': async (url) => {
    const ts = await Cesium.Cesium3DTileset.fromUrl(url, {
      // MGO emits a correct root transform (ENU->ECEF).  Per §9.3 the viewer
      // must NOT wrap it in any additional axis-correction matrix.
    });
    viewer.scene.primitives.add(ts);
    return { name: '3D Tiles', obj: ts, fit: () => viewer.zoomTo(ts) };
  },
  'terrain': async (url) => {
    const dir = url.replace(/\/+$/, '');
    const tp = await Cesium.CesiumTerrainProvider.fromUrl(dir, {
      requestVertexNormals: true,   // MGO encodes OctVertexNormals by default
      requestWaterMask: false,
    });
    viewer.scene.terrainProvider = tp;
    // Camera target: MGO's layer.json carries private-calibrated fields —
    // `bounds` [w,s,e,n] degrees + `available` level ranges (intentionally no
    // standard `availability`; see TerrainLayerJson.cpp 1.111 calibration).
    // NOTE: Rectangle.scale() multiplies radian coords — NOT a center zoom.
    let rect = null;
    try {
      const meta = await (await fetch(dir + '/layer.json')).json();
      if (Array.isArray(meta.bounds) && meta.bounds.length === 4) {
        const [w, s, e, n] = meta.bounds.map(Number);
        const padLon = Math.max((e - w) * 0.6, 0.004);
        const padLat = Math.max((n - s) * 0.6, 0.004);
        rect = Cesium.Rectangle.fromDegrees(w - padLon, s - padLat, e + padLon, n + padLat);
      }
    } catch { /* layer.json unreadable → stay put */ }
    // Bare ellipsoid (no base imagery) renders terrain as one flat baseColor —
    // relief would be literally invisible. Sun-lighting + low-sun clock makes
    // the mesh readable without any external imagery service.
    viewer.scene.globe.depthTestAgainstTerrain = true;
    if (rect) {
      const lonDeg = Cesium.Math.toDegrees((rect.west + rect.east) / 2);
      const d = new Date();
      d.setUTCHours(((((Math.round(8 - lonDeg / 15) % 24) + 24) % 24)), 0, 0, 0);
      viewer.clock.currentTime = Cesium.JulianDate.fromDate(d);
    }
    syncLighting();
    return { name: '地形', obj: tp, fit: () => {
      if (rect) viewer.camera.flyTo({ destination: rect, duration: 1.6 });
    } };
  },
  'imagery': async (url) => {
    // MGO DOM out/ ships tilemapresource.xml; accept dir or explicit xml URL
    const u = url.endsWith('.xml') ? url : url.replace(/\/+$/, '') + '/tilemapresource.xml';
    let ip;
    try { ip = await Cesium.TileMapServiceImageryProvider.fromUrl(u); }
    catch {
      ip = new Cesium.UrlTemplateImageryProvider({ url: url.replace(/\/$/, '') + '/{z}/{x}/{y}.png', tilingScheme: new Cesium.WebMercatorTilingScheme(), maximumLevel: 25 });
    }
    const l = viewer.imageryLayers.addImageryProvider(ip);
    return { name: '影像', obj: l, layer: true, fit: () => viewer.camera.flyTo({ destination: ip.rectangle }) };
  },
  'geojson': async (url) => {
    const ds = await Cesium.GeoJsonDataSource.load(url, { stroke: Cesium.Color.DEEPSKYBLUE, fill: Cesium.Color.DEEPSKYBLUE.withAlpha(0.3), strokeWidth: 3, clampToGround: true });
    viewer.dataSources.add(ds);
    return { name: 'GeoJSON', obj: ds, fit: () => viewer.zoomTo(ds) };
  },
  'model': async (url) => {
    // Local-model preview placement (mesh jobs are not georeferenced):
    // default spot near Hangzhou; override via ?lon=&lat= in the URL.
    const lon = Number(q.get('lon')) || 120.0, lat = Number(q.get('lat')) || 30.0;
    const e = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 50),
      model: { uri: url, scale: 1 },
    });
    viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, lat, 1500), duration: 1 });
    return { name: '模型预览', obj: e, fit: () => viewer.flyTo(e) };
  },
};

async function addLayer(type, url) {
  if (!url) return;
  setStatus('加载中…');
  try {
    const L = await LOADERS[type](url);
    L.url = url; L.type = type;
    layers.push(L);
    // 图层入列后再刷新归属/光照：本地地形此时才算接管 provider（在线地形归属让位）
    updateCredit();
    renderList();
    await L.fit?.();
    setStatus(`已加载: ${L.name}`, 'ok');
    updateBar();
  } catch (e) {
    console.error(e);
    // 模型图层最常见的失败是 glTF 1.0 产物（Cesium ≥1.100 只支持 2.0，报错是
    // "Failed to load model … reading 'buffer'/'extras'" 这类内部异常，用户看不出
    // 所以然）——补一句可操作提示，别让人对着一串堆栈猜。
    const hint = (type === 'model' && /\.(glb|gltf)(\?|$)/i.test(url)
      && /Failed to load model|glTF|reading 'buffer'|reading 'extras'/i.test(String(e?.message ?? '')))
      ? ' — 该模型不是 glTF 2.0（旧版引擎导出的是已废弃的 glTF 1.0，Cesium 无法解析）；请用支持 glTF 2.0 导出的 MGO 引擎重新执行「模型简化」任务'
      : '';
    setStatus(`加载失败 (${type}): ${e.message}${hint}`, 'err');
  }
}

function renderList() {
  const wrap = $('#layerWrap');
  wrap.style.display = layers.length ? '' : 'none';
  $('#layerList').innerHTML = layers.map((l, i) =>
    `<li data-i="${i}" title="点击飞到：${esc(l.url)}">
       <span class="nm">${esc(l.name)}</span>
       <span class="tag2">${l.type}</span>
       <span class="rm" data-rm="${i}" title="移除图层">✕</span>
     </li>`).join('');
  updateBar();
}
function updateBar() { $('#layerCount').textContent = layers.length; }

function removeLayer(i) {
  const l = layers[i];
  closeFeaturePanel();   // 面板里可能正引用被删图层的要素，先关再摘
  if (l.type !== 'terrain') {   // 地形 provider 无处挂载，无需摘除；由 applyTerrain 统一切换
    if (l.layer) viewer.imageryLayers.remove(l.obj, true);
    else if (l.obj && viewer.dataSources.contains(l.obj)) viewer.dataSources.remove(l.obj, true);
    else if (l.obj) { viewer.scene.primitives.remove(l.obj); viewer.entities.remove(l.obj); }
  }
  layers.splice(i, 1);
  // 本地地形摘掉后回落：选了在线地形则切回在线，否则回到平滑椭球
  if (l.type === 'terrain') applyTerrain();
  syncLighting();
  updateCredit();
  renderList();
}

$('#layerList').addEventListener('click', (e) => {
  const rm = e.target?.closest?.('[data-rm]');
  if (rm) { removeLayer(Number(rm.dataset.rm)); return; }
  const i = e.target?.closest?.('li')?.dataset?.i;
  if (i !== undefined) layers[i]?.fit?.();
});

$('#load').onclick = () => addLayer($('#type').value, $('#asset').value.trim());
$('#fit').onclick = () => layers.at(-1)?.fit?.();
$('#clear').onclick = () => { while (layers.length) removeLayer(0); setStatus('已清空全部图层'); };

/* screenshot: grab the drawing buffer inside postRender (before the
   compositor clears it — this is why toDataURL in a click handler fails).
   Retry across a few frames: headless/GPU timing can yield empty buffers. */
$('#shot').onclick = () => {
  let tries = 0;
  const grab = () => {
    tries++;
    let url = null;
    try { url = viewer.scene.canvas.toDataURL('image/png'); } catch { /* buffer unavailable this frame */ }
    if (url && url.length > 1500) {
      const a = document.createElement('a');
      a.href = url;
      a.download = `mgo-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      a.click();
      setStatus('已保存截图', 'ok');
      viewer.scene.postRender.removeEventListener(grab);
      return;
    }
    if (tries >= 40) {
      setStatus('截图失败：未能取得帧缓冲', 'err');
      viewer.scene.postRender.removeEventListener(grab);
    }
  };
  viewer.scene.postRender.addEventListener(grab);
  viewer.scene.requestRender();
};
$('#home').onclick = () => { viewer.camera.flyHome(1.5); setStatus('已复位视角', 'ok'); };
$('#fs').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.();
};

/* coordinate readout */
viewer.screenSpaceEventHandler.setInputAction((movement) => {
  const c = viewer.camera.pickEllipsoid(movement.endPosition, viewer.scene.globe.ellipsoid);
  if (!c) { $('#coord').textContent = ''; return; }
  const g = Cesium.Cartographic.fromCartesian(c);
  const lon = Cesium.Math.toDegrees(g.longitude), lat = Cesium.Math.toDegrees(g.latitude);
  $('#coord').textContent = `经度 ${lon.toFixed(5)}°  纬度 ${lat.toFixed(5)}°`;
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

/* ================ 点击构件查看属性 ================
 * 左键拾取（viewer.scene.pick）：
 *  - 3D Tiles：Cesium 1.111 返回 Cesium3DTileFeature（batch table 即切片时
 *    --bim-* 写入的属性）；同时兼容新版 Cesium 的 {content, properties(PropertyBag)} 形态；
 *  - Entity（GeoJSON 属性 / glb 模型）：读 entity.properties PropertyBag。
 * 选中构件高亮（feature.color），换选/关闭时还原。 */

const featPanel = $('#featPanel'); const featBody = $('#featBody');
const featTitle = $('#featTitle'); const featTag = $('#featTag');
let pickedFeature = null;      // 高亮中的 tile 要素（关闭/换选时还原颜色）
let featJson = null;           // 当前面板对应的属性 JSON（复制用）
const FEAT_HL = Cesium.Color.fromCssColorString('#ffd54d').withAlpha(0.5);

const isTileFeature = (p) => Boolean(p) && p.content
  && typeof p.getPropertyIds === 'function' && typeof p.getProperty === 'function';

function clearFeatureHighlight() {
  if (!pickedFeature) return;
  try { pickedFeature.color = Cesium.Color.WHITE; } catch { /* 图层可能已移除 */ }
  pickedFeature = null;
}
function closeFeaturePanel() {
  clearFeatureHighlight();
  featPanel.hidden = true; featJson = null;
}

const fmtVal = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(6));
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(fmtVal).join(' · ');
  if (typeof v === 'object') {
    if (typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number')
      return `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;   // 向量（法线等）
    try { const s = JSON.stringify(v); return s.length > 200 ? s.slice(0, 197) + '…' : s; } catch { return String(v); }
  }
  return String(v);
};

function propsOfPicked(p) {
  if (!p) return null;
  if (isTileFeature(p)) {                               // Cesium ≤1.11x Cesium3DTileFeature
    let ids = [];
    try { ids = p.getPropertyIds() || []; } catch { /* 无批次表 */ }
    const props = [];
    for (const id of ids) {
      if (id === 'batchId') continue;                   // 单独展示
      let v; try { v = p.getProperty(id); } catch { v = undefined; }
      props.push([id, v]);
    }
    let cls; try { cls = typeof p.getExactClassName === 'function' ? p.getExactClassName() : undefined; } catch {}
    return { props, cls, batchId: p.batchId, kind: '3dtiles' };
  }
  const bag = p.properties;                             // Cesium ≥1.115 PropertyBag 形态
  if (p.content && bag && typeof bag.get === 'function' && typeof bag.keys === 'function') {
    const props = [];
    for (const k of bag.keys()) { let v; try { v = bag.get(k); } catch {} props.push([k, v]); }
    return { props, cls: p.content.metadataClass?.id, batchId: p.batchId, kind: '3dtiles' };
  }
  const ent = p.id instanceof Cesium.Entity ? p.id : null;   // GeoJSON / 模型实体
  if (ent) {
    const props = [];
    const eb = ent.properties;
    // PropertyBag 的公开键名是 propertyNames（PropertyBagKeys 属新版元数据 API）；
    // 退化成 Object.keys(eb) 会把 _propertyNames/_definitionChanged 这类内部字段
    // 当成属性，取值即 Cesium 对象 → 后续 JSON 序列化循环引用报错。
    const keys = eb ? (eb.propertyNames ?? eb.propertyKeys ?? Object.keys(eb)) : [];
    for (const k of keys) {
      if (k.startsWith('_')) continue;                 // 内部字段一律跳过
      const pr = eb[k];
      let v; try { v = pr && typeof pr.getValue === 'function' ? pr.getValue(viewer.clock.currentTime) : pr; } catch { v = String(pr); }
      props.push([k, plainValue(v)]);
    }
    return { props, cls: ent.name || undefined, kind: 'entity' };
  }
  return null;
}

/** 任意取值 → 可安全 JSON 序列化 / 展示的纯值（Cesium 对象降级为字符串）。 */
function plainValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number')
    return `${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}`;
  try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
}

function renderFeature(info) {
  const { props, cls, batchId, kind } = info;
  featTitle.textContent = cls || `构件 #${batchId ?? '—'}`;
  featTag.textContent = kind === '3dtiles' ? `3D Tiles · batchId ${batchId ?? '—'}` : '矢量实体属性';
  featBody.innerHTML = '';
  if (props.length) {
    const tb = el('tbody');
    for (const [k, v] of props) {
      const tr = el('tr');
      tr.append(el('td', { class: 'k' }, k), el('td', { class: 'v' }, fmtVal(v)));
      tb.append(tr);
    }
    featBody.append(el('table', {}, tb));
  } else {
    featBody.append(el('div', { id: 'featEmpty' },
      '该构件没有属性数据 — 模型切片时未开启「属性绑定」。',
      el('br'), '在控制台提交 tiles 任务时勾选「启用属性绑定」或附带属性表 CSV 即可。'));
  }
  // 先亮面板再生成复制用 JSON：序列化异常绝不能把已渲染好的面板留在 hidden 态
  featPanel.hidden = false;
  const obj = {};
  for (const [k, v] of props) obj[k] = plainValue(v);
  if (cls) obj._class = cls;
  if (batchId != null) obj._batchId = batchId;
  try { featJson = JSON.stringify(obj, null, 2); } catch { featJson = String(obj); }
}

const pickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
pickHandler.setInputAction((movement) => {
  let picked = null;
  try { picked = viewer.scene.pick(movement.position); } catch { closeFeaturePanel(); return; }
  const info = propsOfPicked(picked);
  if (!info) { closeFeaturePanel(); return; }
  clearFeatureHighlight();
  if (isTileFeature(picked)) { picked.color = FEAT_HL; pickedFeature = picked; }
  renderFeature(info);
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

$('#featClose').onclick = closeFeaturePanel;
$('#featCopy').onclick = async () => {
  if (!featJson) return;
  const ok = await copyText(featJson);
  setStatus(ok ? '属性 JSON 已复制到剪贴板' : '复制失败：此页面不允许脚本访问剪贴板', ok ? 'ok' : 'err');
};

/* keyboard shortcuts (skip while typing) */
document.addEventListener('keydown', (e) => {
  if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.key === 'Escape' && !featPanel.hidden) { closeFeaturePanel(); return; }
  if (e.key === 'f' || e.key === 'F') layers.at(-1)?.fit?.();
  if (e.key === 'h' || e.key === 'H') $('#home').click();
  if (e.key === 'c' || e.key === 'C') $('#clear').click();
});

// ---------------- deep link: /viewer.html?asset=&type=&basemap=&terrain= ----------------
$('#terrain').value = terrainSel;              // HTML 默认 none → 同步 ?terrain= 深链
setBaseMap(q.get('basemap') || 'esri_img');   // free online imagery by default
if (terrainSel !== 'none') applyTerrain();    // online global terrain on deep link
if (q.get('asset')) {
  $('#type').value = q.get('type') || '3dtiles';
  $('#asset').value = q.get('asset');
  addLayer($('#type').value, q.get('asset'));
} else {
  // no asset → offer succeeded jobs
  fetch('/api/v1/jobs?status=succeeded&limit=20').then(r => r.json()).then(({ items }) => {
    if (!items?.length) return;
    // 此提示是兜底引导，可被底图状态覆盖（既有行为）；但在线地形是异步就绪，
    // 其状态不能反过来被这条晚到的提示吞掉 → 仅在无在线地形状态时显示
    if (!/在线地形：/.test($('#status').textContent)) {
      setStatus('点击任务列表「查看」直接打开，或从下方选择近期成果：');
    }
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="">— 近期成功任务 —</option>' + items.map(j =>
      (j.artifacts || []).filter(a => a.viewer).map(a =>
        `<option value="${a.viewer.type}|${a.viewer.url}" data-id="${j.id}">${j.type} ${j.id.slice(0,8)} · ${a.role}</option>`)
        .join('')).join('');
    sel.onchange = () => { if (!sel.value) return; const [t, u] = sel.value.split('|'); $('#type').value = t; $('#asset').value = u; addLayer(t, u); };
    $('#hud').insertBefore(sel, $('#status'));
  }).catch(() => {});
}
