// Incrementally stitches captured frames into fixed-height tiles using
// OffscreenCanvas. Frames arrive top-to-bottom, so a tile can be encoded to a
// PNG Blob (and its pixels freed) as soon as no future frame can touch it.
export const TILE_HEIGHT = 4096;

export class Stitcher {
  constructor(width, scale) {
    this.width = width;          // device px
    this.scale = scale;          // device px per CSS px
    this.tiles = new Map();      // index -> OffscreenCanvas
    this.done = new Map();       // index -> Blob
    this.maxY = 0;
    this.covered = new Uint8Array(0); // per device row: did any frame draw it?
  }

  markRows(a, b) {
    if (b > this.covered.length) {
      const n = new Uint8Array(Math.max(b, this.covered.length * 2));
      n.set(this.covered); this.covered = n;
    }
    this.covered.fill(1, Math.max(0, a), b);
  }

  // Rows inside [0, height) that no frame covered (should be 0; >0 means a seam).
  gaps(height) {
    let n = 0;
    for (let y = 0; y < height; y++) if (!this.covered[y]) n++;
    return n;
  }

  tile(i) {
    let c = this.tiles.get(i);
    if (!c) {
      c = new OffscreenCanvas(this.width, TILE_HEIGHT);
      this.tiles.set(i, c);
    }
    return c;
  }

  // regions are in CSS px: source rect within the viewport, destination in the document.
  draw(bitmap, regions) {
    const k = bitmap.width / regions.viewportWidth; // actual device scale of this frame
    for (const g of regions.list) {
      const sx = Math.round(g.sx * k), sy = Math.round(g.sy * k);
      const sw = Math.min(bitmap.width - sx, Math.round(g.sw * k));
      const sh = Math.min(bitmap.height - sy, Math.round(g.sh * k));
      const dx = Math.round(g.dx * this.scale), dy = Math.round(g.dy * this.scale);
      const dw = Math.round(sw * this.scale / k), dh = Math.round(sh * this.scale / k);
      if (sw <= 0 || sh <= 0) continue;
      const first = Math.floor(dy / TILE_HEIGHT), last = Math.floor((dy + dh - 1) / TILE_HEIGHT);
      for (let i = first; i <= last; i++) {
        if (this.done.has(i)) continue;
        const ctx = this.tile(i).getContext('2d');
        ctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy - i * TILE_HEIGHT, dw, dh);
      }
      this.markRows(dy, dy + dh);
      this.maxY = Math.max(this.maxY, dy + dh);
    }
  }

  // Areas no frame covered (e.g. beside an inner scroller) become the page colour, not transparent.
  static fillBlank(c) {
    const ctx = c.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.restore();
  }

  // Every tile entirely above `cssY` is final.
  async flushAbove(cssY) {
    const limit = Math.floor((cssY * this.scale) / TILE_HEIGHT);
    for (const [i, c] of [...this.tiles]) {
      if (i < limit) {
        Stitcher.fillBlank(c);
        this.done.set(i, await c.convertToBlob({ type: 'image/png' }));
        this.tiles.delete(i);
      }
    }
  }

  async finish(totalCssHeight) {
    const H = Math.min(this.maxY, Math.round(totalCssHeight * this.scale));
    if (!(H > 0) || !(this.width > 0)) throw new Error('Nothing could be captured from this page (every screenshot came back empty).');
    const count = Math.max(1, Math.ceil(H / TILE_HEIGHT));
    const blobs = [];
    for (let i = 0; i < count; i++) {
      if (this.done.has(i)) { blobs.push(this.done.get(i)); continue; }
      const c = this.tile(i);
      const h = Math.min(TILE_HEIGHT, H - i * TILE_HEIGHT);
      Stitcher.fillBlank(c);
      let out = c;
      if (h !== TILE_HEIGHT) {
        out = new OffscreenCanvas(this.width, h);
        out.getContext('2d').drawImage(c, 0, 0);
      }
      blobs.push(await out.convertToBlob({ type: 'image/png' }));
      this.tiles.delete(i);
    }
    this.tiles.clear();
    return { tiles: blobs, height: H, tileHeight: TILE_HEIGHT, gaps: this.gaps(H) };
  }
}

export async function makeThumb(blob, width = 480) {
  const bmp = await createImageBitmap(blob);
  const h = Math.min(Math.round(bmp.height * width / bmp.width), width * 1.6);
  const c = new OffscreenCanvas(width, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, h);
  ctx.drawImage(bmp, 0, 0, bmp.width, h * bmp.width / width, 0, 0, width, h);
  bmp.close();
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}
