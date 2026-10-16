import { detectFileType, matchesDeclaredType, sniff } from './file-type';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PDF = ascii('%PDF-1.7\n');
const WEBP = [...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBPVP8 ')];
const buf = (...parts: number[][]) => Buffer.from(parts.flat());

describe('detectFileType', () => {
  it.each([
    ['PDF', buf(PDF), 'application/pdf'],
    ['PDF with only the signature', buf(ascii('%PDF-')), 'application/pdf'],
    ['JPEG', buf(JPEG), 'image/jpeg'],
    ['JPEG with only the signature', buf([0xff, 0xd8, 0xff]), 'image/jpeg'],
    ['PNG', buf(PNG, [0, 0, 0, 13]), 'image/png'],
    ['PNG with only the signature', buf(PNG), 'image/png'],
    ['WebP', buf(WEBP), 'image/webp'],
  ])('S04 AS-28: recognises %s', (_, bytes, expected) => {
    expect(detectFileType(bytes)).toBe(expected);
    expect(sniff(bytes)).toBe(expected);
  });

  it.each([
    ['empty', buf()],
    ['one byte', buf([0xff])],
    ['truncated PDF signature', buf(ascii('%PDF'))],
    ['truncated JPEG signature', buf([0xff, 0xd8])],
    ['truncated PNG signature', buf(PNG.slice(0, 7))],
    ['PNG signature with a wrong last byte', buf(PNG.slice(0, 7), [0x0b])],
    ['RIFF without WEBP', buf(ascii('RIFF'), [0, 0, 0, 0], ascii('WAVE'))],
    ['truncated WebP', buf(ascii('RIFF'), [0, 0, 0, 0], ascii('WEB'))],
    ['plain text', buf(ascii('hello world'))],
    ['HTML', buf(ascii('<html><script>'))],
    ['PDF signature not at the start', buf([0x20], PDF)],
    ['ZIP', buf([0x50, 0x4b, 0x03, 0x04])],
    ['GIF', buf(ascii('GIF89a'))],
  ])('S04 AS-28: %s is unknown', (_, bytes) => {
    expect(detectFileType(bytes)).toBeNull();
    expect(sniff(bytes)).toBeNull();
  });

  it('S04 AS-28: accepts a plain Uint8Array', () => {
    expect(detectFileType(new Uint8Array(PNG))).toBe('image/png');
  });
});

describe('matchesDeclaredType', () => {
  it.each([
    ['PDF as PDF', buf(PDF), 'application/pdf', true],
    ['PNG as PNG', buf(PNG), 'image/png', true],
    ['JPEG as JPEG', buf(JPEG), 'image/jpeg', true],
    ['WebP as WebP', buf(WEBP), 'image/webp', true],
    ['PNG declared as PDF', buf(PNG), 'application/pdf', false],
    ['PDF declared as JPEG', buf(PDF), 'image/jpeg', false],
    ['JPEG declared as PNG', buf(JPEG), 'image/png', false],
    ['text declared as PDF', buf(ascii('hello')), 'application/pdf', false],
    ['empty declared as PDF', buf(), 'application/pdf', false],
    ['PDF declared with a parameter', buf(PDF), 'application/pdf; x=1', false],
    ['PDF declared in capitals', buf(PDF), 'APPLICATION/PDF', false],
  ])('S04 AS-28: %s -> %s', (_, bytes, declared, expected) => {
    expect(matchesDeclaredType(bytes, declared)).toBe(expected);
  });
});
