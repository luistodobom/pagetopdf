// Incognito end-to-end check. Loads the unpacked extension, turns on "Allow in Incognito"
// (test-only, through chrome://extensions' private API, exactly what the Details toggle does),
// opens an incognito window and checks that:
//   • the incognito instance has its own service worker and its context menus;
//   • capture → viewer works there, the viewer opens in the incognito window, and PDF/PNG
//     downloads (viewer button + auto-download) complete;
//   • incognito captures stay out of the regular profile (and vice versa), and are gone once
//     every incognito window is closed;
//   • the regular profile still captures normally.
//
//   node test/incognito.mjs            # headless: downloads are only checked to start
//   node test/incognito.mjs --headed   # also checks the incognito downloads complete
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const headed = process.argv.includes('--headed');
const ext = path.join(root, '.build');
fs.rmSync(ext, { recursive: true, force: true });
fs.cpSync(path.join(root, '..', 'extension'), ext, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
mf.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf, null, 2));

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  fs.createReadStream(path.join(root, 'fixtures', 'long.html')).pipe(res);
});
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ check: name, ok: !!ok, detail: String(detail).slice(0, 160) }); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 20000, what = 'condition') {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(200)) { const v = await fn(); if (v) return v; }
  throw new Error(`Timed out waiting for ${what}`);
}

fs.rmSync(path.join(root, '.profile-incognito'), { recursive: true, force: true });
// Playwright only manages downloads of its own browser context. The incognito profile that
// Chrome creates by itself uses the regular profile's download preferences, so point those at
// test/out (instead of ~/Downloads) before launch.
const dlDir = path.join(root, 'out', 'incognito-downloads');
fs.rmSync(dlDir, { recursive: true, force: true }); fs.mkdirSync(dlDir, { recursive: true });
fs.mkdirSync(path.join(root, '.profile-incognito', 'Default'), { recursive: true });
fs.writeFileSync(path.join(root, '.profile-incognito', 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: dlDir, prompt_for_download: false, directory_upgrade: true },
  savefile: { default_directory: dlDir },
}));
const ctx = await chromium.launchPersistentContext(path.join(root, '.profile-incognito'), {
  channel: 'chromium', headless: !headed, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const swErrors = [];
const watch = (w, tag) => w.on('console', m => { if (m.type() === 'error') swErrors.push(`[${tag}] ${m.text()}`); });

try {
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];

  // "Allow in Incognito" (needs developer mode, otherwise the reload it triggers disables an
  // unpacked extension). Toggling it reloads the extension.
  const admin = await ctx.newPage();
  await admin.goto(`chrome://extensions/?id=${extId}`);
  await admin.evaluate(async id => {
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
    await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, incognitoAccess: true });
  }, extId);
  // Wake the reloaded regular service worker from an extension page.
  const driver = await ctx.newPage();
  await until(() => driver.goto(`chrome-extension://${extId}/pages/options.html`).then(() => true, () => false), 15000, 'extension reload');
  await driver.evaluate(() => chrome.runtime.sendMessage({ type: 'status', tabId: -1 }));
  const isIncognitoWorker = w => w.evaluate(() => chrome.extension.inIncognitoContext).catch(() => null);
  const workers = async want => { for (const w of ctx.serviceWorkers()) if ((await isIncognitoWorker(w)) === want) return w; return null; };
  sw = await until(() => workers(false), 15000, 'regular service worker');
  watch(sw, 'regular');
  check('incognito access allowed', await sw.evaluate(() => chrome.extension.isAllowedIncognitoAccess()));
  check('options page shows incognito status', /Allowed\./.test(await driver.locator('#incognitoRow').innerText()));

  // Open an incognito window. In split mode the regular instance can't see it (returns null).
  const incognitoUrl = `${base}/long.html?incognito`;
  await sw.evaluate(u => chrome.windows.create({ incognito: true, url: u }), incognitoUrl);
  const isw = await until(() => workers(true), 15000, 'incognito service worker');
  watch(isw, 'incognito');
  check('separate incognito service worker', isw !== sw);
  check('regular instance cannot see incognito tabs', !(await sw.evaluate(() => chrome.tabs.query({}))).some(t => t.incognito));
  check('context menus registered in incognito', await isw.evaluate(() => chrome.contextMenus.update('capture', {}).then(() => true, e => e.message)) === true);
  await until(async () => (await isw.evaluate(u => chrome.tabs.query({ url: u }), incognitoUrl))[0]?.status === 'complete', 15000, 'incognito page load');

  // Capture in incognito → viewer in the same incognito window.
  const iTab = (await isw.evaluate(u => chrome.tabs.query({ url: u }), incognitoUrl))[0];
  const viewerPromise = ctx.waitForEvent('page', { predicate: p => p.url().includes('result.html'), timeout: 120000 });
  const iId = await isw.evaluate(id => globalThis.ptpCapture(id, { scrollDelay: 50 }), iTab.id);
  const viewer = await viewerPromise;
  const vTab = (await isw.evaluate(() => chrome.tabs.query({}))).find(t => (t.url || t.pendingUrl || '').includes(iId));
  check('viewer opened in the incognito window', vTab && vTab.incognito && vTab.windowId === iTab.windowId, vTab && `${vTab.windowId} vs ${iTab.windowId}`);
  await viewer.waitForFunction(() => window.ptp, null, { timeout: 20000 });
  const exp = await viewer.evaluate(async () => {
    const pdf = await window.ptp.buildExport('pdf');
    const png = await window.ptp.buildExport('png');
    const head = new TextDecoder().decode(await pdf[0].blob.slice(0, 5).arrayBuffer());
    return { pdfBytes: pdf[0].blob.size, head, pngBytes: png[0].blob.size, incognito: chrome.extension.inIncognitoContext };
  });
  check('viewer runs in the incognito instance', exp.incognito);
  check('PDF/PNG export in incognito', exp.head === '%PDF-' && exp.pngBytes > 1000, `pdf ${exp.pdfBytes} B, png ${exp.pngBytes} B`);

  // Downloads. Headless Chromium cancels every download of the incognito profile
  // (USER_CANCELED; Playwright doesn't manage downloads of a profile it didn't create), so
  // these two checks need --headed. Files go to test/out/incognito-downloads.
  const lastDl = w => w.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }).then(d => d[0]));
  const done = d => d && d.state !== 'in_progress' && d;
  // Viewer's PDF button.
  await viewer.click('#dlPdf');
  const dl1 = await until(async () => done(await lastDl(isw)), 30000, 'viewer download');
  // Auto-download (offscreen document of the incognito instance).
  await isw.evaluate(() => chrome.storage.sync.set({ autoDownload: 'png' }));
  await isw.evaluate(id => globalThis.ptpCapture(id, { scrollDelay: 50 }), iTab.id);
  const dl2 = await until(async () => { const d = await lastDl(isw); return d.id !== dl1.id && done(d); }, 30000, 'auto-download');
  await isw.evaluate(() => chrome.storage.sync.set({ autoDownload: 'none' }));
  const desc = d => `${path.basename(d.filename) || '-'} ${d.state} ${d.error || ''}`;
  if (headed) {
    check('viewer PDF download completes in incognito', dl1.state === 'complete' && dl1.incognito && /\.pdf$/.test(dl1.filename), desc(dl1));
    check('auto-download PNG completes in incognito', dl2.state === 'complete' && dl2.incognito && /\.png$/.test(dl2.filename), desc(dl2));
  } else {
    // Still proves both paths reach chrome.downloads in the incognito profile.
    check('viewer PDF download started in incognito (finish needs --headed)', dl1.incognito, desc(dl1));
    check('auto-download started in incognito (finish needs --headed)', dl2.incognito, desc(dl2));
  }

  // Regular profile: still works, and can't see the incognito capture.
  const page = await ctx.newPage();
  await page.goto(`${base}/long.html?regular`);
  const rViewerPromise = ctx.waitForEvent('page', { predicate: p => p.url().includes('result.html'), timeout: 120000 });
  const rId = await sw.evaluate(async u => { const [t] = await chrome.tabs.query({ url: u }); return globalThis.ptpCapture(t.id, { scrollDelay: 50 }); }, page.url());
  const rViewer = await rViewerPromise;
  const rTab = (await sw.evaluate(() => chrome.tabs.query({}))).find(t => (t.url || t.pendingUrl || '').includes(rId));
  check('regular capture opens viewer in regular window', rTab && !rTab.incognito);
  await rViewer.waitForFunction(() => window.ptp, null, { timeout: 20000 });
  const before = (await lastDl(sw))?.id;
  await rViewer.click('#dlPdf');
  const dl3 = await until(async () => { const d = await lastDl(sw); return d && d.id !== before && d.state !== 'in_progress' && d; }, 30000, 'regular download');
  check('viewer PDF download completes in regular profile', dl3.state === 'complete' && !dl3.incognito, `${path.basename(dl3.filename)} ${dl3.state} ${dl3.error || ''}`);
  const list = p => p.evaluate(async () => (await import('../lib/db.js')).listCaptures().then(l => l.map(c => c.id)));
  const regularIds = await list(driver), incognitoIds = await list(viewer);
  check('incognito capture not stored in regular profile', !regularIds.includes(iId) && regularIds.includes(rId), `regular: ${regularIds.length}`);
  check('regular capture not visible in incognito', incognitoIds.includes(iId) && !incognitoIds.includes(rId), `incognito: ${incognitoIds.length}`);
  await rViewer.close();

  // Close every incognito window: its captures go with it.
  await isw.evaluate(async () => { for (const w of await chrome.windows.getAll()) if (w.incognito) await chrome.windows.remove(w.id); }).catch(() => {});
  await sleep(1500);
  await sw.evaluate(u => chrome.windows.create({ incognito: true, url: u }), `${base}/long.html?again`);
  const isw2 = await until(async () => { for (const w of ctx.serviceWorkers()) if (w !== isw && (await isIncognitoWorker(w)) === true) return w; return null; }, 15000, 'new incognito service worker');
  const ids2 = await isw2.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('pagetopdf');
    req.onupgradeneeded = () => req.result.createObjectStore('captures', { keyPath: 'id' });
    req.onsuccess = () => { const g = req.result.transaction('captures').objectStore('captures').getAllKeys(); g.onsuccess = () => resolve(g.result); g.onerror = () => reject(g.error); };
    req.onerror = () => reject(req.error);
  }));
  check('incognito captures deleted when incognito closes', !ids2.includes(iId), `left: ${ids2.length}`);
} catch (e) {
  check('run', false, e.message);
}

console.table(results);
if (swErrors.length) console.log('Service-worker errors:\n' + swErrors.join('\n'));
await ctx.close();
server.close();
process.exit(results.every(r => r.ok) ? 0 : 1);
