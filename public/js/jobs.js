/**
 * 任务列表：分页拉取、SSE 实时进度、日志悬浮弹框与模态框通用锁滚。
 * 提交成功后由 main 调 addJobRow/openLog；跨模块协作经 setJobsHooks 注入。
 */
import { $, esc, fmtAgo, copyText, store } from './dom.js';
import { ICONS, TYPE_CN } from './console-spec.js';
import { toast } from './toast.js';

let hooks = { afterDelete: () => {} };
export function setJobsHooks(h) { Object.assign(hooks, h); }

export const jobs = new Map();   // 只装当前页
let es = null;
let logJobId = null;      // 弹框正在查看日志的任务（行高亮用）
export const PAGE_SIZES = [10, 20, 50];
export let pageSize = PAGE_SIZES.includes(+store.get('mgo.pageSize')) ? +store.get('mgo.pageSize') : 10;
export let page = 1, pages = 1, listTotal = 0;
export let prevTotal = null, pendingNew = 0;   // 停在非首页时新增的任务数 → "有新任务"提示
const STATUS_CN = { queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', usage_error: '参数错误', canceled: '已取消' };
const fmtPct = (j) => {
  const p = j.progress || {};
  const w = j.status === 'succeeded' ? 100 : (p.percent || 0);
  const run = ['queued', 'running'].includes(j.status);
  return `<div class="bar${run ? ' run' : ''}"><i style="width:${w}%"></i></div>
    <span class="pct">${w}%${p.total ? ` · ${p.done}/${p.total}${p.phase === 'levels' ? ' 级' : ''}` : ''}</span>`;
};
export function row(j) {
  const viewer = j.viewerUrl
    ? `<a class="btn" href="${esc(j.viewerUrl)}" target="_blank" title="在查看器中打开">查看</a>` : '';
  const cancel = ['queued', 'running'].includes(j.status) ? `<button class="danger" data-act="cancel" title="取消任务">取消</button>` : '';
  return `<tr data-id="${j.id}"${j.id === logJobId ? ' class="cur"' : ''}>
    <td><span class="jobId" data-copy="${j.id}" title="点击复制完整 ID">${j.id.slice(0, 8)}</span><span class="tRel">${fmtAgo(j.createdAt)}</span></td>
    <td><span class="typeCell" title="${esc(TYPE_CN[j.type] || j.type)}"><span class="typeIc">${ICONS[j.type] || ''}</span>${j.type}</span></td>
    <td><span class="badge s-${j.status}">${STATUS_CN[j.status] || j.status}</span></td>
    <td>${fmtPct(j)}</td>
    <td class="c-input"><span class="inName" title="${esc(j.error ? j.error.code + ': ' + j.error.message : j.inputName || '')}">${esc(j.inputName || '')}</span></td>
    <td><div class="act">${viewer}<button data-act="log" title="查看日志">日志</button>${cancel}<button class="danger" data-act="del" title="删除任务与产物">删除</button></div></td>
  </tr>`;
}
export function render() {
  const arr = [...jobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  $('#jobs').innerHTML = arr.length ? arr.map(row).join('')
    : `<tr><td colspan="6"><div class="empty"><div class="ic">🗂</div><p>暂无任务</p>
        <span class="hint">左侧选择类型并上传文件，提交后进度实时显示在这里</span></div></td></tr>`;
  renderStats(arr);
  renderPager();
}
function renderStats(arr) {
  // 优先用服务端全量 byStatus，避免当前页之外的计数丢失；metrics 不可用时退回本地统计
  const c = jobStats
    ? { running: jobStats.running | 0, queued: jobStats.queued | 0, succeeded: jobStats.succeeded | 0, failed: jobStats.failed | 0 }
    : { running: 0, queued: 0, succeeded: 0, failed: 0, other: 0 };
  if (!jobStats) arr.forEach(j => { if (c[j.status] !== undefined) c[j.status]++; else c.other++; });
  const s = $('#stats');
  const total = jobsTotal ?? arr.length;
  s.innerHTML = [
    ['运行中', c.running, 'warn'], ['排队中', c.queued, 'dim'], ['成功', c.succeeded, 'ok'], ['失败', c.failed, 'err'],
  ].map(([t, n, k]) => `<span class="stat"><b style="color:var(--${k})">${n}</b>${t}</span>`).join('')
    + `<span class="stat" style="margin-left:auto"${listTotal > arr.length ? ` title="当前第 ${page}/${pages} 页"` : ''}>共 ${total} 个任务</span>`;
}
export let jobsTotal = null;   // 服务端任务总数（列表只拉当前页）
let jobStats = null;    // 服务端全量 byStatus（不受分页窗口限制）
let loading = null;     // 同一时刻只允许一次列表请求在飞（5s 轮询 + 手动刷新 + 操作后补拉会撞车）
export function loadJobs(force = false) {
  if (loading) {
    // 翻页/换页大小不能被在飞请求吞掉：fetchPage 在启动时就捕获了旧的
    // page/pageSize，直接返回旧 promise 会让这次导航凭空消失（18b 偶发
    // 超时的根因）——force 时等在飞请求落地后按新参数补抓一次。
    if (!force) return loading;
    return loading.then(() => loadJobs());
  }
  loading = fetchPage().finally(() => { loading = null; });
  return loading;
}
export async function fetchPage() {
  const offset = (page - 1) * pageSize;
  try {
    const [listR, mxR] = await Promise.all([
      fetch(`/api/v1/jobs?limit=${pageSize}&offset=${offset}`),
      fetch('/api/v1/metrics').catch(() => null),
    ]);
    if (!listR.ok) return;
    const o = await listR.json();
    listTotal = Number.isFinite(+o.total) ? +o.total : o.items.length;
    jobsTotal = listTotal;                                   // 先用列表权威总数兜底
    pages = Math.max(1, Math.ceil(listTotal / pageSize));
    if (page > pages) { page = pages; return fetchPage(); }   // 删完最后一页后越界：夹回末页
    if (mxR?.ok) {
      const mx = await mxR.json().catch(() => null);
      if (mx?.jobs) { jobStats = mx.jobs.byStatus ?? null; jobsTotal = mx.jobs.total ?? jobsTotal; }
    }
    // 服务端为权威，整页替换：旧的"只 set 不清"在分页下会把别页的行留在表里
    jobs.clear();
    o.items.forEach(j => jobs.set(j.id, j));
    trackNew();
    render();
  } catch { /* 服务离线：由健康探针负责提示与重连 */ }
}
function trackNew() {   // 新增计数：停在首页直接刷进来看得到，停在后面页只提示不重排
  if (page === 1) pendingNew = 0;
  else if (prevTotal != null && listTotal > prevTotal) pendingNew += listTotal - prevTotal;
  prevTotal = listTotal;
}
/** 停在第 2 页以后：定时刷新只探"有没有新任务"和统计条，不动正在看的那一页的行 */
export async function probeTotal() {
  try {
    const [o, mx] = await Promise.all([
      fetch('/api/v1/jobs?limit=1').then((r) => r.json()),
      fetch('/api/v1/metrics').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const t = Number.isFinite(+o.total) ? +o.total : listTotal;
    if (prevTotal != null && t < prevTotal) return loadJobs();   // 别处删了任务：当前页可能已空，老实重取
    listTotal = t;
    pages = Math.max(1, Math.ceil(listTotal / pageSize));
    if (mx?.jobs) { jobStats = mx.jobs.byStatus ?? null; jobsTotal = mx.jobs.total ?? t; }
    else jobsTotal = t;
    trackNew();
    renderStats([...jobs.values()]);   // 统计条保持实时，表格行不重排
    renderPager();
  } catch { /* 离线：健康探针负责 */ }
}
/* ---------------- pager ---------------- */
function pageWindow(cur, n) {   // 1 … 4 5 [6] 7 8 … 20
  const out = [];
  for (let i = 1; i <= n; i++) {
    if (i === 1 || i === n || Math.abs(i - cur) <= 1) out.push(i);
    else if (out[out.length - 1] !== '…') out.push('…');
  }
  return out;
}
let pagerSig = '';
function renderPager() {
  const box = $('#pager');
  if (!listTotal) { box.innerHTML = ''; pagerSig = ''; return; }
  const sig = [page, pages, pageSize, listTotal, pendingNew].join('|');
  if (sig === pagerSig && box.firstChild) return;   // 5s 轮询别重建 DOM（会把展开中的下拉打断）
  pagerSig = sig;
  const from = (page - 1) * pageSize + 1, to = Math.min(page * pageSize, listTotal);
  const num = (p) => p === '…' ? '<span class="dots">…</span>'
    : `<button data-page="${p}"${p === page ? ' class="on" aria-current="page"' : ''} title="第 ${p} 页">${p}</button>`;
  const edge = (p, label, title, off) =>
    `<button data-page="${p}" title="${title}"${off ? ' disabled' : ''}>${label}</button>`;
  box.innerHTML = `<span class="pInfo">第 ${from}–${to} 条 / 共 ${listTotal} 条</span>
    <label class="pInfo">每页<select id="pageSizeSel" title="每页显示条数">${
      PAGE_SIZES.map((s) => `<option value="${s}"${s === pageSize ? ' selected' : ''}>${s}</option>`).join('')
    }</select>条</label>
    ${pendingNew ? `<button class="newHint" data-new="1" title="跳转到第 1 页">↑ ${pendingNew} 个新任务</button>` : ''}
    <span class="pBtns" role="group" aria-label="分页">${
      edge(1, '«', '首页', page === 1) + edge(page - 1, '‹', '上一页', page === 1)
    }${pageWindow(page, pages).map(num).join('')}${
      edge(page + 1, '›', '下一页', page === pages) + edge(pages, '»', '末页', page === pages)
    }</span>`;
}
$('#pager').addEventListener('click', (e) => {
  const hit = e.target.closest('[data-page],[data-new]');
  if (!hit) return;
  if (hit.dataset.new) { page = 1; pendingNew = 0; loadJobs(true); return; }
  const p = +hit.dataset.page;
  if (!Number.isFinite(p) || p === page || p < 1 || p > pages) return;
  page = p; pendingNew = 0;
  loadJobs(true);
});
$('#pager').addEventListener('change', (e) => {
  if (e.target.id !== 'pageSizeSel') return;
  pageSize = +e.target.value || 10;
  store.set('mgo.pageSize', pageSize);
  page = 1; pendingNew = 0; pagerSig = '';
  loadJobs(true);
});
$('#jobs').addEventListener('click', async (e) => {
  const btn = e.target.closest('button'); const idEl = e.target.closest('[data-copy]');
  if (idEl) {
    const ok = await copyText(idEl.dataset.copy);
    toast(ok ? '任务 ID 已复制：' + idEl.dataset.copy : '复制失败：此页面不允许脚本访问剪贴板', ok ? 'info' : 'err', 2600);
    return;
  }
  if (!btn) return;
  const id = btn.closest('tr').dataset.id;
  const call = async (url, method, okMsg, kind = 'ok') => {
    try {
      const r = await fetch(url, { method, headers: {} });
      if (!r.ok) { const b = await r.json().catch(() => null); toast(b?.error?.message || `操作失败 (HTTP ${r.status})`, 'err', 5000); return false; }
      toast(okMsg, kind); return true;
    } catch { toast('服务不可达，操作未执行', 'err'); return false; }
  };
  if (btn.dataset.act === 'cancel') await call(`/api/v1/jobs/${id}/cancel`, 'POST', '已提交取消请求', 'info');
  if (btn.dataset.act === 'del') {
    if (await call(`/api/v1/jobs/${id}`, 'DELETE', '任务已删除')) {
      jobs.delete(id);
      if (id === logJobId) closeLog();   // 别把日志弹框留在已删除的任务上
    }
  }
  if (btn.dataset.act === 'log') openLog(id);
  loadJobs();
});
$('#refreshBtn').onclick = loadJobs;
$('#closeLogBtn').onclick = closeLog;
$('#copyLogBtn').onclick = async () => {
  const ok = await copyText($('#logBox').textContent);
  toast(ok ? '日志已复制' : '复制失败：此页面不允许脚本访问剪贴板', ok ? 'ok' : 'err', 2600);
};

/* ---------------- 日志悬浮弹框 ---------------- */
const logModal = $('#logModal');
const logDialog = $('#logDialog');
export const logOpen = () => !logModal.hidden;
let logGen = 0;   // 每次 openLog 递增：丢弃上一个请求的迟到回调（连点两行日志时
                  // 第一个 fetch 回来不能覆盖第二个任务的内容）
const logBadge = (st) => { $('#logJob').className = 'badge mono s-' + (st || 'queued'); };
const logTrigger = (id) => {
  try { return document.querySelector(`#jobs tr[data-id="${CSS.escape(id)}"] button[data-act="log"]`); }
  catch { return null; }
};
import { toggleModalChrome as chromeBase } from './dom.js';
/** 日志弹框的默认目标即 logModal；fsbrowser 传自己的节点复用同一实现 */
export function toggleModalChrome(on, modal = logModal) { return chromeBase(on, modal); }
export async function openLog(id) {
  const gen = ++logGen;
  logJobId = id;
  logModal.hidden = false;
  toggleModalChrome(true);
  $('#logJob').textContent = '#' + id.slice(0, 8);
  logBadge(jobs.get(id)?.status);   // 徽章跟着任务真实状态走，不再恒为"运行中"黄
  $('#logBox').textContent = '';
  if (es) { es.close(); es = null; }
  render();                                     // 标记正在看日志的行
  logDialog.focus({ preventScroll: true });     // 键盘/Esc 立刻可用
  const stale = () => gen !== logGen || logJobId !== id;
  // 实时行必须是真实 <span> 元素（Element.append 收到字符串只会当纯文本插入，
  // 曾导致 <span …> 包装标签原样露在日志里、颜色类从未生效）
  const logSpan = (cls, text) => {
    const box = $('#logBox');
    if (cls) {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      box.append(s, '\n');
    } else box.append(`${text}\n`);
  };
  // 终态任务没有"实时"可言：run.log 历史已完整，挂 SSE 只会把事件缓冲区
  // 重放一遍——模块行/进度在历史里都已出现，用户看到同样内容两遍。
  const TERMINAL_ST = ['succeeded', 'failed', 'canceled', 'usage_error'];
  const wasTerminal = TERMINAL_ST.includes(jobs.get(id)?.status);
  // render history FIRST, then attach EventSource — otherwise a late fetch
  // callback clobbers live [progress] lines already appended (was a real race)
  try {
    // 弹框比原来的内嵌面板高得多，历史行数相应放宽（服务端 tail 上限 2000）
    const o = await (await fetch(`/api/v1/jobs/${id}/log?tail=300`)).json();
    if (stale()) return;                        // 弹框已切到别的任务：别覆盖
    $('#logBox').textContent = (o.lines || []).join('\n')
      + (wasTerminal ? '\n' : '\n—— 以下为实时日志 ——\n');
  } catch {
    if (stale()) return;
    $('#logBox').textContent = wasTerminal ? '' : '—— 实时日志 ——\n';
  }
  scroll();
  if (wasTerminal) {
    // 打开瞬间恰好完成的竞态：以服务端权威状态纠正徽章/行，并补一行终态
    try {
      const j = await (await fetch(`/api/v1/jobs/${id}`)).json();
      if (stale()) return;
      const row = jobs.get(id);
      if (row && j.status !== row.status) { row.status = j.status; render(); }
      logBadge(j.status);
      logSpan('t-status', `[status] ${j.status}`);
      scroll();
    } catch { /* 服务离线：历史已在，徽章保持打开时的值 */ }
    return;
  }
  if (stale()) return;                          // fetch 期间被 closeLog/重开：不再挂流
  es = new EventSource(`/api/v1/jobs/${id}/events`);
  es.addEventListener('log', (m) => {
    const line = JSON.parse(m.data).line;
    const cls = /\[(?:Progress|Done)\]/.test(line) ? 't-prog' : (/^Error|错误|warning/i.test(line) ? 't-err' : '');
    logSpan(cls, line); scroll();
  });
  es.addEventListener('progress', (m) => {
    const d = JSON.parse(m.data);
    const j = jobs.get(id); if (j) { j.progress = d.data; j.status = 'running'; render(); }
    logSpan('t-prog', `[progress] ${d.data.done}/${d.data.total} (${d.data.percent}%)`); scroll();
  });
  es.addEventListener('status', (m) => {
    const d = JSON.parse(m.data); const j = jobs.get(id);
    if (j) { j.status = d.status; if (d.artifacts) { j.artifacts = d.artifacts; j.viewerUrl = d.viewerUrl; } render(); }
    logBadge(d.status);
    logSpan('t-status', `[status] ${d.status}`); scroll();
  });
}
export function closeLog() {
  const id = logJobId;
  logModal.hidden = true;
  logJobId = null;
  toggleModalChrome(false);
  render();
  if (es) { es.close(); es = null; }
  // 弹框开着时暂停了轮询，关掉补一次；行会被刷新重建，所以等它落地后再按 id 还焦点
  loadJobs().then(() => { if (!logOpen()) logTrigger(id)?.focus(); });
}
$('#logMask').onclick = closeLog;                 // 点遮罩关闭

const scroll = () => { const b = $('#logBox'); b.scrollTop = b.scrollHeight; };
/** 提交成功后的乐观插入（submit 调用）：新任务只可能出现在第 1 页，
 *  先回首页再插行；分页状态是本模块私有绑定，外部（含 main）不得直接赋值。 */
export function addJobRow(job) { page = 1; pendingNew = 0; jobs.set(job.id, job); if (jobsTotal != null) jobsTotal += 1; render(); }
