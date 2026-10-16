export interface Alternate {
  locale: string;
  href: string;
}

const ENTITIES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  "'": '&apos;',
  '"': '&quot;',
};

export const xmlEscape = (value: string): string =>
  value.replace(/[<>&'"]/g, (c) => ENTITIES[c]);

/** `<front host>/<locale>/brands/<shopSlug>/stories/<slug>` (S27 AS-28). */
export const storyUrl = (
  front: string,
  locale: string,
  shopSlug: string,
  slug: string,
): string => `${front}/${locale}/brands/${shopSlug}/stories/${slug}`;

/**
 * One alternate per locale of the version plus `x-default` at the default locale. Shared by the public body and the
 * sitemap, so the two never disagree (S27 AS-28, AS-71).
 */
export function alternatesFor(
  front: string,
  shopSlug: string,
  slug: string,
  locales: readonly string[],
  defaultLocale: string,
): Alternate[] {
  return [
    ...locales.map((locale) => ({
      locale,
      href: storyUrl(front, locale, shopSlug, slug),
    })),
    {
      locale: 'x-default',
      href: storyUrl(front, defaultLocale, shopSlug, slug),
    },
  ];
}

export const urlsetOpen = (): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n`;

export const urlsetClose = (): string => '</urlset>\n';

export function urlEntryXml(entry: {
  loc: string;
  lastmod: Date;
  alternates: readonly Alternate[];
}): string {
  const links = entry.alternates
    .map(
      (a) =>
        `<xhtml:link rel="alternate" hreflang="${xmlEscape(a.locale)}" href="${xmlEscape(a.href)}"/>`,
    )
    .join('');
  return `  <url><loc>${xmlEscape(entry.loc)}</loc><lastmod>${entry.lastmod.toISOString()}</lastmod>${links}</url>\n`;
}

export const sitemapIndexXml = (locs: readonly string[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  locs
    .map((loc) => `  <sitemap><loc>${xmlEscape(loc)}</loc></sitemap>\n`)
    .join('') +
  `</sitemapindex>\n`;
