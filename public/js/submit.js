/**
 * 提交：表单/JSON → multipart（含附件通道）或纯 JSON，乐观插入任务行并打开日志。
 * 依赖经 setSubmitDeps 注入（form 的 collect/校验、picker 状态、jobs 的行操作），
 * main 在初始化时接线，避免 import 环。
 */
import { $, el } from './dom.js';
import { toast } from './toast.js';

const deps = {
  collect: () => ({ params: {}, files: {} }), validateForm: () => [], showMsg: () => {},
  isJsonManual: () => false, jsonBoxValue: () => '', exitJsonManual: () => {},
  applyPathOnly: () => {}, syncJson: () => {},
  getPicker: () => null, getTreePick: () => null,
  addJobRow: () => {}, openLog: () => {}, loadJobs: () => Promise.resolve(),
};
export function setSubmitDeps(d) { Object.assign(deps, d); }

export async function submitJob() {
  deps.showMsg('', '');
  let params;
  if (deps.isJsonManual()) {
    try { params = JSON.parse(deps.jsonBoxValue()); }
    catch (e) { deps.showMsg('JSON 解析失败: ' + e.message, 'err'); toast('JSON 解析失败', 'err'); return; }
  } else {
    const errs = deps.validateForm();
    if (errs.length) { deps.showMsg('请修正参数后再提交：' + errs.join('；'), 'err'); toast('参数超出有效范围', 'err', 2600); return; }
    const c = deps.collect(); params = c.params;
  }
  const type = params.type = $('#type').value;
  const pathVal = $('#inputPath')?.value.trim() || '';
  const inPath = deps.getPicker()?.getMode?.() === 'path';   // FilePicker「服务器路径」模式
  const fileList = deps.getTreePick()?.length ? [] : ($('#file')?.files ? [...$('#file').files] : []);
  const file = fileList[0];
  /* 防呆：服务器路径 / JSON 手改模式走纯 JSON 通道提交，multipart 附件字段
   * （@prj/@cps/@cfg/@props）不会被携带——旧版静默丢弃造成「投影文件未生效」。 */
  if (inPath || deps.isJsonManual()) {
    const nm = { prj: '投影文件', cps: '控制点 CSV', cfg: '简化配置 CSV', props: '属性表 CSV' };
    const tip = {
      prj: '「投影」组请改用「服务器投影文件」浏览选取（proj.prjPath）',
      cps: '请把控制点内容粘贴到「控制点 CSV 文本」框',
      cfg: '请切回「⬆ 上传」模式提交',
      props: '服务器路径模式请用「属性绑定 → 服务器属性表 CSV」选取，或切回「⬆ 上传」模式',
    };
    const picked = Object.keys(nm).filter((k) => $('#paramForm').querySelector(`[data-k="@${k}"]`)?.files?.[0]);
    if (picked.length) {
      const mode = deps.isJsonManual() ? 'JSON 手改' : '服务器路径';
      deps.showMsg(`「${mode}」模式不携带上传附件（已选但不会生效：${picked.map((k) => nm[k]).join('、')}）——`
        + picked.map((k) => tip[k]).join('；'), 'err');
      toast(`${mode} 模式下上传附件不会生效`, 'err', 5200);
      return;
    }
  }
  const btn = $('#submit'); btn.disabled = true;
  const old = btn.textContent; btn.textContent = ''; btn.append(el('span', { class: 'spinner' }), ' 提交中…');
  let res;
  const form = $('#paramForm');
  const appendAux = (fd) => {
    for (const k of ['prj', 'cps', 'cfg', 'props']) {
      const f = form.querySelector(`[data-k="@${k}"]`)?.files?.[0];
      if (f) fd.append(k, f, f.name);
    }
  };
  const sendLocalPath = async () => {
    const jbody = { ...params };
    const paths = type === 'tiles' ? pathVal.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (paths.length > 1) jbody.inputPaths = paths; else jbody.inputPath = pathVal;
    // 仅 mesh 有模型路径消歧框；tiles 单路径指向文件夹时由服务端自动全选全部模型
    if (type === 'mesh') {
      const mp = $('#modelPaths')?.value.trim();
      if (mp) jbody.modelPaths = mp.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return fetch('/api/v1/jobs', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(jbody) });
  };
  try {
    if (inPath) {
      if (!pathVal) { deps.showMsg('请填写服务器本地路径，或点「📂 浏览…」选择', 'err'); toast('路径为空', 'err', 2600); return; }
      res = await sendLocalPath();
    } else if (type === 'osgb' && !deps.isJsonManual() && deps.getTreePick()?.length) {
      // ---- OSGB 文件夹（拖入或目录选择器）：逐文件携带相对路径，服务端重建树 ----
      const fd = new FormData();
      const rels = deps.getTreePick().map((t) => t.rel);
      fd.append('options', JSON.stringify({ ...params, relPaths: rels, dirName: String(rels[0]).split('/')[0] || 'osgb' }));
      deps.getTreePick().forEach((t, i) => fd.append('file', t.file, `f_${String(i + 1).padStart(6, '0')}`));
      appendAux(fd);
      res = await fetch('/api/v1/jobs', { method: 'POST', headers: {}, body: fd });
    } else if (type === 'osgb' && !deps.isJsonManual() && file) {
      if (!/\.zip$/i.test(file.name)) {
        deps.showMsg('OSGB 上传仅支持文件夹或 .zip——整目录请拖入/点「选文件夹」，超大目录用「服务器路径」模式', 'err');
        toast('OSGB 需要文件夹或 ZIP', 'err', 4200);
        return;
      }
      // ---- OSGB ZIP：服务端解压重建树 ----
      const fd = new FormData();
      fd.append('options', JSON.stringify({ ...params, dirName: file.name.replace(/\.zip$/i, '') || 'osgb' }));
      fd.append('file', file, file.name);
      appendAux(fd);
      res = await fetch('/api/v1/jobs', { method: 'POST', headers: {}, body: fd });
    } else if ((type === 'tiles' || type === 'mesh') && !deps.isJsonManual()
      && (deps.getTreePick()?.length || /\.zip$/i.test(file?.name ?? ''))) {
      if (!deps.getTreePick()?.length && fileList.length > 1) {
        deps.showMsg('ZIP 文件树不能与其他文件混选——请只选 ZIP，或只选模型文件（可多选）', 'err');
        toast('混选了 ZIP 与模型文件', 'err', 3200);
        return;
      }
      // ---- 文件树通道：文件夹（relPaths 重建，含子目录贴图）或 模型+贴图 ZIP ----
      const fd = new FormData();
      const opts = { ...params };
      if (deps.getTreePick()?.length) opts.relPaths = deps.getTreePick().map((t) => t.rel);
      const mp = $('#modelPaths')?.value.trim();
      if (mp) opts.modelPaths = mp.split(',').map((s) => s.trim()).filter(Boolean);
      fd.append('options', JSON.stringify(opts));
      if (deps.getTreePick()?.length) deps.getTreePick().forEach((t, i) => fd.append('file', t.file, `f_${String(i + 1).padStart(6, '0')}`));
      else fd.append('file', file, file.name);
      appendAux(fd);
      res = await fetch('/api/v1/jobs', { method: 'POST', headers: {}, body: fd });
    } else if (file && !deps.isJsonManual()) {
      const fd = new FormData();
      fd.append('options', JSON.stringify(params));
      // tiles：全部选中文件一次上传（服务端统一参数逐个转换后合并）
      for (const f of (type === 'tiles' ? fileList : [file])) fd.append('file', f, f.name);
      appendAux(fd);
      res = await fetch('/api/v1/jobs', { method: 'POST', headers: {}, body: fd });
    } else if (!deps.isJsonManual()) {
      deps.showMsg('请选择输入（文件 / ZIP / 文件夹），或切换到「🖥 服务器路径」', 'err');
      toast('未选择输入', 'err', 2600);
      return;
    } else {
      // JSON 手改模式：沿用「服务器本地路径」提交
      if (!pathVal) { deps.showMsg('JSON 模式仅支持「服务器本地路径」输入（切到「服务器路径」模式填写）', 'err'); return; }
      res = await sendLocalPath();
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const txt = body?.error
        ? `${body.error.code}: ${body.error.message}` + (body.error.details ? '\n' + JSON.stringify(body.error.details) : '')
        : `提交失败 (HTTP ${res.status})`;
      deps.showMsg(txt, 'err');
      toast(`提交失败：${body?.error?.message || 'HTTP ' + res.status}`, 'err', 5000);
      return;
    }
    // 新任务只可能出现在第 1 页：先回到首页再乐观插入，随后拉服务端首页覆盖本地
    deps.addJobRow(body);   // 回首页 + 乐观插行都在 jobs 内完成
    deps.openLog(body.id); deps.loadJobs();
    deps.showMsg(`任务已提交：${body.id.slice(0, 8)}`, 'ok');
    toast('任务已提交，正在处理…', 'ok');
  } catch (err) {
    // 网络中断/服务不可达时 fetch 会 reject——旧代码 try/finally 没有 catch，
    // 异常变成未处理的 Promise rejection，按钮虽然复原了用户却看不到任何提示。
    const what = String(err?.message ?? err);
    deps.showMsg('提交失败（网络/服务异常）：' + what, 'err');
    toast('提交失败：' + what, 'err', 5200);
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}
