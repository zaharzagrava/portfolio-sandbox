import type {
  LookupOutcome,
  PayoutProviderPort,
  TransferOutcome,
  TransferRequest,
} from '../domain/payout-ports';

type Script = 'ok' | 'reject' | 'timeout';

const scriptOf = (destination: string): Script =>
  destination === 'acct_test_reject'
    ? 'reject'
    : destination === 'acct_test_timeout'
      ? 'timeout'
      : 'ok';

/**
 * The payout provider of the local/test profile (`PROVIDER_DOUBLES=enabled`, S15.R-27), bound to the same port as the
 * Stripe adapter. The destination account id picks the behavior: `acct_test_reject` is a definite rejection,
 * `acct_test_timeout` gives no answer (`unknown`, as a real timeout is classified), anything else is accepted. The
 * payout id is the idempotency key: the same payout always gets the same transfer. State is per process.
 */
export class ScriptedPayoutProvider implements PayoutProviderPort {
  private readonly accepted = new Map<string, unknown>();
  private readonly rejected = new Set<string>();

  transfer(request: TransferRequest): Promise<TransferOutcome> {
    switch (scriptOf(request.destination)) {
      case 'reject':
        this.rejected.add(request.payoutId);
        return Promise.resolve({ kind: 'rejected', code: 'account_invalid' });
      case 'timeout':
        return Promise.resolve({ kind: 'unknown' });
      default: {
        if (!this.accepted.has(request.payoutId))
          this.accepted.set(request.payoutId, {
            id: `tr_scripted_${request.payoutId}`,
            amount: request.amountMinor,
            currency: request.currency.toLowerCase(),
            destination: request.destination,
            reversed: false,
          });
        return Promise.resolve({
          kind: 'answered',
          answer: this.accepted.get(request.payoutId),
        });
      }
    }
  }

  lookupByReference(payoutId: string): Promise<LookupOutcome> {
    if (this.rejected.has(payoutId))
      return Promise.resolve({
        kind: 'found_rejected',
        code: 'account_invalid',
      });
    const answer = this.accepted.get(payoutId);
    return Promise.resolve(
      answer === undefined
        ? { kind: 'not_found' }
        : { kind: 'found', answer, reversed: false },
    );
  }
}
