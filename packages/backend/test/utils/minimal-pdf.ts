/**
 * Builds a small valid PDF (Helvetica text, one string array per page, correct
 * xref offsets) - real input for PDF parsing specs without binary fixtures.
 */
export function minimalPdf(pages: string[][]): Buffer {
  const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>'];
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  const fontId = 3 + pages.length * 2;
  pages.forEach((lines, i) => {
    const content = `BT /F1 12 Tf 50 750 Td 16 TL ${lines.map((l) => `(${escape(l)}) Tj T*`).join(' ')} ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    objs.push(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
