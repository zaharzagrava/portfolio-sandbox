import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import Payout from './models/payout.model';
import { ShopModel as Shop } from '@app/domains/tenancy';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { LedgerService } from '../application/ledger.service';
import { LEDGER_ACCOUNTS, shopAccount } from '../domain/accounts';
import { PayoutProvider } from './payout-provider.port';
import { v5 as uuidv5 } from 'uuid';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'payouts.run-weekly': { periodStart?: string };
    'payouts.send': { payoutId: string };
  }
}

const MIN_PAYOUT_MINOR = 10_00;
const PAYOUTS_SENT = 'PAYOUTS_SENT';

/**
 * Weekly seller payouts (lesson 10/02 Ex1 - money leaving the platform):
 *  1. run (fan-out): per shop with an available balance, ONE transaction
 *     creates the Payout row (UNIQUE shop+week → idempotent re-runs) and the
 *     PAYOUT journal SHOP_x → PAYOUT_CLEARING, and enqueues the send job;
 *  2. send: Stripe Connect transfer with idempotency key = payout id; success
 *     → PAYOUT_CLEARING → PAYOUTS_SENT; definite failure → reversal journal
 *     back to the shop's balance. One slow/failed shop never blocks the others.
 */
@Injectable()
export class PayoutJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(PayoutJobs.name);

  constructor(
    @InjectModel(Payout) private readonly payoutModel: typeof Payout,
    @InjectModel(Shop) private readonly shopModel: typeof Shop,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly ledger: LedgerService,
    private readonly jobs: JobsService,
    private readonly provider: PayoutProvider,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({ name: 'payouts.run-weekly', cron: '0 6 * * 1', timezone: 'Europe/Warsaw', jobType: 'payouts.run-weekly', payload: {} });
  }

  @JobHandler('payouts.run-weekly', { concurrency: 1, leaseMs: 600_000 })
  async run({ periodStart }: { periodStart?: string }): Promise<void> {
    const week = periodStart ?? mondayOf(new Date());
    const balances = await this.sequelize.query<{ accountId: string; balance: string }>(
      `SELECT "accountId", sum(amount)::bigint AS balance FROM "LedgerEntry"
       WHERE "accountId" LIKE 'SHOP\\_%' GROUP BY "accountId" HAVING sum(amount) >= :min`,
      { type: QueryTypes.SELECT, replacements: { min: MIN_PAYOUT_MINOR } },
    );

    for (const { accountId, balance } of balances) {
      const shopId = accountId.slice('SHOP_'.length);
      const amount = Number(balance);
      await this.sequelize.transaction(async (tx) => {
        const created = await this.sequelize.query<{ id: string }>(
          `INSERT INTO "Payout" ("shopId", amount, "periodStart") VALUES (:shopId, :amount, :week)
           ON CONFLICT ("shopId", "periodStart") DO NOTHING RETURNING id`,
          { type: QueryTypes.SELECT, replacements: { shopId, amount, week }, transaction: tx },
        );
        if (created.length === 0) return;
        const payoutId = created[0].id;

        await this.ledger.post(
          { journalId: payoutId, kind: 'PAYOUT', lines: [{ accountId, amount: -amount }, { accountId: LEDGER_ACCOUNTS.PAYOUT_CLEARING, amount }] },
          tx,
        );
        await this.jobs.enqueue('payouts.send', { payoutId }, { idempotencyKey: `payout-send:${payoutId}`, shopId });
      });
    }
  }

  @JobHandler('payouts.send', { concurrency: 20 })
  async send({ payoutId }: { payoutId: string }): Promise<void> {
    const payout = await this.payoutModel.findByPk(payoutId);
    if (!payout || payout.status !== 'PENDING') return;
    const shop = await this.shopModel.findByPk(payout.shopId, { attributes: ['stripeAccountId'] });

    try {
      if (!shop?.stripeAccountId) throw Object.assign(new Error('shop has no payout account'), { definite: true });
      const { providerRef } = await this.provider.transfer({
        amount: Number(payout.amount),
        currency: payout.currency,
        destination: shop.stripeAccountId,
        idempotencyKey: payout.id,
      });
      await this.sequelize.transaction(async (tx) => {
        const [updated] = await this.payoutModel.update({ status: 'PAID', providerRef }, { where: { id: payout.id, status: 'PENDING' }, transaction: tx });
        if (updated === 0) return;
        await this.ledger.post(
          {
            journalId: deriveJournalId(payout.id, 'sent'),
            kind: 'PAYOUT',
            lines: [{ accountId: LEDGER_ACCOUNTS.PAYOUT_CLEARING, amount: -Number(payout.amount) }, { accountId: PAYOUTS_SENT, amount: Number(payout.amount) }],
          },
          tx,
        );
      });
    } catch (error) {
      const err = error as { definite?: boolean; type?: string; message: string };
      // Network/5xx → let the job retry (same idempotency key, no double transfer). Definite rejection → reverse.
      if (!err.definite && err.type !== 'StripeInvalidRequestError') throw error;
      await this.sequelize.transaction(async (tx) => {
        const [updated] = await this.payoutModel.update(
          { status: 'FAILED', failureReason: err.message.slice(0, 500) },
          { where: { id: payout.id, status: 'PENDING' }, transaction: tx },
        );
        if (updated === 0) return;
        await this.ledger.post(
          {
            journalId: deriveJournalId(payout.id, 'reversal'),
            kind: 'PAYOUT_REVERSAL',
            lines: [{ accountId: LEDGER_ACCOUNTS.PAYOUT_CLEARING, amount: -Number(payout.amount) }, { accountId: shopAccount(payout.shopId), amount: Number(payout.amount) }],
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
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Deterministic follow-up journal ids per payout (sent / reversal) so retries can't double-post. */
const PAYOUT_NS = '5b1f6d1e-2c0a-4e8e-b3a7-8f1d2e6c4a90';
export function deriveJournalId(payoutId: string, step: 'sent' | 'reversal'): string {
  return uuidv5(`${payoutId}:${step}`, PAYOUT_NS);
}
