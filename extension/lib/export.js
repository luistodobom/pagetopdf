// Rendering of a stored capture (tiles + non-destructive edits) and the
// PNG/JPG/PDF exporters. Runs in extension pages (result page, offscreen doc).
import { PDFWriter, deflate } from './pdf.js';
import { PAPER_SIZES } from './settings.js';
import { formatDateTime } from './util.js';

const MAX_CANVAS_H = 32000;
const MAX_CANVAS_AREA = 250_000_000;

// Kept intervals of [lo, hi] once the removed bands are taken out, each with its offset in
// output space: [{ o0, o1, out0 }]. Removing everything falls back to the whole range.
export function keptSegments(lo, hi, cuts = []) {
  const iv = cuts.map(c => [Math.max(lo, Math.min(c.from, c.to)), Math.min(hi, Math.max(c.from, c.to))])
    .filter(([a, b]) => b - a > 0.5).sort((a, b) => a[0] - b[0]);
  const segs = [];
  let cur = lo, out = 0;
  for (const [a, b] of iv) {
    if (a > cur) { segs.push({ o0: cur, o1: a, out0: out }); out += a - cur; }
    cur = Math.max(cur, b);
  }
  if (hi > cur) segs.push({ o0: cur, o1: hi, out0: out });
  return segs.length ? segs : [{ o0: lo, o1: hi, out0: 0 }];
}
const segsLength = segs => segs.reduce((n, s) => n + s.o1 - s.o0, 0);
// Output -> original coordinate (a point exactly on a seam goes to the start of the next part).
function toOrig(v, segs) {
  for (const s of segs) if (v < s.out0 + s.o1 - s.o0) return s.o0 + Math.max(0, v - s.out0);
  const l = segs.at(-1); return l.o0 + (v - l.out0);
}
// Original -> output coordinate; points inside a removed band (or outside the crop) clamp to the seam.
function toOut(v, segs) {
  for (const s of segs) {
    if (v < s.o0) return s.out0;
    if (v <= s.o1) return s.out0 + v - s.o0;
  }
  const l = segs.at(-1); return l.out0 + l.o1 - l.o0;
}

// edits = { crop: {x,y,w,h} | null, cuts: [{ axis: 'y'|'x', from, to }], shapes: [...] },
// all in CSS px of the original capture. Output space = the crop rect with the cut bands
// (horizontal 'y' bands, vertical 'x' columns) removed and the remaining parts joined.
export class CaptureSource {
  constructor(rec) {
    this.rec = rec;
    this.scale = rec.scale;
    this.cache = new Map();
    const crop = rec.edits?.crop;
    this.crop = crop && crop.w > 4 && crop.h > 4 ? crop : { x: 0, y: 0, w: rec.cssWidth, h: rec.cssHeight };
    this.shapes = rec.edits?.shapes || [];
    const cuts = (rec.edits?.cuts || []).filter(c => c && Number.isFinite(c.from) && Number.isFinite(c.to));
    this.ySegs = keptSegments(this.crop.y, this.crop.y + this.crop.h, cuts.filter(c => c.axis !== 'x'));
    this.xSegs = keptSegments(this.crop.x, this.crop.x + this.crop.w, cuts.filter(c => c.axis === 'x'));
    this.cssWidth = segsLength(this.xSegs);
    this.cssHeight = segsLength(this.ySegs);
    this.width = Math.round(this.cssWidth * this.scale);
    this.height = Math.round(this.cssHeight * this.scale);
  }

  // Output CSS coordinate -> original capture coordinate (and back, clamping removed parts).
  toOrigX(x) { return toOrig(x, this.xSegs); }
  toOrigY(y) { return toOrig(y, this.ySegs); }
  toOutX(x) { return toOut(x, this.xSegs); }
  toOutY(y) { return toOut(y, this.ySegs); }

  async tile(i) {
    if (this.cache.has(i)) return this.cache.get(i);
    const bmp = await createImageBitmap(this.rec.tiles[i]);
    this.cache.set(i, bmp);
    if (this.cache.size > 3) {
      const [k, v] = this.cache.entries().next().value;
      v.close(); this.cache.delete(k);
    }
    return bmp;
  }

  close() { for (const b of this.cache.values()) b.close(); this.cache.clear(); }

  // Draw the output-space CSS rect (x, y, w, h) into ctx at device rect (dx, dy, dw, dh):
  // every kept part that intersects it is drawn at its joined position.
  async draw(ctx, x, y, w, h, dx, dy, dw, dh) {
    const kx = dw / w, ky = dh / h;
    const parts = (segs, a, b) => segs.flatMap(s => {
      const lo = Math.max(a, s.out0), hi = Math.min(b, s.out0 + s.o1 - s.o0);
      return hi - lo > 1e-6 ? [{ out: lo, len: hi - lo, orig: s.o0 + lo - s.out0 }] : [];
    });
    const xs = parts(this.xSegs, x, x + w);
    for (const py of parts(this.ySegs, y, y + h)) {
      // Device edges are computed from output coordinates so neighbouring parts share them exactly.
      const top = dy + (py.out - y) * ky, bot = dy + (py.out + py.len - y) * ky;
      for (const px of xs) {
        const left = dx + (px.out - x) * kx, right = dx + (px.out + px.len - x) * kx;
        await this.drawOrig(ctx, px.orig, py.orig, px.len, py.len, left, top, right - left, bot - top);
      }
    }
    this.paintRedactions(ctx, x, y, w, h, dx, dy, dw, dh);
  }

  // Redaction boxes go on last, over the tiles and every other shape (whatever was drawn after
  // them), and over all kept parts at once so a box crossing a seam is not split into two
  // anti-aliased halves. Each box is snapped outwards to whole device pixels and grown by one
  // more, so no partly covered pixel (or resampling fringe) keeps any of what is underneath.
  paintRedactions(ctx, x, y, w, h, dx, dy, dw, dh) {
    const red = this.redactions();
    if (!red.length) return;
    const kx = dw / w, ky = dh / h;
    const m = ctx.getTransform(); // callers draw axis-aligned (scale + translate)
    const dev = (px, py) => [m.a * px + m.c * py + m.e, m.b * px + m.d * py + m.f];
    const [cx0, cy0] = dev(dx, dy), [cx1, cy1] = dev(dx + dw, dy + dh);
    const clip = [Math.floor(Math.min(cx0, cx1)), Math.floor(Math.min(cy0, cy1)), Math.ceil(Math.max(cx0, cx1)), Math.ceil(Math.max(cy0, cy1))];
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    ctx.fillStyle = '#000'; // always opaque black, whatever colour the shape carries
    for (const r of red) {
      for (const ys of this.ySegs) {
        const oy0 = Math.max(r.y, ys.o0), oy1 = Math.min(r.y + r.h, ys.o1);
        if (oy1 <= oy0) continue;
        for (const xs of this.xSegs) {
          const ox0 = Math.max(r.x, xs.o0), ox1 = Math.min(r.x + r.w, xs.o1);
          if (ox1 <= ox0) continue;
          // Output space, clipped to the requested window, then device pixels.
          const ux0 = Math.max(x, xs.out0 + ox0 - xs.o0), ux1 = Math.min(x + w, xs.out0 + ox1 - xs.o0);
          const uy0 = Math.max(y, ys.out0 + oy0 - ys.o0), uy1 = Math.min(y + h, ys.out0 + oy1 - ys.o0);
          if (ux1 <= ux0 || uy1 <= uy0) continue;
          const [ax, ay] = dev(dx + (ux0 - x) * kx, dy + (uy0 - y) * ky), [bx, by] = dev(dx + (ux1 - x) * kx, dy + (uy1 - y) * ky);
          const X0 = Math.max(clip[0], Math.floor(Math.min(ax, bx)) - 1), Y0 = Math.max(clip[1], Math.floor(Math.min(ay, by)) - 1);
          const X1 = Math.min(clip[2], Math.ceil(Math.max(ax, bx)) + 1), Y1 = Math.min(clip[3], Math.ceil(Math.max(ay, by)) + 1);
          if (X1 > X0 && Y1 > Y0) ctx.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
        }
      }
    }
    ctx.restore();
  }

  // Draw the original-space CSS rect (ox, oy, w, h) (tiles + shapes) at device rect (dx, dy, dw, dh).
  async drawOrig(ctx, ox, oy, w, h, dx, dy, dw, dh) {
    const s = this.scale, th = this.rec.tileHeight;
    const sx = ox * s, sy = oy * s, sw = w * s, sh = h * s;
    const k = dh / sh;
    const first = Math.max(0, Math.floor(sy / th)), last = Math.min(this.rec.tiles.length - 1, Math.floor((sy + sh - 1) / th));
    for (let i = first; i <= last; i++) {
      const bmp = await this.tile(i);
      const top = i * th;
      const y0 = Math.max(sy, top), y1 = Math.min(sy + sh, top + bmp.height);
      if (y1 <= y0) continue;
      ctx.drawImage(bmp, sx, y0 - top, sw, y1 - y0, dx, dy + (y0 - sy) * k, dw, (y1 - y0) * k);
    }
    // Redactions are not drawn here: draw() paints them last, over everything (paintRedactions).
    const shapes = this.shapes.filter(sh => sh.type !== 'redact');
    if (shapes.length) {
      ctx.save();
      ctx.beginPath(); ctx.rect(dx, dy, dw, dh); ctx.clip();
      const kx = dw / w, ky = dh / h;
      ctx.setTransform(ctx.getTransform().translate(dx - ox * kx, dy - oy * ky).scale(kx, ky));
      for (const sh of shapes) drawShape(ctx, sh);
      ctx.restore();
    }
  }

  // Redaction boxes (normalised to positive width / height), in original CSS px.
  redactions() {
    return this.reds ||= this.shapes.filter(s => s.type === 'redact' && [s.x, s.y, s.w, s.h].every(Number.isFinite))
      .map(s => ({ x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) }))
      .filter(r => r.w > 0 && r.h > 0);
  }

  // Items (text / links / media / blocks) mapped into output coordinates. Items fully inside
  // a removed part (or outside the crop) are dropped; items straddling a seam are clipped to
  // what is kept. A text run needs at least half of its height kept, so the searchable text
  // never contains words that are no longer visible.
  //
  // Redactions remove what is under them, like Preview's Redact:
  //   text   every character whose box touches a redaction (any vertical overlap counts) is
  //          removed; the rest of the run stays, as separate runs left / right of the box.
  //   links  a link touching a redaction is dropped, together with every other rect of the
  //          same URL: the URL is information under the box (it often spells out the redacted
  //          text), and the uncovered part of a link, or its other line, would still carry it.
  //   media / blocks (only used to place page breaks) are dropped when their centre is covered.
  items(kind) {
    this.itemCache ||= {};
    if (this.itemCache[kind]) return this.itemCache[kind];
    if (kind === 'text') return (this.itemCache.text = this.textItems());
    const red = this.redactions();
    let list = this.rec[kind] || [];
    if (kind === 'links') {
      const banned = new Set(list.filter(l => red.some(r => overlaps(l, r))).map(l => l.href));
      list = list.filter(l => !banned.has(l.href));
    } else {
      list = list.filter(it => {
        const cx = it.x + it.w / 2, cy = it.y + it.h / 2;
        return !red.some(r => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
      });
    }
    const out = [];
    for (const it of list) {
      const x0 = this.toOutX(it.x), x1 = this.toOutX(it.x + it.w);
      const y0 = this.toOutY(it.y), y1 = this.toOutY(it.y + it.h);
      // Fraction kept on each axis (zero-size items: whether their position is kept).
      const fx = it.w > 0 ? (x1 - x0) / it.w : +this.keptX(it.x);
      const fy = it.h > 0 ? (y1 - y0) / it.h : +this.keptY(it.y);
      if (fy < 0.01 || fx < 0.01) continue;
      out.push({ ...it, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    return (this.itemCache[kind] = out);
  }

  textItems() {
    const red = this.redactions();
    const out = [];
    this.redactedWordList = [];
    for (const { ws, ...it } of this.rec.text || []) {
      const t = String(it.t ?? '');
      const hits = red.filter(r => overlaps(it, r, 1));
      const y0 = this.toOutY(it.y), y1 = this.toOutY(it.y + it.h);
      const x0 = this.toOutX(it.x), x1 = this.toOutX(it.x + it.w);
      const fx = it.w > 0 ? (x1 - x0) / it.w : +this.keptX(it.x);
      const fy = it.h > 0 ? (y1 - y0) / it.h : +this.keptY(it.y);
      const kept = fy >= 0.5 && fx >= 0.01;
      if (!hits.length && (!kept || fx >= 0.999 || !(it.w > 0))) {
        if (kept) out.push({ ...it, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
        continue;
      }
      // Redacted, or cut horizontally (crop edge / removed column): per-character boxes, the
      // covered ones removed, the rest grouped into one run per uninterrupted kept stretch.
      const chars = [...t], boxes = charBoxes({ ...it, ws });
      const covered = boxes.map(([c0, c1]) => {
        const pad = Math.max(0.5, (c1 - c0) * 0.3); // positions inside a word are estimates
        return hits.some(r => c1 + pad > r.x && c0 - pad < r.x + r.w);
      });
      if (hits.length) {
        const words = t.split(' '), hit = new Set();
        let wi = 0;
        chars.forEach((ch, i) => { if (ch === ' ') wi++; else if (covered[i]) hit.add(wi); });
        for (const i of hit) this.redactedWordList.push(words[i]);
      }
      if (!kept) continue;
      let cur = null;
      const flush = () => {
        if (!cur) return;
        let a = 0, b = cur.chars.length;
        while (a < b && cur.chars[a] === ' ') a++;
        while (b > a && cur.chars[b - 1] === ' ') b--;
        const s = cur.seg;
        const l = b > a ? Math.max(cur.boxes[a][0], s.o0) : 0, r = b > a ? Math.min(cur.boxes[b - 1][1], s.o1) : 0;
        if (r > l) out.push({ ...it, t: cur.chars.slice(a, b).join(''), x: s.out0 + l - s.o0, y: y0, w: r - l, h: y1 - y0 });
        cur = null;
      };
      for (let i = 0; i < chars.length; i++) {
        const mid = (boxes[i][0] + boxes[i][1]) / 2;
        const seg = covered[i] ? null : this.xSegs.find(s => mid >= s.o0 && mid <= s.o1);
        if (!seg || (cur && cur.seg !== seg)) flush();
        if (!seg) continue;
        cur ||= { seg, chars: [], boxes: [] };
        cur.chars.push(chars[i]); cur.boxes.push(boxes[i]);
      }
      flush();
    }
    return out;
  }

  // Words (whole, as captured) that lost at least one character to a redaction.
  redactedWords() {
    this.items('text');
    return this.redactedWordList;
  }

  // Page title / URL for the PDF metadata, header, footer and the file name. They are outside
  // the capture, so no box can cover them, but they can repeat what was redacted (a mail
  // client's title "Inbox - jane@example.com", a URL ending in the redacted order number):
  // then they are left out ('') instead.
  labels() {
    const title = this.rec.title || '', url = this.rec.url || '';
    const toks = new Set();
    for (const w of this.redactedWords()) {
      for (const tk of w.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (tk.length >= 4 || (tk.length >= 2 && /\p{N}/u.test(tk))) toks.add(tk);
      }
    }
    if (!toks.size) return { title, url };
    const leaks = s => { const v = s.normalize('NFKC').toLowerCase(); for (const tk of toks) if (v.includes(tk)) return true; return false; };
    let decoded = url;
    try { decoded = decodeURIComponent(url); } catch { /* keep as is */ }
    return { title: leaks(title) ? '' : title, url: leaks(url) || leaks(decoded) ? '' : url };
  }
  keptX(x) { return this.xSegs.some(s => x >= s.o0 && x <= s.o1); }
  keptY(y) { return this.ySegs.some(s => y >= s.o0 && y <= s.o1); }
}

// ---------------------------------------------------------------- pen strokes
// A pen stroke is { type: 'pen', points: [[x, y], ...], color, width } in original CSS px.
// The same SVG path data is used on screen (result page overlay) and in exports (Path2D), so
// the smoothing is identical: quadratic curves through the midpoints of consecutive points,
// with the input points as control points; the ends are drawn straight to the first/last point.
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
export function penPathD(points) {
  const p = points || [];
  if (!p.length) return '';
  // A single tap is a dot: a zero-length segment, drawn as a round cap.
  if (p.length === 1) return `M${p[0][0]} ${p[0][1]}l0 0`;
  let d = `M${p[0][0]} ${p[0][1]}`;
  if (p.length === 2) return `${d}L${p[1][0]} ${p[1][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    d += `Q${p[i][0]} ${p[i][1]} ${r2((p[i][0] + p[i + 1][0]) / 2)} ${r2((p[i][1] + p[i + 1][1]) / 2)}`;
  }
  const l = p.at(-1);
  return `${d}L${l[0]} ${l[1]}`;
}

// Ramer–Douglas–Peucker simplification (iterative), then rounding to 0.1 px, so long strokes
// stay compact in storage. `eps` is the maximum deviation in CSS px.
export function simplifyStroke(points, eps = 0.5) {
  const p = points.filter(q => Number.isFinite(q[0]) && Number.isFinite(q[1]));
  if (p.length < 3) return p.map(([x, y]) => [r1(x), r1(y)]);
  const keep = new Uint8Array(p.length); keep[0] = keep[p.length - 1] = 1;
  const stack = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = p[a], [bx, by] = p[b], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const [x, y] = p[i];
      const dist = len < 1e-9 ? Math.hypot(x - ax, y - ay) : Math.abs(dy * x - dx * y + bx * ay - by * ax) / len;
      if (dist > best) { best = dist; bi = i; }
    }
    if (best > eps) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  const out = [];
  for (let i = 0; i < p.length; i++) {
    if (!keep[i]) continue;
    const q = [r1(p[i][0]), r1(p[i][1])], last = out.at(-1);
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  return out;
}

export const isPenDot = p => p.length === 1 || p.every(q => q[0] === p[0][0] && q[1] === p[0][1]);

// Whether rect a, grown by `pad` on every side, overlaps rect r (both {x, y, w, h}).
function overlaps(a, r, pad = 0) {
  return a.x - pad < r.x + r.w && a.x + a.w + pad > r.x && a.y - pad < r.y + r.h && a.y + a.h + pad > r.y;
}

// Relative glyph widths (a generic sans-serif) to place characters inside a word's box.
let measureCtx = null;
const glyphWidths = new Map();
function glyphWidth(ch) {
  let w = glyphWidths.get(ch);
  if (w === undefined) {
    measureCtx ||= makeCanvas(4, 4).getContext('2d');
    measureCtx.font = '100px Arial, Helvetica, sans-serif';
    w = Math.max(10, measureCtx.measureText(ch).width);
    glyphWidths.set(ch, w);
  }
  return w;
}
function spread(chars, a, b, out) {
  const ws = chars.map(glyphWidth), tot = ws.reduce((n, v) => n + v, 0) || 1;
  let x = a;
  for (const v of ws) { const nx = x + (b - a) * v / tot; out.push([x, nx]); x = nx; }
}

// [left, right] (original CSS px) of every character (code point) of a text run. Word boxes
// come from the capture (`ws`, see agent.js) when present; characters inside a word, and all
// characters of older captures without `ws`, are placed in proportion to their glyph widths.
export function charBoxes(it) {
  const t = String(it.t ?? ''), words = t.split(' ');
  const ws = Array.isArray(it.ws) && it.ws.length === words.length * 2 ? it.ws : null;
  const out = [];
  if (!ws) { spread([...t], it.x, it.x + it.w, out); return out; }
  words.forEach((wd, i) => {
    if (i) out.push([it.x + ws[2 * i - 1], it.x + Math.max(ws[2 * i - 1], ws[2 * i])]); // the space before it
    spread([...wd], it.x + ws[2 * i], it.x + Math.max(ws[2 * i], ws[2 * i + 1]), out);
  });
  return out;
}

// Gallery thumbnail (popup "Recent captures", files page): the top of the capture as it was
// taken (no crop / cuts / drawings, like the one made at capture time) with the redaction
// boxes painted, so the gallery never shows what was redacted. thumbKey() names the boxes a
// thumbnail was drawn with (stored as rec.thumbKey; missing = none).
export const thumbKey = rec => JSON.stringify((rec.edits?.shapes || []).filter(s => s.type === 'redact').map(s => [s.x, s.y, s.w, s.h].map(v => Math.round(v * 10) / 10)));
export async function makeRedactedThumb(rec, width = 480) {
  const src = new CaptureSource({ ...rec, edits: { shapes: (rec.edits?.shapes || []).filter(s => s.type === 'redact') } });
  try {
    const css = Math.min(rec.cssHeight, (rec.tileHeight || rec.height) / rec.scale, rec.cssWidth * 1.6);
    const h = Math.max(1, Math.round(css * width / rec.cssWidth));
    const c = makeCanvas(width, h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, h);
    ctx.imageSmoothingQuality = 'high';
    await src.draw(ctx, 0, 0, rec.cssWidth, h * rec.cssWidth / width, 0, 0, width, h);
    return await toBlob(c, 'image/jpeg', 0.8);
  } finally { src.close(); }
}

export function drawShape(ctx, s) {
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const lw = s.width || 3;
  switch (s.type) {
    case 'rect':
      ctx.strokeStyle = s.color; ctx.lineWidth = lw;
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      break;
    case 'ellipse':
      ctx.strokeStyle = s.color; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, Math.abs(s.w / 2), Math.abs(s.h / 2), 0, 0, Math.PI * 2); ctx.stroke();
      break;
    case 'highlight':
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillStyle = s.color || '#ffeb3b'; ctx.globalAlpha = 0.45;
      ctx.fillRect(s.x, s.y, s.w, s.h);
      break;
    case 'redact':
      ctx.fillStyle = s.color || '#000';
      ctx.fillRect(s.x, s.y, s.w, s.h);
      break;
    case 'arrow':
    case 'line': {
      ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
      if (s.type === 'arrow') {
        const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1), L = 10 + lw * 3;
        ctx.beginPath();
        ctx.moveTo(s.x2, s.y2);
        ctx.lineTo(s.x2 - L * Math.cos(a - 0.45), s.y2 - L * Math.sin(a - 0.45));
        ctx.lineTo(s.x2 - L * Math.cos(a + 0.45), s.y2 - L * Math.sin(a + 0.45));
        ctx.closePath(); ctx.fill();
      }
      break;
    }
    case 'pen': {
      const p = s.points || [];
      if (!p.length) break;
      ctx.strokeStyle = s.color; ctx.fillStyle = s.color; ctx.lineWidth = lw;
      // A dot is filled explicitly: canvas implementations differ on zero-length round caps.
      if (isPenDot(p)) {
        ctx.beginPath(); ctx.arc(p[0][0], p[0][1], lw / 2, 0, Math.PI * 2); ctx.fill();
      } else ctx.stroke(new Path2D(penPathD(p)));
      break;
    }
    case 'text':
      ctx.fillStyle = s.color; ctx.font = `600 ${s.size || 20}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textBaseline = 'top';
      String(s.text || '').split('\n').forEach((ln, i) => ctx.fillText(ln, s.x, s.y + i * (s.size || 20) * 1.25));
      break;
  }
  ctx.restore();
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
const toBlob = (c, type, quality) => c.convertToBlob ? c.convertToBlob({ type, quality }) : new Promise(r => c.toBlob(r, type, quality));

// ---------------------------------------------------------------- images
export async function exportImage(rec, format = 'png', quality = 0.92, onProgress) {
  const src = new CaptureSource(rec);
  const type = format === 'jpg' ? 'image/jpeg' : 'image/png';
  const maxH = Math.max(1, Math.min(MAX_CANVAS_H, Math.floor(MAX_CANVAS_AREA / src.width)));
  const parts = Math.ceil(src.height / maxH);
  const out = [];
  try {
    for (let p = 0; p < parts; p++) {
      const y0 = p * maxH, h = Math.min(maxH, src.height - y0);
      const c = makeCanvas(src.width, h);
      const ctx = c.getContext('2d');
      if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, src.width, h); }
      await src.draw(ctx, 0, y0 / src.scale, src.cssWidth, h / src.scale, 0, 0, src.width, h);
      out.push({ blob: await toBlob(c, type, quality), suffix: parts > 1 ? `-part${p + 1}` : '', ext: format === 'jpg' ? 'jpg' : 'png' });
      onProgress?.((p + 1) / parts);
    }
  } finally { src.close(); }
  return out;
}

// ---------------------------------------------------------------- smart split
async function rowInk(src, y0, y1) {
  // Fraction of "non-background" pixels for each CSS row in [y0, y1).
  const rows = Math.max(1, Math.round(y1 - y0));
  const w = Math.min(800, Math.round(src.cssWidth));
  const c = makeCanvas(w, rows);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, rows);
  await src.draw(ctx, 0, y0, src.cssWidth, rows, 0, 0, w, rows);
  const d = ctx.getImageData(0, 0, w, rows).data;
  // Dominant colour of the window = background.
  const hist = new Map();
  for (let i = 0; i < d.length; i += 4 * 7) {
    const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  let bgKey = 0, best = -1;
  for (const [k, v] of hist) if (v > best) { best = v; bgKey = k; }
  const br = ((bgKey >> 10) & 31) << 3, bgG = ((bgKey >> 5) & 31) << 3, bb = (bgKey & 31) << 3;
  const ink = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let n = 0;
    for (let x = 0, i = r * w * 4; x < w; x++, i += 4) {
      if (Math.abs(d[i] - br) + Math.abs(d[i + 1] - bgG) + Math.abs(d[i + 2] - bb) > 40) n++;
    }
    ink[r] = n / w;
  }
  return ink;
}

// Structure-aware splitting. Blocks come from the page's HTML (see agent.js collect()).
// Penalty for a break that cuts through a block of each kind; a text line is 100.
// 'unit' = a post/comment's own content (author line, body, action row) excluding nested
// replies, so threads break between comments rather than inside one.
const BLOCK_CUT = { row: 60, unit: 50, pre: 35, figure: 35, card: 25, item: 15, quote: 10 };
// Block boundaries where a break may land between siblings (>0 = boundary; larger wins
// the exact snap position when edges of different blocks are within a pixel or two).
const BLOCK_EDGE = { row: 8, unit: 6, item: 5, card: 4, pre: 4, figure: 4, quote: 3, heading: 4 };
const HEADING_ORPHAN = 40; // break right below a heading (heading left alone at the page end)

export async function findBreak(src, text, media, start, target, pageCss, blocks = []) {
  // With structure available, look a little further up so a whole row/card can move down.
  const reach = blocks.length ? Math.min(pageCss * 0.45, 1100) : Math.min(pageCss * 0.35, 900);
  const lo = Math.max(start + pageCss * 0.5, target - reach);
  const span = Math.floor(target - lo);
  if (span < 4) return target;
  // Distance cost per CSS px: unchanged from the text-only heuristic.
  const nearDen = blocks.length ? Math.max(4, Math.min(pageCss * 0.35, 900)) : span;
  const blocked = new Uint8Array(span + 1);   // hard: would cut a text line
  const soft = new Uint8Array(span + 1);      // soft: would cut a small image
  const mark = (arr, top, bottom) => {
    const a = Math.max(0, Math.ceil(top - lo)), b = Math.min(span, Math.floor(bottom - lo));
    for (let i = a; i <= b; i++) arr[i] = 1;
  };
  for (const t of text) if (t.h < pageCss * 0.3 && t.y + t.h > lo && t.y < target) mark(blocked, t.y + 1, t.y + t.h - 1);
  for (const m of media) if (m.h < pageCss * 0.8 && m.y + m.h > lo && m.y < target) mark(soft, m.y + 1, m.y + m.h - 1);

  let cut = null, edge = null, snap = null;
  if (blocks.length) {
    cut = new Float32Array(span + 1);   // structural cost of cutting here
    edge = new Float32Array(span + 1);  // >0: exactly on a block boundary
    snap = new Float64Array(span + 1).fill(NaN); // exact boundary to snap to
    const range = (y0, y1, fn) => {
      const a = Math.max(0, Math.ceil(y0 - lo)), b = Math.min(span, Math.floor(y1 - lo));
      for (let i = a; i <= b; i++) fn(i);
    };
    const onEdge = (y, bonus) => range(y - 1.5, y + 1.5, i => {
      if (bonus > edge[i] && y <= target) { edge[i] = bonus; snap[i] = y; }
    });
    for (const b of blocks) {
      const top = b.y, bot = b.y + b.h;
      if (b.h >= pageCss * 0.8 || bot < lo - 200 || top > target + 2) continue; // huge blocks never prevent a break
      if (b.kind === 'heading') {
        // Keep a heading with what follows: penalise breaks shortly below it, reward breaks above it.
        const K = Math.min(Math.max(b.h * 3, 60), 160);
        range(bot - 1.5, bot + K, i => { const p = HEADING_ORPHAN * (1 - Math.max(0, lo + i - bot) / K); if (p > cut[i]) cut[i] = p; });
        onEdge(top, BLOCK_EDGE.heading);
        continue;
      }
      const w = (BLOCK_CUT[b.kind] || 0) * (b.h > pageCss * 0.5 ? 0.5 : 1);
      if (!w) continue;
      range(top + 1.5, bot - 1.5, i => { if (w > cut[i]) cut[i] = w; });
      onEdge(top, BLOCK_EDGE[b.kind] || 0);
      onEdge(bot, BLOCK_EDGE[b.kind] || 0);
    }
  }

  const ink = await rowInk(src, lo, lo + span + 1);
  let bestY = target, bestScore = Infinity;
  for (let i = span; i >= 0; i--) {
    const y = lo + i;
    const near = (target - y) / nearDen; // 0 at the target, ~1 at the lowest allowed row
    // Pixel ink, preferring the middle of a blank gap rather than its edge.
    let inkCost = (ink[i] || 0) * 20 + ((ink[i - 2] || 0) + (ink[i + 2] || 0)) * 2;
    // A block boundary (between table rows, cards, list items) is as good as a blank gap
    // even when borders / zebra stripes put ink there — but not better, so breaks don't
    // drift away from the target just to land on an edge.
    if (cut && edge[i] > 0) inkCost = Math.min(inkCost, 0.5);
    let score = (blocked[i] ? 100 : 0) + (soft[i] ? 3 : 0) + inkCost + near * 1.2;
    if (cut) score += cut[i];
    if (score < bestScore) { bestScore = score; bestY = cut && edge[i] > 0 ? snap[i] : y; }
  }
  return bestY;
}

// ---------------------------------------------------------------- PDF
function measureHelvetica(str, size) {
  const c = makeCanvas(4, 4).getContext('2d');
  c.font = `${size}px Helvetica, Arial, sans-serif`;
  return c.measureText(str).width;
}
function fitText(str, size, maxW) {
  if (measureHelvetica(str, size) <= maxW) return str;
  let lo = 0, hi = str.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (measureHelvetica(str.slice(0, mid) + '…', size) <= maxW) lo = mid; else hi = mid - 1; }
  return str.slice(0, lo) + '…';
}

async function encodeCanvas(c, quality) {
  if (quality < 1) {
    const blob = await toBlob(c, 'image/jpeg', quality);
    return { kind: 'jpeg', bytes: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height };
  }
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const rgb = new Uint8Array(c.width * c.height * 3);
  for (let i = 0, j = 0; i < d.length; i += 4) { rgb[j++] = d[i]; rgb[j++] = d[i + 1]; rgb[j++] = d[i + 2]; }
  return { kind: 'flate', bytes: await deflate(rgb), width: c.width, height: c.height };
}

export function pageGeometry(src, o) {
  const margin = (Number(o.marginMm) || 0) * 72 / 25.4;
  const headerH = o.pdfHeader ? 24 : 0, footerH = o.pdfFooter ? 24 : 0;
  if (o.paperSize === 'fit') {
    let k = 0.75; // CSS px -> pt at 96 dpi
    const extra = 2 * margin + headerH + footerH;
    if (src.cssHeight * k + extra > 14400) k = (14400 - extra) / src.cssHeight;
    const pageW = src.cssWidth * k + 2 * margin;
    return { pageW, pageH: src.cssHeight * k + extra, margin, headerH, footerH, k, pageCss: src.cssHeight };
  }
  let { w: pageW, h: pageH } = PAPER_SIZES[o.paperSize] || PAPER_SIZES.letter;
  if (o.orientation === 'landscape') [pageW, pageH] = [pageH, pageW];
  const contentW = pageW - 2 * margin;
  const k = contentW / src.cssWidth;
  const availH = pageH - 2 * margin - headerH - footerH;
  return { pageW, pageH, margin, headerH, footerH, k, pageCss: availH / k };
}

export async function computeBreaks(src, o) {
  const g = pageGeometry(src, o);
  const text = src.items('text'), media = src.items('media'), blocks = src.items('blocks');
  const breaks = [0];
  let y = 0;
  while (y < src.cssHeight - 0.5) {
    const target = y + g.pageCss;
    let next;
    if (target >= src.cssHeight - 1) next = src.cssHeight;
    else if (o.smartSplit) next = await findBreak(src, text, media, y, target, g.pageCss, blocks);
    else next = target;
    if (next <= y + 1) next = target; // safety
    breaks.push(next);
    y = next;
  }
  return { breaks, geometry: g };
}

export async function exportPDF(rec, o, onProgress) {
  const src = new CaptureSource(rec);
  try {
    const { breaks, geometry: g } = await computeBreaks(src, o);
    const pdf = new PDFWriter();
    const text = o.textLayer ? src.items('text') : [];
    const links = o.activeLinks ? src.items('links') : [];
    const n = breaks.length - 1;
    const quality = Number(o.pdfImageQuality) || 0.92;
    const date = formatDateTime(rec.createdAt);
    const { title, url } = src.labels(); // '' where they would repeat redacted text
    for (let p = 0; p < n; p++) {
      const y0 = breaks[p], y1 = breaks[p + 1];
      const page = pdf.newPage(g.pageW, o.paperSize === 'fit' ? g.pageH : g.pageH);
      const devW = src.width, devH = Math.max(1, Math.round((y1 - y0) * src.scale));
      const c = makeCanvas(devW, devH);
      const ctx = c.getContext('2d', { willReadFrequently: quality >= 1 });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, devW, devH);
      await src.draw(ctx, 0, y0, src.cssWidth, y1 - y0, 0, 0, devW, devH);
      const imgId = pdf.addImage(await encodeCanvas(c, quality));
      const top = g.margin + g.headerH;
      pdf.drawImage(page, imgId, g.margin, top, src.cssWidth * g.k, (y1 - y0) * g.k);

      for (const t of text) {
        const cy = t.y + t.h / 2;
        if (cy < y0 || cy >= y1) continue;
        pdf.invisibleText(page, t.t, g.margin + t.x * g.k, top + (t.y - y0) * g.k, t.w * g.k, t.h * g.k);
      }
      for (const l of links) {
        const a = Math.max(l.y, y0), b = Math.min(l.y + l.h, y1);
        if (b - a < 2) continue;
        pdf.link(page, l.href, g.margin + l.x * g.k, top + (a - y0) * g.k, l.w * g.k, (b - a) * g.k);
      }
      const fs = 8, innerW = g.pageW - 2 * Math.max(g.margin, 18);
      const left = Math.max(g.margin, 18);
      if (o.pdfHeader) {
        const dw = measureHelvetica(date, fs);
        pdf.visibleText(page, fitText(title, fs, innerW - dw - 20), left, g.margin + 8, fs);
        pdf.visibleText(page, date, left + innerW - dw, g.margin + 8, fs);
      }
      if (o.pdfFooter) {
        const label = `${p + 1} / ${n}`;
        const lw = measureHelvetica(label, fs);
        const yy = g.pageH - g.margin - g.footerH + 8;
        const shown = fitText(url, fs, innerW - lw - 20);
        pdf.visibleText(page, shown, left, yy, fs, '0.1 0.3 0.75');
        if (url && /^https?:/i.test(url)) pdf.link(page, url, left, yy - 2, measureHelvetica(shown, fs), fs + 4);
        pdf.visibleText(page, label, left + innerW - lw, yy, fs);
      }
      await pdf.endPage(page);
      onProgress?.((p + 1) / n);
    }
    return await pdf.finish({ title: title || url, subject: url, keywords: `captured ${new Date(rec.createdAt).toISOString()}` });
  } finally { src.close(); }
}
