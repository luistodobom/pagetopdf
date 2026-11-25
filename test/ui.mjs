// Screenshots of the extension UI (light + dark) and an auto-download check.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(root, '.build');
const out = path.join(root, 'out', 'ui');
fs.mkdirSync(out, { recursive: true });
fs.rmSync(ext, { recursive: true, force: true });
fs.cpSync(path.join(root, '..', 'extension'), ext, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
mf.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf));

const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); fs.createReadStream(path.join(root, 'fixtures', 'long.html')).pipe(res); });
await new Promise(r => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/long.html`;

fs.rmSync(path.join(root, '.profile-ui'), { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(path.join(root, '.profile-ui'), {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const E = p => `chrome-extension://${extId}/pages/${p}`;

// Auto-download PDF: no viewer tab should open, a download should complete.
const page = await ctx.newPage();
await page.goto(url);
await sw.evaluate(() => chrome.storage.sync.set({ autoDownload: 'pdf' }));
const id = await sw.evaluate(async u => { const [t] = await chrome.tabs.query({ url: u }); return globalThis.ptpCapture(t.id, { scrollDelay: 50 }); }, url);
await new Promise(r => setTimeout(r, 1500));
const dl = await sw.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }));
console.log('auto-download:', dl[0] && { filename: path.basename(dl[0].filename), state: dl[0].state, bytes: dl[0].fileSize, mime: dl[0].mime });
await sw.evaluate(() => chrome.storage.sync.set({ autoDownload: 'none' }));

const errors = [];
for (const scheme of ['light', 'dark']) {
  await ctx.pages()[0].emulateMedia({ colorScheme: scheme });
  const shot = async (p, file, size) => {
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errors.push(`${p}: ${e.message}`));
    pg.on('console', m => { if (m.type() === 'error') errors.push(`${p}: ${m.text()}`); });
    await pg.emulateMedia({ colorScheme: scheme });
    if (size) await pg.setViewportSize(size);
    await pg.goto(E(p));
    await pg.waitForTimeout(700);
    return pg;
  };
  let pg = await shot('popup.html', 'popup', { width: 340, height: 560 });
  await pg.screenshot({ path: `${out}/popup-${scheme}.png` }); await pg.close();

  // Viewer: plain, then with the download menu opened from the keyboard, then edit mode.
  pg = await shot(`result.html?id=${id}`, 'result', { width: 1400, height: 860 });
  await pg.screenshot({ path: `${out}/viewer-${scheme}.png` });
  await pg.focus('#dlMenuBtn'); await pg.keyboard.press('ArrowDown'); await pg.waitForTimeout(200);
  const focused = await pg.evaluate(() => document.activeElement?.dataset.act);
  await pg.screenshot({ path: `${out}/menu-${scheme}.png` });
  await pg.keyboard.press('Escape');
  const back = await pg.evaluate(() => document.activeElement?.id);
  if (focused !== 'pdf' || back !== 'dlMenuBtn') errors.push(`menu keyboard: focused=${focused} back=${back}`);
  await pg.click('#editBtn');
  await pg.click('[data-tool="rect"]');
  const box = await pg.locator('#overlay').boundingBox();
  await pg.mouse.move(box.x + 300, box.y + 260); await pg.mouse.down(); await pg.mouse.move(box.x + 560, box.y + 340, { steps: 4 }); await pg.mouse.up();
  await pg.click('#dlMenuBtn');
  await pg.waitForTimeout(300);
  await pg.screenshot({ path: `${out}/editor-${scheme}.png` });
  const label = await pg.locator('#editBtn').innerText();
  if (label.trim() !== 'Draw') errors.push(`draw button label: ${label}`);

  // Crop mode: remove a horizontal section by dragging, undo / redo it, remove a column, keep an area.
  await pg.keyboard.press('Escape'); // closes the menu
  await pg.click('#cropBtn');
  await pg.click('#resetEdits'); // start from no crop (the other colour scheme's run left some)
  await pg.click('[data-crop="rows"]');
  const cuts = () => pg.evaluate(() => window.ptp.getEdits().cuts);
  const drag = async (x0, y0, x1, y1) => { await pg.mouse.move(box.x + x0, box.y + y0); await pg.mouse.down(); await pg.mouse.move(box.x + x1, box.y + y1, { steps: 6 }); await pg.mouse.up(); await pg.waitForTimeout(100); };
  await drag(400, 420, 420, 560);
  const c1 = await cuts();
  await pg.screenshot({ path: `${out}/crop-rows-${scheme}.png` });
  await pg.keyboard.press('Meta+z');
  const c0 = await cuts();
  await pg.keyboard.press('Meta+Shift+z');
  const c2 = await cuts();
  if (c1.length !== 1 || c1[0].axis !== 'y' || c0.length !== 0 || JSON.stringify(c2) !== JSON.stringify(c1)) errors.push(`crop rows/undo/redo: ${JSON.stringify({ c1, c0, c2 })}`);
  await drag(300, 640, 320, 700); // a second section
  await pg.click('[data-crop="cols"]');
  await drag(620, 300, 700, 320);
  const c3 = await cuts();
  if (c3.length !== 3 || c3.filter(k => k.axis === 'x').length !== 1) errors.push(`crop cols: ${JSON.stringify(c3)}`);
  await pg.click('[data-crop="keep"]');
  await drag(150, 30, 900, 760);
  const ed = await pg.evaluate(() => window.ptp.getEdits());
  if (!ed.crop || ed.crop.w < 500) errors.push(`keep area: ${JSON.stringify(ed.crop)}`);
  await pg.mouse.move(box.x + 500, box.y + 200);
  await pg.screenshot({ path: `${out}/crop-mode-${scheme}.png` });
  // The × on a section puts it back.
  const before = (await cuts()).length;
  await pg.locator('#overlay .cut-del').first().click();
  if ((await cuts()).length !== before - 1) errors.push('cut delete button');
  await pg.click('#doneEdit'); await pg.waitForTimeout(800);
  await pg.screenshot({ path: `${out}/crop-done-${scheme}.png` });
  const exp = await pg.evaluate(async () => { const r = await window.ptp.getRec(); const { CaptureSource } = await import('../lib/export.js'); const s = new CaptureSource(r); return { w: s.width, h: s.height, ow: r.width, oh: r.height, edits: r.edits }; });
  console.log(`crop (${scheme}):`, JSON.stringify({ out: [exp.w, exp.h], orig: [exp.ow, exp.oh], crop: exp.edits.crop, cuts: exp.edits.cuts }));
  // Reset (in crop mode) clears crop + sections but keeps the drawing.
  await pg.click('#cropBtn'); await pg.click('#resetEdits');
  const er = await pg.evaluate(() => window.ptp.getEdits());
  if (er.crop || er.cuts.length || !er.shapes.length) errors.push(`crop reset: ${JSON.stringify(er)}`);
  await pg.waitForTimeout(400); await pg.close();

  pg = await shot('files.html', 'files', { width: 1200, height: 760 });
  await pg.screenshot({ path: `${out}/files-${scheme}.png` });
  await pg.click('.cap .check', { force: true }); await pg.waitForTimeout(150);
  await pg.screenshot({ path: `${out}/files-selected-${scheme}.png` }); await pg.close();

  pg = await shot('options.html', 'options', { width: 1100, height: 1000 });
  await pg.screenshot({ path: `${out}/options-${scheme}.png` });
  await pg.evaluate(() => scrollTo(0, 1100)); await pg.waitForTimeout(150);
  await pg.screenshot({ path: `${out}/options-scrolled-${scheme}.png` }); await pg.close();
}
// Toolbar icon: a plain setting — black by default, white when chosen (Chrome doesn't expose
// the toolbar colour, so there is no automatic mode).
const iconNow = () => sw.evaluate(async () => { await new Promise(r => setTimeout(r, 400)); return globalThis.ptpToolbarIcon; });
const def = await iconNow();
await sw.evaluate(() => chrome.storage.sync.set({ toolbarIcon: 'white' }));
const white = await iconNow();
await sw.evaluate(() => chrome.storage.sync.remove('toolbarIcon'));
const back = await iconNow();
console.log('toolbar icon: default', def, '→ white setting', white, '→ cleared', back);
if (def !== 'black' || white !== 'white' || back !== 'black') errors.push(`toolbar icon setting not applied (${def}/${white}/${back})`);
await ctx.close(); server.close();
console.log('ui screenshots in', out, errors);
