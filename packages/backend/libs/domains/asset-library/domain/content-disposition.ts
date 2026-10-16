const MAX_NAME_BYTES = 255;
// NUL, C0 and C1 controls, DEL (this also removes CR and LF, which would split a header)
// eslint-disable-next-line no-control-regex -- the point is to remove control characters
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** The longest prefix of `name` that fits `maxBytes` of UTF-8 without cutting a character. */
function cutToBytes(name: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const char of name) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}

/**
 * `Content-Disposition` value of a download (S31 FR-037, AS-56): always an attachment, an ASCII `filename` without
 * quote, backslash, `%` or `;`, and the RFC 6266 `filename*` carrying the original in UTF-8 percent-encoding. Control
 * characters are removed, the name is cut to 255 bytes, and an empty result becomes `download`. Pure.
 */
export function attachmentHeader(fileName: string): string {
  const cleaned = cutToBytes(
    String(fileName ?? '').replace(CONTROL, ''),
    MAX_NAME_BYTES,
  );
  const name = cleaned.length > 0 ? cleaned : 'download';
  const ascii = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
