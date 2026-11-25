// Objective check for "Remove backgrounds": injects extension/agent.js into a page, runs
// prepare({removeBackgrounds}) + a frame() per viewport (like a real capture), then counts
// text that has poor contrast against the now-white page. Also checks restore() puts the
// DOM back exactly as it was.
//
//   node test/contrast.mjs [--agent=path/to/agent.js] [--show] [--dark] <url|fixture.html>...
// --dark emulates prefers-color-scheme: dark (many sites then render a dark theme).
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const agentPath = args.find(a => a.startsWith('--agent='))?.slice(8) || path.join(root, '..', 'extension', 'agent.js');
const show = args.includes('--show');
const targets = args.filter(a => !a.startsWith('--'));
const agentSrc = fs.readFileSync(agentPath, 'utf8');

const server = http.createServer((req, res) => {
  const f = path.join(root, 'fixtures', decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(path.join(root, 'fixtures')) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: 'chromium' });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 }, bypassCSP: true, colorScheme: args.includes('--dark') ? 'dark' : 'light',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
});

// Runs in the page: list text runs with their contrast against white.
function audit() {
  const cvs = document.createElement('canvas'); cvs.width = cvs.height = 1;
  const g = cvs.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const parse = s => {
    if (!s) return null;
    if (cache.has(s)) return cache.get(s);
    let c = null;
    const m = /^rgba?\(([^)]+)\)$/.exec(s);
    if (m) { const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); c = { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    else { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = s; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; c = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; }
    cache.set(s, c); return c;
  };
  const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = c => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const onWhite = (c, a) => ({ r: c.r * a + 255 * (1 - a), g: c.g * a + 255 * (1 - a), b: c.b * a + 255 * (1 - a) });
  const contrast = c => 1.05 / (lum(c) + 0.05);
  const opCache = new Map();
  const opacity = el => {
    if (!el || el.nodeType !== 1) return 1;
    if (opCache.has(el)) return opCache.get(el);
    const v = parseFloat(getComputedStyle(el).opacity) * opacity(el.parentElement || el.getRootNode().host);
    opCache.set(el, v); return v;
  };
  const media = [...document.querySelectorAll('img,video,canvas,picture')].map(e => e.getBoundingClientRect()).filter(r => r.width > 100 && r.height > 50);
  const overImage = (el, r) => {
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (media.some(m => cx >= m.left && cx <= m.right && cy >= m.top && cy <= m.bottom)) return true;
    for (let e = el; e && e !== document.body; e = e.parentElement) if (/url\(/.test(getComputedStyle(e).backgroundImage)) return true;
    return false;
  };
  const gradColors = s => (s.match(/(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^()]*\)/g) || []).map(parse).filter(Boolean);
  const textColor = (el, cs) => {
    const fill = parse(cs.webkitTextFillColor);
    if (fill && fill.a > 0) return [fill];
    for (let e = el; e; e = e.parentElement) {
      const ecs = getComputedStyle(e);
      if (ecs.webkitBackgroundClip === 'text' || ecs.backgroundClip === 'text') {
        const cols = gradColors(ecs.backgroundImage);
        return cols.length ? cols : []; // gradient text whose gradient was removed: invisible
      }
    }
    const stroke = parseFloat(cs.webkitTextStrokeWidth) > 0 && parse(cs.webkitTextStrokeColor);
    if (stroke && stroke.a > 0) return [stroke];
    return null; // transparent by design (e.g. hidden labels)
  };
  const items = [];
  const check = (el, cs, text, pseudo) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || cs.visibility !== 'visible' || cs.display === 'none') return;
    const op = opacity(el);
    if (op < 0.05) return;
    const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const cols = textColor(el, cs);
    if (!cols) return;
    let worst = cols.length ? Math.min(...cols.map(c => contrast(onWhite(c, c.a * op)))) : 1;
    if (cs.mixBlendMode === 'screen' || cs.mixBlendMode === 'lighten') worst = 1;
    items.push({ text: (pseudo ? `[${pseudo}] ` : '') + text.slice(0, 50), color: cols.map(c => `${c.r},${c.g},${c.b},${+c.a.toFixed(2)}`).join(' | '), contrast: +worst.toFixed(2), need, fail: worst < need, img: overImage(el, r) });
  };
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n; (n = tw.nextNode());) {
    const t = n.nodeValue.trim();
    const el = n.parentElement;
    if (!t || !el || seen.has(el) || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|OPTION|TITLE)$/.test(el.tagName)) continue;
    seen.add(el);
    check(el, getComputedStyle(el), t, '');
  }
  for (const el of document.body.querySelectorAll('*')) {
    for (const p of ['::before', '::after']) {
      const cs = getComputedStyle(el, p);
      if (!/^["']/.test(cs.content) || cs.content.length < 4 || !cs.webkitTextFillColor || cs.display === 'none') continue;
      check(el, Object.assign({}, { webkitTextFillColor: cs.webkitTextFillColor, webkitTextStrokeWidth: cs.webkitTextStrokeWidth, webkitTextStrokeColor: cs.webkitTextStrokeColor, visibility: cs.visibility, display: cs.display, fontSize: cs.fontSize, fontWeight: cs.fontWeight, mixBlendMode: cs.mixBlendMode }), cs.content, p);
    }
    if (el.matches('input[placeholder],textarea[placeholder]') && !el.value) {
      const cs = getComputedStyle(el, '::placeholder');
      check(el, { webkitTextFillColor: cs.color, visibility: 'visible', display: 'block', fontSize: cs.fontSize, fontWeight: cs.fontWeight, webkitTextStrokeWidth: '0px' }, el.placeholder, '::placeholder');
    }
  }
  return items;
}

const OPTS = { removeBackgrounds: true, darkenLightText: true, keepBackgroundImages: true, adjustRepeating: true, hideScrollbars: true, advancedScrolling: true };
const summary = [];
for (const t of targets) {
  const url = /^https?:/.test(t) ? t : `${base}/${t}`;
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForTimeout(/^https?:/.test(t) ? 3000 : 300);
    const original = await page.evaluate(() => document.documentElement.outerHTML);
    await (await page.addScriptTag({ content: agentSrc })).evaluate(s => s.remove());
    // Round trip without scrolling: the DOM must come back byte-for-byte.
    await page.evaluate(o => window.__ptpAgent.prepare(o), OPTS);
    await page.evaluate(() => window.__ptpAgent.restore());
    const roundTrip = await page.evaluate(() => document.documentElement.outerHTML);
    const t0 = Date.now();
    const m = await page.evaluate(o => window.__ptpAgent.prepare(o), OPTS);
    const prepMs = Date.now() - t0;
    // Walk the page like a capture does (lazy content appears while scrolling).
    const h = Math.min(m.docH || m.h || 20000, 20000);
    for (let y = 0; y < h; y += 800) await page.evaluate(y => window.__ptpAgent.frame({ y, phase: 'middle', delay: 50 }), y);
    // Audit right after a frame, i.e. in the state a screenshot would see.
    const items = await page.evaluate(`(async () => { await window.__ptpAgent.frame({ y: 0, phase: 'middle', delay: 50 }); return (${audit})(); })()`);
    await page.evaluate(() => window.__ptpAgent.restore());
    const afterRestore = await page.evaluate(() => document.documentElement.outerHTML);
    const fails = items.filter(i => i.fail && !i.img);
    summary.push({ page: t.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40), elements: await page.evaluate(() => document.getElementsByTagName('*').length), prepMs, texts: items.length, lowContrast: fails.length, overImageLow: items.filter(i => i.fail && i.img).length, restoredExact: original === roundTrip, restoredAfterCapture: original === afterRestore, leftover: (afterRestore.match(/data-ptp|data-pagetopdf/g) || []).length });
    if (show) { console.log(`--- ${t}`); for (const f of fails.slice(0, 40)) console.log(JSON.stringify(f)); }
  } catch (e) {
    summary.push({ page: t, error: String(e.message || e).slice(0, 200) });
  }
  await page.close();
}
console.table(summary);
await browser.close();
server.close();
