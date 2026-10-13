import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Transaction } from 'sequelize';
import { ApiConfigService } from '@app/common/config';
import { CLOCK, Clock } from '@app/common/core/clock';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { isGuarded, parseAccountId } from '../domain/account';
import {
  InsufficientBalance,
  JournalConflict,
  JournalInvalid,
  JournalUnbalanced,
  LedgerBusy,
  TransactionRequired,
} from '../domain/ledger-errors';
import {
  BALANCE_STORE,
  JOURNAL_STORE,
  type BalanceStore,
  type JournalHeader,
  type JournalStore,
} from '../domain/ledger-ports';
import {
  journalsPostedCounter,
  postRejectedCounter,
} from '../domain/ledger-metrics';
import {
  type JournalKind,
  type JournalLineInput,
  journalFingerprint,
  journalId,
  validateJournal,
} from '../domain/journal';
import { aggregateRows } from '../domain/lock-order';
import { shardFor } from '../domain/shard';
import { JournalPosted } from './events/ledger-events';

/** Plain references a journal header records (FR-012: the payer is only a reference). */
export interface JournalLinks {
  paymentId?: string | null;
  orderId?: string | null;
  paymentRef?: string | null;
  refundRef?: string | null;
  userId?: string | null;
  clearingMinor?: number | null;
  amountMinor?: number | null;
  reversesJournalId?: string | null;
  correctsDay?: string | null;
}

export interface PostCommand {
  kind: JournalKind;
  reference: string;
  currency: string;
  lines: (JournalLineInput & { shard?: number })[];
  /** Hash input for the shard of the hot accounts; defaults to the reference. */
  shardKey?: string;
  /** True for `postJournal` (the four caller kinds); false for the ledger's own postings. */
  fromCaller: boolean;
  links?: JournalLinks;
}

export interface PostResult {
  journalId: string;
  created: boolean;
  header: JournalHeader;
}

const LOCK_NOT_AVAILABLE = '55P03';
const QUERY_CANCELED = '57014';

const pgCode = (error: unknown): string | undefined =>
  (error as { parent?: { code?: string }; original?: { code?: string } })
    ?.parent?.code ??
  (error as { original?: { code?: string } })?.original?.code;

/**
 * The one posting path (S14 research R-1, R-4): validate (pure), insert the header unique on (kind, reference), move
 * the running balances in sorted (account, shard) order with the non-negative guard, write the entries with one
 * `postedAt`, and append `ledger.journal_posted` v2 to the outbox. It joins the caller's transaction and never opens,
 * commits or nests one (FR-006); it does no network I/O. Failures after the first write carry `rollbackRequired`.
 */
@Injectable()
export class JournalPostingService {
  private readonly logger = new Logger(JournalPostingService.name);

  constructor(
    @Inject(JOURNAL_STORE) private readonly journals: JournalStore,
    @Inject(BALANCE_STORE) private readonly balances: BalanceStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly config: ApiConfigService,
  ) {}

  async post(
    command: PostCommand,
    tx: Transaction | undefined,
  ): Promise<PostResult> {
    if (!tx) {
      postRejectedCounter.add(1, { reason: 'transaction_required' });
      throw new TransactionRequired();
    }
    try {
      return await this.run(command, tx);
    } catch (error) {
      const refused = this.counted(error);
      this.logger.warn(
        `journal ${String(command.kind)}:${String(command.reference)} refused (${(refused as { code?: string }).code ?? 'error'})`,
      );
      throw refused;
    }
  }

  private async run(
    command: PostCommand,
    tx: Transaction,
  ): Promise<PostResult> {
    validateJournal(
      {
        kind: command.kind,
        reference: command.reference,
        currency: command.currency,
        lines: command.lines,
      },
      { fromCaller: command.fromCaller },
    );

    const shards = this.config.get('ledger_shards');
    const shardKey = command.shardKey ?? command.reference;
    const lines = command.lines.map((l) => {
      const account = parseAccountId(l.accountId)!;
      // Only the ledger's own postings name shards (a sweep, a refund on the sale's shards): callers never do (FR-010).
      const explicit =
        !command.fromCaller && l.shard !== undefined && account.sharded
          ? l.shard
          : undefined;
      return {
        accountId: account.id,
        shard: explicit ?? shardFor(account.id, shardKey, shards),
        amountMinor: l.amountMinor,
      };
    });
    const rows = aggregateRows(lines); // may raise balance_overflow before any write

    const postedAt = this.clock.now();
    const id = journalId(command.kind, command.reference);
    const links = command.links ?? {};
    const header: JournalHeader = {
      id,
      kind: command.kind,
      reference: command.reference,
      currency: command.currency,
      postedAt,
      fingerprint: journalFingerprint(command.currency, lines),
      paymentId: links.paymentId ?? null,
      orderId: links.orderId ?? null,
      paymentRef: links.paymentRef ?? null,
      refundRef: links.refundRef ?? null,
      userId: links.userId ?? null,
      clearingMinor: links.clearingMinor ?? null,
      amountMinor: links.amountMinor ?? null,
      reversesJournalId: links.reversesJournalId ?? null,
      correctsDay: links.correctsDay ?? null,
    };

    await this.balances.bound(tx, {
      lockTimeoutMs: this.config.get('ledger_lock_timeout_ms'),
      statementTimeoutMs: this.config.get('ledger_statement_timeout_ms'),
    });

    const inserted = await this.journals.insertHeader(header, tx);
    if (!inserted.created) {
      const existing = inserted.existing;
      if (
        existing.fingerprint !== header.fingerprint ||
        existing.currency !== header.currency
      )
        throw new JournalConflict();
      return { journalId: existing.id, created: false, header: existing };
    }

    const applied = await this.balances.apply(
      command.currency,
      rows.map((r) => {
        const account = parseAccountId(r.accountId)!;
        return {
          accountId: r.accountId,
          shard: r.shard,
          amountMinor: r.amountMinor,
          guarded: isGuarded(account, command.kind, r.amountMinor),
        };
      }),
      postedAt,
      tx,
    );

    await this.journals.insertEntries(
      lines.map((l) => ({
        journalId: id,
        kind: command.kind,
        paymentId: header.paymentId,
        accountId: l.accountId,
        shard: l.shard,
        amountMinor: l.amountMinor,
        currency: command.currency,
        postedAt,
      })),
      tx,
    );

    await this.outbox.append(
      JournalPosted.create(id, 1, {
        journalId: id,
        kind: command.kind,
        currency: command.currency,
        postedAt: postedAt.toISOString(),
        lines: applied.map((a, i) => ({
          accountId: a.accountId,
          shard: a.shard,
          amountMinor: rows[i].amountMinor,
          balanceAfterMinor: a.balanceMinor,
          balanceVersion: a.version,
        })),
        ...(header.paymentId ? { paymentId: header.paymentId } : {}),
        ...(header.orderId ? { orderId: header.orderId } : {}),
      }),
      tx,
    );

    journalsPostedCounter.add(1, { kind: command.kind });
    this.logger.debug(`journal ${id} posted (${command.kind})`);
    return { journalId: id, created: true, header };
  }

  /** Counts the refusal under its reason and maps database waits to the retryable `ledger_busy`. */
  private counted(error: unknown): unknown {
    const code = pgCode(error);
    if (code === LOCK_NOT_AVAILABLE || code === QUERY_CANCELED) {
      postRejectedCounter.add(1, { reason: 'ledger_busy' });
      return new LedgerBusy();
    }
    if (error instanceof JournalInvalid)
      postRejectedCounter.add(1, { reason: error.reason });
    else if (error instanceof JournalUnbalanced)
      postRejectedCounter.add(1, { reason: 'journal_unbalanced' });
    else if (error instanceof JournalConflict)
      postRejectedCounter.add(1, { reason: 'journal_conflict' });
    else if (error instanceof InsufficientBalance)
      postRejectedCounter.add(1, { reason: 'insufficient_balance' });
    else if (error instanceof LedgerBusy)
      postRejectedCounter.add(1, { reason: 'ledger_busy' });
    return error;
  }
}
