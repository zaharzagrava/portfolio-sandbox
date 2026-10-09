import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/sequelize';
import { Op, Sequelize } from 'sequelize';
import Payment, { PaymentStatus } from './models/payment.model';
import { PaymentProcessed } from '../application/events/payment-events';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';
import { LedgerService } from '../application/ledger.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { TransactionRunner } from '@app/infrastructure/context';
import { LEDGER_ACCOUNTS, PLATFORM_FEE_MINOR } from '../domain/accounts';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'payments.resolve-unknown': Record<string, never>;
  }
}

const RESOLVE_AFTER_MS = 5 * 60_000;
const GIVE_UP_AFTER_MS = 60 * 60_000;

/**
 * Settles payments stuck in UNKNOWN (provider timed out and the Kafka retries
 * were exhausted). Asks Stripe for the intent by OUR idempotency key; never
 * creates a new charge. Settlement goes through the same ledger + outbox path
 * as a normal success, so orders/SSE/notifications react identically.
 */
@Injectable()
export class PaymentResolutionJobs implements OnApplicationBootstrap {
  private readonly logger = new Logger(PaymentResolutionJobs.name);

  constructor(
    @InjectModel(Payment) private readonly paymentModel: typeof Payment,
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly transactions: TransactionRunner,
    private readonly stripe: StripeService,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({
      name: 'payments.resolve-unknown',
      cron: '*/5 * * * *',
      jobType: 'payments.resolve-unknown',
      payload: {},
    });
  }

  @JobHandler('payments.resolve-unknown', { concurrency: 1, leaseMs: 120_000 })
  async resolve(): Promise<void> {
    const stuck = await this.paymentModel.findAll({
      where: {
        status: PaymentStatus.UNKNOWN,
        updatedAt: { [Op.lt]: new Date(Date.now() - RESOLVE_AFTER_MS) },
      },
      limit: 100,
    });

    for (const payment of stuck) {
      const intent = await this.stripe.findPaymentIntentByIdempotencyKey(
        payment.idempotencyKey,
      );
      if (intent?.status === 'succeeded')
        await this.settle(payment, PaymentStatus.COMPLETED, intent.id);
      else if (
        intent &&
        ['canceled', 'requires_payment_method'].includes(intent.status)
      )
        await this.settle(payment, PaymentStatus.FAILED, intent.id);
      else if (
        !intent &&
        Date.now() - payment.createdAt.getTime() > GIVE_UP_AFTER_MS
      )
        await this.settle(payment, PaymentStatus.FAILED, null); // never reached Stripe
    }
  }

  private async settle(
    payment: Payment,
    status: PaymentStatus.COMPLETED | PaymentStatus.FAILED,
    providerRef: string | null,
  ) {
    await this.transactions.run(async (tx) => {
      const [updated] = await this.paymentModel.update(
        { status, providerRef },
        {
          where: { id: payment.id, status: PaymentStatus.UNKNOWN },
          transaction: tx,
        },
      );
      if (updated === 0) return; // resolved concurrently by a Kafka retry

      if (status === PaymentStatus.COMPLETED) {
        await this.ledger.recordMarketplaceSale({
          paymentId: payment.id,
          buyerAccountId: `MERCHANT_${payment.userId}`,
          merchantAccountId: LEDGER_ACCOUNTS.CLEARING,
          platformRevenueAccountId: LEDGER_ACCOUNTS.PLATFORM_FEES,
          totalAmount: Number(payment.amount),
          feeAmount: PLATFORM_FEE_MINOR,
          tx,
        });
      }
      await this.outbox.append(
        PaymentProcessed.create(payment.idempotencyKey, 1, {
          payload: {
            idempotency_key: payment.idempotencyKey,
            bisOrderId: payment.bisOrderId,
            userId: payment.userId,
            amount: payment.amount,
          },
          extra: { payment: { id: payment.id, status } },
          ...(status === PaymentStatus.FAILED && {
            error: { title: 'Payment failed (resolved from UNKNOWN)' },
          }),
        }),
        tx,
      );
    });
    this.logger.log(`payment ${payment.id} UNKNOWN → ${status}`);
  }
}
