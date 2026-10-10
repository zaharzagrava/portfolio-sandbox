import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import type {
  ProductMemberView,
  ProductPage,
} from '@marketplace-sandbox/contracts';
import { ApiConfigService, PlatformSettings } from '@app/common/config';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { ShopQueryService } from '@app/domains/tenancy';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  PRODUCT_REPOSITORY,
  STATUS_HISTORY_REPOSITORY,
  type ProductRepository,
  type StatusHistoryRepository,
} from '../domain/ports';
import { diffProduct } from '../domain/product-changes';
import {
  decodeProductCursor,
  encodeProductCursor,
  type CursorKey,
  type CursorScope,
} from '../domain/product-cursor';
import {
  CurrencyNotSupportedError,
  InvalidCursorError,
  InvalidTransitionError,
  ProductArchivedError,
  ProductNotFoundError,
  ProductValidationError,
  ShopNotActiveError,
  VersionConflictError,
} from '../domain/product-errors';
import {
  parseCreateInput,
  parseListQuery,
  parseUpdateInput,
} from '../domain/product-input';
import { productWriteCounter } from '../domain/product-metrics';
import {
  applyTransition,
  type ProductTransition,
} from '../domain/product-status';
import { toMemberView, type ProductRecord } from '../domain/product-view';
import { snapshotEvent } from './events/product-events';
import { ProductAudit, type ProductAuditAction } from './product-audit';
import { ProductCacheInvalidation } from './product-cache-invalidation.service';

type Operation = 'create' | 'update' | 'archive' | 'restore';

/**
 * The one write path of products (R1, HTTP and other capabilities alike). Every write is a single transaction that
 * holds the conditional row write, the status-history row (transitions) and one full-state event on the outbox; the
 * cache entry is dropped after the commit. Shop facts are read before the transaction (III.3).
 */
@Injectable()
export class ProductCommandService {
  private readonly currency: string;

  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: ProductRepository,
    @Inject(STATUS_HISTORY_REPOSITORY)
    private readonly history: StatusHistoryRepository,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    private readonly shops: ShopQueryService,
    private readonly invalidation: ProductCacheInvalidation,
    private readonly audit: ProductAudit,
    config: ApiConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.currency = new PlatformSettings(config).currency;
  }

  async create(
    shopId: string,
    actorId: string | null,
    input: unknown,
  ): Promise<ProductMemberView> {
    const parsed = parseCreateInput(input);
    if (!parsed.ok) throw this.refused('create', parsed.fields);
    const value = parsed.value;
    this.assertCurrency('create', value.currency);
    const shop = await this.activeShop('create', shopId);

    const now = this.clock.now();
    const record = await this.runner.run(async () => {
      const created = await this.products.insert({
        id: uuidv7(),
        shopId,
        createdBy: actorId,
        isSandbox: shop.isSandbox,
        title: value.title,
        description: value.description ?? '',
        brand: value.brand,
        category: value.category,
        priceMinor: value.priceMinor,
        currency: value.currency ?? this.currency,
        quantity: value.quantity ?? 0,
        tags: value.tags ?? [],
        now,
      });
      await this.outbox.append(snapshotEvent('created', created, []));
      return created;
    });
    return this.done('create', 'product.created', record, actorId);
  }

  async update(
    shopId: string,
    productId: string,
    input: unknown,
    actorId: string | null = null,
  ): Promise<ProductMemberView> {
    const parsed = parseUpdateInput(input);
    if (!parsed.ok) throw this.refused('update', parsed.fields);
    const { expectedVersion, ...edit } = parsed.value;
    this.assertCurrency('update', edit.currency);
    await this.activeShop('update', shopId);

    const now = this.clock.now();
    const outcome = await this.run('update', async () => {
      const current = await this.mustFind(shopId, productId);
      if (current.version !== expectedVersion)
        throw new VersionConflictError(current.version);
      if (current.status === 'ARCHIVED') throw new ProductArchivedError();
      const { changes, fields } = diffProduct(current, edit);
      if (fields.length === 0) return { record: current, changed: false };
      const updated = await this.products.update(
        shopId,
        productId,
        expectedVersion,
        changes,
        now,
      );
      if (!updated) throw await this.lostRace(shopId, productId);
      await this.outbox.append(snapshotEvent('updated', updated, fields));
      return { record: updated, changed: true };
    });
    if (!outcome.changed) return toMemberView(outcome.record);
    return this.done('update', 'product.updated', outcome.record, actorId);
  }

  archive(
    shopId: string,
    productId: string,
    expectedVersion: number,
    actorId: string | null = null,
  ): Promise<ProductMemberView> {
    return this.transition(
      'archive',
      shopId,
      productId,
      expectedVersion,
      actorId,
    );
  }

  restore(
    shopId: string,
    productId: string,
    expectedVersion: number,
    actorId: string | null = null,
  ): Promise<ProductMemberView> {
    return this.transition(
      'restore',
      shopId,
      productId,
      expectedVersion,
      actorId,
    );
  }

  async getForShop(
    shopId: string,
    productId: string,
  ): Promise<ProductMemberView> {
    return toMemberView(await this.mustFind(shopId, productId));
  }

  async listByShop(shopId: string, query: unknown): Promise<ProductPage> {
    const parsed = parseListQuery((query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) throw new ProductValidationError(parsed.fields);
    const { status, category, inStock, limit, cursor } = parsed.value;
    const scope: CursorScope = { shopId, status, category, inStock };
    let after: CursorKey | null = null;
    if (cursor !== null) {
      after = decodeProductCursor(cursor, scope);
      if (!after) throw new InvalidCursorError();
    }
    const found = await this.products.listByShop(
      shopId,
      { status, category, inStock },
      after,
      limit + 1,
    );
    const page = found.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => toMemberView(row.record)),
      nextCursor:
        found.length > limit && last
          ? encodeProductCursor(last.key, scope)
          : null,
    };
  }

  private async transition(
    kind: ProductTransition,
    shopId: string,
    productId: string,
    expectedVersion: number,
    actorId: string | null,
  ): Promise<ProductMemberView> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1)
      throw this.refused(kind, ['expectedVersion']);
    await this.activeShop(kind, shopId);

    const now = this.clock.now();
    const record = await this.run(kind, async () => {
      const current = await this.mustFind(shopId, productId);
      if (current.version !== expectedVersion)
        throw new VersionConflictError(current.version);
      const move = applyTransition(current.status, kind);
      if (!move.ok) throw new InvalidTransitionError();
      const moved = await this.products.transition(
        shopId,
        productId,
        current.status,
        move.to,
        expectedVersion,
        now,
      );
      if (!moved) throw await this.lostRace(shopId, productId);
      await this.history.append({
        productId,
        shopId,
        fromStatus: current.status,
        toStatus: move.to,
        productVersion: moved.version,
        actorId,
        at: now,
      });
      await this.outbox.append(
        snapshotEvent(kind === 'archive' ? 'archived' : 'restored', moved, []),
      );
      return moved;
    });
    return this.done(
      kind,
      kind === 'archive' ? 'product.archived' : 'product.restored',
      record,
      actorId,
    );
  }

  /** One transaction; a domain refusal is counted by its kind before it propagates. */
  private async run<T>(operation: Operation, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.runner.run(fn);
    } catch (error) {
      productWriteCounter.add(1, {
        operation,
        result:
          error instanceof VersionConflictError
            ? 'conflict'
            : error instanceof ProductNotFoundError
              ? 'not_found'
              : error instanceof InvalidTransitionError ||
                  error instanceof ProductArchivedError
                ? 'refused'
                : 'error',
      });
      throw error;
    }
  }

  private async done(
    operation: Operation,
    action: ProductAuditAction,
    record: ProductRecord,
    actorId: string | null,
  ): Promise<ProductMemberView> {
    await this.invalidation.afterWrite([
      { productId: record.id, version: record.version },
    ]);
    productWriteCounter.add(1, { operation, result: 'ok' });
    this.audit.record(action, {
      shopId: record.shopId,
      productId: record.id,
      actorId,
      version: record.version,
    });
    return toMemberView(record);
  }

  private refused(operation: Operation, fields: string[]) {
    productWriteCounter.add(1, { operation, result: 'invalid' });
    return new ProductValidationError(fields);
  }

  private assertCurrency(operation: Operation, currency: string | undefined) {
    if (currency === undefined || currency === this.currency) return;
    productWriteCounter.add(1, { operation, result: 'refused' });
    throw new CurrencyNotSupportedError();
  }

  private async activeShop(operation: Operation, shopId: string) {
    const shop = (await this.shops.getShopsByIds([shopId])).get(shopId);
    if (!shop || shop.status !== 'ACTIVE') {
      productWriteCounter.add(1, { operation, result: 'refused' });
      throw new ShopNotActiveError(
        shop?.status === 'SUSPENDED' || shop?.status === 'DELETING'
          ? shop.status
          : 'DELETED',
      );
    }
    return shop;
  }

  private async mustFind(shopId: string, productId: string) {
    const found = await this.products.findInShop(shopId, productId);
    if (!found) throw new ProductNotFoundError();
    return found;
  }

  /** A conditional write matched no row: someone else got there first. Say why from the current row. */
  private async lostRace(shopId: string, productId: string) {
    const now = await this.products.findInShop(shopId, productId);
    if (!now) return new ProductNotFoundError();
    return new VersionConflictError(now.version);
  }
}
