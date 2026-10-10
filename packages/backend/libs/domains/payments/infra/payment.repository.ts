import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import type {
  PaymentCurrency,
  PaymentFailureCode,
} from '@marketplace-sandbox/contracts';
import type {
  NewPayment,
  PaymentMove,
  PaymentPatch,
  PaymentRecord,
  PaymentRepository,
} from '../domain/ports';
import type { PaymentStatus } from '../domain/payment-status';
import { safeNumber } from './safe-number';

interface PaymentRow {
  id: string;
  userId: string;
  orderId: string;
  amount: string | number;
  currency: string;
  status: PaymentStatus;
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
  createdAt: Date;
  updatedAt: Date;
}

const COLUMNS = `"id", "userId", "orderId", "amount", "currency", "status", "version", "providerRef", "chargeAttemptedAt",
  "chargeAttempts", "requiresAction", "clientSecret", "paymentMethodToken", "failureCode", "nextResolveAt", "resolveChecks",
  "unknownSince", "lastStuckAlertAt", "refundRequestedAt", "refundNextAt", "createdAt", "updatedAt"`;

/** Patch keys that may be written: the only column names that reach SQL text. */
const PATCH_COLUMNS: Array<keyof PaymentPatch> = [
  'providerRef',
  'failureCode',
  'requiresAction',
  'clientSecret',
  'paymentMethodToken',
  'nextResolveAt',
  'resolveChecks',
  'unknownSince',
  'refundRequestedAt',
  'refundNextAt',
];

const toRecord = (r: PaymentRow): PaymentRecord => ({
  id: r.id,
  userId: r.userId,
  orderId: r.orderId,
  amountMinor: safeNumber(r.amount),
  currency: r.currency as PaymentCurrency,
  status: r.status,
  version: r.version,
  providerRef: r.providerRef,
  chargeAttemptedAt: r.chargeAttemptedAt,
  chargeAttempts: r.chargeAttempts,
  requiresAction: r.requiresAction,
  clientSecret: r.clientSecret,
  paymentMethodToken: r.paymentMethodToken,
  failureCode: r.failureCode as PaymentFailureCode | null,
  nextResolveAt: r.nextResolveAt,
  resolveChecks: r.resolveChecks,
  unknownSince: r.unknownSince,
  lastStuckAlertAt: r.lastStuckAlertAt,
  refundRequestedAt: r.refundRequestedAt,
  refundNextAt: r.refundNextAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/**
 * `Payment`. Every statement joins the active transaction (CLS). No method updates by id alone: a move matches the
 * status and version the caller read, so concurrent writers cannot both win (S13 III.7). Times come from the caller.
 */
@Injectable()
export class SequelizePaymentRepository implements PaymentRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private select<T extends object>(
    sql: string,
    replacements: object,
  ): Promise<T[]> {
    return this.sequelize.query<T>(sql, {
      type: QueryTypes.SELECT,
      replacements: replacements as Record<string, unknown>,
    });
  }

  async insertAccepted(input: NewPayment): Promise<PaymentRecord | null> {
    const [row] = await this.select<PaymentRow>(
      `INSERT INTO "Payment" ("id", "userId", "orderId", "bisOrderId", "amount", "currency", "status", "version",
                              "paymentMethodToken", "createdAt", "updatedAt")
       VALUES (:id, :userId, :orderId, :orderId, :amount, :currency, 'PENDING', 1, :token, :now, :now)
       ON CONFLICT ("orderId") WHERE "orderId" IS NOT NULL DO NOTHING
       RETURNING ${COLUMNS}`,
      {
        id: input.id,
        userId: input.userId,
        orderId: input.orderId,
        amount: input.amountMinor,
        currency: input.currency,
        token: input.paymentMethodToken,
        now: input.now,
      },
    );
    return row ? toRecord(row) : null;
  }

  async findById(id: string): Promise<PaymentRecord | null> {
    const [row] = await this.select<PaymentRow>(
      `SELECT ${COLUMNS} FROM "Payment" WHERE "id" = :id`,
      { id },
    );
    return row ? toRecord(row) : null;
  }

  async findByOrderId(orderId: string): Promise<PaymentRecord | null> {
    const [row] = await this.select<PaymentRow>(
      `SELECT ${COLUMNS} FROM "Payment" WHERE "orderId" = :orderId`,
      { orderId },
    );
    return row ? toRecord(row) : null;
  }

  async findByProviderRef(providerRef: string): Promise<PaymentRecord | null> {
    const [row] = await this.select<PaymentRow>(
      `SELECT ${COLUMNS} FROM "Payment" WHERE "providerRef" = :providerRef`,
      { providerRef },
    );
    return row ? toRecord(row) : null;
  }

  async move(move: PaymentMove): Promise<PaymentRecord | null> {
    const sets = [
      '"status" = :to',
      '"version" = "version" + :step',
      '"updatedAt" = :now',
    ];
    const replacements: Record<string, unknown> = {
      id: move.id,
      from: move.from,
      to: move.to,
      version: move.version,
      step: move.versionStep,
      now: move.now,
    };
    for (const key of PATCH_COLUMNS) {
      if (move.patch[key] === undefined) continue;
      sets.push(`"${key}" = :p_${key}`);
      replacements[`p_${key}`] = move.patch[key];
    }
    const guard = move.requireUnattempted
      ? ' AND ("chargeAttemptedAt" IS NULL OR "requiresAction")'
      : '';
    const [row] = await this.select<PaymentRow>(
      `UPDATE "Payment" SET ${sets.join(', ')}
       WHERE "id" = :id AND "status" = :from AND "version" = :version${guard}
       RETURNING ${COLUMNS}`,
      replacements,
    );
    return row ? toRecord(row) : null;
  }

  async startCharge(id: string, now: Date): Promise<number | null> {
    const [row] = await this.select<{ chargeAttempts: number }>(
      `UPDATE "Payment" SET "chargeAttemptedAt" = :now, "chargeAttempts" = "chargeAttempts" + 1, "updatedAt" = :now
       WHERE "id" = :id AND "status" = 'PENDING' AND "chargeAttemptedAt" IS NULL
       RETURNING "chargeAttempts"`,
      { id, now },
    );
    return row ? row.chargeAttempts : null;
  }

  async clearChargeMark(id: string): Promise<void> {
    await this.sequelize.query(
      `UPDATE "Payment" SET "chargeAttemptedAt" = NULL WHERE "id" = :id AND "status" = 'PENDING'`,
      { replacements: { id } },
    );
  }

  async rescheduleResolve(
    id: string,
    patch: {
      nextResolveAt: Date;
      resolveChecks: number;
      lastStuckAlertAt?: Date;
    },
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE "Payment" SET "nextResolveAt" = :next, "resolveChecks" = :checks,
         "lastStuckAlertAt" = COALESCE(:alert, "lastStuckAlertAt")
       WHERE "id" = :id AND "status" = 'UNKNOWN'`,
      {
        replacements: {
          id,
          next: patch.nextResolveAt,
          checks: patch.resolveChecks,
          alert: patch.lastStuckAlertAt ?? null,
        },
      },
    );
  }

  async oldestUnknownSince(): Promise<Date | null> {
    const [row] = await this.select<{ since: Date | null }>(
      `SELECT min("unknownSince") AS "since" FROM "Payment" WHERE "status" = 'UNKNOWN'`,
      {},
    );
    return row?.since ?? null;
  }

  async markRefundRequested(id: string, now: Date, next: Date): Promise<void> {
    await this.sequelize.query(
      `UPDATE "Payment" SET "refundRequestedAt" = COALESCE("refundRequestedAt", :now), "refundNextAt" = :next
       WHERE "id" = :id`,
      { replacements: { id, now, next } },
    );
  }

  async rescheduleRefund(id: string, next: Date | null): Promise<void> {
    await this.sequelize.query(
      `UPDATE "Payment" SET "refundNextAt" = :next WHERE "id" = :id AND "status" = 'REFUND_PENDING'`,
      { replacements: { id, next } },
    );
  }

  async claimDueRefunds(now: Date, limit: number): Promise<PaymentRecord[]> {
    const rows = await this.select<PaymentRow>(
      `SELECT ${COLUMNS} FROM "Payment" WHERE "status" = 'REFUND_PENDING' AND "refundNextAt" <= :now
       ORDER BY "refundNextAt", "id" LIMIT :limit FOR UPDATE SKIP LOCKED`,
      { now, limit },
    );
    return rows.map(toRecord);
  }

  async oldestRefundPendingSince(): Promise<Date | null> {
    const [row] = await this.select<{ since: Date | null }>(
      `SELECT min("refundRequestedAt") AS "since" FROM "Payment" WHERE "status" = 'REFUND_PENDING'`,
      {},
    );
    return row?.since ?? null;
  }

  async claimDueUnknown(now: Date, limit: number): Promise<PaymentRecord[]> {
    const rows = await this.select<PaymentRow>(
      `SELECT ${COLUMNS} FROM "Payment" WHERE "status" = 'UNKNOWN' AND "nextResolveAt" <= :now
       ORDER BY "nextResolveAt", "id" LIMIT :limit FOR UPDATE SKIP LOCKED`,
      { now, limit },
    );
    return rows.map(toRecord);
  }
}
