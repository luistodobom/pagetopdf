// Stopping a capture in progress: cancel (discard) and "stop & save" (keep the part captured
// so far), in normal and hi-res mode, during preparation, mid-page, during the end-of-feed
// probe, on tab close, double stops and a new capture straight after a cancel. Also
// screenshots the popup's busy state with its Stop buttons (light + dark).
//
//   node test/cancel.mjs [--headed]
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(root, '.build');
const out = path.join(root, 'out', 'cancel');
const headed = process.argv.includes('--headed');

fs.rmSync(ext, { recursive: true, force: true });
fs.cpSync(path.join(root, '..', 'extension'), ext, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
mf.host_permissions = ['<all_urls>'];
if (!mf.permissions.includes('debugger')) mf.permissions.push('debugger');
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf, null, 2));
fs.mkdirSync(out, { recursive: true });

const server = http.createServer((req, res) => {
  const f = path.join(root, 'fixtures', decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(path.join(root, 'fixtures')) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

fs.rmSync(path.join(root, '.profile-cancel'), { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(path.join(root, '.profile-cancel'), {
  channel: 'chromium', headless: !headed, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];

// An extension page to talk to the worker exactly like the popup does, and to read IndexedDB.
const ui = await ctx.newPage();
await ui.goto(`chrome-extension://${extId}/pages/files.html`);
const stop = (tabId, keep = false) => ui.evaluate(m => chrome.runtime.sendMessage(m), { type: 'stop', tabId, keep });
const records = () => ui.evaluate(async () => (await import('../lib/db.js')).listCaptures().then(l => l.map(r => r.id)));
const record = id => ui.evaluate(async id => { const r = await (await import('../lib/db.js')).getCapture(id); return r && { height: r.cssHeight, stoppedEarly: !!r.capturedWith?.stoppedEarly }; }, id);
const badge = tabId => sw.evaluate(id => chrome.action.getBadgeText({ tabId: id }).catch(() => ''), tabId);
const resultTabs = () => sw.evaluate(async () => (await chrome.tabs.query({})).filter(t => (t.url || t.pendingUrl || '').includes('result.html')).map(t => t.id));
// Playwright itself is attached to every page, so getTargets() can't tell; detaching can:
// it only fails when this extension is not attached.
const debuggerAttached = tabId => sw.evaluate(id => chrome.debugger.detach({ tabId: id }).then(() => true, () => false), tabId);
const closeResultTabs = () => sw.evaluate(async () => { for (const t of await chrome.tabs.query({})) if ((t.url || t.pendingUrl || '').includes('result.html')) await chrome.tabs.remove(t.id); });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function openFixture(file, scrollY = 0) {
  const page = await ctx.newPage();
  await page.goto(`${base}/${file}?${Math.random()}`, { waitUntil: 'load' });
  await page.evaluate(y => scrollTo(0, y), scrollY);
  await page.bringToFront();
  const tabId = await sw.evaluate(async u => (await chrome.tabs.query({})).find(t => t.url === u).id, page.url());
  return { page, tabId };
}
// Everything the capture touches in the page: scroll position, our style elements, inline styles.
const pageState = page => page.evaluate(() => ({
  y: Math.round(scrollY),
  ours: document.querySelectorAll('[data-pagetopdf]').length,
  inline: [...document.querySelectorAll('[style]')].map(e => `${e.tagName}:${e.getAttribute('style')}`).join('|'),
  docClass: document.documentElement.className + '/' + document.body.className,
  dpr: devicePixelRatio, vw: innerWidth,
}));
const start = (tabId, o) => {
  const p = sw.evaluate(({ id, o }) => globalThis.ptpCapture(id, { scrollDelay: 100, ...o }), { id: tabId, o });
  p.catch(() => {});
  return p;
};
async function waitFor(fn, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(50); }
  throw new Error('timed out waiting');
}
const pctOf = async tabId => parseInt(await badge(tabId), 10) || 0;

const results = [];
async function check(name, fn) {
  const fails = [];
  const expect = (cond, msg) => { if (!cond) fails.push(msg); };
  const t0 = Date.now();
  try { await fn(expect); } catch (e) { fails.push('threw: ' + String(e.message || e).slice(0, 200)); }
  results.push({ name, ok: !fails.length, secs: (Date.now() - t0) / 1000, ...info, fails: fails.join('; ') });
  for (const k of Object.keys(info)) delete info[k];
  await closeResultTabs();
}
const info = {};

// Cancel and verify everything is as before; returns the stop latency.
async function cancelCase(expect, { file = 'long.html', o = {}, when, keep = false, scrollY = 400 }) {
  const { page, tabId } = await openFixture(file, scrollY);
  const before = await pageState(page);
  const recs = (await records()).length;
  const capture = start(tabId, o);
  await when(tabId, page);
  info.atPct = await pctOf(tabId);
  const t0 = Date.now();
  const res = await stop(tabId, keep);
  expect(res?.ok === true, `stop returned ${JSON.stringify(res)}`);
  const id = await capture;
  info.stopMs = Date.now() - t0;
  expect(info.stopMs < 3000, `took ${info.stopMs} ms to stop`);
  await sleep(600); // a viewer tab would have opened by now
  const after = await pageState(page);
  expect(after.y === before.y, `scroll ${before.y} -> ${after.y}`);
  expect(after.ours === 0, `${after.ours} [data-pagetopdf] elements left`);
  expect(after.inline === before.inline, 'inline styles differ after restore');
  expect(after.vw === before.vw, `viewport width ${before.vw} -> ${after.vw}`);
  expect(after.docClass === before.docClass, 'html/body classes differ');
  expect(await badge(tabId) === '', `badge "${await badge(tabId)}"`);
  if (o.hiRes) {
    expect(!(await debuggerAttached(tabId)), 'debugger still attached');
    expect(after.dpr === before.dpr, `device scale ${before.dpr} -> ${after.dpr}`);
  }
  const now = await records();
  if (keep) {
    expect(typeof id === 'string', `expected a record id, got ${id}`);
    const rec = await record(id);
    const full = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(rec && rec.stoppedEarly, 'record not marked stoppedEarly');
    expect(rec && rec.height > 0 && rec.height < full, `partial height ${rec?.height} vs page ${full}`);
    info.kept = rec && `${Math.round(rec.height)}/${full}px`;
    expect((await resultTabs()).length === 1, 'viewer should open for the kept capture');
  } else {
    expect(id === null, `capture resolved with ${id}`);
    expect(now.length === recs, `records ${recs} -> ${now.length}`);
    expect((await resultTabs()).length === 0, 'a viewer tab opened');
  }
  return { page, tabId };
}

await check('cancel mid-page', async expect => {
  const { page } = await cancelCase(expect, { when: tabId => waitFor(async () => (await pctOf(tabId)) >= 30) });
  await page.close();
});
await check('cancel during prepare', async expect => {
  const { page } = await cancelCase(expect, { when: () => sleep(20) });
  await page.close();
});
await check('cancel in end-of-feed probe', async expect => {
  // The feed grows whenever the capture reaches its bottom; by the 3rd growth it is probing.
  const { page } = await cancelCase(expect, { file: 'feed.html', scrollY: 0, when: (_, p) => waitFor(() => p.evaluate(() => window.__grows >= 3)) });
  await page.close();
});
await check('stop & save (keep partial)', async expect => {
  const { page } = await cancelCase(expect, { keep: true, file: 'tables.html', when: tabId => waitFor(async () => (await pctOf(tabId)) >= 35) });
  await page.close();
});
await check('hi-res cancel mid-page', async expect => {
  const { page } = await cancelCase(expect, { o: { hiRes: true, hiResScale: 2 }, when: tabId => waitFor(async () => (await pctOf(tabId)) >= 30) });
  await page.close();
});
await check('hi-res cancel while attaching', async expect => {
  const { page } = await cancelCase(expect, { o: { hiRes: true, hiResScale: 2 }, when: () => sleep(150) });
  await page.close();
});

await check('double stop', async expect => {
  const { page, tabId } = await openFixture('long.html', 200);
  const capture = start(tabId, {});
  await waitFor(async () => (await pctOf(tabId)) >= 20);
  const [a, b, c] = await Promise.all([stop(tabId), stop(tabId), stop(tabId, true)]);
  expect(a.ok && !b.ok && !c.ok, `stop results ${JSON.stringify([a, b, c])}`);
  expect(await capture === null, 'capture not cancelled');
  expect((await stop(tabId)).ok === false, 'stop after the end should be a no-op');
  expect((await resultTabs()).length === 0, 'a viewer tab opened');
  await page.close();
});

await check('keep then cancel upgrades to cancel', async expect => {
  const { page, tabId } = await openFixture('long.html', 0);
  const recs = (await records()).length;
  const capture = start(tabId, {});
  await waitFor(async () => (await pctOf(tabId)) >= 20);
  await stop(tabId, true);
  const r = await stop(tabId, false);
  expect(r.ok, 'cancel after keep refused');
  const id = await capture;
  // Either the cancel won (nothing stored) or the keep had already been committed.
  info.outcome = id ? 'kept' : 'cancelled';
  if (!id) expect((await records()).length === recs, 'record stored despite cancel');
  await page.close();
});

await check('cancel, then capture again at once', async expect => {
  const { page, tabId } = await openFixture('long.html', 300);
  const before = await pageState(page);
  const first = start(tabId, {});
  await waitFor(async () => (await pctOf(tabId)) >= 20);
  await stop(tabId);
  const second = start(tabId, {}); // while the first is still restoring the page
  const [a, b] = await Promise.all([first, second]);
  expect(a === null, `first resolved ${a}`);
  expect(typeof b === 'string', `second capture failed: ${b}`);
  const rec = await record(b);
  expect(rec && !rec.stoppedEarly && rec.height > 3000, `second capture incomplete: ${JSON.stringify(rec)}`);
  await waitFor(async () => (await resultTabs()).length === 1, 5000).catch(() => expect(false, 'no viewer for the second capture'));
  const after = await pageState(page);
  expect(after.y === before.y && after.ours === 0 && after.inline === before.inline, 'page not restored after second capture');
  expect(await badge(tabId) === '', 'badge not cleared');
  await page.close();
});

await check('tab closed mid-capture', async expect => {
  const { page, tabId } = await openFixture('long.html', 0);
  const recs = (await records()).length;
  const capture = start(tabId, {});
  await waitFor(async () => (await pctOf(tabId)) >= 20);
  const t0 = Date.now();
  await page.close();
  const id = await capture;
  info.stopMs = Date.now() - t0;
  expect(id === null, `resolved ${id}`);
  expect(info.stopMs < 3000, `took ${info.stopMs} ms`);
  expect((await records()).length === recs, 'record stored');
  expect((await stop(tabId)).ok === false, 'capture still registered');
});

await check('hi-res tab closed mid-capture', async expect => {
  const { page, tabId } = await openFixture('long.html', 0);
  const capture = start(tabId, { hiRes: true });
  await waitFor(async () => (await pctOf(tabId)) >= 20);
  await page.close();
  expect(await capture === null, 'not cancelled');
  expect(!(await debuggerAttached(tabId)), 'debugger still attached');
});

// ---------------------------------------------------------------- popup
await check('popup Stop buttons', async expect => {
  for (const scheme of ['light', 'dark']) {
    const pg = await ctx.newPage();
    await pg.emulateMedia({ colorScheme: scheme });
    await pg.setViewportSize({ width: 340, height: 300 });
    await pg.goto(`chrome-extension://${extId}/pages/popup.html`);
    await pg.waitForTimeout(500);
    // The popup follows the active tab, which here is the popup itself: drive it with the
    // same progress messages the worker sends during a capture.
    const popupTab = await sw.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
    await sw.evaluate(id => chrome.runtime.sendMessage({ type: 'progress', tabId: id, stage: 'capturing', pct: 0.42 }), popupTab);
    await pg.waitForTimeout(400);
    expect(await pg.isVisible('#cancel') && await pg.isVisible('#stopKeep'), 'stop buttons not visible');
    await pg.screenshot({ path: `${out}/popup-busy-${scheme}.png`, fullPage: true });
    await sw.evaluate(id => chrome.runtime.sendMessage({ type: 'progress', tabId: id, stage: 'capturing', pct: 0.55, stopping: 'keep' }), popupTab);
    await pg.waitForTimeout(400);
    expect(await pg.isDisabled('#cancel'), 'buttons not disabled while stopping');
    await pg.screenshot({ path: `${out}/popup-stopping-${scheme}.png`, fullPage: true });
    // Clicking sends the stop message for the popup's tab.
    await sw.evaluate(() => { globalThis.__stops = []; chrome.runtime.onMessage.addListener(m => { if (m.type === 'stop') globalThis.__stops.push(m); }); });
    await sw.evaluate(id => chrome.runtime.sendMessage({ type: 'progress', tabId: id, stage: 'capturing', pct: 0.6 }), popupTab);
    await pg.waitForTimeout(200);
    await pg.click('#cancel');
    await pg.waitForTimeout(400);
    const sent = await sw.evaluate(() => globalThis.__stops);
    expect(sent.length >= 1 && sent[0].tabId === popupTab && sent[0].keep === false, `stop message ${JSON.stringify(sent)}`);
    // Nothing was really running, so the popup resyncs and returns to its idle view.
    expect(await pg.isVisible('#idle'), 'popup did not return to idle');
    await pg.close();
  }
});

console.table(results);
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
await ctx.close();
server.close();
console.log('screenshots in', out);
process.exit(results.every(r => r.ok) ? 0 : 1);
