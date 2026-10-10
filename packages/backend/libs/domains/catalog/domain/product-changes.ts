import type { ProductSnapshot } from '@marketplace-sandbox/contracts';
import type { ProductChanges } from './ports';
import type { ProductRecord } from './product-view';

type FieldName = Exclude<ProductSnapshot['changedFields'][number], 'shopId'>;

const FIELDS: readonly FieldName[] = [
  'title',
  'description',
  'brand',
  'category',
  'priceMinor',
  'currency',
  'quantity',
  'tags',
];

const sameTags = (a: string[], b: string[]) =>
  a.length === b.length && a.every((tag, i) => tag === b[i]);

/**
 * What an (already normalised) update really changes (AS-09): only the fields whose value differs from the stored
 * one. Empty `fields` means a no-op, which writes nothing and emits nothing.
 */
export function diffProduct(
  current: ProductRecord,
  input: ProductChanges,
): { changes: ProductChanges; fields: FieldName[] } {
  const changes: Record<string, unknown> = {};
  const fields: FieldName[] = [];
  for (const field of FIELDS) {
    const next = input[field];
    if (next === undefined) continue;
    const same =
      field === 'tags'
        ? sameTags(current.tags, next as string[])
        : current[field] === next;
    if (same) continue;
    changes[field] = next;
    fields.push(field);
  }
  return { changes: changes as ProductChanges, fields };
}
