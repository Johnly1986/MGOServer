/**
 * 服务器目录浏览选径弹框（只读；受 MGO_ALLOWED_ROOTS + 白名单 IP 约束）。
 * 通用选择弹框（输入文件 / 投影 side-car / 属性表 / 整目录共用），由 main 接线打开。
 */
import { $, el, esc, fmtKB, toggleModalChrome } from './dom.js';
import { fileAccept } from './console-spec.js';

/* ---- 服务器目录浏览选径（只读；受 MGO_ALLOWED_ROOTS + 白名单 IP 约束） ----
 * 通用选择弹框（输入文件 / 投影 side-car / 整目录共用）。
 * sel 存【绝对路径】：旧版存裸文件名、确认时按当时的 cwd 拼接——进入子目录
 * 再「加入选中」会拼出错误路径，且同名文件跨目录误高亮。现在选择跨目录
 * 保留、路径即所见即所得。 */
export const fsState = { cwd: null, last: null, req: '', sel: [], multi: false, allowDir: false,
  exts: [], filter: '', onlyOk: true, input: null, loading: false, err: null, errReq: null,
  wildcard: false };
export const fsExtOf = (name) => { const m = /\.([A-Za-z0-9]+)$/.exec(name); return m ? '.' + m[1].toLowerCase() : ''; };
/**
 * 目标输入框中【已选/已加入】的绝对路径集合。多选模式下这些条目在列表中
 * 置灰禁选（划掉 + 「已选」标签），防止重复选中；「✕ 移除所选」或手改
 * 路径框后即时恢复。需每次渲染现算：路径框随时可能被外部清空/编辑。
 */
export function fsUsed() {
  const set = new Set();
  for (const s of String(fsState.input?.value || '').split(/[,\n]/)) { const t = s.trim(); if (t) set.add(t); }
  return set;
}
export async function fsBrowse(p) {
  const r = await fetch('/api/v1/fs/browse', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  return j;
}
/**
 * 打开浏览弹框。type 推导默认策略；opts 可整体覆盖：
 * {exts, allowDir, multi, title, start}。投影行传
 * {exts:['.prj','.wkt','.proj'], allowDir:false, multi:false}。
 */
export function openFsBrowser(type, inputEl, opts = {}) {
  fsState.input = inputEl; fsState.sel = []; fsState.last = null;
  fsState.multi = opts.multi ?? (type === 'tiles');           // tiles 可逗号多选多个模型文件
  fsState.allowDir = opts.allowDir ?? (type === 'osgb' || type === 'tiles' || type === 'mesh'); // 可选整目录（树模式）
  // NOTE: server-path browse lists model FILES / FOLDERS only — no .zip.  ZIP
  // is an upload-channel input (server extracts it); a server-side path to a
  // .zip is rejected by the API as an unknown extension, so offering it here
  // (旧版把上传 accept 的 .zip 混进来) 只会让用户选了又提交失败。
  fsState.exts = opts.exts ?? ((type === 'osgb' || type == null) ? []
    : fileAccept(type).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  fsState.filter = ''; fsState.onlyOk = true; fsState.err = null;
  $('#fsFilter').value = '';
  $('#fsOnlyOk').checked = true;
  $('#fsOnlyWrap').hidden = !fsState.exts.length;
  $('#fsTitle').textContent = opts.title || '🖥 选择服务器文件';
  fsState.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $('#fsModal').hidden = false;
  toggleModalChrome(true, $('#fsModal'));
  $('#fsDialog').focus();
  // 初始定位：目标输入框已有路径时先进它的所在目录（失败静默回落根列表）
  const cur = String(inputEl?.value || '').split(',').map((s) => s.trim()).filter(Boolean).pop() || '';
  const dir0 = cur.replace(/[\\/]+[^\\/]*$/, '');
  if (opts.start || dir0) fsLoad(opts.start || dir0, { quiet: true });
  else fsLoad('');
}
export function fsClose() {
  $('#fsModal').hidden = true;
  toggleModalChrome(false, $('#fsModal'));   // 解锁滚动 + 恢复背景可交互
  fsState.returnFocus?.focus?.();            // 焦点回到打开浏览器的按钮
  fsState.returnFocus = null;
}
export function fsJoin(base, name) {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base.replace(/[\\/]+$/, '') + sep + name;
}
export async function fsLoad(p, { quiet = false } = {}) {
  fsState.req = p; fsState.loading = true; fsState.err = null;
  fsRender();
  try {
    const d = await fsBrowse(p);
    fsState.loading = false;
    fsState.last = d; fsState.cwd = d.cwd; fsState.wildcard = Boolean(d.wildcard);
    fsRender();
  } catch (e) {
    fsState.loading = false;
    if (quiet) { fsLoad('', {}); return; }        // 自动定位失败不算错：回落根列表
    fsState.err = String(e?.message ?? e); fsState.errReq = p;
    fsState.last = null; fsState.cwd = null;
    fsRender();
  }
}
export function fsRender() {
  const list = $('#fsList'); const crumbs = $('#fsCrumbs');
  list.innerHTML = ''; crumbs.innerHTML = ''; crumbs.hidden = true;
  const st = $('#fsCwd');

  if (fsState.loading) {
    st.textContent = '⏳ 加载中…';
    list.append(el('div', { class: 'fsEmpty' }, '加载中…'));
    $('#fsUseDir').hidden = true; $('#fsConfirm').hidden = true; $('#fsClear').hidden = true;
    return;
  }
  if (!fsState.last) {
    st.textContent = fsState.err ? '✗ ' + fsState.err
      : fsState.wildcard ? '整个文件系统（MGO_ALLOWED_ROOTS=*）' : '允许的根目录（MGO_ALLOWED_ROOTS）';
    if (fsState.err) {
      list.append(
        el('button', { class: 'fsItem', onclick: () => fsLoad(fsState.errReq ?? '') }, '↻ 重试本目录'),
        el('button', { class: 'fsItem', onclick: () => fsLoad('') }, '🏠 回到根目录'));
    }
    $('#fsUseDir').hidden = true; $('#fsConfirm').hidden = true; $('#fsClear').hidden = true;
    $('#fsHint').textContent = '';
    return;
  }
  const d = fsState.last;
  const inDir = Boolean(d.cwd);
  st.textContent = inDir ? d.cwd
    : d.wildcard ? '整个文件系统（MGO_ALLOWED_ROOTS=*）' : '允许的根目录（MGO_ALLOWED_ROOTS）';
  st.title = inDir ? d.cwd : '';
  $('#fsUseDir').hidden = !(fsState.allowDir && inDir);
  // 多选下当前目录已整体加入过 → 按钮置灰，避免重复选择
  const dirUsed = inDir && fsState.multi && fsState.input?.value
    && String(fsState.input.value).split(/[,\n]/).map((s) => s.trim()).includes(d.cwd);
  $('#fsUseDir').disabled = Boolean(dirUsed);
  $('#fsUseDir').title = dirUsed ? '当前目录已填入路径框，如需重选请先清空或修改路径框' : '';

  // ---- 面包屑：最长匹配根 + 可点分段（当前段置灰样式） ----
  // 根本身可能自带分隔符（通配模式：POSIX 的 '/'、Windows 的 'C:\'），先按
  // 自带分隔符整体前缀匹配，再退回「根 + 分隔符」拼接匹配。
  if (inDir && (d.roots ?? []).length) {
    let root = null;
    for (const r of d.roots) {
      if (!r.ok) continue;
      const base = /[\\/]$/.test(r.path) ? r.path : null;
      if (d.cwd === r.path || (base && d.cwd.startsWith(base))
        || d.cwd.startsWith(r.path + '/') || d.cwd.startsWith(r.path + '\\')) {
        if (!root || r.path.length > root.path.length) root = r;
      }
    }
    if (root) {
      crumbs.hidden = false;
      crumbs.append(el('button', { onclick: () => fsLoad(''), title: '根目录列表' }, '🏠 ' + root.name));
      let acc = root.path;
      for (const sg of d.cwd.slice(root.path.length).split(/[\\/]+/).filter(Boolean)) {
        acc = fsJoin(acc, sg);
        crumbs.append(el('span', { class: 'sep' }, '/'));
        const p = acc;
        crumbs.append(el('button', { onclick: () => fsLoad(p), title: p }, sg));
      }
      const bs = crumbs.querySelectorAll('button');
      bs[bs.length - 1]?.classList.add('cur');
    }
  }

  if (!inDir) {
    for (const r of d.roots ?? []) {
      list.append(el('button', { class: 'fsItem', disabled: r.ok ? null : '', title: r.path,
        onclick: () => { if (r.ok) fsLoad(r.path); } },
        (r.ok ? '📁 ' : '🚫 ') + r.name + (r.ok ? '' : '（不存在）')));
    }
    // 空态提示：请求成功但没有任何可浏览根目录时不许无声空白——那会被当成
    // 「弹框坏了」。通配模式正常必有盘符/'/'；走到这里只可能是极端环境
    // （如 Windows 一个可用盘符都没有）。显式模式则对应两类配置错误：
    // ① MGO_ALLOWED_ROOTS 根本没配到路径；② 配了但路径在服务器上不存在
    //   （.env 从 Linux 拷贝 / POSIX 的 ':' 分隔习惯在 Windows 失效）。
    if (!list.children.length) {
      list.append(el('div', { class: 'fsEmpty' },
        d.wildcard ? '未找到可浏览的盘符/根目录'
          : '未配置 MGO_ALLOWED_ROOTS（未配置本应是全盘通配模式）——请检查 .env 是否被命令行参数覆盖',
        el('div', { style: 'margin-top:6px;font-size:12px;color:#93a0b4' },
          '显式限定的配置示例（Windows 用分号分隔，路径需真实存在）：MGO_ALLOWED_ROOTS=D:\\data;E:\\prj')));
    } else if (!(d.roots ?? []).some((r) => r.ok)) {
      list.append(el('div', { class: 'fsEmpty' },
        '配置的根目录在服务器上都不存在（路径写错，或 .env 从别的系统拷贝而来）',
        el('div', { style: 'margin-top:6px;font-size:12px;color:#93a0b4' },
          'Windows 示例：MGO_ALLOWED_ROOTS=D:\\data;E:\\prj（分号分隔，不能用 Linux 的冒号）；改完重启服务')));
    }
  } else {
    const q = fsState.filter.trim().toLowerCase();
    if (d.parent) list.append(el('button', { class: 'fsItem', onclick: () => fsLoad(d.parent) },
      '⬆ ..', el('span', { class: 'sz' }, '上级目录')));
    for (const name of (d.dirs ?? []).filter((n) => !q || n.toLowerCase().includes(q))) {
      list.append(el('button', { class: 'fsItem', title: fsJoin(d.cwd, name),
        onclick: () => fsLoad(fsJoin(d.cwd, name)) }, '📁 ' + name));
    }
    let files = d.files ?? [];
    if (q) files = files.filter((f) => f.name.toLowerCase().includes(q));
    const okExt = (f) => fsState.exts.length > 0 && fsState.exts.includes(fsExtOf(f.name));
    let hiddenN = 0;
    if (fsState.onlyOk && fsState.exts.length) {
      const before = files.length;
      files = files.filter(okExt);
      hiddenN = before - files.length;
    }
    const used = fsState.multi ? fsUsed() : null;   // 已加入目标路径框的条目 → 禁选
    for (const f of files) {
      const ok = okExt(f);
      const full = fsJoin(d.cwd, f.name);
      const u = used?.has(full);
      list.append(el('button', { class: 'fsItem' + (u ? ' used' : fsState.sel.includes(full) ? ' sel' : ''),
        disabled: ok && !u ? null : '', title: u ? full + '（已填入路径框，如需重选请先在输入框中删除）' : full,
        onclick: () => fsSel(full) },
      '📄 ' + f.name, el('span', { class: 'sz' }, u ? '已选' : fmtKB(f.size))));
    }
    if (!list.children.length) {
      list.append(el('div', { class: 'fsEmpty' },
        q ? `没有匹配「${fsState.filter.trim()}」的条目` : '空目录'));
    } else if (hiddenN) {
      list.append(el('div', { class: 'fsEmpty', style: 'padding:8px 12px;text-align:left' },
        `已隐藏 ${hiddenN} 个不可选项（取消「只看可选」查看）`));
    }
    if (d.truncated) {
      list.append(el('div', { class: 'fsEmpty', style: 'padding:8px 12px;text-align:left' },
        '条目过多，已截断显示（可用上方过滤框缩小范围）'));
    }
  }
  $('#fsSelN').textContent = String(fsState.sel.length);
  $('#fsConfirm').hidden = !(fsState.multi && fsState.sel.length);
  $('#fsClear').hidden = !fsState.sel.length;
  const usedN = fsState.multi ? fsUsed().size : 0;
  $('#fsHint').textContent = fsState.multi
    ? (fsState.sel.length ? `已选 ${fsState.sel.length} 个（跨目录保留）` : '可点选多个文件，再「加入选中」')
      + (usedN ? ` · 路径框已含 ${usedN} 项（列表中置灰不可重复选）` : '')
    : (fsState.exts.length ? '点击文件即选中'
      : (fsState.allowDir ? '该输入只接受文件夹——进入目标目录后点「📂 选择当前文件夹」' : ''));
}
export function fsSel(full) {
  if (fsState.multi) {
    if (fsUsed().has(full)) return;                       // 已加入 → 不可再选（防御）
    const i2 = fsState.sel.indexOf(full);
    if (i2 >= 0) fsState.sel.splice(i2, 1); else fsState.sel.push(full);
    fsRender();
  } else {
    fsWrite([full], true);                                 // 单选：即选即填并关闭
  }
}
export function fsWrite(items, replace, close = true) {
  const input = fsState.input; if (!input) return;
  const cur = replace ? [] : String(input.value || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of items) if (p && !cur.includes(p)) cur.push(p);
  input.value = cur.join(', ');
  input.dispatchEvent(new Event('input', { bubbles: true }));  // JSON 预览 / 投影优先联动即时刷新
  if (close) fsClose();
}
