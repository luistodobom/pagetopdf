import { hydrateIcons } from './icons.js';
import { getSettings, setSettings } from '../lib/settings.js';
import { listCaptures } from '../lib/db.js';

hydrateIcons();
const $ = id => document.getElementById(id);
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const settings = await getSettings();

for (const key of ['removeBackgrounds', 'hiRes', 'adjustRepeating']) {
  $(key).checked = !!settings[key];
  $(key).addEventListener('change', async e => {
    const v = e.target.checked;
    await setSettings({ [key]: v });
    if (key === 'hiRes') $('hiResRow').hidden = !v;
  });
}
$('hiResRow').hidden = !settings.hiRes;
const seg = $('hiResScale');
const paintSeg = v => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.v) === Number(v)));
paintSeg(settings.hiResScale);
seg.addEventListener('click', async e => {
  const v = e.target.dataset?.v; if (!v) return;
  paintSeg(v); await setSettings({ hiResScale: Number(v) });
});

const commands = await chrome.commands.getAll();
const sc = commands.find(c => c.name === 'capture-page')?.shortcut;
if (sc) $('shortcut').textContent = sc; else $('shortcut').remove();

$('files').onclick = () => { chrome.tabs.create({ url: 'pages/files.html' }); window.close(); };
$('options').onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };

let startedAt = 0; // when this popup last started a capture
function show(which) { for (const id of ['idle', 'busy', 'error']) $(id).hidden = id !== which; }
function setPct(p) {
  $('pct').textContent = `${Math.round(p * 100)}%`;
  $('ringVal').style.strokeDashoffset = String(326.7 * (1 - p));
  document.querySelector('.ring').setAttribute('aria-valuenow', String(Math.round(p * 100)));
}

const restricted = !tab || !/^(https?|file):/.test(tab.url || '') || /chromewebstore\.google\.com|chrome\.google\.com\/webstore/.test(tab.url || '');
if (restricted) {
  $('capture').querySelector('small').textContent = 'This page can’t be scrolled by extensions — only the visible area will be saved';
}

function setStopping(reason) {
  const was = $('cancel').disabled;
  $('cancel').disabled = $('stopKeep').disabled = !!reason;
  if (reason) $('stage').textContent = reason === 'keep' ? 'Saving what’s captured…' : 'Cancelling…';
  else if (was) $('stage').textContent = 'Capturing page…'; // a new capture started meanwhile
}

function capture(overrides = {}) {
  show('busy'); setPct(0); setStopping(null);
  $('stage').textContent = overrides.visibleOnly ? 'Capturing visible area…' : 'Capturing page…';
  startedAt = Date.now();
  chrome.runtime.sendMessage({ type: 'capture', tabId: tab.id, overrides });
}
$('capture').onclick = () => capture();
$('visible').onclick = () => capture({ visibleOnly: true });
$('retry').onclick = () => capture();

function stop(keep) {
  setStopping(keep ? 'keep' : 'cancel'); // also guards against double clicks
  chrome.runtime.sendMessage({ type: 'stop', tabId: tab.id, keep }).then(async res => {
    if (res?.ok) return; // a 'cancelled' or 'done' progress message follows
    // Nothing left to stop (it just finished, or is already being saved): resync with the worker.
    const s = await chrome.runtime.sendMessage({ type: 'status', tabId: tab.id });
    if (s?.stage !== 'capturing') show(s?.stage === 'error' ? 'error' : 'idle');
  });
}
$('cancel').onclick = () => stop(false);
$('stopKeep').onclick = () => stop(true);

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type !== 'progress' || msg.tabId !== tab.id) return;
  if (msg.stage === 'capturing') {
    show('busy'); setPct(msg.pct || 0); setStopping(msg.stopping);
    if (msg.waitingForTab) $('stage').textContent = 'Waiting for the page to be the front tab again…';
    else if (!msg.stopping && msg.step) $('stage').textContent = msg.step;
    else if (!msg.stopping && msg.pct > 0.96) $('stage').textContent = 'Stitching…';
  }
  else if (msg.stage === 'done') { setPct(1); $('cancel').disabled = $('stopKeep').disabled = true; $('stage').textContent = 'Done!'; setTimeout(() => window.close(), 400); }
  else if (msg.stage === 'cancelled') show('idle');
  else if (msg.stage === 'error') showError(msg);
});

// Apply the worker's view of this tab's capture (used on open and as a periodic resync, so a
// missed progress message can never leave the popup stuck on a stale percentage).
// Error view; when Chrome refused permission for this site, offer to allow it permanently.
function showError(st) {
  show('error');
  $('errMsg').textContent = st?.error || 'Something went wrong.';
  const allow = $('allowSite');
  allow.hidden = !st?.needsAccess;
  if (st?.needsAccess) {
    allow.textContent = `Allow on ${st.host}`;
    allow.onclick = async () => {
      // Must run straight from the click (user gesture) for Chrome to show its prompt.
      const ok = await chrome.permissions.request({ origins: [st.needsAccess] }).catch(() => false);
      if (ok) capture(); else $('errMsg').textContent = 'Permission not granted. You can also allow it later in Settings → Site access.';
    };
  }
}
function applyStatus(st) {
  if (st?.stage === 'capturing') { show('busy'); setPct(st.pct || 0); setStopping(st.stopping); if (st.step && !st.stopping) $('stage').textContent = st.step; }
  else if (st?.stage === 'error') showError(st);
  else if (!$('busy').hidden) show('idle'); // finished or cancelled while we weren't listening
}
const status = await chrome.runtime.sendMessage({ type: 'status', tabId: tab.id });
if (status?.stage === 'capturing' || status?.stage === 'error') applyStatus(status);
setInterval(async () => {
  if ($('busy').hidden || Date.now() - startedAt < 1500) return; // the worker may not have registered a new capture yet
  const st = await chrome.runtime.sendMessage({ type: 'status', tabId: tab.id }).catch(() => null);
  if (st?.stage === 'done') return; // the 'done' message closes the popup
  applyStatus(st);
}, 2000);

const recent = (await listCaptures()).slice(0, 3);
if (recent.length) {
  const f = $('recent');
  f.innerHTML = '<h4>Recent captures</h4><div class="recent"></div>';
  for (const r of recent) {
    const a = document.createElement('a');
    a.href = `result.html?id=${r.id}`; a.target = '_blank'; a.title = r.title || r.url; a.setAttribute('aria-label', `Open capture: ${r.title || r.url}`);
    const img = document.createElement('img');
    if (r.thumb) img.src = URL.createObjectURL(r.thumb);
    a.appendChild(img);
    f.lastChild.appendChild(a);
  }
}
