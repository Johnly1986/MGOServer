/**
 * 控制台入口：capabilities 探测 → 模块接线（hooks/deps/共享状态）→ 表单与列表初始化。
 * 页面级事件（Esc / Tab 焦点圈 / 弹框按钮）也在这里统一装配。
 */
import { $, el, esc, copyText } from './dom.js';
import { ICONS, DESC, TYPE_CN } from './console-spec.js';
import { toast } from './toast.js';
import { inputState, renderInputArea, setPickerHooks, fpk } from './picker.js';
import { openFsBrowser, fsState, fsClose, fsRender, fsWrite } from './fsbrowser.js';
import * as form from './form.js';
import * as jobs from './jobs.js';
import { submitJob, setSubmitDeps } from './submit.js';

/* ---- capabilities / 提示 ---- */
export let caps = null;
const ipNote = () => {
  const n = $('#ipNote');
  if (!n || !caps?.client) return;
  const { ip, allowed } = caps.client;
  n.innerHTML = allowed
    ? `🟢 IP <b>${esc(ip)}</b> `
    : `🔴 IP <b>${esc(ip)}</b> 未在白名单，提交会被拒绝（可在白名单页添加）`;
};
const showMsg = (text, kind) => {
  const m = $('#msg');
  m.textContent = text;
  m.className = kind || '';
  m.style.display = text ? 'block' : 'none';
};

/* ---- 接线：跨模块回调与共享状态 ---- */
setPickerHooks({ openFsBrowser });
form.setFormHooks({ syncBim: () => syncBim() });
jobs.setJobsHooks({});
setSubmitDeps({
  collect: form.collect, validateForm: form.validateForm, showMsg,
  isJsonManual: () => form.jsonManual, jsonBoxValue: () => $('#jsonBox').value,
  exitJsonManual: form.exitJsonManual, applyPathOnly: form.applyPathOnly, syncJson: form.syncJson,
  getPicker: () => fpk.picker, getTreePick: () => fpk.treePick,
  addJobRow: jobs.addJobRow,
  openLog: jobs.openLog, loadJobs: jobs.loadJobs,
});

/* 属性绑定联动（需要读 capabilities 与 JSON 预览，放这里避免循环 import） */
const BIM_DEPS = ['bim.idProperty', 'bim.strategy', 'bim.noSceneMeta', 'bim.noInherit', 'bim.report'];
function syncBim() {
  const formEl = $('#paramForm');
  const bind = formEl.querySelector('[data-k="bim.bind"]');
  if (!bind) return;                                    // 非 tiles 表单
  const propsFile = formEl.querySelector('[data-k="@props"]');
  const propsPath = formEl.querySelector('[data-k="bim.propsPath"]');
  const engineOff = caps && caps.features && caps.features.bimBinding === false;
  const hasProps = Boolean(propsFile?.files?.length) || Boolean(propsPath?.value.trim());
  if (hasProps && !bind.checked) bind.checked = true;   // 属性表隐含绑定
  const on = !engineOff && (bind.checked || hasProps);
  bind.disabled = Boolean(engineOff);
  bind.closest('.chk')?.classList?.toggle('dim', Boolean(engineOff));
  if (propsFile) propsFile.disabled = Boolean(engineOff);
  if (propsPath) propsPath.disabled = Boolean(engineOff);
  for (const k of BIM_DEPS) {
    const n = formEl.querySelector(`[data-k="${k}"]`);
    if (!n) continue;
    n.disabled = !on;
    const cell = n.closest('.fcell') || n.closest('.chk');
    if (cell) cell.style.opacity = on ? '' : '.45';
  }
  let note = formEl.querySelector('#bimCapNote');
  if (engineOff) {
    if (!note) {
      note = el('div', { class: 'hint bad', id: 'bimCapNote' },
        '⚠ 当前服务器的 MGO 引擎不支持属性绑定（缺少 --bim-* 参数），本组参数不可用——请升级引擎二进制');
      formEl.querySelectorAll('details.grp > .gbody').forEach((b) => {
        if (b.parentElement.querySelector('summary')?.textContent.includes('属性绑定')) b.prepend(note);
      });
    }
  } else if (note) note.remove();
  // 程序化勾选不会触发 input 事件：显式刷新 JSON 预览，保证「所选即所提交」
  form.syncJson();
}


/* ---- 浏览弹框按钮接线（fsModal 的行为在 fsbrowser，DOM 装配在这里） ---- */
$('#fsMask').onclick = fsClose;
$('#fsCloseBtn').onclick = fsClose;
$('#fsUseDir').onclick = () => {
  if (!fsState.cwd) return;
  const had = String(fsState.input?.value || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
  fsWrite([fsState.cwd], true);
  // 多选模式下此按钮整目录替换路径框——旧版静默丢弃已加入的文件选择
  if (fsState.multi && had.length && !(had.length === 1 && had[0] === fsState.cwd))
    toast(`已选当前文件夹（替换原有 ${had.length} 项）`, 'info', 3200);
};
$('#fsConfirm').onclick = () => {                    // 加入选中：回填后弹框保持打开，可跨目录续选
  const n = fsState.sel.length; if (!n) return;
  fsWrite(fsState.sel.slice(), false, false);
  fsState.sel = [];
  fsRender();
  toast(`已加入 ${n} 个路径`, 'ok', 2200);
};
$('#fsClear').onclick = () => { fsState.sel = []; fsRender(); };
$('#fsFilter').addEventListener('input', (e) => { fsState.filter = e.target.value; fsRender(); });
$('#fsOnlyOk').addEventListener('change', (e) => { fsState.onlyOk = e.target.checked; fsRender(); });

document.addEventListener('keydown', (e) => {     // Esc 全局兜底（焦点在弹框内任何位置都关得掉）
  const fsOpen = !$('#fsModal').hidden;
  if (e.key === 'Escape' && fsOpen) { e.preventDefault(); fsClose(); return; }
  if (e.key === 'Escape' && jobs.logOpen()) { e.preventDefault(); jobs.closeLog(); }
  if (fsOpen && e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? '')) {
    e.preventDefault(); $('#fsFilter').focus();    // '/' 快速进入过滤
  }
});
$('#fsList').addEventListener('keydown', (e) => {  // ↑/↓/Home/End 在可用条目间移动焦点，Enter=点击
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...$('#fsList').querySelectorAll('.fsItem:not([disabled])')];
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement);
  const n = e.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(items.length - 1, i + 1))
    : e.key === 'ArrowUp' ? Math.max(0, i - 1)
    : e.key === 'Home' ? 0 : items.length - 1;
  items[n].focus();
});
{   // 两个模态框同款 Tab 焦点圈
  for (const dlg of [$('#logDialog'), $('#fsDialog')]) {
    dlg.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const f = [...dlg.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((n) => !n.disabled && n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
}

/* ---- 类型切换与启动 ---- */
$('#type').append(...['tiles', 'terrain', 'image', 'geojson', 'mesh', 'osgb']
  .map(t => el('option', { value: t }, `${ICONS[t]} ${t} · ${TYPE_CN[t]}`)));
$('#type').onchange = () => {
  const t = $('#type').value;
  $('#typeDesc').textContent = DESC[t];
  form.exitJsonManual();   // JSON 手改内容属于旧类型，切换后不得再「以此为准」
  renderInputArea(t); form.renderForm(t);
};
async function probeCaps() {
  const pill = $('#health');
  try {
    caps = await (await fetch('/api/v1/capabilities')).json();
    inputState.caps = caps; form.formState.caps = caps;
    pill.classList.remove('offline'); pill.classList.add('online');
    pill.innerHTML = `<i></i><span class="hide-sm">在线 · </span><span>${caps.jobTypes.length} 种任务类型</span>`;
    if (!caps.features.osgb) $('#type').querySelector('[value=osgb]')?.remove();
    if (caps.client?.canManageWhitelist) $('#wlLink').style.display = '';
    ipNote();
    return true;
  } catch {
    caps = null; inputState.caps = null; form.formState.caps = null;
    const n = $('#ipNote');
    if (n && !n.innerHTML.includes('IP <b')) n.textContent = 'IP 授权状态未知（服务不可达）';
    pill.classList.remove('online'); pill.classList.add('offline');
    pill.innerHTML = '<i></i><span>服务不可达，自动重试…</span>';
    return false;
  }
}
document.addEventListener('fpk-mode', form.applyPathOnly);
await probeCaps();
$('#type').value = 'tiles';
$('#type').onchange();
await jobs.loadJobs();
setInterval(async () => {
  // 每轮都探测健康：loadJobs 的失败被静默吞掉，不能据它判断在线
  const wasOffline = !$('#health').classList.contains('online');
  const ok = await probeCaps();
  if (!ok) return;                                  // 仍离线：健康探针已负责提示与重试
  if (jobs.logOpen()) return;                       // 弹框开着不打扰列表，关闭时 closeLog 会补一次
  if (wasOffline || jobs.page === 1) jobs.loadJobs();   // 刚恢复在线 / 停在首页：整页重取
  else jobs.probeTotal();                           // 停在后面的页：只探新增，不重排正在看的内容
}, 5000);
$('#submit').onclick = submitJob;   // 提交按钮装配（模块自身不碰 DOM 时序）
