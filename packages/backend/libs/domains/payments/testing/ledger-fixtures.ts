import { QueryTypes } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import type { INestApplication } from '@nestjs/common';
import { Sequelize } from 'sequelize-typescript';
import { journalPostedV2Schema } from '@marketplace-sandbox/contracts';
import { orderEvents } from '../application/events/order-events';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';

/** A fresh seller account id (a plain uuid: no shop row is needed for a ledger account to exist). */
export const newShopAccount = (): string => `SHOP_${uuidv4()}`;

/** A contract-valid `order.paid` for the settlement consumer (built from `packages/contracts`, like the producer). */
export function orderPaidEvent(input: {
  orderId: string;
  /** One line per shop worth its subtotal, in `category` (none = the line carries none). */
  shops: { shopId: string; subtotalMinor: number; category?: string }[];
  totalMinor?: number;
  currency?: string;
  paymentRef?: string;
  version?: number;
  paidAt?: Date;
}) {
  const version = input.version ?? 3;
  const total =
    input.totalMinor ?? input.shops.reduce((s, x) => s + x.subtotalMinor, 0);
  return orderEvents().paid.create(input.orderId, version, {
    orderId: input.orderId,
    userId: uuidv4(),
    orderVersion: version,
    totalMinor: total,
    currency: input.currency ?? 'EUR',
    paymentRef: input.paymentRef ?? 'pi_1',
    paidAt: (input.paidAt ?? new Date()).toISOString(),
    lines: input.shops.map((s) => ({
      lineId: uuidv4(),
      ...(s.category ? { category: s.category } : {}),
      productId: uuidv4(),
      shopId: s.shopId,
      title: 'Line',
      quantity: 1,
      unitPriceMinor: s.subtotalMinor,
      discountMinor: 0,
      lineTotalMinor: s.subtotalMinor,
    })),
    shopOrders: input.shops.map((s) => ({
      shopOrderId: uuidv4(),
      shopId: s.shopId,
      subtotalMinor: s.subtotalMinor,
    })),
  });
}

export const sql = async <T extends object>(
  app: INestApplication,
  query: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> =>
  app.get(Sequelize).query<T>(query, { type: QueryTypes.SELECT, replacements });

/**
 * The invariants every posting spec ends with (SC-001): every journal sums to zero, every journal has a header, and
 * every running balance equals the sum of the entries of its (account, shard, currency).
 */
export async function assertBooksHealthy(app: INestApplication): Promise<void> {
  const unbalanced = await sql<{ journalId: string; total: string }>(
    app,
    `SELECT "journalId", sum(amount)::text AS total FROM "LedgerEntry" GROUP BY "journalId" HAVING sum(amount) <> 0`,
  );
  expect(unbalanced).toEqual([]);

  const headerless = await sql<{ journalId: string }>(
    app,
    `SELECT DISTINCT e."journalId" FROM "LedgerEntry" e LEFT JOIN "LedgerJournal" j ON j."id" = e."journalId" WHERE j."id" IS NULL`,
  );
  expect(headerless).toEqual([]);

  const drift = await sql<{
    accountId: string;
    shard: number;
    balance: string | null;
    entries: string | null;
  }>(
    app,
    `SELECT coalesce(b."accountId", e."accountId") AS "accountId", coalesce(b."shard", e."shard") AS shard,
            b."balanceMinor"::text AS balance, e.total::text AS entries
       FROM "AccountBalance" b
       FULL JOIN (SELECT "accountId", "shard", "currency", sum(amount) AS total FROM "LedgerEntry" GROUP BY 1, 2, 3) e
         ON e."accountId" = b."accountId" AND e."shard" = b."shard" AND e."currency" = b."currency"
      WHERE coalesce(b."balanceMinor", 0) <> coalesce(e.total, 0)`,
  );
  expect(drift).toEqual([]);
}

/** The `ledger.journal_posted` events in the outbox, parsed with the contract schema (VII.6). */
export async function journalEvents(app: INestApplication) {
  const rows = await sql<{
    payload: { version: number; payload: unknown };
    aggregateId: string;
  }>(
    app,
    `SELECT "payload", "aggregateId" FROM "Outbox" WHERE "type" = 'ledger.journal_posted' ORDER BY "createdAt", "id"`,
  );
  return rows.map((r) => ({
    aggregateId: r.aggregateId,
    version: r.payload.version,
    payload: journalPostedV2Schema.parse(r.payload.payload),
  }));
}

/**
 * Records every outbound call a posting could make (HTTP, Redis, DynamoDB) while a spec runs; `calls()` is empty when
 * the code under test stayed inside the database (FR-006: no network I/O in a posting). Call `stop()` when done.
 */
export function watchNetwork(app: INestApplication): {
  calls(): string[];
  stop(): void;
} {
  const calls: string[] = [];
  const restores: Array<() => void> = [];
  const wrap = <T extends object>(target: T, key: keyof T, label: string) => {
    const original = target[key] as unknown as (...a: unknown[]) => unknown;
    if (typeof original !== 'function') return;
    (target as Record<keyof T, unknown>)[key] = function (
      this: unknown,
      ...args: unknown[]
    ) {
      calls.push(label);
      return original.apply(this, args);
    };
    restores.push(() => {
      (target as Record<keyof T, unknown>)[key] = original;
    });
  };
  wrap(globalThis as never, 'fetch' as never, 'fetch');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  wrap(require('node:http'), 'request', 'http.request');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  wrap(require('node:https'), 'request', 'https.request');
  try {
    const redis = app.get(RedisService, { strict: false });
    wrap(redis.client as never, 'sendCommand' as never, 'redis');
  } catch {
    /* no Redis in this app */
  }
  try {
    const dynamo = app.get(DynamoService, { strict: false });
    wrap(dynamo.doc as never, 'send' as never, 'dynamodb');
  } catch {
    /* no DynamoDB in this app */
  }
  return {
    calls: () => [...calls],
    stop: () => restores.splice(0).forEach((r) => r()),
  };
}

export async function count(
  app: INestApplication,
  table: string,
  where = 'true',
  replacements: Record<string, unknown> = {},
): Promise<number> {
  const [row] = await sql<{ n: string }>(
    app,
    `SELECT count(*)::text AS n FROM "${table}" WHERE ${where}`,
    replacements,
  );
  return Number(row.n);
}

export async function balanceOf(
  app: INestApplication,
  accountId: string,
  currency = 'EUR',
): Promise<number> {
  const [row] = await sql<{ b: string | null }>(
    app,
    `SELECT sum("balanceMinor")::text AS b FROM "AccountBalance" WHERE "accountId" = :accountId AND "currency" = :currency`,
    { accountId, currency },
  );
  return Number(row?.b ?? 0);
}
