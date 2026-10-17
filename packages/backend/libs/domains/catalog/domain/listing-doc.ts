import * as Y from 'yjs';

/**
 * Shape of a listing draft document (shared with the FE editor, S06 FR-012):
 *   Y.Text  "title"        - plain text, collaboratively typed
 *   Y.Text  "description"  - plain text
 *   Y.Map   "fields"       - priceMinor (integer minor units), brand, category, quantity (integer): last-writer-wins per key
 *   Y.Map   "specs"        - spec table rows ("Storage" -> "256 GB")
 *
 * Reading is total: a value of the wrong type becomes `undefined` and is reported by the publish validation, never thrown.
 */
export interface ListingContent {
  title: string;
  description: string;
  priceMinor: number | undefined;
  brand: string | undefined;
  category: string | undefined;
  quantity: number | undefined;
  specs: Record<string, string>;
}

const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

export function readListing(doc: Y.Doc): ListingContent {
  const fields = doc.getMap<unknown>('fields');
  const specs: [string, string][] = [];
  for (const [key, value] of doc.getMap<unknown>('specs').entries())
    if (typeof value === 'string') specs.push([key, value]);
  return {
    title: doc.getText('title').toJSON().trim(),
    description: doc.getText('description').toJSON(),
    priceMinor: integer(fields.get('priceMinor')),
    brand: text(fields.get('brand')),
    category: text(fields.get('category')),
    quantity: integer(fields.get('quantity')),
    specs: Object.fromEntries(specs),
  };
}

export function seedListing(content: Partial<ListingContent>): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    if (content.title) doc.getText('title').insert(0, content.title);
    if (content.description)
      doc.getText('description').insert(0, content.description);
    const fields = doc.getMap<unknown>('fields');
    for (const key of ['priceMinor', 'brand', 'category', 'quantity'] as const)
      if (content[key] !== undefined) fields.set(key, content[key]);
    for (const [k, v] of Object.entries(content.specs ?? {}))
      doc.getMap<string>('specs').set(k, v);
  });
  return doc;
}

const HEADING = 'Specifications';
/** Line terminators of JavaScript: LF, CR, and the two Unicode separators (built from code points so the source stays plain ASCII). */
const BREAKS = String.fromCharCode(0x0a, 0x0d, 0x2028, 0x2029);
const LINE_BREAK = new RegExp(`[${BREAKS}]`);
const SPEC_LINE = new RegExp(`^- ([^:${BREAKS}]+): (.+)$`);

/** A spec row survives a render/parse round trip only when key and value are non-empty, trimmed single-line text and the key has no colon. */
export function isValidSpecEntry(key: string, value: string): boolean {
  return (
    key.length > 0 &&
    key === key.trim() &&
    !key.includes(':') &&
    !LINE_BREAK.test(key) &&
    value.length > 0 &&
    value === value.trim() &&
    !LINE_BREAK.test(value)
  );
}

/** Description + blank line + `Specifications` + one `- key: value` line per row, keys sorted; an empty table adds nothing (S06 FR-030). */
export function renderSpecs(
  description: string,
  specs: Record<string, string>,
): string {
  const rows = Object.entries(specs)
    .filter(([k, v]) => isValidSpecEntry(k, v))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `- ${k}: ${v}`);
  if (rows.length === 0) return description;
  const section = `${HEADING}\n${rows.join('\n')}`;
  return description === '' ? section : `${description}\n\n${section}`;
}

/** Exact inverse of `renderSpecs` for a description without the reserved heading; text that has no well formed section is returned whole. */
export function parseSpecs(source: string): {
  description: string;
  specs: Record<string, string>;
} {
  const whole = { description: source, specs: {} };
  const inner = source.lastIndexOf(`\n\n${HEADING}\n`);
  let description: string;
  let tail: string;
  if (inner >= 0) {
    description = source.slice(0, inner);
    tail = source.slice(inner + HEADING.length + 3);
  } else if (source.startsWith(`${HEADING}\n`)) {
    description = '';
    tail = source.slice(HEADING.length + 1);
  } else return whole;
  const rows: [string, string][] = [];
  for (const line of tail.split('\n')) {
    const match = SPEC_LINE.exec(line);
    if (!match || !isValidSpecEntry(match[1], match[2])) return whole;
    rows.push([match[1], match[2]]);
  }
  return { description, specs: Object.fromEntries(rows) };
}
