import { Injectable } from '@nestjs/common';
import { AppError } from '@app/common/errors';
import {
  ProductArchivedError,
  ProductCommandService,
  ProductNotFoundError,
  ProductQueryService,
  ProductStockService,
  VersionConflictError,
} from '@app/domains/catalog';
import { SYNC_FIELDS, type SyncField } from '@marketplace-sandbox/contracts';
import type {
  SyncCatalogGateway,
  SyncProductPage,
  SyncProductView,
  SyncStockCommand,
  SyncStockOutcome,
  SyncUpdateOutcome,
} from '../domain/ports';

interface ProductLike {
  id: string;
  version: number;
  quantity: number;
  status: 'ACTIVE' | 'ARCHIVED';
  title: string;
  description: string;
  priceMinor: number;
  currency: string;
}

const view = (p: ProductLike): SyncProductView => ({
  id: p.id,
  version: p.version,
  quantity: p.quantity,
  status: p.status,
  data: {
    title: p.title,
    description: p.description,
    priceMinor: p.priceMinor,
    currency: p.currency,
    quantity: p.quantity,
    status: p.status,
  },
});

const LISTED = ['ACTIVE', 'ARCHIVED'] as const;

/**
 * The catalog's exported services behind the gateway port (R1): stock only through `applyStockDelta`, fields only
 * through `update`, reads through `getProductsByIds` / `listByShop`. No catalog model, no catalog table, no product
 * event is touched here (IX.4, S05 FR-042).
 */
@Injectable()
export class SyncCatalogServicesGateway implements SyncCatalogGateway {
  constructor(
    private readonly stock: ProductStockService,
    private readonly query: ProductQueryService,
    private readonly commands: ProductCommandService,
  ) {}

  async applyStock(command: SyncStockCommand): Promise<SyncStockOutcome> {
    const result = await this.stock.applyStockDelta([
      {
        operationId: command.operationId,
        productId: command.productId,
        shopId: command.shopId,
        delta: command.delta,
        reason: command.reason,
      },
    ]);
    if (result.outcome === 'rejected') {
      const failure = result.failures[0];
      return { kind: 'rejected', code: failure.code };
    }
    const done = result.results[0];
    return {
      kind: 'applied',
      quantityAfter: done.quantityAfter,
      productVersion: done.productVersion,
      replayed: done.replayed,
    };
  }

  async product(
    shopId: string,
    productId: string,
  ): Promise<SyncProductView | null> {
    const found = await this.query.getProductsByIds([productId], { shopId });
    const product = found.get(productId.toLowerCase());
    return product ? view(product as ProductLike) : null;
  }

  async updateFields(
    shopId: string,
    productId: string,
    expectedVersion: number,
    fields: Partial<Record<SyncField, string | number>>,
    actorId: string | null,
  ): Promise<SyncUpdateOutcome> {
    try {
      const updated = await this.commands.update(
        shopId,
        productId,
        { expectedVersion, ...fields },
        actorId,
      );
      return { kind: 'updated', version: updated.version };
    } catch (error) {
      if (error instanceof VersionConflictError)
        return { kind: 'version_conflict' };
      if (error instanceof ProductArchivedError) return { kind: 'archived' };
      if (error instanceof ProductNotFoundError) return { kind: 'not_found' };
      const invalid = invalidFields(error);
      if (invalid) return { kind: 'invalid', fields: invalid };
      throw error;
    }
  }

  async listProducts(
    shopId: string,
    cursor: string | null,
  ): Promise<SyncProductPage> {
    // The catalog lists one status at a time; the feed needs both, ACTIVE first.
    const position = cursor
      ? (JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
          status: (typeof LISTED)[number];
          cursor: string | null;
        })
      : { status: LISTED[0], cursor: null };
    const page = await this.commands.listByShop(shopId, {
      status: position.status,
      limit: '100',
      ...(position.cursor ? { cursor: position.cursor } : {}),
    });
    const items = page.items.map((p) => view(p as ProductLike));
    let next: {
      status: (typeof LISTED)[number];
      cursor: string | null;
    } | null = null;
    if (page.nextCursor)
      next = { status: position.status, cursor: page.nextCursor };
    else if (position.status === 'ACTIVE')
      next = { status: 'ARCHIVED', cursor: null };
    return {
      items,
      nextCursor: next
        ? Buffer.from(JSON.stringify(next)).toString('base64url')
        : null,
    };
  }
}

/** The fields the catalog refused, from its typed `validation_failed` problem (`errors: [{field, code}]`). */
function invalidFields(error: unknown): SyncField[] | null {
  if (!(error instanceof AppError) || error.code !== 'validation_failed')
    return null;
  const errors = (error.extensions?.errors ?? []) as Array<{ field?: string }>;
  return errors
    .map((e) => e.field)
    .filter((f): f is SyncField =>
      (SYNC_FIELDS as readonly string[]).includes(f ?? ''),
    );
}
