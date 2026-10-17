import * as fc from 'fast-check';
import { simhash, simhashDistance, visibleText } from './simhash';

const sentences = Array.from(
  { length: 60 },
  (_, i) =>
    `The stainless steel kettle model ${i} boils water quickly and shuts off automatically with feature ${i * 7}.`,
);
const page = (widget: string) =>
  `${sentences.join(' ')} Customers also viewed ${widget}`;

const unrelated = Array.from(
  { length: 60 },
  (_, i) =>
    `Garden hose reel number ${i * 13} stores twenty metres of tubing beside patio ${i} furniture.`,
).join(' ');

const HEX16 = /^[0-9a-f]{16}$/;

describe('S41 AS-36: SimHash', () => {
  it('S41 AS-36: identical text gives the same 16 hex digit hash and distance 0', () => {
    const a = simhash(page('alpha beta gamma'));
    expect(a).toMatch(HEX16);
    expect(simhash(page('alpha beta gamma'))).toBe(a);
    expect(simhashDistance(a, a)).toBe(0);
  });

  it('S41 AS-36: a rotated "people also bought" widget stays within 3 bits', () => {
    const a = simhash(page('red mug blue plate green bowl'));
    const b = simhash(page('yellow cup black dish white jar'));
    expect(simhashDistance(a, b)).toBeLessThanOrEqual(3);
  });

  it('S41 AS-36: an unrelated page is more than 15 bits away', () => {
    expect(
      simhashDistance(simhash(page('x')), simhash(unrelated)),
    ).toBeGreaterThan(15);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   \n\t '],
    ['one word', 'kettle'],
    ['two words', 'steel kettle'],
    ['three words', 'steel kettle 19'],
    ['four words', 'steel kettle 19 euro'],
    ['punctuation only', '!!! ??? ...'],
    ['markup only', visibleText('<div><img src="a.png"><br></div>')],
    ['unicode', 'Wasserkocher Küche 日本語 テスト'],
  ])('S41 AS-36: %s text produces a valid hash', (_name, text) => {
    const hash = simhash(text);
    expect(hash).toMatch(HEX16);
    expect(simhash(text)).toBe(hash);
  });

  it('S41 AS-36: empty text, whitespace and markup-only all hash alike', () => {
    expect(simhash('')).toBe(simhash(visibleText('<p> </p>')));
  });

  it('S41 AS-36: short texts that differ give different hashes', () => {
    expect(simhash('kettle')).not.toBe(simhash('toaster'));
  });

  it('S41 AS-36: distance counts differing bits', () => {
    expect(simhashDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(simhashDistance('0000000000000001', '0000000000000003')).toBe(1);
    expect(simhashDistance('8000000000000000', '0000000000000001')).toBe(2);
  });

  describe('properties', () => {
    const hash = fc.string({ maxLength: 120 }).map(simhash);

    it('S41 AS-36: any text yields a valid hash', () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 200 }), (t) =>
          HEX16.test(simhash(t)),
        ),
      );
    });

    it('S41 AS-36: distance is symmetric', () => {
      fc.assert(
        fc.property(
          hash,
          hash,
          (a, b) => simhashDistance(a, b) === simhashDistance(b, a),
        ),
      );
    });

    it('S41 AS-36: d(a, a) = 0', () => {
      fc.assert(fc.property(hash, (a) => simhashDistance(a, a) === 0));
    });

    it('S41 AS-36: triangle inequality', () => {
      fc.assert(
        fc.property(
          hash,
          hash,
          hash,
          (a, b, c) =>
            simhashDistance(a, c) <=
            simhashDistance(a, b) + simhashDistance(b, c),
        ),
      );
    });
  });
});

describe('S41 AS-36: visible text', () => {
  it.each([
    ['script', '<p>a</p><script>var secret = 1;</script><p>b</p>'],
    ['style', '<p>a</p><style>.x{color:red}</style><p>b</p>'],
    ['noscript', '<p>a</p><noscript>enable js</noscript><p>b</p>'],
    [
      'script with attributes and uppercase',
      '<p>a</p><SCRIPT type="text/x" async>secret</SCRIPT><p>b</p>',
    ],
  ])('S41 AS-36: %s content is ignored', (_name, html) => {
    expect(visibleText(html)).toBe('a b');
  });

  it('S41 AS-36: tags are dropped and whitespace collapsed', () => {
    expect(visibleText('<div>  Hello\n\n <b>world</b>  </div>')).toBe(
      'Hello world',
    );
  });

  it('S41 AS-36: markup-only html gives empty text', () => {
    expect(visibleText('<div><img src="a.png"></div>')).toBe('');
  });
});
