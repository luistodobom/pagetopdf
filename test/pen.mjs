// Pen tool in Draw mode: freehand strokes, simplification, undo/redo, select/move/recolour/
// delete, thickness picker, and the exported PNG matching the on-screen strokes.
//   node test/pen.mjs    → screenshots in test/out/pen/
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(root, '.build-pen');
const out = path.join(root, 'out', 'pen');
fs.mkdirSync(out, { recursive: true });
fs.rmSync(ext, { recursive: true, force: true });
fs.cpSync(path.join(root, '..', 'extension'), ext, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
mf.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf));

const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); fs.createReadStream(path.join(root, 'fixtures', 'long.html')).pipe(res); });
await new Promise(r => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/long.html`;

const profile = path.join(root, '.profile-pen');
fs.rmSync(profile, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = sw.url().split('/')[2];
const page = await ctx.newPage();
await page.goto(url);
const id = await sw.evaluate(async u => { const [t] = await chrome.tabs.query({ url: u }); return globalThis.ptpCapture(t.id, { scrollDelay: 50 }); }, url);

const errors = [], log = (...a) => console.log(...a);
const check = (ok, msg) => { if (!ok) errors.push(msg); log(ok ? 'ok  ' : 'FAIL', msg); };

for (const scheme of ['light', 'dark']) {
  const pg = await ctx.newPage();
  pg.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  pg.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await pg.emulateMedia({ colorScheme: scheme });
  await pg.setViewportSize({ width: 1400, height: 860 });
  await pg.goto(`chrome-extension://${extId}/pages/result.html?id=${id}`);
  await pg.waitForFunction(() => window.ptp);
  await pg.waitForTimeout(500);
  await pg.evaluate(() => window.ptp.setEdits({ crop: null, cuts: [], shapes: [] }));
  const edits = () => pg.evaluate(() => window.ptp.getEdits());
  const zoom = await pg.evaluate(() => document.getElementById('doc').getBoundingClientRect().width / (document.getElementById('overlay').viewBox.baseVal.width));

  await pg.click('#editBtn');
  await pg.keyboard.press('p');
  const penBtn = pg.locator('[data-tool="pen"]');
  check(await penBtn.getAttribute('aria-pressed') === 'true', `${scheme}: P selects the pen`);
  check(await penBtn.getAttribute('title') === 'Pen (P)', `${scheme}: pen tooltip`);
  check(await pg.locator('#penOpts').isVisible(), `${scheme}: thickness picker shown for the pen`);

  const box = await pg.locator('#overlay').boundingBox();
  // A curvy stroke: a sine wave drawn with many small mouse moves.
  const wave = async (x0, y0, len, amp, steps, periods = 2) => {
    await pg.mouse.move(box.x + x0, box.y + y0); await pg.mouse.down();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await pg.mouse.move(box.x + x0 + len * t, box.y + y0 + amp * Math.sin(t * Math.PI * 2 * periods));
    }
    await pg.mouse.up(); await pg.waitForTimeout(50);
  };
  await wave(260, 220, 420, 40, 160);
  let e = await edits();
  const s0 = e.shapes[0];
  check(e.shapes.length === 1 && s0.type === 'pen' && s0.color === '#ef4444' && s0.width === 4, `${scheme}: one red medium pen stroke ${JSON.stringify({ n: e.shapes.length, type: s0?.type, color: s0?.color, width: s0?.width })}`);
  check(s0.points.length >= 8 && s0.points.length < 160, `${scheme}: simplified ${160} moves → ${s0.points.length} points`);
  check(s0.points.every(([x, y]) => Math.round(x * 10) === x * 10 && Math.round(y * 10) === y * 10), `${scheme}: points rounded to 0.1 px`);
  const first = s0.points[0], last = s0.points.at(-1);
  check(Math.abs(first[0] - 260 / zoom) < 1.5 && Math.abs(last[0] - 680 / zoom) < 1.5, `${scheme}: endpoints in capture coords (zoom ${zoom.toFixed(3)})`);

  await pg.keyboard.press('Meta+z');
  check((await edits()).shapes.length === 0, `${scheme}: undo removes the stroke`);
  await pg.keyboard.press('Meta+Shift+z');
  e = await edits();
  check(e.shapes.length === 1 && JSON.stringify(e.shapes[0]) === JSON.stringify(s0), `${scheme}: redo brings it back`);

  // Thick green loop, thin blue scribble, and a dot.
  await pg.click('#swatches [data-c="#22c55e"]');
  await pg.click('#penWidths [data-w="8"]');
  await pg.mouse.move(box.x + 820, box.y + 260); await pg.mouse.down();
  for (let i = 1; i <= 120; i++) { const a = i / 120 * Math.PI * 2.1; await pg.mouse.move(box.x + 760 + 60 * Math.cos(a) + i * 0.6, box.y + 260 + 45 * Math.sin(a)); }
  await pg.mouse.up();
  await pg.click('#swatches [data-c="#3b82f6"]');
  await pg.click('#penWidths [data-w="2"]');
  await wave(300, 420, 300, 18, 140, 5);
  await pg.mouse.click(box.x + 640, box.y + 420);
  e = await edits();
  check(e.shapes.length === 4 && e.shapes[1].width === 8 && e.shapes[2].width === 2 && e.shapes[2].color === '#3b82f6' && e.shapes[3].points.length === 1, `${scheme}: loop/scribble/dot stored ${JSON.stringify(e.shapes.map(s => [s.width, s.color, s.points.length]))}`);
  await pg.mouse.move(box.x + 1000, box.y + 600);
  await pg.screenshot({ path: `${out}/pen-strokes-${scheme}.png` });

  // Select & move the first (red) stroke by grabbing it on its curve.
  await pg.keyboard.press('v');
  check(!(await pg.locator('#penOpts').isVisible()), `${scheme}: thickness picker hidden for the select tool`);
  const before = (await edits()).shapes[0].points;
  // Grab a midpoint between two points: the smoothed curve passes through it.
  const k = Math.floor(before.length / 2);
  const grab = [(before[k][0] + before[k + 1][0]) / 2 * zoom, (before[k][1] + before[k + 1][1]) / 2 * zoom];
  await pg.mouse.move(box.x + grab[0], box.y + grab[1]); await pg.mouse.down();
  await pg.mouse.move(box.x + grab[0] + 30, box.y + grab[1] + 120, { steps: 8 }); await pg.mouse.up();
  const moved = (await edits()).shapes[0].points;
  const dx = moved[0][0] - before[0][0], dy = moved[0][1] - before[0][1];
  check(Math.abs(dx - 30 / zoom) < 0.3 && Math.abs(dy - 120 / zoom) < 0.3 && moved.length === before.length
    && moved.every((p, i) => Math.abs(p[0] - before[i][0] - dx) < 0.15 && Math.abs(p[1] - before[i][1] - dy) < 0.15), `${scheme}: select + drag moves every point (${dx.toFixed(1)}, ${dy.toFixed(1)})`);
  check(await pg.locator('#penOpts').isVisible(), `${scheme}: thickness picker shown for a selected pen stroke`);
  await pg.click('#swatches [data-c="#a855f7"]');
  check((await edits()).shapes[0].color === '#a855f7', `${scheme}: swatch recolours the selected stroke`);
  await pg.click('#penWidths [data-w="8"]');
  check((await edits()).shapes[0].width === 8, `${scheme}: thickness restyles the selected stroke`);
  await pg.mouse.move(box.x + 1000, box.y + 600);
  await pg.screenshot({ path: `${out}/pen-selected-${scheme}.png` });
  await pg.keyboard.press('Delete');
  e = await edits();
  check(e.shapes.length === 3 && e.shapes.every(s => s.color !== '#a855f7'), `${scheme}: Delete removes the selected stroke`);
  await pg.keyboard.press('Meta+z');
  check((await edits()).shapes.length === 4, `${scheme}: undo restores the deleted stroke`);

  // Exported PNG: the smoothed curve passes through the midpoints of consecutive points, so
  // the pixels there must be the stroke colour (stroke 8px; sampled at the centre).
  await pg.waitForTimeout(500); // edits are saved 250 ms after the last change
  const res = await pg.evaluate(async () => {
    const [f] = await window.ptp.buildExport('png');
    const bmp = await createImageBitmap(f.blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    const rec = await window.ptp.getRec();
    const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const res = [];
    for (const s of rec.edits.shapes) {
      if (s.points.length < 3) continue;
      let good = 0, n = 0;
      for (let i = 1; i < s.points.length - 1; i++) {
        const mx = (s.points[i][0] + s.points[i + 1][0]) / 2, my = (s.points[i][1] + s.points[i + 1][1]) / 2;
        // Best match in a 3×3 neighbourhood (a 2px stroke is anti-aliased across pixels).
        const d = x.getImageData(Math.round(mx * rec.scale) - 1, Math.round(my * rec.scale) - 1, 3, 3).data, w = hex(s.color);
        let best = 1e9; for (let j = 0; j < 36; j += 4) best = Math.min(best, Math.abs(d[j] - w[0]) + Math.abs(d[j + 1] - w[1]) + Math.abs(d[j + 2] - w[2]));
        n++; if (best < 60) good++;
      }
      res.push({ color: s.color, width: s.width, good, n });
    }
    const toB64 = async blob => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
    return { res, shapes: rec.edits.shapes.length, png: await toB64(f.blob) };
  });
  fs.writeFileSync(`${out}/pen-export-${scheme}.png`, Buffer.from(res.png, 'base64'));
  check(res.shapes === 4 && res.res.length === 3, `${scheme}: export has the 4 strokes`);
  for (const r of res.res) check(r.good / r.n > 0.95, `${scheme}: export draws ${r.color} w${r.width} stroke on its curve (${r.good}/${r.n})`);

  // Touch: a finger stroke via CDP touch events draws too (touch-action: none on the overlay).
  await pg.keyboard.press('p');
  const cdp = await ctx.newCDPSession(pg);
  const tp = (x, y) => [{ x: box.x + x, y: box.y + y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(300, 600) });
  for (let i = 1; i <= 30; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(300 + i * 8, 600 + 30 * Math.sin(i / 5)) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await pg.waitForTimeout(100);
  e = await edits();
  check(e.shapes.length === 5 && e.shapes[4].type === 'pen' && e.shapes[4].points.length > 3, `${scheme}: touch stroke drawn (${e.shapes[4]?.points?.length} points)`);
  check(await pg.evaluate(() => getComputedStyle(document.getElementById('overlay')).touchAction) === 'none', `${scheme}: overlay touch-action none while drawing`);
  await pg.close();
}
await ctx.close(); server.close();
fs.rmSync(ext, { recursive: true, force: true });
console.log(errors.length ? `\n${errors.length} problem(s):\n${errors.join('\n')}` : '\nall pen checks passed', '\nscreenshots in', out);
process.exitCode = errors.length ? 1 : 0;
