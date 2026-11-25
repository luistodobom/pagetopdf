// High-resolution capture, end to end, against the extension exactly as shipped.
//
// Only `<all_urls>` host access is added (a real user gets the equivalent from activeTab
// when they click the toolbar button / menu / shortcut). `debugger` is NOT injected: it
// must come from extension/manifest.json, so a manifest regression fails here.
//
//   node test/hires.mjs            # local fixtures
//   node test/hires.mjs --web      # also a 3x capture of a long Wikipedia article
//   node test/hires.mjs --headed   # real window: Chrome's "started debugging" bar is shown
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(root, '.build-hires');
const helper = path.join(root, '.build-hires-helper');
const out = path.join(root, 'out', 'hires');
const args = process.argv.slice(2);
const headed = args.includes('--headed');
const web = args.includes('--web');
fs.mkdirSync(out, { recursive: true });

const shipped = JSON.parse(fs.readFileSync(path.join(root, '..', 'extension', 'manifest.json'), 'utf8'));
fs.rmSync(ext, { recursive: true, force: true });
fs.cpSync(path.join(root, '..', 'extension'), ext, { recursive: true });
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ ...shipped, host_permissions: ['<all_urls>'] }, null, 2));

// A second extension that also uses chrome.debugger, to stand in for "someone else is
// already debugging this tab".
fs.rmSync(helper, { recursive: true, force: true });
fs.mkdirSync(helper);
fs.writeFileSync(path.join(helper, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'debugger-holder', version: '1', permissions: ['debugger', 'tabs'], background: { service_worker: 'sw.js' }, web_accessible_resources: [{ resources: ['frame.html'], matches: ['<all_urls>'] }] }));
fs.writeFileSync(path.join(helper, 'sw.js'), '// driven from the test\n');
fs.writeFileSync(path.join(helper, 'frame.html'), '<!doctype html><p>frame from another extension</p>');

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/wide.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><body style="margin:0"><div style="width:6000px;height:2400px;background:linear-gradient(90deg,#fde,#def)"><h1 style="font:40px sans-serif;margin:0;padding:40px">Very wide page</h1></div>');
  }
  const f = path.join(root, 'fixtures', decodeURIComponent(u));
  if (!f.startsWith(path.join(root, 'fixtures')) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }); };

fs.rmSync(path.join(root, '.profile-hires'), { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(path.join(root, '.profile-hires'), {
  channel: 'chromium', headless: !headed,
  viewport: null, // no Playwright emulation: let the real window size (and infobar) apply
  args: [`--disable-extensions-except=${ext},${helper}`, `--load-extension=${ext},${helper}`, '--window-size=1280,900'],
});
const sws = async () => {
  for (let i = 0; i < 50 && ctx.serviceWorkers().length < 2; i++) await new Promise(r => setTimeout(r, 100));
  return ctx.serviceWorkers();
};
const all = await sws();
let sw = null, hsw = null;
for (const w of all) {
  const name = await w.evaluate(() => chrome.runtime.getManifest().name);
  if (name === 'debugger-holder') hsw = w; else sw = w;
}
const extId = sw.url().split('/')[2];
const E = p => `chrome-extension://${extId}/pages/${p}`;

// ------------------------------------------------------------ shipped manifest
check('manifest: debugger is a regular permission', shipped.permissions.includes('debugger') && !(shipped.optional_permissions || []).includes('debugger'), { permissions: shipped.permissions, optional: shipped.optional_permissions });
const granted = await sw.evaluate(() => chrome.permissions.contains({ permissions: ['debugger'] }));
check('runtime: debugger granted at install', granted);

// ------------------------------------------------------------ toggles
const watch = pg => { const errs = []; pg.on('pageerror', e => errs.push(e.message)); pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); return errs; };
const stored = () => sw.evaluate(() => chrome.storage.sync.get(['hiRes', 'hiResScale']));

await sw.evaluate(() => chrome.storage.sync.set({ hiRes: false }));
{
  const pg = await ctx.newPage(); const errs = watch(pg);
  await pg.goto(E('popup.html')); await pg.waitForSelector('#hiRes');
  await pg.click('label:has(#hiRes), .row:has(#hiRes) .switch');
  await pg.waitForTimeout(600);
  const st = await pg.evaluate(() => ({ checked: document.getElementById('hiRes').checked, rowShown: !document.getElementById('hiResRow').hidden, text: document.body.innerText }));
  await pg.click('#hiResScale [data-v="3"]'); await pg.waitForTimeout(200);
  const s = await stored();
  check('popup: High resolution toggle stays on', st.checked && st.rowShown && s.hiRes === true, { ...st, text: undefined, stored: s });
  check('popup: scale selection stored', s.hiResScale === 3, s);
  check('popup: no errors / no permission wording', !errs.length && !/permission/i.test(st.text), errs);
  await pg.close();
}
await sw.evaluate(() => chrome.storage.sync.set({ hiRes: false, hiResScale: 2 }));
{
  const pg = await ctx.newPage(); const errs = watch(pg);
  await pg.goto(E('options.html')); await pg.waitForSelector('[data-k="hiRes"]');
  await pg.locator('[data-k="hiRes"]').check({ force: true });
  await pg.waitForTimeout(600);
  const st = await pg.evaluate(() => ({
    checked: document.querySelector('[data-k="hiRes"]').checked,
    scaleEnabled: !document.querySelector('[data-row="hiResScale"]').classList.contains('disabled'),
    toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent),
    help: document.querySelector('[data-row="hiRes"]')?.innerText || '',
  }));
  const s = await stored();
  check('options: High-resolution toggle stays on', st.checked && st.scaleEnabled && s.hiRes === true && !st.toasts.length, { ...st, stored: s });
  check('options: help text describes the debugging bar, no permission prompt', /started debugging/.test(st.help) && !/permission/i.test(st.help), st.help);
  check('options: no errors', !errs.length, errs);
  await pg.close();
}
await sw.evaluate(() => chrome.storage.sync.set({ hiRes: false, hiResScale: 2 }));

// ------------------------------------------------------------ captures
if (!granted) await finish(); // nothing below can work without the permission
await sw.evaluate(() => { globalThis.ptpDebug = true; });
const pageState = pg => pg.evaluate(() => ({ dpr: devicePixelRatio, w: innerWidth, h: innerHeight, y: Math.round(scrollY), styles: document.querySelectorAll('[data-pagetopdf]').length }));
// getTargets().attached also counts Playwright's own CDP session, so probe for *our* session:
// detach() only succeeds if this extension is still attached.
const stillAttached = tabId => sw.evaluate(t => chrome.debugger?.detach({ tabId: t }).then(() => true, () => false) ?? false, tabId);
const tabIdOf = url => sw.evaluate(async u => (await chrome.tabs.query({})).find(t => t.url === u)?.id, url);

// Captures `url` with overrides; returns { rec meta, png paths } or { error }.
let fullH = null; // the window's viewport height with no debugging bar showing
async function capture(name, url, o, { before: setup, during, cleanup, savePng = true, wait = 0 } = {}) {
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  if (wait) await page.waitForTimeout(wait);
  await page.evaluate(() => scrollTo(0, 137)); // the user's scroll position must come back
  await page.bringToFront();
  const tabId = await tabIdOf(page.url());
  if (setup) await setup({ page, tabId });
  // Let the bar from a previous capture go away first, so `before` is the user's normal state.
  if (fullH) await page.waitForFunction(h => innerHeight === h, fullH, { timeout: 15000 }).catch(() => {});
  const before = await pageState(page);
  await sw.evaluate(() => { globalThis.ptpFrameLog = []; });
  const rpP = ctx.waitForEvent('page', { predicate: p => p.url().includes('result.html'), timeout: 300000 }); rpP.catch(() => {});
  const run = sw.evaluate(({ tabId, o }) => globalThis.ptpCapture(tabId, { scrollDelay: 100, ...o }).then(id => ({ id }), e => ({ error: String(e.message || e) })), { tabId, o });
  if (during) await during({ page, tabId });
  const r = await run;
  const frames = await sw.evaluate(() => globalThis.ptpFrameLog || []);
  const res = { name, ...r, frames, settled: await sw.evaluate(() => { const v = globalThis.ptpSettled; delete globalThis.ptpSettled; return v; }) };
  const badge = await sw.evaluate(t => chrome.action.getBadgeText({ tabId: t }).catch(() => null), tabId);
  res.badge = badge;
  if (r.id) {
    const rp = await rpP;
    await rp.waitForFunction(() => window.ptp, null, { timeout: 20000 });
    const data = await rp.evaluate(async save => {
      const rec = await window.ptp.getRec();
      const toB64 = async blob => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
      let pngs = [];
      if (save) { const { exportImage } = await import('../lib/export.js'); pngs = await Promise.all((await exportImage(rec, 'png')).map(i => toB64(i.blob))); }
      return {
        meta: { width: rec.width, height: rec.height, scale: rec.scale, cssWidth: rec.cssWidth, cssHeight: rec.cssHeight, tiles: rec.tiles.length, gaps: rec.gaps, capturedWith: rec.capturedWith, mode: rec.mode },
        badges: document.getElementById('badges').textContent, note: document.getElementById('captureNote').textContent, pngs,
      };
    }, savePng);
    data.pngs.forEach((p, i) => fs.writeFileSync(path.join(out, `${name}${i ? '-' + i : ''}.png`), Buffer.from(p, 'base64')));
    Object.assign(res, data.meta, { badges: data.badges, note: data.note });
    await rp.close();
  }
  if (cleanup) await cleanup({ page, tabId });
  if (!page.isClosed()) {
    res.before = before;
    res.leftAttached = await stillAttached(tabId);
    await page.bringToFront(); // a background tab doesn't see window resizes
    // Chrome keeps its "started debugging" bar for a few seconds after we detach; the window
    // (not the page layout) shrinks while it shows. Wait for it to go before comparing.
    const t0 = Date.now(), h0 = (await pageState(page)).h;
    res.barShown = h0 < before.h;
    await page.waitForFunction(h => innerHeight === h, before.h, { timeout: 15000 }).catch(() => {});
    res.barMs = Date.now() - t0;
    res.after = await pageState(page);
  }
  if (!page.isClosed()) await page.close();
  return res;
}
const restored = r => !r.leftAttached && r.after && r.after.dpr === r.before.dpr && r.after.w === r.before.w && r.after.h === r.before.h && r.after.y === r.before.y && r.after.styles === 0;
const dimsOk = (r, k) => r.scale === k && Math.abs(r.width - Math.round(r.cssWidth * k)) <= 1 && Math.abs(r.height - Math.round(r.cssHeight * k)) <= 2;
// Every frame came back full-size at the requested scale (no short frames from an infobar,
// first frame not taken before the re-render at the new scale).
const framesOk = (r, k) => r.frames.length > 0 && r.frames.every(f => f.bw === Math.round(f.vw * k) && Math.abs(f.bh - f.vh * k) <= 1);
const summary = r => ({ error: r.error, scale: r.scale, size: r.width && `${r.width}x${r.height}`, css: r.cssWidth && `${r.cssWidth}x${Math.round(r.cssHeight)}`, tiles: r.tiles, gaps: r.gaps, frames: r.frames.length, firstFrame: r.frames[0] && `${r.frames[0].bw}x${r.frames[0].bh}@vw${r.frames[0].vw}`, cw: r.capturedWith, badges: r.badges, before: r.before, after: r.after, badge: r.badge, barShown: r.barShown, barMs: r.barMs, leftAttached: r.leftAttached });
const long = `${base}/long.html`;

const r1 = await capture('long-1x', long, { hiRes: false });
check('1x baseline capture', r1.id && dimsOk(r1, r1.scale) && restored(r1), summary(r1));
const vp = r1.before;
fullH = vp.h;

for (const k of [2, 3, 4]) {
  const r = await capture(`long-${k}x`, long, { hiRes: true, hiResScale: k }, { savePng: k < 4 });
  check(`${k}x capture of long.html is ${k}x the CSS size`, r.id && dimsOk(r, k) && r.capturedWith.hiRes && !r.gaps, summary(r));
  check(`${k}x: re-render at ${k}x settled before the first frame; every frame full size`, r.settled === true && framesOk(r, k), { settled: r.settled, frames: r.frames.slice(0, 3) });
  check(`${k}x: layout width unchanged by the override`, r.cssWidth === r1.cssWidth && r.frames.every(f => f.vh === r1.frames[0].vh), { css: r.cssWidth, base: r1.cssWidth, vh: r.frames[0]?.vh, baseVh: r1.frames[0]?.vh });
  check(`${k}x: page restored, override cleared, debugger detached`, restored(r) && r.after.dpr === vp.dpr, { before: r.before, after: r.after });
}

// A session of our own left over (e.g. the service worker restarted mid-capture).
{
  const r = await capture('stale-own-session', long, { hiRes: true, hiResScale: 2 }, {
    savePng: false, before: ({ tabId }) => sw.evaluate(t => chrome.debugger.attach({ tabId: t }, '1.3'), tabId),
  });
  check('stale own debugger session: re-attached, still hi-res', r.id && r.capturedWith?.hiRes && dimsOk(r, 2) && restored(r), summary(r));
}
// Another debugger client (a second extension) already attached to the tab. Current Chrome
// allows several clients, so this is expected to stay hi-res; older builds refused with
// "Another debugger is already attached", which must give a normal capture plus the reason.
{
  let held;
  const r = await capture('other-debugger', long, { hiRes: true, hiResScale: 2 }, {
    savePng: false,
    before: async ({ tabId }) => { held = await hsw.evaluate(t => chrome.debugger.attach({ tabId: t }, '1.3').then(() => 'attached', e => e.message), tabId); },
    cleanup: ({ tabId }) => hsw.evaluate(t => chrome.debugger.detach({ tabId: t }).catch(() => {}), tabId),
  });
  check('another extension attached: capture completes (hi-res, or normal with a visible reason)', r.id && (r.capturedWith.hiRes ? dimsOk(r, 2) : /normal resolution/.test(r.badges) && r.note.startsWith(r.capturedWith.hiResNote)) && restored(r), { held, ...summary(r), note: r.note });
}
// Restricted page: the agent can't be injected there, so hi-res isn't attempted and the
// capture must not claim to be hi-res.
{
  const r = await capture('restricted', `chrome-extension://${extId}/pages/files.html`, { hiRes: true, hiResScale: 2 }, { savePng: false });
  check('restricted page (extension page): no hi-res claim, reason shown, debugger not left attached', r.id && r.capturedWith.hiRes === false && /normal resolution/.test(r.badges) && /does not allow/.test(r.note) && !r.leftAttached, { ...summary(r), note: r.note });
}
// A page embedding another extension's frame: Chrome refuses chrome.debugger.attach to it,
// while the page itself can still be captured normally.
{
  const hid = hsw.url().split('/')[2];
  const r = await capture('ext-iframe', `${base}/long.html?frame`, { hiRes: true, hiResScale: 2 }, {
    savePng: false,
    before: ({ page }) => page.evaluate(src => { const f = document.createElement('iframe'); f.src = src; f.style.cssText = 'width:300px;height:80px'; document.body.prepend(f); return new Promise(r => f.onload = r); }, `chrome-extension://${hid}/frame.html`),
  });
  check('attach refused (other extension\'s frame): normal-resolution capture with the reason shown', r.id && !r.capturedWith.hiRes && r.scale === r1.scale && /normal resolution/.test(r.badges) && /does not allow/.test(r.note) && restored(r), { ...summary(r), note: r.note });
}
// Session ended by Chrome mid-capture: tab closed.
{
  const r = await capture('tab-closed', long, { hiRes: true, hiResScale: 2, scrollDelay: 300 }, {
    savePng: false,
    during: async ({ page }) => {
      for (let i = 0; i < 100 && !(await sw.evaluate(() => (globalThis.ptpFrameLog || []).length)); i++) await new Promise(r => setTimeout(r, 50));
      await page.close();
    },
  });
  // Closing the tab cancels the capture (see the Stop/Cancel feature): it settles quietly with
  // nothing saved (id null). An explicit "tab was closed" error is also acceptable.
  check('tab closed mid-capture: cancelled cleanly, nothing saved', /tab was closed/i.test(r.error || '') || (!r.error && r.id == null), summary(r));
}
// Session ended mid-capture without an onDetach event (closest automatable stand-in for the
// user clicking Cancel on the infobar: the session is gone and Chrome drops the override).
{
  const r = await capture('detached-midway', long, { hiRes: true, hiResScale: 2, scrollDelay: 300 }, {
    savePng: false,
    during: async ({ tabId }) => {
      for (let i = 0; i < 100 && !(await sw.evaluate(() => (globalThis.ptpFrameLog || []).length)); i++) await new Promise(r => setTimeout(r, 50));
      await sw.evaluate(t => chrome.debugger.detach({ tabId: t }), tabId);
    },
  });
  check('debugger detached mid-capture: fails visibly, page restored', r.error && restored(r) && r.badge === '!', summary(r));
}
// Very wide page at 4x: the scale is lowered so tiles stay within canvas limits.
{
  const r = await capture('wide-4x', `${base}/wide.html`, { hiRes: true, hiResScale: 4 }, { savePng: false });
  check('6000px-wide page at 4x: scale reduced to 2x with a note', r.id && dimsOk(r, 2) && /very wide/.test(r.capturedWith?.hiResNote || '') && restored(r), summary(r));
}
if (web) {
  const r = await capture('wiki-3x', 'https://en.wikipedia.org/wiki/Portable_Document_Format', { hiRes: true, hiResScale: 3 }, { savePng: false, wait: 1500 });
  check('Wikipedia article at 3x', r.id && dimsOk(r, 3) && !r.gaps && restored(r), summary(r));
}

await finish();

async function finish() {
await ctx.close(); server.close();
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok && !process.env.VERBOSE ? '' : `\n      ${r.detail}`}`);
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed; PNGs in ${out}`);
process.exit(failed ? 1 : 0);
}
