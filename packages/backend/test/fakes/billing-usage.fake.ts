import type {
  UsageInvoiceLinesProvider,
  UsageLine,
} from '@app/domains/billing';

/**
 * S18's `UsageInvoiceLinesProvider` as the billing specs script it (S17 test-plan.md): lines per subscription, or a
 * failure, with a call log. Answers "no usage" for anything not scripted.
 */
export class FakeUsageLines implements UsageInvoiceLinesProvider {
  readonly calls: Array<{ subscriptionId: string; timeoutMs: number }> = [];
  private readonly lines = new Map<string, UsageLine[]>();
  private readonly failing = new Set<string>();
  /** Fails every call (S18 down). */
  failAll = false;

  reset(): void {
    this.calls.length = 0;
    this.lines.clear();
    this.failing.clear();
    this.failAll = false;
  }

  set(subscriptionId: string, lines: UsageLine[]): void {
    this.lines.set(subscriptionId, lines);
  }

  fail(subscriptionId: string): void {
    this.failing.add(subscriptionId);
  }

  recover(subscriptionId: string): void {
    this.failing.delete(subscriptionId);
  }

  linesFor(input: { subscriptionId: string; timeoutMs: number }) {
    this.calls.push({
      subscriptionId: input.subscriptionId,
      timeoutMs: input.timeoutMs,
    });
    if (this.failAll || this.failing.has(input.subscriptionId))
      return Promise.reject(new Error('usage lines timed out'));
    return Promise.resolve({
      lines: this.lines.get(input.subscriptionId) ?? [],
    });
  }
}
