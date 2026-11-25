// Central definition of user settings and their defaults.
export const PAPER_SIZES = {
  // width x height in PDF points (1/72 inch), portrait.
  letter: { label: 'Letter (8.5 × 11 in)', w: 612, h: 792 },
  legal: { label: 'Legal (8.5 × 14 in)', w: 612, h: 1008 },
  tabloid: { label: 'Tabloid (11 × 17 in)', w: 792, h: 1224 },
  a3: { label: 'A3 (297 × 420 mm)', w: 841.89, h: 1190.55 },
  a4: { label: 'A4 (210 × 297 mm)', w: 595.28, h: 841.89 },
  a5: { label: 'A5 (148 × 210 mm)', w: 419.53, h: 595.28 },
  fit: { label: 'Fit to image (one long page)', w: 0, h: 0 },
};

export const DEFAULTS = {
  // Capture
  hiRes: false,            // use the debugger API to render at a higher device scale factor
  hiResScale: 2,           // device scale factor used in hi-res mode
  removeBackgrounds: false,
  darkenLightText: true,   // when removing backgrounds, make light text dark so it stays readable
  keepBackgroundImages: true, // when removing backgrounds, keep url() images (only drop colors/gradients)
  adjustRepeating: true,   // fixed/sticky elements are shown once instead of in every frame
  hideScrollbars: true,
  advancedScrolling: true, // scroll inner scrollable elements when the page itself does not scroll
  scrollDelay: 150,        // ms to wait after each scroll before capturing
  preScroll: false,        // scroll through the page once first to trigger lazy loading
  maxHeight: 60000,        // CSS px cap for very long / infinite pages
  oneClick: false,         // toolbar button captures immediately (no popup)
  toolbarIcon: 'black',    // black | white (Chrome doesn't expose the toolbar colour)

  // Output
  imageFormat: 'png',      // png | jpg
  jpgQuality: 0.92,
  autoDownload: 'none',    // none | png | jpg | pdf
  saveAs: false,
  directory: '',
  filenameTemplate: 'screencapture-{url}-{date}-{time}',

  // PDF
  paperSize: 'letter',
  orientation: 'portrait', // portrait | landscape
  marginMm: 0,
  smartSplit: true,
  pdfHeader: false,        // title + capture date/time (off by default)
  pdfFooter: false,        // URL + page numbers (off by default)
  activeLinks: true,
  textLayer: true,         // searchable/selectable invisible text
  pdfImageQuality: 0.92,   // 1 = lossless (Flate), otherwise JPEG quality
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}
