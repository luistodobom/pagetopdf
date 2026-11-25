"""Check the redaction cases produced by run.mjs (node test/run.mjs --only=redact):
nothing under a redaction box may survive in any export.

  python3 test/check_redact.py [redact redact-crop]

PDF: no redacted word in the extracted text (plain and per-character), the metadata or the
decompressed file; no link annotation to a redacted URL; the page images are black under
every box. PNG/JPG exports and the stored thumbnail: black under every box.
"""
import sys, os, json, pymupdf

out = os.path.join(os.path.dirname(__file__), 'out')
names = sys.argv[1:] or ['redact', 'redact-crop']
failed = False


def report(ok, msg):
    global failed
    failed |= not ok
    print(('  ok   ' if ok else '  FAIL ') + msg)


def max_in(pix, x0, y0, x1, y1):
    """Max channel value of pix inside the device rect [x0, x1) x [y0, y1)."""
    n, best = pix.n, 0
    s = pix.samples
    for y in range(max(0, y0), min(pix.height, y1)):
        row = y * pix.stride
        for x in range(max(0, x0), min(pix.width, x1)):
            i = row + x * n
            v = max(s[i], s[i + 1], s[i + 2])
            if v > best: best = v
    return best


def box_check(label, pix, pieces, k, tol, inset=0):
    worst = 0
    for p in pieces:
        x0, y0 = int(p['x'] * k) + inset, int(p['y'] * k) + inset
        x1, y1 = int(-(-(p['x'] + p['w']) * k // 1)) - inset, int(-(-(p['y'] + p['h']) * k // 1)) - inset
        worst = max(worst, max_in(pix, x0, y0, x1, y1))
    report(worst <= tol, f'{label}: max channel under the boxes = {worst} (allowed {tol})')


def block_check(label, pix, pieces, k, tol, bands):
    """JPEG: every 16x16 MCU that lies entirely under a box must be black. MCUs straddling the
    box edge also hold the visible pixels next to the box, so they can ring a little; they
    cannot carry anything that was under the box (those pixels were black when encoded).
    bands: [(y0, y1)] of the separately encoded images (their MCU grids start at y0)."""
    worst, blocks = 0, 0
    for p in pieces:
        x0, y0 = p['x'] * k, p['y'] * k
        x1, y1 = (p['x'] + p['w']) * k, (p['y'] + p['h']) * k
        for b0, b1 in bands:
            by = b0 + -(-(max(y0, b0) - b0) // 16) * 16
            while by + 16 <= min(y1, b1):
                bx = -(-x0 // 16) * 16
                while bx + 16 <= x1:
                    worst = max(worst, max_in(pix, int(bx), int(by), int(bx) + 16, int(by) + 16)); blocks += 1
                    bx += 16
                by += 16
    report(worst <= tol, f'{label}: max channel in the {blocks} JPEG blocks fully under the boxes = {worst} (allowed {tol})')


for n in names:
    print(n)
    meta = json.load(open(f'{out}/{n}.redact.json'))
    edit = json.load(open(f'{out}/{n}.edit.json'))
    exp, pieces, scale = meta['expect'], meta['pieces'], meta['scale']
    doc = pymupdf.open(f'{out}/{n}.pdf')

    # ---- text layer + visible header/footer text
    plain = '\n'.join(p.get_text() for p in doc)
    raw = ''
    for p in doc:
        for b in p.get_text('rawdict')['blocks']:
            for l in b.get('lines', []):
                for s in l['spans']:
                    raw += ''.join(c['c'] for c in s['chars']) + ' '
    words = ' '.join(w[4] for p in doc for w in p.get_text('words'))
    for label, txt in (('get_text()', plain), ("get_text('rawdict')", raw)):
        leaked = [w for w in exp['gone'] if w.lower() in txt.lower()]
        missing = [w for w in exp['kept'] if w not in txt]
        report(not leaked, f'{label}: redacted words absent' + (f' -- LEAKED {leaked}' if leaked else ''))
        report(not missing, f'{label}: words around the boxes kept' + (f' -- MISSING {missing}' if missing else ''))
    pb = [w for w in words.split() if w.startswith('left') or w.startswith('right') or 'INQX' in w or 'NQX' in w or w.endswith('QX')]
    print('       words left of/right of the partial box in run (b):', pb)

    # ---- metadata and the whole decompressed file
    md = ' '.join(str(v) for v in doc.metadata.values() if v)
    leaked = [w for w in exp['goneMeta'] if w.lower() in md.lower()]
    report(not leaked, f'metadata free of redacted words ({md[:90]!r})')
    blob = doc.tobytes(expand=255).decode('latin1')
    leaked = [w for w in exp['gone'] + exp['goneUrls'] if w in blob]
    report(not leaked, 'decompressed PDF bytes free of redacted words / URLs' + (f' -- LEAKED {leaked}' if leaked else ''))

    # ---- links
    uris = [l.get('uri', '') for p in doc for l in p.get_links()]
    bad = [u for u in uris if any(g in u for g in exp['goneUrls'])]
    report(not bad, f'link annotations: {len(uris)}, none to a redacted URL' + (f' -- LEAKED {bad}' if bad else ''))
    missing = [u for u in exp['keptUrls'] if u not in uris]
    report(not missing, 'unredacted link kept' + (f' -- MISSING {missing}' if missing else ''))

    # ---- PDF page images, stacked = the output canvas
    imgs = []
    for p in doc:
        for im in p.get_images(full=True):
            imgs.append(pymupdf.Pixmap(doc, im[0]))
    report(len(imgs) == len(doc), f'one image per page ({len(imgs)} images, {len(doc)} pages)')
    W, H = imgs[0].width, sum(i.height for i in imgs)
    stack = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, W, H), False)
    y, bands = 0, []
    for im in imgs:
        if im.n != 3 or im.alpha: im = pymupdf.Pixmap(pymupdf.csRGB, im)
        im.set_origin(0, y); stack.copy(im, im.irect); bands.append((y, y + im.height)); y += im.height
    stack.save(f'{out}/{n}-pdf-images.png')
    # JPEG (default quality) may ring a few levels near the box edges; the interior must be black.
    box_check('PDF images (JPEG), edges', stack, pieces, scale, 48)
    block_check('PDF images (JPEG)', stack, pieces, scale, 2, bands)

    # ---- PNG / JPG exports
    png = pymupdf.Pixmap(f'{out}/{n}.png')
    box_check('PNG export', png, pieces, scale, 0)
    jpg = pymupdf.Pixmap(f'{out}/{n}.jpg')
    box_check('JPG export, edges', jpg, pieces, scale, 48)
    block_check('JPG export', jpg, pieces, scale, 2, [(0, jpg.height)])

    # ---- thumbnail (original space, 480 px wide, top of the capture)
    if os.path.exists(f'{out}/{n}-thumb.jpg'):
        th = pymupdf.Pixmap(f'{out}/{n}-thumb.jpg')
        reds = [s for s in edit['edits']['shapes'] if s['type'] == 'redact']
        k = th.width / meta['cssWidth']  # drawn from the uncropped capture
        box_check('thumbnail, 2px inside', th, [r for r in reds if r['y'] * k < th.height], k, 40, inset=2)
        print('       thumbKey:', meta.get('thumbKey'))

    # ---- renders to look at
    os.makedirs(f'{out}/render', exist_ok=True)
    for i in range(min(len(doc), 2)):
        doc[i].get_pixmap(dpi=110).save(f'{out}/render/{n}-p{i + 1}.png')

print('FAILED' if failed else 'all redaction checks passed')
sys.exit(1 if failed else 0)
