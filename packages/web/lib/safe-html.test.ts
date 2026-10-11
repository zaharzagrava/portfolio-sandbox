import { describe, expect, it } from 'vitest';
import { sanitizeBodyHtml } from './safe-html';
import { safeHttpsUrl } from './safe-url';

const html = (input: string) => {
  const holder = document.createElement('div');
  holder.innerHTML = sanitizeBodyHtml(input);
  return holder;
};

describe('sanitizeBodyHtml', () => {
  it('W02 AS-47: keeps the allowed formatting', () => {
    expect(sanitizeBodyHtml('<p>a <strong>bold</strong> and <em>it</em> <del>x</del> <code>c</code></p>')).toBe(
      '<p>a <strong>bold</strong> and <em>it</em> <del>x</del> <code>c</code></p>',
    );
    expect(html('<ul><li>one</li></ul><ol><li>two</li></ol><blockquote>q</blockquote><pre>p</pre>').querySelectorAll('ul li, ol li, blockquote, pre')).toHaveLength(4);
  });

  it('W02 AS-47: **laptop** arrives as <strong>laptop</strong> and shows as bold text', () => {
    const out = html('<p><strong>laptop</strong></p>');
    expect(out.querySelector('strong')?.textContent).toBe('laptop');
  });

  it.each([
    ['script element', '<p>hi</p><script>alert(1)</script>', 'alert'],
    ['img with onerror', '<img src=x onerror="alert(1)">', 'onerror'],
    ['inline event handler', '<p onclick="alert(1)">x</p>', 'onclick'],
    ['style element', '<style>body{display:none}</style><p>x</p>', 'display'],
    ['style attribute', '<p style="color:red">x</p>', 'style'],
    ['iframe', '<iframe src="https://evil.example"></iframe>', 'iframe'],
    ['svg with handler', '<svg onload="alert(1)"><circle/></svg>', 'svg'],
    ['form', '<form action="https://evil.example"><input name=x></form>', 'form'],
    ['object and embed', '<object data="x"></object><embed src="x">', 'embed'],
    ['link element', '<link rel="stylesheet" href="https://evil.example/x.css">', 'stylesheet'],
    ['math element', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>', 'javascript'],
    ['id and class attributes', '<p id="x" class="y" data-a="b">t</p>', 'data-a'],
  ])('W02 AS-47: %s never reaches the page', (_name, input, forbidden) => {
    expect(sanitizeBodyHtml(input)).not.toContain(forbidden);
  });

  it.each([
    ['javascript:', '<a href="javascript:alert(1)">click</a>'],
    ['JaVaScRiPt: with entities', '<a href="jav&#x09;ascript:alert(1)">click</a>'],
    ['data:', '<a href="data:text/html,<script>alert(1)</script>">click</a>'],
    ['vbscript:', '<a href="vbscript:x">click</a>'],
    ['file:', '<a href="file:///etc/passwd">click</a>'],
    ['ftp:', '<a href="ftp://host/x">click</a>'],
    ['tel:', '<a href="tel:+123">click</a>'],
    ['protocol-relative', '<a href="//evil.example/x">click</a>'],
  ])('W02 AS-47: a %s link becomes its text', (_name, input) => {
    const out = html(input);
    expect(out.querySelector('a')).toBeNull();
    expect(out.textContent).toBe('click');
  });

  it.each(['https://shop.example/x?a=1&b=2', 'http://shop.example/', 'mailto:help@shop.example'])('W02 AS-47: %s stays a link with rel and target', (href) => {
    const link = html(`<p><a href="${href}" onclick="x()" title="t">go</a></p>`).querySelector('a');
    expect(link?.getAttribute('href')).toBe(href);
    expect(link?.getAttribute('rel')).toBe('nofollow ugc noopener noreferrer');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttributeNames().sort()).toEqual(['href', 'rel', 'target']);
  });

  it('W02 AS-47: the sender cannot choose rel or target', () => {
    const link = html('<a href="https://a.example" rel="opener" target="_self">x</a>').querySelector('a');
    expect(link?.getAttribute('rel')).toBe('nofollow ugc noopener noreferrer');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('W02 AS-47: headings of every level are shown as bold paragraphs', () => {
    const out = html('<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>');
    expect(out.querySelectorAll('h1,h2,h3,h4,h5,h6')).toHaveLength(0);
    const paragraphs = [...out.querySelectorAll('p > strong')].map((node) => node.textContent);
    expect(paragraphs).toEqual(['One', 'Two', 'Three', 'Four', 'Five', 'Six']);
  });

  it('W02 AS-47: nested quotes and broken markup stay inert text', () => {
    const out = html('<p title="a"b" onmouseover="alert(1)">x</p><a href=\'https://a.example" onclick="y\'>z</a>');
    // the injected handlers must not exist as attributes (they may survive only as escaped text inside an href value)
    const attributeNames = [...out.querySelectorAll('*')].flatMap((node) => node.getAttributeNames());
    expect(attributeNames.filter((name) => name !== 'href' && name !== 'rel' && name !== 'target')).toEqual([]);
    expect(out.textContent).toContain('x');
  });

  it('W02 AS-47: text that merely looks like markup is escaped, not interpreted', () => {
    expect(sanitizeBodyHtml('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('W02 AS-47: an empty or non-string body gives an empty string', () => {
    expect(sanitizeBodyHtml('')).toBe('');
    expect(sanitizeBodyHtml(undefined as never)).toBe('');
  });

  it('W02 AS-47: sanitising twice gives the same output', () => {
    const once = sanitizeBodyHtml('<h3>t</h3><a href="https://a.example">x</a><script>1</script>');
    expect(sanitizeBodyHtml(once)).toBe(once);
  });
});

describe('safeHttpsUrl', () => {
  it('W02 AS-72: accepts an absolute https URL and returns it unchanged', () => {
    expect(safeHttpsUrl('https://cdn.example/a.jpg?x=1')).toBe('https://cdn.example/a.jpg?x=1');
  });

  it.each([
    ['http', 'http://cdn.example/a.jpg'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:image/png;base64,AAAA'],
    ['relative', '/a.jpg'],
    ['protocol-relative', '//cdn.example/a.jpg'],
    ['empty', ''],
    ['not a URL', 'https//x'],
    ['credentials', 'https://user:pw@cdn.example/a.jpg'],
  ])('W02 AS-72: %s is ignored', (_name, value) => {
    expect(safeHttpsUrl(value)).toBeUndefined();
  });

  it('W02 AS-72: non-strings are ignored', () => {
    expect(safeHttpsUrl(null)).toBeUndefined();
    expect(safeHttpsUrl(undefined)).toBeUndefined();
    expect(safeHttpsUrl(42)).toBeUndefined();
  });
});
