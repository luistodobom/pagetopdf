import { getSettings } from './lib/settings.js';
import { initThemeIcon } from './lib/theme-icon.js';
import { putCapture } from './lib/db.js';
import { Stitcher, makeThumb } from './lib/stitcher.js';
import { buildFilename, sleep } from './lib/util.js';

initThemeIcon(); // toolbar icon colour from the 'toolbarIcon' setting (black by default)

const running = new Map(); // tabId -> status
const active = new Map();  // tabId -> { stopper, settled } for captures in progress
let lastCapture = 0;

// ---------------------------------------------------------------- stopping
// A capture can be stopped in two ways:
//   'keep'   stop scrolling and save what has been captured so far (top -> current row)
//   'cancel' abort, restore the page and store nothing
// The capture loop polls the stopper between frames; waits use stopper.sleep() so a
// cancel wakes them up immediately.
class CaptureCancelled extends Error {
  constructor() { super('Capture cancelled'); this.name = 'CaptureCancelled'; }
}
class Stopper {
  reason = null;     // null | 'keep' | 'cancel'
  committed = false; // the capture is being saved; too late to stop
  #wake = new Set();
  stop(reason) {
    if (this.committed || this.reason === 'cancel' || this.reason === reason) return false;
    this.reason = reason; // 'cancel' may upgrade an earlier 'keep'
    // Only a cancel cuts waits short ('keep' still finishes the current row, rate limit included).
    if (reason === 'cancel') for (const f of [...this.#wake]) f();
    return true;
  }
  get cancelled() { return this.reason === 'cancel'; }
  throwIfCancelled() { if (this.reason === 'cancel') throw new CaptureCancelled(); }
  sleep(ms) {
    if (this.reason === 'cancel') return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(t); this.#wake.delete(done); resolve(); };
      const t = setTimeout(done, ms);
      this.#wake.add(done);
    });
  }
}

/** Stops the capture running in `tabId` (or every capture when tabId is null). */
export function stopCapture(tabId, reason = 'cancel') {
  const targets = tabId == null ? [...active.keys()] : active.has(tabId) ? [tabId] : [];
  let ok = false;
  for (const id of targets) {
    if (!active.get(id).stopper.stop(reason)) continue;
    ok = true;
    const cur = running.get(id);
    if (cur?.stage === 'capturing') report(id, cur); // tell the popup it is stopping
  }
  if (ok) syncStopMenus();
  return ok;
}

// The "Stop capture" context-menu items only show while something is being captured.
function syncStopMenus() {
  const visible = [...active.values()].some(a => !a.stopper.committed && !a.stopper.cancelled);
  for (const id of ['stop-keep', 'stop-cancel']) chrome.contextMenus.update(id, { visible }, () => void chrome.runtime.lastError);
}
syncStopMenus(); // a fresh service worker has no capture running

// ---------------------------------------------------------------- UI wiring
function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'capture', title: 'Capture full page', contexts: ['page', 'action'] });
    chrome.contextMenus.create({ id: 'capture-nobg', title: 'Capture full page without backgrounds', contexts: ['page', 'action'] });
    chrome.contextMenus.create({ id: 'capture-hires', title: 'Capture full page in high resolution', contexts: ['page', 'action'] });
    chrome.contextMenus.create({ id: 'capture-visible', title: 'Capture visible area only', contexts: ['page', 'action'] });
    chrome.contextMenus.create({ id: 'files', title: 'Open captured files', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'stop-keep', title: 'Stop capture and save what’s captured', contexts: ['page', 'action'], visible: false });
    chrome.contextMenus.create({ id: 'stop-cancel', title: 'Cancel capture', contexts: ['page', 'action'], visible: false });
  });
}
chrome.runtime.onInstalled.addListener(async () => {
  createMenus();
  await syncActionMode();
});
// The manifest sets "incognito": "split". When the user allows the extension in incognito,
// incognito windows get their own service worker, IndexedDB and offscreen document, so
// captures taken there never reach the regular profile and vanish when incognito closes
// (chrome.storage settings are still shared). That instance never receives onInstalled and
// its context menus are separate, so it registers them itself on every start.
if (chrome.extension.inIncognitoContext) createMenus();
chrome.runtime.onStartup.addListener(syncActionMode);
chrome.storage.onChanged.addListener(c => { if (c.oneClick) syncActionMode(); });

async function syncActionMode() {
  const s = await getSettings();
  await chrome.action.setPopup({ popup: s.oneClick ? '' : 'pages/popup.html' });
}

// Only fires in one-click mode. Clicking again while capturing stops (and keeps the partial capture).
chrome.action.onClicked.addListener(tab => toggleCapture(tab));

function toggleCapture(tab) {
  if (active.has(tab.id)) return void stopCapture(tab.id, 'keep');
  startCapture(tab).catch(() => {});
}

// Closing the tab cancels its capture instead of failing on the next frame.
chrome.tabs.onRemoved.addListener(tabId => stopCapture(tabId, 'cancel'));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const map = {
    capture: {},
    'capture-nobg': { removeBackgrounds: true },
    'capture-hires': { hiRes: true },
    'capture-visible': { visibleOnly: true },
  };
  if (info.menuItemId === 'files') return chrome.tabs.create({ url: 'pages/files.html' });
  if (info.menuItemId === 'stop-keep' || info.menuItemId === 'stop-cancel') {
    return stopCapture(tab && active.has(tab.id) ? tab.id : null, info.menuItemId === 'stop-keep' ? 'keep' : 'cancel');
  }
  if (map[info.menuItemId]) startCapture(tab, map[info.menuItemId]);
});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'capture-page') return;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) toggleCapture(tab); // pressing the shortcut again stops the capture
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'capture') {
    chrome.tabs.get(msg.tabId).then(tab => startCapture(tab, msg.overrides || {}));
    sendResponse({ ok: true });
  } else if (msg.type === 'stop') {
    sendResponse({ ok: stopCapture(msg.tabId, msg.keep ? 'keep' : 'cancel') });
  } else if (msg.type === 'status') {
    sendResponse(running.get(msg.tabId) || null);
  }
});

// ---------------------------------------------------------------- progress
function report(tabId, status) {
  const stopping = status.stage === 'capturing' ? active.get(tabId)?.stopper.reason : null;
  status = { ...status, stopping: stopping || undefined };
  running.set(tabId, status);
  chrome.runtime.sendMessage({ type: 'progress', tabId, ...status }).catch(() => {});
  const text = status.stage === 'done' || status.stage === 'cancelled' ? '' : status.stage === 'error' ? '!' : `${Math.round((status.pct || 0) * 100)}%`;
  chrome.action.setBadgeBackgroundColor({ color: status.stage === 'error' ? '#c62828' : '#2962ff', tabId }).catch(() => {});
  chrome.action.setBadgeText({ text, tabId }).catch(() => {});
}

// ---------------------------------------------------------------- agent calls
const TAB_CLOSED = 'The tab was closed during the capture.';
const tabClosed = tabId => chrome.tabs.get(tabId).then(() => false, () => true);

// Chrome briefly refuses tab operations (screenshots, script injection, opening tabs) while
// it thinks the user is dragging a tab — e.g. right after a click in the popup:
// "Tabs cannot be edited right now (user may be dragging a tab)". It clears within moments,
// so retry instead of failing the capture (and leaving the page half-prepared).
const TRANSIENT_TAB_ERROR = /cannot be edited right now|dragging a tab/i;
async function retryTransient(fn, stopper, { tries = 40, wait = 250 } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || !TRANSIENT_TAB_ERROR.test(String(e?.message || e))) throw e;
      if (stopper) { stopper.throwIfCancelled(); await stopper.sleep(wait); } else await sleep(wait);
    }
  }
}

// Upper bounds for one call into the page. A page that never answers (its main thread stuck)
// becomes a clear error naming the step instead of a capture stuck at 0% forever.
const AGENT_TIMEOUT = { prepare: 120000, frame: 45000, probe: 20000, measure: 15000, restore: 15000 };
const AGENT_STEP = { prepare: 'preparing the page', frame: 'getting the page ready for a screenshot', probe: 'checking for more content', measure: 'measuring the page', restore: 'restoring the page' };

async function agent(tabId, method, arg) {
  const limit = AGENT_TIMEOUT[method] || 30000;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`The page stopped responding while ${AGENT_STEP[method] || method} (no answer for ${limit / 1000} s).`)), limit);
  });
  const [res] = await Promise.race([retryTransient(() => chrome.scripting.executeScript({
    target: { tabId },
    func: (m, a) => window.__ptpAgent[m](a),
    args: [method, arg ?? null],
  })), timeout]).catch(async e => { throw (await tabClosed(tabId)) ? new Error(TAB_CLOSED) : e; }).finally(() => clearTimeout(timer));
  if (res && res.error) throw new Error(res.error.message || String(res.error));
  return res ? res.result : undefined;
}

// ---------------------------------------------------------------- screenshots
// chrome.tabs.captureVisibleTab photographs whatever tab is in front of the window, and
// the one-time 'activeTab' permission only covers the tab the user invoked us on. If another
// tab is in front, wait (up to 30 s) for the captured one to come back rather than failing.
async function waitForFront(tab, stopper) {
  for (let waited = 0; ; waited += 500) {
    const [front] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
    if (!front || front.id === tab.id) return;
    if (waited >= 30000) throw new Error('The page being captured is no longer the front tab. Keep it in front until the capture finishes.');
    if (waited === 0) report(tab.id, { ...running.get(tab.id), waitingForTab: true });
    await stopper.sleep(500);
    stopper.throwIfCancelled();
  }
}

// Chrome kept refusing chrome.tabs.captureVisibleTab for this window; the caller switches to
// the debugger's screenshot instead (see screenshotFallback).
class ScreenshotRefused extends Error {}

async function grabVisible(tab, stopper) {
  const sleep = ms => stopper.sleep(ms);
  const windowId = tab.windowId;
  let refusedSince = 0;
  // A refusal for our (front) tab: retry briefly, then let the caller fall back.
  const refused = async e => {
    refusedSince ||= Date.now();
    report(tab.id, { ...running.get(tab.id), step: `Chrome refused the screenshot (${e.message.replace(/\.$/, '')}); retrying…` });
    if (Date.now() - refusedSince > 3000) throw new ScreenshotRefused(e.message);
    await sleep(250);
  };
  // chrome.tabs.captureVisibleTab is limited to 2 calls/second.
  for (let attempt = 0; ; attempt++) {
    const wait = 520 - (Date.now() - lastCapture);
    if (wait > 0) await sleep(wait);
    stopper.throwIfCancelled();
    await waitForFront(tab, stopper); // right before the shot: a tab switch during the wait counts
    lastCapture = Date.now();
    try {
      const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      if (refusedSince) report(tab.id, { ...running.get(tab.id), step: 'Capturing page…' }); // recovered
      return await (await fetch(url)).blob();
    } catch (e) {
      if (attempt < 4 && /MAX_CAPTURE|quota|rate/i.test(e.message)) { await sleep(600); continue; }
      if (TRANSIENT_TAB_ERROR.test(e.message)) { await refused(e); continue; }
      if (NEEDS_ACCESS.test(e.message)) {
        // Another tab came to the front between the check and the shot: Chrome then refuses
        // (it would be photographing that tab). Wait for ours and try again.
        const [front] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
        if (front && front.id !== tab.id && attempt < 60) continue;
        await refused(e); continue;
      }
      throw e;
    }
  }
}

// High resolution: re-render the tab at a higher device scale factor through the
// DevTools protocol and screenshot it from there (chrome.debugger; Chrome shows its
// "started debugging this browser" bar while we are attached).
const HIRES_MAX_WIDTH = 16384; // device px; keeps tiles/frames under GPU + canvas limits

// Thrown when the debugger can't be used for this tab at all (before any frame was taken);
// the capture then continues at normal resolution.
class HiResUnavailable extends Error {}

function attachError(e) {
  const m = String(e?.message || e);
  if (/already attached/i.test(m)) {
    return new HiResUnavailable('Another debugger (DevTools or an extension) is attached to this tab, so high resolution was not available.');
  }
  if (/cannot (access|attach)|not allowed|chrome:\/\/|chrome-extension:|devtools:\/\//i.test(m)) {
    return new HiResUnavailable('Chrome does not allow high-resolution capture of this page.');
  }
  return new HiResUnavailable(`High resolution is unavailable (${m}).`);
}

class DebuggerShooter {
  constructor(tabId) {
    this.target = { tabId };
    this.attached = false;
    this.lost = null; // chrome.debugger.onDetach reason, once Chrome or the user ends our session
    this.onDetach = (src, reason) => {
      if (src.tabId !== tabId) return;
      this.attached = false;
      this.lost = reason;
    };
  }
  send(method, params) { return chrome.debugger.sendCommand(this.target, method, params); }

  async attach(width, height, scale) {
    try {
      await chrome.debugger.attach(this.target, '1.3');
    } catch (e) {
      if (!/already attached/i.test(e.message)) throw attachError(e);
      // A session of our own left behind (e.g. the service worker restarted mid-capture)?
      // detach() only succeeds for our own session, never for DevTools or another extension.
      const ours = await chrome.debugger.detach(this.target).then(() => true, () => false);
      if (!ours) throw attachError(e);
      await chrome.debugger.attach(this.target, '1.3').catch(e2 => { throw attachError(e2); });
    }
    this.attached = true;
    chrome.debugger.onDetach.addListener(this.onDetach);
    // Explicit width/height: the page keeps its layout size even though Chrome's
    // "started debugging" bar now takes space above it (the bar is browser UI and never
    // part of the rendered surface).
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await this.settle(width, height, scale);
  }

  // Wait until the page has re-laid out and painted at the new scale, so the first
  // frame is not taken from a surface still at the old density.
  async settle(width, height, scale) {
    const expression = `new Promise(done => {
      const t0 = performance.now();
      const ok = () => Math.abs(devicePixelRatio - ${scale}) < 0.01 && innerWidth === ${width} && innerHeight === ${height};
      const tick = () => (ok() || performance.now() - t0 > 2000)
        ? requestAnimationFrame(() => requestAnimationFrame(() => done(ok())))
        : requestAnimationFrame(tick);
      tick();
    })`;
    const res = await Promise.race([
      this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).catch(() => null),
      sleep(3000).then(() => null),
    ]);
    this.check();
    if (globalThis.ptpDebug) globalThis.ptpSettled = !!res?.result?.value;
    if (!res?.result?.value) console.warn('PageToPDF: hi-res metrics override did not settle in time', res);
    await sleep(100); // let rasterisation at the new scale finish
  }

  check() {
    if (!this.lost) return;
    if (this.lost === 'canceled_by_user') throw new Error('High-resolution capture was cancelled from Chrome’s “started debugging” bar.');
    if (this.lost === 'target_closed') throw new Error(TAB_CLOSED);
    throw new Error(`The high-resolution capture was interrupted (${this.lost}).`);
  }

  async grab() {
    this.check();
    let data;
    try {
      ({ data } = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }));
    } catch (e) {
      // Report why the session went away rather than "Debugger is not attached".
      this.check();
      if (await tabClosed(this.target.tabId)) throw new Error(TAB_CLOSED);
      if (/not attached/i.test(e.message)) throw new Error('The high-resolution capture was interrupted: Chrome ended the debugging session.');
      throw e;
    }
    return (await fetch(`data:image/png;base64,${data}`)).blob();
  }

  async detach() {
    chrome.debugger.onDetach.removeListener(this.onDetach);
    if (!this.attached) return; // never attached, or Chrome already ended the session (which also drops the override)
    this.attached = false;
    try { await this.send('Emulation.clearDeviceMetricsOverride'); } catch { /* tab may be gone */ }
    try { await chrome.debugger.detach(this.target); } catch { /* already detached */ }
  }
}

// When Chrome refuses chrome.tabs.captureVisibleTab for a window, take the screenshots through
// the debugger instead, at the page's current pixel density so nothing re-lays out or changes
// scale mid-capture (Chrome shows its "started debugging" bar meanwhile).
async function screenshotFallback(tabId, scale, why, stopper) {
  report(tabId, { ...running.get(tabId), step: 'Chrome refused normal screenshots; switching to its debugging API…' });
  const [{ result: size }] = await retryTransient(() => chrome.scripting.executeScript({ target: { tabId }, func: () => [innerWidth, innerHeight] }), stopper);
  const shooter = new DebuggerShooter(tabId);
  try {
    await shooter.attach(size[0], size[1], scale);
  } catch (e) {
    await shooter.detach();
    throw new Error(`Chrome refused to take screenshots of this page (${why}), and the fallback failed too (${e.message}).`);
  }
  report(tabId, { ...running.get(tabId), step: 'Capturing page…' });
  return shooter;
}
const FALLBACK_NOTE = 'Chrome refused normal screenshots in this window, so this page was captured through Chrome’s debugging API.';

// Screenshots and page scripts rely on the one-time 'activeTab' permission Chrome grants when
// the toolbar button is clicked. If Chrome refuses (the grant didn't cover this page, or was
// withdrawn), the popup offers to allow the site permanently (optional host permission).
const NEEDS_ACCESS = /'<all_urls>' or 'activeTab' permission is required|Cannot access contents of|must request permission to access/i;
function needsSiteAccess(e, tab) {
  if (!NEEDS_ACCESS.test(String(e?.message || e))) return null;
  try {
    const u = new URL(tab.url || '');
    if (!/^https?:$/.test(u.protocol)) return null;
    return { pattern: `${u.protocol}//${u.hostname}/*`, host: u.hostname };
  } catch { return null; }
}

// ---------------------------------------------------------------- main flow
export async function startCapture(tab, overrides = {}) {
  const tabId = tab.id;
  // A capture that is still stopping (restoring the page) finishes first; then this one starts.
  for (let prev; (prev = active.get(tabId)); ) {
    if (!prev.stopper.reason) return; // already capturing this tab
    await prev.settled;
  }
  const stopper = new Stopper();
  let settle;
  active.set(tabId, { stopper, settled: new Promise(r => (settle = r)) });
  syncStopMenus();
  report(tabId, { stage: 'capturing', pct: 0 });
  let shooter = null;
  let injected = false;
  let cancelled = false;
  try {
    const settings = { ...(await getSettings()), ...overrides };
    stopper.throwIfCancelled();
    try {
      await retryTransient(() => chrome.scripting.executeScript({ target: { tabId }, files: ['agent.js'] }), stopper);
      injected = true;
    } catch (e) {
      injected = false; // restricted page (chrome://, Web Store, PDF viewer…)
    }
    stopper.throwIfCancelled();

    let result;
    if (!injected || settings.visibleOnly) {
      result = await captureVisibleOnly(tab, settings, injected, stopper);
    } else {
      result = await captureFull(tab, settings, s => (shooter = s), stopper);
    }
    stopper.throwIfCancelled();
    stopper.committed = true; // from here on the capture is saved; stopping is ignored
    syncStopMenus();
    const { hiResUsed, hiResNote: note, ...capture } = result;
    const hiResNote = settings.hiRes && !injected && !settings.visibleOnly ? 'Chrome does not allow high-resolution capture of this page.' : note;
    const thumb = await makeThumb(capture.tiles[0]);
    const rec = {
      id: crypto.randomUUID(),
      url: tab.url || result.url || '',
      title: result.title || tab.title || '',
      createdAt: Date.now(),
      ...capture,
      thumb,
      capturedWith: {
        hiRes: !!hiResUsed, removeBackgrounds: !!settings.removeBackgrounds,
        ...(hiResNote ? { hiResNote } : {}),
        mode: result.mode, truncated: !!result.truncated, stoppedEarly: !!result.stoppedEarly,
      },
    };
    await putCapture(rec);
    if (settings.autoDownload && settings.autoDownload !== 'none') {
      await autoDownload(rec, settings);
    } else {
      await openViewer(rec.id, tab);
    }
    // Report "done" only now: the popup closes on it, so a failure to open the viewer or to
    // download must still reach the popup as an error instead of failing silently.
    report(tabId, { stage: 'done', pct: 1, id: rec.id });
    return rec.id;
  } catch (e) {
    // Errors caused by the cancellation itself, or by the tab being closed, are not failures.
    if (e instanceof CaptureCancelled || stopper.cancelled || (!stopper.committed && !(await chrome.tabs.get(tabId).catch(() => null)))) {
      cancelled = true;
      return null;
    }
    console.error('Capture failed', e);
    const access = needsSiteAccess(e, tab);
    report(tabId, access
      ? { stage: 'error', error: `Chrome didn’t allow PageToPDF to capture ${access.host} this time. Allow it on this site and try again.`, needsAccess: access.pattern, host: access.host }
      : { stage: 'error', error: String(e.message || e) });
    setTimeout(() => chrome.action.setBadgeText({ text: '', tabId }).catch(() => {}), 6000);
    throw e;
  } finally {
    if (shooter) await shooter.detach();
    if (injected) { try { await agent(tabId, 'restore'); } catch { /* ignore */ } }
    if (cancelled) report(tabId, { stage: 'cancelled' }); // only once the page is restored
    active.delete(tabId);
    settle();
    syncStopMenus();
    setTimeout(() => { if (running.get(tabId)?.stage !== 'capturing') running.delete(tabId); }, 30000);
  }
}

async function captureVisibleOnly(tab, settings, injected, stopper) {
  // Captures exactly what is on screen at the user's current scroll position. The agent
  // (when it could be injected) leaves the page where it is and only collects the text,
  // links and media in the viewport; on restricted pages we just take the pixels.
  let collected = { vw: tab.width, vh: tab.height, text: [], links: [], media: [], blocks: [] };
  let shooter = null, hiResNote = null, visibleFallback = false;
  try {
    if (injected) {
      const m = await agent(tab.id, 'prepare', {
        ...settings, keepScroll: true, adjustRepeating: false, advancedScrolling: false, preScroll: false,
      });
      if (settings.hiRes) {
        // Same CSS viewport, higher device scale factor: layout and scroll position don't change.
        // The window's real viewport (incl. scrollbar), read before the debugging bar shrinks it.
        const [{ result: size }] = await retryTransient(() => chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => [innerWidth, innerHeight] }), stopper);
        shooter = new DebuggerShooter(tab.id);
        try {
          await shooter.attach(size[0], size[1], Number(settings.hiResScale) || 2);
        } catch (e) {
          await shooter.detach(); shooter = null; // e.g. the page doesn't allow debugging
          console.warn('Hi-res visible capture unavailable, using a normal screenshot', e);
          hiResNote = e instanceof HiResUnavailable ? e.message : 'High resolution was not available for this page.';
        }
      }
      collected = await agent(tab.id, 'frame', { phase: 'only', delay: 0 });
    }
    stopper.throwIfCancelled(); // 'keep' just lets this single-frame capture finish
    const cssWidth = collected.vw || tab.width;
    let bmp;
    // Chrome occasionally returns a screenshot shorter than the viewport (e.g. while an
    // infobar animates): try again a few times before settling for it.
    for (let attempt = 0; ; attempt++) {
      let blob;
      if (shooter) blob = await shooter.grab();
      else {
        try { blob = await grabVisible(tab, stopper); } catch (e) {
          if (!(e instanceof ScreenshotRefused) || !injected) throw e;
          const [{ result: dpr }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => devicePixelRatio });
          shooter = await screenshotFallback(tab.id, dpr || 1, e.message, stopper);
          visibleFallback = true;
          blob = await shooter.grab();
        }
      }
      bmp = await createImageBitmap(blob);
      const short = cssWidth && collected.vh && bmp.height / (bmp.width / cssWidth) < collected.vh - 1;
      if (!short || attempt >= 3) break;
      bmp.close();
    }
    const width = bmp.width, height = bmp.height; // read before close(): a closed bitmap reports 0×0
    const vw = cssWidth || width;
    const scale = width / vw;
    const st = new Stitcher(width, scale);
    st.draw(bmp, { viewportWidth: vw, list: [{ sx: 0, sy: 0, sw: vw, sh: height / scale, dx: 0, dy: 0 }] });
    bmp.close();
    const out = await st.finish(height / scale);
    return {
      mode: 'visible', scale, width, height: out.height, cssWidth: vw, cssHeight: out.height / scale,
      hiResUsed: !!shooter && !visibleFallback, hiResNote: visibleFallback ? FALLBACK_NOTE : hiResNote,
      tiles: out.tiles, tileHeight: out.tileHeight,
      text: collected.text || [], links: collected.links || [], media: collected.media || [], blocks: collected.blocks || [],
    };
  } finally {
    if (shooter) await shooter.detach();
  }
}

async function captureFull(tab, settings, setShooter, stopper) {
  const tabId = tab.id;
  report(tabId, { stage: 'capturing', pct: 0, step: 'Preparing the page…' });
  let m = await agent(tabId, 'prepare', settings);
  report(tabId, { stage: 'capturing', pct: 0, step: 'Capturing page…' });
  stopper.throwIfCancelled();
  let shooter = null, hiResNote = null;
  if (settings.hiRes) {
    const want = Number(settings.hiResScale) || 2;
    // Very wide pages at 3-4x would exceed canvas/GPU limits: lower the scale instead of failing.
    const scale = Math.max(1, Math.min(want, Math.floor(HIRES_MAX_WIDTH / Math.max(m.docW, m.vw, 1))));
    if (scale < want) hiResNote = `Scale reduced to ${scale}× because the page is very wide.`;
    // The window's real viewport (incl. scrollbar), read before attaching: the debugging
    // bar Chrome shows on attach shrinks it, and the override must keep the old size.
    const [{ result: size }] = await retryTransient(() => chrome.scripting.executeScript({ target: { tabId }, func: () => [innerWidth, innerHeight] }), stopper);
    shooter = new DebuggerShooter(tabId);
    setShooter(shooter);
    try {
      await shooter.attach(size[0], size[1], scale);
    } catch (e) {
      await shooter.detach();
      shooter = null; setShooter(null);
      if (!(e instanceof HiResUnavailable)) throw e;
      // Nothing was captured yet, so fall back to a normal capture rather than failing:
      // the user still gets their page and the viewer says why it is not hi-res.
      console.warn('PageToPDF: falling back to normal resolution:', e.message);
      hiResNote = e.message;
    }
    stopper.throwIfCancelled();
    m = await agent(tabId, 'measure');
  }
  const grab = async () => {
    if (shooter) return shooter.grab();
    try {
      return await grabVisible(tab, stopper);
    } catch (e) {
      if (!(e instanceof ScreenshotRefused)) throw e;
      // Keep the pixel density of the frames already stitched (or the page's own).
      shooter = await screenshotFallback(tabId, stitcher ? stitcher.scale : (m.dpr || 1), e.message, stopper);
      setShooter(shooter); fallbackUsed = true;
      return shooter.grab();
    }
  };
  let fallbackUsed = false;
  // Checked between rows: true when the user asked to stop and keep what has been captured.
  // With nothing captured yet there is nothing to keep, so that becomes a cancel.
  let stitcher = null;
  const stopHere = () => {
    if (stopper.reason === 'keep' && !stitcher) stopper.stop('cancel');
    stopper.throwIfCancelled();
    return stopper.reason === 'keep';
  };
  let stoppedEarly = false;
  const cap = Math.max(1000, Number(settings.maxHeight) || 60000);
  const delay = Math.max(0, Number(settings.scrollDelay) || 0);

  const text = new Map(), links = new Map(), media = new Map(), blocks = new Map();
  const addAll = (map, arr, keyFn) => { for (const it of arr || []) { const k = keyFn(it); if (!map.has(k)) map.set(k, it); } };
  let docW = m.docW, docH = Math.min(m.docH, cap);
  // Never stitch wider than a canvas can hold (also bounds the number of side-by-side shots).
  const estScale = shooter ? (Number(settings.hiResScale) || 2) : (m.dpr || 1);
  let widthNote = null;
  if (docW * estScale > HIRES_MAX_WIDTH) {
    docW = Math.max(m.vw, Math.floor(HIRES_MAX_WIDTH / estScale));
    widthNote = `This page is extremely wide; only the left ${docW} px were captured.`;
  }
  let truncated = m.docH > cap;
  let frames = 0;
  let prevReached = null;
  let endChecks = 0;

  const step = m.mode === 'element' ? m.el.h : m.vh;
  const maxScroll = () => (m.mode === 'element' ? m.maxScroll : docH - m.vh);
  const wide = m.mode === 'window' && docW > m.vw + 4;

  for (let y = 0; ; ) {
    if (stopHere()) { stoppedEarly = true; break; }
    let isLastRow = y + step >= (m.mode === 'element' ? m.maxScroll + step : docH) - 1;
    // Infinite feeds append content once the bottom is reached. Before taking what
    // looks like the last frame, scroll there and wait to see whether the page grows.
    while (isLastRow && y > 0 && m.mode === 'window' && docH < cap && endChecks++ < 30) {
      if (stopper.reason) break;
      const probe = await agent(tabId, 'probe', { y, wait: 900 });
      if (stopHere()) break;
      if (probe.docH <= docH + 4) break;
      docH = Math.min(probe.docH, cap); truncated = probe.docH > cap;
      isLastRow = y + step >= docH - 1;
    }
    if (stopHere()) { stoppedEarly = true; break; }
    const xs = [];
    if (wide) for (let x = 0; x < docW; x += m.vw) xs.push(x); else xs.push(0);
    let res;
    let shortBy = 0;
    // On pages wider than the window a row takes several screenshots. If the page changes
    // height in the middle of a row (lazy feeds), the shots won't match: redo the row.
    for (let attempt = 0; ; attempt++) {
    let rowDocH = null, rowChanged = false;
    for (const x of xs) {
      const phase = y === 0 && isLastRow ? 'only' : y === 0 ? 'first' : isLastRow ? 'last' : 'middle';
      stopper.throwIfCancelled(); // a started row is always finished when stopping with 'keep'
      res = await agent(tabId, 'frame', { x, y, phase, delay });
      stopper.throwIfCancelled();
      const blob = await grab();
      stopper.throwIfCancelled();
      const bmp = await createImageBitmap(blob);
      // Chrome occasionally returns a screenshot shorter than the viewport (e.g. while an
      // infobar animates). Only trust the rows we actually got and step by those.
      const effVh = bmp.height / (bmp.width / res.vw);
      if (effVh < res.vh - 1) {
        res.regions = res.regions
          .map(g => ({ ...g, sh: Math.min(g.sh, effVh - g.sy) }))
          .filter(g => g.sh > 0);
        shortBy = Math.max(shortBy, Math.ceil(res.vh - effVh));
      }
      if (!stitcher) {
        const scale = bmp.width / res.vw;
        stitcher = new Stitcher(Math.round(Math.max(docW, res.vw) * scale), scale);
        stitcher.cssWidth = Math.max(docW, res.vw);
      }
      if (globalThis.ptpDebug) (globalThis.ptpFrameLog ||= []).push({ y, scrollY: res.scrollY, vw: res.vw, vh: res.vh, bw: bmp.width, bh: bmp.height, regions: res.regions });
      stitcher.draw(bmp, { viewportWidth: res.vw, list: res.regions });
      bmp.close();
      frames++;
      addAll(text, res.text, t => `${t.t}|${Math.round(t.x)}|${Math.round(t.y)}`);
      addAll(links, res.links, l => `${l.href}|${Math.round(l.x)}|${Math.round(l.y)}`);
      addAll(media, res.media, r => `${Math.round(r.x)}|${Math.round(r.y)}|${Math.round(r.w)}`);
      addAll(blocks, res.blocks, b => `${b.kind}|${Math.round(b.x)}|${Math.round(b.y)}|${Math.round(b.w)}`);
      await stitcher.flushAbove(Math.min(...res.regions.map(g => g.dy)));
      if (rowDocH !== null && Math.abs(res.docH - rowDocH) > 4) rowChanged = true;
      rowDocH = res.docH;
    }
    if (!rowChanged || attempt >= 2) break;
    // Forget what this row collected; the retry re-collects it from consistent frames.
    const y0 = res.scrollY, y1 = res.scrollY + res.vh;
    for (const map of [text, links, media]) for (const [k, it] of map) if (it.y + it.h > y0 && it.y < y1) map.delete(k);
    // Blocks are only collected in the frame showing their top edge, so purge by top.
    for (const [k, it] of blocks) if (it.y >= y0 && it.y < y1) blocks.delete(k);
    }
    // The page may have grown (lazy loading / infinite scroll).
    if (res.mode === 'window') {
      if (res.docH > docH && docH < cap) { docH = Math.min(res.docH, cap); truncated = res.docH > cap; }
    } else {
      m.maxScroll = Math.max(m.maxScroll, res.maxScroll);
      docH = Math.min(res.vh + m.maxScroll, cap);
      truncated = res.vh + m.maxScroll > cap;
    }
    const reached = res.scrollY;
    report(tabId, { stage: 'capturing', pct: Math.min(0.97, (reached + step) / docH), step: running.get(tabId)?.step });
    if (frames > 2000) break;
    // Continue from where the page actually scrolled to (sites may snap or round the
    // position), otherwise a 1px seam can be left between frames. If the screenshot came
    // back short, step by what was really captured.
    // Never loop on a page that refuses to scroll further.
    if (prevReached !== null && reached <= prevReached + 0.5) break;
    prevReached = reached;
    const nextY = Math.min(Math.floor(reached) + step - shortBy, Math.max(0, maxScroll()));
    const atEnd = isLastRow || reached + step >= docH - 1;
    // Stop at the end of the page, and always stop if scrolling can't make progress.
    if ((atEnd && !shortBy) || nextY <= Math.floor(reached)) break;
    y = nextY;
  }

  stopper.throwIfCancelled();
  report(tabId, { stage: 'capturing', pct: 0.98, step: 'Stitching…' });
  // Stopped early: keep everything down to the last captured row.
  const lastY = stoppedEarly ? stitcher.maxY / stitcher.scale : m.mode === 'element' ? m.vh + (m.maxScroll) : docH;
  const cssHeight = Math.min(lastY, cap);
  const out = await stitcher.finish(cssHeight);
  stopper.throwIfCancelled();
  const cssWidth = stitcher.cssWidth;
  const inside = it => it.y < cssHeight && it.y + it.h > 0;
  return {
    mode: m.mode, scale: stitcher.scale, width: stitcher.width, height: out.height,
    cssWidth, cssHeight: out.height / stitcher.scale, hiResUsed: !!shooter && !fallbackUsed, hiResNote: [fallbackUsed ? FALLBACK_NOTE : hiResNote, widthNote].filter(Boolean).join(' ') || null,
    tiles: out.tiles, tileHeight: out.tileHeight, truncated: truncated && !stoppedEarly, stoppedEarly, gaps: out.gaps,
    text: [...text.values()].filter(inside),
    links: [...links.values()].filter(inside),
    media: [...media.values()].filter(inside),
    blocks: [...blocks.values()].filter(inside),
  };
}

// Open the viewer next to the captured tab. If Chrome refuses (the tab was closed or moved
// to another window meanwhile), open it as a plain new tab rather than losing the capture.
async function openViewer(id, tab) {
  const url = `pages/result.html?id=${id}`;
  try {
    await retryTransient(() => chrome.tabs.create({ url, index: tab.index + 1, openerTabId: tab.id, windowId: tab.windowId }));
  } catch (e) {
    console.warn('Could not open the viewer next to the page; opening it in a new tab', e);
    await retryTransient(() => chrome.tabs.create({ url }));
  }
}

// ---------------------------------------------------------------- auto download
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'pages/offscreen.html', reasons: ['BLOBS'],
      justification: 'Encode screenshots / PDFs into downloadable blob URLs',
    });
  } catch (e) {
    // Another export may have created it concurrently.
    if (!(await chrome.offscreen.hasDocument())) throw e;
  }
}

async function autoDownload(rec, settings) {
  await ensureOffscreen();
  const fmt = settings.autoDownload;
  const res = await chrome.runtime.sendMessage({ type: 'offscreen-export', id: rec.id, format: fmt, settings });
  if (!res || res.error) throw new Error(res?.error || 'Export failed');
  for (const f of res.files) {
    await chrome.downloads.download({ url: f.url, filename: buildFilename(settings.filenameTemplate, rec, f.ext, settings.directory).replace(/(\.\w+)$/, (f.suffix || '') + '$1'), saveAs: false });
  }
  setTimeout(() => chrome.runtime.sendMessage({ type: 'offscreen-revoke', urls: res.files.map(f => f.url) }).catch(() => {}), 60000);
}

// Test hook (used by the automated test-suite through the service worker).
globalThis.ptpCapture = (tabId, overrides) => chrome.tabs.get(tabId).then(t => startCapture(t, overrides));
globalThis.ptpStop = (tabId, reason) => stopCapture(tabId, reason);
globalThis.ptpStatus = tabId => running.get(tabId) || null;
