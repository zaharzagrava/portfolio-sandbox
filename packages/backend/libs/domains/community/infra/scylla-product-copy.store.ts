import { Injectable } from '@nestjs/common';
import type { types } from 'cassandra-driver';
import type { ProductCopyStore } from '../domain/ports';
import {
  applyProductEvent,
  type GuardResult,
  type ProductCopy,
  type ProductCopyEvent,
} from '../domain/version-guard';
import { FeedScylla, long } from './feed-scylla';

const IN_CHUNK = 100;
/** Compare-and-set attempts for one product (each lost attempt means another event moved the copy forward). */
const MAX_ATTEMPTS = 10;

const chunks = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, (i + 1) * size),
  );

const num = (v: types.Long | number): number =>
  typeof v === 'number' ? v : v.toNumber();

const toCopy = (row: types.Row): ProductCopy => ({
  productId: row.product_id,
  shopId: row.shop_id,
  title: row.title ?? '',
  priceMinor: num(row.price_minor ?? 0),
  currency: row.currency ?? '',
  status: row.status,
  isSandbox: row.is_sandbox === true,
  productVersion: num(row.product_version ?? 0),
});

const COLUMNS =
  'product_id, shop_id, title, price_minor, currency, status, is_sandbox, product_version';

/**
 * The product fields the feed shows, owned by `community` (R3, S26 B4, D-7, D-12): a version-guarded upsert from S05's
 * snapshot events (a conditional write on the stored version, so concurrent and out-of-order events converge on the
 * highest version), `DELETED` as the tombstone state, and the posts deleted before their creation event arrived.
 */
@Injectable()
export class ScyllaProductCopyStore implements ProductCopyStore {
  constructor(private readonly db: FeedScylla) {}

  async get(productId: string): Promise<ProductCopy | null> {
    const row = (
      await this.db.read(
        `SELECT ${COLUMNS} FROM product_copies WHERE product_id = ?`,
        [productId],
      )
    ).first();
    return row ? toCopy(row) : null;
  }

  async getMany(productIds: string[]): Promise<Map<string, ProductCopy>> {
    const out = new Map<string, ProductCopy>();
    for (const part of chunks([...new Set(productIds)], IN_CHUNK)) {
      const result = await this.db.read(
        `SELECT ${COLUMNS} FROM product_copies WHERE product_id IN ?`,
        [part],
      );
      for (const row of result.rows) out.set(row.product_id, toCopy(row));
    }
    return out;
  }

  async apply(event: ProductCopyEvent, at: Date): Promise<GuardResult> {
    const productId =
      event.kind === 'snapshot' ? event.copy.productId : event.productId;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = await this.get(productId);
      const result = applyProductEvent(current, event);
      if (!result.applied || !result.copy) return result;
      const c = result.copy;
      const values = [
        c.shopId,
        c.title,
        long(c.priceMinor),
        c.currency,
        c.status,
        c.isSandbox,
        long(c.productVersion),
        at,
      ];
      const { applied } = current
        ? await this.db.lwt(
            'UPDATE product_copies SET shop_id = ?, title = ?, price_minor = ?, currency = ?, status = ?, is_sandbox = ?, product_version = ?, updated_at = ? WHERE product_id = ? IF product_version = ?',
            [...values, productId, long(current.productVersion)],
          )
        : await this.db.lwt(
            'INSERT INTO product_copies (shop_id, title, price_minor, currency, status, is_sandbox, product_version, updated_at, product_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) IF NOT EXISTS',
            [...values, productId],
          );
      if (applied) return result;
    }
    // contended beyond the budget: the framework redelivers the event
    throw new Error('product copy contended');
  }

  async isPostDeleted(postId: string): Promise<boolean> {
    return (
      (
        await this.db.read(
          'SELECT post_id FROM post_tombstones WHERE post_id = ?',
          [postId],
        )
      ).first() !== null
    );
  }

  async tombstonePost(postId: string, at: Date): Promise<void> {
    await this.db.write(
      'INSERT INTO post_tombstones (post_id, deleted_at) VALUES (?, ?)',
      [postId, at],
    );
  }
}
