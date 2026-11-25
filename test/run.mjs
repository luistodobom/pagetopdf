// End-to-end test runner: loads the unpacked extension into Playwright's
// Chromium, captures pages through the real capture pipeline, and writes the
// resulting PNG/PDF files to test/out for inspection (see test/check.py).
//
//   node test/run.mjs                 # local fixtures
//   node test/run.mjs --web           # also real websites
//   node test/run.mjs --only=long     # filter by case name
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(root, '.build');
const out = path.join(root, 'out');
const args = process.argv.slice(2);
const only = args.find(a => a.startsWith('--only='))?.slice(7);
const headed = args.includes('--headed');

// Copy the extension, granting host access up-front (normally activeTab from a user gesture).
// Everything else, including `debugger` for hi-res, is exactly as shipped.
fs.rmSync(ext, { recursive: true, force: true });
fs.cpSync(path.join(root, '..', 'extension'), ext, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
mf.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf, null, 2));
fs.mkdirSync(out, { recursive: true });

// Fixture server
const server = http.createServer((req, res) => {
  const f = path.join(root, 'fixtures', decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(path.join(root, 'fixtures')) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

// Redaction boxes computed from the fixture's layout (runs in the captured page, document
// coordinates). Returns the edits plus what the checker (test/check_redact.py) expects.
function redactEdits(opt) {
  const word = (sel, w) => {
    const el = document.querySelector(sel);
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode());) {
      const i = n.data.indexOf(w);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + w.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height };
    }
    throw new Error(`no ${w} in ${sel}`);
  };
  const box = (el) => { const b = document.querySelector(el).getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height }; };
  const union = (a, b) => { const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y); return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }; };
  const red = r => ({ type: 'redact', x: r.x, y: r.y, w: r.w, h: r.h, color: '#000' });
  const pad = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
  const shapes = [];
  // (a) two whole words in the middle of a run
  shapes.push(red(pad(union(word('#pa', 'MARMOSETX'), word('#pa', 'NARWHALY')), 1)));
  // (b) middle of a long run + the left half of PANGOLINQX
  const pg = word('#pb', 'PANGOLINQX');
  const b = union(word('#pb', 'OCELOTPRIME'), { ...pg, w: pg.w / 2 });
  shapes.push(red({ x: b.x - 1, y: b.y + 2, w: b.w + 1, h: b.h - 4 }));
  // only the bottom third of a word (vertical partial overlap counts as covered)
  const wl = word('#pv', 'WOMBATLOW');
  shapes.push(red({ x: wl.x + 2, y: wl.y + wl.h * 0.7, w: wl.w - 4, h: wl.h * 0.3 }));
  // (c) one word of a link; the second line of a wrapped link
  shapes.push(red(pad(word('#pc', 'ACCOUNTREF'), 1)));
  shapes.push(red(pad(word('#wrap', 'WRAPTAILZ'), 1)));
  // (d) the image
  shapes.push(red(box('#pic')));
  // (e) one box from KINKAJOUTOP down to AXOLOTLDOWN, across #band2 (removed in the crop case)
  shapes.push(red(pad(union(word('#pe1', 'KINKAJOUTOP'), word('#pe2', 'AXOLOTLDOWN')), 1)));
  if (opt?.later) {
    // Shapes added after the redactions, drawn over them: they must not show what is underneath.
    const a = shapes[0];
    shapes.push({ type: 'highlight', x: a.x - 20, y: a.y - 4, w: a.w + 40, h: a.h + 8, color: '#facc15' });
    shapes.push({ type: 'arrow', x1: b.x - 40, y1: b.y - 30, x2: b.x + b.w / 2, y2: b.y + b.h / 2, color: '#ef4444', width: 3 });
    shapes.push({ type: 'text', x: box('#pic').x + 10, y: box('#pic').y + 40, text: 'Note', color: '#22c55e', size: 22 });
  }
  const main = box('main'), band = box('#band'), band2 = box('#band2');
  const edits = { crop: null, cuts: [], shapes };
  if (opt?.crop) {
    edits.crop = { x: main.x + 20, y: 0, w: main.w - 40, h: document.documentElement.scrollHeight };
    edits.cuts = [{ axis: 'y', from: band.y, to: band.y + band.h }, { axis: 'y', from: band2.y, to: band2.y + band2.h }];
  }
  return {
    edits,
    expect: {
      gone: ['MARMOSETX', 'NARWHALY', 'OCELOTPRIME', 'TAPIRSECOND', 'PANGOLINQX', 'PANGOL', 'WOMBATLOW', 'ACCOUNTREF', 'WRAPTAILZ', 'KINKAJOUTOP', 'AXOLOTLDOWN'],
      kept: ['Alpha', 'bravo', 'charlie', 'delta', 'echo', 'leftsideone', 'leftsidetwo', 'rightsideone', 'rightsidetwo', 'upperline', 'keepvisible', 'trailingword', 'Statement', 'March', 'Public', 'Wrapped', 'seamabove', 'staysabove', 'seambelow', 'staysbelow', 'Closing'],
      goneUrls: ['private.example', 'ACCOUNT-778899', 'wrapped.example', 'SECRETWRAP'],
      keptUrls: ['https://public.example/okay'],
      goneMeta: ['MARMOSETX'],
    },
  };
}

const CASES = [
  { name: 'long', url: `${base}/long.html` },
  { name: 'long-nobg', url: `${base}/long.html`, o: { removeBackgrounds: true } },
  { name: 'dark', url: `${base}/dark.html` },
  { name: 'dark-nobg', url: `${base}/dark.html`, o: { removeBackgrounds: true } },
  { name: 'dark-nobg-noimg', url: `${base}/dark.html`, o: { removeBackgrounds: true, keepBackgroundImages: false } },
  { name: 'long-hires', url: `${base}/long.html`, o: { hiRes: true, hiResScale: 2 } },
  { name: 'long-hires3', url: `${base}/long.html`, o: { hiRes: true, hiResScale: 3 } },
  { name: 'app', url: `${base}/app.html` },
  { name: 'long-a4-margins', url: `${base}/long.html`, pdf: { paperSize: 'a4', marginMm: 12 } },
  { name: 'long-edits', url: `${base}/long.html`, edits: { crop: { x: 200, y: 0, w: 880, h: 3000 }, shapes: [{ type: 'redact', x: 230, y: 150, w: 400, h: 60, color: '#000' }, { type: 'arrow', x1: 700, y1: 400, x2: 600, y2: 300, color: '#ef4444', width: 3 }, { type: 'highlight', x: 230, y: 300, w: 500, h: 40, color: '#facc15' }, { type: 'text', x: 650, y: 420, text: 'Look here', color: '#ef4444', size: 22 }] } },
  // Pen strokes with a crop, a removed horizontal band and a removed column that the strokes
  // cross: they must be clipped at the seams like every other shape.
  { name: 'long-pen', url: `${base}/long.html`, edits: { crop: { x: 200, y: 100, w: 880, h: 1400 }, cuts: [{ axis: 'y', from: 520, to: 760 }, { axis: 'x', from: 700, to: 800 }], shapes: [
    { type: 'pen', color: '#ef4444', width: 4, points: Array.from({ length: 60 }, (_, i) => [260 + i * 12, Math.round((400 + 260 * i / 59 + 50 * Math.sin(i / 4)) * 10) / 10]) },
    { type: 'pen', color: '#22c55e', width: 8, points: Array.from({ length: 41 }, (_, i) => [Math.round((620 + 120 * Math.cos(i / 40 * 2 * Math.PI)) * 10) / 10, Math.round((1000 + 90 * Math.sin(i / 40 * 2 * Math.PI)) * 10) / 10]) },
    { type: 'pen', color: '#3b82f6', width: 2, points: [[300, 1200], [340, 1160], [380, 1240], [420, 1160], [460, 1240], [500, 1200]] },
    { type: 'pen', color: '#111827', width: 8, points: [[560, 1200]] },
  ] } },
  // Crop: keep an area; remove one / two horizontal sections (+ shapes, redaction); remove a column.
  { name: 'long-keep', url: `${base}/long.html`, edits: { crop: { x: 240, y: 700, w: 800, h: 2600 }, shapes: [] } },
  { name: 'long-cut1', url: `${base}/long.html`, edits: { crop: null, cuts: [{ axis: 'y', from: 900, to: 2300 }], shapes: [] } },
  { name: 'long-cut2', url: `${base}/long.html`, pdf: { paperSize: 'a4', marginMm: 12 }, edits: { crop: null, cuts: [{ axis: 'y', from: 500, to: 1150 }, { axis: 'y', from: 2600, to: 4100 }], shapes: [{ type: 'redact', x: 280, y: 1200, w: 400, h: 60, color: '#000' }, { type: 'arrow', x1: 800, y1: 1300, x2: 700, y2: 1130, color: '#ef4444', width: 3 }, { type: 'highlight', x: 270, y: 4120, w: 500, h: 60, color: '#facc15' }, { type: 'rect', x: 280, y: 2400, w: 300, h: 400, color: '#3b82f6', width: 3 }] } },
  // Redaction: words, part of a long run, part of a link, an image, a box across a removed band;
  // with crop + cuts and shapes drawn on top of the boxes afterwards. See test/check_redact.py.
  { name: 'redact', url: `${base}/redact.html`, pdf: { pdfHeader: true, pdfFooter: true, textLayer: true, activeLinks: true }, editsFrom: redactEdits },
  { name: 'redact-crop', url: `${base}/redact.html`, pdf: { pdfHeader: true, pdfFooter: true, textLayer: true, activeLinks: true, paperSize: 'a4', marginMm: 10 }, editsFrom: redactEdits, editsArg: { crop: true, later: true } },
  { name: 'long-cutcols', url: `${base}/long.html`, edits: { crop: { x: 200, y: 0, w: 880, h: 3000 }, cuts: [{ axis: 'x', from: 560, to: 760 }, { axis: 'y', from: 1000, to: 1600 }], shapes: [] } },
  { name: 'gmail-like', url: `${base}/gmail-like.html` },
  { name: 'claude-like', url: `${base}/claude-like.html` },
  { name: 'thread', url: `${base}/thread.html` },
  { name: 'pen-over-redact', url: `${base}/long.html`, edits: { crop: null, cuts: [], shapes: [{ type: 'redact', x: 300, y: 250, w: 400, h: 120, color: '#000' }, { type: 'pen', points: [[250, 230], [400, 300], [550, 280], [750, 390]], color: '#ef4444', width: 8 }] } },
  { name: 'long-nosmart', url: `${base}/long.html`, pdf: { smartSplit: false } },
  { name: 'tables', url: `${base}/tables.html` },
  { name: 'tables-a4', url: `${base}/tables.html`, pdf: { paperSize: 'a4', marginMm: 10 } },
  { name: 'tables-nobg', url: `${base}/tables.html`, o: { removeBackgrounds: true } },
  // "Capture visible area": must capture exactly the viewport at the current scroll position.
  // `scrollTo` scrolls the window (number) or an inner scroller ({ sel, y }) before capturing.
  { name: 'visible', url: `${base}/long.html`, o: { visibleOnly: true } },
  { name: 'visible-scrolled', url: `${base}/long.html`, scrollTo: 3000, o: { visibleOnly: true } },
  { name: 'visible-nobg', url: `${base}/long.html`, scrollTo: 3000, o: { visibleOnly: true, removeBackgrounds: true } },
  { name: 'visible-inner', url: `${base}/app.html`, scrollTo: { sel: '.feed', y: 900 }, o: { visibleOnly: true } },
  // Script injection fails on extension pages (like chrome:// pages): the pixels must still be captured.
  { name: 'visible-restricted', extPage: 'pages/options.html', o: { visibleOnly: true } },
  { name: 'visible-hires', url: `${base}/long.html`, scrollTo: 3000, o: { visibleOnly: true, hiRes: true, hiResScale: 2 } },
];
if (args.includes('--web')) {
  CASES.push(
    { name: 'wiki', url: 'https://en.wikipedia.org/wiki/Portable_Document_Format', wait: 1500 },
    { name: 'blog', url: 'https://paulgraham.com/greatwork.html', wait: 1000 },
    { name: 'github', url: 'https://github.com/microsoft/playwright', wait: 2500 },
    { name: 'hn', url: 'https://news.ycombinator.com/', wait: 800 },
    { name: 'x', url: 'https://x.com/NASA', wait: 6000, o: { maxHeight: 8000 } },
    { name: 'databricks', url: 'https://www.databricks.com/blog/tabular-foundation-models-databricks-ai-runtime', wait: 4000 },
    { name: 'youtube', url: 'https://www.youtube.com/', wait: 5000 },
    { name: 'youtube-grid', url: 'https://www.youtube.com/@NASA/videos', wait: 5000, o: { maxHeight: 6000 } },
    { name: 'tokit', url: 'https://hk.tokit.com/', wait: 5000 },
    { name: 'roswell', url: 'https://www.roswellpark.org/cancertalk/202211/where-does-prostate-cancer-spread', wait: 5000 },
    { name: 'aliexpress', url: 'https://www.aliexpress.us/item/3256804687172334.html', wait: 6000 },
    { name: 'ctshirts', url: 'https://www.charlestyrwhitt.com/us/editorial-style-tips/shirt-of-the-season.html?cm_sp=HP-HP4_shirts-SOTS_PLP', wait: 6000 },
    { name: 'politico', url: 'https://www.politico.eu/europe-poll-of-polls/portugal/', wait: 6000 },
    { name: 'reddit-thread', url: 'https://www.reddit.com/r/TheMatpatEffect/comments/1lrj5ih/the_original_unedited_version_of_the_literal/', wait: 5000 },
    { name: 'bsky', url: 'https://bsky.app/profile/nasa.gov', wait: 5000, o: { maxHeight: 9000 } },
    { name: 'wiki-table', url: 'https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population', wait: 1500 },
    { name: 'mdn-nobg', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/position', wait: 2000, o: { removeBackgrounds: true } },
    { name: 'linear-nobg', url: 'https://linear.app/', wait: 4000, o: { removeBackgrounds: true, maxHeight: 9000 } },
    { name: 'spacex-nobg', url: 'https://www.spacex.com/', wait: 4000, o: { removeBackgrounds: true } },
    { name: 'vercel-nobg', url: 'https://vercel.com/', wait: 4000, o: { removeBackgrounds: true, maxHeight: 9000 } },
    { name: 'tailwind-dark-nobg', url: 'https://tailwindcss.com/', scheme: 'dark', wait: 3000, o: { removeBackgrounds: true, maxHeight: 9000 } },
    { name: 'pydocs-dark-nobg', url: 'https://docs.python.org/3/library/functions.html', scheme: 'dark', wait: 1500, o: { removeBackgrounds: true, maxHeight: 9000 } },
  );
}

// Fresh profile every run: Chrome caches extension service-worker code across runs.
fs.rmSync(path.join(root, '.profile'), { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(path.join(root, '.profile'), {
  channel: 'chromium', headless: !headed,
  viewport: { width: 1280, height: 800 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
if (process.env.PTP_DEBUG) await sw.evaluate(() => { globalThis.ptpDebug = true; });

const results = [], splits = [];
for (const c of CASES.filter(c => !only || c.name.includes(only))) {
  const t0 = Date.now();
  try {
    const page = await ctx.newPage();
    if (c.scheme) await page.emulateMedia({ colorScheme: c.scheme }); // e.g. a site's dark theme
    const url = c.extPage ? `chrome-extension://${sw.url().split('/')[2]}/${c.extPage}` : c.url;
    await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    if (c.wait) await page.waitForTimeout(c.wait);
    const fromPage = c.editsFrom ? await page.evaluate(c.editsFrom, c.editsArg || null) : null;
    const caseEdits = fromPage ? fromPage.edits : c.edits;
    if (c.scrollTo != null) {
      await page.evaluate(s => { if (typeof s === 'number') scrollTo(0, s); else document.querySelector(s.sel).scrollTop = s.y; }, c.scrollTo);
      await page.waitForTimeout(100);
    }
    await page.bringToFront();
    const state = () => page.evaluate(sel => ({
      y: scrollY, inner: sel ? document.querySelector(sel).scrollTop : 0,
      styles: document.querySelectorAll('[data-pagetopdf],[data-ptp-fix]').length,
    }), c.scrollTo?.sel);
    const before = await state();
    // Visible-area capture: remember what is on screen right now to check the result against.
    // Headless Playwright emulates the 1280×800 viewport in a window whose real content area is
    // shorter (the window is 800px tall including the browser UI), and captureVisibleTab returns
    // either one. Both are "the visible area"; in a real browser window they are the same.
    // (The reference screenshot is taken after the capture, once the page is verified restored:
    // a Playwright screenshot right before the capture makes the real-area result more likely.)
    const visible = c.o?.visibleOnly ? {
      restricted: !!c.extPage,
      tabH: await sw.evaluate(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].height),
      ...(await page.evaluate(() => ({
        vw: innerWidth, vh: innerHeight,
        // Headings fully inside the viewport, with their viewport position.
        headings: [...document.querySelectorAll('h1, h2, h3, .msg b')].map(h => ({ t: h.textContent.trim(), r: h.getBoundingClientRect() }))
          .filter(({ r }) => r.top >= 0 && r.bottom <= innerHeight && r.height > 0).map(({ t, r }) => ({ t, top: r.top, bottom: r.bottom })),
      }))),
    } : null;
    const resultPagePromise = ctx.waitForEvent('page', { predicate: p => p.url().includes('result.html'), timeout: 300000 });
    resultPagePromise.catch(() => {}); // surfaced below if the capture itself succeeded
    const id = await sw.evaluate(async ({ url, o }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(t => t.url === url) || tabs.find(t => t.active);
      return globalThis.ptpCapture(tab.id, { scrollDelay: 100, ...(o || {}) });
    }, { url: page.url(), o: c.o });
    if (process.env.PTP_DEBUG) console.log(JSON.stringify(await sw.evaluate(() => { const l = globalThis.ptpFrameLog; globalThis.ptpFrameLog = []; return l; })));
    const after = await state();
    if (visible) visible.shot = (await page.screenshot()).toString('base64');
    const rp = await resultPagePromise;
    await rp.waitForFunction(() => window.ptp, null, { timeout: 20000 });
    await rp.setViewportSize({ width: 1400, height: 900 });
    const data = await rp.evaluate(async ({ pdf, edits, visible, nobg, redactCheck }) => {
      if (edits) await window.ptp.setEdits(edits);
      const rec = await window.ptp.getRec();
      let check = null;
      if (visible) {
        // Size must be the viewport (or the tab's real content area, see above) × scale; pixels
        // must match what the page showed, 1:1 from the top (scaled down for hi-res; not
        // compared without backgrounds); visible headings must be in the text layer at the
        // position they had on screen.
        const near = (a, b) => Math.abs(a - b) <= 1;
        const sizeOk = near(rec.width, visible.vw * rec.scale) && (near(rec.height, visible.vh * rec.scale) || near(rec.height, visible.tabH * rec.scale));
        let pxDiff = null;
        if (!nobg) {
          const exp = await createImageBitmap(await (await fetch(`data:image/png;base64,${visible.shot}`)).blob());
          const got = await createImageBitmap(rec.tiles[0]);
          const w = exp.width, h = Math.min(exp.height, Math.round(rec.height / rec.scale));
          const px = (img, sw, sh) => { const cv = new OffscreenCanvas(w, h); const x = cv.getContext('2d'); x.drawImage(img, 0, 0, sw, sh, 0, 0, w, h); return x.getImageData(0, 0, w, h).data; };
          const a = px(exp, w, h), b = px(got, got.width, h * rec.scale);
          let sum = 0; for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
          pxDiff = +(sum / (a.length / 4) / 3).toFixed(2); // mean abs difference per channel, 0-255
        }
        // Restricted pages have no text layer (the agent can't be injected there).
        const missing = visible.restricted ? [] : visible.headings.filter(h => !rec.text.some(t => h.t.startsWith(t.t) && t.y >= h.top - 2 && t.y + t.h <= h.bottom + 2));
        check = { sizeOk, pxDiff, headings: visible.restricted ? 0 : visible.headings.length, missingHeadings: missing.map(h => h.t), sample: rec.text.slice(0, 4).map(t => [t.t.slice(0, 40), Math.round(t.y), Math.round(t.h)]) };
      }
      const toB64 = async blob => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
      const { getSettings } = await import('../lib/settings.js');
      const { exportPDF, exportImage, computeBreaks, CaptureSource } = await import('../lib/export.js');
      const s = { ...(await getSettings()), ...(pdf || {}) };
      // Split quality: breaks that cut through structural blocks, with ("after") and
      // without ("before": text/pixel heuristics only) the structure-aware splitter.
      const blocks = new CaptureSource(rec).items('blocks');
      const splitStats = async r => {
        const src = new CaptureSource(r);
        try {
          const { breaks, geometry: g } = await computeBreaks(src, s);
          const st = { pages: breaks.length - 1, rowCuts: 0, blockCuts: 0, orphanHeadings: 0 };
          for (const b of breaks.slice(1, -1)) {
            let row = false, other = false;
            for (const k of blocks) {
              const top = k.y, bot = k.y + k.h;
              if (k.kind === 'heading') { if (bot <= b + 1 && b - bot < 50) st.orphanHeadings++; continue; }
              if (k.h >= g.pageCss * 0.8 || !(top + 2 < b && b < bot - 2)) continue;
              if (k.kind === 'row') row = true; else other = true;
            }
            st.rowCuts += row; st.blockCuts += row || other;
          }
          return st;
        } finally { src.close(); }
      };
      const split = s.smartSplit ? { blocks: blocks.length, before: await splitStats({ ...rec, blocks: [] }), after: await splitStats(rec) } : null;
      const pdfBlob = await exportPDF(rec, s);
      // What the edits removed: output size, and text runs that are entirely inside a removed
      // part (they must not appear in the PDF text layer).
      const src = new CaptureSource(rec);
      const removed = [];
      if (rec.edits?.cuts?.length || rec.edits?.crop) {
        // Headings whose box is entirely inside removed parts (or outside the kept area).
        for (const t of rec.text) {
          const gone = src.toOutY(t.y) === src.toOutY(t.y + t.h) || src.toOutX(t.x) === src.toOutX(t.x + t.w);
          if (gone && /Section \d+/.test(t.t)) removed.push(t.t.match(/Section \d+/)[0]);
        }
      }
      const edit = { outCss: [src.cssWidth, src.cssHeight], outPx: [src.width, src.height], removed: [...new Set(removed)], ySegs: src.ySegs, xSegs: src.xSegs, edits: rec.edits };
      const imgs = await exportImage(rec, 'png');
      let redact = null;
      if (redactCheck) {
        // Each redaction box in output CSS px (one piece per kept part it overlaps), the JPG
        // export and the stored thumbnail, for test/check_redact.py.
        const pieces = [];
        for (const r of rec.edits.shapes.filter(s => s.type === 'redact')) {
          for (const ys of src.ySegs) for (const xs of src.xSegs) {
            const x0 = Math.max(r.x, xs.o0), x1 = Math.min(r.x + r.w, xs.o1), y0 = Math.max(r.y, ys.o0), y1 = Math.min(r.y + r.h, ys.o1);
            if (x1 > x0 && y1 > y0) pieces.push({ x: xs.out0 + x0 - xs.o0, y: ys.out0 + y0 - ys.o0, w: x1 - x0, h: y1 - y0 });
          }
        }
        const jpg = await exportImage(rec, 'jpg', s.jpgQuality);
        redact = { pieces, scale: rec.scale, cssWidth: rec.cssWidth, outCss: [src.cssWidth, src.cssHeight], jpg: await toB64(jpg[0].blob), thumb: rec.thumb ? await toB64(rec.thumb) : null, thumbKey: rec.thumbKey ?? null };
      }
      return {
        redact,
        meta: { width: rec.width, height: rec.height, scale: rec.scale, cssWidth: rec.cssWidth, cssHeight: rec.cssHeight, mode: rec.mode, text: rec.text.length, links: rec.links.length, media: rec.media.length, blocks: (rec.blocks || []).length, tiles: rec.tiles.length, truncated: rec.capturedWith.truncated, gaps: rec.gaps },
        split, check, edit, pdf: await toB64(pdfBlob), png: await Promise.all(imgs.map(i => toB64(i.blob))),
      };
    }, { pdf: c.pdf, edits: caseEdits, visible, nobg: !!c.o?.removeBackgrounds, redactCheck: !!fromPage });
    if (data.redact) {
      const { jpg, thumb, ...rest } = data.redact;
      fs.writeFileSync(path.join(out, `${c.name}.jpg`), Buffer.from(jpg, 'base64'));
      if (thumb) fs.writeFileSync(path.join(out, `${c.name}-thumb.jpg`), Buffer.from(thumb, 'base64'));
      fs.writeFileSync(path.join(out, `${c.name}.redact.json`), JSON.stringify({ ...rest, expect: fromPage.expect }, null, 2));
    }
    fs.writeFileSync(path.join(out, `${c.name}.pdf`), Buffer.from(data.pdf, 'base64'));
    data.png.forEach((p, i) => fs.writeFileSync(path.join(out, `${c.name}${i ? '-' + i : ''}.png`), Buffer.from(p, 'base64')));
    await rp.screenshot({ path: path.join(out, `${c.name}-viewer.png`) });
    const restored = before.y === after.y && before.inner === after.inner && after.styles === 0;
    let ok = true, visibleCheck;
    if (data.check) {
      const k = data.check;
      // Hi-res is compared after scaling down, so allow for resampled text edges.
      ok = restored && k.sizeOk && (k.pxDiff === null || k.pxDiff < (c.o.hiRes ? 6 : 1)) && !k.missingHeadings.length;
      visibleCheck = `size ${k.sizeOk ? 'ok' : 'BAD'}, px diff ${k.pxDiff ?? '-'}, headings ${k.headings - k.missingHeadings.length}/${k.headings}`;
      if (!ok) console.log(c.name, 'visible-area check failed:', JSON.stringify({ restored, before, after, ...k }));
    }
    results.push({ name: c.name, ok, secs: (Date.now() - t0) / 1000, restored, ...data.meta, ...(visibleCheck ? { visibleCheck } : {}), out: data.edit?.outPx?.join('x') });
    if (caseEdits) fs.writeFileSync(path.join(out, `${c.name}.edit.json`), JSON.stringify(data.edit, null, 2));
    if (data.split) splits.push({ name: c.name, blocks: data.split.blocks, ...Object.fromEntries(['pages', 'rowCuts', 'blockCuts', 'orphanHeadings'].map(k => [k, `${data.split.before[k]} -> ${data.split.after[k]}`])) });
    await rp.close(); await page.close();
  } catch (e) {
    results.push({ name: c.name, ok: false, error: String(e.message || e).slice(0, 400) });
  }
}
console.table(results);
if (splits.length) { console.log('Smart split, before (text/pixels only) -> after (structure-aware):'); console.table(splits); }
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results.map(r => ({ ...r, split: splits.find(x => x.name === r.name) })), null, 2));
await ctx.close();
server.close();
