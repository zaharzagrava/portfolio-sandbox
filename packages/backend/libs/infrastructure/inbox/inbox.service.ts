import { Inject, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  getActiveTransaction,
  TransactionRunner,
} from '@app/infrastructure/context';
import type { InboxStatus } from './inbox.model';

export type { InboxStatus } from './inbox.model';
export type ClaimOutcome =
  'CLAIMED' | 'DUPLICATE_IN_PROGRESS' | 'DUPLICATE_DONE';
export interface ClaimResult {
  outcome: ClaimOutcome;
  status: InboxStatus;
  attempts: number;
}

/** A `RECEIVED` claim older than this is treated as a crashed handler and may be claimed again. */
export const CLAIM_LEASE_MS = 5 * 60_000;
export const INBOX_PURGE_BATCH = 1_000;
const TERMINAL: InboxStatus[] = [
  'PROCESSED',
  'IGNORED',
  'UNMATCHED',
  'REJECTED',
];

export class InboxTransactionRequiredError extends Error {
  constructor(consumer: string) {
    super(
      `recordOnce(${consumer}) must run inside the transaction of the effect (TransactionRunner.run / @Transactional) so the record commits or rolls back with it`,
    );
    this.name = 'InboxTransactionRequiredError';
  }
}

const TABLE = '"ProcessedWebhookEvent"';

/**
 * The inbox (S53 FR-041, FR-042): the one place that records "this external or consumed event was handled".
 *  - `claim`/`markStatus`: external webhooks (S10's Stripe handler). One statement inserts or re-claims.
 *  - `recordOnce`: consumers with `idempotency: 'inbox'`, in the transaction of their effect.
 */
@Injectable()
export class InboxService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly runner: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Records a handling attempt atomically. A new pair, a `FAILED` pair and a `RECEIVED` pair older than the claim
   * lease are claimed (attempts counted); anything else is a duplicate, in progress while `RECEIVED`, done otherwise.
   */
  async claim(source: string, eventId: string): Promise<ClaimResult> {
    const now = this.clock.now();
    const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MS);
    const [claimed] = (
      await this.sequelize.query(
        `INSERT INTO ${TABLE} ("provider", "eventId", "status", "attempts", "claimedAt", "createdAt", "processedAt")
       VALUES ($1, $2, 'RECEIVED', 1, $3, $3, $3)
       ON CONFLICT ("provider", "eventId") DO UPDATE
         SET "status" = 'RECEIVED', "attempts" = ${TABLE}."attempts" + 1, "claimedAt" = $3, "handledAt" = NULL
         WHERE ${TABLE}."status" = 'FAILED'
            OR (${TABLE}."status" = 'RECEIVED' AND ${TABLE}."claimedAt" < $4)
       RETURNING "status", "attempts"`,
        { bind: [source, eventId, now, staleBefore] },
      )
    )[0] as { status: InboxStatus; attempts: number }[];
    if (claimed)
      return {
        outcome: 'CLAIMED',
        status: claimed.status,
        attempts: claimed.attempts,
      };

    const [existing] = (
      await this.sequelize.query(
        `SELECT "status", "attempts" FROM ${TABLE} WHERE "provider" = $1 AND "eventId" = $2`,
        { bind: [source, eventId] },
      )
    )[0] as { status: InboxStatus; attempts: number }[];
    return {
      outcome:
        existing.status === 'RECEIVED'
          ? 'DUPLICATE_IN_PROGRESS'
          : 'DUPLICATE_DONE',
      status: existing.status,
      attempts: existing.attempts,
    };
  }

  /** Sets the outcome of a claimed event. `detail` is a short reason code, never a payload value. */
  async markStatus(
    source: string,
    eventId: string,
    status: InboxStatus,
    detail?: string,
  ): Promise<void> {
    await this.sequelize.query(
      `UPDATE ${TABLE} SET "status" = $3, "handledAt" = $4, "detail" = $5 WHERE "provider" = $1 AND "eventId" = $2`,
      { bind: [source, eventId, status, this.clock.now(), detail ?? null] },
    );
  }

  /**
   * Consumer-side dedupe: true the first time `(consumer, eventId)` is seen, false after. Joins the active
   * transaction, so a rolled-back effect leaves no record and the redelivery is treated as new.
   */
  async recordOnce(consumer: string, eventId: string): Promise<boolean> {
    const transaction = getActiveTransaction();
    if (!transaction) throw new InboxTransactionRequiredError(consumer);
    const now = this.clock.now();
    const [rows] = await this.sequelize.query(
      `INSERT INTO ${TABLE} ("provider", "eventId", "status", "attempts", "claimedAt", "handledAt", "createdAt", "processedAt")
       VALUES ($1, $2, 'PROCESSED', 1, $3, $3, $3, $3)
       ON CONFLICT ("provider", "eventId") DO NOTHING RETURNING 1`,
      { bind: [consumer, eventId, now], transaction },
    );
    return rows.length === 1;
  }

  /** Deletes one batch (at most 1 000) of terminal rows handled before `olderThan`; `RECEIVED` and `FAILED` stay. */
  async purge(olderThan: Date): Promise<number> {
    return this.runner.run(async (transaction) => {
      const [rows] = await this.sequelize.query(
        `DELETE FROM ${TABLE} WHERE ctid IN (
           SELECT ctid FROM ${TABLE}
           WHERE "status" = ANY($1::text[]) AND COALESCE("handledAt", "processedAt") < $2
           LIMIT $3
         ) RETURNING 1`,
        { bind: [TERMINAL, olderThan, INBOX_PURGE_BATCH], transaction },
      );
      return rows.length;
    });
  }
}
