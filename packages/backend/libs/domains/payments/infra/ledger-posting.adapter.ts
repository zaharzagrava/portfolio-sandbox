import { Injectable } from '@nestjs/common';
import { assertActiveTransaction } from '@app/infrastructure/context';
import { LedgerService } from '../application/ledger.service';
import type { LedgerPosting, PaymentRecord } from '../domain/ports';

/** The ledger's two posting names, called inside the transition's transaction only (S13 A15, CONTRACT 8). */
@Injectable()
export class LedgerPostingAdapter implements LedgerPosting {
  constructor(private readonly ledger: LedgerService) {}

  async recordCaptured(payment: PaymentRecord): Promise<void> {
    await this.ledger.recordPaymentCaptured(
      {
        paymentId: payment.id,
        userId: payment.userId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
      },
      assertActiveTransaction(),
    );
  }

  async recordRefunded(payment: PaymentRecord): Promise<void> {
    await this.ledger.recordPaymentRefunded(
      {
        paymentId: payment.id,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
      },
      assertActiveTransaction(),
    );
  }
}
