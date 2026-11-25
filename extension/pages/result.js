import { hydrateIcons, toast } from './icons.js';
import { getCapture, updateCapture, deleteCapture } from '../lib/db.js';
import { getSettings, setSettings, PAPER_SIZES } from '../lib/settings.js';
import { CaptureSource, exportImage, exportPDF, computeBreaks, penPathD, simplifyStroke, isPenDot, makeRedactedThumb, thumbKey } from '../lib/export.js';
import { buildFilename, formatDateTime } from '../lib/util.js';

hydrateIcons();
const $ = id => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const id = new URLSearchParams(location.search).get('id');
let rec = await getCapture(id);
let settings = await getSettings();

if (!rec) {
  $('title').textContent = 'Capture not found';
  $('stage').innerHTML = '<p class="muted" style="text-align:center;margin-top:20vh">This capture no longer exists. <a href="files.html">Browse all captures</a></p>';
  throw new Error('missing capture');
}

// ------------------------------------------------------------------ header
document.title = `${rec.title || rec.url} · PageToPDF`;
$('title').textContent = rec.title || 'Untitled page';
$('url').textContent = rec.url.replace(/^https?:\/\//, '');
$('url').href = rec.url;
$('when').textContent = formatDateTime(rec.createdAt);
$('dims').textContent = `${rec.width} × ${rec.height}px`;
const badges = [];
if (rec.capturedWith?.hiRes) badges.push(`${rec.scale.toFixed(0)}× hi-res`);
else if (rec.capturedWith?.hiResNote) badges.push('normal resolution');
if (rec.capturedWith?.hiResNote) $('badges').title = rec.capturedWith.hiResNote;
if (rec.capturedWith?.removeBackgrounds) badges.push('no backgrounds');
if (rec.capturedWith?.truncated) badges.push('height limit reached');
if (rec.capturedWith?.stoppedEarly) badges.push('stopped early');
if (rec.mode === 'visible') badges.push('visible area');
$('badges').textContent = badges.join(' · ');
// Only real notes about how the capture was taken (e.g. a fallback or reduced scale).
$('captureNote').textContent = rec.capturedWith?.hiResNote || '';

// ------------------------------------------------------------------ image
const doc = $('doc'), overlay = $('overlay'), stage = $('stage');
overlay.setAttribute('viewBox', `0 0 ${rec.cssWidth} ${rec.cssHeight}`);
overlay.setAttribute('preserveAspectRatio', 'none');
for (const blob of rec.tiles) {
  const img = new Image();
  img.src = URL.createObjectURL(blob);
  img.decoding = 'async';
  $('tiles').appendChild(img);
}
let zoomMode = 'fit', zoom = 1;
function applyZoom() {
  const avail = stage.clientWidth - 64;
  zoom = zoomMode === 'fit' ? Math.min(1, avail / rec.cssWidth) : 1;
  doc.style.width = `${rec.cssWidth * zoom}px`;
  doc.style.height = `${rec.cssHeight * zoom}px`;
}
applyZoom();
addEventListener('resize', applyZoom);
new ResizeObserver(applyZoom).observe(stage);
$('zoomSeg').addEventListener('click', e => {
  const z = e.target.dataset.z; if (!z) return;
  zoomMode = z;
  $('zoomSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.target));
  applyZoom();
});

// ------------------------------------------------------------------ PDF settings panel
const sel = $('paperSize');
for (const [k, v] of Object.entries(PAPER_SIZES)) sel.add(new Option(v.label, k));
sel.value = settings.paperSize;
sel.onchange = () => saveSetting('paperSize', sel.value);
for (const key of ['orientation', 'marginMm', 'pdfImageQuality']) {
  const s = $(key);
  const cur = String(settings[key]);
  // Values set from the options page may not be in the short list here; show them anyway.
  if (![...s.options].some(o => o.value === cur)) s.add(new Option(key === 'marginMm' ? `${cur} mm` : cur, cur));
  s.value = cur;
  s.onchange = () => saveSetting(key, key === 'orientation' ? s.value : Number(s.value));
}
for (const key of ['smartSplit', 'pdfHeader', 'pdfFooter', 'textLayer', 'activeLinks']) {
  $(key).checked = !!settings[key];
  $(key).onchange = e => saveSetting(key, e.target.checked);
}
$('showBreaks').onchange = () => refreshBreaks();
async function saveSetting(key, value) {
  settings[key] = value;
  await setSettings({ [key]: value });
  if (['paperSize', 'orientation', 'marginMm', 'smartSplit', 'pdfHeader', 'pdfFooter'].includes(key)) refreshBreaks();
}
const panel = $('panel');
if (localStorage.getItem('ptp-panel') === 'closed') panel.classList.add('closed');
const paintPanelBtn = () => $('panelBtn').setAttribute('aria-expanded', String(!panel.classList.contains('closed')));
paintPanelBtn();
$('panelBtn').onclick = () => {
  panel.classList.toggle('closed');
  paintPanelBtn();
  try { localStorage.setItem('ptp-panel', panel.classList.contains('closed') ? 'closed' : 'open'); } catch { /* ignore */ }
};

// Page-break preview drawn over the screenshot.
let breakToken = 0, breaks = [];
async function refreshBreaks() {
  const token = ++breakToken;
  const src = new CaptureSource(rec);
  try {
    const r = await computeBreaks(src, settings);
    if (token !== breakToken) return;
    breaks = r.breaks.map(b => src.toOrigY(b));
    paintDims(src);
    $('pageCount').textContent = `${r.breaks.length - 1} page${r.breaks.length === 2 ? '' : 's'}`;
  } finally { src.close(); }
  render();
}

function paintDims(src) {
  const changed = src.width !== rec.width || src.height !== rec.height;
  $('dims').textContent = changed ? `${src.width} × ${src.height}px · cropped` : `${rec.width} × ${rec.height}px`;
  $('dims').title = changed ? `Original: ${rec.width} × ${rec.height}px` : '';
}

// ------------------------------------------------------------------ overlay rendering
// edits = { crop: {x,y,w,h} | null, cuts: [{ axis: 'y'|'x', from, to }], shapes: [...] } in CSS px
// of the original capture (see CaptureSource in lib/export.js). Older captures may lack cuts.
const normEdits = e => ({ crop: e?.crop || null, cuts: Array.isArray(e?.cuts) ? e.cuts : [], shapes: Array.isArray(e?.shapes) ? e.shapes : [] });
let edits = normEdits(structuredClone(rec.edits));
// "Keep area" starts with the whole capture selected, so you only pull the edges in.
// A crop covering everything is the same as no crop, so it is stored as null.
const fullCrop = () => ({ x: 0, y: 0, w: rec.cssWidth, h: rec.cssHeight });
const isFullCrop = c => !!c && c.x <= 0.5 && c.y <= 0.5 && c.x + c.w >= rec.cssWidth - 0.5 && c.y + c.h >= rec.cssHeight - 0.5;
const storedEdits = () => { const e = structuredClone(edits); if (isFullCrop(e.crop)) e.crop = null; return e; };
// mode: null (viewing), 'draw' (shapes) or 'crop' (keep area / remove rows / remove columns).
let mode = null, tool = 'rect', color = '#ef4444', selected = -1;
// Pen thickness in CSS px of the capture: thin / medium / thick.
const PEN_WIDTHS = { thin: 2, medium: 4, thick: 8 };
let penWidth = PEN_WIDTHS.medium;
let cropTool = 'keep', cutSel = -1;
const history = [JSON.stringify(edits)], future = [];

function el(tag, attrs) { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; }

function shapeNode(s, i) {
  const common = { class: 'shape', 'data-i': i };
  const lw = s.width || 3;
  switch (s.type) {
    case 'rect': return el('rect', { ...common, x: s.x, y: s.y, width: s.w, height: s.h, fill: 'none', stroke: s.color, 'stroke-width': lw, 'stroke-linejoin': 'round' });
    case 'ellipse': return el('ellipse', { ...common, cx: s.x + s.w / 2, cy: s.y + s.h / 2, rx: Math.abs(s.w / 2), ry: Math.abs(s.h / 2), fill: 'none', stroke: s.color, 'stroke-width': lw });
    case 'highlight': return el('rect', { ...common, x: s.x, y: s.y, width: s.w, height: s.h, fill: s.color, 'fill-opacity': 0.45, style: 'mix-blend-mode:multiply' });
    case 'redact': return el('rect', { ...common, x: s.x, y: s.y, width: s.w, height: s.h, fill: s.color || '#000' });
    case 'line':
    case 'arrow': {
      const g = el('g', common);
      g.appendChild(el('line', { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, stroke: s.color, 'stroke-width': lw, 'stroke-linecap': 'round' }));
      if (s.type === 'arrow') {
        const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), L = 10 + lw * 3;
        const p = [[s.x2, s.y2], [s.x2 - L * Math.cos(a - 0.45), s.y2 - L * Math.sin(a - 0.45)], [s.x2 - L * Math.cos(a + 0.45), s.y2 - L * Math.sin(a + 0.45)]];
        g.appendChild(el('polygon', { points: p.map(q => q.join(',')).join(' '), fill: s.color }));
      }
      // fat invisible hit area
      g.appendChild(el('line', { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, stroke: 'transparent', 'stroke-width': 14 }));
      return g;
    }
    case 'pen': {
      // Visible ink + a fat invisible copy of the same path as the hit area for the select tool.
      const g = el('g', common), p = s.points || [];
      if (!p.length) return g;
      const d = penPathD(p), dot = isPenDot(p);
      g.appendChild(dot
        ? el('circle', { class: 'ink', cx: p[0][0], cy: p[0][1], r: lw / 2, fill: s.color })
        : el('path', { class: 'ink', d, fill: 'none', stroke: s.color, 'stroke-width': lw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      g.appendChild(el('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(14, lw + 10), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      return g;
    }
    case 'text': {
      const t = el('text', { ...common, x: s.x, y: s.y, fill: s.color, 'font-size': s.size || 20, 'font-weight': 600, 'font-family': 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', 'dominant-baseline': 'hanging' });
      String(s.text).split('\n').forEach((ln, k) => { const sp = el('tspan', { x: s.x, dy: k ? (s.size || 20) * 1.25 : 0 }); sp.textContent = ln; t.appendChild(sp); });
      return t;
    }
  }
  return el('g', {});
}

function render(draft) {
  if (mode === 'crop' && cropTool === 'keep' && !edits.crop) edits.crop = fullCrop();
  if (mode !== 'crop' && isFullCrop(edits.crop)) edits.crop = null;
  overlay.replaceChildren();
  paintStyleOpts();
  edits.shapes.forEach((s, i) => { const n = shapeNode(s, i); if (i === selected) n.classList.add('selected'); overlay.appendChild(n); });
  if (draft && draft.type !== 'crop' && draft.type !== 'cut') overlay.appendChild(shapeNode(draft, -1));
  renderCrop(draft);
  if (!mode && $('showBreaks').checked && breaks.length > 2) {
    const s = 1 / zoom;
    breaks.slice(1, -1).forEach((y, i) => {
      const x0 = edits.crop?.x || 0, x1 = x0 + (edits.crop?.w || rec.cssWidth);
      overlay.appendChild(el('line', { x1: x0, x2: x1, y1: y, y2: y, class: 'pb-line', 'stroke-width': 1.5 * s, 'stroke-dasharray': `${6 * s} ${5 * s}` }));
      const label = `Page ${i + 2}`;
      overlay.appendChild(el('rect', { x: x1 - 62 * s, y: y - 9 * s, width: 56 * s, height: 18 * s, rx: 9 * s, class: 'pb-pill' }));
      const t = el('text', { x: x1 - 34 * s, y: y + 4 * s, 'text-anchor': 'middle', class: 'pb-label', style: `font-size:${11 * s}px` });
      t.textContent = label; overlay.appendChild(t);
    });
  }
}

// Crop rect + removed sections. Everything outside the kept area is dimmed; removed sections
// are dimmed and hatched with a "− N px" pill on them. In crop mode they get handles.
const MASK = 'rgba(15,23,41,.55)';
function renderCrop(draft) {
  const W = rec.cssWidth, H = rec.cssHeight, s = 1 / zoom, active = mode === 'crop';
  const crop = draft?.type === 'crop' ? draft : edits.crop;
  const c = crop || { x: 0, y: 0, w: W, h: H };
  let cuts = edits.cuts.map((k, i) => ({ ...k, i }));
  if (draft?.type === 'cut') cuts = draft.i >= 0 ? cuts.map(k => (k.i === draft.i ? { ...draft } : k)) : [...cuts, { ...draft, i: -1 }];
  if (!crop && !cuts.length) return;
  const defs = el('defs', {});
  const pat = el('pattern', { id: 'ptp-hatch', patternUnits: 'userSpaceOnUse', width: 10 * s, height: 10 * s, patternTransform: 'rotate(45)' });
  pat.appendChild(el('rect', { width: 10 * s, height: 10 * s, fill: MASK }));
  pat.appendChild(el('line', { x1: 0, y1: 0, x2: 0, y2: 10 * s, stroke: 'rgba(255,255,255,.3)', 'stroke-width': 3 * s }));
  defs.appendChild(pat); overlay.appendChild(defs);
  if (crop) {
    overlay.appendChild(el('path', { d: `M0 0H${W}V${H}H0Z M${c.x} ${c.y}v${c.h}h${c.w}v${-c.h}Z`, fill: MASK, 'fill-rule': 'evenodd', 'pointer-events': 'none' }));
    if (active && cropTool === 'keep') overlay.appendChild(el('rect', { x: c.x, y: c.y, width: c.w, height: c.h, fill: 'transparent', 'data-h': 'crop-move', style: 'cursor:move' }));
  }
  // Removed sections, clipped to the kept area.
  for (const k of cuts) {
    const a = Math.min(k.from, k.to), b = Math.max(k.from, k.to), sel = active && k.i === cutSel && k.i >= 0;
    const r = k.axis === 'x'
      ? { x: Math.max(a, c.x), y: c.y, width: Math.min(b, c.x + c.w) - Math.max(a, c.x), height: c.h }
      : { x: c.x, y: Math.max(a, c.y), width: c.w, height: Math.min(b, c.y + c.h) - Math.max(a, c.y) };
    if (r.width <= 0 || r.height <= 0) continue;
    overlay.appendChild(el('rect', { ...r, fill: 'url(#ptp-hatch)', class: 'cut', 'data-h': 'cut-move', 'data-i': k.i }));
    // Seam lines on both edges: dashed white, solid blue when selected.
    const edge = { stroke: sel ? '#0b57d0' : '#fff', 'stroke-width': (sel ? 2.5 : 1.5) * s, 'stroke-dasharray': sel ? 'none' : `${6 * s} ${4 * s}`, 'pointer-events': 'none' };
    const lines = k.axis === 'x'
      ? [[r.x, r.y, r.x, r.y + r.height], [r.x + r.width, r.y, r.x + r.width, r.y + r.height]]
      : [[r.x, r.y, r.x + r.width, r.y], [r.x, r.y + r.height, r.x + r.width, r.y + r.height]];
    for (const [x1, y1, x2, y2] of lines) overlay.appendChild(el('line', { x1, y1, x2, y2, ...edge }));
    // "− 340 px" pill (+ a delete button in crop mode).
    const label = `− ${Math.round(k.axis === 'x' ? r.width : r.height)} px`;
    const pw = (label.length * 6.4 + 22) * s, ph = 22 * s;
    const px = r.x + r.width / 2 - pw / 2;
    const py = k.axis === 'x' ? r.y + Math.min(r.height / 2, 160 * s) - ph / 2 : r.y + r.height / 2 - ph / 2;
    const g = el('g', { 'pointer-events': 'none' });
    g.appendChild(el('rect', { x: px, y: py, width: pw, height: ph, rx: ph / 2, fill: sel ? '#0b57d0' : '#1f1f1f', stroke: 'rgba(255,255,255,.7)', 'stroke-width': s }));
    const t = el('text', { x: px + pw / 2, y: py + ph / 2 + 4 * s, 'text-anchor': 'middle', class: 'cut-label', style: `font-size:${12 * s}px` });
    t.textContent = label; g.appendChild(t);
    overlay.appendChild(g);
    if (active && k.i >= 0) {
      const R = 11 * s;
      const bx = k.axis === 'x' ? px + pw / 2 : px + pw + R + 6 * s, by = k.axis === 'x' ? py + ph + R + 6 * s : py + ph / 2;
      const del = el('g', { class: 'cut-del', 'data-h': 'cut-del', 'data-i': k.i, style: 'cursor:pointer' });
      const tip = el('title', {}); tip.textContent = 'Put this section back'; del.appendChild(tip);
      del.appendChild(el('circle', { cx: bx, cy: by, r: R, fill: '#fff', stroke: 'rgba(0,0,0,.3)', 'stroke-width': s }));
      const d = 4 * s;
      del.appendChild(el('path', { d: `M${bx - d} ${by - d}L${bx + d} ${by + d}M${bx + d} ${by - d}L${bx - d} ${by + d}`, stroke: '#1f1f1f', 'stroke-width': 1.8 * s, 'stroke-linecap': 'round' }));
      overlay.appendChild(del);
      // Fat invisible grab areas on the two edges.
      const cur = k.axis === 'x' ? 'ew-resize' : 'ns-resize';
      lines.forEach(([x1, y1, x2, y2], j) => overlay.appendChild(el('line', { x1, y1, x2, y2, stroke: 'transparent', 'stroke-width': 12 * s, 'data-h': j ? 'cut-to' : 'cut-from', 'data-i': k.i, style: `cursor:${cur}` })));
    }
  }
  if (crop) {
    overlay.appendChild(el('rect', { x: c.x, y: c.y, width: c.w, height: c.h, fill: 'none', stroke: '#fff', 'stroke-width': 1.5 * s, 'stroke-dasharray': active ? 'none' : `${6 * s} ${4 * s}`, 'pointer-events': 'none' }));
    if (active) {
      const hs = 10 * s, cx = c.x + c.w / 2, cy = c.y + c.h / 2, x1 = c.x + c.w, y1 = c.y + c.h;
      const pts = { nw: [c.x, c.y], n: [cx, c.y], ne: [x1, c.y], e: [x1, cy], se: [x1, y1], s: [cx, y1], sw: [c.x, y1], w: [c.x, cy] };
      const cur = { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' };
      for (const [h, [x, y]] of Object.entries(pts)) {
        overlay.appendChild(el('rect', { x: x - hs / 2, y: y - hs / 2, width: hs, height: hs, rx: 2 * s, fill: '#fff', stroke: '#0b57d0', 'stroke-width': 1.5 * s, 'data-h': `crop-${h}`, style: `cursor:${cur[h]}-resize` }));
      }
    }
  }
}

// ------------------------------------------------------------------ editing
const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7', '#111827', '#ffffff'];
for (const c of COLORS) {
  const b = document.createElement('button');
  b.style.background = c; b.dataset.c = c; b.title = c;
  b.setAttribute('aria-label', `Colour ${c}`);
  b.setAttribute('aria-pressed', String(c === color));
  if (c === color) b.classList.add('on');
  $('swatches').appendChild(b);
}
$('swatches').onclick = e => {
  const c = e.target.dataset.c; if (!c) return;
  color = c;
  $('swatches').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b === e.target); b.setAttribute('aria-pressed', String(b === e.target)); });
  if (selected >= 0 && edits.shapes[selected].type !== 'redact') { edits.shapes[selected].color = c; commit(); }
};

// Style pickers beside the colours. Line thickness: for the pen and the outline shapes (and when
// one of those is selected, to restyle it). Text size in pt: for the text tool / a selected text.
// Highlight and Redact get neither.
const STROKE_TYPES = new Set(['pen', 'rect', 'ellipse', 'arrow', 'line']);
const TEXT_PT = [9, 10, 12, 14, 16, 18, 24, 32, 48, 72];
const PX_PER_PT = 4 / 3; // shapes are in CSS px of the capture; 1pt = 1/72in, 1px = 1/96in
let textPt = 16;
const ptOf = s => Math.round((s.size || 20) / PX_PER_PT);
function paintStyleOpts() {
  const s = selected >= 0 ? edits.shapes[selected] : null;
  const kind = s ? s.type : tool;
  const stroke = mode === 'draw' && STROKE_TYPES.has(kind);
  const text = mode === 'draw' && kind === 'text';
  $('penOpts').hidden = !stroke;
  $('textOpts').hidden = !text;
  const w = s && STROKE_TYPES.has(s.type) ? s.width || 3 : penWidth;
  $('penWidths').querySelectorAll('[data-w]').forEach(b => {
    const on = Number(b.dataset.w) === w;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
  });
  if (text) {
    const pt = s?.type === 'text' ? ptOf(s) : textPt;
    const sel = $('textSize');
    // A size not in the list (e.g. text drawn before this picker existed) gets its own option.
    sel.querySelector('[data-extra]')?.remove();
    if (!TEXT_PT.includes(pt)) {
      const o = new Option(`${pt} pt`, pt); o.dataset.extra = '1';
      sel.insertBefore(o, [...sel.options].find(x => Number(x.value) > pt) || null);
    }
    sel.value = String(pt);
  }
}
for (const [name, w] of Object.entries(PEN_WIDTHS)) {
  const b = document.createElement('button');
  b.dataset.w = w; b.setAttribute('role', 'radio'); b.title = `${name[0].toUpperCase()}${name.slice(1)} line`;
  b.setAttribute('aria-label', b.title);
  const dot = document.createElement('span'); dot.className = 'dot';
  dot.style.width = dot.style.height = `${{ 2: 4, 4: 7, 8: 11 }[w]}px`;
  b.appendChild(dot);
  $('penWidths').appendChild(b);
}
$('penWidths').onclick = e => {
  const b = e.target.closest('[data-w]'); if (!b) return;
  penWidth = Number(b.dataset.w);
  const s = selected >= 0 ? edits.shapes[selected] : null;
  if (s && STROKE_TYPES.has(s.type)) { s.width = penWidth; commit(); }
  paintStyleOpts();
};
for (const pt of TEXT_PT) $('textSize').appendChild(new Option(`${pt} pt`, pt));
$('textSize').onchange = e => {
  textPt = Number(e.target.value);
  const s = selected >= 0 ? edits.shapes[selected] : null;
  if (s?.type === 'text') { s.size = textPt * PX_PER_PT; commit(); }
  const box = doc.querySelector('.text-input'); // a text being typed follows the picker too
  if (box) { box.style.fontSize = `${textPt * PX_PER_PT * zoom}px`; box.focus(); }
  paintStyleOpts();
};

function setTool(t) {
  tool = t; selected = -1;
  document.body.className = document.body.className.replace(/tool-\w+/g, '').trim() + ` tool-${t}`;
  $('drawTools').querySelectorAll('[data-tool]').forEach(b => { b.classList.toggle('active', b.dataset.tool === t); b.setAttribute('aria-pressed', String(b.dataset.tool === t)); });
  render();
}
$('drawTools').onclick = e => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); };

const CROP_HINTS = {
  keep: 'Drag the edges in, or drag out a new area, to choose what to keep',
  rows: 'Drag down over a section to cut it out',
  cols: 'Drag across a strip to cut it out',
};
function setCropTool(t) {
  cropTool = t; cutSel = -1;
  document.body.className = document.body.className.replace(/crop-\w+/g, '').trim() + ` crop-${t}`;
  $('cropSeg').querySelectorAll('[data-crop]').forEach(b => { b.classList.toggle('on', b.dataset.crop === t); b.setAttribute('aria-checked', String(b.dataset.crop === t)); });
  $('cropHint').textContent = CROP_HINTS[t];
  render();
}
$('cropSeg').onclick = e => { const b = e.target.closest('[data-crop]'); if (b) setCropTool(b.dataset.crop); };

// Draw and Crop are two modes sharing the floating toolbar, the undo history and auto-save.
function setMode(m) {
  mode = m;
  const b = document.body;
  b.classList.toggle('editing', !!m);
  b.classList.toggle('mode-draw', m === 'draw');
  b.classList.toggle('mode-crop', m === 'crop');
  $('editbar').hidden = !m;
  $('editbar').setAttribute('aria-label', m === 'crop' ? 'Crop tools' : 'Drawing tools');
  $('drawTools').hidden = m !== 'draw';
  $('drawTip').hidden = m !== 'draw' || tipDismissed();
  $('cropTools').hidden = m !== 'crop';
  $('resetEdits').title = m === 'crop' ? 'Undo all cropping and put every removed section back' : 'Remove all drawings';
  for (const [btn, on] of [[$('editBtn'), m === 'draw'], [$('cropBtn'), m === 'crop']]) {
    btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', String(on));
  }
  selected = -1; cutSel = -1;
  if (m === 'draw') setTool(tool);
  else if (m === 'crop') setCropTool(cropTool);
  else refreshBreaks();
  render();
}
// "Use Redact, not paint" tip above the Draw toolbar, until dismissed.
const tipDismissed = () => { try { return localStorage.getItem('ptp-redact-tip') === 'off'; } catch { return false; } };
$('tipClose').onclick = () => { try { localStorage.setItem('ptp-redact-tip', 'off'); } catch { /* ignore */ } $('drawTip').hidden = true; };
$('tipUseRedact').onclick = () => setTool('redact');
$('editBtn').onclick = () => setMode(mode === 'draw' ? null : 'draw');
$('cropBtn').onclick = () => setMode(mode === 'crop' ? null : 'crop');
$('doneEdit').onclick = () => setMode(null);

let saveTimer;
function commit() {
  history.push(JSON.stringify(storedEdits())); future.length = 0;
  if (history.length > 100) history.shift();
  render(); persist();
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    rec = await updateCapture(id, { edits: storedEdits() });
    refreshBreaks();
    syncThumb();
  }, 250);
}
// The gallery thumbnail (popup, files page) is redrawn with the redaction boxes on it, so it
// never shows what was redacted.
async function syncThumb() {
  const key = thumbKey(rec);
  if (!rec.thumb || key === (rec.thumbKey ?? '[]')) return;
  try {
    const thumb = await makeRedactedThumb(rec);
    if (thumbKey(rec) === key) rec = await updateCapture(id, { thumb, thumbKey: key });
  } catch (err) { console.warn('Could not update the thumbnail', err); }
}
// Best-effort save of a pending change when the tab is closed right after an edit.
addEventListener('pagehide', () => { clearTimeout(saveTimer); updateCapture(id, { edits: storedEdits() }); });
function undo() { if (history.length < 2) return; future.push(history.pop()); edits = normEdits(JSON.parse(history.at(-1))); selected = -1; cutSel = -1; render(); persist(); }
function redo() { if (!future.length) return; history.push(future.pop()); edits = normEdits(JSON.parse(history.at(-1))); selected = -1; cutSel = -1; render(); persist(); }
$('undo').onclick = undo; $('redo').onclick = redo;
$('resetEdits').onclick = () => {
  if (mode === 'crop') { edits.crop = null; edits.cuts = []; cutSel = -1; }
  else { edits.shapes = []; selected = -1; }
  commit();
};

const pt = e => { const r = overlay.getBoundingClientRect(); return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom }; };
const norm = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clampRect = r => {
  const x = clamp(r.x, 0, rec.cssWidth), y = clamp(r.y, 0, rec.cssHeight);
  return { x, y, w: clamp(r.x + r.w, 0, rec.cssWidth) - x, h: clamp(r.y + r.h, 0, rec.cssHeight) - y };
};
const roundRect = r => { const x = Math.round(r.x), y = Math.round(r.y); return { x, y, w: Math.round(r.x + r.w) - x, h: Math.round(r.y + r.h) - y }; };

// Sorted, rounded, merged removed sections; returns the index of the one containing `keep`.
function tidyCuts(keep) {
  const out = [];
  let found = -1;
  for (const axis of ['y', 'x']) {
    const max = axis === 'x' ? rec.cssWidth : rec.cssHeight;
    const iv = edits.cuts.filter(k => (k.axis === 'x' ? 'x' : 'y') === axis)
      .map(k => [clamp(Math.round(Math.min(k.from, k.to)), 0, max), clamp(Math.round(Math.max(k.from, k.to)), 0, max)])
      .filter(([a, b]) => b - a >= 1).sort((a, b) => a[0] - b[0]);
    for (const [a, b] of iv) {
      const last = out.at(-1);
      if (last && last.axis === axis && a <= last.to) last.to = Math.max(last.to, b);
      else out.push({ axis, from: a, to: b });
    }
  }
  if (keep) found = out.findIndex(k => k.axis === keep.axis && k.from <= keep.mid && keep.mid <= k.to);
  edits.cuts = out;
  return found;
}

let drag = null;
overlay.addEventListener('pointerdown', e => {
  if (!mode || e.button !== 0) return;
  const p = pt(e);
  if (mode === 'crop') return cropDown(e, p);
  if (tool === 'text') { e.preventDefault(); openTextInput(p); return; }
  overlay.setPointerCapture(e.pointerId);
  if (tool === 'select') {
    const n = e.target.closest('.shape');
    selected = n ? Number(n.dataset.i) : -1;
    if (selected >= 0) drag = { mode: 'move', start: p, orig: structuredClone(edits.shapes[selected]) };
    render();
    return;
  }
  if (tool === 'pen') {
    e.preventDefault();
    const s = { type: 'pen', points: [[p.x, p.y]], color, width: penWidth };
    const node = shapeNode(s, -1);
    overlay.appendChild(node);
    drag = { mode: 'pen', shape: s, node };
    return;
  }
  drag = { mode: 'draw', start: p };
});
// Pen: collect every pointer sample (coalesced events give the in-between ones on fast strokes),
// skipping those closer than ~1 screen px, and update just the live path element.
function penMove(e) {
  const d = drag, pts = d.shape.points, min = 1 / zoom;
  const evs = e.getCoalescedEvents?.() || [];
  for (const ev of evs.length ? evs : [e]) {
    const q = pt(ev), l = pts.at(-1);
    if (Math.hypot(q.x - l[0], q.y - l[1]) >= min) pts.push([q.x, q.y]);
  }
  const ink = d.node.querySelector('.ink');
  if (pts.length > 1 && ink.tagName !== 'path') { d.node.replaceWith(d.node = shapeNode(d.shape, -1)); return; }
  const path = penPathD(pts);
  d.node.querySelectorAll('path').forEach(n => n.setAttribute('d', path));
}
function penUp(d) {
  // Simplify within half a screen pixel: invisible, but keeps long strokes small in storage.
  const s = d.shape;
  s.points = simplifyStroke(s.points, Math.min(1.5, 0.5 / zoom));
  edits.shapes.push(s);
  commit();
}
overlay.addEventListener('pointermove', e => {
  if (!drag) return;
  const p = pt(e);
  if (drag.mode.startsWith('crop') || drag.mode.startsWith('cut')) return cropMove(p);
  if (drag.mode === 'pen') return penMove(e);
  if (drag.mode === 'move') {
    const dx = p.x - drag.start.x, dy = p.y - drag.start.y, o = drag.orig, s = edits.shapes[selected];
    if (o.type === 'pen') s.points = o.points.map(([x, y]) => [Math.round((x + dx) * 10) / 10, Math.round((y + dy) * 10) / 10]);
    else if ('x1' in o) Object.assign(s, { x1: o.x1 + dx, y1: o.y1 + dy, x2: o.x2 + dx, y2: o.y2 + dy });
    else Object.assign(s, { x: o.x + dx, y: o.y + dy });
    drag.moved = true; render(); return;
  }
  drag.draft = makeShape(drag.start, p);
  render(drag.draft);
});
overlay.addEventListener('pointerup', e => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.mode.startsWith('crop') || d.mode.startsWith('cut')) return cropUp(d, e.altKey);
  if (d.mode === 'move') { if (d.moved) commit(); return; }
  if (d.mode === 'pen') return penUp(d);
  const s = d.draft; if (!s) return render();
  const tiny = 'x1' in s ? Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 4 : s.w < 4 || s.h < 4;
  if (tiny) return render();
  edits.shapes.push(s);
  commit();
});
overlay.addEventListener('pointercancel', () => { drag = null; render(); });

// ------------------------------------------------------------------ crop mode
// Keep area: drag a rectangle, then move it or pull its 8 handles. Remove rows / columns: drag
// over a band; its edges can be dragged, the body moved, × (or Delete) puts it back.
function cropDown(e, p) {
  const t = e.target.closest('[data-h]'), h = t?.dataset.h, i = Number(t?.dataset.i);
  if (h === 'cut-del') { edits.cuts.splice(i, 1); cutSel = -1; commit(); return; }
  overlay.setPointerCapture(e.pointerId);
  e.preventDefault();
  if (h === 'crop-move' && isFullCrop(edits.crop)) {
    drag = { mode: 'crop-new', start: p };
  } else if (h?.startsWith('crop-') && edits.crop) {
    drag = { mode: 'crop-edit', which: h.slice(5), start: p, orig: { ...edits.crop } };
  } else if (h?.startsWith('cut-') && edits.cuts[i] && (h !== 'cut-move' || cropTool !== 'keep')) {
    cutSel = i;
    drag = { mode: 'cut-edit', which: h.slice(4), i, start: p, orig: { ...edits.cuts[i] } };
    render();
  } else if (cropTool === 'keep') {
    drag = { mode: 'crop-new', start: p };
  } else {
    cutSel = -1;
    drag = { mode: 'cut-new', start: p, axis: cropTool === 'cols' ? 'x' : 'y' };
  }
}
function cropMove(p) {
  const d = drag, dx = p.x - d.start.x, dy = p.y - d.start.y;
  d.moved ||= Math.hypot(dx, dy) > 2;
  if (!d.moved) return;
  if (d.mode === 'crop-new') {
    edits.crop = null;
    d.draft = { type: 'crop', ...clampRect(norm(d.start, p)) };
    return render(d.draft);
  }
  if (d.mode === 'crop-edit') {
    const o = d.orig, w = d.which;
    if (w === 'move') {
      edits.crop = { ...o, x: clamp(o.x + dx, 0, rec.cssWidth - o.w), y: clamp(o.y + dy, 0, rec.cssHeight - o.h) };
    } else {
      const a = { x: o.x, y: o.y }, b = { x: o.x + o.w, y: o.y + o.h };
      if (w.includes('n')) a.y += dy;
      if (w.includes('s')) b.y += dy;
      if (w.includes('w')) a.x += dx;
      if (w.includes('e')) b.x += dx;
      edits.crop = clampRect(norm(a, b));
    }
    return render();
  }
  const axis = d.mode === 'cut-new' ? d.axis : d.orig.axis === 'x' ? 'x' : 'y';
  const max = axis === 'x' ? rec.cssWidth : rec.cssHeight, delta = axis === 'x' ? dx : dy;
  if (d.mode === 'cut-new') {
    const v0 = d.start[axis], v1 = clamp(p[axis], 0, max);
    d.draft = { type: 'cut', axis, from: Math.min(v0, v1), to: Math.max(v0, v1), i: -1 };
    return render(d.draft);
  }
  const o = d.orig, k = edits.cuts[d.i];
  if (d.which === 'move') {
    const len = o.to - o.from, from = clamp(o.from + delta, 0, max - len);
    Object.assign(k, { from, to: from + len });
  } else {
    const v = clamp(o[d.which] + delta, 0, max), other = d.which === 'from' ? o.to : o.from;
    Object.assign(k, { from: Math.min(v, other), to: Math.max(v, other) });
  }
  render();
}
// Horizontal edges snap out of text lines (to the nearer edge of the line), so a cut never
// slices a line of text in half. Hold Alt to place an edge freely.
function snapY(v) {
  const text = rec.text || [];
  for (let n = 0; n < 4; n++) {
    const t = text.find(t => t.h < 120 && v > t.y + 1 && v < t.y + t.h - 1);
    if (!t) break;
    v = v - t.y < t.y + t.h - v ? t.y : t.y + t.h;
  }
  return v;
}
function snapRectY(r) { const y0 = snapY(r.y), y1 = snapY(r.y + r.h); return { ...r, y: y0, h: y1 - y0 }; }
function cropUp(d, free) {
  const sy = free ? v => v : snapY;
  if (!d.moved) {
    // A plain click on the page (not on a section) clears the selection.
    if (d.mode === 'crop-new' || d.mode === 'cut-new') { cutSel = -1; render(); }
    return;
  }
  if (d.mode === 'crop-new') {
    const r = d.draft;
    if (!r || r.w < 8 || r.h < 8) { edits.crop = JSON.parse(history.at(-1)).crop; return render(); }
    edits.crop = roundRect(free ? r : snapRectY(r));
  } else if (d.mode === 'crop-edit') {
    edits.crop = roundRect(free || d.which === 'move' ? edits.crop : snapRectY(edits.crop));
    if (edits.crop.w < 8 || edits.crop.h < 8) edits.crop = d.orig;
  } else if (d.mode === 'cut-new') {
    const k = d.draft;
    if (!k || k.to - k.from < 4) { cutSel = -1; return render(); }
    edits.cuts.push(k.axis === 'y' ? { axis: 'y', from: sy(k.from), to: sy(k.to) } : { axis: k.axis, from: k.from, to: k.to });
    cutSel = tidyCuts({ axis: k.axis, mid: (k.from + k.to) / 2 });
  } else {
    const k = edits.cuts[d.i];
    if (k.axis !== 'x') Object.assign(k, { from: sy(k.from), to: sy(k.to) });
    if (k.to - k.from < 2) edits.cuts.splice(d.i, 1);
    cutSel = k.to - k.from < 2 ? -1 : tidyCuts({ axis: k.axis === 'x' ? 'x' : 'y', mid: (k.from + k.to) / 2 });
  }
  commit();
}

function makeShape(a, b) {
  const lw = penWidth;
  switch (tool) {
    case 'arrow': case 'line': return { type: tool, x1: a.x, y1: a.y, x2: b.x, y2: b.y, color, width: lw };
    case 'redact': return { type: 'redact', ...norm(a, b), color: '#000' };
    case 'highlight': return { type: 'highlight', ...norm(a, b), color: color === '#ef4444' ? '#facc15' : color };
    default: return { type: tool, ...norm(a, b), color, width: lw };
  }
}

function openTextInput(p) {
  const box = document.createElement('div');
  box.className = 'text-input'; box.contentEditable = 'true';
  box.style.left = `${p.x * zoom}px`; box.style.top = `${p.y * zoom}px`;
  box.style.color = color; box.style.fontSize = `${textPt * PX_PER_PT * zoom}px`;
  doc.appendChild(box);
  setTimeout(() => box.focus());
  const finish = () => {
    const t = box.innerText.replace(/\n$/, '');
    box.remove();
    if (t.trim()) { edits.shapes.push({ type: 'text', x: p.x, y: p.y, text: t, color, size: textPt * PX_PER_PT }); commit(); }
  };
  // Picking a size from the toolbar mid-typing shouldn't end the text; anything else does.
  const onBlur = e => { if (e.relatedTarget === $('textSize')) return; box.removeEventListener('blur', onBlur); finish(); };
  box.addEventListener('blur', onBlur);
  $('textSize').addEventListener('blur', () => { if (box.isConnected && document.activeElement !== box) box.focus(); }, { once: true });
  box.addEventListener('keydown', e => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); box.blur(); } });
}

addEventListener('keydown', e => {
  if (e.target.isContentEditable || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mode && mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mode && mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (mode === 'draw' && selected >= 0) { edits.shapes.splice(selected, 1); selected = -1; commit(); }
    else if (mode === 'crop' && cutSel >= 0) { edits.cuts.splice(cutSel, 1); cutSel = -1; commit(); }
    return;
  }
  if (e.key === 'Escape') {
    if (menu.classList.contains('open')) return closeMenu(true);
    if (drag) { drag = null; edits = normEdits(JSON.parse(history.at(-1))); return render(); }
    if (mode) setMode(null);
    return;
  }
  if (mod || e.altKey) return;
  if (e.key === 'd') return setMode(mode === 'draw' ? null : 'draw');
  if (e.key === 'c') return setMode(mode === 'crop' ? null : 'crop');
  if (mode === 'draw') {
    const map = { v: 'select', p: 'pen', r: 'rect', o: 'ellipse', a: 'arrow', l: 'line', t: 'text', h: 'highlight', x: 'redact' };
    if (map[e.key]) setTool(map[e.key]);
  } else if (mode === 'crop') {
    const map = { k: 'keep', r: 'rows', R: 'cols' };
    if (map[e.key]) setCropTool(map[e.key]);
  }
});

// ------------------------------------------------------------------ export
// Download menu: behaves like Chrome's cr-action-menu (arrow keys, Home/End, Esc, Tab closes).
const menu = $('dlMenu'), menuBtn = $('dlMenuBtn');
const menuItems = () => [...menu.querySelectorAll('[role="menuitem"]')];
function openMenu(focusIndex = null) {
  menu.classList.add('open'); menuBtn.setAttribute('aria-expanded', 'true');
  if (focusIndex !== null) { const items = menuItems(); items.at(focusIndex)?.focus(); }
}
function closeMenu(refocus = false) {
  if (!menu.classList.contains('open')) return;
  menu.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false');
  if (refocus) menuBtn.focus();
}
menuBtn.onclick = e => {
  e.stopPropagation();
  if (menu.classList.contains('open')) return closeMenu();
  openMenu(e.detail === 0 ? 0 : null); // keyboard activation (detail 0) focuses the first item
};
menuBtn.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openMenu(e.key === 'ArrowDown' ? 0 : -1); }
});
menu.addEventListener('keydown', e => {
  const items = menuItems(), i = items.indexOf(document.activeElement);
  const go = n => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i < 0 ? -1 : i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(-1);
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
  else if (e.key === 'Tab') closeMenu();
});
document.addEventListener('click', e => { if (!menu.contains(e.target)) closeMenu(); });
menu.onclick = async e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  closeMenu(true);
  const act = b.dataset.act;
  if (act === 'pdf' || act === 'png' || act === 'jpg') return download(act);
  if (act === 'open') return chrome.tabs.create({ url: rec.url });
  if (act === 'copyurl') { await navigator.clipboard.writeText(rec.url); return toast('URL copied'); }
  if (act === 'files') return (location.href = 'files.html');
  if (act === 'delete') return deleteThisCapture();
};
// Delete is in the top bar and in the menu; both ask for confirmation first.
async function deleteThisCapture() {
  if (!confirm('Delete this capture? This cannot be undone.')) return;
  clearTimeout(saveTimer);
  await deleteCapture(id); location.href = 'files.html';
}
$('deleteBtn').onclick = deleteThisCapture;
$('dlPdf').onclick = () => download('pdf');

async function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: !!settings.saveAs });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
}

export async function buildExport(fmt, onProgress) {
  rec = await getCapture(id);
  if (fmt === 'pdf') {
    const blob = await exportPDF(rec, settings, onProgress);
    return [{ blob, ext: 'pdf', suffix: '' }];
  }
  return exportImage(rec, fmt, settings.jpgQuality, onProgress);
}

async function download(fmt) {
  const t = toast(fmt === 'pdf' ? 'Creating PDF…' : `Encoding ${fmt.toUpperCase()}…`, 0);
  t.progress(0);
  try {
    clearTimeout(saveTimer); await updateCapture(id, { edits: storedEdits() });
    const files = await buildExport(fmt, p => t.progress(p));
    const named = { ...rec, ...new CaptureSource(rec).labels() }; // no redacted text in the file name
    for (const f of files) {
      const name = buildFilename(settings.filenameTemplate, named, f.ext, settings.directory).replace(/(\.\w+)$/, `${f.suffix}$1`);
      await saveBlob(f.blob, name);
    }
    t.done(files.length > 1 ? `Saved ${files.length} files` : 'Download started');
  } catch (err) {
    console.error(err);
    t.done(`Export failed: ${err.message}`, 5000);
  }
}

$('copyBtn').onclick = async () => {
  const t = toast('Copying image…', 0);
  try {
    // Clipboard images must be PNG; keep it below ~25 MP so apps like Google Docs accept it.
    const src = new CaptureSource(await getCapture(id));
    const k = Math.min(1, Math.sqrt(25_000_000 / (src.width * src.height)), 32000 / src.height);
    const w = Math.max(1, Math.round(src.width * k)), h = Math.max(1, Math.round(src.height * k));
    const c = new OffscreenCanvas(w, h);
    await src.draw(c.getContext('2d'), 0, 0, src.cssWidth, src.cssHeight, 0, 0, w, h);
    src.close();
    const blob = await c.convertToBlob({ type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    t.done(k < 1 ? 'Copied (resized to fit clipboard limits)' : 'Image copied to clipboard');
  } catch (err) { t.done(`Copy failed: ${err.message}`, 4000); }
};

// Expose for automated tests.
window.ptp = { buildExport, getRec: () => getCapture(id), refreshBreaks, setEdits: async e => { edits = normEdits(e); commit(); clearTimeout(saveTimer); rec = await updateCapture(id, { edits: storedEdits() }); await syncThumb(); await refreshBreaks(); }, setMode, getEdits: () => storedEdits() };

refreshBreaks();
render();
syncThumb();
