/**
 * A small well-formedness check for the sitemap documents the specs read: tags nest and close, attribute values are
 * quoted and hold no raw `<`, text holds no raw `<` or bare `&`. The sitemaps are machine-written, so this is enough to
 * prove that escaping never breaks the document; it is not a general XML parser.
 */
export function assertWellFormedXml(xml: string): void {
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  let match: RegExpExecArray | null;
  const text = (segment: string) => {
    if (/[<>]/.test(segment)) throw new Error('raw < or > in text');
    if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(segment))
      throw new Error('bare & in text');
  };
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, '');
  while ((match = tag.exec(body))) {
    text(body.slice(last, match.index));
    last = tag.lastIndex;
    const [, closing, name, attributes, selfClosing] = match;
    if (attributes && /&(?!amp;|lt;|gt;|quot;|apos;)/.test(attributes))
      throw new Error('bare & in an attribute');
    if (closing) {
      if (stack.pop() !== name) throw new Error(`unbalanced </${name}>`);
    } else if (!selfClosing) stack.push(name);
  }
  text(body.slice(last));
  if (stack.length > 0)
    throw new Error(`unclosed <${stack[stack.length - 1]}>`);
}

const unescape = (value: string): string =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

export interface SitemapUrl {
  loc: string;
  lastmod: string;
  alternates: { hreflang: string; href: string }[];
}

export function parseUrlset(xml: string): SitemapUrl[] {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([, inner]) => ({
    loc: unescape(/<loc>([^<]*)<\/loc>/.exec(inner)?.[1] ?? ''),
    lastmod: /<lastmod>([^<]*)<\/lastmod>/.exec(inner)?.[1] ?? '',
    alternates: [
      ...inner.matchAll(
        /<xhtml:link rel="alternate" hreflang="([^"]*)" href="([^"]*)"\/>/g,
      ),
    ].map(([, hreflang, href]) => ({
      hreflang: unescape(hreflang),
      href: unescape(href),
    })),
  }));
}

export function parseIndex(xml: string): string[] {
  return [...xml.matchAll(/<sitemap><loc>([^<]*)<\/loc><\/sitemap>/g)].map(
    ([, loc]) => unescape(loc),
  );
}
