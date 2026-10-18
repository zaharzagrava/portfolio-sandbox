import { Inject, Injectable, Logger } from '@nestjs/common';
import { assertNoActiveTransaction } from '@app/infrastructure/context';
import { ApiConfigService } from '@app/common/config';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';
import type { BillingProviderTransport } from './billing-provider-transport';
import { ScriptedBillingTransport } from './scripted-billing-transport';
import {
  classifyError,
  classifyIntent,
  type ChargeOutcome,
  type IntentSnapshot,
  type LookupOutcome,
} from '../domain/charge-outcome';
import type { BillingGateway, ChargeRequest } from '../domain/ports';

export type { BillingProviderTransport };

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

/**
 * Binds the transport token to the real client, or to the scripted provider when `PROVIDER_DOUBLES=enabled` (the config
 * rules refuse that in production, like S13.R-31 for order payments): `pm_test_visa` settles, `pm_test_declined` declines.
 */
export const stripeTransportProvider = {
  provide: BILLING_PROVIDER_TRANSPORT,
  inject: [ApiConfigService, StripeService],
  useFactory: (
    config: ApiConfigService,
    stripe: StripeService,
  ): BillingProviderTransport =>
    config.get('provider_doubles') === 'enabled'
      ? new ScriptedBillingTransport()
      : stripe,
};
