"""Inspect PDFs produced by run.mjs: page count, text layer, links, rendered previews."""
import sys, glob, os, json, pymupdf
out = os.path.join(os.path.dirname(__file__), 'out')
names = sys.argv[1:] or [os.path.basename(p)[:-4] for p in sorted(glob.glob(f'{out}/*.pdf'))]
for n in names:
    doc = pymupdf.open(f'{out}/{n}.pdf')
    words = sum(len(p.get_text('words')) for p in doc)
    links = sum(len(p.get_links()) for p in doc)
    # Words whose box touches the top/bottom edge of the image area = likely cut lines.
    cut = 0
    for p in doc:
        imgs = p.get_image_info()
        if not imgs: continue
        b = imgs[0]['bbox']
        for w in p.get_text('words'):
            if (w[1] < b[1] - 1 < w[3] - 2) or (w[1] + 2 < b[3] + 1 < w[3]): cut += 1
    print(f'{n:22s} pages={len(doc):3d} size={doc[0].rect.width:.0f}x{doc[0].rect.height:.0f} words={words:6d} links={links:4d} cutWords={cut} bytes={os.path.getsize(f"{out}/{n}.pdf"):,}')
    print('   p1:', ' '.join(doc[0].get_text().split())[:200])
    os.makedirs(f'{out}/render', exist_ok=True)
    for i in range(min(len(doc), 3)):
        doc[i].get_pixmap(dpi=60).save(f'{out}/render/{n}-p{i+1}.png')
