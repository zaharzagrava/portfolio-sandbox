import type { ListingProblem } from './draft-errors';
import type { ProductFields } from './draft-ports';
import { renderSpecs, type ListingContent } from './listing-doc';
import { parseCreateInput } from './product-input';

/** A category the draft left empty is published under this one (S05 requires a category; the draft may not have set it). */
export const DEFAULT_CATEGORY = 'uncategorized';

export type ListingCheck =
  { ok: true; fields: ProductFields } | { ok: false; errors: ListingProblem[] };

/**
 * Whether the draft's content can become a product (S06 FR-027). The limits are S05's own: the content goes through
 * the product create parser, so a change of a limit there is a change here. Spec rows are rendered into the description.
 * `present` says whether the document holds a value under the key at all (a value of the wrong type reads as `undefined`
 * and is reported `invalid`, a missing one `required`).
 */
export function validateListing(
  content: ListingContent,
  present: (key: 'priceMinor' | 'brand' | 'category' | 'quantity') => boolean,
): ListingCheck {
  const input: Record<string, unknown> = {
    title: content.title,
    description: renderSpecs(content.description, content.specs),
    category: content.category ?? DEFAULT_CATEGORY,
  };
  if (content.brand !== undefined) input.brand = content.brand;
  if (content.priceMinor !== undefined) input.priceMinor = content.priceMinor;
  if (content.quantity !== undefined) input.quantity = content.quantity;

  const wrongTyped = (['priceMinor', 'brand', 'category', 'quantity'] as const)
    .filter((k) => content[k] === undefined && present(k))
    .map((field): ListingProblem => ({ field, code: 'invalid' }));
  const parsed = parseCreateInput(input);
  if (parsed.ok && wrongTyped.length === 0) {
    const v = parsed.value;
    return {
      ok: true,
      fields: {
        title: v.title,
        description: v.description ?? '',
        brand: v.brand,
        category: v.category,
        priceMinor: v.priceMinor,
        quantity: v.quantity ?? 0,
      },
    };
  }
  const errors = new Map<string, ListingProblem>(
    wrongTyped.map((p) => [p.field, p]),
  );
  if (!parsed.ok)
    for (const field of parsed.fields)
      if (!errors.has(field))
        errors.set(field, {
          field,
          code: input[field] === undefined ? 'required' : 'invalid',
        });
  return { ok: false, errors: [...errors.values()] };
}
