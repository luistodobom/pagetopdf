import { hydrateIcons, initPageChrome, toast } from './icons.js';
import { getSettings, setSettings, DEFAULTS, PAPER_SIZES } from '../lib/settings.js';

hydrateIcons();
initPageChrome();
let s = await getSettings();

const SECTIONS = [
  { title: 'Capture', desc: 'How pages are scrolled and photographed.', rows: [
    { key: 'hiRes', type: 'bool', label: 'High-resolution capture', help: 'Re-renders the page at a higher pixel density using the browser’s debugging protocol. Faster than normal mode and not rate-limited. While a capture runs Chrome shows a “PageToPDF started debugging this browser” bar, which goes away shortly after the capture ends (clicking Cancel on it stops the capture). On pages Chrome won’t let extensions debug, the capture is taken at normal resolution instead.' },
    { key: 'hiResScale', type: 'select', label: 'Resolution scale', options: { 2: '2× (Retina)', 3: '3×', 4: '4× (very large files)' }, dependsOn: 'hiRes', num: true },
    { key: 'removeBackgrounds', type: 'bool', label: 'Remove backgrounds', help: 'Temporarily strips background colours and gradients before capturing, then puts the page back. Great for printing.' },
    { key: 'darkenLightText', type: 'bool', label: 'Darken light text', help: 'When backgrounds are removed, turns white/light text dark so it stays readable on white.', dependsOn: 'removeBackgrounds' },
    { key: 'keepBackgroundImages', type: 'bool', label: 'Keep background images', help: 'Only remove colours and gradients; keep photos and icons drawn as CSS backgrounds.', dependsOn: 'removeBackgrounds' },
    { key: 'adjustRepeating', type: 'bool', label: 'Adjust repeating elements', help: 'Sticky headers, “back to top” buttons and cookie bars are shown once (headers on the first screen, footers on the last) instead of on every scroll step.' },
    { key: 'advancedScrolling', type: 'bool', label: 'Advanced scrolling', help: 'If the page itself doesn’t scroll, find the inner element that does (web apps, docs, chat UIs) and capture all of it.' },
    { key: 'hideScrollbars', type: 'bool', label: 'Hide scrollbars' },
    { key: 'preScroll', type: 'bool', label: 'Load lazy content first', help: 'Scroll through the whole page once before capturing so lazy-loaded images are ready.' },
    { key: 'scrollDelay', type: 'number', label: 'Delay after each scroll (ms)', help: 'Increase for pages with animations or slow-loading images.', min: 0, max: 5000 },
    { key: 'maxHeight', type: 'number', label: 'Maximum page height (px)', help: 'Stops infinite feeds (Twitter/X, Reddit…) from scrolling forever.', min: 1000, max: 500000 },
    { key: 'oneClick', type: 'bool', label: 'One-click capture', help: 'Clicking the toolbar button starts a capture immediately instead of opening the menu.' },
  ]},
  { title: 'Toolbar button', rows: [
    { key: 'toolbarIcon', type: 'select', label: 'Toolbar icon', help: 'Chrome doesn’t let extensions see your toolbar’s colour (custom themes can make it light even in dark mode), so pick whichever stands out on your toolbar.', options: { black: 'Black — for light toolbars', white: 'White — for dark toolbars' } },
  ]},
  { title: 'Images & downloads', rows: [
    { key: 'imageFormat', type: 'select', label: 'Default image format', options: { png: 'PNG — lossless', jpg: 'JPG — smaller' } },
    { key: 'jpgQuality', type: 'select', label: 'JPG quality', options: { 0.7: 'Medium', 0.85: 'High', 0.92: 'Very high', 1: 'Maximum' }, num: true },
    { key: 'autoDownload', type: 'select', label: 'Auto-download', help: 'Save the capture straight to your downloads folder instead of opening the viewer.', options: { none: 'Off — open the viewer', png: 'PNG', jpg: 'JPG', pdf: 'PDF' } },
    { key: 'saveAs', type: 'bool', label: 'Ask where to save', help: 'Show a “Save as” dialog for downloads from the viewer.' },
    { key: 'directory', type: 'text', label: 'Downloads sub-folder', help: 'Relative to your downloads folder, e.g. <code>screencaptures</code>. Leave blank for the downloads folder itself.' },
    { key: 'filenameTemplate', type: 'text', label: 'File name', help: 'Placeholders: <code>{title}</code> <code>{url}</code> <code>{domain}</code> <code>{date}</code> <code>{time}</code> <code>{timestamp}</code>' },
  ]},
  { title: 'PDF', desc: 'Defaults used when exporting to PDF. You can also change them from the viewer.', rows: [
    { key: 'paperSize', type: 'select', label: 'Paper size', options: Object.fromEntries(Object.entries(PAPER_SIZES).map(([k, v]) => [k, v.label])) },
    { key: 'orientation', type: 'select', label: 'Orientation', options: { portrait: 'Portrait', landscape: 'Landscape' } },
    { key: 'marginMm', type: 'select', label: 'Margins', options: { 0: 'None', 6: 'Small (6 mm)', 12: 'Normal (12 mm)', 20: 'Large (20 mm)' }, num: true },
    { key: 'smartSplit', type: 'bool', label: 'Smart page splitting', help: 'Uses the page’s text layout and the pixels themselves to place page breaks in gaps, so lines of text and small images are never cut in half.' },
    { key: 'pdfHeader', type: 'bool', label: 'Add title and date/time', help: 'Page title and capture date/time at the top of every page.' },
    { key: 'pdfFooter', type: 'bool', label: 'Add URL and page numbers', help: 'A clickable link to the original page plus “n / N” at the bottom.' },
    { key: 'textLayer', type: 'bool', label: 'Searchable text', help: 'Embeds the page’s real text (invisible, aligned with the screenshot) so the PDF can be searched, selected and copied.' },
    { key: 'activeLinks', type: 'bool', label: 'Active links', help: 'Links on the page stay clickable in the PDF.' },
    { key: 'pdfImageQuality', type: 'select', label: 'Image quality', options: { 0.8: 'Compact (JPEG 80%)', 0.92: 'High (JPEG 92%)', 1: 'Lossless (larger files)' }, num: true },
  ]},
];

function rowHTML(r) {
  const help = r.help ? `<small>${r.help}</small>` : '';
  let ctl = '';
  if (r.type === 'bool') ctl = `<span class="switch"><input type="checkbox" data-k="${r.key}"><span></span></span>`;
  else if (r.type === 'select') ctl = `<select class="input" data-k="${r.key}">${Object.entries(r.options).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`;
  else if (r.type === 'number') ctl = `<input class="input" type="number" min="${r.min}" max="${r.max}" data-k="${r.key}">`;
  else ctl = `<input class="input" type="text" data-k="${r.key}" spellcheck="false">`;
  return `<label class="row" data-row="${r.key}"><span class="lbl"><b>${r.label}</b>${help}</span><span class="ctl">${ctl}</span></label>`;
}

const root = document.getElementById('sections');
const slug = t => t.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
for (const sec of SECTIONS) {
  const el = document.createElement('section');
  el.className = 'settings';
  el.id = slug(sec.title);
  el.innerHTML = `<div class="sec-head"><h2 class="sec-title">${sec.title}</h2>${sec.desc ? `<p>${sec.desc}</p>` : ''}</div>
    <div class="card">${sec.rows.map(rowHTML).join('')}</div>`;
  root.appendChild(el);
}
const cmd = (await chrome.commands.getAll()).find(c => c.name === 'capture-page');
const extra = document.createElement('section');
extra.className = 'settings';
extra.id = 'shortcut';
extra.innerHTML = `<div class="sec-head"><h2 class="sec-title">Keyboard shortcut &amp; reset</h2></div>
  <div class="card">
    <div class="row"><span class="lbl"><b>Capture full page</b><small>Change it on Chrome’s keyboard shortcuts page.</small></span>
      <span class="ctl"><span class="kbd">${cmd?.shortcut || 'Not set'}</span><button class="btn" id="sc">Change</button></span></div>
    <div class="row" id="incognitoRow"><span class="lbl"><b>Incognito windows</b><small>${await chrome.extension.isAllowedIncognitoAccess()
      ? 'Allowed. Captures taken in incognito are kept only in incognito and deleted when you close all incognito windows.'
      : 'Not allowed. To capture in incognito, turn on “Allow in Incognito” on the extension’s details page. Captures taken there stay in incognito and are deleted when it closes.'}</small></span>
      <span class="ctl">${await chrome.extension.isAllowedIncognitoAccess() ? '' : '<button class="btn" id="incog">Details</button>'}</span></div>
    <div class="row" id="accessRow"><span class="lbl"><b>Site access</b><small id="accessText"></small></span>
      <span class="ctl"><button class="btn" id="accessBtn"></button></span></div>
    <div class="row"><span class="lbl"><b>Reset settings</b><small>Restore all settings to their original defaults.</small></span>
      <span class="ctl"><button class="btn" id="reset">Reset</button></span></div>
  </div>`;
root.appendChild(extra);
document.getElementById('sc').onclick = e => { e.preventDefault(); chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }); };
document.getElementById('incog')?.addEventListener('click', () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }));

// Site access. Normally Chrome grants PageToPDF one-time access to a tab when you click its
// toolbar button. Allowing sites permanently avoids "permission is required" failures when
// that one-time grant doesn't cover a page.
async function paintAccess() {
  const { origins = [] } = await chrome.permissions.getAll();
  const all = origins.some(o => o === '<all_urls>' || o === '*://*/*');
  const sites = origins.filter(o => o !== '<all_urls>' && o !== '*://*/*').map(o => o.replace(/^\w+:\/\/|\/\*$/g, ''));
  document.getElementById('accessText').textContent = all
    ? 'Allowed on all sites: captures never depend on Chrome’s one-time permission.'
    : `Only when you click the toolbar button${sites.length ? `, plus always on ${sites.join(', ')}` : ''}. If Chrome refuses a capture, allow the site from the popup, or allow all sites here.`;
  const btn = document.getElementById('accessBtn');
  btn.textContent = all || sites.length ? 'Remove access' : 'Allow on all sites';
  btn.onclick = async () => {
    if (all || sites.length) await chrome.permissions.remove({ origins }).catch(() => false);
    else await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
    paintAccess();
  };
}
paintAccess();
chrome.permissions.onAdded.addListener(paintAccess);
chrome.permissions.onRemoved.addListener(paintAccess);

// "Search settings": filter rows by their label/help text, like chrome://settings.
document.getElementById('q').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  let any = false;
  for (const sec of root.querySelectorAll('section.settings')) {
    let n = 0;
    for (const row of sec.querySelectorAll('.row')) {
      const hit = !q || row.textContent.toLowerCase().includes(q) || sec.querySelector('.sec-title').textContent.toLowerCase().includes(q);
      row.hidden = !hit; if (hit) n++;
    }
    sec.hidden = !n; any ||= n > 0;
    // keep a divider only between visible rows
    sec.querySelectorAll('.row').forEach(r => r.style.borderTop = '');
    const first = [...sec.querySelectorAll('.row')].find(r => !r.hidden);
    if (first) first.style.borderTop = '0';
  }
  document.getElementById('noMatch').hidden = any;
});

const rows = SECTIONS.flatMap(x => x.rows);
function paint() {
  for (const r of rows) {
    const input = root.querySelector(`[data-k="${r.key}"]`);
    if (r.type === 'bool') input.checked = !!s[r.key]; else input.value = String(s[r.key]);
    if (r.dependsOn) root.querySelector(`[data-row="${r.key}"]`).classList.toggle('disabled', !s[r.dependsOn]);
  }
}
paint();

root.addEventListener('change', async e => {
  const k = e.target.dataset.k; if (!k) return;
  const r = rows.find(x => x.key === k);
  let v = r.type === 'bool' ? e.target.checked : r.type === 'number' || r.num ? Number(e.target.value) : e.target.value;
  if (r.type === 'number') v = Math.min(r.max, Math.max(r.min, v || DEFAULTS[k]));
  s[k] = v;
  await setSettings({ [k]: v });
  paint();
});

document.getElementById('reset').onclick = async () => {
  if (!confirm('Restore all settings to their defaults?')) return;
  await chrome.storage.sync.clear();
  s = await getSettings(); paint(); toast('Defaults restored');
};
