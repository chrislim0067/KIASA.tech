/**
 * Hand-built PDF fixtures for the résumé tests.
 *
 * Written byte by byte rather than committed as binary files, for three
 * reasons: a reviewer can read exactly what is being tested, the secret
 * scanner and diff tooling can see them, and a "scanned résumé" fixture that
 * is genuinely a real person's scanned résumé is not something to keep in a
 * public repository.
 *
 * Each builder emits a minimal but VALID PDF — correct object offsets, a real
 * cross-reference table, a real trailer — so the extractor is exercised on
 * documents a PDF parser accepts, not on strings that happen to start `%PDF`.
 */

/** Assemble numbered objects into a valid PDF with a correct xref table. */
function assemble(objects) {
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj${body}endobj\n`;
  });
  const startxref = pdf.length;
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${startxref}\n%%EOF`;
  // latin1: the byte-for-byte encoding a PDF's structure is written in.
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

const escapePdfString = (s) => s.replace(/[\\()]/g, (m) => `\\${m}`);

/** Set by longTextPdf so its dense pages actually fit inside the MediaBox. */
let fontSize = 12;
let leading = 16;

/**
 * A text PDF: `pages` is an array of arrays of lines.
 * This is the shape a résumé exported from a word processor has.
 */
export function textPdf(pages) {
  const objects = ['', '', ...[]];
  const pageCount = pages.length;
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');

  const parts = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${kids}]/Count ${pageCount}>>`,
  ];

  const fontObjNumber = 3 + pageCount * 2;
  pages.forEach((lines, i) => {
    const contentNumber = 4 + i * 2;
    const content =
      `BT /F1 ${fontSize} Tf 36 750 Td ` +
      lines
        .map((l, n) => (n ? `0 -${leading} Td ` : '') + `(${escapePdfString(l)}) Tj `)
        .join('') +
      'ET';
    parts.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentNumber} 0 R` +
        `/Resources<</Font<</F1 ${fontObjNumber} 0 R>>>>>>`
    );
    parts.push(`<</Length ${content.length}>>stream\n${content}\nendstream`);
  });
  parts.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');

  objects.length = 0;
  objects.push(...parts);
  return assemble(objects);
}

/**
 * A scanned résumé: one page, an image, and NO text operators.
 *
 * This is the case that must reach manual review rather than being sent to a
 * model as an empty string and coming back as a confident, invented résumé.
 */
export function imageOnlyPdf() {
  const content = 'q 100 0 0 100 72 600 cm /Im0 Do Q';
  return assemble([
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R' +
      '/Resources<</XObject<</Im0 5 0 R>>>>>>',
    `<</Length ${content.length}>>stream\n${content}\nendstream`,
    '<</Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceGray' +
      '/BitsPerComponent 8/Length 1>>stream\n \nendstream',
  ]);
}

/** Bytes that are not a PDF at all. */
export function malformedPdf() {
  return new Uint8Array(Buffer.from('this is not a pdf, it is a sentence', 'latin1'));
}

/** A PDF header followed by rubbish: the extension lies, the content is broken. */
export function truncatedPdf() {
  return new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog', 'latin1'));
}

/** Zero bytes. */
export function emptyPdf() {
  return new Uint8Array(0);
}

/** A valid text PDF padded past `bytes` with a comment, for size-limit tests. */
export function oversizePdf(bytes) {
  const base = textPdf([['Padding fixture']]);
  const padding = Buffer.alloc(Math.max(0, bytes - base.byteLength), 0x20);
  return new Uint8Array(Buffer.concat([Buffer.from(base), padding]));
}

/** `n` pages, each carrying one line, for page-count tests. */
export function manyPagePdf(n, line = 'Page') {
  return textPdf(Array.from({ length: n }, (_, i) => [`${line} ${i + 1}`]));
}

/**
 * A document whose extracted text exceeds `chars`, for text-length limits.
 *
 * Spread across pages rather than piled onto one: pdf.js does not extract text
 * positioned below the MediaBox, so a single page of a thousand lines yields
 * only the forty-odd that actually fit and the fixture silently under-delivers.
 * Measured — a one-page attempt produced 3 163 characters, not the 85 000 asked
 * for.
 */
export function longTextPdf(chars) {
  // Small type on purpose. pdf.js extracts only what actually lands inside the
  // MediaBox, so long lines are clipped horizontally and surplus lines fall off
  // the bottom -- a naive one-page fixture asking for 85 000 characters
  // delivered 3 163, and 200-character lines delivered 44 159. At 4pt with 5pt
  // leading a page genuinely holds the text this fixture claims.
  const previousSize = fontSize;
  const previousLeading = leading;
  fontSize = 4;
  leading = 5;
  try {
    const lineLength = 240;
    const linesPerPage = 140;
    const pageCount = Math.ceil(chars / (lineLength * linesPerPage)) + 1;
    const pages = Array.from({ length: pageCount }, (_, p) =>
      Array.from({ length: linesPerPage }, (_, i) => `p${p}l${i} ` + 'x'.repeat(lineLength))
    );
    return textPdf(pages);
  } finally {
    fontSize = previousSize;
    leading = previousLeading;
  }
}
