import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { orderEvents } from '../application/events/order-events';
import { OrdersEventsConsumer } from '../infra/orders-events.consumer';
import { exec, rows } from './payments-app';

/** The consumer of `orders.events` as the specs reach it (the probe module provides it). */
const consumer = (app: INestApplication) =>
  app.get(OrdersEventsConsumer, { strict: false });

const now = (app: INestApplication) =>
  app.get<Clock>(CLOCK, { strict: false }).now();

export interface ReservedOrder {
  orderId: string;
  userId: string;
  totalMinor: number;
  currency: string;
  reservedUntil: Date;
}

/** Publishes an S10-shaped `order.reserved` to the consumer: the order copy then exists and is payable. */
export async function publishOrderReserved(
  app: INestApplication,
  input: {
    userId: string;
    orderId?: string;
    totalMinor?: number;
    currency?: string;
    version?: number;
    holdSeconds?: number;
    reservedUntil?: Date;
  },
): Promise<ReservedOrder> {
  const orderId = input.orderId ?? randomUUID();
  const version = input.version ?? 1;
  const totalMinor = input.totalMinor ?? 2_500;
  const currency = input.currency ?? 'EUR';
  const reservedUntil =
    input.reservedUntil ??
    new Date(now(app).getTime() + (input.holdSeconds ?? 900) * 1000);
  await consumer(app).project([
    orderEvents().reserved.create(orderId, version, {
      orderId,
      userId: input.userId,
      orderVersion: version,
      totalMinor,
      currency,
      shopIds: [],
      reservedUntil: reservedUntil.toISOString(),
    }),
  ]);
  return { orderId, userId: input.userId, totalMinor, currency, reservedUntil };
}

export async function publishOrderCancelled(
  app: INestApplication,
  input: {
    orderId: string;
    userId: string;
    version: number;
    reason?:
      'out_of_stock' | 'payment_failed' | 'hold_expired' | 'user_cancelled';
    previousStatus?: 'PENDING' | 'RESERVED' | 'PAID';
  },
): Promise<void> {
  await consumer(app).project([
    orderEvents().cancelled.create(input.orderId, input.version, {
      orderId: input.orderId,
      userId: input.userId,
      orderVersion: input.version,
      reason: input.reason ?? 'user_cancelled',
      previousStatus: input.previousStatus ?? 'RESERVED',
    }),
  ]);
}

export async function publishOrderPaid(
  app: INestApplication,
  input: {
    orderId: string;
    userId: string;
    version: number;
    totalMinor?: number;
    currency?: string;
  },
): Promise<void> {
  await consumer(app).project([
    orderEvents().paid.create(input.orderId, input.version, {
      orderId: input.orderId,
      userId: input.userId,
      orderVersion: input.version,
      totalMinor: input.totalMinor ?? 2_500,
      currency: input.currency ?? 'EUR',
      paymentRef: 'pi_seed',
      paidAt: now(app).toISOString(),
      lines: [],
      shopOrders: [],
    }),
  ]);
}

export interface PaymentRow {
  id: string;
  userId: string;
  orderId: string;
  amount: string;
  currency: string;
  status: string;
  version: number;
  providerRef: string | null;
  chargeAttemptedAt: Date | null;
  chargeAttempts: number;
  requiresAction: boolean;
  clientSecret: string | null;
  paymentMethodToken: string | null;
  failureCode: string | null;
  nextResolveAt: Date | null;
  resolveChecks: number;
  unknownSince: Date | null;
  lastStuckAlertAt: Date | null;
  refundRequestedAt: Date | null;
  refundNextAt: Date | null;
}

const PAYMENT_COLUMNS = `"id", "userId", "orderId", "amount", "currency", "status", "version", "providerRef",
  "chargeAttemptedAt", "chargeAttempts", "requiresAction", "clientSecret", "paymentMethodToken", "failureCode",
  "nextResolveAt", "resolveChecks", "unknownSince", "lastStuckAlertAt", "refundRequestedAt", "refundNextAt"`;

export const paymentRow = async (
  app: INestApplication,
  id: string,
): Promise<PaymentRow | undefined> =>
  (
    await rows<PaymentRow>(
      app,
      `SELECT ${PAYMENT_COLUMNS} FROM "Payment" WHERE "id" = :id`,
      { id },
    )
  )[0];

export const paymentForOrder = async (
  app: INestApplication,
  orderId: string,
): Promise<PaymentRow | undefined> =>
  (
    await rows<PaymentRow>(
      app,
      `SELECT ${PAYMENT_COLUMNS} FROM "Payment" WHERE "orderId" = :orderId`,
      { orderId },
    )
  )[0];

export const paymentCount = async (app: INestApplication): Promise<number> =>
  Number(
    (await rows<{ n: string }>(app, `SELECT count(*) AS n FROM "Payment"`))[0]
      .n,
  );

export const historyOf = (app: INestApplication, paymentId: string) =>
  rows<{
    version: number;
    fromStatus: string | null;
    toStatus: string;
    reason: string | null;
    actor: string;
  }>(
    app,
    `SELECT "version", "fromStatus", "toStatus", "reason", "actor" FROM "PaymentHistory"
     WHERE "paymentId" = :paymentId ORDER BY "version", "at"`,
    { paymentId },
  );

export interface OutboxRow {
  id: string;
  kind: string;
  topic: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
}

/** Outbox rows (events and tasks), oldest first, optionally of one type. */
export const outboxRows = (app: INestApplication, type?: string) =>
  rows<OutboxRow>(
    app,
    `SELECT "id", "kind", "topic", "aggregateId", "type", "payload" FROM "Outbox"
     WHERE (CAST(:type AS text) IS NULL OR "type" = :type) ORDER BY "createdAt", "id"`,
    { type: type ?? null },
  );

/** The ledger lines of one payment's journals. */
export const ledgerOf = (app: INestApplication, paymentId: string) =>
  rows<{ journalId: string; kind: string; accountId: string; amount: string }>(
    app,
    `SELECT "journalId", "kind", "accountId", "amount" FROM "LedgerEntry" WHERE "paymentId" = :paymentId
     ORDER BY "kind", "accountId"`,
    { paymentId },
  );

export interface SeededPayment {
  id: string;
  orderId: string;
}

/** Inserts a payment as the accept transaction would have (plus its first history row), then lets a spec move it. */
export async function seedPayment(
  app: INestApplication,
  input: {
    userId: string;
    orderId?: string;
    amountMinor?: number;
    currency?: string;
    status?: string;
    version?: number;
    providerRef?: string | null;
    chargeAttemptedAt?: Date | null;
    chargeAttempts?: number;
    requiresAction?: boolean;
    clientSecret?: string | null;
    paymentMethodToken?: string | null;
    failureCode?: string | null;
    nextResolveAt?: Date | null;
    unknownSince?: Date | null;
    createdAt?: Date;
  },
): Promise<SeededPayment> {
  const id = randomUUID();
  const orderId = input.orderId ?? randomUUID();
  const createdAt = input.createdAt ?? now(app);
  await exec(
    app,
    `INSERT INTO "Payment" ("id", "userId", "orderId", "bisOrderId", "amount", "currency", "status", "version",
       "providerRef", "chargeAttemptedAt", "chargeAttempts", "requiresAction", "clientSecret", "paymentMethodToken",
       "failureCode", "nextResolveAt", "unknownSince", "createdAt", "updatedAt")
     VALUES (:id, :userId, :orderId, :orderId, :amount, :currency, :status, :version, :providerRef,
       :chargeAttemptedAt, :chargeAttempts, :requiresAction, :clientSecret, :token, :failureCode, :nextResolveAt,
       :unknownSince, :createdAt, :createdAt)`,
    {
      id,
      userId: input.userId,
      orderId,
      amount: input.amountMinor ?? 2_500,
      currency: input.currency ?? 'EUR',
      status: input.status ?? 'PENDING',
      version: input.version ?? 1,
      providerRef: input.providerRef ?? null,
      chargeAttemptedAt: input.chargeAttemptedAt ?? null,
      chargeAttempts: input.chargeAttempts ?? 0,
      requiresAction: input.requiresAction ?? false,
      clientSecret: input.clientSecret ?? null,
      token: input.paymentMethodToken ?? 'pm_card_visa',
      failureCode: input.failureCode ?? null,
      nextResolveAt: input.nextResolveAt ?? null,
      unknownSince: input.unknownSince ?? null,
      createdAt,
    },
  );
  await exec(
    app,
    `INSERT INTO "PaymentHistory" ("paymentId", "version", "fromStatus", "toStatus", "reason", "actor", "at")
     VALUES (:id, :version, NULL, :status, 'seed', 'system:seed', :createdAt)`,
    {
      id,
      version: input.version ?? 1,
      status: input.status ?? 'PENDING',
      createdAt,
    },
  );
  return { id, orderId };
}
