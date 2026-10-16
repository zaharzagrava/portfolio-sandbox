import { attachmentHeader } from './content-disposition';

/** The `filename="…"` part and the decoded `filename*` part of an attachment header. */
function parse(header: string) {
  const m =
    /^attachment; filename="([^"]*)"; filename\*=UTF-8''([^;\s]*)$/.exec(
      header,
    );
  if (!m) throw new Error(`unexpected header shape: ${header}`);
  return { ascii: m[1], decoded: decodeURIComponent(m[2]) };
}

describe('S31 attachment file names', () => {
  it('S31 AS-56: escapes quotes and keeps the original in filename*', () => {
    const h = attachmentHeader('résumé "v2".pdf');
    const { ascii, decoded } = parse(h);
    expect(ascii).toBe('r_sum_ _v2_.pdf');
    expect(decoded).toBe('résumé "v2".pdf');
    expect(h).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22.pdf");
  });

  it('S31 AS-56: never lets CR, LF or a header-looking name through', () => {
    const h = attachmentHeader('a\r\nSet-Cookie: x=1.txt');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.startsWith('attachment; filename="aSet-Cookie: x=1.txt"')).toBe(
      true,
    );
    expect(parse(h).decoded).toBe('aSet-Cookie: x=1.txt');
  });

  it.each([
    ['a;b\\c%d.txt', 'a_b_c_d.txt'],
    ["it's (1)*.txt", "it's (1)*.txt"],
  ])('S31 AS-56: %s has the ASCII form %s', (name, ascii) => {
    const parsed = parse(attachmentHeader(name));
    expect(parsed.ascii).toBe(ascii);
    expect(parsed.decoded).toBe(name);
  });

  it('S31 AS-56: percent-encodes the characters filename* may not carry raw', () => {
    const h = attachmentHeader("it's (1)*.txt");
    expect(h).toContain("filename*=UTF-8''it%27s%20%281%29%2A.txt");
  });

  it('S31 AS-56: cuts a 400-character name to 255 bytes without splitting a character', () => {
    const { decoded, ascii } = parse(attachmentHeader('x'.repeat(400)));
    expect(Buffer.byteLength(decoded)).toBe(255);
    expect(ascii.length).toBe(255);
    const multi = parse(attachmentHeader('é'.repeat(200))).decoded; // 2 bytes each
    expect(Buffer.byteLength(multi)).toBeLessThanOrEqual(255);
    expect(multi).toBe('é'.repeat(127));
    expect(multi).not.toContain('\ufffd');
  });

  it.each([[''], ['\u0000\u0001\r\n\u007f'], ['\u0085\u009f']])(
    'S31 AS-56: an empty or all-control name %j becomes download',
    (name) => {
      const { ascii, decoded } = parse(attachmentHeader(name));
      expect(ascii).toBe('download');
      expect(decoded).toBe('download');
    },
  );

  it('S31 AS-56: the filename part is always printable ASCII without quote or backslash', () => {
    for (const name of ['日本語.pdf', '\u202ephoto.exe', 'a"b\\c', 'tab\there'])
      expect(parse(attachmentHeader(name)).ascii).toMatch(/^[\x20-\x7e]*$/);
    expect(parse(attachmentHeader('a"b\\c')).ascii).not.toMatch(/["\\]/);
  });
});
