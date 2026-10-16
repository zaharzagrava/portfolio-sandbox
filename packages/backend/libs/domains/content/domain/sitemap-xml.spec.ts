import {
  alternatesFor,
  sitemapIndexXml,
  storyUrl,
  urlEntryXml,
  urlsetClose,
  urlsetOpen,
  xmlEscape,
} from './sitemap-xml';

const FRONT = 'https://shop.example.com';

describe('S27 sitemap xml', () => {
  it('S27 AS-71: escapes the five XML characters', () => {
    expect(xmlEscape(`<a href="x" b='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; b=&apos;y&apos;&gt;&amp;',
    );
  });

  it('S27 AS-28: the url of a locale of a story', () => {
    expect(storyUrl(FRONT, 'uk', 'apple', 'inside-iphone-18')).toBe(
      'https://shop.example.com/uk/brands/apple/stories/inside-iphone-18',
    );
  });

  it('S27 AS-28: alternates list every locale and x-default at the default locale', () => {
    expect(alternatesFor(FRONT, 'apple', 'inside', ['en', 'uk'], 'en')).toEqual(
      [
        {
          locale: 'en',
          href: 'https://shop.example.com/en/brands/apple/stories/inside',
        },
        {
          locale: 'uk',
          href: 'https://shop.example.com/uk/brands/apple/stories/inside',
        },
        {
          locale: 'x-default',
          href: 'https://shop.example.com/en/brands/apple/stories/inside',
        },
      ],
    );
  });

  it('S27 AS-28: x-default follows the default locale, whatever its position', () => {
    const alternates = alternatesFor(
      FRONT,
      'apple',
      'inside',
      ['uk', 'en'],
      'en',
    );
    expect(alternates.at(-1)).toEqual({
      locale: 'x-default',
      href: 'https://shop.example.com/en/brands/apple/stories/inside',
    });
    expect(alternates.map((a) => a.locale)).toEqual(['uk', 'en', 'x-default']);
  });

  it('S27 AS-71: a url entry has loc, lastmod and one alternate per locale plus x-default', () => {
    const alternates = alternatesFor(
      FRONT,
      'apple',
      'inside',
      ['en', 'uk'],
      'en',
    );
    const xml = urlEntryXml({
      loc: alternates[0].href,
      lastmod: new Date('2026-10-16T12:00:00Z'),
      alternates,
    });
    expect(xml).toContain(
      '<loc>https://shop.example.com/en/brands/apple/stories/inside</loc>',
    );
    expect(xml).toContain('<lastmod>2026-10-16T12:00:00.000Z</lastmod>');
    expect(xml.match(/<xhtml:link /g)).toHaveLength(3);
    expect(xml).toContain('hreflang="x-default"');
    expect(xml).toContain('rel="alternate"');
  });

  it('S27 AS-71: a host or slug with markup characters never breaks the document', () => {
    const front = `https://a.example/?x=1&y="2"<'>`;
    const alternates = alternatesFor(front, 'ap&ple', 'in<side', ['en'], 'en');
    const xml = urlEntryXml({
      loc: alternates[0].href,
      lastmod: new Date('2026-10-16T12:00:00Z'),
      alternates,
    });
    expect(xml).not.toMatch(/<loc>[^<]*[<>"'][^<]*<\/loc>/);
    expect(xml).not.toContain('&y=');
    expect(xml).toContain('&amp;');
    // well formed: every ampersand starts an entity
    expect(xml.match(/&(?!amp;|lt;|gt;|quot;|apos;)/g)).toBeNull();
  });

  it('S27 AS-71: the urlset wrapper declares both namespaces', () => {
    expect(urlsetOpen()).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(urlsetOpen()).toContain(
      'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    );
    expect(urlsetOpen()).toContain(
      'xmlns:xhtml="http://www.w3.org/1999/xhtml"',
    );
    expect(urlsetClose()).toBe('</urlset>\n');
  });

  it('S27 AS-70: the index lists one sitemap per page', () => {
    const xml = sitemapIndexXml([
      'https://api.example.com/api/sitemaps/stories-0.xml',
      'https://api.example.com/api/sitemaps/stories-1.xml',
    ]);
    expect(xml).toContain(
      '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    expect(xml.match(/<sitemap><loc>/g)).toHaveLength(2);
    expect(xml).toContain('stories-1.xml</loc>');
  });
});
