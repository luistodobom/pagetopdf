import { hydrateIcons, initPageChrome, toast } from './icons.js';
import { listCaptures, deleteCapture } from '../lib/db.js';
import { formatDateTime } from '../lib/util.js';

hydrateIcons();
initPageChrome();
const $ = id => document.getElementById(id);
let all = await listCaptures();
const selected = new Set();
const thumbs = new Map(); // id -> object URL, so re-renders don't leak blob URLs

const sc = (await chrome.commands.getAll()).find(c => c.name === 'capture-page')?.shortcut;
if (sc) $('emptyShortcut').textContent = sc;
else $('emptyShortcut').parentElement.textContent = 'Click the PageToPDF button in the toolbar on any page.';

function visible() {
  const q = $('q').value.trim().toLowerCase();
  return all.filter(c => !q || (c.title || '').toLowerCase().includes(q) || (c.url || '').toLowerCase().includes(q));
}

function paintSelection() {
  $('selbar').hidden = !selected.size;
  document.querySelector('.tb-main').hidden = !!selected.size;
  $('selCount').textContent = `${selected.size} selected`;
}

function toggle(id) {
  selected.has(id) ? selected.delete(id) : selected.add(id);
  render();
}

function render() {
  const items = visible();
  const grid = $('grid');
  const focusedId = document.activeElement?.closest?.('.cap')?.dataset.id;
  grid.replaceChildren();
  grid.classList.toggle('selecting', selected.size > 0);
  $('empty').hidden = all.length > 0;
  $('noMatch').hidden = !all.length || items.length > 0;
  $('summary').parentElement.hidden = !all.length;
  $('summary').textContent = `${all.length} capture${all.length === 1 ? '' : 's'} · stored privately in this browser`;
  paintSelection();
  for (const c of items) {
    const card = document.createElement('div');
    card.className = 'cap' + (selected.has(c.id) ? ' sel' : '');
    card.dataset.id = c.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'link');
    let host = c.url; try { host = new URL(c.url).hostname; } catch { /* keep raw */ }
    const title = c.title || host || 'Untitled';
    card.setAttribute('aria-label', title);
    card.innerHTML = `<div class="thumb"><img alt=""></div><input type="checkbox" class="check">
      <div class="info"><div class="t"></div><div class="u"></div><div class="d"><span class="when"></span><span>${c.width}×${c.height}</span></div></div>`;
    if (c.thumb) {
      if (!thumbs.has(c.id)) thumbs.set(c.id, URL.createObjectURL(c.thumb));
      card.querySelector('img').src = thumbs.get(c.id);
    }
    const check = card.querySelector('.check');
    check.checked = selected.has(c.id);
    check.setAttribute('aria-label', `Select ${title}`);
    card.querySelector('.t').textContent = title;
    card.querySelector('.u').textContent = c.url;
    card.querySelector('.when').textContent = formatDateTime(c.createdAt);
    card.onclick = e => {
      if (e.target.closest('.check') || selected.size || e.metaKey || e.ctrlKey || e.shiftKey) return toggle(c.id);
      location.href = `result.html?id=${c.id}`;
    };
    card.onkeydown = e => {
      if (e.target !== card) return;
      if (e.key === 'Enter') { e.preventDefault(); card.click(); }
      else if (e.key === ' ') { e.preventDefault(); toggle(c.id); }
    };
    grid.appendChild(card);
  }
  if (focusedId) grid.querySelector(`.cap[data-id="${CSS.escape(focusedId)}"]`)?.focus();
}
$('q').oninput = render;
$('selCancel').onclick = () => { selected.clear(); render(); };
$('selAll').onclick = () => { for (const c of visible()) selected.add(c.id); render(); };
addEventListener('keydown', e => { if (e.key === 'Escape' && selected.size) { selected.clear(); render(); } });
$('delSel').onclick = async () => {
  const n = selected.size;
  if (!confirm(`Delete ${n} capture${n === 1 ? '' : 's'}? This cannot be undone.`)) return;
  for (const id of selected) await deleteCapture(id);
  toast(`Deleted ${n} capture${n === 1 ? '' : 's'}`);
  selected.clear();
  all = await listCaptures(); render();
};
render();
