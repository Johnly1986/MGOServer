/**
 * 三页共用（console / viewer / whitelist）的最小 DOM 工具。
 * 刻意保持零依赖、无副作用——页面样式仍各自独立成文件。
 */
export const $ = (s) => document.querySelector(s);

/** el('div', { class: 'x', onclick: fn }, childNode, 'text…') */
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const k of kids) { if (k == null || k === false) continue; n.append(k.nodeType ? k : document.createTextNode(k)); }
  return n;
}

/** 注入 innerHTML / title 等属性前的 HTML 转义 */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 复制到剪贴板，返回是否成功。
 * 剪贴板 API 只在安全上下文（https 或 localhost）存在；控制台常被内网用
 * http://<IP> 打开——此时 navigator.clipboard 直接是 undefined，旧代码
 * 静默吞掉后还弹"已复制"，纯属误导。这里先走 Clipboard API，不行就退回
 * 传统的隐藏 textarea + execCommand('copy')，最后如实告知结果。
 */
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* 掉进兜底 */ }
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = String(text ?? '');
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.append(ta);
    const sel = document.getSelection(); const prev = sel?.rangeCount ? sel.getRangeAt(0) : null;
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (prev) { sel.removeAllRanges(); sel.addRange(prev); }
    return ok;
  } catch { return false; }
}

/** 字节数 → 人类可读（GB / MB / KB） */
export const fmtKB = (n) => n == null ? '' : n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB'
  : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

/** ISO 时间 → 「N 秒/分/时/天前」 */
export function fmtAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 8) return '刚刚';
  if (s < 60) return Math.floor(s) + '秒前';
  if (s < 3600) return Math.floor(s / 60) + '分钟前';
  if (s < 86400) return Math.floor(s / 3600) + '小时前';
  return Math.floor(s / 86400) + '天前';
}

/** localStorage 包装：无痕模式/被禁策略下静默降级 */
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },   // 无痕模式别炸
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 存不下就算了 */ } },
};

/** <label> 快捷构造 */
export const label = (s) => el('label', {}, s);

/** 模态框通用外壳：锁背景滚动（补滚动条宽度）+ 其余内容 inert。
 *  日志弹框与目录浏览弹框共用同一套语义。 */
export function toggleModalChrome(on, modal) {
  const b = document.body;
  if (on) {
    const gap = window.innerWidth - document.documentElement.clientWidth;   // 先量滚动条宽度再锁
    b.style.paddingRight = gap > 0 ? `${gap}px` : '';
    b.classList.add('locked');
  } else {
    b.classList.remove('locked');
    b.style.paddingRight = '';
  }
  // 背景整体 inert：不进 Tab 序、读屏也不播（不支持该属性的浏览器忽略即可，焦点圈仍由 keydown 兜住）。
  for (const n of b.children) {
    if (n.tagName === 'SCRIPT' || n === modal || n.id === 'toasts') continue;
    n.inert = on;
  }
}
