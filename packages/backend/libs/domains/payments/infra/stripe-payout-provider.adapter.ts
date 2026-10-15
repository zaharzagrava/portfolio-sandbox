import { Injectable } from '@nestjs/common';
import { ApiConfigService } from '@app/common/config';
import { StripeService } from '@app/infrastructure/stripe/stripe.service';
import { payoutProviderMismatchCounter } from '../domain/payout-metrics';
import type {
  LookupOutcome,
  PayoutProviderPort,
  TransferOutcome,
  TransferRequest,
} from '../domain/payout-ports';

/** Codes after which Stripe will never accept this transfer: a definite rejection. */
const REJECTION_CODES = new Set([
  'account_closed',
  'account_invalid',
  'invalid_destination',
  'insufficient_platform_funds',
  'resource_missing',
  'transfers_not_allowed',
]);

interface SdkError {
  type?: string;
  code?: string;
  statusCode?: number;
  message?: string;
}

/**
 * The payment provider behind the payout port (S15 research R-6). It classifies and nothing else: success bodies are
 * returned raw for the application to validate, a timeout is `unknown` (never a rejection), 429/5xx/connection reset
 * is `transient`, a known rejection code is `rejected`, anything it cannot classify is `unknown`. One call per method
 * call: retries belong to the job layer and the resolver.
 */
@Injectable()
export class StripePayoutProviderAdapter implements PayoutProviderPort {
  constructor(
    private readonly stripe: StripeService,
    private readonly config: ApiConfigService,
  ) {}

  async transfer(request: TransferRequest): Promise<TransferOutcome> {
    try {
      const answer = await this.stripe.createTransfer({
        amountMinor: request.amountMinor,
        currency: request.currency,
        destination: request.destination,
        idempotencyKey: request.payoutId,
        transferGroup: request.payoutId,
        timeoutMs: this.config.get('payout_provider_timeout_ms'),
      });
      return { kind: 'answered', answer };
    } catch (error) {
      return this.classify(error as SdkError);
    }
  }

  async lookupByReference(payoutId: string): Promise<LookupOutcome> {
    try {
      const found = await this.stripe.listTransfersByGroup(
        payoutId,
        this.config.get('payout_provider_timeout_ms'),
      );
      if (found.length === 0) return { kind: 'not_found' };
      if (found.length > 1) {
        payoutProviderMismatchCounter.add(1, { kind: 'duplicate_transfer' });
        return { kind: 'unreachable' };
      }
      return { kind: 'found', answer: found[0], reversed: found[0].reversed };
    } catch {
      return { kind: 'unreachable' };
    }
  }

  private classify(error: SdkError): TransferOutcome {
    if (error.code && REJECTION_CODES.has(error.code))
      return { kind: 'rejected', code: error.code };
    if (error.statusCode === 429) return { kind: 'transient', status: '429' };
    if (error.statusCode && [502, 503, 504].includes(error.statusCode))
      return { kind: 'transient', status: String(error.statusCode) };
    if (error.code === 'ECONNRESET')
      return { kind: 'transient', status: 'reset' };
    if (error.type === 'StripeRateLimitError')
      return { kind: 'transient', status: '429' };
    return { kind: 'unknown' };
  }
}
