// Chrome's transient "Tabs cannot be edited right now (user may be dragging a tab)" error
// must not fail a capture or leave the page half-prepared; and a capture the extension
// abandons must be undone by the page-side watchdog.
//   node test/transient.mjs
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(root, 'out', `transient-${Date.now()}`);
const ext = path.join(tmp, 'ext');
fs.mkdirSync(tmp, { recursive: true });
fs.cpSync(path.join(root, '..', 'extension'), ext, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
mf.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf));

const server = http.createServer((req, res) => {
  const f = path.join(root, 'fixtures', path.basename(req.url.split('?')[0]));
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info: String(info).slice(0, 120) }); };

// Page state that a capture must leave untouched.
const pageState = page => page.evaluate(() => ({
  styled: [...document.querySelectorAll('[style]')].map(e => `${e.id || e.tagName}:${e.getAttribute('style')}`).join(' | '),
  ours: document.querySelectorAll('[data-pagetopdf]').length,
  docH: document.scrollingElement.scrollHeight, y: scrollY,
}));

// Make the next N calls of chrome.<ns>.<fn> fail with Chrome's transient tab error.
const failNext = (ns, fn, n, onlyFuncs = false) => sw.evaluate(({ ns, fn, n, onlyFuncs }) => {
  const api = chrome[ns];
  const orig = api[`__orig_${fn}`] || (api[`__orig_${fn}`] = api[fn].bind(api));
  let left = n;
  api[fn] = (...a) => {
    const isFunc = !!a[0]?.func && a[0]?.args?.[0] === 'restore';
    if (left > 0 && (!onlyFuncs || isFunc)) { left--; return Promise.reject(new Error('Tabs cannot be edited right now (user may be dragging a tab).')); }
    return orig(...a);
  };
  globalThis.__left = () => left;
}, { ns, fn, n, onlyFuncs });
const unpatch = () => sw.evaluate(() => {
  for (const [ns, fn] of [['tabs', 'captureVisibleTab'], ['scripting', 'executeScript']]) {
    if (chrome[ns][`__orig_${fn}`]) chrome[ns][fn] = chrome[ns][`__orig_${fn}`];
  }
});
async function capture(url, before) {
  const page = await ctx.newPage();
  await page.goto(url); await page.bringToFront();
  const s0 = await pageState(page);
  await before?.();
  const viewer = ctx.waitForEvent('page', { predicate: p => p.url().includes('result.html'), timeout: 120000 }).catch(() => null);
  const r = await sw.evaluate(async u => {
    const [t] = await chrome.tabs.query({ url: u });
    return globalThis.ptpCapture(t.id, { scrollDelay: 50 }).then(id => ({ id }), e => ({ error: String(e.message || e) }));
  }, url);
  await unpatch();
  const v = r.id ? await viewer : null;
  await page.waitForTimeout(300);
  const s1 = await pageState(page);
  if (v) await v.close();
  await page.close();
  return { r, same: JSON.stringify(s0) === JSON.stringify(s1), s0, s1 };
}

// 1. Screenshots refused a few times.
{
  const { r, same } = await capture(`${base}/gmail-like.html`, () => failNext('tabs', 'captureVisibleTab', 5));
  check('screenshot refused 5× → capture succeeds', !!r.id, r.error || r.id);
  check('… and the page is restored', same);
}
// 2. Script injection refused a few times (first injection included).
{
  const { r, same } = await capture(`${base}/gmail-like.html`, () => failNext('scripting', 'executeScript', 4));
  check('script injection refused 4× → capture succeeds', !!r.id, r.error || r.id);
  check('… and the page is restored', same);
}
// 3. The restore call itself refused a few times.
{
  const { r, same, s1 } = await capture(`${base}/gmail-like.html`, () => failNext('scripting', 'executeScript', 3, true));
  check('restore refused 3× → page still restored', same && !!r.id, same ? r.id : JSON.stringify(s1).slice(0, 120));
}
// 4. Chrome refuses every normal screenshot (both errors seen on Gmail): the capture switches
//    to the debugger's screenshots and still succeeds, at the same scale, with a note.
for (const msg of ["Tabs cannot be edited right now (user may be dragging a tab).", "Either the '<all_urls>' or 'activeTab' permission is required."]) {
  const page = await ctx.newPage();
  await page.goto(`${base}/gmail-like.html`); await page.bringToFront();
  const s0 = await pageState(page);
  await sw.evaluate(m => {
    chrome.tabs.__orig_captureVisibleTab ||= chrome.tabs.captureVisibleTab.bind(chrome.tabs);
    chrome.tabs.captureVisibleTab = () => Promise.reject(new Error(m));
  }, msg);
  const viewer = ctx.waitForEvent('page', { predicate: p => p.url().includes('result.html'), timeout: 120000 }).catch(() => null);
  const r = await sw.evaluate(async u => {
    const [t] = await chrome.tabs.query({ url: u });
    return globalThis.ptpCapture(t.id, { scrollDelay: 50 }).then(id => ({ id }), e => ({ error: String(e.message || e) }));
  }, page.url());
  await unpatch();
  const v = r.id ? await viewer : null;
  const rec = v ? await v.evaluate(async () => { await new Promise(r => setTimeout(r, 300)); const x = await window.ptp.getRec(); return { w: x.width, h: x.height, scale: x.scale, gaps: x.gaps, note: x.capturedWith?.hiResNote, text: x.text.length }; }) : null;
  await page.waitForTimeout(300);
  const s1 = await pageState(page);
  const short = msg.slice(0, 24);
  check(`"${short}…" every time → falls back and succeeds`, !!rec && rec.gaps === 0 && rec.h >= 2000 && rec.scale === 1 && /debugging API/.test(rec.note || ''), r.error || JSON.stringify(rec));
  check('… and the page is restored', JSON.stringify(s0) === JSON.stringify(s1));
  if (v) await v.close();
  await page.close();
}
// 4b. Chrome refuses everything for the page (scripts and screenshots): the popup is told which
//     site to allow.
{
  const page = await ctx.newPage();
  await page.goto(`${base}/gmail-like.html`); await page.bringToFront();
  await sw.evaluate(() => {
    const deny = () => Promise.reject(new Error("Either the '<all_urls>' or 'activeTab' permission is required."));
    chrome.tabs.__orig_captureVisibleTab ||= chrome.tabs.captureVisibleTab.bind(chrome.tabs);
    chrome.scripting.__orig_executeScript ||= chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.tabs.captureVisibleTab = deny; chrome.scripting.executeScript = deny;
  });
  const r = await sw.evaluate(async u => {
    const [t] = await chrome.tabs.query({ url: u });
    const res = await globalThis.ptpCapture(t.id, { scrollDelay: 50 }).then(id => ({ id }), e => ({ error: String(e.message || e) }));
    return { ...res, status: globalThis.ptpStatus(t.id) };
  }, page.url());
  await unpatch();
  check('no access at all → fails with "Allow on <site>"', !r.id && r.status?.needsAccess === 'http://127.0.0.1/*' && /allow it on this site/i.test(r.status?.error || ''), `${r.status?.needsAccess} | ${r.status?.error || r.error}`);
  await page.close();
}
// 5. Another tab comes to the front mid-capture; the capture waits for it to come back.
{
  const page = await ctx.newPage();
  await page.goto(`${base}/long.html`); await page.bringToFront();
  const other = await ctx.newPage();
  await page.bringToFront();
  const run = sw.evaluate(async u => {
    const [t] = await chrome.tabs.query({ url: u });
    return globalThis.ptpCapture(t.id, { scrollDelay: 50 }).then(id => ({ id }), e => ({ error: String(e.message || e) }));
  }, page.url());
  await page.waitForTimeout(2500);
  await other.bringToFront();             // user switches tabs…
  await page.waitForTimeout(3000);
  await page.bringToFront();              // …and comes back
  const r = await run;
  check('other tab in front mid-capture → waits, then completes', !!r.id, r.error || r.id);
  for (const p of ctx.pages()) if (p.url().includes('result.html')) await p.close();
  await other.close(); await page.close();
}
// 6. An abandoned capture: prepare() runs, then the extension never calls again.
{
  const page = await ctx.newPage();
  await page.goto(`${base}/gmail-like.html`);
  const s0 = await pageState(page);
  await sw.evaluate(async u => {
    const [t] = await chrome.tabs.query({ url: u });
    await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['agent.js'] });
    await chrome.scripting.executeScript({ target: { tabId: t.id }, func: () => window.__ptpAgent.prepare({ adjustRepeating: true, hideScrollbars: true, advancedScrolling: true }) });
  }, page.url());
  const mid = await pageState(page);
  check('prepare expanded the page', mid.docH > s0.docH, `${s0.docH} → ${mid.docH}`);
  await page.waitForTimeout(32000);
  const s1 = await pageState(page);
  check('watchdog restores an abandoned capture within ~30 s', JSON.stringify(s0) === JSON.stringify(s1), `docH ${s1.docH}`);
  await page.close();
}

console.table(results);
await ctx.close(); server.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
