/**
 * 参数表单：渲染（BASIC + UI 组）、值收集、校验、JSON 预览与模式/绑定联动。
 * 跨模块协作通过 setFormHooks 注入（openFsBrowser / syncBim），main 负责接线；
 * jsonManual（「以此为准」开关）归本模块所有，submit 经 isJsonManual() 读取。
 */
import { $, el, esc, label } from './dom.js';
import { ICONS, OPT_CN, F, el2, BASIC, UI } from './console-spec.js';
import { fileAccept } from './console-spec.js';
import { openFsBrowser } from './fsbrowser.js';
import { fpk, inputState } from './picker.js';

let hooks = { syncBim: () => {} };
export function setFormHooks(h) { Object.assign(hooks, h); }

/* capabilities 快照由 main 同步进来（applyPathOnly/syncBim 需要 fsBrowse/bimBinding） */
export const formState = { caps: null };

function syncPrjPriority() {
  const p = $('#paramForm').querySelector('[data-k="proj.prjPath"]');
  const c = $('#paramForm').querySelector('[data-k="proj.crs"]');
  if (!p || !c) return;
  const has = p.value.trim() !== '';
  c.disabled = has;
  c.style.opacity = has ? '.45' : '';
  c.title = has ? '已选择投影定义文件，本文本框被忽略（文件优先）' : '';
}

/* ---- pathOnly 字段（如 proj.prjPath）仅在「🖥 服务器路径」模式 + 服务器开启
 * 浏览能力时可见可收集；离开该模式即隐藏并清空，防止残留值打到上传/JSON 通道。
 * 投影文件优先：prjPath 或上传 @prj 有值时禁用 CRS 文本框（镜像服务端
 * prjFile > prjPath > crs 的取舍，同时规避 schema 的 crs|prjPath 二选一 422）。 */
export function applyPathOnly() {
  const on = fpk.picker?.getMode?.() === 'path' && Boolean(formState.caps?.features?.fsBrowse) && !jsonManual;
  for (const n of $('#paramForm').querySelectorAll('.pathOnly')) {
    n.hidden = !on;
    if (!on) {
      const i = n.querySelector('input[type=text]');
      if (i && i.value) i.value = '';
    }
  }
  for (const n of $('#paramForm').querySelectorAll('.uploadOnly')) {
    n.hidden = on;
    if (on) {                                  // 路径/JSON 模式不收附件：直接清掉选择
      const i = n.querySelector('input[type=file]');
      if (i && i.value) i.value = '';
    }
  }
  syncPrjPriority();
  hooks.syncBim();
  syncJson();
}

/* 数值参数校验与范围提示：规则与服务端 zod（schemas.js）一致；
   仅以红框 + 行内提示呈现，不打断输入，服务端校验仍是最终防线 */
function rangeHint(f) {
  const p = [];
  if (f.min != null && f.max != null) p.push(`${f.min} ~ ${f.max}`);
  else if (f.min != null) p.push(`≥ ${f.min}`);
  else if (f.max != null) p.push(`≤ ${f.max}`);
  if (f.pos) p.push('> 0');
  if (f.t === 'int') p.push('整数');
  if (f.odd) p.push('奇数');
  return p.length ? `取值范围：${p.join(' · ')}` : '';
}
export function specError(f, raw) {
  const v = String(raw ?? '').trim();
  if (!v) return '';
  const x = Number(v);
  if (!Number.isFinite(x)) return '请输入数字';
  if (f.t === 'int' && !Number.isInteger(x)) return '需为整数';
  if (f.odd && Math.abs(x) % 2 === 0) return '取值需为奇数 (odd)';
  if (f.min != null && x < f.min) return `不能小于 ${f.min}`;
  if (f.max != null && x > f.max) return `不能大于 ${f.max}`;
  if (f.pos && x <= 0) return '需大于 0';
  return '';
}
function paintField(node) {
  const err = specError(node._f, node.value);
  node.classList.toggle('bad', !!err);
  const h = node._hint;
  if (h) { h.textContent = err || ''; h.classList.toggle('bad', !!err); }
}
function numInput(f, attrs) {
  const s = el('input', { type: 'number', step: f.t === 'int' ? '1' : 'any',
    ...(f.min != null ? { min: f.min } : {}), ...(f.max != null ? { max: f.max } : {}), ...attrs });
  const h = el('div', { class: 'hint' }); /* 平时留空（:empty 隐藏），仅非法时显示红字 */
  s._f = f; s._hint = h;
  s.addEventListener('input', () => paintField(s));
  return [s, h];
}
/* 统一输入提示：控件右侧 ⓘ，悬停显示「用途 → 取值范围 → 留空语义」 */
function tipFor(f) {
  const lines = [];
  if (f.hint) lines.push(f.hint);
  if (f.t === 'num' || f.t === 'int') {
    const r = rangeHint(f);
    if (r) lines.push(r);
    lines.push('留空 = 不传该参数（用 CLI 默认值）');
  } else if (f.t === 'select') lines.push('选「默认（不指定）」= 不传该参数');
  else if (f.t === 'text' || f.t === 'area' || f.t === 'pathtext') lines.push('留空 = 不传该参数');
  return lines.join('\n');
}
const infoIcon = (tip) => el('i', { class: 'info', tabindex: '0', 'data-tip': tip || '暂无说明' }, 'i');
const iw = (node, tip, ta) => el('div', { class: 'iw' + (ta ? ' ta' : '') }, node, infoIcon(tip));
export function fieldNode(f) {
  const id = 'f_' + f.k.replace(/[^a-zA-Z0-9]/g, '_');
  const cls = 'fcell' + (f.span ? ' fspan' : '');
  if (f.t === 'bool') {
    const cb = el('input', { type: 'checkbox', id, 'data-k': f.k, 'data-def': f.def ? '1' : '' });
    if (f.def) cb.checked = true;
    const tail = f.def ? '默认已开启；关闭 = 显式停用' : '勾选 = 开启；不勾 = 不传该参数';
    return el('div', { class: 'chk ' + cls }, cb, el('label', { for: id }, f.label),
      infoIcon([f.hint, tail].filter(Boolean).join('\n')));
  }
  if (f.t === 'select') {
    const s = el('select', { id, 'data-k': f.k }, ...f.opts.map(o => el('option', { value: o },
      o ? (OPT_CN[o] ? `${o} · ${OPT_CN[o]}` : o) : '默认（不指定）')));
    return el('div', { class: cls }, label(f.label), iw(s, tipFor(f)));
  }
  if (f.t === 'num' || f.t === 'int') {
    const [s, h] = numInput(f, { id, 'data-k': f.k, placeholder: f.ph || '' });
    return el('div', { class: cls }, label(f.label), iw(s, tipFor(f)), h);
  }
  if (f.t === 'text') {
    const s = el('input', { type: 'text', id, 'data-k': f.k, placeholder: f.ph || '' });
    return el('div', { class: cls }, label(f.label), iw(s, tipFor(f)));
  }
  if (f.t === 'area') {
    const s = el('textarea', { id, 'data-k': f.k, placeholder: f.ph || 'sx,sy,sz,tx,ty,tz\n12345.6,2345678.9,42.0,445000,3260000,0' });
    return el('div', { class: 'fcell fspan' }, label(f.label), iw(s, tipFor(f), true));
  }
  if (f.t === 'pathtext') {
    // 服务器路径模式专属（.pathOnly 行）：文本框 + 浏览按钮，回填走通用弹框
    const s = el('input', { type: 'text', id, 'data-k': f.k, placeholder: f.ph || '',
      autocomplete: 'off', spellcheck: 'false' });
    const btn = el('button', { type: 'button', class: 'btn', title: `浏览服务器文件（${f.pext}）` }, '📂 浏览…');
    btn.onclick = () => openFsBrowser(null, s, {
      exts: String(f.pext || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
      allowDir: false, multi: false, title: '🖥 ' + f.label,
    });
    s.addEventListener('input', () => { syncPrjPriority(); hooks.syncBim(); });
    const row = el('div', { class: cls + ' pathOnly' }, label(f.label),
      iw(el('div', { class: 'fsRow' }, s, btn), tipFor(f)));
    row.hidden = true;                       // 初始隐藏；applyPathOnly() 按 FilePicker 当前模式放行
    return row;
  }
  if (f.t === 'file') {
    const s = el('input', { type: 'file', id, 'data-k': f.k, accept: f.accept || '' });
    return el('div', { class: cls + (f.uploadOnly ? ' uploadOnly' : '') }, label(f.label),
      iw(s, [f.hint, '不选择 = 不上传'].filter(Boolean).join('\n')));
  }
  if (f.t === 'vec3' || f.t === 'seven') {
    const subs = (f.subs || (f.t === 'vec3' ? ['X', 'Y', 'Z'] : ['mx', 'my', 'mz', 'rx', 'ry', 'rz', 's']))
      .map((x) => (Array.isArray(x) ? x : [x, null]));
    const grid = el('div', { class: 'fgrid' }, ...subs.map(([sb, rng, note], i) => {
      const tip = [f.hint,
        `${sb}${note ? ' — ' + note : ''}${rng ? ' · ' + rangeHint({ t: 'num', ...rng }) : ''}`,
        `整组 ${subs.length} 个值需一次填全，或全部留空`].filter(Boolean).join('\n');
      const cell = [label(sb)];
      if (rng) { const [s, h] = numInput({ t: 'num', ...rng }, { 'data-vec': f.k, 'data-i': i }); cell.push(iw(s, tip), h); }
      else cell.push(iw(el('input', { type: 'number', step: 'any', 'data-vec': f.k, 'data-i': i }), tip));
      return el('div', { class: 'fcell' }, ...cell);
    }));
    return el('div', { class: cls }, label(f.label), grid);
  }
  throw new Error('field type? ' + f.t);
}

/* 悬浮 tip：body 级 fixed 浮层，不受 details overflow 裁剪，视口边缘自动翻转 */
const tipBox = el('div', { id: 'tipBox' });
document.body.append(tipBox);
let tipOwner = null;
function showTip(t) {
  tipBox.textContent = t.dataset.tip || '';
  tipBox.style.display = 'block';
  const r = t.getBoundingClientRect();
  const bw = tipBox.offsetWidth, bh = tipBox.offsetHeight;
  let x = r.left + r.width / 2 - bw / 2;
  x = Math.max(8, Math.min(x, innerWidth - bw - 8));
  let y = r.top - bh - 8;
  if (y < 8) y = Math.min(r.bottom + 8, innerHeight - bh - 8);
  tipBox.style.left = x + 'px'; tipBox.style.top = y + 'px';
}
function hideTip() { tipBox.style.display = 'none'; tipOwner = null; }
document.addEventListener('pointerover', (e) => {
  const t = e.target?.closest?.('.info');
  if (t === tipOwner) return;
  if (t) { tipOwner = t; showTip(t); } else if (tipOwner) hideTip();
});
document.addEventListener('focusin', (e) => {
  const t = e.target?.closest?.('.info');
  if (t) { tipOwner = t; showTip(t); }
});
document.addEventListener('focusout', (e) => { if (e.target?.closest?.('.info')) hideTip(); });
document.addEventListener('pointerdown', (e) => { if (!e.target?.closest?.('.info')) hideTip(); });
addEventListener('scroll', hideTip, true);
addEventListener('resize', hideTip);

export function renderForm(type) {
  const form = $('#paramForm'); form.innerHTML = '';
  const groups = [...(BASIC[type] || []), ...(UI[type] || [])()];
  groups.forEach((g, gi) => {
    const chev = el('span', { class: 'chev' }, '▶');
    const cnt = el('span', { class: 'cnt' }, gi === 0 ? '核心参数' : '可选');
    const body = el('div', { class: 'gbody' }, el('div', { class: 'fgrid' }, ...g.fields.map(fieldNode)));
    form.append(el('details', { class: 'grp', open: gi === 0 || groups.length <= 2 },
      el('summary', {}, chev, g.name, cnt), body));
  });
  for (const inp of form.querySelectorAll('input,select,textarea')) inp.addEventListener('input', syncJson);
  // 属性绑定联动：勾选/属性表变化即时决定其余 bim 控件的可提交性
  for (const inp of form.querySelectorAll('[data-k^="bim."],[data-k="@props"]')) inp.addEventListener('change', () => hooks.syncBim());
  applyPathOnly();
  syncJson();
}

export function getPath(obj, k) { return k.split('.').reduce((o, x) => o?.[x], obj); }
export function setPath(obj, k, v) {
  const parts = k.split('.'); const last = parts.pop();
  let o = obj; for (const p of parts) o = o[p] ??= {};
  o[last] = v;
}

export function collect() {
  const type = $('#type').value;
  const params = { type };
  const files = {};
  for (const node of $('#paramForm').querySelectorAll('[data-k]')) {
    const k = node.dataset.k;
    if (k.startsWith('@')) { if (!node.disabled && node.files?.[0]) files[k.slice(1)] = node.files[0]; continue; }
    if (node.disabled) continue;            // 被投影文件压制的 crs / 未启用的 bim 参数不收集
    if (k === 'proj.prjPath' && fpk.picker?.getMode?.() !== 'path') continue; // 仅路径模式携带
    if (k === 'bim.propsPath' && fpk.picker?.getMode?.() !== 'path') continue;
    if (node.type === 'checkbox') {
      if (k === 'normals') { if (!node.checked) params.normals = false; continue; }
      // mesh -L defaults ON in the CLI, so an explicit false opts out;
      // other types' --lock-border is a bare flag (only forward when checked)
      // NOTE: the field key is simplify.lockBorder — matching plain
      // "lockBorder" here never fired, so unchecking 锁边 could not disable it.
      if (k === 'simplify.lockBorder' && type === 'mesh') { setPath(params, k, node.checked); continue; }
      if (node.checked) setPath(params, k, true);
      continue;
    }
    const v = node.value.trim();
    if (!v) continue;
    if (node.type === 'number') setPath(params, k, Number(v));
    else if (k === 'georef.fitOrder') setPath(params, k, Number(v));
    else setPath(params, k, v);
  }
  for (const [key, n] of [['origin', 3], ['georef.sevenParameter', 7], ['georef.offset', 3], ['enu', 3]]) {
    const nodes = [...$('#paramForm').querySelectorAll(`[data-vec="${key}"]`)];
    if (!nodes.length) continue;
    const vals = nodes.map(x => x.value.trim());
    if (vals.every(x => x !== '')) setPath(params, key, vals.map(Number));
  }
  return { params, files };
}

/* 提交前聚合校验：逐字段标红 + 汇总提示；不合法时不发送请求 */
const VEC_CN = { origin: '坐标原点', enu: 'ENU 参考点', 'georef.sevenParameter': '七参数', 'georef.offset': '投影偏移' };
export function validateForm() {
  const errs = [];
  for (const n of $('#paramForm').querySelectorAll('input[data-k]')) {
    if (!n._f) continue;
    const e = specError(n._f, n.value);
    if (e) { paintField(n); errs.push(`${n.closest('.fcell').querySelector('label').textContent}：${e}`); }
  }
  for (const key of Object.keys(VEC_CN)) {
    const nodes = [...$('#paramForm').querySelectorAll(`[data-vec="${key}"]`)];
    if (!nodes.length) continue;
    const filled = nodes.filter((n) => n.value.trim() !== '').length;
    if (filled && filled < nodes.length) errs.push(`${VEC_CN[key]}：${nodes.length} 个值需填全，或全部留空`);
    for (const n of nodes) {
      if (!n._f) continue;
      const e = specError(n._f, n.value);
      if (e) { paintField(n); errs.push(`${VEC_CN[key]} ${e}`); }
    }
  }
  return [...new Set(errs)];
}

export let jsonManual = false;
export function syncJson() {
  if (jsonManual) return;
  $('#jsonBox').value = JSON.stringify(collect().params, null, 2);
}
/** 退出 JSON 手改模式（还原只读预览 + 按新表单重建 JSON）。切任务类型时
 *  必须重置：否则旧类型的 JSON 残留「以此为准」、提交时还会被强改 type，
 *  造成与新表单不一致的 422。 */
export function exitJsonManual() {
  if (!jsonManual) return;
  jsonManual = false;
  $('#jsonBox').readOnly = true;
  $('#jsonModeLabel').textContent = '预览';
  applyPathOnly();
  syncJson();
}
$('#jsonGrp').querySelector('summary').addEventListener('click', () => {
  jsonManual = !jsonManual;
  $('#jsonBox').readOnly = !jsonManual;
  $('#jsonModeLabel').textContent = jsonManual ? '编辑中 · 以此为准提交' : '预览';
  if (!jsonManual) { try { applyJsonToForm(JSON.parse($('#jsonBox').value)); } catch { /* keep form */ } }
  applyPathOnly();   // JSON 手改模式下 pathOnly 行隐藏（值由 JSON 框接管）
});
export function applyJsonToForm(p) { // best-effort form fill
  for (const node of $('#paramForm').querySelectorAll('[data-k]')) {
    const k = node.dataset.k; if (k.startsWith('@')) continue;
    const v = getPath(p, k);
    // Checkboxes default per the field spec (normals / mesh 锁边 are ON by
    // default; everything else OFF) — JSON round-trip must not flip a default
    // ON control to OFF just because the key is absent.
    if (node.type === 'checkbox') node.checked = v === undefined ? node.dataset.def === '1' : Boolean(v);
    else node.value = v ?? '';
  }
  for (const key of ['origin', 'georef.sevenParameter', 'georef.offset', 'enu']) {
    const arr = getPath(p, key) || [];
    [...$('#paramForm').querySelectorAll(`[data-vec="${key}"]`)].forEach((n, i) => n.value = arr[i] ?? '');
  }
}
