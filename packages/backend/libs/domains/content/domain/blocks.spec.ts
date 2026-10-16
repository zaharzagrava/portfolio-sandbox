import fc from 'fast-check';
import { parseBlocks, parseSeo, sanitizeRichText } from './blocks';

const ok = (block: unknown) => parseBlocks([block]);
const rejected = (block: unknown) => {
  const parsed = parseBlocks([block]);
  expect(parsed.ok).toBe(false);
  return parsed;
};

describe('S27 blocks: schemas, video hosts, S30 playlist rule', () => {
  it.each([
    ['heading 2', { type: 'heading', level: 2, text: 'Design' }],
    ['heading 3', { type: 'heading', level: 3, text: 'Design' }],
    ['richText', { type: 'richText', html: '<p>Hello</p>' }],
    [
      'image',
      {
        type: 'image',
        url: 'https://cdn.example.com/a.png',
        alt: 'A',
        width: 10,
        height: 20,
      },
    ],
    [
      'product',
      { type: 'product', productId: '0b9a6a52-7d2e-4a3c-9d3c-4f9d3d1a0a11' },
    ],
    ['quote', { type: 'quote', text: 'Wow', cite: 'Someone' }],
    ['quote without cite', { type: 'quote', text: 'Wow' }],
    [
      'video youtube',
      { type: 'video', url: 'https://www.youtube.com/watch?v=x' },
    ],
    ['video vimeo', { type: 'video', url: 'https://player.vimeo.com/video/1' }],
    [
      'video public playlist',
      {
        type: 'video',
        url: 'https://stream.marketplace.dev/p/0b9a6a52-7d2e-4a3c-9d3c-4f9d3d1a0a11/master.m3u8',
      },
    ],
  ])('S27 AS-08: accepts %s', (_name, block) => {
    expect(ok(block).ok).toBe(true);
  });

  it.each([
    ['unknown type', { type: 'carousel' }],
    ['heading level 4', { type: 'heading', level: 4, text: 'x' }],
    [
      'heading text over 200',
      { type: 'heading', level: 2, text: 'x'.repeat(201) },
    ],
    ['richText over 20,000', { type: 'richText', html: 'x'.repeat(20_001) }],
    [
      'image over http',
      {
        type: 'image',
        url: 'http://a.example/a.png',
        alt: 'a',
        width: 1,
        height: 1,
      },
    ],
    [
      'image without alt',
      { type: 'image', url: 'https://a.example/a.png', width: 1, height: 1 },
    ],
    [
      'image alt over 300',
      {
        type: 'image',
        url: 'https://a.example/a.png',
        alt: 'a'.repeat(301),
        width: 1,
        height: 1,
      },
    ],
    [
      'image width 0',
      {
        type: 'image',
        url: 'https://a.example/a.png',
        alt: 'a',
        width: 0,
        height: 1,
      },
    ],
    [
      'image negative height',
      {
        type: 'image',
        url: 'https://a.example/a.png',
        alt: 'a',
        width: 1,
        height: -3,
      },
    ],
    ['product not a uuid', { type: 'product', productId: '123' }],
    ['quote over 500', { type: 'quote', text: 'q'.repeat(501) }],
    ['extra property', { type: 'quote', text: 'q', extra: 1 }],
    [
      'video suffix host',
      { type: 'video', url: 'https://www.youtube.com.evil.example/x' },
    ],
    [
      'video userinfo',
      { type: 'video', url: 'https://www.youtube.com@evil.example/x' },
    ],
    [
      'video credentials',
      { type: 'video', url: 'https://user:pw@www.youtube.com/x' },
    ],
    ['video port', { type: 'video', url: 'https://www.youtube.com:8443/x' }],
    ['video http', { type: 'video', url: 'http://www.youtube.com/x' }],
    ['video other host', { type: 'video', url: 'https://evil.example/x' }],
    ['video not a url', { type: 'video', url: 'nonsense' }],
    [
      'unlisted stream path',
      {
        type: 'video',
        url: 'https://stream.marketplace.dev/u/0b9a6a52-7d2e-4a3c-9d3c-4f9d3d1a0a11/master.m3u8',
      },
    ],
    [
      'stream playlist with a credential in the query',
      {
        type: 'video',
        url: 'https://stream.marketplace.dev/p/abc/master.m3u8?token=secret',
      },
    ],
    [
      'stream playlist with a fragment',
      {
        type: 'video',
        url: 'https://stream.marketplace.dev/p/abc/master.m3u8#x',
      },
    ],
    [
      'stream other file',
      { type: 'video', url: 'https://stream.marketplace.dev/p/abc/other.mp4' },
    ],
  ])('S27 AS-08: refuses %s', (_name, block) => {
    rejected(block);
  });

  it('S27 AS-08: more than 200 blocks are refused', () => {
    const block = { type: 'heading', level: 2, text: 'x' };
    expect(parseBlocks(Array.from({ length: 200 }, () => block)).ok).toBe(true);
    expect(parseBlocks(Array.from({ length: 201 }, () => block)).ok).toBe(
      false,
    );
  });

  it('S27 AS-08: issues are capped at 10 and never carry the submitted value', () => {
    const bad = Array.from({ length: 30 }, () => ({
      type: 'heading',
      level: 9,
      text: 'SECRET-VALUE',
    }));
    const parsed = parseBlocks(bad);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(parsed.issues)).not.toContain('SECRET-VALUE');
    for (const issue of parsed.issues) {
      expect(typeof issue.path).toBe('string');
      expect(typeof issue.code).toBe('string');
    }
  });

  it('S27 AS-08: a non-array is refused', () => {
    expect(parseBlocks('x').ok).toBe(false);
  });

  it.each([
    ['empty', {}, true],
    ['description', { description: 'd' }, true],
    ['https og image', { ogImage: 'https://a.example/i.png' }, true],
    ['http og image', { ogImage: 'http://a.example/i.png' }, false],
    ['javascript og image', { ogImage: 'javascript:alert(1)' }, false],
    ['description over 300', { description: 'x'.repeat(301) }, false],
    ['unknown property', { robots: 'all' }, false],
  ])('S27 AS-08: seo %s', (_name, seo, valid) => {
    expect(parseSeo(seo).ok).toBe(valid);
  });
});

describe('S27 blocks: rich text sanitiser', () => {
  const HOSTILE =
    '<p>Titanium. <script>alert(1)</script><a href="javascript:x()">x</a><a href="https://apple.com" onclick="steal()">site</a></p>';

  it('S27 AS-06: the spec example keeps the safe link and drops the rest', () => {
    const out = sanitizeRichText(HOSTILE);
    expect(out).toContain(
      '<a href="https://apple.com" rel="noopener">site</a>',
    );
    expect(out).not.toMatch(/script|javascript:|onclick/);
    expect(sanitizeRichText(out)).toBe(out);
  });

  it.each([
    [
      'script element and content',
      '<p>a</p><script>alert(1)</script>',
      'alert',
    ],
    ['javascript link', '<a href="javascript:alert(1)">x</a>', 'javascript'],
    ['data link', '<a href="data:text/html;base64,AAAA">x</a>', 'data:'],
    ['event attribute', '<p onmouseover="x()">a</p>', 'onmouseover'],
    ['style attribute', '<p style="color:red">a</p>', 'style'],
    ['iframe', '<iframe src="https://evil.example"></iframe>', 'iframe'],
    ['img onerror', '<img src=x onerror=alert(1)>', 'onerror'],
    ['svg', '<svg onload=alert(1)></svg>', 'svg'],
    ['http link', '<a href="http://a.example">x</a>', 'http://'],
    ['style element', '<style>body{display:none}</style>', 'display'],
  ])('S27 AS-06: removes %s', (_name, html, needle) => {
    expect(sanitizeRichText(html).toLowerCase()).not.toContain(needle);
  });

  it('S27 AS-06: every remaining link carries rel="noopener"', () => {
    const out = sanitizeRichText(
      '<a href="https://a.example">1</a><a href="https://b.example" rel="opener">2</a>',
    );
    expect(out.match(/<a /g)).toHaveLength(2);
    expect(out.match(/rel="noopener"/g)).toHaveLength(2);
  });

  it('S27 AS-06: allowed formatting survives', () => {
    const html =
      '<h2>T</h2><p><strong>b</strong> <em>i</em><br /></p><ul><li>x</li></ul><blockquote>q</blockquote>';
    expect(sanitizeRichText(html)).toBe(html);
  });

  const fragment = fc.oneof(
    fc.constantFrom(
      '<script>alert(1)</script>',
      '<a href="javascript:x()">j</a>',
      '<a href="https://a.example" onclick="x()">ok</a>',
      '<img src=x onerror=alert(1)>',
      '<p onload="x()">p</p>',
      '<iframe src="//e.example"></iframe>',
      '<SCRIPT SRC=//e.example></SCRIPT>',
      '<a href="  JaVaScRiPt:alert(1)">z</a>',
      '<svg/onload=alert(1)>',
      '<b>bold</b>',
      '&lt;script&gt;',
      '<p>',
      '</p>',
    ),
    fc.string({ maxLength: 12 }),
  );

  it('S27 AS-06: property: sanitising is idempotent and the output is never executable', () => {
    fc.assert(
      fc.property(fc.array(fragment, { maxLength: 8 }), (parts) => {
        const once = sanitizeRichText(parts.join(''));
        expect(sanitizeRichText(once)).toBe(once);
        expect(once).not.toMatch(/<\s*script/i);
        expect(once).not.toMatch(/href="\s*javascript:/i);
        expect(once).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
      }),
      { numRuns: 400 },
    );
  });
});
