import { FORBIDDEN_OUTPUT, XSS_CORPUS } from '../testing/xss-corpus';
import {
  assertMarkdownComplexity,
  HTML_POLICY_VERSION,
  markdownNesting,
  MAX_MARKDOWN_NESTING,
  normalizeTitle,
  plainTextPreview,
  renderUserMarkdown,
} from './content';

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
  'a',
  'h3',
  'h4',
]);
const LINK_REL = 'rel="nofollow ugc noopener noreferrer"';

describe('S25 FR-040 markdown rendition', () => {
  it.each([
    ['**hi**', '<p><strong>hi</strong></p>'],
    [
      '[ok](https://apple.com)',
      `<p><a href="https://apple.com" ${LINK_REL} target="_blank">ok</a></p>`,
    ],
    ['[x](javascript:alert(1))', '<p>x</p>'],
    ['# big', '<h4>big</h4>'],
    ['## big', '<h4>big</h4>'],
    ['### mid', '<h3>mid</h3>'],
    ['#### small', '<h4>small</h4>'],
    ['##### tiny', '<h4>tiny</h4>'],
    ['###### tiny', '<h4>tiny</h4>'],
    ['*it* ~~gone~~ `c`', '<p><em>it</em> <del>gone</del> <code>c</code></p>'],
    ['a  \nb', '<p>a<br />b</p>'],
  ])('S25 AS-08: %j renders as %j', (markdown, html) => {
    expect(renderUserMarkdown(markdown)).toBe(html);
  });

  it('S25 AS-08: images, scripts and comments leave no tag behind', () => {
    for (const md of [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '![t](https://evil.example/t.png)',
      '<!-- c -->',
    ]) {
      const html = renderUserMarkdown(md);
      expect(html).not.toMatch(/<script|<img|<!--|onerror/i);
    }
  });

  it('S25 AS-08: lists, quotes and fenced code survive; only allowed tags and link attributes are emitted', () => {
    const html = renderUserMarkdown(
      '1. one\n2. two\n\n- a\n- b\n\n> quote\n\n```\ncode\n```\n\n[m](mailto:a@b.example) [h](http://x.example) [s](https://x.example)',
    );
    expect(html).toContain('<ol>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<pre><code>');
    expect(html.match(/<a /g)).toHaveLength(3);
    const tags = [...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]);
    expect(tags.every((t) => ALLOWED_TAGS.has(t))).toBe(true);
    for (const a of html.matchAll(/<a ([^>]*)>/g)) {
      expect(a[1]).toContain(LINK_REL);
      expect(a[1]).toContain('target="_blank"');
      expect([...a[1].matchAll(/([a-z]+)=/g)].map((m) => m[1]).sort()).toEqual([
        'href',
        'rel',
        'target',
      ]);
    }
  });

  it.each(XSS_CORPUS)(
    'S25 AS-09: the corpus payload "%s" yields no executable construct',
    (_name, markdown) => {
      const html = renderUserMarkdown(markdown);
      for (const forbidden of FORBIDDEN_OUTPUT)
        expect(html).not.toMatch(forbidden);
      expect(html).not.toMatch(
        /<(?!\/?(p|br|strong|em|del|code|pre|blockquote|ul|ol|li|a|h3|h4)[\s/>])/i,
      );
    },
  );

  it('S25 AS-09: plain text stays readable where it was plain text', () => {
    expect(renderUserMarkdown('hello onerror=alert(1) world')).toContain(
      'hello onerror',
    );
    expect(renderUserMarkdown('try javascript:alert(1) now')).toContain(
      'try javascript',
    );
  });

  it('S25 AS-10: the policy version is a positive integer', () => {
    expect(Number.isInteger(HTML_POLICY_VERSION)).toBe(true);
    expect(HTML_POLICY_VERSION).toBeGreaterThan(0);
  });
});

describe('S25 AS-12 markdown complexity', () => {
  it.each([
    ['plain text', 'hello', 0],
    ['one quote', '> a', 1],
    ['two quotes on a line', '> > a', 2],
    ['quote without space', '>>>a', 3],
    ['list', '- a', 1],
    ['nested list by indent', '- a\n  - b\n    - c', 3],
    ['numbered list', '1. a\n   1. b', 2],
    ['list in quote', '> - a', 2],
    ['markers on one line', '- - - - a', 4],
    ['indented code block is not a list', '    code\n    more', 0],
    ['text containing a greater-than', 'a > b', 0],
  ])('S25 AS-12: nesting of %s is %i', (_n, markdown, depth) => {
    expect(markdownNesting(markdown)).toBe(depth);
  });

  it('S25 AS-12: 20 levels are accepted and 21 are refused', () => {
    expect(() =>
      assertMarkdownComplexity('>'.repeat(MAX_MARKDOWN_NESTING)),
    ).not.toThrow();
    expect(() =>
      assertMarkdownComplexity('>'.repeat(MAX_MARKDOWN_NESTING + 1)),
    ).toThrow('markdown_too_complex');
  });

  it.each([
    ['20,000 nested quote markers', '> '.repeat(20_000)],
    ['5,000 nested list levels', '- '.repeat(5_000)],
  ])('S25 AS-12: %s is refused without parsing', (_n, markdown) => {
    const started = Date.now();
    expect(() => assertMarkdownComplexity(markdown)).toThrow(
      'markdown_too_complex',
    );
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('S25 AS-12: 10,000 unclosed bracket pairs and a normal 40,000 character body render within 250 ms', () => {
    for (const body of [
      '[('.repeat(10_000),
      'Some **bold** words and a [link](https://x.example). '
        .repeat(700)
        .slice(0, 40_000),
    ]) {
      assertMarkdownComplexity(body);
      const started = Date.now();
      renderUserMarkdown(body);
      expect(Date.now() - started).toBeLessThan(250);
    }
  });
});

describe('S25 AS-03 titles', () => {
  it.each([
    ['  Does it work?  ', 'Does it work?'],
    ['abc', 'abc'],
    ['\tabc\n', 'abc'],
    ['x'.repeat(300), 'x'.repeat(300)],
    ['😀😀😀', '😀😀😀'],
    ['<b>x</b>', '<b>x</b>'],
    ['<img src=x onerror=alert(1)>', '<img src=x onerror=alert(1)>'],
  ])('accepts %j as %j', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });

  it.each([
    ['too short', 'ab'],
    ['blank', '    '],
    ['too long', 'x'.repeat(301)],
    ['too long in code points', '😀'.repeat(301)],
    ['control character', 'ab\u0000c'],
    ['newline inside', 'ab\ncd'],
    ['delete character', 'ab\u007Fc'],
    ['bidi override', `ab${String.fromCharCode(0x202e)}c`],
    ['bidi isolate', `ab${String.fromCharCode(0x2066)}c`],
    ['not a string', 7 as unknown as string],
  ])('refuses a title that is %s', (_n, input) => {
    expect(normalizeTitle(input)).toBeNull();
  });
});

describe('S25 plain text previews', () => {
  it('takes the first 140 code points of the text without markup', () => {
    expect(plainTextPreview('**bold** [link](https://x.example)')).toBe(
      'bold link',
    );
    expect(plainTextPreview('😀'.repeat(200))).toBe('😀'.repeat(140));
    expect(plainTextPreview('<script>alert(1)</script> hi')).not.toContain('<');
  });
});
