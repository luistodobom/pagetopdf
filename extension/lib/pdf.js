// Minimal dependency-free PDF writer: JPEG/Flate images, an invisible Unicode
// text layer (Type0 / Identity-H font + ToUnicode CMap, render mode 3, the same
// trick OCR tools use), visible Helvetica header/footer text and URI links.

const enc = new TextEncoder();

// Unicode -> WinAnsiEncoding byte for the 0x80-0x9F range Helvetica supports.
const WIN_ANSI = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };

function pdfString(s) {
  // Literal string restricted to WinAnsi-ish single bytes (for Helvetica text).
  let out = '(';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c < 32) out += ' ';
    else if (c < 127) out += ch;
    else if (c >= 160 && c <= 255) out += '\\' + c.toString(8).padStart(3, '0');
    else if (WIN_ANSI[c]) out += '\\' + WIN_ANSI[c].toString(8);
    // other characters (emoji, CJK…) can't be drawn with the standard font: drop them
  }
  return out + ')';
}

function pdfTextString(s) {
  // Text string for metadata: UTF-16BE with BOM, hex encoded.
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0');
  return '<' + hex + '>';
}

function asciiString(s) {
  let out = '(';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch;
    else if (c < 32 || c > 126) out += encodeURIComponent(ch);
    else out += ch;
  }
  return out + ')';
}

const num = n => (Math.abs(n) < 1e-6 ? '0' : (Math.round(n * 1000) / 1000).toString());

function pdfDate(d) {
  const p = n => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`;
}

export class PDFWriter {
  constructor() {
    this.chunks = [];
    this.offset = 0;
    this.offsets = [];  // object number -> byte offset
    this.nextId = 1;
    this.pages = [];
    this.cidMap = new Map(); // unicode string (code point) -> CID
    this.catalogId = this.alloc();
    this.pagesId = this.alloc();
    this.helvId = this.alloc();
    this.textFontId = this.alloc(); // Type0, written at the end
    this.write('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  }

  alloc() { return this.nextId++; }

  write(data) {
    let bytes;
    if (typeof data === 'string') {
      // Strings are written as latin1 bytes (binary-safe for our own output).
      bytes = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
    } else bytes = data;
    this.chunks.push(bytes);
    this.offset += bytes.length;
  }

  obj(id, body) {
    this.offsets[id] = this.offset;
    this.write(`${id} 0 obj\n${body}\nendobj\n`);
  }

  stream(id, dict, bytes) {
    this.offsets[id] = this.offset;
    this.write(`${id} 0 obj\n<< ${dict} /Length ${bytes.length} >>\nstream\n`);
    this.write(bytes);
    this.write('\nendstream\nendobj\n');
  }

  // image: { kind: 'jpeg', bytes, width, height } | { kind: 'flate', bytes, width, height }
  addImage(img) {
    const id = this.alloc();
    const filter = img.kind === 'jpeg' ? '/DCTDecode' : '/FlateDecode';
    this.stream(id, `/Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter}`, img.bytes);
    return id;
  }

  cid(ch) {
    let id = this.cidMap.get(ch);
    if (!id) { id = this.cidMap.size + 1; this.cidMap.set(ch, id); }
    return id;
  }

  // Invisible text run fitted to the box (x, y = top-left in PDF points, page coordinates from top).
  invisibleText(page, str, x, yTop, w, h) {
    const chars = [...str];
    if (!chars.length || w <= 0 || h <= 0) return;
    let hex = '';
    for (const ch of chars) hex += this.cid(ch).toString(16).padStart(4, '0');
    const size = h;
    const tz = (100 * w) / (chars.length * size);
    const baseline = page.height - (yTop + h * 0.8);
    // Tr and Tz are graphics-state parameters, so scope them with q/Q.
    page.ops.push(`q BT /FT ${num(size)} Tf 3 Tr ${num(tz)} Tz 1 0 0 1 ${num(x)} ${num(baseline)} Tm <${hex}> Tj ET Q`);
    page.usesText = true;
  }

  visibleText(page, str, x, yTop, size, color = '0.35 0.35 0.35') {
    page.ops.push(`q BT /FH ${num(size)} Tf 0 Tr 100 Tz ${color} rg 1 0 0 1 ${num(x)} ${num(page.height - yTop - size * 0.8)} Tm ${pdfString(str)} Tj ET Q`);
    page.usesHelv = true;
  }

  link(page, uri, x, yTop, w, h) {
    page.annots.push(`<< /Type /Annot /Subtype /Link /Rect [${num(x)} ${num(page.height - yTop - h)} ${num(x + w)} ${num(page.height - yTop)}] /Border [0 0 0] /A << /S /URI /URI ${asciiString(uri)} >> >>`);
  }

  newPage(width, height) {
    const page = { width, height, ops: [], images: [], annots: [], id: this.alloc() };
    this.pages.push(page);
    return page;
  }

  drawImage(page, imageId, x, yTop, w, h) {
    const name = `Im${page.images.length}`;
    page.images.push([name, imageId]);
    page.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(page.height - yTop - h)} cm /${name} Do Q`);
  }

  async endPage(page) {
    const content = enc.encode(page.ops.join('\n'));
    const contentId = this.alloc();
    const compressed = await deflate(content);
    this.stream(contentId, '/Filter /FlateDecode', compressed);
    const xobj = page.images.map(([n, id]) => `/${n} ${id} 0 R`).join(' ');
    const fonts = [];
    if (page.usesHelv) fonts.push(`/FH ${this.helvId} 0 R`);
    if (page.usesText) fonts.push(`/FT ${this.textFontId} 0 R`);
    let annots = '';
    if (page.annots.length) {
      const ids = page.annots.map(a => { const id = this.alloc(); this.obj(id, a); return id; });
      annots = ` /Annots [${ids.map(i => `${i} 0 R`).join(' ')}]`;
    }
    this.obj(page.id, `<< /Type /Page /Parent ${this.pagesId} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Resources << /XObject << ${xobj} >> /Font << ${fonts.join(' ')} >> /ProcSet [/PDF /Text /ImageC] >> /Contents ${contentId} 0 R${annots} >>`);
    page.ops = null;
  }

  async finish(meta = {}) {
    // Fonts
    this.obj(this.helvId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const descId = this.alloc(), cidFontId = this.alloc(), toUniId = this.alloc();
    this.obj(descId, '<< /Type /FontDescriptor /FontName /PageToPDFGlyphless /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>');
    this.obj(cidFontId, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /PageToPDFGlyphless /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descId} 0 R /DW 1000 /CIDToGIDMap /Identity >>`);
    this.stream(toUniId, '/Filter /FlateDecode', await deflate(enc.encode(this.toUnicodeCMap())));
    this.obj(this.textFontId, `<< /Type /Font /Subtype /Type0 /BaseFont /PageToPDFGlyphless /Encoding /Identity-H /DescendantFonts [${cidFontId} 0 R] /ToUnicode ${toUniId} 0 R >>`);

    this.obj(this.pagesId, `<< /Type /Pages /Kids [${this.pages.map(p => `${p.id} 0 R`).join(' ')}] /Count ${this.pages.length} >>`);
    this.obj(this.catalogId, `<< /Type /Catalog /Pages ${this.pagesId} 0 R /ViewerPreferences << /DisplayDocTitle true >> >>`);
    const infoId = this.alloc();
    const now = pdfDate(new Date());
    const parts = [`/Producer ${pdfTextString('PageToPDF')}`, `/Creator ${pdfTextString('PageToPDF browser extension')}`, `/CreationDate (${now})`];
    if (meta.title) parts.push(`/Title ${pdfTextString(meta.title)}`);
    if (meta.subject) parts.push(`/Subject ${pdfTextString(meta.subject)}`);
    if (meta.keywords) parts.push(`/Keywords ${pdfTextString(meta.keywords)}`);
    this.obj(infoId, `<< ${parts.join(' ')} >>`);

    const xref = this.offset;
    const n = this.nextId;
    let x = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (let i = 1; i < n; i++) x += `${String(this.offsets[i] || 0).padStart(10, '0')} 00000 ${this.offsets[i] ? 'n' : 'f'} \n`;
    this.write(x);
    this.write(`trailer\n<< /Size ${n} /Root ${this.catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(this.chunks, { type: 'application/pdf' });
  }

  toUnicodeCMap() {
    const entries = [...this.cidMap.entries()];
    let body = '';
    for (let i = 0; i < entries.length; i += 100) {
      const batch = entries.slice(i, i + 100);
      body += `${batch.length} beginbfchar\n`;
      for (const [ch, cid] of batch) {
        let u = '';
        for (let j = 0; j < ch.length; j++) u += ch.charCodeAt(j).toString(16).padStart(4, '0');
        body += `<${cid.toString(16).padStart(4, '0')}> <${u}>\n`;
      }
      body += 'endbfchar\n';
    }
    return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${body}endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
  }
}

export async function deflate(bytes) {
  const cs = new CompressionStream('deflate'); // zlib wrapper == PDF FlateDecode
  const out = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
