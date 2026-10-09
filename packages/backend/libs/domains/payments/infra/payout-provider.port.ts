import { Injectable } from '@nestjs/common';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';

export interface PayoutTransfer {
  amount: number;
  currency: string;
  destination: string;
  /** Our payout id - providers dedupe retries on it. */
  idempotencyKey: string;
}

export abstract class PayoutProvider {
  abstract transfer(transfer: PayoutTransfer): Promise<{ providerRef: string }>;
}

@Injectable()
export class StripeConnectPayoutProvider extends PayoutProvider {
  constructor(private readonly stripe: StripeService) {
    super();
  }

  async transfer(t: PayoutTransfer) {
    const { id } = await this.stripe.transfer(t);
    return { providerRef: id };
  }
}

/** Test double: records transfers, can be told to fail. */
export class FakePayoutProvider extends PayoutProvider {
  readonly transfers: PayoutTransfer[] = [];
  failNext = false;

  async transfer(t: PayoutTransfer) {
    if (this.failNext) {
      this.failNext = false;
      throw Object.assign(new Error('account_closed'), {
        type: 'StripeInvalidRequestError',
      });
    }
    this.transfers.push(t);
    return { providerRef: `tr_fake_${this.transfers.length}` };
  }
}
