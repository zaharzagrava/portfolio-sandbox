import { sniff } from './import-sniff';

const bytes = (...b: number[]) => Buffer.from(b);
const pad = (head: Buffer) =>
  Buffer.concat([head, Buffer.from('x'.repeat(64))]);

describe('S07 import content sniffing', () => {
  it.each([
    ['zip', pad(bytes(0x50, 0x4b, 0x03, 0x04))],
    ['empty zip', pad(bytes(0x50, 0x4b, 0x05, 0x06))],
    ['gzip', pad(bytes(0x1f, 0x8b, 0x08))],
    ['pdf', pad(Buffer.from('%PDF-1.7'))],
    ['png', pad(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a))],
    ['jpeg', pad(bytes(0xff, 0xd8, 0xff, 0xe0))],
    ['gif', pad(Buffer.from('GIF89a'))],
    ['elf', pad(bytes(0x7f, 0x45, 0x4c, 0x46))],
    ['windows executable', pad(bytes(0x4d, 0x5a, 0x90))],
    [
      'ole document',
      pad(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)),
    ],
    ['utf-16 le bom', pad(bytes(0xff, 0xfe, 0x73, 0x00))],
    ['utf-16 be bom', pad(bytes(0xfe, 0xff, 0x00, 0x73))],
    ['utf-32 le bom', pad(bytes(0xff, 0xfe, 0x00, 0x00))],
    ['utf-32 be bom', pad(bytes(0x00, 0x00, 0xfe, 0xff))],
    ['a NUL byte in the window', Buffer.from('sku,title\nA\u0000B,x\n')],
    [
      'invalid utf-8',
      Buffer.concat([
        Buffer.from('sku,title\n'),
        bytes(0xc3, 0x28),
        Buffer.from(',x\n'),
      ]),
    ],
    [
      'lone continuation byte',
      Buffer.concat([Buffer.from('sku\n'), bytes(0x80), Buffer.from('\n')]),
    ],
  ])('S07 AS-26: %s is unsupported', (_name, head) => {
    expect(sniff(head).ok).toBe(false);
  });

  it.each([
    ['plain csv', Buffer.from('sku,title,price,category\nA,B,1,c\n'), 'csv', 0],
    [
      'csv with utf-8 bom',
      Buffer.concat([bytes(0xef, 0xbb, 0xbf), Buffer.from('sku,title\n')]),
      'csv',
      3,
    ],
    ['jsonl', Buffer.from('{"sku":"A"}\n{"sku":"B"}\n'), 'jsonl', 0],
    [
      'jsonl with bom',
      Buffer.concat([bytes(0xef, 0xbb, 0xbf), Buffer.from('{"sku":"A"}\n')]),
      'jsonl',
      3,
    ],
    [
      'jsonl after blank lines',
      Buffer.from('\r\n  \n{"sku":"A"}\n'),
      'jsonl',
      0,
    ],
    [
      'csv whose header starts with a quote',
      Buffer.from('"sku","title"\n'),
      'csv',
      0,
    ],
    ['multi-byte text', Buffer.from('sku,title\nA,Müller Käse €\n'), 'csv', 0],
    ['empty file', Buffer.alloc(0), 'csv', 0],
  ])('S07 AS-26: %s is read as %s', (_name, head, format, bomLength) => {
    expect(sniff(head)).toEqual({ ok: true, format, bomLength });
  });

  it('S07 AS-26: a window cut in the middle of a multi-byte character is not an error', () => {
    const text = Buffer.from('sku,title\nA,€€€€\n');
    expect(sniff(text.subarray(0, text.length - 3)).ok).toBe(true);
  });

  it('S07 AS-26: only the first 4 KiB are classified', () => {
    const head = Buffer.concat([
      Buffer.from('sku,title\n'),
      Buffer.from('a'.repeat(5000)),
      bytes(0),
    ]);
    expect(sniff(head).ok).toBe(true);
  });

  it('S07 AS-26: the reason names the class, never the content', () => {
    expect(sniff(pad(bytes(0x50, 0x4b, 0x03, 0x04)))).toEqual({
      ok: false,
      reason: 'archive',
    });
    expect(sniff(Buffer.from('a\u0000b'))).toEqual({
      ok: false,
      reason: 'binary',
    });
  });
});
