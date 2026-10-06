import { metrics } from '@opentelemetry/api';
import { Injectable, Logger } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config/api-config.service';
import Stripe from 'stripe'; // Fixed: Cleaned up imports
import CircuitBreaker from 'opossum';
import { InternalServerError } from '@app/common/errors/error.types';
import { ErrorUtilsService } from '@app/common/errors/error-utils/error-utils.service';
import { Domain_CircuitBreakerOpenError } from './stripe.errors';
import { Event } from 'node_modules/stripe/cjs/resources/Events';
import { Response } from 'node_modules/stripe/cjs/lib';
import { VerificationSession } from 'node_modules/stripe/cjs/resources/Identity';
import { PaymentIntent } from 'node_modules/stripe/cjs/resources/PaymentIntents';
import { Session } from 'node_modules/stripe/cjs/resources/Checkout';

@Injectable()
export class StripeService {
  private readonly l = new Logger(StripeService.name);
  private readonly stripe: Stripe.Stripe; // Fixed: Changed Stripe.Stripe to Stripe
  private readonly createPaymentIntentBreaker: CircuitBreaker<
    [{ amount: number; paymentMethodId: string; idempotencyKey: string }],
    Response<PaymentIntent>
  >;

  constructor(
    private readonly configService: ApiConfigService,
    private readonly errorUtilsService: ErrorUtilsService,
  ) {
    // Fixed: Added the required apiVersion config object
    this.stripe = new Stripe(this.configService.get('stripe_secret_key'), {
      apiVersion: '2026-08-26.dahlia', // Use the version your account is pinned to, or the latest
    });

    this.createPaymentIntentBreaker = new CircuitBreaker(
      (params: { amount: number; paymentMethodId: string; idempotencyKey: string }) =>
        this.createPaymentIntentUnprotected(params),
      { errorThresholdPercentage: 50, resetTimeout: 10_000, timeout: 15_000 },
    );
    // SD-33: breaker state as a gauge (1 = open) → alert StripeCircuitOpen.
    metrics
      .getMeter('payments')
      .createObservableGauge('circuit_breaker_open', { description: '1 while the circuit breaker is open' })
      .addCallback((r) => r.observe(this.createPaymentIntentBreaker.opened ? 1 : 0, { breaker: 'stripe.create_payment_intent' }));
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

  // TODO: Depending on how you configured your stripeService.createPaymentIntent wrapper, the official Stripe Node SDK throws exceptions for card declines (like Insufficient Funds, Fraud, or Expired Cards) returning a 402 Payment Required HTTP status. It doesn't return a neat object with status: 'failed'.
  public async createPaymentIntent(params: {
    amount: number;
    paymentMethodId: string;
    idempotencyKey: string;
  }): Promise<Response<PaymentIntent>> {
    try {
      return await this.createPaymentIntentBreaker.fire(params);
    } catch (error) {
      if (this.createPaymentIntentBreaker.opened) {
        throw new Domain_CircuitBreakerOpenError({ causes: [error] });
      }
      throw error;
    }
  }

  private async createPaymentIntentUnprotected({
    amount,
    paymentMethodId,
    idempotencyKey,
  }: {
    amount: number;
    paymentMethodId: string;
    idempotencyKey: string;
  }): Promise<Response<PaymentIntent>> {
    if (this.configService.get('is_load_test')) {
      return {
        status: 'succeeded',
        payment_method: paymentMethodId,
        amount: amount,
        currency: 'usd',
        created: Date.now(),
      } as any;
    }

    return await this.stripe.paymentIntents.create(
      {
        amount: amount, // e.g., 10000 cents ($100.00)
        currency: 'usd',
        payment_method: paymentMethodId,
        confirm: true, // Attempt to charge it immediately
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        // SD-19: lets the Stripe webhook map the intent back to our Payment/order.
        metadata: { idempotencyKey },
      },
      {
        idempotencyKey: idempotencyKey, // Stripe prevents double-charges natively!
      },
    );
  }

  public async refundPaymentIntent({
    paymentIntentId,
    idempotencyKey,
  }: {
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (this.configService.get('is_load_test')) {
      return;
    }

    await this.stripe.refunds.create(
      { payment_intent: paymentIntentId },
      { idempotencyKey: `refund:${idempotencyKey}` },
    );
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
    const e = error as { type?: string; code?: string; message?: string; name?: string };
    return (
      e?.type === 'StripeConnectionError' ||
      e?.type === 'StripeAPIError' ||
      e?.code === 'ETIMEDOUT' ||
      e?.code === 'ECONNRESET' ||
      /timed out/i.test(e?.message ?? '')
    );
  }

  /** "Query the provider by OUR reference" (lesson 10/02 Ex1) - never re-send a charge whose outcome is unknown. */
  public async findPaymentIntentByIdempotencyKey(idempotencyKey: string): Promise<PaymentIntent | null> {
    const result = await this.stripe.paymentIntents.search({ query: `metadata['idempotencyKey']:'${idempotencyKey.replace(/'/g, '')}'`, limit: 1 });
    return result.data[0] ?? null;
  }

  /** Streams every PaymentIntent created in [from, to) - auto-pagination with backpressure (`for await`). */
  public async *paymentIntentsCreatedBetween(from: Date, to: Date): AsyncGenerator<PaymentIntent> {
    for await (const intent of this.stripe.paymentIntents.list({
      created: { gte: Math.floor(from.getTime() / 1000), lt: Math.floor(to.getTime() / 1000) },
      limit: 100,
    })) {
      yield intent;
    }
  }

  /** Stripe Connect transfer to a shop's connected account; idempotent by our payout id. */
  public async transfer(params: { amount: number; currency: string; destination: string; idempotencyKey: string }): Promise<{ id: string }> {
    if (this.configService.get('is_load_test')) return { id: `tr_loadtest_${params.idempotencyKey}` };
    const transfer = await this.stripe.transfers.create(
      { amount: params.amount, currency: params.currency.toLowerCase(), destination: params.destination, metadata: { payoutId: params.idempotencyKey } },
      { idempotencyKey: params.idempotencyKey },
    );
    return { id: transfer.id };
  }
}
