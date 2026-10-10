import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { LedgerJournalKind } from '../infra/models/ledger-entry.model';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { JournalPosted } from './events/ledger-events';
import { InjectModel } from '@nestjs/sequelize';
import LedgerEntry from '../infra/models/ledger-entry.model';
import { Transaction } from 'sequelize';
import { DbUtilsService } from '@app/infrastructure/database/db-utils/db-utils.service';
import { v5 as uuidv5 } from 'uuid';
import { LEDGER_ACCOUNTS, PLATFORM_FEE_MINOR } from '../domain/accounts';

/** Namespace of the deterministic journal ids of captured and refunded payments. */
const PAYMENT_NS = '5d1a2f7e-6c1b-4a58-9b38-2f3a7d0c8e44';

@Injectable()
export class LedgerService {
  private readonly l = new Logger(LedgerService.name);

  constructor(
    @InjectModel(LedgerEntry)
    private readonly ledgerEntryModel: typeof LedgerEntry,
    private readonly dbUtilsService: DbUtilsService,
    @Optional() private readonly domainEvents?: OutboxService,
  ) {}

  public async recordMarketplaceSale({
    paymentId,
    buyerAccountId,
    merchantAccountId,
    platformRevenueAccountId,
    totalAmount,
    feeAmount,
    tx,
  }: {
    paymentId: string;
    buyerAccountId: string;
    merchantAccountId: string;
    platformRevenueAccountId: string;
    totalAmount: number;
    feeAmount: number;
    tx: Transaction;
  }): Promise<void> {
    await this.dbUtilsService.wrapInTransaction(async (tx) => {
      if (totalAmount < feeAmount) {
        throw new InternalServerErrorException(
          'CRITICAL: Total amount is less than fee amount.',
        );
      }

      const buyerDebit = -Math.abs(totalAmount);
      const merchantCredit = Math.abs(totalAmount - feeAmount);
      const platformCredit = Math.abs(feeAmount);

      if (buyerDebit + merchantCredit + platformCredit !== 0) {
        // If this throws, the outer Postgres transaction automatically rolls back.
        throw new InternalServerErrorException(
          'CRITICAL: Ledger entry mathematically invalid. Amounts do not sum to zero.',
        );
      }

      // One SALE journal per payment (journalId = paymentId). SD-20: posted through
      // `post()` so the balanced-journal invariant + balance events apply uniformly.
      await this.post(
        {
          journalId: paymentId,
          kind: 'SALE',
          paymentId,
          lines: [
            { accountId: buyerAccountId, amount: buyerDebit }, // Usually a system account tracking Stripe's incoming FBO balance
            { accountId: merchantAccountId, amount: merchantCredit }, // Clearing until settled to shops (SD-20)
            { accountId: platformRevenueAccountId, amount: platformCredit }, // You
          ],
        },
        tx,
      );
    }, tx);
  }

  /**
   * Books a captured payment (S13 CONTRACT 8; S14 replaces the internals, the name and shape stay): one SALE journal
   * per payment, id `uuidv5('sale:' + paymentId)`, so a repeat finds it and does nothing. Runs in the caller's
   * transaction. The buyer side is the provider-funds account, never an account named after the user.
   */
  public async recordPaymentCaptured(
    payment: {
      paymentId: string;
      userId: string;
      amountMinor: number;
      currency: string;
    },
    tx: Transaction,
  ): Promise<{ journalId: string }> {
    const journalId = uuidv5(`sale:${payment.paymentId}`, PAYMENT_NS);
    if (await this.journalExists(journalId, tx)) return { journalId };
    const fee = Math.min(PLATFORM_FEE_MINOR, payment.amountMinor);
    await this.post(
      {
        journalId,
        kind: 'SALE',
        paymentId: payment.paymentId,
        lines: [
          {
            accountId: LEDGER_ACCOUNTS.PROVIDER_FUNDS,
            amount: -payment.amountMinor,
          },
          {
            accountId: LEDGER_ACCOUNTS.CLEARING,
            amount: payment.amountMinor - fee,
          },
          { accountId: LEDGER_ACCOUNTS.PLATFORM_FEES, amount: fee },
        ],
      },
      tx,
    );
    return { journalId };
  }

  /** The reversal of `recordPaymentCaptured`, id `uuidv5('refund:' + paymentId)`; idempotent the same way. */
  public async recordPaymentRefunded(
    payment: { paymentId: string; amountMinor: number; currency: string },
    tx: Transaction,
  ): Promise<{ journalId: string }> {
    const journalId = uuidv5(`refund:${payment.paymentId}`, PAYMENT_NS);
    if (await this.journalExists(journalId, tx)) return { journalId };
    const fee = Math.min(PLATFORM_FEE_MINOR, payment.amountMinor);
    await this.post(
      {
        journalId,
        kind: 'REFUND',
        paymentId: payment.paymentId,
        lines: [
          {
            accountId: LEDGER_ACCOUNTS.PROVIDER_FUNDS,
            amount: payment.amountMinor,
          },
          {
            accountId: LEDGER_ACCOUNTS.CLEARING,
            amount: -(payment.amountMinor - fee),
          },
          { accountId: LEDGER_ACCOUNTS.PLATFORM_FEES, amount: -fee },
        ],
      },
      tx,
    );
    return { journalId };
  }

  private async journalExists(
    journalId: string,
    tx: Transaction,
  ): Promise<boolean> {
    // The advisory lock serialises two postings of the same journal; the check then sees the first one.
    await this.ledgerEntryModel.sequelize!.query(
      `SELECT pg_advisory_xact_lock(hashtext(:journalId))`,
      { replacements: { journalId }, transaction: tx },
    );
    const [{ exists }] = await this.ledgerEntryModel.sequelize!.query<{
      exists: boolean;
    }>(
      `SELECT EXISTS (SELECT 1 FROM "LedgerEntry" WHERE "journalId" = :journalId) AS exists`,
      {
        type: QueryTypes.SELECT,
        replacements: { journalId },
        transaction: tx,
      },
    );
    return exists;
  }

  /**
   * Posts one balanced journal (double-entry, lesson 10/02 Ex1): validated here
   * (fast feedback) AND by the deferred `ledger_balanced` constraint trigger at
   * COMMIT (the database is the last line of defense). Emits `ledger.journal_posted`
   * through the outbox in the same transaction for the balance read model.
   */
  public async post(
    journal: {
      journalId: string;
      kind: LedgerJournalKind;
      paymentId?: string | null;
      lines: { accountId: string; amount: number }[];
    },
    tx: Transaction,
  ): Promise<void> {
    const sum = journal.lines.reduce((acc, l) => acc + l.amount, 0);
    if (
      sum !== 0 ||
      journal.lines.some((l) => !Number.isSafeInteger(l.amount))
    ) {
      throw new InternalServerErrorException(
        `CRITICAL: unbalanced journal ${journal.journalId} (sum ${sum})`,
      );
    }

    await this.ledgerEntryModel.bulkCreate(
      journal.lines
        .filter((l) => l.amount !== 0)
        .map((l) => ({
          journalId: journal.journalId,
          kind: journal.kind,
          paymentId: journal.paymentId ?? null,
          accountId: l.accountId,
          amount: BigInt(l.amount),
        })),
      { transaction: tx, validate: true },
    );

    await this.domainEvents?.append(
      JournalPosted.create(journal.journalId, 1, {
        kind: journal.kind,
        lines: journal.lines,
      }),
      tx,
    );
  }

  /** Authoritative balance (sum of entries) - the Redis projection is the fast path; this is the fallback/rebuild. */
  public async balance(accountId: string, tx?: Transaction): Promise<number> {
    const [row] = await this.ledgerEntryModel.sequelize!.query<{
      balance: string;
    }>(
      `SELECT coalesce(sum(amount), 0)::bigint AS balance FROM "LedgerEntry" WHERE "accountId" = :accountId`,
      { replacements: { accountId }, transaction: tx, type: QueryTypes.SELECT },
    );
    return Number(row.balance);
  }
}
