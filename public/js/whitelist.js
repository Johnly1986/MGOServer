/** 白名单管理页：仅服务器本机可增删条目；读写 /api/v1/whitelist。 */
import { $ } from './dom.js';

let local = false;           // 是否本机（可管理）
let items = [];              // 当前编辑条目（不含恒允许的本机）

async function load() {
  const r = await fetch('/api/v1/capabilities');
  const caps = await r.json().catch(() => null);
  local = caps?.client?.canManageWhitelist === true;
  const allowed = caps?.client?.allowed === true;
  const ip = caps?.client?.ip ?? '?';
  const st = $('#stateText');
  if (!caps) { $('#stateBadge').textContent = '离线'; $('#stateBadge').className = 'badge err'; st.textContent = '无法连接服务。'; return; }
  $('#stateBadge').textContent = allowed ? `已授权（${ip}）` : `未授权（${ip}）`;
  $('#stateBadge').className = 'badge ' + (allowed ? 'ok' : 'err');
  if (!local) {
    st.innerHTML = `当前 IP <b class="mono">${ip}</b> 非服务器本机，本页只读。请在服务器本机打开此页修改。`;
  } else {
    st.innerHTML = `本机访问 ✓ 可修改白名单，保存后立即生效。`;
  }
  if (!local) {
    $('#addBtn').disabled = $('#saveBtn').disabled = $('#resetBtn').disabled = true;
    $('#entry').disabled = true;
  }
  const w = await (await fetch('/api/v1/whitelist')).json();
  items = (w.whitelist || []).filter((e) => !['127.0.0.1', '::1'].includes(e));
  render();
}

function render() {
  $('#count').textContent = `${items.length} 条`;
  $('#list').innerHTML = [
    '<li class="locked">127.0.0.1<span class="tag">本机·恒允许</span></li>',
    '<li class="locked">::1<span class="tag">本机·恒允许</span></li>',
    ...items.map((e, i) => `<li>${e}<span class="rm" data-i="${i}" title="移除">✕</span></li>`),
  ].join('');
}

$('#list').addEventListener('click', (e) => {
  const rm = e.target?.closest?.('.rm');
  if (rm && local) { items.splice(Number(rm.dataset.i), 1); render(); }
});
$('#addBtn').onclick = addEntry;
$('#entry').addEventListener('keydown', (e) => { if (e.key === 'Enter') addEntry(); });
function addEntry() {
  const v = $('#entry').value.trim();
  if (!v) return;
  if (!/^[\w.:\/\[\]]+$/.test(v) || !/\d|:/.test(v)) {
    show('格式无效，请输入 IP 或 CIDR 网段', 'err'); return;
  }
  if (!items.includes(v)) items.push(v);
  $('#entry').value = '';
  render();
}
$('#saveBtn').onclick = async () => {
  const r = await fetch('/api/v1/whitelist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ whitelist: items }),
  });
  const b = await r.json().catch(() => null);
  if (!r.ok) { show(`保存失败：${b?.error?.message || r.status}`, 'err'); return; }
  items = (b.whitelist || []).filter((e) => !['127.0.0.1', '::1'].includes(e));
  render();
  show('✓ 已保存并生效', 'ok');
};
$('#resetBtn').onclick = async () => {
  const r = await fetch('/api/v1/whitelist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ whitelist: [] }),
  });
  const b = await r.json().catch(() => null);
  if (!r.ok) { show(`重置失败：${b?.error?.message || r.status}`, 'err'); return; }
  items = [];
  render();
  show('✓ 已恢复默认（仅本机）', 'ok');
};
function show(t, k) { const m = $('#msg'); m.textContent = t; m.className = k; }

load();
