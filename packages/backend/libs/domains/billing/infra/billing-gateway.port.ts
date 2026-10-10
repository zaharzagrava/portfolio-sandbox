import { Injectable } from '@nestjs/common';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';

export interface ChargeRequest {
  amount: number;
  currency: string;
  paymentMethodRef: string;
  /** = invoice id + attempt: retries of the same attempt never double charge. */
  idempotencyKey: string;
}

export type ChargeResult =
  | { ok: true; providerRef: string }
  | { ok: false; definite: boolean; reason: string };

export abstract class BillingGateway {
  abstract charge(request: ChargeRequest): Promise<ChargeResult>;
}

@Injectable()
export class StripeBillingGateway extends BillingGateway {
  constructor(private readonly stripe: StripeService) {
    super();
  }

  async charge(r: ChargeRequest): Promise<ChargeResult> {
    try {
      const intent = await this.stripe.createPaymentIntent({
        amount: r.amount,
        currency: r.currency,
        paymentMethodId: r.paymentMethodRef,
        idempotencyKey: r.idempotencyKey,
      });
      return intent.status === 'succeeded'
        ? { ok: true, providerRef: intent.id }
        : { ok: false, definite: true, reason: intent.status };
    } catch (error) {
      return {
        ok: false,
        definite: !this.stripe.isUnknownOutcome(error),
        reason: (error as Error).message,
      };
    }
  }
}

export class FakeBillingGateway extends BillingGateway {
  readonly charges: ChargeRequest[] = [];
  failuresLeft = 0;

  async charge(r: ChargeRequest): Promise<ChargeResult> {
    this.charges.push(r);
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      return { ok: false, definite: true, reason: 'card_declined' };
    }
    return { ok: true, providerRef: `pi_fake_${this.charges.length}` };
  }
}
