// Offscreen document: runs exports for the auto-download feature (service workers can't
// create blob URLs).
import { getCapture } from '../lib/db.js';
import { exportImage, exportPDF } from '../lib/export.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'offscreen-export') {
    (async () => {
      const rec = await getCapture(msg.id);
      const s = msg.settings; // offscreen documents only get chrome.runtime, so settings come with the message
      const files = msg.format === 'pdf'
        ? [{ blob: await exportPDF(rec, s), ext: 'pdf', suffix: '' }]
        : await exportImage(rec, msg.format, s.jpgQuality);
      return { files: files.map(f => ({ url: URL.createObjectURL(f.blob), ext: f.ext, suffix: f.suffix })) };
    })().then(sendResponse, e => sendResponse({ error: String(e.message || e) }));
    return true;
  }
  if (msg.type === 'offscreen-revoke') { for (const u of msg.urls) URL.revokeObjectURL(u); }
});
