import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import { z } from 'zod';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';
import { LedgerService } from '../application/ledger.service';
import { LEDGER_ACCOUNTS, shopAccount } from '../domain/account';
import {
  PROVIDER_ACCOUNT_REPOSITORY,
  type ProviderAccountRepository,
} from '../domain/ledger-ports';
import Payout from './models/payout.model';
import { PayoutProvider } from './payout-provider.port';
import {
  LEDGER_JOB_ATTEMPTS,
  upsertLedgerSchedule,
} from './schedule-bootstrap';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'payouts.run-weekly': { periodStart?: string };
    'payouts.send': { payoutId: string };
  }
}

declareJobType({
  name: 'payouts.run-weekly',
  contract: z.object({ periodStart: z.string().optional() }),
  maxAttempts: LEDGER_JOB_ATTEMPTS,
});
declareJobType({
  name: 'payouts.send',
  contract: z.object({ payoutId: z.string() }),
  maxAttempts: LEDGER_JOB_ATTEMPTS,
});

const MIN_PAYOUT_MINOR = 10_00;
const CURRENCY = 'EUR';
const PAGE = 200;

/**
 * Weekly seller payouts (lesson 10/02 Ex1 - money leaving the platform):
 *  1. run (fan-out): per shop with an available balance, ONE transaction
 *     creates the Payout row (UNIQUE shop+week → idempotent re-runs) and the
 *     PAYOUT journal SHOP_x → PAYOUT_CLEARING, and enqueues the send job;
 *  2. send: Stripe Connect transfer with idempotency key = payout id; success
 *     → PAYOUT_CLEARING → PAYOUTS_SENT; definite failure → reversal journal
 *     back to the shop's balance. One slow/failed shop never blocks the others.
 * S14 moved this file onto the ledger's exports (`postJournal`, `listSellerBalances`), the payments-owned
 * `ProviderAccount` and the transaction runner; its behaviour is unchanged (S15 owns the rest).
 */
@Injectable()
export class PayoutJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(PayoutJobs.name);

  constructor(
    @InjectModel(Payout) private readonly payoutModel: typeof Payout,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly ledger: LedgerService,
    private readonly jobs: JobsService,
    private readonly provider: PayoutProvider,
    private readonly transactions: TransactionRunner,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PROVIDER_ACCOUNT_REPOSITORY)
    private readonly providerAccounts: ProviderAccountRepository,
  ) {}

  async onApplicationBootstrap() {
    await upsertLedgerSchedule(this.jobs, this.logger, {
      name: 'payouts.run-weekly',
      cron: '0 6 * * 1',
      timezone: 'Europe/Warsaw',
      jobType: 'payouts.run-weekly',
      payload: {},
    });
  }

  @JobHandler('payouts.run-weekly', { concurrency: 1, leaseMs: 600_000 })
  async run({ periodStart }: { periodStart?: string }): Promise<void> {
    const week = periodStart ?? mondayOf(this.clock.now());
    let after: string | undefined;
    do {
      const page = await this.ledger.listSellerBalances({
        currency: CURRENCY,
        minMinor: MIN_PAYOUT_MINOR,
        limit: PAGE,
        after,
      });
      for (const { shopId, balanceMinor } of page.items)
        await this.payoutOne(shopId, balanceMinor, week);
      after = page.next ?? undefined;
    } while (after);
  }

  private async payoutOne(
    shopId: string,
    amount: number,
    week: string,
  ): Promise<void> {
    await this.transactions.run(async (tx) => {
      const created = await this.sequelize.query<{ id: string }>(
        `INSERT INTO "Payout" ("shopId", amount, "periodStart") VALUES (:shopId, :amount, :week)
         ON CONFLICT ("shopId", "periodStart") DO NOTHING RETURNING id`,
        {
          type: QueryTypes.SELECT,
          replacements: { shopId, amount, week },
          transaction: tx,
        },
      );
      if (created.length === 0) return;
      const payoutId = created[0].id;

      await this.ledger.postJournal(
        {
          kind: 'PAYOUT',
          reference: `payout:${payoutId}`,
          currency: CURRENCY,
          lines: [
            { accountId: shopAccount(shopId), amountMinor: -amount },
            { accountId: LEDGER_ACCOUNTS.PAYOUT_CLEARING, amountMinor: amount },
          ],
        },
        tx,
      );
      await this.jobs.enqueue(
        'payouts.send',
        { payoutId },
        {
          idempotencyKey: `payout-send:${payoutId}`,
          shopId,
          maxAttempts: LEDGER_JOB_ATTEMPTS,
        },
      );
    });
  }

  @JobHandler('payouts.send', { concurrency: 20 })
  async send({ payoutId }: { payoutId: string }): Promise<void> {
    const payout = await this.payoutModel.findByPk(payoutId);
    if (!payout || payout.status !== 'PENDING') return;
    const destination = await this.providerAccounts.findAccountId(
      payout.shopId,
    );

    try {
      if (!destination)
        throw Object.assign(new Error('shop has no payout account'), {
          definite: true,
        });
      const { providerRef } = await this.provider.transfer({
        amount: Number(payout.amount),
        currency: payout.currency,
        destination,
        idempotencyKey: payout.id,
      });
      await this.transactions.run(async (tx) => {
        const [updated] = await this.payoutModel.update(
          { status: 'PAID', providerRef },
          { where: { id: payout.id, status: 'PENDING' }, transaction: tx },
        );
        if (updated === 0) return;
        await this.ledger.postJournal(
          {
            kind: 'PAYOUT',
            reference: `payout-sent:${payout.id}`,
            currency: CURRENCY,
            lines: [
              {
                accountId: LEDGER_ACCOUNTS.PAYOUT_CLEARING,
                amountMinor: -Number(payout.amount),
              },
              {
                accountId: LEDGER_ACCOUNTS.PAYOUTS_SENT,
                amountMinor: Number(payout.amount),
              },
            ],
          },
          tx,
        );
      });
    } catch (error) {
      const err = error as {
        definite?: boolean;
        type?: string;
        message: string;
      };
      // Network/5xx → let the job retry (same idempotency key, no double transfer). Definite rejection → reverse.
      if (!err.definite && err.type !== 'StripeInvalidRequestError')
        throw error;
      await this.transactions.run(async (tx) => {
        const [updated] = await this.payoutModel.update(
          { status: 'FAILED', failureReason: err.message.slice(0, 500) },
          { where: { id: payout.id, status: 'PENDING' }, transaction: tx },
        );
        if (updated === 0) return;
        await this.ledger.postJournal(
          {
            kind: 'PAYOUT_REVERSAL',
            reference: `payout-reversal:${payout.id}`,
            currency: CURRENCY,
            lines: [
              {
                accountId: LEDGER_ACCOUNTS.PAYOUT_CLEARING,
                amountMinor: -Number(payout.amount),
              },
              {
                accountId: shopAccount(payout.shopId),
                amountMinor: Number(payout.amount),
              },
            ],
          },
          tx,
        );
      });
      this.logger.warn(`payout ${payout.id} failed: ${err.message}`);
    }
  }
}

/** Monday (ISO week start) of the given date, UTC, as YYYY-MM-DD. */
export function mondayOf(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
