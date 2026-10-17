import * as Y from 'yjs';

/**
 * The shape of a listing draft document (S06 FR-012), shared with the server:
 *   Y.Text "title" and "description"    plain text, typed together
 *   Y.Map  "fields"                     priceMinor and quantity (integers), brand and category (text): last writer wins per key
 *   Y.Map  "specs"                      one row per specification, name to value
 * Reading is total: a value of the wrong type is shown as empty, the server reports it when publishing.
 */

export type Listing = {
  title: string;
  description: string;
  priceMinor: number | undefined;
  brand: string;
  category: string;
  quantity: number | undefined;
  specs: [string, string][];
};

const integer = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

export function readListing(doc: Y.Doc): Listing {
  const fields = doc.getMap<unknown>('fields');
  const specs: [string, string][] = [];
  for (const [key, value] of doc.getMap<unknown>('specs').entries()) if (typeof value === 'string') specs.push([key, value]);
  specs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    title: doc.getText('title').toJSON(),
    description: doc.getText('description').toJSON(),
    priceMinor: integer(fields.get('priceMinor')),
    brand: text(fields.get('brand')),
    category: text(fields.get('category')),
    quantity: integer(fields.get('quantity')),
    specs,
  };
}

/**
 * Replaces the text with `next` by editing only what differs (the common start and end stay), so another member's typing
 * around the change is kept. Indexes are UTF-16 units, as in `Y.Text`.
 */
export function setText(doc: Y.Doc, name: 'title' | 'description', next: string): void {
  const ytext = doc.getText(name);
  const current = ytext.toJSON();
  if (current === next) return;
  let start = 0;
  const shortest = Math.min(current.length, next.length);
  while (start < shortest && current.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  let end = 0;
  while (end < shortest - start && current.charCodeAt(current.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end += 1;
  doc.transact(() => {
    const removed = current.length - start - end;
    if (removed > 0) ytext.delete(start, removed);
    const added = next.slice(start, next.length - end);
    if (added.length > 0) ytext.insert(start, added);
  });
}

/** Sets one of the `fields`; `undefined` or an empty text removes the key (a missing value, which publishing reports). */
export function setField(doc: Y.Doc, key: 'priceMinor' | 'brand' | 'category' | 'quantity', value: string | number | undefined): void {
  const fields = doc.getMap<unknown>('fields');
  if (value === undefined || value === '') {
    if (fields.has(key)) fields.delete(key);
  } else if (fields.get(key) !== value) {
    fields.set(key, value);
  }
}

export function setSpec(doc: Y.Doc, name: string, value: string): void {
  const specs = doc.getMap<string>('specs');
  if (specs.get(name) !== value) specs.set(name, value);
}

export function removeSpec(doc: Y.Doc, name: string): void {
  const specs = doc.getMap<string>('specs');
  if (specs.has(name)) specs.delete(name);
}

/** Minor units as the text of an amount ("2450" in EUR is "24.50"), by string arithmetic. */
export function formatMinor(minor: number | undefined, fractionDigits: number): string {
  if (minor === undefined) return '';
  const digits = String(Math.abs(minor)).padStart(fractionDigits + 1, '0');
  const whole = digits.slice(0, digits.length - fractionDigits);
  const fraction = digits.slice(digits.length - fractionDigits);
  return `${minor < 0 ? '-' : ''}${whole}${fractionDigits > 0 ? `.${fraction}` : ''}`;
}
