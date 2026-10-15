import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize';
import type {
  NewSubscription,
  SubscriptionPatch,
  SubscriptionRepository,
} from '../domain/ports';
import type { BillingInterval } from '../domain/periods';
import type { SubscriptionStatus } from '../domain/subscription-status';
import {
  actorText,
  type Audience,
  type EntitlementValues,
  type HistoryEntry,
  type Subject,
  type SubjectType,
  type SubscriptionView,
} from '../domain/types';
import { dateOrNull, minor, run, select } from './sql';

interface ViewDb {
  id: string;
  subjectType: SubjectType;
  subjectId: string;
  priceId: string;
  status: SubscriptionStatus;
  quantity: number;
  billingAnchorDay: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  cancelAtPeriodEnd: boolean;
  cancelReason: string | null;
  canceledAt: Date | null;
  offboardingStartedAt: Date | null;
  statusSince: Date;
  hasPaymentMethod: boolean;
  creditBalanceMinor: string;
  version: number;
  createdAt: Date;
  priceVersion: number;
  planId: string;
  interval: BillingInterval;
  unitAmount: string;
  currency: string;
  perSeat: boolean;
  trialDays: number;
  includedUsage: Record<string, number>;
  overagePer1000: Record<string, number>;
  priceActive: boolean;
  priceCreatedAt: Date;
  planCode: string;
  planName: string;
  audience: Audience;
}

const VIEW_SQL = `
  SELECT s."id", s."subjectType", s."subjectId", s."priceId", s."status", s."quantity", s."billingAnchorDay",
         s."currentPeriodStart", s."currentPeriodEnd", s."trialEndsAt", s."cancelAtPeriodEnd", s."cancelReason",
         s."canceledAt", s."offboardingStartedAt", s."statusSince",
         (s."paymentMethodRef" IS NOT NULL) AS "hasPaymentMethod", s."creditBalanceMinor", s."version", s."createdAt",
         pr."version" AS "priceVersion", pr."planId", pr."interval", pr."unitAmount", pr."currency", pr."perSeat",
         pr."trialDays", pr."includedUsage", pr."overagePer1000", pr."active" AS "priceActive",
         pr."createdAt" AS "priceCreatedAt", p."code" AS "planCode", p."name" AS "planName", p."audience"
    FROM "Subscription" s
    JOIN "Price" pr ON pr."id" = s."priceId"
    JOIN "Plan" p ON p."id" = pr."planId"`;

const toView = (row: ViewDb): SubscriptionView => ({
  subscription: {
    id: row.id,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    priceId: row.priceId,
    status: row.status,
    quantity: row.quantity,
    billingAnchorDay: row.billingAnchorDay,
    currentPeriodStart: new Date(row.currentPeriodStart),
    currentPeriodEnd: new Date(row.currentPeriodEnd),
    trialEndsAt: dateOrNull(row.trialEndsAt),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    cancelReason: row.cancelReason,
    canceledAt: dateOrNull(row.canceledAt),
    offboardingStartedAt: dateOrNull(row.offboardingStartedAt),
    statusSince: new Date(row.statusSince),
    hasPaymentMethod: row.hasPaymentMethod,
    creditBalanceMinor: minor(row.creditBalanceMinor),
    version: row.version,
    createdAt: new Date(row.createdAt),
  },
  price: {
    id: row.priceId,
    planId: row.planId,
    version: row.priceVersion,
    interval: row.interval,
    unitAmountMinor: minor(row.unitAmount),
    currency: row.currency,
    perSeat: row.perSeat,
    trialDays: row.trialDays,
    includedUsage: row.includedUsage,
    overagePer1000Minor: row.overagePer1000,
    active: row.priceActive,
    createdAt: new Date(row.priceCreatedAt),
  },
  plan: { code: row.planCode, name: row.planName, audience: row.audience },
});

/** Subscriptions and their history over raw SQL. Every query puts `(subjectType, subjectId)` or the id in the predicate. */
@Injectable()
export class SequelizeSubscriptionRepository implements SubscriptionRepository {
  constructor(@InjectConnection() private readonly sequelize: Sequelize) {}

  private async one(
    where: string,
    replacements: Record<string, unknown>,
    suffix = '',
  ): Promise<SubscriptionView | null> {
    const [row] = await select<ViewDb>(
      this.sequelize,
      `${VIEW_SQL} WHERE ${where} ${suffix}`,
      replacements,
    );
    return row ? toView(row) : null;
  }

  findLive(subject: Subject) {
    return this.one(
      `s."subjectType" = :subjectType AND s."subjectId" = :subjectId AND s."status" <> 'CANCELED'`,
      subject as unknown as Record<string, unknown>,
    );
  }

  findById(id: string) {
    return this.one(`s."id" = :id`, { id });
  }

  lockForRenewal(id: string) {
    return this.one(`s."id" = :id`, { id }, 'FOR UPDATE OF s');
  }

  async hasEverSubscribed(subject: Subject) {
    const rows = await select<{ one: number }>(
      this.sequelize,
      `SELECT 1 AS one FROM "Subscription" WHERE "subjectType" = :subjectType AND "subjectId" = :subjectId LIMIT 1`,
      subject as unknown as Record<string, unknown>,
    );
    return rows.length > 0;
  }

  private async writeHistory(
    subscriptionId: string,
    history: HistoryEntry,
    version: number,
  ) {
    await run(
      this.sequelize,
      `INSERT INTO "SubscriptionTransition" ("subscriptionId", "fromStatus", "toStatus", "reason", "actor", "at", "version")
       VALUES (:subscriptionId, :from, :to, :reason, :actor, :at, :version)`,
      {
        subscriptionId,
        from: history.from,
        to: history.to,
        reason: history.reason,
        actor: actorText(history.actor),
        at: history.at,
        version,
      },
    );
  }

  async insert(input: NewSubscription, history: HistoryEntry) {
    const [created] = await select<{ id: string }>(
      this.sequelize,
      `INSERT INTO "Subscription" ("subjectType", "subjectId", "priceId", "status", "quantity", "billingAnchorDay",
                                   "currentPeriodStart", "currentPeriodEnd", "trialEndsAt", "paymentMethodRef",
                                   "version", "statusSince", "createdAt", "updatedAt")
       VALUES (:subjectType, :subjectId, :priceId, :status, :quantity, :billingAnchorDay,
               :currentPeriodStart, :currentPeriodEnd, :trialEndsAt, :paymentMethodRef, 0, :now, :now, :now)
       ON CONFLICT DO NOTHING
       RETURNING "id"`,
      { ...input } as unknown as Record<string, unknown>,
    );
    if (!created) return null;
    await this.writeHistory(created.id, history, 0);
    return this.findById(created.id);
  }

  async applyUpdate(
    id: string,
    expect: { version: number; status?: SubscriptionStatus },
    patch: SubscriptionPatch,
    history: HistoryEntry,
  ) {
    const sets = [`"version" = "version" + 1`, `"updatedAt" = :now`];
    const replacements: Record<string, unknown> = {
      id,
      expectVersion: expect.version,
      expectStatus: expect.status ?? null,
      now: history.at,
    };
    const assign = (column: string, key: string, value: unknown) => {
      sets.push(`"${column}" = :${key}`);
      replacements[key] = value;
    };
    if (patch.priceId !== undefined)
      assign('priceId', 'priceId', patch.priceId);
    if (patch.quantity !== undefined)
      assign('quantity', 'quantity', patch.quantity);
    if (patch.status !== undefined) assign('status', 'status', patch.status);
    if (history.from !== history.to) sets.push(`"statusSince" = :now`);
    if (patch.currentPeriodStart !== undefined)
      assign(
        'currentPeriodStart',
        'currentPeriodStart',
        patch.currentPeriodStart,
      );
    if (patch.currentPeriodEnd !== undefined)
      assign('currentPeriodEnd', 'currentPeriodEnd', patch.currentPeriodEnd);
    if (patch.trialEndsAt !== undefined)
      assign('trialEndsAt', 'trialEndsAt', patch.trialEndsAt);
    if (patch.cancelAtPeriodEnd !== undefined)
      assign('cancelAtPeriodEnd', 'cancelAtPeriodEnd', patch.cancelAtPeriodEnd);
    if (patch.cancelReason !== undefined)
      assign('cancelReason', 'cancelReason', patch.cancelReason);
    if (patch.canceledAt !== undefined)
      assign('canceledAt', 'canceledAt', patch.canceledAt);
    if (patch.offboardingStartedAt !== undefined)
      assign(
        'offboardingStartedAt',
        'offboardingStartedAt',
        patch.offboardingStartedAt,
      );
    if (patch.paymentMethodRef !== undefined)
      assign('paymentMethodRef', 'paymentMethodRef', patch.paymentMethodRef);
    if (patch.creditDeltaMinor !== undefined) {
      sets.push(`"creditBalanceMinor" = "creditBalanceMinor" + :creditDelta`);
      replacements.creditDelta = patch.creditDeltaMinor;
    }
    const [updated] = await select<{ version: number }>(
      this.sequelize,
      `UPDATE "Subscription" SET ${sets.join(', ')}
        WHERE "id" = :id AND "version" = :expectVersion
          AND (CAST(:expectStatus AS text) IS NULL OR "status" = CAST(:expectStatus AS text))
        RETURNING "version"`,
      replacements,
    );
    if (!updated) return null;
    await this.writeHistory(id, history, updated.version);
    return this.findById(id);
  }

  async setPaymentMethodRef(subject: Subject, ref: string, now: Date) {
    const [row] = await select<{ id: string }>(
      this.sequelize,
      `UPDATE "Subscription" SET "paymentMethodRef" = :ref, "updatedAt" = :now
        WHERE "subjectType" = :subjectType AND "subjectId" = :subjectId AND "status" <> 'CANCELED'
        RETURNING "id"`,
      { ...subject, ref, now },
    );
    return row ? this.findById(row.id) : null;
  }

  async paymentMethodRefOf(subscriptionId: string) {
    const [row] = await select<{ ref: string | null }>(
      this.sequelize,
      `SELECT "paymentMethodRef" AS ref FROM "Subscription" WHERE "id" = :subscriptionId`,
      { subscriptionId },
    );
    return row?.ref ?? null;
  }

  async eraseCredentials(subject: Subject, now: Date) {
    const rows = await select<{ id: string }>(
      this.sequelize,
      `UPDATE "Subscription" SET "paymentMethodRef" = NULL, "updatedAt" = :now
        WHERE "subjectType" = :subjectType AND "subjectId" = :subjectId AND "paymentMethodRef" IS NOT NULL
        RETURNING "id"`,
      { ...subject, now },
    );
    return rows.length;
  }

  async liveBasis(subjectType: SubjectType, subjectIds: string[]) {
    if (subjectIds.length === 0) return [];
    const rows = await select<{
      subjectId: string;
      subscriptionId: string;
      status: SubscriptionStatus;
      planCode: string;
      entitlements: EntitlementValues;
      subscriptionVersion: number;
    }>(
      this.sequelize,
      `SELECT s."subjectId", s."id" AS "subscriptionId", s."status", p."code" AS "planCode",
              p."entitlements", s."version" AS "subscriptionVersion"
         FROM "Subscription" s JOIN "Price" pr ON pr."id" = s."priceId" JOIN "Plan" p ON p."id" = pr."planId"
        WHERE s."subjectType" = :subjectType AND s."subjectId" IN (:subjectIds)
          AND s."status" IN ('TRIALING','ACTIVE','PAST_DUE')`,
      { subjectType, subjectIds },
    );
    return rows;
  }

  async listDueIds(now: Date, unpaidCutoff: Date, limit: number) {
    const rows = await select<{ id: string }>(
      this.sequelize,
      `SELECT "id" FROM "Subscription"
        WHERE ("status" IN ('TRIALING','ACTIVE') AND "currentPeriodEnd" <= :now)
           OR ("status" IN ('PAST_DUE','UNPAID') AND "cancelAtPeriodEnd" AND "currentPeriodEnd" <= :now)
           OR ("status" = 'UNPAID' AND "statusSince" <= :unpaidCutoff)
        ORDER BY "currentPeriodEnd", "id" LIMIT :limit`,
      { now, unpaidCutoff, limit },
    );
    return rows.map((row) => row.id);
  }

  async countOverdue(overdueBefore: Date) {
    const [row] = await select<{ n: string }>(
      this.sequelize,
      `SELECT count(*) AS n FROM "Subscription"
        WHERE "status" IN ('TRIALING','ACTIVE') AND "currentPeriodEnd" <= :overdueBefore`,
      { overdueBefore },
    );
    return Number(row?.n ?? 0);
  }
}
