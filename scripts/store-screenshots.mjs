// Chrome Web Store listing screenshots (1280×800) of the real extension on public pages.
// Usage: node scripts/store-screenshots.mjs  →  store/screenshots/*.png
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'store', 'screenshots');
const tmp = path.join(root, 'test', '.store-shots');
const ext = path.join(tmp, 'ext');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, 'extension'), ext, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
mf.host_permissions = ['<all_urls>']; // headless has no toolbar click to grant activeTab
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf));

const PAGES = {
  article: 'https://en.wikipedia.org/wiki/Lighthouse',
  docs: 'https://docs.python.org/3/tutorial/introduction.html',
};
const W = 1280, H = 800;

const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
  channel: 'chromium', headless: true, viewport: { width: W, height: H }, deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const E = p => `chrome-extension://${extId}/pages/${p}`;
await sw.evaluate(() => chrome.storage.sync.set({ autoDownload: 'none' }));

async function capture(url) {
  const pg = await ctx.newPage();
  await pg.goto(url, { waitUntil: 'networkidle' });
  // Decline any consent banner text-only; most of these sites have none.
  await pg.waitForTimeout(800);
  await pg.bringToFront();
  const id = await sw.evaluate(async u => {
    const [t] = await chrome.tabs.query({ url: u + '*' });
    return globalThis.ptpCapture(t.id, { scrollDelay: 250 });
  }, pg.url().split('#')[0]);
  // The viewer opens in a new tab when done; close it, we open our own.
  await new Promise(r => setTimeout(r, 1500));
  for (const p of ctx.pages()) if (p.url().includes('result.html')) await p.close();
  return { id, pg };
}

async function viewer(id, scheme = 'light') {
  const pg = await ctx.newPage();
  await pg.emulateMedia({ colorScheme: scheme });
  await pg.goto(E(`result.html?id=${id}`));
  await pg.waitForTimeout(1200);
  return pg;
}

// 1. Popup over the page being captured.
const art = await capture(PAGES.article);
await art.pg.bringToFront();
const pageShot = await art.pg.screenshot({ type: 'png' });
const pop = await ctx.newPage();
// Headless has no toolbar: make the popup's "active tab" the article, as if opened over it.
await pop.addInitScript(u => {
  const q = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = info => info?.active ? q({ url: u }) : q(info);
}, art.pg.url().split('#')[0]);
await pop.setViewportSize({ width: 340, height: 560 });
await pop.goto(E('popup.html'));
await pop.waitForTimeout(800);
const popH = await pop.evaluate(() => document.documentElement.scrollHeight);
await pop.setViewportSize({ width: 340, height: Math.min(popH, 700) });
const popShot = await pop.screenshot({ type: 'png' });
await pop.close();
const comp = await ctx.newPage();
await comp.setViewportSize({ width: W, height: H });
await comp.setContent(`<body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;position:relative">
  <img src="data:image/png;base64,${pageShot.toString('base64')}" style="position:absolute;inset:0;filter:brightness(.96)">
  <img src="data:image/png;base64,${popShot.toString('base64')}" style="position:absolute;top:10px;right:24px;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.08)">
</body>`);
await comp.waitForTimeout(300);
await comp.screenshot({ path: path.join(out, '1-popup.png') });
await comp.close();

// 2. Viewer with the PDF panel and page-break preview.
let v = await viewer(art.id);
if (await v.locator('#panel').evaluate(el => el.classList.contains('closed'))) await v.click('#panelBtn');
if (!(await v.locator('#showBreaks').isChecked())) await v.click('#showBreaks');
await v.waitForTimeout(600);
await v.screenshot({ path: path.join(out, '2-pdf-viewer.png') });
await v.close();

// 3. Draw mode on a docs page: an arrow, a box and a highlight.
const doc = await capture(PAGES.docs);
v = await viewer(doc.id);
if (!(await v.locator('#panel').evaluate(el => el.classList.contains('closed')))) await v.click('#panelBtn');
await v.click('#editBtn');
const tip = v.locator('#tipClose'); if (await tip.isVisible()) await tip.click();
const box = await v.locator('#overlay').boundingBox();
const drag = async (tool, x1, y1, x2, y2) => {
  await v.click(`[data-tool="${tool}"]`);
  await v.mouse.move(x1, y1); await v.mouse.down(); // viewport coordinates
  await v.mouse.move(x2, y2, { steps: 6 }); await v.mouse.up();
};
await drag('rect', 360, 590, 1140, 688);
await drag('highlight', 370, 446, 1026, 466);
await drag('arrow', 1215, 470, 1150, 590);
await v.click('[data-tool="select"]');

await v.waitForTimeout(400);
await v.screenshot({ path: path.join(out, '3-draw.png') });
await v.close();

// 4. Dark-mode viewer of the docs page, download menu open.
v = await viewer(doc.id, 'dark');
await v.click('#dlMenuBtn');
await v.waitForTimeout(300);
await v.screenshot({ path: path.join(out, '4-dark.png') });
await v.close();

await ctx.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('wrote', fs.readdirSync(out).join(', '));
