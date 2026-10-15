import { Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import Stripe from 'stripe'; // Fixed: Cleaned up imports
import { InternalServerError } from '@app/common/errors';
import { ErrorUtilsService } from '@app/common/errors/error-utils/error-utils.service';
import { Event } from 'node_modules/stripe/cjs/resources/Events';
import { Response } from 'node_modules/stripe/cjs/lib';
import { VerificationSession } from 'node_modules/stripe/cjs/resources/Identity';
import { PaymentIntent } from 'node_modules/stripe/cjs/resources/PaymentIntents';
import { Session } from 'node_modules/stripe/cjs/resources/Checkout';

@Injectable()
export class StripeService {
  private readonly l = new Logger(StripeService.name);
  private readonly stripe: Stripe.Stripe; // Fixed: Changed Stripe.Stripe to Stripe

  constructor(
    private readonly configService: ApiConfigService,
    private readonly errorUtilsService: ErrorUtilsService,
  ) {
    // Thin client (S13 A24): no breaker and no retries here. The payments adapter owns both, so a call is sent once
    // and every call site picks its own timeout (`timeout` below is only the ceiling for callers that pass none).
    this.stripe = new Stripe(this.configService.get('stripe_secret_key'), {
      apiVersion: '2026-08-26.dahlia', // Use the version your account is pinned to, or the latest
      timeout: 15_000,
      maxNetworkRetries: 0,
    });
  }

  // Fixed: Changed Event.Event to Stripe.Event
  constructEvent(body: any, sig: string, endpointSecret: string): Event {
    try {
      return this.stripe.webhooks.constructEvent(body, sig, endpointSecret);
    } catch (error) {
      throw new InternalServerError('Failed to construct event', {
        causes: [error],
      });
    }
  }

  getIdentitySession(
    sessionId: string,
  ): Promise<Response<VerificationSession>> {
    return this.stripe.identity.verificationSessions.retrieve(sessionId);
  }

  /**
   * Creates and confirms an intent in one call. The SDK throws for card declines (`StripeCardError`, 402), for every
   * other error response and for timeouts; the payments adapter classifies them. `metadata` lets the webhook and the
   * unknown-outcome lookup map the intent back to our order.
   */
  public async createPaymentIntent(params: {
    amount: number;
    currency: string;
    paymentMethodId: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<Response<PaymentIntent>> {
    return await this.stripe.paymentIntents.create(
      {
        amount: params.amount, // minor units
        currency: params.currency.toLowerCase(),
        payment_method: params.paymentMethodId,
        confirm: true, // Attempt to charge it immediately
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: params.metadata ?? { idempotencyKey: params.idempotencyKey },
      },
      {
        idempotencyKey: params.idempotencyKey, // Stripe prevents double-charges natively!
        ...(params.timeoutMs !== undefined && { timeout: params.timeoutMs }),
        maxNetworkRetries: 0,
      },
    );
  }

  public retrievePaymentIntent(
    intentId: string,
    timeoutMs: number,
  ): Promise<Response<PaymentIntent>> {
    return this.stripe.paymentIntents.retrieve(intentId, undefined, {
      timeout: timeoutMs,
      maxNetworkRetries: 0,
    });
  }

  /** The intent whose `metadata[key]` equals `value` (search query values are escaped), or null. */
  public async findPaymentIntentByMetadata(
    key: string,
    value: string,
    timeoutMs: number,
  ): Promise<PaymentIntent | null> {
    const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await this.stripe.paymentIntents.search(
      { query: `metadata['${key}']:'${escaped}'`, limit: 1 },
      { timeout: timeoutMs, maxNetworkRetries: 0 },
    );
    return result.data[0] ?? null;
  }

  public cancelPaymentIntent(
    intentId: string,
    idempotencyKey: string,
    timeoutMs: number,
  ): Promise<Response<PaymentIntent>> {
    return this.stripe.paymentIntents.cancel(intentId, undefined, {
      idempotencyKey,
      timeout: timeoutMs,
      maxNetworkRetries: 0,
    });
  }

  /** A full refund of the charge; `idempotencyKey` is ours (`refund:<paymentId>`), the provider dedupes on it. */
  public createRefund(
    paymentIntentId: string,
    idempotencyKey: string,
    timeoutMs: number,
  ) {
    return this.stripe.refunds.create(
      { payment_intent: paymentIntentId },
      { idempotencyKey, timeout: timeoutMs, maxNetworkRetries: 0 },
    );
  }

  /** The refunds the provider holds for a charge (a lookup before any retry of a refund). */
  public async listRefunds(paymentIntentId: string, timeoutMs: number) {
    const result = await this.stripe.refunds.list(
      { payment_intent: paymentIntentId, limit: 10 },
      { timeout: timeoutMs, maxNetworkRetries: 0 },
    );
    return result.data;
  }

  public async createPaymentSession({
    userId,
    priceId,
  }: {
    userId: string;
    priceId: 'verification_payment_price_id';
  }): Promise<Response<Session>> {
    try {
      const session = await this.stripe.checkout.sessions.create({
        success_url: `${this.configService.get('front_host')}/app/settings`,
        ui_mode: 'hosted_page',
        metadata: {
          userId,
        },
        mode: 'setup',
        currency: 'usd',
      });

      return session;
    } catch (error) {
      throw new InternalServerError('Failed to create payment session', {
        causes: [error],
      });
    }
  }

  public async createIdentitySession({
    userId,
  }: {
    userId: string;
  }): Promise<Response<VerificationSession>> {
    try {
      const session = await this.stripe.identity.verificationSessions.create({
        return_url: `${this.configService.get('front_host')}/stripe/identity-session-callback`,
        metadata: {
          userId,
        },
        type: 'document',
      });

      if (!session.url) {
        throw new InternalServerError('Failed to create identity session');
      }

      return session;
    } catch (error) {
      const newError = new InternalServerError(
        'Failed to create identity session',
        {
          causes: [error],
        },
      );

      this.errorUtilsService.captureSentryException(newError);
      throw newError;
    }
  }

  // --- SD-20: unknown outcomes, reconciliation, payouts --- //

  /**
   * A timeout or dropped connection means "we don't know if the charge
   * happened". Card declines and validation errors are definite failures.
   */
  public isUnknownOutcome(error: unknown): boolean {
    const e = error as {
      type?: string;
      code?: string;
      message?: string;
      name?: string;
    };
    return (
      e?.type === 'StripeConnectionError' ||
      e?.type === 'StripeAPIError' ||
      e?.code === 'ETIMEDOUT' ||
      e?.code === 'ECONNRESET' ||
      /timed out/i.test(e?.message ?? '')
    );
  }

  /** "Query the provider by OUR reference" (lesson 10/02 Ex1) - never re-send a charge whose outcome is unknown. */
  public async findPaymentIntentByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PaymentIntent | null> {
    const result = await this.stripe.paymentIntents.search({
      query: `metadata['idempotencyKey']:'${idempotencyKey.replace(/'/g, '')}'`,
      limit: 1,
    });
    return result.data[0] ?? null;
  }

  /**
   * One page of the account's balance transactions created in [from, to) (S14 statement). `source` is expanded so a
   * charge, refund or dispute line carries its own id and, for a charge, the payment intent. No retry: the caller
   * (the reconciliation job layer) owns retries; `timeoutMs` bounds the call.
   */
  public async listBalanceTransactions(params: {
    fromInclusive: Date;
    toExclusive: Date;
    startingAfter?: string;
    limit: number;
    timeoutMs: number;
  }): Promise<{ data: Stripe.BalanceTransaction[]; hasMore: boolean }> {
    const page = await this.stripe.balanceTransactions.list(
      {
        created: {
          gte: Math.floor(params.fromInclusive.getTime() / 1000),
          lt: Math.floor(params.toExclusive.getTime() / 1000),
        },
        limit: params.limit,
        ...(params.startingAfter && { starting_after: params.startingAfter }),
        expand: ['data.source'],
      },
      { timeout: params.timeoutMs, maxNetworkRetries: 0 },
    );
    return { data: page.data, hasMore: page.has_more };
  }

  /**
   * The balance transaction of a payment intent (`pi_…`), a refund (`re_…`) or a dispute (`dp_…`) by our stored
   * reference, wherever in time it happened; `null` when the provider has no such object.
   */
  public async retrieveBalanceTransactionByReference(
    reference: string,
    timeoutMs: number,
  ): Promise<Stripe.BalanceTransaction | null> {
    const options = { timeout: timeoutMs, maxNetworkRetries: 0 };
    try {
      if (reference.startsWith('pi_')) {
        const intent = await this.stripe.paymentIntents.retrieve(
          reference,
          { expand: ['latest_charge.balance_transaction'] },
          options,
        );
        const charge = intent.latest_charge;
        const transaction =
          charge && typeof charge === 'object'
            ? charge.balance_transaction
            : null;
        return transaction && typeof transaction === 'object'
          ? transaction
          : null;
      }
      if (reference.startsWith('re_')) {
        const refund = await this.stripe.refunds.retrieve(
          reference,
          { expand: ['balance_transaction'] },
          options,
        );
        const transaction = refund.balance_transaction;
        return transaction && typeof transaction === 'object'
          ? transaction
          : null;
      }
      if (reference.startsWith('dp_')) {
        const dispute = await this.stripe.disputes.retrieve(
          reference,
          { expand: ['balance_transactions'] },
          options,
        );
        return dispute.balance_transactions?.[0] ?? null;
      }
      return null;
    } catch (error) {
      if ((error as { code?: string }).code === 'resource_missing') return null;
      throw error;
    }
  }

  /**
   * Stripe Connect transfer to a shop's connected account, idempotent by our payout id (the key, the transfer group and
   * the metadata all carry it). Thin: no retry (`maxNetworkRetries: 0`), `timeoutMs` bounds the call, and the
   * payout adapter classifies every error.
   */
  public async createTransfer(params: {
    amountMinor: number;
    currency: string;
    destination: string;
    idempotencyKey: string;
    transferGroup: string;
    timeoutMs: number;
  }): Promise<TransferRecord> {
    if (this.configService.get('is_load_test'))
      return {
        id: `tr_loadtest_${params.idempotencyKey}`,
        amount: params.amountMinor,
        currency: params.currency.toLowerCase(),
        destination: params.destination,
        reversed: false,
      };
    const transfer = await this.stripe.transfers.create(
      {
        amount: params.amountMinor,
        currency: params.currency.toLowerCase(),
        destination: params.destination,
        transfer_group: params.transferGroup,
        metadata: { payoutId: params.idempotencyKey },
      },
      {
        idempotencyKey: params.idempotencyKey,
        timeout: params.timeoutMs,
        maxNetworkRetries: 0,
      },
    );
    return toTransferRecord(transfer);
  }

  /** The transfers of a transfer group (our payout id), at most three: more than one is an alarm for the caller. */
  public async listTransfersByGroup(
    group: string,
    timeoutMs: number,
  ): Promise<TransferRecord[]> {
    if (this.configService.get('is_load_test')) return [];
    const page = await this.stripe.transfers.list(
      { transfer_group: group, limit: 3 },
      { timeout: timeoutMs, maxNetworkRetries: 0 },
    );
    return page.data.map(toTransferRecord);
  }
}

/** A transfer as the payout adapter needs it: plain values, never the SDK object. */
export interface TransferRecord {
  id: string;
  amount: number;
  currency: string;
  destination: string;
  reversed: boolean;
}

function toTransferRecord(t: Stripe.Transfer): TransferRecord {
  return {
    id: t.id,
    amount: t.amount,
    currency: t.currency,
    destination:
      typeof t.destination === 'string'
        ? t.destination
        : (t.destination?.id ?? ''),
    reversed: t.reversed,
  };
}
