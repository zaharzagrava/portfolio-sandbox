export interface ExtractedPrice {
  amountMinor: number;
  currency: string;
  source: 'json-ld' | 'meta';
}

const toMinor = (value: unknown): number | null => {
  const n =
    typeof value === 'number'
      ? value
      : Number(String(value ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};

/**
 * Price from structured data first (schema.org Product → offers: Offer /
 * AggregateOffer, also inside @graph), then OpenGraph / itemprop meta tags.
 * Never scraped from free text: a "was €199" banner must not become the price.
 */
export function extractPrice(html: string): ExtractedPrice | null {
  for (const match of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    let data: unknown;
    try {
      data = JSON.parse(match[1]);
    } catch {
      continue;
    }
    const nodes = (Array.isArray(data) ? data : [data]).flatMap(
      (d) => ((d as { '@graph'?: unknown[] })['@graph'] as unknown[]) ?? [d],
    ) as Record<string, unknown>[];
    for (const node of nodes) {
      const type = ([] as unknown[]).concat(node['@type']).map(String);
      if (!type.includes('Product')) continue;
      for (const offer of ([] as unknown[]).concat(node.offers ?? []) as Record<
        string,
        unknown
      >[]) {
        const amount = toMinor(offer.price ?? offer.lowPrice);
        if (amount !== null)
          return {
            amountMinor: amount,
            currency: String(offer.priceCurrency ?? 'USD').toUpperCase(),
            source: 'json-ld',
          };
      }
    }
  }
  const meta = (name: string) =>
    new RegExp(
      `<meta[^>]+(?:property|name|itemprop)=["']${name}["'][^>]*content=["']([^"']+)["']`,
      'i',
    ).exec(html)?.[1];
  const amount = toMinor(
    meta('product:price:amount') ?? meta('og:price:amount') ?? meta('price'),
  );
  if (amount === null) return null;
  return {
    amountMinor: amount,
    currency: (
      meta('product:price:currency') ??
      meta('og:price:currency') ??
      meta('priceCurrency') ??
      'USD'
    ).toUpperCase(),
    source: 'meta',
  };
}
