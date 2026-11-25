// Draw toolbar: line thickness for pen/rect/ellipse/arrow/line (not text/highlight/redact),
// a pt text-size picker for text; both restyle a selected shape.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(root, '.build');
const out = path.join(root, 'out', 'style');
fs.mkdirSync(out, { recursive: true });
fs.rmSync(ext, { recursive: true, force: true });
fs.cpSync(path.join(root, '..', 'extension'), ext, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
mf.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf));
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); fs.createReadStream(path.join(root, 'fixtures', 'long.html')).pipe(res); });
await new Promise(r => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/long.html`;
fs.rmSync(path.join(root, '.profile-style'), { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(path.join(root, '.profile-style'), {
  channel: 'chromium', headless: true, viewport: { width: 1400, height: 860 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const page = await ctx.newPage(); await page.goto(url);
const errors = [];
for (const scheme of ['light', 'dark']) {
  await page.bringToFront();
  const id = await sw.evaluate(async u => { const [t] = await chrome.tabs.query({ url: u }); return globalThis.ptpCapture(t.id, { scrollDelay: 50 }); }, url);
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errors.push(e.message));
  await pg.emulateMedia({ colorScheme: scheme });
  await pg.goto(`chrome-extension://${extId}/pages/result.html?id=${id}`); await pg.waitForTimeout(700);
  await pg.click('#editBtn');
  const vis = () => pg.evaluate(() => ({ w: !document.getElementById('penOpts').hidden, t: !document.getElementById('textOpts').hidden }));
  const seen = {};
  for (const t of ['pen', 'rect', 'ellipse', 'arrow', 'line', 'text', 'highlight', 'redact']) { await pg.click(`[data-tool="${t}"]`); seen[t] = await vis(); }
  const want = { pen: [1, 0], rect: [1, 0], ellipse: [1, 0], arrow: [1, 0], line: [1, 0], text: [0, 1], highlight: [0, 0], redact: [0, 0] };
  for (const [t, [w, x]] of Object.entries(want)) if (seen[t].w !== !!w || seen[t].t !== !!x) errors.push(`${scheme} ${t} visibility ${JSON.stringify(seen[t])}`);
  const box = await pg.locator('#overlay').boundingBox();
  const drag = async (x0, y0, x1, y1) => { await pg.mouse.move(box.x + x0, box.y + y0); await pg.mouse.down(); await pg.mouse.move(box.x + x1, box.y + y1, { steps: 4 }); await pg.mouse.up(); };
  // Thick rectangle, thin arrow.
  await pg.click('[data-tool="rect"]'); await pg.click('#penWidths [data-w="8"]'); await drag(100, 100, 300, 200);
  await pg.click('[data-tool="arrow"]'); await pg.click('#penWidths [data-w="2"]'); await drag(350, 100, 500, 220);
  // 32pt text, typed after choosing the size, then changed to 24 mid-typing.
  await pg.click('[data-tool="text"]'); await pg.selectOption('#textSize', '32');
  await pg.mouse.click(box.x + 120, box.y + 300); await pg.waitForTimeout(100);
  await pg.keyboard.type('Big note');
  await pg.selectOption('#textSize', '24'); await pg.waitForTimeout(100);
  await pg.keyboard.type('!');
  await pg.click('[data-tool="select"]'); await pg.waitForTimeout(200);
  let sh = await pg.evaluate(() => window.ptp.getEdits().shapes.map(s => ({ type: s.type, width: s.width, size: s.size, text: s.text })));
  const [r, a, tx] = sh;
  if (r?.width !== 8 || a?.width !== 2 || tx?.type !== 'text' || tx.text !== 'Big note!' || Math.abs(tx.size - 32) > 0.01) errors.push(`${scheme} shapes ${JSON.stringify(sh)}`);
  // Select the rect → thickness shown, set to medium; select the text → size shown as 24, set 48.
  await pg.mouse.click(box.x + 100, box.y + 150);
  const rv = await vis();
  await pg.click('#penWidths [data-w="4"]');
  await pg.screenshot({ path: `${out}/rect-selected-${scheme}.png` });
  await pg.mouse.click(box.x + 140, box.y + 310);
  const tv = await vis(); const shown = await pg.inputValue('#textSize');
  await pg.selectOption('#textSize', '48');
  await pg.screenshot({ path: `${out}/text-selected-${scheme}.png` });
  sh = await pg.evaluate(() => window.ptp.getEdits().shapes.map(s => ({ type: s.type, width: s.width, size: s.size })));
  if (!rv.w || rv.t || sh[0].width !== 4) errors.push(`${scheme} restyle rect ${JSON.stringify({ rv, s: sh[0] })}`);
  if (!tv.t || tv.w || shown !== '24' || Math.abs(sh[2].size - 64) > 0.01) errors.push(`${scheme} restyle text ${JSON.stringify({ tv, shown, s: sh[2] })}`);
  await pg.click('[data-tool="pen"]');
  await pg.screenshot({ path: `${out}/toolbar-${scheme}.png`, clip: { x: 0, y: 0, width: 1400, height: 120 } });
  await pg.close();
}
await ctx.close(); server.close();
console.log('style opts', errors.length ? errors : 'OK', out);
