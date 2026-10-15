import type {
  LookupOutcome,
  PayoutProviderPort,
  TransferOutcome,
  TransferRequest,
} from '../domain/payout-ports';
import type { Gate } from './fake-payment-provider';

/** What a transfer call does. The provider keeps the idempotency-key behaviour of the real one: a key that already produced a transfer replays it. */
export type TransferStep =
  | { kind: 'success' }
  | { kind: 'reject'; code: string }
  | { kind: 'transient'; status: '429' | '502' | '503' | '504' | 'reset' }
  /** The caller gives up: the transfer exists at the provider only when `committed`. */
  | { kind: 'timeout'; committed?: boolean }
  | { kind: 'garbage'; body: unknown; committed?: boolean }
  | {
      kind: 'wrong';
      field: 'amount' | 'currency' | 'destination' | 'reference';
    }
  /** The provider accepted the transfer and the caller's process died before it could record it: the promise never settles. */
  | { kind: 'hang' }
  /** Blocks inside the call (no transaction may be open, AS-29) until the gate opens, then does `then`. */
  | { kind: 'gate'; gate: Gate; then?: TransferStep };

export type LookupStep =
  | { kind: 'default' }
  | { kind: 'unreachable' }
  | { kind: 'rejected'; code: string }
  | { kind: 'not_found' };

export interface FakeTransfer {
  id: string;
  amount: number;
  currency: string;
  destination: string;
  reversed: boolean;
}

export interface ProviderCall {
  op: 'transfer' | 'lookup';
  payoutId: string;
  amountMinor?: number;
  currency?: string;
  destination?: string;
}

/**
 * The payment provider behind the payout port for specs (S15 test-plan.md): scriptable outcomes, a call log, and the
 * idempotency-key replay of the real provider. A fault it cannot simulate is not simulated here: the spec reports it
 * blocked (L-003).
 */
export class FakePayoutProvider implements PayoutProviderPort {
  readonly calls: ProviderCall[] = [];
  /** Transfers that exist at the provider, by payout id (the idempotency key). */
  readonly transfers = new Map<string, FakeTransfer>();
  private script: TransferStep[] = [];
  private lookups: LookupStep[] = [];
  private seq = 0;

  /** The next calls follow these steps in order; after them every call succeeds. */
  next(...steps: TransferStep[]): this {
    this.script.push(...steps);
    return this;
  }

  /** The next lookups follow these steps in order; after them a lookup reports what the provider holds. */
  nextLookups(...steps: LookupStep[]): this {
    this.lookups.push(...steps);
    return this;
  }

  /** The transfer is reversed at the provider after the fact (the audit's `reversed_at_provider`). */
  reverse(payoutId: string): void {
    const t = this.transfers.get(payoutId);
    if (t) t.reversed = true;
  }

  /** Makes the provider hold a transfer our records do not agree with. */
  tamper(payoutId: string, change: Partial<FakeTransfer>): void {
    const t = this.transfers.get(payoutId);
    if (t) Object.assign(t, change);
  }

  forget(payoutId: string): void {
    this.transfers.delete(payoutId);
  }

  reset(): void {
    this.calls.length = 0;
    this.transfers.clear();
    this.script = [];
    this.lookups = [];
    this.seq = 0;
  }

  transferCalls(): ProviderCall[] {
    return this.calls.filter((c) => c.op === 'transfer');
  }

  async transfer(request: TransferRequest): Promise<TransferOutcome> {
    this.calls.push({
      op: 'transfer',
      payoutId: request.payoutId,
      amountMinor: request.amountMinor,
      currency: request.currency,
      destination: request.destination,
    });
    return this.run(this.script.shift() ?? { kind: 'success' }, request);
  }

  private async run(
    step: TransferStep,
    request: TransferRequest,
  ): Promise<TransferOutcome> {
    switch (step.kind) {
      case 'gate':
        await step.gate.wait();
        return this.run(step.then ?? { kind: 'success' }, request);
      case 'success':
        return { kind: 'answered', answer: this.commit(request) };
      case 'reject':
        return { kind: 'rejected', code: step.code };
      case 'transient':
        return { kind: 'transient', status: step.status };
      case 'timeout':
        if (step.committed) this.commit(request);
        return { kind: 'unknown' };
      case 'garbage':
        if (step.committed) this.commit(request);
        return { kind: 'answered', answer: step.body };
      case 'wrong': {
        const real = this.commit(request);
        const answer: Record<string, unknown> = { ...real };
        if (step.field === 'amount') answer.amount = real.amount + 1;
        if (step.field === 'currency') answer.currency = 'usd';
        if (step.field === 'destination') answer.destination = 'acct_other0000';
        if (step.field === 'reference') answer.id = '';
        return { kind: 'answered', answer };
      }
      case 'hang':
        this.commit(request);
        return new Promise<TransferOutcome>(() => undefined);
    }
  }

  /** Creates the transfer, or replays the one this key already made. */
  private commit(request: TransferRequest): FakeTransfer {
    const existing = this.transfers.get(request.payoutId);
    if (existing) return { ...existing };
    const created: FakeTransfer = {
      id: `tr_fake_${++this.seq}`,
      amount: request.amountMinor,
      currency: request.currency.toLowerCase(),
      destination: request.destination,
      reversed: false,
    };
    this.transfers.set(request.payoutId, created);
    return { ...created };
  }

  lookupByReference(payoutId: string): Promise<LookupOutcome> {
    return Promise.resolve(this.lookup(payoutId));
  }

  private lookup(payoutId: string): LookupOutcome {
    this.calls.push({ op: 'lookup', payoutId });
    const step = this.lookups.shift() ?? { kind: 'default' as const };
    switch (step.kind) {
      case 'unreachable':
        return { kind: 'unreachable' };
      case 'rejected':
        return { kind: 'found_rejected', code: step.code };
      case 'not_found':
        return { kind: 'not_found' };
      case 'default': {
        const t = this.transfers.get(payoutId);
        return t
          ? { kind: 'found', answer: { ...t }, reversed: t.reversed }
          : { kind: 'not_found' };
      }
    }
  }
}
