import {
  DEFAULT_CATEGORY,
  buildItem,
  idString,
  isRecord,
  parseDate,
  reject,
  stripHtml,
  type NormaliseContext,
  type NormaliseResult,
} from './normalise';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const names = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.map((x) => (isRecord(x) ? str(x.name) : '')).filter((n) => n !== '')
    : [];

/**
 * WooCommerce product or variation -> at most one result (AS-12, AS-14, AS-52).
 * - simple: `externalId = <id>:<id>`; a `variable` parent yields no item (its variations are the items);
 * - variation (pass the parent as third argument): `<parentId>:<id>`, titled `"<parent> — <attribute options>"`
 *   (falls back to the variation SKU, then its id, when it has no attributes).
 * Stock: `stock_quantity` when `manage_stock` is true, otherwise `inventory_not_tracked`.
 */
export function normaliseWooProduct(
  product: unknown,
  ctx: NormaliseContext,
  parent?: unknown,
): NormaliseResult[] {
  if (!isRecord(product)) return [reject('invalid_payload', null)];
  const id = idString(product.id);
  if (id === null) return [reject('invalid_payload', null)];
  if (product.type === 'variable') return [];

  const isVariation = product.type === 'variation';
  const parentRecord = isRecord(parent) ? parent : null;
  let parentId = id;
  if (isVariation) {
    const p =
      idString(product.parent_id) ??
      (parentRecord ? idString(parentRecord.id) : null);
    if (p === null) return [reject('invalid_payload', null)];
    parentId = p;
  }
  const externalId = `${parentId}:${id}`;

  if (product.status !== 'publish') return [reject('unlisted', externalId)];

  let title = str(product.name);
  if (isVariation) {
    const base = str(parentRecord?.name);
    const options = Array.isArray(product.attributes)
      ? product.attributes
          .map((a) => (isRecord(a) ? str(a.option) : ''))
          .filter((o) => o !== '')
      : [];
    const suffix = options.length
      ? options.join(' / ')
      : str(product.sku) || id;
    title = base === '' ? '' : `${base} — ${suffix}`;
  }

  const source = isVariation && parentRecord ? parentRecord : product;
  const categories = names(source.categories);
  const tags = names(source.tags);
  const descriptionRaw =
    str(product.description) || str(parentRecord?.description);

  if (product.manage_stock !== true)
    return [
      title === ''
        ? reject('missing_title', externalId)
        : reject('inventory_not_tracked', externalId),
    ];

  return [
    buildItem({
      provider: 'woocommerce',
      ctx,
      externalId,
      title,
      description: stripHtml(descriptionRaw),
      brand: '',
      category: categories[0] ?? DEFAULT_CATEGORY,
      tags,
      priceRaw: product.price,
      stockRaw: product.stock_quantity,
      updatedAt: parseDate(product.date_modified_gmt, true),
    }),
  ];
}
