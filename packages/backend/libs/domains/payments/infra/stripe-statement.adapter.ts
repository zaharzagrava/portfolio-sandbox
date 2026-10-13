import { Injectable } from '@nestjs/common';
import type Stripe from 'stripe';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';
import {
  ProviderUnavailableError,
  type ProviderStatement,
  type StatementPage,
} from '../domain/ledger-ports';

/** Per-call bound of every statement call (FR-034); the adapter makes no retry of its own. */
export const STATEMENT_TIMEOUT_MS = 10_000;

const asId = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
    : value &&
        typeof value === 'object' &&
        typeof (value as { id?: unknown }).id === 'string'
      ? (value as { id: string }).id
      : undefined;

/**
 * One balance transaction as the matcher's raw line `{id, type, reference, amount, currency, created}`: the
 * reference is what our journals store (a payment intent id for a charge, a refund id, a dispute id). Anything it
 * cannot map keeps its raw `type` so the matcher skips it; nothing but these fields is kept (no raw body).
 */
export function toRawLine(
  bt: Stripe.BalanceTransaction,
): Record<string, unknown> {
  const source = bt.source as unknown;
  const category = (bt as { reporting_category?: string }).reporting_category;
  let type: string = bt.type;
  let reference: string | undefined;
  if (bt.type === 'charge' || bt.type === 'payment') {
    type = 'charge';
    reference =
      asId((source as { payment_intent?: unknown } | null)?.payment_intent) ??
      asId(source);
  } else if (bt.type === 'refund' || bt.type === 'payment_refund') {
    type = 'refund';
    reference = asId(source);
  } else if (category === 'dispute' || bt.type === 'dispute') {
    type = 'dispute';
    reference = asId(source);
  }
  return {
    id: bt.id,
    type,
    reference,
    amount: bt.amount,
    currency: bt.currency,
    created: bt.created,
  };
}

const isUnavailable = (error: unknown): boolean => {
  const e = error as {
    type?: string;
    statusCode?: number;
    code?: string;
    message?: string;
  };
  return (
    e?.type === 'StripeConnectionError' ||
    e?.type === 'StripeAPIError' ||
    e?.type === 'StripeRateLimitError' ||
    e?.statusCode === 429 ||
    (e?.statusCode !== undefined && e.statusCode >= 500) ||
    e?.code === 'ETIMEDOUT' ||
    e?.code === 'ECONNRESET' ||
    /timed out|timeout/i.test(e?.message ?? '')
  );
};

/** Statement port over the thin Stripe client: validates nothing itself, maps shapes, classifies failures. */
@Injectable()
export class StripeStatementAdapter implements ProviderStatement {
  constructor(private readonly stripe: StripeService) {}

  async listLines(input: {
    fromInclusive: Date;
    toExclusive: Date;
    cursor: string | null;
    limit: number;
  }): Promise<StatementPage> {
    try {
      const page = await this.stripe.listBalanceTransactions({
        fromInclusive: input.fromInclusive,
        toExclusive: input.toExclusive,
        startingAfter: input.cursor ?? undefined,
        limit: input.limit,
        timeoutMs: STATEMENT_TIMEOUT_MS,
      });
      return {
        lines: page.data.map(toRawLine),
        nextCursor:
          page.hasMore && page.data.length > 0
            ? page.data[page.data.length - 1].id
            : null,
      };
    } catch (error) {
      throw this.refuse(error);
    }
  }

  async findByReference(reference: string): Promise<unknown | null> {
    try {
      const bt = await this.stripe.retrieveBalanceTransactionByReference(
        reference,
        STATEMENT_TIMEOUT_MS,
      );
      return bt ? { ...toRawLine(bt), reference } : null;
    } catch (error) {
      throw this.refuse(error);
    }
  }

  private refuse(error: unknown): Error {
    return isUnavailable(error)
      ? new ProviderUnavailableError(
          `the statement call failed (${(error as Error).name})`,
        )
      : (error as Error);
  }
}
