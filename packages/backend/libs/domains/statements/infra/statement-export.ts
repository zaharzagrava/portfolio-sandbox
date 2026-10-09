import { Readable, Transform, TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import type { Pool } from 'pg';
import QueryStream from 'pg-query-stream';

const COLUMNS = [
  'orderId',
  'orderedAt',
  'productId',
  'category',
  'quantity',
  'unitPrice',
  'lineTotal',
] as const;

/** Spreadsheet-safe CSV cell: quote everything, double quotes, neutralize formula injection (=, +, -, @). */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

class CsvRows extends Transform {
  constructor() {
    super({ writableObjectMode: true });
    this.push(COLUMNS.join(',') + '\n');
  }

  _transform(
    row: Record<string, unknown>,
    _enc: BufferEncoding,
    done: TransformCallback,
  ) {
    done(null, COLUMNS.map((c) => csvCell(row[c])).join(',') + '\n');
  }
}

/**
 * Streams a shop's statement lines straight from a server-side Postgres
 * cursor to the HTTP response (lesson 02/02 §4.1): constant memory for
 * millions of rows, and `pipeline` propagates backpressure end to end - a slow
 * client pauses the cursor instead of buffering the whole month in RAM - and
 * destroys every stage (releasing the DB connection) if the client disconnects.
 */
export async function streamStatementCsv(
  pool: Pool,
  shopId: string,
  month: string,
  out: Writable,
): Promise<void> {
  const client = await pool.connect();
  try {
    const query = new QueryStream(
      `SELECT o.id AS "orderId", o."createdAt" AS "orderedAt", i."productId", p.category, i.quantity,
              i."priceAtPurchase" AS "unitPrice", i."priceAtPurchase" * i.quantity AS "lineTotal"
       FROM "BisOrderItem" i JOIN "BisOrder" o ON o.id = i."bisOrderId" JOIN "Product" p ON p.id = i."productId"
       WHERE i."shopId" = $1 AND o.status IN ('PAID','FULFILLING','SHIPPED','DELIVERED')
         AND o."createdAt" >= $2::date AND o."createdAt" < $2::date + interval '1 month'
       ORDER BY o."createdAt"`,
      [shopId, month],
      { batchSize: 1_000 },
    );
    await pipeline(
      client.query(query) as unknown as Readable,
      new CsvRows(),
      out,
    );
  } finally {
    client.release();
  }
}
