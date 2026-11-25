// Toolbar (action) icon colour.
//
// Chrome doesn't let extensions see the toolbar's colours: there is no theme API, and its
// light/dark mode doesn't help because custom themes can make the toolbar light in dark mode
// (or the reverse). So the icon colour is simply a user setting (`toolbarIcon`):
//   • 'black' (default) — near-black glyph, for light toolbars;
//   • 'white'           — near-white glyph, for dark toolbars.
import { getSettings } from './settings.js';

const path = file => ({
  16: `/icons/toolbar-${file}-16.png`,
  32: `/icons/toolbar-${file}-32.png`,
});
// File names: "light" = the glyph for light toolbars (black), "dark" = for dark toolbars (white).
const FILE = { black: 'light', white: 'dark' };

export async function syncActionIcon() {
  const { toolbarIcon } = await getSettings().catch(() => ({}));
  const glyph = toolbarIcon === 'white' ? 'white' : 'black'; // anything else (incl. a saved old 'auto') = black
  globalThis.ptpToolbarIcon = glyph; // read by the UI test
  return chrome.action.setIcon({ path: path(FILE[glyph]) }).catch(() => {});
}

// Service-worker side. Safe to call on every service-worker start.
export function initThemeIcon() {
  syncActionIcon();
  chrome.storage.onChanged.addListener(c => { if (c.toolbarIcon) syncActionIcon(); });
}
