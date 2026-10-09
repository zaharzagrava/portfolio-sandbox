import * as Y from 'yjs';

/**
 * Shape of a listing draft document (shared with the FE editor):
 *   Y.Text  "title"        - plain text, collaboratively typed
 *   Y.Text  "description"  - rich text (TipTap/ProseMirror binds an XmlFragment in the FE; plain Y.Text here)
 *   Y.Map   "fields"       - price (minor units), brand, category, quantity: last-writer-wins per key
 *   Y.Map   "specs"        - spec table rows ("Storage" → "256 GB")
 */
export interface ListingContent {
  title: string;
  description: string;
  price: number | null;
  brand: string | null;
  category: string | null;
  quantity: number | null;
  specs: Record<string, string>;
}

export function readListing(doc: Y.Doc): ListingContent {
  const fields = doc.getMap<unknown>('fields');
  const num = (k: string) =>
    typeof fields.get(k) === 'number' ? (fields.get(k) as number) : null;
  const str = (k: string) =>
    typeof fields.get(k) === 'string' ? (fields.get(k) as string) : null;
  return {
    title: doc.getText('title').toString().trim(),
    description: doc.getText('description').toString(),
    price: num('price'),
    brand: str('brand'),
    category: str('category'),
    quantity: num('quantity'),
    specs: Object.fromEntries(
      [...doc.getMap<string>('specs').entries()].map(([k, v]) => [
        k,
        String(v),
      ]),
    ),
  };
}

export function seedListing(content: Partial<ListingContent>): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    if (content.title) doc.getText('title').insert(0, content.title);
    if (content.description)
      doc.getText('description').insert(0, content.description);
    const fields = doc.getMap<unknown>('fields');
    for (const key of ['price', 'brand', 'category', 'quantity'] as const)
      if (content[key] !== undefined && content[key] !== null)
        fields.set(key, content[key]);
    for (const [k, v] of Object.entries(content.specs ?? {}))
      doc.getMap<string>('specs').set(k, v);
  });
  return doc;
}
