export type ExtractResult =
  | {
      kind: 'price';
      amountMinor: number;
      currency: string;
      source: 'json-ld' | 'meta';
    }
  | { kind: 'out_of_stock' }
  | { kind: 'none' };

const MAX_MINOR = 10n ** 12n;

const ZERO_EXPONENT = new Set(
  'JPY KRW VND CLP ISK UGX XAF XOF XPF PYG RWF'.split(' '),
);
const THREE_EXPONENT = new Set('KWD BHD OMR JOD TND IQD LYD'.split(' '));

const CURRENCIES = new Set(
  (
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD ' +
    'CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD ' +
    'GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT ' +
    'LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR ' +
    'NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP ' +
    'STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF ' +
    'XPF YER ZAR ZMW ZWL'
  ).split(' '),
);

const exponentOf = (currency: string): number =>
  ZERO_EXPONENT.has(currency) ? 0 : THREE_EXPONENT.has(currency) ? 3 : 2;

/** Exact decimal string -> minor units, half-up; no floating point involved. */
function toMinor(amount: unknown, currency: string): number | null {
  const text =
    typeof amount === 'number'
      ? String(amount)
      : typeof amount === 'string'
        ? amount.trim()
        : '';
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const exp = exponentOf(currency);
  const frac = m[2] ?? '';
  let minor = BigInt(m[1] + frac.slice(0, exp).padEnd(exp, '0'));
  if (frac.length > exp && frac[exp] >= '5') minor += 1n;
  if (minor <= 0n || minor > MAX_MINOR) return null;
  return Number(minor);
}

function normalizeCurrency(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return CURRENCIES.has(code) ? code : null;
}

const asArray = (v: unknown): unknown[] =>
  Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const hasType = (node: Record<string, unknown>, type: string): boolean =>
  asArray(node['@type']).includes(type);

const OUT_OF_STOCK = /OutOfStock|Discontinued|SoldOut/i;

function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const m of html.matchAll(re)) {
    if (!/type\s*=\s*["']?\s*application\/ld\+json/i.test(m[1])) continue;
    const body = m[2]
      .replace(/<!--|-->|<!\[CDATA\[|\]\]>/g, '')
      .replace(/^\s*\/\/\s*$/gm, '')
      .trim();
    try {
      blocks.push(JSON.parse(body));
    } catch {
      continue;
    }
  }
  return blocks;
}

function productNodes(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const v of value) productNodes(v, out);
    return;
  }
  if (!isRecord(value)) return;
  if (hasType(value, 'Product')) out.push(value);
  productNodes(value['@graph'], out);
}

interface ProductOutcome {
  price: { amountMinor: number; currency: string } | null;
  outOfStock: boolean;
}

function evaluateProduct(node: Record<string, unknown>): ProductOutcome {
  const candidates: { amountMinor: number; currency: string }[] = [];
  let outOfStock = false;
  for (const o of asArray(node.offers)) {
    if (!isRecord(o)) continue;
    if (
      typeof o.availability === 'string' &&
      OUT_OF_STOCK.test(o.availability)
    ) {
      outOfStock = true;
      continue;
    }
    const currency = normalizeCurrency(o.priceCurrency);
    if (!currency) continue;
    const amount = hasType(o, 'AggregateOffer')
      ? (o.lowPrice ?? o.price)
      : o.price;
    const amountMinor = toMinor(amount, currency);
    if (amountMinor !== null) candidates.push({ amountMinor, currency });
  }
  if (new Set(candidates.map((c) => c.currency)).size > 1)
    return { price: null, outOfStock };
  const best = candidates.sort((a, b) => a.amountMinor - b.amountMinor)[0];
  return { price: best ?? null, outOfStock };
}

function parseAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of tag.replace(/^<\s*[a-z0-9]+/i, '').matchAll(re))
    attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

function metaPrice(html: string): ExtractResult {
  const values = new Map<string, string>();
  for (const m of html.matchAll(/<[a-z][a-z0-9]*\b[^>]*>/gi)) {
    const attrs = parseAttributes(m[0]);
    const content = attrs.get('content');
    if (content === undefined) continue;
    for (const key of ['property', 'name', 'itemprop']) {
      const name = attrs.get(key)?.trim().toLowerCase();
      if (name && !values.has(`${key === 'itemprop' ? 'i' : 'm'}:${name}`))
        values.set(`${key === 'itemprop' ? 'i' : 'm'}:${name}`, content);
    }
  }
  const pairs: [string | undefined, string | undefined][] = [
    [
      values.get('m:product:price:amount'),
      values.get('m:product:price:currency'),
    ],
    [values.get('m:og:price:amount'), values.get('m:og:price:currency')],
    [values.get('i:price'), values.get('i:pricecurrency')],
  ];
  for (const [amount, rawCurrency] of pairs) {
    const currency = normalizeCurrency(rawCurrency);
    if (!currency) continue;
    const amountMinor = toMinor(amount, currency);
    if (amountMinor !== null)
      return { kind: 'price', amountMinor, currency, source: 'meta' };
  }
  return { kind: 'none' };
}

/**
 * Price from structured data first (schema.org Product offers, also inside
 * @graph), then meta tags. Never scraped from free text: a "was €199" banner
 * must not become the price. Ambiguity yields no price rather than a guess.
 */
export function extractPrice(html: string): ExtractResult {
  const products: Record<string, unknown>[] = [];
  for (const block of jsonLdBlocks(html)) productNodes(block, products);
  let outOfStock = false;
  for (const product of products) {
    const outcome = evaluateProduct(product);
    if (outcome.price)
      return { kind: 'price', ...outcome.price, source: 'json-ld' };
    outOfStock ||= outcome.outOfStock;
  }
  if (outOfStock) return { kind: 'out_of_stock' };
  return metaPrice(html);
}
