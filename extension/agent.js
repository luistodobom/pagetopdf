// Injected into the page (isolated world). Drives scrolling, hides repeating
// fixed/sticky elements, optionally strips backgrounds, and collects the text,
// links and media boxes that are visible in each frame so the PDF can carry a
// real text layer and clickable links.
(() => {
  if (window.__ptpAgent) return;

  // Next frame — with a timeout, because Chrome doesn't run animation frames for tabs that
  // aren't visible (another tab in front, minimised window), which would hang the capture.
  const raf = () => new Promise(r => { const t = setTimeout(r, 150); requestAnimationFrame(() => { clearTimeout(t); r(); }); });
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let S = null; // capture state

  // ---------- generic DOM helpers ----------
  function* allElements(root = document.documentElement) {
    // Depth-first walk including open shadow roots.
    const stack = [root];
    while (stack.length) {
      const el = stack.pop();
      if (!el || el.nodeType !== 1) continue;
      yield el;
      if (el.shadowRoot) for (let c = el.shadowRoot.lastElementChild; c; c = c.previousElementSibling) stack.push(c);
      for (let c = el.lastElementChild; c; c = c.previousElementSibling) stack.push(c);
    }
  }

  function saveInline(el, props) {
    let rec = S.touched.get(el);
    if (!rec) {
      rec = {}; S.touched.set(el, rec);
      S.inlineOrig.set(el, el.getAttribute('style')); // exact original attribute (or null)
    }
    for (const p of props) {
      if (!(p in rec)) rec[p] = [el.style.getPropertyValue(p), el.style.getPropertyPriority(p)];
    }
  }
  function setImportant(el, prop, value) {
    saveInline(el, [prop]);
    el.style.setProperty(prop, value, 'important');
    S.inlineAfter.set(el, el.getAttribute('style'));
  }
  // Undo one property we set earlier (before restore()).
  function unsetInline(el, rec, p) {
    const ours = el.getAttribute('style') === S.inlineAfter.get(el);
    const [v, prio] = rec[p];
    if (v) el.style.setProperty(p, v, prio); else el.style.removeProperty(p);
    delete rec[p];
    if (ours) S.inlineAfter.set(el, el.getAttribute('style'));
  }
  function restoreInline() {
    for (const [el, rec] of S.touched) {
      const orig = S.inlineOrig.get(el);
      if (el.getAttribute('style') === S.inlineAfter.get(el)) {
        // Only we changed it since: put the attribute back byte-for-byte (property-by-property
        // restoring can't undo shorthands like `inset` and reserialises colours).
        if (orig == null) el.removeAttribute('style'); else el.setAttribute('style', orig);
        continue;
      }
      // The page changed it too: undo just our properties and keep the page's own changes.
      for (const [p, [v, prio]] of Object.entries(rec)) {
        if (v) el.style.setProperty(p, v, prio); else el.style.removeProperty(p);
      }
      if (orig == null && !el.style.length) el.removeAttribute('style');
    }
    S.touched.clear();
    S.inlineOrig.clear();
    S.inlineAfter.clear();
  }

  function addStyle(css) {
    const st = document.createElement('style');
    st.setAttribute('data-pagetopdf', '');
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
    S.styles.push(st);
  }

  // ---------- background removal ----------
  // "Remove backgrounds" makes the page white for ink-friendly printing. Everything designed to
  // be read on a dark background must then be recoloured so it stays readable: text (including
  // ::before/::after text, placeholders, list markers, outlined text and gradient text painted
  // with background-clip:text), SVG labels and icons, and dividers. A colour that fails the WCAG
  // contrast ratio against white (4.5:1, or 3:1 for large text) is darkened in OKLab keeping its
  // hue, so links stay blue and warnings stay amber. Lighter colours end up darker, so the
  // original emphasis (primary vs. muted text) survives. Text that sits on a kept image is left
  // alone: it was designed to be read on that image and darkening it would make it unreadable.
  // Content that appears later (lazy loading while scrolling) is handled before each frame.

  const COLOR_FN = /(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\([^()]*\)/g;
  const WHITE = { r: 255, g: 255, b: 255, a: 1 };
  const DARKEST = 0.0103; // relative luminance of #1a1a1a, the darkest we map white text to
  const clamp01 = x => Math.min(1, Math.max(0, x));
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const unlin = v => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  const relLum = c => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const mix = (c, bg, a) => ({ r: c.r * a + bg.r * (1 - a), g: c.g * a + bg.g * (1 - a), b: c.b * a + bg.b * (1 - a), a: 1 });
  const contrastOnWhite = (c, op = 1) => 1.05 / (relLum(mix(c, WHITE, c.a * op)) + 0.05);

  const colorCache = new Map();
  let colorCtx = null;
  function parseColor(s) {
    if (!s || s === 'none') return null;
    let c = colorCache.get(s);
    if (c !== undefined) return c;
    c = null;
    const m = /^rgba?\(([^)]*)\)$/.exec(s);
    if (m) {
      const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      if (p.length >= 3) c = { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    } else if (/^(?:#|hsla?\(|hwb\(|oklch\(|oklab\(|lab\(|lch\(|color\()/.test(s)) {
      // Computed values keep modern colour spaces (e.g. Tailwind's oklch): let canvas convert.
      try {
        if (!colorCtx) {
          const cv = document.createElement('canvas'); cv.width = cv.height = 1;
          colorCtx = cv.getContext('2d', { willReadFrequently: true });
        }
        colorCtx.clearRect(0, 0, 1, 1);
        colorCtx.fillStyle = 'rgba(0, 0, 0, 0)';
        colorCtx.fillStyle = s;
        colorCtx.fillRect(0, 0, 1, 1);
        const d = colorCtx.getImageData(0, 0, 1, 1).data;
        c = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      } catch { c = null; }
    }
    colorCache.set(s, c);
    return c;
  }

  function toOklab(c) {
    const R = lin(c.r), G = lin(c.g), B = lin(c.b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function oklabToLinear(L, a, b) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  }
  // sRGB colour with OKLab lightness L and the hue of (a, b); chroma is reduced to stay in gamut.
  function oklabToRgb(L, a, b) {
    const inGamut = k => oklabToLinear(L, a * k, b * k).every(x => x >= -1e-6 && x <= 1 + 1e-6);
    let k = 1;
    if (!inGamut(1)) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (inGamut(mid)) lo = mid; else hi = mid; }
      k = lo;
    }
    const v = oklabToLinear(L, a * k, b * k);
    return { r: Math.round(unlin(clamp01(v[0]))), g: Math.round(unlin(clamp01(v[1]))), b: Math.round(unlin(clamp01(v[2]))), a: 1 };
  }

  // A CSS colour that keeps the hue of `c` but reaches `need`:1 contrast on white when painted with
  // opacity `op`, or null when `c` already does. `bd` is what it was originally painted on: the more
  // it stood out there (white on black), the darker it becomes, which keeps the page's hierarchy.
  // `emphasis` false only reaches the threshold (used for borders).
  const readableCache = new Map();
  function readableColor(c, need, op, bd, emphasis = true) {
    if (!c || c.a < 0.02) return null;
    if (op < 0.2) op = 1; // probably mid entrance-animation: judge it as it will end up
    if (contrastOnWhite(c, op) >= need) return null;
    const key = `${c.r},${c.g},${c.b},${c.a}|${need}|${op.toFixed(2)}|${emphasis && bd ? `${bd.r | 0},${bd.g | 0},${bd.b | 0}` : ''}`;
    let out = readableCache.get(key);
    if (out !== undefined) return out;
    const y0 = 1.05 / (need * 1.06) - 0.05; // a little margin above the threshold
    const cy0 = Math.cbrt(y0);
    const [L, A, B] = toOklab(c);
    let t = 0;
    if (emphasis) {
      const cy = Math.cbrt(relLum(bd ? mix(c, bd, c.a * op) : c));
      const cb = bd ? Math.cbrt(relLum(bd)) : 0;
      // 0 = just reach the threshold, 1 = as dark as #1a1a1a. Saturated colours stay lighter so
      // they remain recognisable; text that was faint on its original background stays faint.
      t = clamp01((cy - cy0) / (1 - cy0)) * clamp01((cy - cb) / 0.4) * (1 - 0.6 * clamp01(Math.hypot(A, B) / 0.12));
    }
    const target = (cy0 + (Math.cbrt(DARKEST) - cy0) * t) ** 3;
    // Largest lightness (same hue) whose rendering on white is at most `target`.
    let lo = 0, hi = clamp01(L), best = oklabToRgb(0, A, B);
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2, rgb = oklabToRgb(mid, A, B);
      if (relLum(mix(rgb, WHITE, op)) <= target) { lo = mid; best = rgb; } else hi = mid;
    }
    out = `rgb(${best.r}, ${best.g}, ${best.b})`;
    readableCache.set(key, out);
    return out;
  }

  function gradientColors(bgi) {
    return (bgi.match(COLOR_FN) || []).map(parseColor).filter(Boolean);
  }

  // A url() background big enough to be a backdrop for text (hero/banner), not an icon or a
  // page-wide texture (those are effectively page backgrounds).
  function isBackdropImage(el, cs) {
    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.height < 50 || r.height > innerHeight * 1.5) return false;
    const size = cs.backgroundSize;
    if (/cover|contain/.test(size)) return true;
    if (!/^no-repeat/.test(cs.backgroundRepeat)) return true;
    const m = /^([\d.]+)(px|%)/.exec(size);
    return !!m && (m[2] === '%' ? +m[1] >= 60 : +m[1] >= r.width * 0.6);
  }

  const RECOLOR_SKIP = new Set(['head', 'script', 'style', 'noscript', 'template', 'meta', 'link', 'title', 'br', 'wbr', 'option', 'optgroup']);
  const MEDIA_TAGS = new Set(['img', 'video', 'canvas', 'iframe', 'object', 'embed']);
  const SVG_SKIP = new Set(['defs', 'clipPath', 'mask', 'pattern', 'marker', 'symbol', 'linearGradient', 'radialGradient', 'filter', 'style', 'script', 'title', 'desc', 'metadata']);
  const SVG_SHAPES = new Set(['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'use']);
  const SVG_TEXT = new Set(['text', 'tspan', 'textPath']);
  const SIDES = ['Top', 'Right', 'Bottom', 'Left'];
  const textDecl = v => `color: ${v} !important; -webkit-text-fill-color: ${v} !important`;
  const needFor = cs => {
    const size = parseFloat(cs.fontSize);
    return size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight, 10) >= 700) ? 3 : 4.5;
  };

  // Recolour the subtrees under `roots` ([el, ctx] pairs). Reads everything first, then writes,
  // so the browser recalculates styles once. Returns the number of changes made.
  function recolorTrees(roots) {
    // Read colours as they end up, not halfway through a colour transition.
    try {
      for (const a of document.getAnimations?.() || []) {
        if (a.transitionProperty && /color|fill|stroke/.test(a.transitionProperty) && a.playState === 'running') a.finish();
      }
    } catch {}
    const o = S.opts, darken = o.darkenLightText !== false, keep = !!o.keepBackgroundImages;
    const recs = [], groups = [], media = [], writes = [], bgs = [];
    writes.transitions = new Set(); // elements whose colour changes would otherwise be animated
    const stack = roots.slice().reverse();
    while (stack.length) {
      const [el, ctx] = stack.pop();
      const tag = el.localName;
      if (RECOLOR_SKIP.has(tag) || el.hasAttribute('data-pagetopdf')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none') continue;
      const op = ctx.op * (parseFloat(cs.opacity) || 0);
      if (cs.transitionDuration !== '0s' && /\b(all|color|fill|stroke|border|background|-webkit-text)/.test(cs.transitionProperty)) writes.transitions.add(el);
      const visible = cs.visibility === 'visible' && op > 0.05;

      if (MEDIA_TAGS.has(tag)) {
        // A fixed full-screen <canvas>/<video> behind the page is a background, not a backdrop.
        if (visible && cs.position !== 'fixed') {
          const r = el.getBoundingClientRect();
          if (r.width >= 100 && r.height >= 50) media.push({ el, r });
        }
        continue;
      }

      // ---- SVG: decide per <svg> once all of it has been read ----
      if (ctx.svg) {
        if (SVG_SKIP.has(tag)) continue;
        const child = tag === 'foreignObject' ? { ...ctx, svg: null, op } : { ...ctx, op };
        if (darken && (SVG_SHAPES.has(tag) || SVG_TEXT.has(tag))) {
          const sw = parseFloat(cs.strokeWidth) || 0;
          ctx.svg[SVG_TEXT.has(tag) ? 'texts' : 'shapes'].push({
            el, op, need: needFor(cs), fill: parseColor(cs.fill), stroke: sw > 0 ? parseColor(cs.stroke) : null,
          });
        }
        S.bgCtx.set(el, child);
        for (let c = el.lastElementChild; c; c = c.previousElementSibling) stack.push([c, child]);
        continue;
      }

      // ---- what this element was originally painted on ----
      let bd = ctx.bd, bgEl = ctx.bgEl, bgAlpha = 0;
      const bgc = parseColor(cs.backgroundColor);
      if (bgc && bgc.a > 0) { bd = mix(bgc, bd, bgc.a); bgAlpha = bgc.a; }
      const bgi = cs.backgroundImage;
      const clipText = cs.webkitBackgroundClip === 'text' || cs.backgroundClip === 'text';
      const hasGradient = bgi !== 'none' && bgi.includes('gradient');
      if (hasGradient && !clipText) {
        const cols = gradientColors(bgi);
        if (cols.length) {
          const avg = cols.reduce((s, c) => ({ r: s.r + c.r / cols.length, g: s.g + c.g / cols.length, b: s.b + c.b / cols.length, a: s.a + c.a / cols.length }), { r: 0, g: 0, b: 0, a: 0 });
          bd = mix(avg, bd, avg.a);
          bgAlpha = Math.max(bgAlpha, avg.a);
        }
      }
      if (bgAlpha >= 0.9) bgEl = el;
      const isRoot = el === document.documentElement || el === document.body;
      // (an opaque background of its own covers any image further up)
      const img = (ctx.img && bgEl !== el) || (keep && !isRoot && bgi !== 'none' && bgi.includes('url(') && isBackdropImage(el, cs));

      if (tag === 'svg') {
        const group = { root: el, img, bd, bgEl, texts: [], shapes: [] };
        groups.push(group);
        const child = { ...ctx, op, img, bgEl, svg: group };
        S.bgCtx.set(el, child);
        for (let c = el.lastElementChild; c; c = c.previousElementSibling) stack.push([c, child]);
        continue;
      }

      // ---- text and other things that must stay visible ----
      let rec = null;
      const fix = (prop, value, pseudo) => {
        if (!rec) { rec = { el, parent: ctx.rec, img, bgEl, fixes: [] }; recs.push(rec); }
        rec.fixes.push([prop, value, pseudo]);
      };
      if (hasGradient && clipText) {
        // Gradient text: the gradient is the text's paint, not a background. Keep it (darkened).
        const need = needFor(cs);
        const v = darken ? bgi.replace(COLOR_FN, s => readableColor(parseColor(s), need, op, ctx.bd) || s) : bgi;
        if (v !== bgi) fix('background-image', v);
        else if (!keep) writes.push([el, 'background-image', bgi]);
        if (v !== bgi && !keep) rec.keepBgi = bgi;
      } else if (!isRoot && ((hasGradient && keep) || (bgAlpha > 0 && bgAlpha < 0.9))) {
        // Decided below: gradients are dropped like background colours (url() images are kept),
        // except a see-through layer over a kept image (a scrim that keeps text on photos legible).
        bgs.push({ el, img, bgEl: ctx.bgEl, scrim: keep && bgAlpha < 0.9, bgc: bgc && bgc.a > 0 ? cs.backgroundColor : null, bgi: hasGradient ? bgi : null });
      }
      // Generated content (text, or decorative boxes such as gradient overlays and fades).
      const pseudos = [];
      for (const p of ['::before', '::after']) {
        const ps = getComputedStyle(el, p);
        const content = ps.content;
        if (content === 'none' || content === 'normal' || ps.display === 'none') continue;
        pseudos.push([p, ps]);
        const pbgc = parseColor(ps.backgroundColor), pbg = ps.backgroundImage;
        const pGrad = pbg !== 'none' && pbg.includes('gradient') && ps.webkitBackgroundClip !== 'text' && ps.backgroundClip !== 'text';
        let pa = pbgc ? pbgc.a : 0;
        if (pGrad) { const cols = gradientColors(pbg); if (cols.length) pa = Math.max(pa, cols.reduce((s, c) => s + c.a, 0) / cols.length); }
        if ((pGrad && keep) || (pa > 0 && pa < 0.9)) {
          bgs.push({ el, pseudo: p, img, bgEl, scrim: keep && pa < 0.9, bgc: pbgc && pbgc.a > 0 ? ps.backgroundColor : null, bgi: pGrad ? pbg : null });
        }
      }
      if (darken) {
        const need = needFor(cs);
        const colStr = cs.color;
        const nc = readableColor(parseColor(colStr), need, op, bd);
        if (nc) { fix('color', nc); rec.color = colStr; rec.shadow = cs.textShadow; }
        const fillStr = cs.webkitTextFillColor;
        if (fillStr !== colStr) { const v = readableColor(parseColor(fillStr), need, op, bd); if (v) fix('-webkit-text-fill-color', v); }
        if (parseFloat(cs.webkitTextStrokeWidth) > 0) { const v = readableColor(parseColor(cs.webkitTextStrokeColor), 4.5, op, bd); if (v) fix('-webkit-text-stroke-color', v); }
        if (cs.textDecorationLine !== 'none' && cs.textDecorationColor !== colStr) { const v = readableColor(parseColor(cs.textDecorationColor), 3, op, bd); if (v) fix('text-decoration-color', v); }
        // Generated text can't take inline styles: it gets a rule keyed on a data attribute.
        for (const [p, ps] of pseudos) {
          if (ps.content === '""') continue; // decorative box, no text
          const pfill = ps.webkitTextFillColor;
          const pc = pfill !== ps.color ? pfill : ps.color;
          if (nc && pc === colStr && pfill === cs.webkitTextFillColor) continue; // inherits the element's fix
          const v = readableColor(parseColor(pc), needFor(ps), op, bd);
          if (v) fix(null, textDecl(v), p);
        }
        if ((tag === 'input' || tag === 'textarea') && el.hasAttribute('placeholder')) {
          const v = readableColor(parseColor(getComputedStyle(el, '::placeholder').color), need, op, bd);
          if (v) fix(null, textDecl(v), '::placeholder');
        }
        if (cs.display.includes('list-item')) {
          const mc = getComputedStyle(el, '::marker').color;
          if (mc !== colStr) { const v = readableColor(parseColor(mc), need, op, bd); if (v) fix(null, `color: ${v} !important`, '::marker'); }
        }
        // Dividers and outlines that were visible on the dark page but vanish on white.
        if (!img && cs.borderStyle !== 'none' && relLum(bd) < 0.2) {
          for (const side of SIDES) {
            if (!(parseFloat(cs[`border${side}Width`]) > 0)) continue;
            const st = cs[`border${side}Style`];
            if (st === 'none' || st === 'hidden') continue;
            const c = parseColor(cs[`border${side}Color`]);
            if (!c || c.a < 0.02 || contrastOnWhite(c, op) >= 1.3) continue;
            const was = relLum(mix(c, bd, c.a * op)), under = relLum(bd);
            if ((Math.max(was, under) + 0.05) / (Math.min(was, under) + 0.05) < 1.2) continue; // invisible before too
            const v = readableColor(c, 1.5, op, null, false);
            if (v) writes.push([el, `border-${side.toLowerCase()}-color`, v]);
          }
        }
        // Blend modes meant for dark backgrounds (screen, difference, ...) wash text out on white.
        const blend = cs.mixBlendMode;
        if (blend !== 'normal' && blend !== 'multiply' && blend !== 'darken' && !img) writes.push([el, 'mix-blend-mode', 'normal']);
      }

      const child = { bd, op, img, bgEl, svg: null, rec: rec && rec.color ? rec : ctx.rec };
      S.bgCtx.set(el, child);
      if (el.shadowRoot) for (let c = el.shadowRoot.lastElementChild; c; c = c.previousElementSibling) stack.push([c, child]);
      for (let c = el.lastElementChild; c; c = c.previousElementSibling) stack.push([c, child]);
    }

    // ---- decide: text over a kept image keeps its colours ----
    // Only images inside the text's nearest opaque background count: an image outside it is
    // either hidden behind that background or a decorative overlay (glow, shade), and the text
    // was designed for the background colour, which is now gone.
    const overMedia = (el, bgEl) => {
      if (!media.length) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) return false;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      return media.some(m => cx >= m.r.left && cx <= m.r.right && cy >= m.r.top && cy <= m.r.bottom &&
        (!bgEl || bgEl.contains(m.el)) &&
        (!el.contains(m.el) || r.width * r.height <= 1.5 * m.r.width * m.r.height));
    };
    for (const b of bgs) {
      if (b.scrim && (b.img || overMedia(b.el, b.bgEl))) {
        if (!b.bgc) continue;
        writes.push(b.pseudo ? [b.el, null, `background-color: ${b.bgc} !important`, b.pseudo] : [b.el, 'background-color', b.bgc]);
      } else if (b.bgi && keep) {
        const urls = b.bgi.match(/url\([^)]*\)/g)?.join(', ') || 'none';
        writes.push(b.pseudo ? [b.el, null, `background-image: ${urls} !important`, b.pseudo] : [b.el, 'background-image', urls]);
      }
    }
    for (const rec of recs) {
      rec.skip = rec.img || overMedia(rec.el, rec.bgEl);
      if (!rec.skip) { for (const [p, v, pseudo] of rec.fixes) pseudo ? writes.push([rec.el, null, v, pseudo]) : writes.push([rec.el, p, v]); continue; }
      // Kept as designed. If an ancestor's colour changed, pin the original so it isn't inherited,
      // and keep its text-shadow (often what makes text on photos legible).
      if (rec.color && rec.parent && !rec.parent.skip) writes.push([rec.el, 'color', rec.color]);
      if (rec.shadow && rec.shadow !== 'none') writes.push([rec.el, 'text-shadow', rec.shadow]);
      if (rec.keepBgi) writes.push([rec.el, 'background-image', rec.keepBgi]);
    }
    for (const g of groups) {
      if (g.img || (!g.texts.length && !g.shapes.length) || overMedia(g.root, g.bgEl)) continue;
      const paints = [];
      for (const s of [...g.shapes, ...g.texts]) {
        if (s.fill && s.fill.a > 0.02) paints.push([s.fill, s.op]);
        if (s.stroke && s.stroke.a > 0.02) paints.push([s.stroke, s.op]);
      }
      if (!paints.length) continue;
      // An icon/logo drawn only in light colours (made for a dark page) is darkened as a whole;
      // an illustration with its own dark shapes is left alone except for light labels on white.
      const mono = paints.every(([c, op]) => contrastOnWhite(c, op) < 3);
      let darkBoxes = null;
      for (const s of mono ? [...g.shapes, ...g.texts] : g.texts) {
        const isText = SVG_TEXT.has(s.el.localName);
        const need = isText ? s.need : 3;
        const f = readableColor(s.fill, need, s.op, g.bd, isText || mono);
        const k = readableColor(s.stroke, 3, s.op, g.bd);
        if (!f && !k) continue;
        if (!mono) {
          darkBoxes ??= g.shapes.filter(sh => sh.fill && sh.fill.a > 0.5 && contrastOnWhite(sh.fill, sh.op) >= 3).map(sh => sh.el.getBoundingClientRect());
          const r = s.el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          if (darkBoxes.some(b => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom)) continue;
        }
        if (f) writes.push([s.el, 'fill', f]);
        if (k) writes.push([s.el, 'stroke', k]);
      }
    }
    return writes;
  }

  function applyRecolor(writes) {
    let pseudoDirty = false;
    const P = S.pseudo;
    for (const [el, prop, value, pseudo] of writes) {
      if (!pseudo) {
        // Switch transitions off in the same style change, or the new colour fades in over the
        // first frames (and a second capture right after restore() would read mid-fade colours).
        if (writes.transitions.has(el)) { setImportant(el, 'transition', 'none'); writes.transitions.delete(el); }
        setImportant(el, prop, value);
        continue;
      }
      const key = pseudo + value; // value: CSS declarations for the pseudo-element
      let tok = P.tokens.get(key);
      if (!tok) {
        tok = `c${P.tokens.size}`;
        P.tokens.set(key, tok);
        P.rules.push(`[data-ptp-fix~="${tok}"]${pseudo} { ${value}; }`);
        pseudoDirty = true;
      }
      const cur = el.getAttribute('data-ptp-fix');
      if (!cur) el.setAttribute('data-ptp-fix', tok);
      else if (!cur.split(' ').includes(tok)) el.setAttribute('data-ptp-fix', `${cur} ${tok}`);
      P.els.add(el);
    }
    if (pseudoDirty) {
      if (!P.style) { addStyle(''); P.style = S.styles[S.styles.length - 1]; }
      P.style.textContent = P.rules.join('\n');
    }
    return writes.length;
  }

  function removeBackgrounds(opts) {
    S.bgCtx = new WeakMap();
    S.pseudo = { tokens: new Map(), rules: [], els: new Set(), style: null };
    // Read the page as designed (before the stylesheet below hides its backgrounds)...
    const writes = recolorTrees([[document.documentElement, { bd: WHITE, op: 1, img: false, bgEl: null, svg: null, rec: null }]]);
    S.bgRoot = (document.body && S.bgCtx.get(document.body)?.bd) || WHITE;
    let css = `
      *, *::before, *::after { background-color: transparent !important; box-shadow: none !important; text-shadow: none !important; }
      html, body { background: #fff !important; }`;
    if (!opts.keepBackgroundImages) css += `\n*, *::before, *::after { background-image: none !important; }`;
    addStyle(css);
    // ...then change it in one go.
    applyRecolor(writes);
    // Recolour content that is added or restyled later (lazy loading while scrolling).
    S.bgPending = new Set();
    S.bgObs = new MutationObserver(queueRecolor);
    S.bgObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'], childList: true, subtree: true });
  }

  function queueRecolor(muts) {
    for (const m of muts) {
      if (m.type === 'attributes') {
        // Our own inline changes (and fixed-element hiding) aren't page changes; but a page that
        // rewrites the style attribute (frameworks re-rendering) may have wiped our colours.
        if (m.attributeName === 'style' && m.target.getAttribute('style') === S.inlineAfter.get(m.target)) continue;
        S.bgPending.add(m.target);
      } else for (const n of m.addedNodes) if (n.nodeType === 1) S.bgPending.add(n);
    }
  }

  const parentOf = el => el.parentElement || el.parentNode?.host || null;
  // Recolour what changed since the last call; returns the number of changes made.
  function recolorPending(budget = 8000) {
    if (!S?.bgObs) return 0;
    queueRecolor(S.bgObs.takeRecords());
    if (!S.bgPending.size) return 0;
    const batch = new Set();
    let n = 0;
    for (let el of S.bgPending) {
      if (n > budget) break;
      S.bgPending.delete(el);
      if (!el.isConnected) continue;
      while (el.ownerSVGElement) el = el.ownerSVGElement; // SVGs are judged as a whole
      batch.add(el);
      n += 1 + el.getElementsByTagName('*').length;
    }
    const roots = [];
    for (const el of batch) {
      let p = parentOf(el), nested = false;
      for (let q = p; q && !nested; q = parentOf(q)) nested = batch.has(q);
      if (nested) continue;
      let ctx = null;
      for (let q = p; q && !ctx; q = parentOf(q)) ctx = S.bgCtx.get(q);
      roots.push([el, ctx || { bd: S.bgRoot, op: 1, img: false, bgEl: null, svg: null, rec: null }]);
    }
    const changed = applyRecolor(recolorTrees(roots));
    S.bgObs.takeRecords(); // our own writes
    return changed;
  }

  // ---------- fixed / sticky handling ----------
  // Big transparent containers (chat widgets, overlays, side rails) should be classified by
  // where their visible content is, not by their own full-screen box.
  function contentRect(el) {
    const own = el.getBoundingClientRect();
    if (own.height < innerHeight * 0.5) return own;
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity, n = 0;
    for (const c of el.querySelectorAll('*')) {
      if (++n > 300) break;
      const r = c.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.height >= own.height * 0.9) continue;
      top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom);
      left = Math.min(left, r.left); right = Math.max(right, r.right);
    }
    return top === Infinity ? own : { top, bottom, left, right, width: right - left, height: bottom - top };
  }

  function classifyFixed(el) {
    const r = contentRect(el);
    const vw = innerWidth, vh = innerHeight;
    const cs = getComputedStyle(el);
    const z = parseInt(cs.zIndex, 10);
    const big = r.width >= vw * 0.9 && r.height >= vh * 0.9;
    // Full-screen layers behind the content are backgrounds: keep them in every frame.
    if (big && (isNaN(z) || z <= 0)) return 'background';
    // Tall rails (side navigation) belong with the start of the page.
    if (r.height > vh * 0.5) return 'top';
    // Zero-size elements (e.g. a reading-progress bar at 0% width) still grow later: classify by position.
    return (r.top + r.height / 2) < vh / 2 ? 'top' : 'bottom';
  }

  function registerPositioned(el) {
    if (S.positioned.has(el) || el === document.documentElement || el === document.body) return;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') {
      S.positioned.set(el, { kind: 'fixed', cls: classifyFixed(el) });
    } else if (cs.position === 'sticky' || cs.position === '-webkit-sticky') {
      S.positioned.set(el, { kind: 'sticky' });
      if (S.opts.adjustRepeating) {
        // Pin sticky elements to their natural position so they don't repeat.
        setImportant(el, 'position', 'relative');
        for (const p of ['top', 'bottom', 'left', 'right', 'inset']) setImportant(el, p, 'auto');
      }
    }
  }

  function scanPositioned() {
    for (const el of allElements()) registerPositioned(el);
  }

  // Cheap re-scan: find fixed/sticky ancestors of whatever is at a grid of points.
  function sampleNewPositioned() {
    const found = [];
    const vw = innerWidth, vh = innerHeight;
    const seen = new Set();
    for (let gy = 0; gy <= 8; gy++) {
      for (let gx = 0; gx <= 6; gx++) {
        const x = Math.min(vw - 1, (gx / 6) * vw), y = Math.min(vh - 1, (gy / 8) * vh);
        // Look through every layer: a full-screen transparent overlay must not hide what's below.
        for (let el of document.elementsFromPoint(x, y)) {
          for (; el && el !== document.body && el !== document.documentElement && !seen.has(el); el = el.parentElement) {
            seen.add(el);
            if (!S.positioned.has(el)) {
              const pos = getComputedStyle(el).position;
              if (pos === 'fixed' || pos === 'sticky') { registerPositioned(el); found.push(el); }
            }
          }
        }
      }
    }
    return found;
  }

  function applyFixedVisibility(phase) {
    if (!S.opts.adjustRepeating) return;
    for (const [el, info] of S.positioned) {
      if (info.kind !== 'fixed' || info.cls === 'background') continue;
      let show;
      if (phase === 'only') show = true;
      else if (phase === 'first') show = info.cls === 'top';
      else if (phase === 'last') show = info.cls === 'bottom';
      else show = false;
      if (show) {
        const rec = S.touched.get(el);
        for (const p of ['visibility', 'opacity']) {
          if (rec && p in rec) unsetInline(el, rec, p);
        }
      } else {
        // Descendants can override `visibility` (e.g. OneTrust banners), but not an ancestor's opacity.
        setImportant(el, 'visibility', 'hidden');
        setImportant(el, 'opacity', '0');
      }
    }
  }

  // ---------- scroller detection ----------
  function findInnerScroller() {
    let best = null, bestArea = 0;
    for (const el of allElements(document.body || document.documentElement)) {
      if (el.scrollHeight <= el.clientHeight + 40) continue;
      const cs = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(cs.overflowY)) continue;
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      if (w <= 0 || h <= 0) continue;
      const area = w * h;
      if (area > bestArea && area > innerWidth * innerHeight * 0.2) { best = el; bestArea = area; }
    }
    return best;
  }

  // App-style pages (Gmail, Claude, chat apps) are one screen tall and scroll inner panels
  // (the message/chat, and often a sidebar). Rather than scrolling a panel (which leaves the
  // rest of the page only in the first screen), temporarily make every scrolling panel as tall
  // as its content, growing each container around it by just enough pixels, so the whole page
  // scrolls normally. Heights stay definite (px, not `auto`) so things sized in % or pinned
  // top/bottom — e.g. Claude's sidebar — stretch along instead of collapsing.
  // Returns true when that worked; otherwise undoes everything and returns false.
  const EXPAND_PROPS = ['overflow-x', 'overflow-y', 'height', 'max-height', 'position', 'contain', 'flex-shrink'];
  function panelScrollers() {
    const out = [];
    for (const el of allElements(document.body || document.documentElement)) {
      if (el.scrollHeight <= el.clientHeight + 20 || el.clientHeight < 60) continue;
      if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
      out.push(el);
    }
    return out.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  }
  function growChain(el, extra) {
    const chain = [];
    for (let a = el; a && a.nodeType === 1; a = a.parentElement || a.getRootNode()?.host) chain.push(a);
    const target = el.getBoundingClientRect().bottom + scrollY + extra; // where its content will end
    // Read everything first, then write (avoids a layout per element).
    const plan = chain.map(a => {
      const cs = getComputedStyle(a);
      return { a, cs, h: cs.display === 'contents' ? NaN : parseFloat(cs.height), bottom: a.getBoundingClientRect().bottom + scrollY };
    });
    for (const { a, cs, h, bottom } of plan) {
      if (a !== el && bottom >= target - 1) break; // this container (and the ones above) already fit
      if (isNaN(h)) continue;
      S.expandTouched.add(a);
      setImportant(a, 'height', `${h + (a === el ? extra : target - bottom)}px`);
      if (cs.maxHeight !== 'none') setImportant(a, 'max-height', 'none');
      if (/size|strict|content/.test(cs.contain)) setImportant(a, 'contain', 'none');
      if (cs.position === 'fixed') setImportant(a, 'position', 'absolute'); // must scroll with the page
      // A grown item in a vertical flex stack must not be shrunk back to make room for its
      // siblings. Only for column flex: in a row, flex-shrink governs WIDTH, and pinning it
      // let Gmail's message column grow to ~100,000 px wide (pushing the email off-screen).
      const pcs = a.parentElement && getComputedStyle(a.parentElement);
      if (cs.flexShrink !== '0' && pcs && /flex/.test(pcs.display) && pcs.flexDirection.startsWith('column')) setImportant(a, 'flex-shrink', '0');
      if (a !== el && (!/visible/.test(cs.overflowY) || !/visible|clip/.test(cs.overflowX))) {
        // overflow-y: visible is computed as `auto` while overflow-x is hidden/auto, so clip x.
        setImportant(a, 'overflow-y', 'visible');
        setImportant(a, 'overflow-x', /visible/.test(cs.overflowX) ? 'visible' : 'clip');
      }
    }
  }
  async function expandScrollers(main, cap) {
    S.expanded = [];
    S.expandTouched = new Set();
    for (let pass = 0; pass < 4; pass++) {
      let grew = false;
      for (const el of panelScrollers()) {
        // Content height is measured once, before this panel is grown: content sized as
        // min-height: 100% grows along with the panel and would otherwise never "fit".
        let rec = S.expanded.find(x => x.el === el);
        if (!rec) {
          if (S.expanded.length >= 12) continue;
          rec = { el, startTop: el.scrollTop, want: el.scrollHeight };
          S.expanded.push(rec);
        }
        const extra = Math.min(rec.want - el.clientHeight, cap);
        if (extra <= 4) continue;
        el.scrollTop = 0;
        growChain(el, extra);
        grew = true;
        await raf();
      }
      if (!grew) break;
    }
    await raf(); await raf();
    const mainRec = S.expanded.find(x => x.el === main);
    if (mainRec && main.clientHeight >= Math.min(mainRec.want, main.clientHeight + cap) - 4 && windowScrolls()) {
      for (const x of S.expanded) x.el.scrollTop = 0;
      return true;
    }
    // Didn't work: put every element back exactly as it was.
    for (const el of S.expandTouched) {
      const rec = S.touched.get(el);
      if (rec) for (const p of EXPAND_PROPS) if (p in rec) unsetInline(el, rec, p);
    }
    for (const { el, startTop } of S.expanded) el.scrollTop = startTop;
    S.expanded = null;
    await raf();
    return false;
  }

  // The size the window can actually scroll over. Only the scrolling element counts: <body>
  // can report a far larger content size that never scrolls (Gmail parks hidden elements
  // ~100,000 px to the right), which would turn one page into hundreds of side-by-side shots.
  function docSize() {
    const se = document.scrollingElement || document.documentElement;
    let w = Math.max(se.scrollWidth, innerWidth);
    if (w > innerWidth + 4 && (!userScrollsX() || !windowScrollsX())) w = innerWidth;
    return { w, h: Math.max(se.scrollHeight, innerHeight) };
  }
  // Can the user scroll the page sideways at all? overflow-x hidden/clip on the root (or on
  // <body>, which propagates to the viewport when the root is visible) means no — even though
  // scripts could still scroll it, that content is not part of the page as seen.
  function userScrollsX() {
    const h = getComputedStyle(document.documentElement).overflowX;
    const v = h !== 'visible' || !document.body ? h : getComputedStyle(document.body).overflowX;
    return !/hidden|clip/.test(v);
  }
  function windowScrollsX() {
    const x0 = scrollX;
    window.scrollTo({ left: x0 + 40, top: scrollY, behavior: 'instant' });
    const moved = scrollX !== x0;
    window.scrollTo({ left: x0, top: scrollY, behavior: 'instant' });
    return moved;
  }

  // Does the window itself scroll? Some sites make <body> (or another element) the scroller
  // while its content is tall, so checking heights alone is not enough: try it.
  function windowScrolls() {
    const se = document.scrollingElement || document.documentElement;
    if (se.scrollHeight <= innerHeight + 4) return false;
    const y0 = scrollY;
    window.scrollTo({ left: scrollX, top: y0 + 40, behavior: 'instant' });
    const moved = scrollY !== y0;
    window.scrollTo({ left: scrollX, top: y0, behavior: 'instant' });
    if (moved) return true;
    // Already at the bottom? Try upwards.
    if (y0 > 0) {
      window.scrollTo({ left: scrollX, top: y0 - 40, behavior: 'instant' });
      const up = scrollY !== y0;
      window.scrollTo({ left: scrollX, top: y0, behavior: 'instant' });
      return up;
    }
    return false;
  }

  function measure() {
    const vw = document.documentElement.clientWidth || innerWidth;
    const vh = innerHeight;
    if (S.mode === 'element') {
      const el = S.scroller;
      const r = el.getBoundingClientRect();
      const top = r.top + el.clientTop, left = r.left + el.clientLeft;
      return {
        mode: 'element', vw, vh, dpr: devicePixelRatio,
        el: { x: left, y: top, w: el.clientWidth, h: el.clientHeight },
        maxScroll: el.scrollHeight - el.clientHeight,
        docW: vw, docH: vh + (el.scrollHeight - el.clientHeight),
      };
    }
    const d = docSize();
    return { mode: 'window', vw, vh, dpr: devicePixelRatio, docW: d.w, docH: d.h };
  }

  // ---------- content collection ----------
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'SELECT', 'OPTION', 'svg', 'SVG', 'IFRAME']);

  function regionFor(x, y, regions) {
    for (const g of regions) if (x >= g.sx && x < g.sx + g.sw && y >= g.sy && y < g.sy + g.sh) return g;
    return null;
  }

  // Structural blocks the PDF splitter should avoid cutting (table rows, list items, code,
  // figures, quotes, cards) and headings it should keep with the content that follows.
  const BLOCK_TAGS = {
    TR: 'row', LI: 'item', DT: 'item', DD: 'item', PRE: 'pre', FIGURE: 'figure', BLOCKQUOTE: 'quote',
    H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
  };
  const ROLE_KINDS = { row: 'row', listitem: 'item', heading: 'heading', article: 'card' };
  const CARD_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'A', 'FORM', 'FIELDSET', 'DETAILS', 'TABLE', 'UL', 'OL']);
  const CARD_STYLE_BUDGET = 800; // getComputedStyle calls per frame for card detection

  // A "card": a box that visibly stands out (border, background or shadow) and is much
  // smaller than a page. Cached per element for the whole capture.
  function isCard(el, r, vh) {
    if (r.height < 48 || r.width < 120 || r.height > Math.max(1200, vh * 1.4)) return false;
    let v = S.cards.get(el);
    if (v !== undefined) return v;
    const cs = getComputedStyle(el);
    const border = ['Top', 'Bottom'].some(side => parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none' && (parseColor(cs[`border${side}Color`])?.a ?? 1) > 0.1);
    const shadow = cs.boxShadow && cs.boxShadow !== 'none';
    const bg = parseColor(cs.backgroundColor);
    const filled = (bg && bg.a > 0.1) || (cs.backgroundImage && cs.backgroundImage !== 'none');
    v = !!(border || shadow || filled) && !(r.width >= innerWidth * 0.98 && !border && !shadow); // full-width bands are sections, not cards
    S.cards.set(el, v);
    return v;
  }

  // Threaded content (Reddit/forum comments, nested lists): a post's or comment's own part —
  // author line, body, action row — runs from its top to where its first nested reply starts.
  // Returns that height (or the whole height for a post/comment without replies), else 0.
  const UNIT_NESTED = 'article, [role="article"], [role="comment"]';
  function ownContentHeight(el, r) {
    const role = el.getAttribute('role');
    const isPost = el.tagName === 'ARTICLE' || role === 'article' || role === 'comment';
    const isItem = el.tagName === 'LI' || role === 'listitem';
    if (!isPost && !isItem) return 0;
    const nestedSel = isPost ? UNIT_NESTED : 'ul, ol, [role="list"]';
    let first = Infinity;
    for (const n of el.querySelectorAll(nestedSel)) {
      const t = n.getBoundingClientRect().top;
      if (t > r.top + 8 && t < first) first = t;
      if (first < Infinity) break; // document order: the first nested one is the topmost
    }
    if (first === Infinity) return isPost ? r.height : 0; // plain list items stay 'item'
    const own = first - r.top;
    return own >= 24 && own < r.height - 8 ? own : 0;
  }

  function collect(regions) {
    const vw = innerWidth, vh = innerHeight;
    const text = [], links = [], media = [], blocks = [];
    let styleBudget = CARD_STYLE_BUDGET;
    const visCache = new Map();
    const visible = el => {
      if (visCache.has(el)) return visCache.get(el);
      if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) { visCache.set(el, false); return false; }
      const cs = getComputedStyle(el);
      let ok = cs.visibility !== 'hidden' && cs.visibility !== 'collapse' && parseFloat(cs.opacity) > 0.05 && cs.display !== 'none';
      if (ok) { const c = parseColor(cs.color); if (c && c.a < 0.05 && !cs.webkitTextFillColor.includes('rgb')) ok = false; }
      if (ok) { const r = el.getBoundingClientRect(); ok = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw; }
      visCache.set(el, ok);
      return ok;
    };
    const range = document.createRange();
    const push = (arr, r, extra) => {
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      const g = regionFor(cx, cy, regions);
      if (!g) return;
      arr.push({ ...extra, x: r.left - g.sx + g.dx, y: r.top - g.sy + g.dy, w: r.width, h: r.height });
    };

    // A text run: its words joined by single spaces. Runs of several words also carry `ws`,
    // each word's [left, right] relative to the run's x (0.1 px), so exports can remove exactly
    // the words / characters under a redaction box (lib/export.js charBoxes).
    const pushRun = line => push(text, line, line.ws.length > 2 ? { t: line.t, ws: line.ws.map(v => Math.round(v * 10) / 10) } : { t: line.t });

    for (const el of allElements(document.body || document.documentElement)) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      // Text nodes directly inside this element (and its shadow root's are handled as elements).
      let hasText = false;
      for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3 && /\S/.test(n.data)) { hasText = true; break; }
      if (hasText && visible(el)) {
        for (let n = el.firstChild; n; n = n.nextSibling) {
          if (n.nodeType !== 3 || !/\S/.test(n.data)) continue;
          const data = n.data;
          const re = /\S+/g;
          let m, line = null;
          while ((m = re.exec(data))) {
            range.setStart(n, m.index);
            range.setEnd(n, m.index + m[0].length);
            const rects = range.getClientRects();
            let r = null;
            for (const rr of rects) if (rr.width > 0.5 && rr.height > 0.5) { r = rr; break; }
            if (!r || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) { if (line) { pushRun(line); line = null; } continue; }
            if (line && Math.abs(r.top - line.top) < Math.max(2, r.height * 0.3) && r.left >= line.right - 1 && r.left - line.right < r.height * 1.5) {
              line.t += ' ' + m[0];
              line.ws.push(r.left - line.left, r.right - line.left);
              line.right = r.right; line.width = line.right - line.left;
              line.top = Math.min(line.top, r.top); line.bottom = Math.max(line.bottom, r.bottom); line.height = line.bottom - line.top;
            } else {
              if (line) pushRun(line);
              line = { t: m[0], ws: [0, r.width], left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
            }
          }
          if (line) pushRun(line);
        }
      }
      if (el.tagName === 'A' && el.href && visible(el)) {
        const href = el.href;
        if (/^(https?|mailto|ftp):/i.test(href)) {
          for (const r of el.getClientRects()) {
            if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= vh) continue;
            push(links, r, { href });
          }
        }
      }
      if ((el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'CANVAS' || el.tagName === 'PICTURE' || el.tagName === 'FIGURE') && visible(el)) {
        const r = el.getBoundingClientRect();
        if (r.width >= 40 && r.height >= 40 && r.top >= -1 && r.bottom <= vh + 1) push(media, r, {});
      }
      // Blocks are recorded in the frame where their top edge is visible, with their full
      // box (which may extend below the viewport).
      let kind = BLOCK_TAGS[el.tagName];
      if (!kind) { const role = el.getAttribute('role'); if (role) kind = ROLE_KINDS[role]; }
      if (!kind && el.tagName === 'ARTICLE') kind = 'card';
      const cardCandidate = (!kind || kind === 'item') && S && styleBudget > 0 && (kind || CARD_TAGS.has(el.tagName)) && el.firstElementChild;
      if (kind || cardCandidate) {
        const r = el.getBoundingClientRect();
        if (r.height >= 4 && r.width >= 4 && r.top >= 0 && r.top < vh && r.right > 0 && r.left < vw) {
          if (cardCandidate) {
            if (!S.cards.has(el)) styleBudget--;
            if (isCard(el, r, vh)) kind = 'card'; // also upgrades a styled list item
          }
          if (kind && visible(el)) {
            const g = regionFor(Math.min(Math.max(r.left, 0), vw - 1), r.top, regions);
            if (g) {
              blocks.push({ kind, x: r.left - g.sx + g.dx, y: r.top - g.sy + g.dy, w: r.width, h: r.height });
              const own = ownContentHeight(el, r);
              if (own) blocks.push({ kind: 'unit', x: r.left - g.sx + g.dx, y: r.top - g.sy + g.dy, w: r.width, h: own });
            }
          }
        }
      }
    }
    return { text, links, media, blocks };
  }

  // ---------- public API ----------
  async function prepare(opts) {
    if (S) restore();
    S = {
      opts, touched: new Map(), inlineOrig: new Map(), inlineAfter: new Map(), styles: [], positioned: new Map(), cards: new WeakMap(),
      startX: scrollX, startY: scrollY, mode: 'window', scroller: null, scrollerStart: 0,
    };
    addStyle(`html, body { scroll-behavior: auto !important; } * { caret-color: transparent !important; }`);
    if (opts.hideScrollbars) {
      addStyle(`html { scrollbar-width: none !important; } html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }`);
    }
    if (opts.removeBackgrounds) removeBackgrounds(opts);

    if (opts.keepScroll) {
      // Visible-area capture: leave the page where the user is looking. Don't unlock it,
      // don't switch to an inner scroller, don't scroll. Hiding the scrollbar can reflow
      // the page, so put the scroll position back where it was.
      window.scrollTo({ left: S.startX, top: S.startY, behavior: 'instant' });
      await raf(); await raf();
      return { ...measure(), vw: innerWidth }; // the whole window, classic scrollbar included
    }

    // Scroll-locked page (a modal/consent manager set overflow:hidden on html/body while the
    // document itself is long): unlock it for the capture; restore() puts it back.
    if (!windowScrolls()) {
      const b = document.body, h = document.documentElement;
      const tall = b && Math.max(b.scrollHeight, h.scrollHeight) > innerHeight + 40;
      const locked = b && [h, b].some(el => /hidden|clip/.test(getComputedStyle(el).overflowY));
      if (tall && locked) {
        for (const el of [h, b]) {
          setImportant(el, 'overflow', 'visible');
          setImportant(el, 'overflow-y', 'visible');
          setImportant(el, 'height', 'auto');
          setImportant(el, 'max-height', 'none');
          if (getComputedStyle(el).position === 'fixed') setImportant(el, 'position', 'static');
        }
        S.unlocked = windowScrolls();
        if (!S.unlocked) { // didn't help: put html/body back exactly as they were
          for (const el of [h, b]) {
            const rec = S.touched.get(el);
            if (!rec) continue;
            for (const p of ['overflow', 'overflow-y', 'height', 'max-height', 'position']) {
              if (p in rec) unsetInline(el, rec, p);
            }
          }
        }
      }
    }
    if (opts.advancedScrolling && !windowScrolls()) {
      const el = findInnerScroller();
      if (el && !(await expandScrollers(el, Math.max(2000, Number(opts.maxHeight) || 60000)))) {
        // Couldn't expand the layout: scroll the inner element itself (the older approach).
        S.mode = 'element'; S.scroller = el; S.scrollerStart = el.scrollTop; el.scrollTop = 0;
      }
    }
    if (S.mode === 'window') window.scrollTo({ left: 0, top: 0, behavior: 'instant' });

    if (opts.preScroll && S.mode === 'window') {
      // Walk the page once to trigger lazy loading, then come back up.
      const cap = opts.maxHeight || 60000;
      for (let y = 0; y < Math.min(docSize().h, cap); y += innerHeight) {
        window.scrollTo({ left: 0, top: y, behavior: 'instant' });
        await sleep(120);
      }
      window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    }
    recolorPending(Infinity); // content loaded by the pre-scroll
    await raf(); await raf();
    scanPositioned();
    // Watch for elements that turn fixed/sticky later (e.g. headers that stick after scrolling).
    S.changed = new Set();
    S.observer = new MutationObserver(muts => {
      for (const m of muts) {
        if (m.type === 'attributes') S.changed.add(m.target);
        else for (const n of m.addedNodes) if (n.nodeType === 1) S.changed.add(n);
      }
    });
    S.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'], childList: true, subtree: true });
    await raf();
    return measure();
  }

  // Register elements whose class/style changed (or that were added) and are now fixed/sticky.
  function checkChanged() {
    if (!S.changed || !S.changed.size) return 0;
    const before = S.positioned.size;
    let budget = 3000;
    for (const el of S.changed) {
      if (!el.isConnected) continue;
      registerPositioned(el);
      if (el.childElementCount && budget > 0) {
        for (const c of el.querySelectorAll('*')) { if (--budget <= 0) break; registerPositioned(c); }
      }
    }
    S.changed.clear();
    return S.positioned.size - before;
  }

  // Let entrance animations (fade/slide-ins triggered by scrolling into view) finish.
  async function waitForAnimations(maxMs = 2500) {
    if (!document.getAnimations) return;
    const vh = innerHeight, vw = innerWidth;
    const anims = document.getAnimations().filter(a => {
      if (a.playState !== 'running' || !a.effect) return false;
      const t = a.effect.getComputedTiming();
      if (!isFinite(t.endTime) || t.endTime - (t.localTime || 0) > maxMs) return false; // looping / very long
      const el = a.effect.target;
      if (!el || !el.getBoundingClientRect) return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    });
    if (!anims.length) return;
    await Promise.race([Promise.all(anims.map(a => a.finished.catch(() => {}))), sleep(maxMs)]);
    await raf();
  }

  // Wait for lazily loaded images in the viewport (they start loading once scrolled into view),
  // then give fade-in transitions a moment.
  async function waitForVisibleImages(maxMs = 2000) {
    const vh = innerHeight, vw = innerWidth;
    const pending = () => [...document.images].filter(img => {
      if (img.complete) return false; // loaded, failed, or no source yet
      const r = img.getBoundingClientRect();
      return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    });
    let waiting = pending();
    if (!waiting.length) return;
    const t0 = performance.now();
    while (waiting.length && performance.now() - t0 < maxMs) {
      await sleep(100);
      waiting = waiting.filter(img => !img.complete);
    }
    await sleep(150);
  }

  async function frame({ x = 0, y = 0, phase = 'middle', delay = 150 }) {
    if (S.opts.keepScroll) return frameInPlace(delay);
    applyFixedVisibility(phase);
    let regions;
    if (S.mode === 'element') {
      S.scroller.scrollTop = y;
      await raf(); await raf();
      if (delay) await sleep(delay);
      await waitForVisibleImages();
      await waitForAnimations();
      if (recolorPending()) { await raf(); await raf(); } // lazily loaded content
      const m = measure();
      const st = S.scroller.scrollTop;
      const er = m.el;
      if (phase === 'first' || phase === 'only') {
        regions = [{ sx: 0, sy: 0, sw: m.vw, sh: m.vh, dx: 0, dy: 0 }];
        if (phase === 'only') regions[0].dy = 0;
      } else {
        regions = [{ sx: er.x, sy: er.y, sw: er.w, sh: er.h, dx: er.x, dy: er.y + st }];
        if (phase === 'last') {
          const below = er.y + er.h;
          if (below < m.vh) regions.push({ sx: 0, sy: below, sw: m.vw, sh: m.vh - below, dx: 0, dy: below + st });
        }
      }
      const c = collect(regions);
      return { ...m, scrollX: 0, scrollY: st, regions, ...c };
    }
    window.scrollTo({ left: x, top: y, behavior: 'instant' });
    await raf(); await raf();
    if (delay) await sleep(delay);
    await waitForVisibleImages();
    await waitForAnimations();
    if (recolorPending()) { await raf(); await raf(); } // lazily loaded content
    // Elements that only become fixed once scrolled (e.g. "sticky" headers implemented in JS).
    if (S.opts.adjustRepeating && phase !== 'first' && phase !== 'only') {
      const fresh = checkChanged() + sampleNewPositioned().length;
      if (fresh) { applyFixedVisibility(phase); await raf(); await raf(); }
    } else {
      checkChanged();
    }
    const m = measure();
    const regions2 = [{ sx: 0, sy: 0, sw: m.vw, sh: m.vh, dx: scrollX, dy: scrollY }];
    const c = collect(regions2);
    return { ...m, scrollX, scrollY, regions: regions2, ...c };
  }

  // Visible-area capture: no scrolling; the viewport is the whole image, so everything is
  // collected in viewport coordinates. Fixed/sticky elements stay exactly as they are.
  async function frameInPlace(delay) {
    await raf(); await raf();
    if (delay) await sleep(delay);
    await waitForVisibleImages();
    await waitForAnimations();
    if (recolorPending()) { await raf(); await raf(); }
    const m = measure();
    // innerWidth, not clientWidth: a visible classic scrollbar is part of the screenshot.
    const vw = innerWidth;
    const regions = [{ sx: 0, sy: 0, sw: vw, sh: m.vh, dx: 0, dy: 0 }];
    return { ...m, mode: 'visible', vw, docW: vw, docH: m.vh, scrollX, scrollY, regions, ...collect(regions) };
  }

  function restore() {
    if (!S) return;
    S.observer?.disconnect();
    S.bgObs?.disconnect();
    for (const el of S.pseudo?.els || []) el.removeAttribute('data-ptp-fix');
    for (const st of S.styles) st.remove();
    restoreInline();
    if (S.mode === 'element' && S.scroller) S.scroller.scrollTop = S.scrollerStart;
    window.scrollTo({ left: S.startX, top: S.startY, behavior: 'instant' });
    for (const { el, startTop } of S.expanded || []) el.scrollTop = startTop; // panels we expanded
    S = null;
    return true;
  }

  function info() {
    return {
      url: location.href, title: document.title,
      canScroll: docSize().h > innerHeight + 4 || !!findInnerScroller(),
    };
  }

  async function probe({ y, wait = 900 }) {
    applyFixedVisibility('middle');
    window.scrollTo({ left: 0, top: y, behavior: 'instant' });
    await sleep(wait);
    return measure();
  }

  // Watchdog: if the extension stops driving the capture (its service worker crashed, or a
  // failure kept it from calling restore()), put the page back by itself. A running capture
  // calls in every few seconds; 25 s of silence means it is gone.
  let lastCall = 0, watchdog = null;
  const driven = fn => (...args) => {
    lastCall = Date.now();
    if (!watchdog) {
      watchdog = setInterval(() => {
        if (S && Date.now() - lastCall > 25000) restore();
        if (!S) { clearInterval(watchdog); watchdog = null; }
      }, 5000);
    }
    return fn(...args);
  };

  window.__ptpAgent = { prepare: driven(prepare), frame: driven(frame), probe: driven(probe), restore, measure: driven(() => measure()), info };
})();
