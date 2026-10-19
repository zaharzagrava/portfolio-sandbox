import { randomUUID } from 'node:crypto';
import {
  importJobSchema,
  importStartResponseSchema,
  productPageSchema,
  productSearchResponseSchema,
  type ImportJob,
  type ProductPage,
  type ProductSearchResponse,
} from '@marketplace-sandbox/contracts';
import { API_URL, type JourneyClient } from './journey-client';
import { waitForContract } from './wait-for-contract';

/** A shop the fixtures act for: its owner and id. */
export interface FixtureShop {
  owner: JourneyClient;
  shopId: string;
}

export interface CsvRow {
  sku: string;
  title: string;
  /** Decimal string, e.g. `12.50`. */
  price: string;
  category?: string;
  stock?: number;
  brand?: string;
  description?: string;
}

/** `rows` as CSV text (header `sku,title,price,category,stock,brand,description`); quotes are doubled, never needed for the tokens used. */
export function csv(rows: CsvRow[]): string {
  const cell = (value: string | number | undefined) => {
    const text = value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return (
    'sku,title,price,category,stock,brand,description\n' +
    rows
      .map((r) =>
        [
          r.sku,
          r.title,
          r.price,
          r.category ?? 'electronics',
          r.stock ?? 5,
          r.brand ?? 'Journey',
          r.description ?? `${r.title}. Imported by the J04 journey.`,
        ]
          .map(cell)
          .join(','),
      )
      .join('\n') +
    '\n'
  );
}

/** `count` rows whose titles carry `token` (the search key of the run) and whose SKUs are unique to the run. */
export function rowsFor(
  token: string,
  count: number,
  options: { priceCents?: number; stock?: number; title?: string } = {},
): CsvRow[] {
  return Array.from({ length: count }, (_, i) => ({
    sku: `${token}-${String(i + 1).padStart(3, '0')}`,
    title: `${options.title ?? 'Import Item'} ${token} ${i + 1}`,
    price: ((options.priceCents ?? 1000 + i * 10) / 100).toFixed(2),
    stock: options.stock ?? 5,
  }));
}

/**
 * A ZIP archive (stored, one entry) named like a CSV: its bytes begin with `PK`, so the import's content sniff must refuse it
 * whatever the name says (AS-04). Built by hand so the fixture needs no archive library.
 */
export function zipAsCsv(): Buffer {
  const name = Buffer.from('catalog.csv');
  const data = Buffer.from('sku,title,price,category\nZ-1,Zip,1.00,x\n');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, data]);
}

export interface StartedImport {
  importId: string;
  parts: { partNumber: number; url: string }[];
  partSize: number;
}

/** `POST /shops/:id/imports` with an idempotency key (same key + same body opens the same import, L-010). */
export async function startImport(
  shop: FixtureShop,
  fileName: string,
  sizeBytes: number,
  key: string = randomUUID(),
): Promise<StartedImport> {
  const started = await shop.owner.post(`/api/shops/${shop.shopId}/imports`, {
    body: { fileName, sizeBytes },
    key,
    schema: importStartResponseSchema,
  });
  if (started.status !== 200 && started.status !== 201)
    throw new Error(
      `start import: ${started.status} ${JSON.stringify(started.body)}`,
    );
  const body = importStartResponseSchema.parse(started.body);
  return {
    importId: body.importId,
    parts: body.parts,
    partSize: body.partSize,
  };
}

/** PUTs the content to the presigned part URLs and returns the `{partNumber, etag}` list `complete` wants. */
export async function uploadParts(
  started: StartedImport,
  content: Buffer,
): Promise<{ partNumber: number; etag: string }[]> {
  const done: { partNumber: number; etag: string }[] = [];
  for (const part of started.parts) {
    const from = (part.partNumber - 1) * started.partSize;
    const slice = content.subarray(from, from + started.partSize);
    const response = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(slice),
    });
    if (!response.ok)
      throw new Error(`upload part ${part.partNumber}: ${response.status}`);
    const etag = response.headers.get('etag');
    if (!etag) throw new Error(`upload part ${part.partNumber}: no ETag`);
    done.push({ partNumber: part.partNumber, etag });
  }
  return done;
}

/** `POST …/imports/:id/complete`; `202` accepts the import, any other status is returned to the caller's assertion. */
export async function completeImport(
  shop: FixtureShop,
  importId: string,
  parts: { partNumber: number; etag: string }[],
) {
  return shop.owner.post(
    `/api/shops/${shop.shopId}/imports/${importId}/complete`,
    {
      body: { parts },
    },
  );
}

/** Start, upload and complete in one go. `key` is the start's `Idempotency-Key`. */
export async function startAndComplete(
  shop: FixtureShop,
  fileName: string,
  content: Buffer | string,
  key: string = randomUUID(),
): Promise<{ importId: string; completeStatus: number }> {
  const buffer = typeof content === 'string' ? Buffer.from(content) : content;
  const started = await startImport(shop, fileName, buffer.length, key);
  const parts = await uploadParts(started, buffer);
  const completed = await completeImport(shop, started.importId, parts);
  return { importId: started.importId, completeStatus: completed.status };
}

export async function importStatus(
  shop: FixtureShop,
  importId: string,
): Promise<ImportJob> {
  const reply = await shop.owner.get(
    `/api/shops/${shop.shopId}/imports/${importId}`,
    { schema: importJobSchema },
  );
  if (reply.status !== 200)
    throw new Error(
      `import status: ${reply.status} ${JSON.stringify(reply.body)}`,
    );
  return importJobSchema.parse(reply.body);
}

const TERMINAL = new Set(['DONE', 'FAILED', 'CANCELLED', 'EXPIRED']);

/** J04.H1: polls the status until the import is terminal. The trigger of everything after it is `DONE`. */
export async function waitImportTerminal(
  shop: FixtureShop,
  importId: string,
): Promise<ImportJob> {
  return waitForContract('J04.H1', async () => {
    const job = await importStatus(shop, importId);
    return TERMINAL.has(job.status) ? job : null;
  });
}

/** Every product of the shop (all pages) as the member view. */
export async function listProducts(
  shop: FixtureShop,
  query: Record<string, string | number | undefined> = {},
): Promise<ProductPage['items']> {
  const items: ProductPage['items'] = [];
  let cursor: string | undefined;
  do {
    const reply = await shop.owner.get(`/api/shops/${shop.shopId}/products`, {
      query: { limit: 100, cursor, ...query },
      schema: productPageSchema,
    });
    if (reply.status !== 200)
      throw new Error(
        `list products: ${reply.status} ${JSON.stringify(reply.body)}`,
      );
    const page = productPageSchema.parse(reply.body);
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

/** The part of a search item the journey reads. */
export type FoundProduct = ProductSearchResponse['items'][number];

/**
 * `GET /products/search?q=` (anonymous), all pages (the page limit is 50). `total` is the index's `total.value`; the optional
 * `viewer` adds a token (a member of another shop must not see this shop's products).
 */
export async function searchProducts(
  q: string,
  options: { viewer?: JourneyClient; inStock?: boolean } = {},
): Promise<{ total: number; items: FoundProduct[] }> {
  const items: FoundProduct[] = [];
  let total = 0;
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ q, limit: '50' });
    if (cursor) params.set('cursor', cursor);
    if (options.inStock !== undefined)
      params.set('inStock', String(options.inStock));
    const response = await fetch(`${API_URL}/api/products/search?${params}`, {
      headers: options.viewer?.token
        ? { authorization: `Bearer ${options.viewer.token}` }
        : {},
    });
    if (response.status !== 200)
      throw new Error(
        `search ${q}: ${response.status} ${await response.text()}`,
      );
    const page = productSearchResponseSchema.parse(await response.json());
    items.push(...page.items);
    total = page.total.value;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return { total, items };
}
