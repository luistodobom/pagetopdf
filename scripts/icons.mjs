// Renders the extension icons with Playwright.
//  • Toolbar (action) icon: a solid glyph on a transparent background, like Chrome's own
//    toolbar buttons — near-black for light toolbars, near-white for dark toolbars
//    (lib/theme-icon.js switches between them):
//      icons/toolbar16.svg → toolbar-{light,dark}-16.png   (hand-placed on the 16 px grid)
//      icons/toolbar32.svg → toolbar-{light,dark}-32.png   (2x screens)
//  • App icon (chrome://extensions, Web Store): icons/icon.svg → icon{16,32,48,128}.png
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
const svg = f => readFileSync(`extension/icons/${f}`, 'utf8');
const COLORS = { light: '#1f1f1f', dark: '#e3e3e3' }; // Chrome's toolbar icon colours
const b = await chromium.launch();
async function render(src, s, file) {
  const p = await b.newPage({ viewport: { width: s, height: s } });
  await p.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${s}px;height:${s}px;display:block}</style>${src}`);
  await p.screenshot({ path: `extension/icons/${file}`, omitBackground: true });
  await p.close();
}
for (const [scheme, color] of Object.entries(COLORS)) {
  await render(svg('toolbar16.svg').replaceAll('COLOR', color), 16, `toolbar-${scheme}-16.png`);
  await render(svg('toolbar32.svg').replaceAll('COLOR', color), 32, `toolbar-${scheme}-32.png`);
}
for (const s of [16, 32, 48, 128]) await render(svg('icon.svg'), s, `icon${s}.png`);
await b.close();
