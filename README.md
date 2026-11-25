# PageToPDF

A free, open-source Chrome extension that captures an **entire web page** by scrolling, screenshotting and stitching it together. You can save it as a PNG/JPG, or as a **searchable PDF** that keeps the real text, clickable links and clean page breaks. Unlike *Print → Save as PDF*, the result looks exactly like the page on screen.

It's an open replacement for GoFullPage, with everything that tool charges for included free, plus a few new features.

| | GoFullPage (free) | GoFullPage Premium | **PageToPDF** |
|---|:-:|:-:|:-:|
| Full-page capture, PNG/JPG/PDF export | ✓ | ✓ | ✓ |
| Repeating sticky/fixed elements shown once | ✓ | ✓ | ✓ (headers on first screen, footers/cookie bars on last) |
| Inner scrollable elements ("advanced scrolling") | ✓ | ✓ | ✓ |
| Active links in PDF | ✓ | ✓ | ✓ |
| **Smart page splitting** | – | ✓ | ✓ uses the page's text layout *and* pixel analysis, never cuts a line of text |
| **URL + date/time on PDF** | – | ✓ | ✓ title/date header, clickable URL + page-number footer |
| **Draw** (shapes, arrows, text, highlight, redact) and **Crop** (keep an area, cut out rows or columns) | – | ✓ | ✓ non-destructive and auto-saved |
| **Searchable / selectable text layer in PDF** | – | – | ✓ invisible Unicode text aligned to the screenshot |
| **High-resolution capture** (2×/3×/4×) | – | – | ✓ via the DevTools protocol, also faster (no capture rate limit) |
| **Remove backgrounds** (ink-friendly) | – | – | ✓ temporarily restyles the page, then restores it |
| Redaction removes what is underneath (text layer, links, pixels) from every export, like Preview | – | – | ✓ |
| Page-break preview in the viewer | – | – | ✓ |

## Install (developer mode)

1. Clone this repository.
2. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**.
3. Select the `extension/` folder.

Capture with the toolbar button, the right-click menu, or **Alt+Shift+P**.

### Incognito windows

Like every Chrome extension, PageToPDF does nothing in incognito windows until you allow it: its toolbar button, right-click menu and shortcut simply aren't there. To use it in incognito, open `chrome://extensions`, click **Details** under PageToPDF and turn on **Allow in Incognito**.

The extension runs in *split* incognito mode. Captures taken in an incognito window are stored only in that incognito session and are deleted when you close the last incognito window. They never appear in your regular profile's capture list, and regular captures don't appear in incognito. Settings are shared between the two.

## How it works

- **`extension/agent.js`** is injected into the page. It scrolls the page (or the inner scrolling element), hides fixed and sticky elements after the first screen, and optionally removes backgrounds. For every frame it also records the position of each visible line of text, each link and each image. Every change it makes is undone afterwards.
- **`extension/background.js`** takes the screenshots: `captureVisibleTab` normally, or in hi-res mode the DevTools protocol (`Emulation.setDeviceMetricsOverride` + `Page.captureScreenshot`). `lib/stitcher.js` stitches frames into 4096-px PNG tiles stored in IndexedDB, so very long pages never need one giant canvas.
- **`extension/lib/pdf.js`** is a small PDF writer with no dependencies. Each page is one JPEG or Flate image with invisible text (a Type0/Identity-H font with a ToUnicode map, render mode 3, the same technique OCR tools use) sized to the original DOM text boxes, plus URI link annotations.
- **`extension/lib/export.js`** handles page splitting. When choosing where a page ends, it never cuts inside a text line, avoids cutting small images, and prefers the blankest rows of pixels near the paper-size boundary.

High resolution uses the `debugger` permission (granted at install; Chrome does not allow it as an optional permission). It is only used while a hi-res capture runs, and Chrome shows a “started debugging this browser” bar for that time. If Chrome refuses to debug a page, the capture falls back to normal resolution and the viewer says why. Captures stay in your browser (IndexedDB); nothing is uploaded.

## Development

```bash
npm install
npx playwright install chromium
node test/run.mjs           # captures local fixtures → test/out/*.pdf|png
node test/run.mjs --web     # also Wikipedia, GitHub, HN, MDN, X, a blog
python3 test/check.py       # page count, text layer, links, words cut by page breaks (needs pymupdf)
node test/ui.mjs            # UI screenshots (light/dark) + auto-download check
node test/cancel.mjs        # stop / cancel a capture in progress (+ popup Stop screenshots)
node test/incognito.mjs     # capture/viewer/export in an incognito window (--headed also checks downloads)
node test/hires.mjs         # hi-res capture with the shipped manifest: toggles, 2-4x, failure modes
node test/transient.mjs     # Chrome's transient "tabs cannot be edited" errors + page-restore watchdog
npm run package             # dist/pagetopdf.zip for the Chrome Web Store
```

## Limitations

- Browsers don't let extensions run on `chrome://` pages, the Chrome Web Store, or the built-in PDF viewer. On those pages only the visible area is captured.
- Text inside cross-origin iframes appears in the image but isn't added to the text layer.
- Infinite feeds stop at the *Maximum page height* setting (60,000 px by default).

## License

MIT
