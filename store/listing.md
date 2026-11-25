# Chrome Web Store submission text

## Store listing tab

**Category:** Tools (or Productivity › Tools)
**Language:** English

**Detailed description:**

PageToPDF captures an entire web page, not just what's on screen, by scrolling, screenshotting and stitching it together. Save the result as a PNG/JPG image, or as a searchable PDF that keeps the real text, clickable links and clean page breaks. Unlike Print → Save as PDF, the result looks exactly like the page you see.

Everything is free and open source. No account, no ads, no tracking: captures never leave your computer.

Features
• Full-page capture of long pages, including inner scrolling areas (web apps, chats, mail)
• Searchable, selectable text in the PDF, with working links
• Smart page splitting that never cuts a line of text in half, with a page-break preview
• Optional header and footer with page title, date, URL and page numbers
• High-resolution capture at 2×, 3× or 4×
• Remove backgrounds for ink-friendly printing
• Draw shapes, arrows, text and highlights; crop; redact (redaction also removes the hidden text and links underneath)
• Sticky headers, footers and cookie bars shown once instead of on every screen
• Capture history stored locally, with re-export to any format

How to use: click the toolbar button, use the right-click menu, or press Alt+Shift+P.

Source code, issues and feature requests: https://github.com/luistodobom/pagetopdf

**Homepage URL:** https://github.com/luistodobom/pagetopdf
**Support URL:** https://github.com/luistodobom/pagetopdf/issues

**Screenshots:** store/screenshots/1-popup.png … 4-dark.png (1280×800).
**Small promo tile (optional):** 440×280.

## Privacy practices tab

**Single purpose:**
PageToPDF captures the full length of the web page the user is viewing and saves it as an image (PNG/JPG) or a PDF.

**activeTab:**
Gives temporary access to the current tab when the user clicks the toolbar button, uses the context menu or presses the keyboard shortcut, so the extension can screenshot the page they asked to capture.

**scripting:**
Injects the capture script into the tab being captured. It scrolls the page, temporarily hides repeating sticky elements, records text and link positions for the searchable PDF, and restores the page afterwards.

**storage:**
Saves the user's settings (format, page size, header/footer options).

**unlimitedStorage:**
Captured pages are stored locally in IndexedDB as image tiles so users can reopen, annotate and re-export them. Long pages at high resolution can exceed the default storage quota.

**downloads:**
Saves the exported PNG, JPG or PDF file to the user's computer.

**contextMenus:**
Adds right-click menu items: capture full page, capture without backgrounds, capture in high resolution, capture visible area, and stop/cancel a running capture.

**offscreen:**
Uses an offscreen document to decode and stitch screenshot images and build the PDF, which a service worker cannot do on its own (it has no DOM or canvas image decoding).

**debugger:**
Used only for the optional high-resolution capture mode that the user picks themselves. The extension attaches to the tab being captured to call the DevTools protocol (Emulation.setDeviceMetricsOverride and Page.captureScreenshot), renders the page at 2×–4× pixel density and takes screenshots, then detaches as soon as the capture ends. It does not read network traffic, cookies or any other data from the debugger session.

**Host permission (optional `<all_urls>`):**
Optional and never requested at install. Chrome sometimes refuses the one-time activeTab grant (for example after the page navigates or reloads during a capture). In that case the user can allow the current site from the popup, or allow all sites from the options page, so captures keep working without a new click. The user can remove this access at any time on the options page.

**Remote code:** No, I am not using remote code. All JavaScript is included in the package.

**Data usage:** Check none of the data types. Certify all three disclosures:
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/luistodobom/pagetopdf/blob/main/PRIVACY.md
(Live once PRIVACY.md is pushed to main.)

## Distribution tab

**Visibility:** Public (or Unlisted to test first)
**Regions:** All regions
**Pricing:** Free
