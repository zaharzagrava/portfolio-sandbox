import { Inject, Injectable, Logger } from '@nestjs/common';
import { assertNoActiveTransaction } from '@app/infrastructure/context';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';
import {
  classifyError,
  classifyIntent,
  type ChargeOutcome,
  type IntentSnapshot,
  type LookupOutcome,
} from '../domain/charge-outcome';
import type { BillingGateway, ChargeRequest } from '../domain/ports';

/** What the adapter needs from the provider SDK (the thin `StripeService` satisfies it; the e2e kit swaps in a scripted double). */
export interface BillingProviderTransport {
  createPaymentIntent(params: {
    amount: number;
    currency: string;
    paymentMethodId: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<IntentSnapshot>;
  findPaymentIntentByMetadataPair(
    pairs: Record<string, string>,
    timeoutMs: number,
  ): Promise<IntentSnapshot | null>;
}

export const BILLING_PROVIDER_TRANSPORT = Symbol('BILLING_PROVIDER_TRANSPORT');

export const SUBSCRIPTION_INVOICE_KIND = 'subscription_invoice';

/** The provider's idempotency key and our reference for one attempt: `<invoiceId>:<attempt>` (S17 FR-031). */
export const chargeKey = (invoiceId: string, attemptRef: string): string =>
  `${invoiceId}:${attemptRef}`;

/**
 * Anti-corruption adapter over the provider client (IV.8): billing's charge in the invoice's own currency, tagged
 * `kind: subscription_invoice` and never `idempotencyKey` (the order webhook keys on that field), classified into
 * the closed set of outcomes. It sends once (`maxNetworkRetries: 0` in the client), never inside a transaction, and
 * never logs the payment reference.
 */
@Injectable()
export class StripeBillingGateway implements BillingGateway {
  private readonly logger = new Logger(StripeBillingGateway.name);

  constructor(
    @Inject(BILLING_PROVIDER_TRANSPORT)
    private readonly transport: BillingProviderTransport,
  ) {}

  async charge(request: ChargeRequest): Promise<ChargeOutcome> {
    assertNoActiveTransaction('network');
    try {
      const intent = await this.transport.createPaymentIntent({
        amount: request.amountMinor,
        currency: request.currency,
        paymentMethodId: request.paymentMethodRef,
        idempotencyKey: chargeKey(request.invoiceId, request.attemptRef),
        metadata: {
          kind: SUBSCRIPTION_INVOICE_KIND,
          invoiceId: request.invoiceId,
          subscriptionId: request.subscriptionId,
          attempt: request.attemptRef,
        },
        timeoutMs: request.timeoutMs,
      });
      const outcome = classifyIntent(intent);
      if (outcome.kind === 'unknown')
        this.logger.warn(
          `unclassifiable provider answer for invoice ${request.invoiceId} attempt ${request.attemptRef}` +
            ` (status ${typeof intent?.status === 'string' ? intent.status : 'missing'})`,
        );
      return outcome;
    } catch (error) {
      const outcome = classifyError(error);
      if (outcome.kind === 'unknown') {
        const requestId = (error as { requestId?: string }).requestId;
        this.logger.warn(
          `provider did not answer for invoice ${request.invoiceId} attempt ${request.attemptRef}` +
            (requestId ? ` (request ${requestId})` : ''),
        );
      }
      return outcome;
    }
  }

  async lookup(
    invoiceId: string,
    attemptRef: string,
    timeoutMs: number,
  ): Promise<LookupOutcome> {
    assertNoActiveTransaction('network');
    const intent = await this.transport.findPaymentIntentByMetadataPair(
      { invoiceId, attempt: attemptRef },
      timeoutMs,
    );
    if (!intent) return { kind: 'not_found' };
    const outcome = classifyIntent(intent);
    // The intent exists but is still moving (or says something nobody can read): not settled, not "nothing there".
    if (outcome.kind === 'unknown')
      throw new Error('the provider charge is not in a final state yet');
    return { kind: 'found', outcome };
  }
}

/** Binds the transport token to the real client. */
export const stripeTransportProvider = {
  provide: BILLING_PROVIDER_TRANSPORT,
  useExisting: StripeService,
};
