/**
 * FilePicker 输入区组件（上传 ↔ 服务器路径）+ 文件树选择态。
 * 浏览弹框与表单联动通过 setPickerHooks 注入（main 接线），避免模块间双向 import。
 */
import { $, el, label, fmtKB } from './dom.js';
import { fileAccept } from './console-spec.js';

export const inputState = { caps: null };   // capabilities 快照（main 赋值）

let hooks = { openFsBrowser: () => {} };
export function setPickerHooks(h) { Object.assign(hooks, h); }

/* FilePicker 组件状态：picker=当前实例；treePick=「文件树」选择态
 * （null=普通文件；数组 [{file, rel}] 时 rel 保留目录结构，走 relPaths 通道） */
export const fpk = { picker: null, treePick: null };

/* ============ FilePicker 组件 ================
 * 单一输入控件，内含分段切换（服务器开启本地路径时）：
 *   ⬆ 上传        —— 拖/选 模型文件、模型+贴图 ZIP、整个文件夹（树通道）
 *   🖥 服务器路径  —— 手填 + 只读目录浏览点选（原地处理，不上传不搬动）
 * 默认段即「🖥 服务器路径」（可用时）：控制台主场景是服务器侧数据原地转换。
 * 可用性按客户端判定：本机 127.0.0.1/::1 访问恒可用；远程访问需服务器开启
 * MGO_ALLOW_LOCAL_PATH，未开启时路径段置灰 + tooltip 说明开启方式。
 * OSGB 与 tiles/mesh 共用本组件。
 */
export function renderInputArea(type) {
  const area = $('#inputArea'); area.innerHTML = '';
  fpk.treePick = null;
  fpk.picker = createFilePicker(type);
  area.append(label(type === 'osgb' ? 'OSGB 数据（文件夹 / ZIP）' : '输入'), fpk.picker);
  // tiles 走「自动全选」：文件夹/ZIP 内所有模型统一参数逐个转换后合并，无需手填模型路径；
  // 仅 mesh（单模型语义、多候选会歧义）保留可选的模型路径消歧框。
  if (type === 'mesh') {
    area.append(label('模型路径（ZIP / 文件夹内；可留空自动识别）'));
    area.append(el('input', { type: 'text', id: 'modelPaths', placeholder: '如 site/model.fbx' }));
  }
}
function createFilePicker(type) {
  const allowPath = Boolean(inputState.caps?.features?.localPathInput);
  const osgb = type === 'osgb';
  const treeMode = osgb || type === 'tiles' || type === 'mesh';
  const multi = type === 'tiles';
  fpk.treePick = null;
  const root = el('div', { class: 'fpk' });

  /* ---- 上传模式 ---- */
  const accept = osgb ? '.zip' : fileAccept(type) + ((type === 'tiles' || type === 'mesh') ? ',.zip' : '');
  const drop = el('div', { class: 'drop' },
    el('input', { type: 'file', id: 'file', accept, multiple: multi }),
    el('div', { class: 'dropInner' },
      el('span', { class: 'ic' }, '🗂'),
      el('span', { class: 'txt' }, osgb ? '点击/拖入 OSGB 文件夹，或 ZIP 压缩包'
        : multi ? '拖入 模型文件（可多选）· 模型+贴图 ZIP · 或整个文件夹'
        : type === 'mesh' ? '拖入 模型文件 · 模型+贴图 ZIP · 或整个文件夹'
        : '点击选择或拖拽文件到此处'),
      treeMode ? 
        el('span', { class: 'txt', style: 'font-size:11.5px' },
        el('span', {}, '点击', 
        el('a', { href: '#', id: 'dirPickLink', class: 'dirLink' }, '点这里选文件夹'), '')) : null,
        el('span', { class: 'meta', id: 'dropMeta' }, '')));
  const fi = drop.querySelector('#file');
  fi.onchange = () => {
    fpk.treePick = null; updateDrop();
    if (osgb && fi.files?.length && !/\.zip$/i.test(fi.files[0].name)) {
      $('#dropMeta').textContent = '⚠ OSGB 只支持文件夹或 .zip 压缩包，请重选';
    }
  };
  const upPane = el('div', {}, drop);
  if (treeMode) {
    const dp = el('input', { type: 'file', id: 'dirPick', hidden: '' });
    dp.webkitdirectory = true; dp.multiple = true;
    dp.onchange = () => {
      fpk.treePick = [...(dp.files ?? [])].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));
      if (fpk.treePick.length) fi.value = '';
      updateDrop();
    };
    upPane.append(dp);
    const dl = drop.querySelector('#dirPickLink');
    if (dl) dl.onclick = (e) => { e.preventDefault(); e.stopPropagation(); dp.click(); };
  }
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('drag');
    const entries = [...(e.dataTransfer?.items ?? [])]
      .map((it) => (it.kind === 'file' ? it.webkitGetAsEntry?.() : null)).filter(Boolean);
    if (treeMode && entries.some((en) => en.isDirectory)) {
      // 文件夹进入树模式：递归收集（含子目录贴图），rel 保留树结构
      (async () => {
        const picked = [];
        for (const en of entries) await walkEntry(en, '', picked);
        fpk.treePick = picked; fi.value = ''; updateDrop();
      })();
      return;
    }
    const fs = multi ? [...(e.dataTransfer?.files ?? [])] : [...(e.dataTransfer?.files ?? [])].slice(0, 1);
    if (fs.length) {
      fpk.treePick = null;
      try { const dt = new DataTransfer(); fs.forEach((f) => dt.items.add(f)); fi.files = dt.files; } catch { /* fallback */ }
      updateDrop();
    }
  });

  /* ---- 服务器路径模式 ---- */
  const pathInput = el('input', { type: 'text', id: 'inputPath',
    placeholder: osgb ? '/data/osgb_root/Data（目录）'
      : type === 'tiles' ? '/data/models/ 或 /data/a.fbx, /data/b.obj（逗号分隔）'
      : '/data/models/x.fbx' });
  const browseBtn = el('button', { type: 'button', class: 'btn', id: 'fsBrowseBtn' }, '📂 浏览…');
  browseBtn.onclick = () => hooks.openFsBrowser(type, pathInput);
  const pathPane = el('div', { hidden: '' },
    el('div', { class: 'fsRow' }, pathInput, allowPath ? browseBtn : null),
    el('div', { class: 'hint' }, osgb ? 'OSGB 整目录原地处理（不上传、不搬动文件）'
      : type === 'tiles' ? '可直接填模型文件夹或逗号分隔多个模型文件'
      : type === 'mesh' ? '可直接填文件夹'
      : '服务器本地路径，免上传、原地处理'));

  /* ---- 模式切换 ---- */
  // 默认段：路径模式可用（本机访问恒可用，或服务器开启 MGO_ALLOW_LOCAL_PATH）
  // 时直接落在「🖥 服务器路径」；仅上传可达时才回落到「⬆ 上传」。
  let mode = allowPath ? 'path' : 'upload';
  let seg = null;
  const setMode = (m) => {
    mode = m;
    upPane.hidden = m !== 'upload';
    pathPane.hidden = m !== 'path';
    if (seg) for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.m === m);
    document.dispatchEvent(new CustomEvent('fpk-mode', { detail: { mode: m } }));
  };
  // 切换段恒在：路径模式对该客户端不可用时，路径段置灰并以 tooltip 说明开启方式
  seg = el('div', { class: 'fpkSeg', id: 'fpkSeg' },
    allowPath
      ? el('button', { type: 'button', 'data-m': 'path', onclick: () => setMode('path') }, '🖥 服务器路径')
      : el('button', { type: 'button', 'data-m': 'path', disabled: '', title: '无权访问服务器文件' }, '🖥 服务器路径'),
      el('button', { type: 'button', 'data-m': 'upload', onclick: () => setMode('upload') }, '⬆ 上传')
      );
  root.append(seg);
  root.append(upPane, pathPane);
  setMode(mode);   // 初始段高亮 + 面板可见性（默认即「服务器路径」，若可用）
  root.getMode = () => mode;
  return root;
}

/* FilePicker 组件状态：picker=当前实例；treePick=「文件树」选择态
 * （null=普通文件；数组 [{file, rel}] 时 rel 保留目录结构，走 relPaths 通道） */
async function walkEntry(entry, prefix, out) {
  if (!entry) return;
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file: f, rel: prefix + entry.name });
  } else if (entry.isDirectory) {
    const rd = entry.createReader();
    let all = []; let batch;
    do { batch = await new Promise((res) => rd.readEntries(res, () => res([]))); all = all.concat(batch); } while (batch.length);
    for (const ch of all) await walkEntry(ch, prefix + entry.name + '/', out);
  }
}
export function updateDrop() {
  const meta = $('#dropMeta');
  if (!meta) return;
  const size = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  if (fpk.treePick?.length) {
    const total = fpk.treePick.reduce((s, t) => s + t.file.size, 0);
    const top = String(fpk.treePick[0].rel).split('/')[0];
    meta.textContent = `🗂 ${top}/ · ${fpk.treePick.length} 个文件 · ${size(total)}（树结构保留，贴图可解析）`;
    return;
  }
  const fi = $('#file');
  const fs = fi && fi.files ? [...fi.files] : [];
  if (!fs.length) { meta.textContent = ''; return; }
  if (fs.length === 1) {
    meta.textContent = /\.zip$/i.test(fs[0].name)
      ? `${fs[0].name} · ${size(fs[0].size)}（ZIP 文件树）`
      : `${fs[0].name} · ${size(fs[0].size)}`;
    return;
  }
  const total = fs.reduce((s, f) => s + f.size, 0);
  const shown = fs.slice(0, 3).map((f) => f.name).join('、');
  meta.textContent = `${fs.length} 个文件 · ${size(total)}（${shown}${fs.length > 3 ? '…' : ''}）`;
}
