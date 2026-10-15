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

/**
 * Shopify REST product -> one result per variant (one variant = one marketplace product) (AS-12, AS-14, AS-52).
 * The stock of a variant is its `inventory_quantity` (the adapter overlays the primary-location level there).
 * Never throws; credentials are never read.
 */
export function normaliseShopifyProduct(
  product: unknown,
  ctx: NormaliseContext,
): NormaliseResult[] {
  if (!isRecord(product)) return [reject('invalid_payload', null)];
  const productId = idString(product.id);
  if (
    productId === null ||
    !Array.isArray(product.variants) ||
    product.variants.length === 0
  )
    return [reject('invalid_payload', null)];

  const baseTitle = str(product.title);
  const listed = product.status === 'active';
  const description =
    typeof product.body_html === 'string' ? stripHtml(product.body_html) : '';
  const category = str(product.product_type) || DEFAULT_CATEGORY;
  const brand = str(product.vendor);
  const tags =
    typeof product.tags === 'string'
      ? product.tags
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t !== '')
      : [];
  const productUpdated = parseDate(product.updated_at);
  const multi = product.variants.length > 1;

  return product.variants.map((variant: unknown): NormaliseResult => {
    if (!isRecord(variant)) return reject('invalid_payload', null);
    const variantId = idString(variant.id);
    if (variantId === null) return reject('invalid_payload', null);
    const externalId = `${productId}:${variantId}`;

    if (!listed) return reject('unlisted', externalId);
    if (baseTitle === '') return reject('missing_title', externalId);

    const variantTitle = str(variant.title);
    const title =
      multi && variantTitle !== '' && variantTitle !== 'Default Title'
        ? `${baseTitle} — ${variantTitle}`
        : baseTitle;

    if (
      variant.inventory_item_id === undefined ||
      variant.inventory_item_id === null
    )
      return reject('no_inventory_item', externalId);
    if (
      variant.inventory_management === undefined ||
      variant.inventory_management === null
    )
      return reject('inventory_not_tracked', externalId);

    const times = [productUpdated, parseDate(variant.updated_at)].filter(
      (d): d is Date => d !== null,
    );
    const updatedAt = times.length
      ? new Date(Math.max(...times.map((d) => d.getTime())))
      : null;

    return buildItem({
      provider: 'shopify',
      ctx,
      externalId,
      title,
      description,
      brand,
      category,
      tags,
      priceRaw: variant.price,
      stockRaw: variant.inventory_quantity,
      updatedAt,
    });
  });
}
