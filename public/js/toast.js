/* 右下角轻提示：toast(msg, 'ok'|'err'|'info') */
import { $, el } from './dom.js';

export function toast(msg, type = 'info', ms = 3600) {
  const box = $('#toasts');
  const t = el('div', { class: 'toast ' + type },
    el('span', { class: 't-ic' }, { ok: '✓', err: '✕', info: 'ℹ' }[type] || 'ℹ'),
    el('span', { class: 't-msg' }, msg),
    el('span', { class: 't-x', onclick: () => { t.classList.add('out'); setTimeout(() => t.remove(), 300); } }, '✕'));
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}
