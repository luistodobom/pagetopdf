// Inline SVG icon set: monochrome outline glyphs on a 24x24 grid, drawn with
// currentColor so they follow the theme (Material Symbols-like weight).

const P = {
  // Brand glyph: a page inside viewfinder corners (capture frame). Outline version of icons/icon.svg.
  logo: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M13 6.5H9a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-6.5z"/><path d="M13 6.5v3.5h3M10.5 13.5h3"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  page: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  viewport: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
  download: '<path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/>',
  pdf: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M9.5 15.5h5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4M8 11h6"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M2 6h14a2 2 0 0 1 2 2v14"/>',
  cutRows: '<path d="M5 3v5h14V3M5 21v-5h14v5"/><path d="M3 12h2.5m3 0h2.5m3 0h2.5m3 0H21"/>',
  cutCols: '<path d="M3 5h5v14H3M21 5h-5v14h5"/><path d="M12 3v2.5m0 3v2.5m0 3v2.5m0 3V21"/>',
  // Freehand stroke: a scribble (like Material's "gesture").
  pen: '<path d="M3 17c2-5.6 4-10 6.2-10 2.6 0-.6 11 2.8 11 2.8 0 3.6-9 6.4-9 1.6 0 2.4 1.8 2.6 3.8"/>',
  rect: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  arrow: '<path d="M5 19 19 5M10 5h9v9"/>',
  line: '<path d="M5 19 19 5"/>',
  highlight: '<path d="m9 11-5 5v4h4l5-5"/><path d="m9 11 4-4 4 4-4 4z"/><path d="m13 7 3-3 4 4-3 3"/>',
  // A line of text with part of it blacked out (Preview-style redaction).
  redact: '<path d="M4 6h16M4 18h11M4 12h3"/><rect x="9" y="9.25" width="11" height="5.5" rx="1" fill="currentColor" stroke="none"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  pointer: '<path d="m5 3 14 7-6 2-2 6z"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  droplet: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/><path d="M4 4l16 16"/>',
  hires: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 9v6M7 12h3M10 9v6M14 9v6h2a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  more: '<circle cx="12" cy="5.5" r=".9" fill="currentColor"/><circle cx="12" cy="12" r=".9" fill="currentColor"/><circle cx="12" cy="18.5" r=".9" fill="currentColor"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M8 14h8"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
};

export function icon(name, cls = '') {
  return `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
}

export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
    el.removeAttribute('data-icon');
  }
}

export function toast(msg, ms = 2600) {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; wrap.setAttribute('role', 'status'); wrap.setAttribute('aria-live', 'polite'); document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  wrap.appendChild(t);
  const api = {
    el: t,
    progress(p, label) {
      if (label) t.firstChild.nodeValue = label;
      let bar = t.querySelector('.bar');
      if (!bar) { bar = document.createElement('div'); bar.className = 'bar'; bar.innerHTML = '<i></i>'; t.appendChild(bar); }
      bar.firstChild.style.width = `${Math.round(p * 100)}%`;
    },
    done(label, after = 2000) { if (label) t.firstChild.nodeValue = label; t.querySelector('.bar')?.remove(); setTimeout(() => t.remove(), after); },
  };
  if (ms) setTimeout(() => t.remove(), ms);
  return api;
}

// Shared behaviour of the captures/settings page chrome (toolbar + navigation rail).
export function initPageChrome() {
  document.getElementById('navShortcuts')?.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  const bar = document.querySelector('.cr-toolbar');
  if (bar) addEventListener('scroll', () => bar.classList.toggle('scrolled', scrollY > 0), { passive: true });
}
